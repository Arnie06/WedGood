-- UX-17 first slice: guest shuttles (wedding_ux_rsvp_audit_output/GAP_BACKLOG.md; ADR-031 UX-17
-- addendum). Owner decisions (2026-11-23): shuttles first, planner-entered only, app switch
-- GUEST_SHUTTLES=on (off by default). Lodging and check-in are later slices.
--
-- A shuttle run is one vehicle trip for one event: "to the event" or "from the event", a pickup
-- point, a departure time and a number of seats. Planners put attending guests on runs.
--
-- Rules:
--   * Who: anyone who manages guests (owner, partner, a planner with the guests grant). Rows reveal
--     who is attending, so reads use the same gate as seating and replies.
--   * Clients have SELECT only. Every write is an RPC that takes the per-wedding guests advisory
--     lock, the same lock RSVP replies, archive, revoke and seating use, so seat counts and
--     eligibility are checked against replies that cannot change underneath them. Two requests for
--     the last seat on a run cannot both succeed.
--   * Only a guest whose active invitation for the event is accepted, and who is not archived, can
--     ride. Waiting guests cannot be placed (no tentative rides in this slice).
--   * One ride each way per guest per event: unique (event, direction, guest). Putting a guest on a
--     different run in the same direction moves them.
--   * A run's direction never changes after it is created (assignments carry it through the
--     foreign key). Seats cannot drop below the guests already on the run (SH409).
--   * Releases happen in the same transaction as the reply: a decline, a return to waiting, a
--     revoked invitation or an archived guest removes their rides (triggers below, so every write
--     path is covered, including ones added later). Nothing ever places a guest automatically.
--   * Audit rows carry counts and directions only: no guest names, pickup text or notes.
--
-- Errors: 28000 sign in, 42501 not permitted / not found, 55000 changed since read, 22023 invalid
-- input, 54000 limit (30 runs per event, 20 guests per request), 23505 run name already used,
-- SH409 not enough seats, SH422 guest not attending this event.

-- ---------------------------------------------------------------- tables
create table public.shuttle_runs (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null,
  event_id uuid not null,
  direction text not null check (direction in ('to_event', 'from_event')),
  label text not null check (char_length(label) between 1 and 60 and label = btrim(label)),
  pickup text not null check (char_length(pickup) between 1 and 200 and pickup = btrim(pickup)),
  dropoff text check (dropoff is null or (char_length(dropoff) between 1 and 200 and dropoff = btrim(dropoff))),
  departs_at timestamptz not null,
  capacity integer not null check (capacity between 1 and 100),
  notes text check (notes is null or char_length(notes) between 1 and 500),
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (wedding_id, id),
  unique (wedding_id, event_id, id, direction),
  foreign key (wedding_id, event_id) references public.events (wedding_id, id) on delete cascade
);
create unique index shuttle_runs_label_uq on public.shuttle_runs (event_id, lower(label));
create index shuttle_runs_event_idx on public.shuttle_runs (wedding_id, event_id, departs_at, id);
create trigger shuttle_runs_touch before update on public.shuttle_runs
  for each row execute function app_private.touch_updated_at();

create table public.shuttle_assignments (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null,
  event_id uuid not null,
  run_id uuid not null,
  direction text not null check (direction in ('to_event', 'from_event')),
  guest_id uuid not null,
  assigned_at timestamptz not null default now(),
  unique (event_id, direction, guest_id),
  foreign key (wedding_id, event_id, run_id, direction)
    references public.shuttle_runs (wedding_id, event_id, id, direction) on delete cascade,
  foreign key (wedding_id, guest_id) references public.guests (wedding_id, id) on delete cascade
);
create index shuttle_assignments_run_idx on public.shuttle_assignments (run_id);
create index shuttle_assignments_guest_idx on public.shuttle_assignments (wedding_id, guest_id);

alter table public.shuttle_runs enable row level security;
alter table public.shuttle_assignments enable row level security;
revoke all on public.shuttle_runs, public.shuttle_assignments from anon, authenticated;
grant select on public.shuttle_runs, public.shuttle_assignments to authenticated;
create policy shuttle_runs_select_managers on public.shuttle_runs
  for select to authenticated using (app_private.can_manage_guests(wedding_id));
create policy shuttle_assignments_select_managers on public.shuttle_assignments
  for select to authenticated using (app_private.can_manage_guests(wedding_id));

-- ---------------------------------------------------------------- helpers
-- True when the guest is attending this event: an active, accepted invitation and not archived.
create function app_private.shuttle_eligible(p_wedding uuid, p_event uuid, p_guest uuid)
returns boolean
language sql stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.invitation_members im
      join public.guests g on g.id = im.guest_id and g.wedding_id = im.wedding_id
     where im.wedding_id = p_wedding and im.event_id = p_event and im.guest_id = p_guest
       and im.active and im.rsvp_status = 'accepted' and g.archived_at is null);
$$;
revoke all on function app_private.shuttle_eligible(uuid, uuid, uuid) from public, anon, authenticated;

-- Locks one run of this wedding for update. Hides other tenants' runs.
create function app_private.lock_shuttle_run(p_wedding uuid, p_run uuid)
returns public.shuttle_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.shuttle_runs%rowtype;
begin
  select * into v_run from public.shuttle_runs
    where id = p_run and wedding_id = p_wedding for update;
  if not found then raise exception 'not permitted' using errcode = '42501'; end if;
  return v_run;
end;
$$;
revoke all on function app_private.lock_shuttle_run(uuid, uuid) from public, anon, authenticated;

-- Shared input checks for add and update. Raises 22023 on anything malformed.
create function app_private.shuttle_run_check(
  p_label text, p_pickup text, p_dropoff text, p_departs_at timestamptz, p_capacity integer, p_notes text
) returns void
language plpgsql immutable
set search_path = ''
as $$
begin
  if p_label is null or char_length(p_label) not between 1 and 60
     or p_pickup is null or char_length(p_pickup) not between 1 and 200
     or (p_dropoff is not null and char_length(p_dropoff) not between 1 and 200)
     or (p_notes is not null and char_length(p_notes) not between 1 and 500)
     or p_departs_at is null
     or p_departs_at < timestamptz '1970-01-01' or p_departs_at > timestamptz '2200-12-31'
     or p_capacity is null or p_capacity not between 1 and 100 then
    raise exception 'invalid run' using errcode = '22023';
  end if;
end;
$$;
revoke all on function app_private.shuttle_run_check(text, text, text, timestamptz, integer, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------- releases (same transaction as the change)
-- A reply, revocation or removal from an invitation: the guest keeps their rides only while they are
-- still attending. A deleted member row (an event or invitation removed) releases without an audit
-- row, because the event and its runs are usually going away in the same statement.
create function app_private.shuttle_release_member() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.invitation_members%rowtype;
  v_n integer;
begin
  if tg_op = 'DELETE' then
    delete from public.shuttle_assignments
      where event_id = old.event_id and guest_id = old.guest_id
        and not app_private.shuttle_eligible(old.wedding_id, old.event_id, old.guest_id);
    return null;
  end if;
  v_row := new;
  if v_row.active and v_row.rsvp_status = 'accepted' then
    return null;
  end if;
  if app_private.shuttle_eligible(v_row.wedding_id, v_row.event_id, v_row.guest_id) then
    return null;
  end if;
  delete from public.shuttle_assignments
    where event_id = v_row.event_id and guest_id = v_row.guest_id;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
      values (v_row.wedding_id, (select auth.uid()), 'event', v_row.event_id, 'shuttle.guest_released',
              jsonb_build_object('rides', v_n),
              (select revision from public.weddings where id = v_row.wedding_id));
  end if;
  return null;
end;
$$;
revoke all on function app_private.shuttle_release_member() from public, anon, authenticated;
create trigger invitation_members_shuttle_release
  after update of rsvp_status, active or delete on public.invitation_members
  for each row execute function app_private.shuttle_release_member();

-- Archiving a guest takes them off every run.
create function app_private.shuttle_release_guest() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event uuid;
  v_n integer;
begin
  for v_event, v_n in
    with gone as (
      delete from public.shuttle_assignments
        where wedding_id = new.wedding_id and guest_id = new.id
        returning event_id)
    select event_id, count(*)::integer from gone group by event_id
  loop
    insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
      values (new.wedding_id, (select auth.uid()), 'event', v_event, 'shuttle.guest_released',
              jsonb_build_object('rides', v_n),
              (select revision from public.weddings where id = new.wedding_id));
  end loop;
  return null;
end;
$$;
revoke all on function app_private.shuttle_release_guest() from public, anon, authenticated;
create trigger guests_shuttle_release
  after update of archived_at on public.guests
  for each row when (old.archived_at is null and new.archived_at is not null)
  execute function app_private.shuttle_release_guest();

-- ---------------------------------------------------------------- RPCs
create function public.add_shuttle_run(
  p_wedding uuid, p_event uuid, p_direction text, p_label text, p_pickup text, p_dropoff text,
  p_departs_at timestamptz, p_capacity integer, p_notes text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_label text := regexp_replace(btrim(coalesce(p_label, '')), '\s+', ' ', 'g');
  v_pickup text := nullif(regexp_replace(btrim(coalesce(p_pickup, '')), '\s+', ' ', 'g'), '');
  v_dropoff text := nullif(regexp_replace(btrim(coalesce(p_dropoff, '')), '\s+', ' ', 'g'), '');
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_id uuid;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  if not exists (select 1 from public.events where id = p_event and wedding_id = p_wedding) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_direction is null or p_direction not in ('to_event', 'from_event') then
    raise exception 'invalid run' using errcode = '22023';
  end if;
  perform app_private.shuttle_run_check(nullif(v_label, ''), v_pickup, v_dropoff, p_departs_at, p_capacity, v_notes);
  if (select count(*) from public.shuttle_runs where event_id = p_event) >= 30 then
    raise exception 'too many runs' using errcode = '54000';
  end if;
  insert into public.shuttle_runs (wedding_id, event_id, direction, label, pickup, dropoff, departs_at, capacity, notes)
    values (p_wedding, p_event, p_direction, v_label, v_pickup, v_dropoff, p_departs_at, p_capacity, v_notes)
    returning id into v_id;
  update public.weddings set revision = revision + 1 where id = p_wedding;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'shuttle_run', v_id, 'shuttle.run_added',
            jsonb_build_object('direction', p_direction, 'capacity', p_capacity), v_wedding.revision + 1);
  return v_id;
end;
$$;

-- Direction is fixed once created. Seats may not drop below the guests already on the run.
create function public.update_shuttle_run(
  p_wedding uuid, p_run uuid, p_expected_version integer, p_label text, p_pickup text,
  p_dropoff text, p_departs_at timestamptz, p_capacity integer, p_notes text default null
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_run public.shuttle_runs%rowtype;
  v_label text := regexp_replace(btrim(coalesce(p_label, '')), '\s+', ' ', 'g');
  v_pickup text := nullif(regexp_replace(btrim(coalesce(p_pickup, '')), '\s+', ' ', 'g'), '');
  v_dropoff text := nullif(regexp_replace(btrim(coalesce(p_dropoff, '')), '\s+', ' ', 'g'), '');
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  v_run := app_private.lock_shuttle_run(p_wedding, p_run);
  perform app_private.shuttle_run_check(nullif(v_label, ''), v_pickup, v_dropoff, p_departs_at, p_capacity, v_notes);
  if v_run.version <> p_expected_version then
    raise exception 'version conflict' using errcode = '55000';
  end if;
  if (select count(*) from public.shuttle_assignments where run_id = p_run) > p_capacity then
    raise exception 'run too small for its riders' using errcode = 'SH409';
  end if;
  update public.shuttle_runs
     set label = v_label, pickup = v_pickup, dropoff = v_dropoff, departs_at = p_departs_at,
         capacity = p_capacity, notes = v_notes, version = version + 1
   where id = p_run
   returning * into v_run;
  update public.weddings set revision = revision + 1 where id = p_wedding;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'shuttle_run', p_run, 'shuttle.run_updated',
            jsonb_build_object('capacity', p_capacity), v_wedding.revision + 1);
  return v_run.version;
end;
$$;

-- Removing a run returns its riders to the "no ride yet" list. Returns how many were on it.
create function public.remove_shuttle_run(p_wedding uuid, p_run uuid, p_expected_version integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_run public.shuttle_runs%rowtype;
  v_n integer;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  v_run := app_private.lock_shuttle_run(p_wedding, p_run);
  if v_run.version <> p_expected_version then
    raise exception 'version conflict' using errcode = '55000';
  end if;
  select count(*) into v_n from public.shuttle_assignments where run_id = p_run;
  delete from public.shuttle_runs where id = p_run;
  update public.weddings set revision = revision + 1 where id = p_wedding;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'shuttle_run', p_run, 'shuttle.run_removed',
            jsonb_build_object('riders', v_n), v_wedding.revision + 1);
  return v_n;
end;
$$;

-- Puts up to 20 guests on one run, all or nothing (a household rides together or not at all).
-- A guest already on another run in the same direction is moved. Repeating the same request changes
-- nothing. Returns how many guests were placed or moved.
create function public.assign_shuttle_guests(p_wedding uuid, p_run uuid, p_guests uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_run public.shuttle_runs%rowtype;
  v_guests uuid[];
  v_guest uuid;
  v_on integer;
  v_new integer;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  v_run := app_private.lock_shuttle_run(p_wedding, p_run);
  select coalesce(array_agg(distinct g), '{}') into v_guests from unnest(p_guests) g where g is not null;
  if cardinality(v_guests) = 0 then
    raise exception 'no guests' using errcode = '22023';
  end if;
  if cardinality(v_guests) > 20 then
    raise exception 'too many guests' using errcode = '54000';
  end if;
  foreach v_guest in array v_guests loop
    if not app_private.shuttle_eligible(p_wedding, v_run.event_id, v_guest) then
      raise exception 'guest not attending' using errcode = 'SH422';
    end if;
  end loop;
  select count(*) into v_on from public.shuttle_assignments where run_id = p_run;
  select count(*) into v_new from unnest(v_guests) g
    where not exists (select 1 from public.shuttle_assignments a where a.run_id = p_run and a.guest_id = g);
  if v_new = 0 then
    return 0;
  end if;
  if v_on + v_new > v_run.capacity then
    raise exception 'not enough seats' using errcode = 'SH409';
  end if;
  insert into public.shuttle_assignments (wedding_id, event_id, run_id, direction, guest_id)
    select p_wedding, v_run.event_id, p_run, v_run.direction, g from unnest(v_guests) g
    on conflict (event_id, direction, guest_id) do update
      set run_id = excluded.run_id, assigned_at = now()
      where public.shuttle_assignments.run_id <> excluded.run_id;
  update public.weddings set revision = revision + 1 where id = p_wedding;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'shuttle_run', p_run, 'shuttle.guests_assigned',
            jsonb_build_object('guests', v_new), v_wedding.revision + 1);
  return v_new;
end;
$$;

create function public.unassign_shuttle_guest(p_wedding uuid, p_run uuid, p_guest uuid)
returns void
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
  perform app_private.lock_shuttle_run(p_wedding, p_run);
  delete from public.shuttle_assignments where run_id = p_run and guest_id = p_guest;
  get diagnostics v_n = row_count;
  if v_n = 0 then return; end if;
  update public.weddings set revision = revision + 1 where id = p_wedding;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'shuttle_run', p_run, 'shuttle.guest_unassigned', '{}'::jsonb,
            v_wedding.revision + 1);
end;
$$;

revoke all on function
  public.add_shuttle_run(uuid, uuid, text, text, text, text, timestamptz, integer, text),
  public.update_shuttle_run(uuid, uuid, integer, text, text, text, timestamptz, integer, text),
  public.remove_shuttle_run(uuid, uuid, integer),
  public.assign_shuttle_guests(uuid, uuid, uuid[]),
  public.unassign_shuttle_guest(uuid, uuid, uuid)
  from public, anon;
grant execute on function
  public.add_shuttle_run(uuid, uuid, text, text, text, text, timestamptz, integer, text),
  public.update_shuttle_run(uuid, uuid, integer, text, text, text, timestamptz, integer, text),
  public.remove_shuttle_run(uuid, uuid, integer),
  public.assign_shuttle_guests(uuid, uuid, uuid[]),
  public.unassign_shuttle_guest(uuid, uuid, uuid)
  to authenticated;
