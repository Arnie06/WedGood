-- R1-11 seating layouts, tables, assignments and finalized snapshots (docs/07 "Seating", docs/06,
-- docs/08 layouts endpoints).
--
-- Rules:
--  * One layout per event. Owner and partner manage seating (same gate as guests). Clients have
--    SELECT only; every write is an RPC that takes the per-wedding guests advisory lock, the same
--    lock RSVP submissions and owner guest writes use. That serializes seat and capacity checks with
--    RSVP changes, so two requests for the last seat cannot both succeed (T10).
--  * A guest has at most one assignment per layout (unique index). A confirmed seat needs an active,
--    accepted invitation membership for the layout's event. A tentative seat needs a pending one and
--    is only allowed while the layout has allow_tentative on. Tentative and confirmed seats both
--    occupy capacity but are reported separately.
--  * RSVP changes act on seating inside the same transaction: decline (or an archived guest, or a
--    revoked invitation) removes the seat; accepting confirms a tentative seat; going back to
--    waiting keeps the seat as tentative when allowed, else removes it. They do not place anyone.
--  * layouts.revision counts every change that affects the plan (tables, seats, RSVP, meals).
--    Finalizing freezes a snapshot at a revision; the snapshot is stale whenever revision differs.
--    Historical snapshots are never rewritten.

-- ---------------------------------------------------------------- tables
create table public.seating_layouts (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null,
  event_id uuid not null,
  allow_tentative boolean not null default false,
  revision integer not null default 1,
  finalized_revision integer,
  finalized_at timestamptz,
  finalized_by uuid references auth.users (id) on delete set null,
  snapshot jsonb,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (wedding_id, id),
  unique (wedding_id, id, event_id),
  unique (event_id),
  check ((finalized_revision is null) = (snapshot is null)),
  foreign key (wedding_id, event_id) references public.events (wedding_id, id) on delete cascade
);
create trigger seating_layouts_touch before update on public.seating_layouts
  for each row execute function app_private.touch_updated_at();

create table public.seating_tables (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null,
  layout_id uuid not null,
  label text not null check (char_length(label) between 1 and 60 and label = btrim(label)),
  capacity integer not null check (capacity between 1 and 50),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (wedding_id, layout_id, id),
  foreign key (wedding_id, layout_id) references public.seating_layouts (wedding_id, id) on delete cascade
);
create unique index seating_tables_label_uq on public.seating_tables (layout_id, lower(label));
create trigger seating_tables_touch before update on public.seating_tables
  for each row execute function app_private.touch_updated_at();

create table public.seat_assignments (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null,
  layout_id uuid not null,
  table_id uuid not null,
  guest_id uuid not null,
  seat_number integer check (seat_number is null or seat_number between 1 and 50),
  tentative boolean not null default false,
  assigned_at timestamptz not null default now(),
  unique (layout_id, guest_id),
  foreign key (wedding_id, layout_id, table_id)
    references public.seating_tables (wedding_id, layout_id, id) on delete cascade,
  foreign key (wedding_id, guest_id) references public.guests (wedding_id, id)
);
create unique index seat_assignments_seat_uq on public.seat_assignments (table_id, seat_number)
  where seat_number is not null;
create index seat_assignments_table_idx on public.seat_assignments (table_id);

alter table public.seating_layouts enable row level security;
alter table public.seating_tables enable row level security;
alter table public.seat_assignments enable row level security;
revoke all on public.seating_layouts, public.seating_tables, public.seat_assignments
  from anon, authenticated;
grant select on public.seating_layouts, public.seating_tables, public.seat_assignments
  to authenticated;
create policy seating_layouts_select_managers on public.seating_layouts
  for select to authenticated using (app_private.can_manage_guests(wedding_id));
create policy seating_tables_select_managers on public.seating_tables
  for select to authenticated using (app_private.can_manage_guests(wedding_id));
create policy seat_assignments_select_managers on public.seat_assignments
  for select to authenticated using (app_private.can_manage_guests(wedding_id));

-- ---------------------------------------------------------------- helpers
-- Marks the plan changed so a finalized snapshot becomes stale. Callers hold the guests lock.
create function app_private.seating_touch(p_layout uuid) returns void
language sql
security definer
set search_path = ''
as $$ update public.seating_layouts set revision = revision + 1 where id = p_layout $$;
revoke all on function app_private.seating_touch(uuid) from public, anon, authenticated;

-- Applies an RSVP, archive or revocation change to seating. Never places a guest.
-- p_new is the guest's new status for the event, or null when they no longer have an active one.
create function app_private.seating_on_member_change(p_event uuid, p_guest uuid, p_new text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_layout public.seating_layouts%rowtype;
  v_removed integer := 0;
begin
  select * into v_layout from public.seating_layouts where event_id = p_event;
  if not found then return; end if;
  if p_new = 'accepted' then
    update public.seat_assignments set tentative = false
      where layout_id = v_layout.id and guest_id = p_guest and tentative;
  elsif p_new = 'pending' and v_layout.allow_tentative then
    update public.seat_assignments set tentative = true
      where layout_id = v_layout.id and guest_id = p_guest and not tentative;
  else
    delete from public.seat_assignments where layout_id = v_layout.id and guest_id = p_guest;
    get diagnostics v_removed = row_count;
  end if;
  perform app_private.seating_touch(v_layout.id);
  if v_removed > 0 then
    insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
      values (v_layout.wedding_id, (select auth.uid()), 'seating_layout', v_layout.id,
              'seating.guest_released', '{}'::jsonb,
              (select revision from public.weddings where id = v_layout.wedding_id));
  end if;
end;
$$;
revoke all on function app_private.seating_on_member_change(uuid, uuid, text)
  from public, anon, authenticated;

-- RSVP response hook: a changed status or meal acts on seating (docs/07).
create or replace function app_private.apply_member_response(
  p_member uuid, p_status text, p_meal uuid, p_allow_pending boolean
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_m public.invitation_members%rowtype;
  v_meal uuid := p_meal;
  v_active boolean;
begin
  select * into v_m from public.invitation_members where id = p_member for update;
  if not found or not v_m.active then
    raise exception 'unknown member' using errcode = '22023';
  end if;
  if p_status not in ('accepted', 'declined') and not (p_allow_pending and p_status = 'pending') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  -- Declining or resetting removes meal eligibility.
  if p_status <> 'accepted' then v_meal := null; end if;
  if v_meal is not null and v_meal is distinct from v_m.meal_option_id then
    select active into v_active from public.meal_options where id = v_meal and event_id = v_m.event_id;
    if v_active is distinct from true then
      raise exception 'invalid meal option' using errcode = '22023';
    end if;
  end if;
  if v_m.rsvp_status = p_status and v_m.meal_option_id is not distinct from v_meal then
    return false;
  end if;
  update public.invitation_members
    set rsvp_status = p_status, meal_option_id = v_meal,
        responded_at = case when p_status = 'pending' then null else now() end,
        version = version + 1
    where id = p_member;
  perform app_private.seating_on_member_change(v_m.event_id, v_m.guest_id, p_status);
  return true;
end;
$$;
revoke all on function app_private.apply_member_response(uuid, text, uuid, boolean)
  from public, anon, authenticated;

create or replace function public.revoke_invitation(p_wedding uuid, p_invitation_id uuid, p_expected_version integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_inv public.invitations%rowtype;
  v_m record;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  select * into v_inv from public.invitations where id = p_invitation_id and wedding_id = p_wedding for update;
  if not found then raise exception 'not permitted' using errcode = '42501'; end if;
  if v_inv.version <> p_expected_version or v_inv.revoked_at is not null then
    raise exception 'version conflict' using errcode = '55000';
  end if;
  update public.invitations set revoked_at = now(), version = version + 1 where id = p_invitation_id;
  for v_m in select guest_id, event_id from public.invitation_members
              where invitation_id = p_invitation_id and active loop
    perform app_private.seating_on_member_change(v_m.event_id, v_m.guest_id, null);
  end loop;
  update public.invitation_members set active = false, version = version + 1
    where invitation_id = p_invitation_id and active;
  update public.weddings set revision = revision + 1 where id = p_wedding;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'invitation', p_invitation_id, 'invitation.revoked', '{}'::jsonb, v_wedding.revision + 1);
end;
$$;

-- Archiving a guest takes them off every layout.
create or replace function public.set_guest_archived(
  p_wedding uuid,
  p_guest_id uuid,
  p_expected_version integer,
  p_archived boolean
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.guests%rowtype;
  v_m record;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  select * into v_old from public.guests where id = p_guest_id and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_old.version <> p_expected_version then
    raise exception 'guest changed, reload' using errcode = '55000';
  end if;
  if (v_old.archived_at is not null) = p_archived then
    return;
  end if;
  if not p_archived then
    perform app_private.assert_guest_cap(p_wedding, 1);
  end if;
  update public.guests set archived_at = case when p_archived then now() end where id = p_guest_id;
  if p_archived then
    for v_m in select event_id from public.invitation_members where guest_id = p_guest_id and active loop
      perform app_private.seating_on_member_change(v_m.event_id, p_guest_id, null);
    end loop;
  end if;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'guest', p_guest_id,
            case when p_archived then 'guest.archived' else 'guest.restored' end,
            '{}'::jsonb, v_wedding.revision);
end;
$$;

-- ---------------------------------------------------------------- RPCs
-- Locks the wedding and returns the layout row for update. Hides other tenants' layouts.
create function app_private.lock_layout(p_wedding uuid, p_layout uuid)
returns public.seating_layouts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_layout public.seating_layouts%rowtype;
begin
  select * into v_layout from public.seating_layouts
    where id = p_layout and wedding_id = p_wedding for update;
  if not found then raise exception 'not permitted' using errcode = '42501'; end if;
  return v_layout;
end;
$$;
revoke all on function app_private.lock_layout(uuid, uuid) from public, anon, authenticated;

create function public.ensure_seating_layout(p_wedding uuid, p_event_id uuid) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_id uuid;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  if not exists (select 1 from public.events where id = p_event_id and wedding_id = p_wedding) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  select id into v_id from public.seating_layouts where event_id = p_event_id;
  if v_id is not null then return v_id; end if;
  insert into public.seating_layouts (wedding_id, event_id) values (p_wedding, p_event_id)
    returning id into v_id;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'seating_layout', v_id, 'seating.layout_created', '{}'::jsonb, v_wedding.revision);
  return v_id;
end;
$$;

-- Turning tentative seating off is refused while tentative guests are still seated.
create function public.set_seating_tentative(
  p_wedding uuid, p_layout uuid, p_expected_version integer, p_allow boolean
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_layout public.seating_layouts%rowtype;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  v_layout := app_private.lock_layout(p_wedding, p_layout);
  if v_layout.version <> p_expected_version then
    raise exception 'version conflict' using errcode = '55000';
  end if;
  if v_layout.allow_tentative = p_allow then return; end if;
  if not p_allow and exists (
       select 1 from public.seat_assignments where layout_id = p_layout and tentative) then
    raise exception 'tentative guests are still seated' using errcode = 'SE422';
  end if;
  update public.seating_layouts set allow_tentative = p_allow, version = version + 1,
    revision = revision + 1 where id = p_layout;
  update public.weddings set revision = revision + 1 where id = p_wedding;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'seating_layout', p_layout, 'seating.tentative_changed',
            jsonb_build_object('allow', p_allow), v_wedding.revision + 1);
end;
$$;

create function public.add_seating_table(p_wedding uuid, p_layout uuid, p_label text, p_capacity integer)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_label text := regexp_replace(btrim(coalesce(p_label, '')), '\s+', ' ', 'g');
  v_id uuid;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  perform app_private.lock_layout(p_wedding, p_layout);
  if char_length(v_label) not between 1 and 60 or p_capacity is null or p_capacity not between 1 and 50 then
    raise exception 'invalid table' using errcode = '22023';
  end if;
  if (select count(*) from public.seating_tables where layout_id = p_layout) >= 100 then
    raise exception 'too many tables' using errcode = '54000';
  end if;
  insert into public.seating_tables (wedding_id, layout_id, label, capacity)
    values (p_wedding, p_layout, v_label, p_capacity) returning id into v_id;
  perform app_private.seating_touch(p_layout);
  update public.weddings set revision = revision + 1 where id = p_wedding;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'seating_table', v_id, 'seating.table_added', '{}'::jsonb, v_wedding.revision + 1);
  return v_id;
end;
$$;

-- Capacity may not drop below the guests already seated or the highest numbered seat in use.
create function public.update_seating_table(
  p_wedding uuid, p_table uuid, p_expected_version integer, p_label text, p_capacity integer
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_label text := regexp_replace(btrim(coalesce(p_label, '')), '\s+', ' ', 'g');
  v_t public.seating_tables%rowtype;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  select * into v_t from public.seating_tables where id = p_table and wedding_id = p_wedding for update;
  if not found then raise exception 'not permitted' using errcode = '42501'; end if;
  perform app_private.lock_layout(p_wedding, v_t.layout_id);
  if char_length(v_label) not between 1 and 60 or p_capacity is null or p_capacity not between 1 and 50 then
    raise exception 'invalid table' using errcode = '22023';
  end if;
  if v_t.version <> p_expected_version then
    raise exception 'version conflict' using errcode = '55000';
  end if;
  if exists (
       select 1 from public.seat_assignments where table_id = p_table
       having count(*) > p_capacity or coalesce(max(seat_number), 0) > p_capacity) then
    raise exception 'table too small for seated guests' using errcode = 'SE409';
  end if;
  update public.seating_tables set label = v_label, capacity = p_capacity, version = version + 1
    where id = p_table;
  perform app_private.seating_touch(v_t.layout_id);
  update public.weddings set revision = revision + 1 where id = p_wedding;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'seating_table', p_table, 'seating.table_updated', '{}'::jsonb, v_wedding.revision + 1);
end;
$$;

-- Removing a table returns its guests to the queue. Returns how many were unseated.
create function public.remove_seating_table(p_wedding uuid, p_table uuid, p_expected_version integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_t public.seating_tables%rowtype;
  v_n integer;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  select * into v_t from public.seating_tables where id = p_table and wedding_id = p_wedding for update;
  if not found then raise exception 'not permitted' using errcode = '42501'; end if;
  perform app_private.lock_layout(p_wedding, v_t.layout_id);
  if v_t.version <> p_expected_version then
    raise exception 'version conflict' using errcode = '55000';
  end if;
  select count(*) into v_n from public.seat_assignments where table_id = p_table;
  delete from public.seating_tables where id = p_table;
  perform app_private.seating_touch(v_t.layout_id);
  update public.weddings set revision = revision + 1 where id = p_wedding;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'seating_table', p_table, 'seating.table_removed',
            jsonb_build_object('unseated', v_n), v_wedding.revision + 1);
  return v_n;
end;
$$;

-- Seats (or moves) one guest. Idempotent for the same target. SE409 = table full, SE422 = guest not
-- eligible for this event's seating, 23505 = numbered seat taken.
create function public.assign_guest_seat(
  p_wedding uuid, p_layout uuid, p_guest uuid, p_table uuid, p_seat integer default null
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_layout public.seating_layouts%rowtype;
  v_t public.seating_tables%rowtype;
  v_status text;
  v_tentative boolean;
  v_used integer;
  v_prev public.seat_assignments%rowtype;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  v_layout := app_private.lock_layout(p_wedding, p_layout);
  select * into v_t from public.seating_tables
    where id = p_table and layout_id = p_layout and wedding_id = p_wedding for update;
  if not found then raise exception 'not permitted' using errcode = '42501'; end if;
  if p_seat is not null and p_seat not between 1 and v_t.capacity then
    raise exception 'invalid seat' using errcode = '22023';
  end if;
  select im.rsvp_status into v_status
    from public.invitation_members im
    join public.guests g on g.id = im.guest_id and g.wedding_id = im.wedding_id
    where im.wedding_id = p_wedding and im.event_id = v_layout.event_id and im.guest_id = p_guest
      and im.active and g.archived_at is null
    for share of im;
  if v_status is null or v_status = 'declined' then
    raise exception 'guest not eligible' using errcode = 'SE422';
  end if;
  v_tentative := v_status = 'pending';
  if v_tentative and not v_layout.allow_tentative then
    raise exception 'guest not eligible' using errcode = 'SE422';
  end if;
  select * into v_prev from public.seat_assignments where layout_id = p_layout and guest_id = p_guest;
  select count(*) into v_used from public.seat_assignments
    where table_id = p_table and guest_id <> p_guest;
  if v_used >= v_t.capacity then
    raise exception 'table is full' using errcode = 'SE409';
  end if;
  if v_prev.id is not null and v_prev.table_id = p_table and v_prev.seat_number is not distinct from p_seat
     and v_prev.tentative = v_tentative then
    return;
  end if;
  insert into public.seat_assignments (wedding_id, layout_id, table_id, guest_id, seat_number, tentative)
    values (p_wedding, p_layout, p_table, p_guest, p_seat, v_tentative)
    on conflict (layout_id, guest_id) do update
      set table_id = excluded.table_id, seat_number = excluded.seat_number,
          tentative = excluded.tentative, assigned_at = now();
  perform app_private.seating_touch(p_layout);
  update public.weddings set revision = revision + 1 where id = p_wedding;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'seating_layout', p_layout, 'seating.guest_seated',
            jsonb_build_object('tentative', v_tentative), v_wedding.revision + 1);
end;
$$;

create function public.unassign_guest_seat(p_wedding uuid, p_layout uuid, p_guest uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_n integer;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  perform app_private.lock_layout(p_wedding, p_layout);
  delete from public.seat_assignments where layout_id = p_layout and guest_id = p_guest;
  get diagnostics v_n = row_count;
  if v_n = 0 then return; end if;
  perform app_private.seating_touch(p_layout);
  update public.weddings set revision = revision + 1 where id = p_wedding;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'seating_layout', p_layout, 'seating.guest_unseated', '{}'::jsonb, v_wedding.revision + 1);
end;
$$;

-- Freezes the plan the person reviewed. p_expected_revision must still be current, so a plan that
-- changed under them is refused instead of silently frozen.
create function public.finalize_seating_layout(p_wedding uuid, p_layout uuid, p_expected_revision integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_layout public.seating_layouts%rowtype;
  v_snap jsonb;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  v_layout := app_private.lock_layout(p_wedding, p_layout);
  if v_layout.revision <> p_expected_revision then
    raise exception 'version conflict' using errcode = '55000';
  end if;
  select jsonb_build_object(
    'revision', v_layout.revision,
    'tables', coalesce((
      select jsonb_agg(jsonb_build_object(
        'label', t.label, 'capacity', t.capacity,
        'guests', coalesce((
          select jsonb_agg(jsonb_build_object(
            'name', g.full_name, 'tentative', a.tentative, 'seat', a.seat_number,
            'meal', mo.name) order by coalesce(a.seat_number, 999), g.full_name)
          from public.seat_assignments a
          join public.guests g on g.id = a.guest_id
          left join public.invitation_members im
            on im.event_id = v_layout.event_id and im.guest_id = a.guest_id and im.active
          left join public.meal_options mo on mo.id = im.meal_option_id
          where a.table_id = t.id), '[]'::jsonb)) order by t.label)
      from public.seating_tables t where t.layout_id = p_layout), '[]'::jsonb),
    'accepted', (select count(*) from public.invitation_members im
                  join public.guests g on g.id = im.guest_id
                  where im.event_id = v_layout.event_id and im.active and im.rsvp_status = 'accepted'
                    and g.archived_at is null),
    'confirmedSeated', (select count(*) from public.seat_assignments where layout_id = p_layout and not tentative),
    'tentativeSeated', (select count(*) from public.seat_assignments where layout_id = p_layout and tentative)
  ) into v_snap;
  update public.seating_layouts
    set finalized_revision = v_layout.revision, finalized_at = now(), finalized_by = v_user,
        snapshot = v_snap, version = version + 1
    where id = p_layout;
  update public.weddings set revision = revision + 1 where id = p_wedding;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'seating_layout', p_layout, 'seating.finalized',
            jsonb_build_object('layoutRevision', v_layout.revision), v_wedding.revision + 1);
end;
$$;

revoke all on function public.ensure_seating_layout(uuid, uuid),
  public.set_seating_tentative(uuid, uuid, integer, boolean),
  public.add_seating_table(uuid, uuid, text, integer),
  public.update_seating_table(uuid, uuid, integer, text, integer),
  public.remove_seating_table(uuid, uuid, integer),
  public.assign_guest_seat(uuid, uuid, uuid, uuid, integer),
  public.unassign_guest_seat(uuid, uuid, uuid),
  public.finalize_seating_layout(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.ensure_seating_layout(uuid, uuid),
  public.set_seating_tentative(uuid, uuid, integer, boolean),
  public.add_seating_table(uuid, uuid, text, integer),
  public.update_seating_table(uuid, uuid, integer, text, integer),
  public.remove_seating_table(uuid, uuid, integer),
  public.assign_guest_seat(uuid, uuid, uuid, uuid, integer),
  public.unassign_guest_seat(uuid, uuid, uuid),
  public.finalize_seating_layout(uuid, uuid, integer) to authenticated;
