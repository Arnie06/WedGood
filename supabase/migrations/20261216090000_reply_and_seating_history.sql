-- REL-05 reply and seating history (ADR-031; docs/07 "Guests" and "Seating").
--   * rsvp_changes: one append-only row per real change of a guest's answer or meal for an event,
--     written inside apply_member_response. A retry that changes nothing writes nothing.
--   * seating_snapshots: one immutable row per finalization. seating_layouts.snapshot still holds
--     the latest copy (the stale check and the existing pages read it); this table keeps them all.
-- Both are readable by owner and partner only (the same people who can read guest rows and plans).
-- Nothing here is writable by clients.

-- ---------------------------------------------------------------- reply changes
create table public.rsvp_changes (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  event_id uuid not null,
  guest_id uuid not null,
  from_status text not null check (from_status in ('pending', 'accepted', 'declined')),
  to_status text not null check (to_status in ('pending', 'accepted', 'declined')),
  from_meal_option_id uuid,
  to_meal_option_id uuid,
  -- null for a guest answering from their own link
  actor_id uuid references auth.users (id) on delete set null,
  source text not null check (source in ('guest', 'couple')),
  reason text check (reason is null or char_length(reason) between 1 and 200),
  occurred_at timestamptz not null default now(),
  check (from_status <> to_status or from_meal_option_id is distinct from to_meal_option_id),
  foreign key (wedding_id, event_id) references public.events (wedding_id, id),
  foreign key (wedding_id, guest_id) references public.guests (wedding_id, id),
  foreign key (wedding_id, event_id, from_meal_option_id)
    references public.meal_options (wedding_id, event_id, id),
  foreign key (wedding_id, event_id, to_meal_option_id)
    references public.meal_options (wedding_id, event_id, id)
);
create index rsvp_changes_guest_idx on public.rsvp_changes (wedding_id, guest_id, occurred_at desc, id);
create index rsvp_changes_event_idx on public.rsvp_changes (wedding_id, event_id, occurred_at desc, id);

create function app_private.history_append_only() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Cascading erasure of a whole wedding (or a layout with it) is the only permitted deletion.
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end;
$$;
create trigger rsvp_changes_no_update before update or delete on public.rsvp_changes
  for each row execute function app_private.history_append_only();

alter table public.rsvp_changes enable row level security;
revoke all on public.rsvp_changes from anon, authenticated;
grant select on public.rsvp_changes to authenticated;
create policy rsvp_changes_select_managers on public.rsvp_changes
  for select to authenticated using (app_private.can_manage_guests(wedding_id));

-- ---------------------------------------------------------------- finalized seating versions
create table public.seating_snapshots (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  layout_id uuid not null,
  event_id uuid not null,
  revision integer not null,
  snapshot jsonb not null,
  finalized_at timestamptz not null default now(),
  finalized_by uuid references auth.users (id) on delete set null,
  unique (layout_id, revision),
  foreign key (wedding_id, layout_id, event_id)
    references public.seating_layouts (wedding_id, id, event_id) on delete cascade
);
create index seating_snapshots_event_idx on public.seating_snapshots (wedding_id, event_id, finalized_at desc, id);
create trigger seating_snapshots_no_update before update or delete on public.seating_snapshots
  for each row execute function app_private.history_append_only();

alter table public.seating_snapshots enable row level security;
revoke all on public.seating_snapshots from anon, authenticated;
grant select on public.seating_snapshots to authenticated;
create policy seating_snapshots_select_managers on public.seating_snapshots
  for select to authenticated using (app_private.can_manage_guests(wedding_id));

-- The copy each layout holds today becomes its first version.
insert into public.seating_snapshots (wedding_id, layout_id, event_id, revision, snapshot, finalized_at, finalized_by)
  select wedding_id, id, event_id, finalized_revision, snapshot, finalized_at, finalized_by
  from public.seating_layouts
  where snapshot is not null and finalized_revision is not null and finalized_at is not null;

-- ---------------------------------------------------------------- reply hook
-- Same rules as before, plus the history row. The old four-argument form is replaced, so there is
-- one definition. p_reason is only used by the owner's override.
drop function app_private.apply_member_response(uuid, text, uuid, boolean);
create function app_private.apply_member_response(
  p_member uuid, p_status text, p_meal uuid, p_allow_pending boolean, p_reason text default null
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_m public.invitation_members%rowtype;
  v_meal uuid := p_meal;
  v_active boolean;
  v_actor uuid := (select auth.uid());
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
  insert into public.rsvp_changes (
    wedding_id, event_id, guest_id, from_status, to_status, from_meal_option_id, to_meal_option_id,
    actor_id, source, reason
  ) values (
    v_m.wedding_id, v_m.event_id, v_m.guest_id, v_m.rsvp_status, p_status, v_m.meal_option_id, v_meal,
    v_actor, case when v_actor is null then 'guest' else 'couple' end, p_reason
  );
  perform app_private.seating_on_member_change(v_m.event_id, v_m.guest_id, p_status);
  return true;
end;
$$;
revoke all on function app_private.apply_member_response(uuid, text, uuid, boolean, text)
  from public, anon, authenticated;

-- The owner's response on a guest's behalf records the reason beside the change.
create or replace function public.override_rsvp_response(
  p_wedding uuid, p_member_id uuid, p_status text, p_reason text, p_meal_option_id uuid default null
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_inv uuid;
  v_reason text := regexp_replace(btrim(coalesce(p_reason, '')), '\s+', ' ', 'g');
  v_changed boolean;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  if char_length(v_reason) not between 1 and 200 then
    raise exception 'invalid reason' using errcode = '22023';
  end if;
  select im.invitation_id into v_inv from public.invitation_members im
    where im.id = p_member_id and im.wedding_id = p_wedding and im.active;
  if v_inv is null then raise exception 'not permitted' using errcode = '42501'; end if;
  perform 1 from public.invitations where id = v_inv for update;
  v_changed := app_private.apply_member_response(p_member_id, p_status, p_meal_option_id, true, v_reason);
  if v_changed then
    update public.invitations set version = version + 1, last_responded_at = now() where id = v_inv;
    update public.weddings set revision = revision + 1 where id = p_wedding;
    insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
      values (p_wedding, v_user, 'invitation', v_inv, 'rsvp.overridden',
              jsonb_build_object('status', p_status, 'reason', v_reason), v_wedding.revision + 1);
  end if;
end;
$$;

-- ---------------------------------------------------------------- finalize keeps every version
-- Same freeze as before, and each finalization is also kept as its own row. Finalizing a plan that
-- has not changed since its last finalization is a no-op, so a retry cannot make a duplicate.
create or replace function public.finalize_seating_layout(p_wedding uuid, p_layout uuid, p_expected_revision integer)
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
  if v_layout.finalized_revision is not distinct from v_layout.revision then
    return;
  end if;
  select jsonb_build_object(
    'revision', v_layout.revision,
    'tables', coalesce((
      select jsonb_agg(jsonb_build_object(
        'label', t.label, 'capacity', t.capacity, 'shape', t.shape, 'notes', t.notes,
        'guests', coalesce((
          select jsonb_agg(jsonb_build_object(
            'name', g.full_name, 'tentative', a.tentative, 'seat', a.seat_number,
            'captain', a.is_captain, 'meal', mo.name)
            order by coalesce(a.seat_number, 999), g.full_name)
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
  insert into public.seating_snapshots (wedding_id, layout_id, event_id, revision, snapshot, finalized_by)
    values (p_wedding, p_layout, v_layout.event_id, v_layout.revision, v_snap, v_user);
  update public.weddings set revision = revision + 1 where id = p_wedding;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'seating_layout', p_layout, 'seating.finalized',
            jsonb_build_object('layoutRevision', v_layout.revision), v_wedding.revision + 1);
end;
$$;
