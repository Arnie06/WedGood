-- UX-17 last slice: day-of check-in (wedding_ux_rsvp_audit_output/GAP_BACKLOG.md; UXR-43 "actual
-- attendance separate from Yes"; ADR-031 UX-17 check-in addendum). App switch DAY_OF_CHECKIN=on
-- (off by default). Existing roles only: no new grant area and no vendor login.
--
-- Two kinds of arrival, both recorded by a signed-in member on the day:
--   * guest_checkins: a guest arrived at an event. Actual attendance is a separate fact from the
--     reply: a "yes" who has not arrived stays "expected", and a guest who turned up without
--     answering yes can still be recorded (the page labels them). A check-in is a fact about the
--     day, so replies, revocations and archiving never delete it.
--   * vendor_arrivals: a vendor linked to the event (REL-07) arrived. The row is tied to the link,
--     so unlinking a vendor from an event clears that arrival with it.
--
-- Rules:
--   * Guest check-ins: anyone who manages guests (owner, partner, a planner with the guests grant),
--     because the list shows who was invited. Reads use the same gate. Vendor arrivals: anyone who
--     can edit the plan; every member can read them (like the agenda and the vendor links).
--   * Clients have SELECT only. Every write is an RPC. Guest writes take the per-wedding guests
--     lock, so a check-in is judged against replies that cannot change underneath it and two
--     helpers tapping the same guest cannot both record it.
--   * Idempotent: recording an arrival that exists, or undoing one that does not, changes nothing
--     and says so (the page shows "already checked in" instead of a false success).
--   * A guest can be checked in only while they have an active invitation to the event and are not
--     archived. Up to 20 guests at once, all or nothing (a household arrives together).
--   * The time is the server's clock at the moment of the tap. Nothing is typed in and nothing is
--     sent to anyone. Check-ins do not bump the wedding revision: no package or snapshot reads them.
--   * Audit rows carry counts only: no names.
--
-- Errors: 28000 sign in, 42501 not permitted / not found, 22023 invalid input, 54000 too many guests,
-- CI422 guest has no active invitation to this event, CI423 vendor is not linked to this event.

-- ---------------------------------------------------------------- tables
create table public.guest_checkins (
  event_id uuid not null,
  guest_id uuid not null,
  wedding_id uuid not null,
  checked_in_at timestamptz not null default now(),
  checked_in_by uuid references auth.users (id) on delete set null,
  primary key (event_id, guest_id),
  foreign key (wedding_id, event_id) references public.events (wedding_id, id) on delete cascade,
  foreign key (wedding_id, guest_id) references public.guests (wedding_id, id) on delete cascade
);
create index guest_checkins_wedding_idx on public.guest_checkins (wedding_id, event_id);

create table public.vendor_arrivals (
  event_id uuid not null,
  candidate_id uuid not null,
  wedding_id uuid not null,
  arrived_at timestamptz not null default now(),
  arrived_by uuid references auth.users (id) on delete set null,
  primary key (event_id, candidate_id),
  foreign key (event_id, candidate_id)
    references public.event_vendors (event_id, candidate_id) on delete cascade,
  foreign key (wedding_id, event_id) references public.events (wedding_id, id) on delete cascade
);
create index vendor_arrivals_wedding_idx on public.vendor_arrivals (wedding_id, event_id);

alter table public.guest_checkins enable row level security;
alter table public.vendor_arrivals enable row level security;
revoke all on public.guest_checkins, public.vendor_arrivals from anon, authenticated;
grant select on public.guest_checkins, public.vendor_arrivals to authenticated;
create policy guest_checkins_select_managers on public.guest_checkins
  for select to authenticated using (app_private.can_manage_guests(wedding_id));
create policy vendor_arrivals_select_member on public.vendor_arrivals
  for select to authenticated using (app_private.is_member(wedding_id));

-- ---------------------------------------------------------------- guests
-- Records up to 20 guests as arrived. Returns how many were newly recorded (guests already
-- checked in are left exactly as they were, with their original time).
create function public.check_in_guests(p_wedding uuid, p_event uuid, p_guests uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_guests uuid[];
  v_guest uuid;
  v_new integer;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  if not exists (select 1 from public.events where id = p_event and wedding_id = p_wedding) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  select coalesce(array_agg(distinct g), '{}') into v_guests from unnest(p_guests) g where g is not null;
  if cardinality(v_guests) = 0 then
    raise exception 'no guests' using errcode = '22023';
  end if;
  if cardinality(v_guests) > 20 then
    raise exception 'too many guests' using errcode = '54000';
  end if;
  foreach v_guest in array v_guests loop
    if not exists (
      select 1
        from public.invitation_members im
        join public.guests g on g.id = im.guest_id and g.wedding_id = im.wedding_id
       where im.wedding_id = p_wedding and im.event_id = p_event and im.guest_id = v_guest
         and im.active and g.archived_at is null) then
      raise exception 'guest not invited to this event' using errcode = 'CI422';
    end if;
  end loop;
  with ins as (
    insert into public.guest_checkins (event_id, guest_id, wedding_id, checked_in_by)
      select p_event, g, p_wedding, v_user from unnest(v_guests) g
      on conflict (event_id, guest_id) do nothing
      returning 1)
  select count(*)::integer into v_new from ins;
  if v_new > 0 then
    insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
      values (p_wedding, v_user, 'event', p_event, 'checkin.guests_arrived',
              jsonb_build_object('guests', v_new), v_wedding.revision);
  end if;
  return v_new;
end;
$$;

-- Takes one guest back off the arrived list (a mistaken tap). Returns false when they were not on it.
create function public.undo_guest_check_in(p_wedding uuid, p_event uuid, p_guest uuid)
returns boolean
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
  delete from public.guest_checkins
    where wedding_id = p_wedding and event_id = p_event and guest_id = p_guest;
  get diagnostics v_n = row_count;
  if v_n = 0 then return false; end if;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'event', p_event, 'checkin.guest_undone', '{}'::jsonb, v_wedding.revision);
  return true;
end;
$$;

-- ---------------------------------------------------------------- vendors
-- Records a vendor linked to this event as arrived. Returns false when already recorded.
create function public.record_vendor_arrival(p_wedding uuid, p_event uuid, p_candidate uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_n integer;
begin
  v_wedding := app_private.lock_wedding_for_plan(p_wedding);
  if not exists (select 1 from public.events where id = p_event and wedding_id = p_wedding) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.event_vendors
     where wedding_id = p_wedding and event_id = p_event and candidate_id = p_candidate) then
    raise exception 'vendor not at this event' using errcode = 'CI423';
  end if;
  insert into public.vendor_arrivals (event_id, candidate_id, wedding_id, arrived_by)
    values (p_event, p_candidate, p_wedding, v_user)
    on conflict (event_id, candidate_id) do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then return false; end if;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'event', p_event, 'checkin.vendor_arrived', '{}'::jsonb, v_wedding.revision);
  return true;
end;
$$;

create function public.undo_vendor_arrival(p_wedding uuid, p_event uuid, p_candidate uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_n integer;
begin
  v_wedding := app_private.lock_wedding_for_plan(p_wedding);
  delete from public.vendor_arrivals
    where wedding_id = p_wedding and event_id = p_event and candidate_id = p_candidate;
  get diagnostics v_n = row_count;
  if v_n = 0 then return false; end if;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'event', p_event, 'checkin.vendor_undone', '{}'::jsonb, v_wedding.revision);
  return true;
end;
$$;

revoke all on function
  public.check_in_guests(uuid, uuid, uuid[]),
  public.undo_guest_check_in(uuid, uuid, uuid),
  public.record_vendor_arrival(uuid, uuid, uuid),
  public.undo_vendor_arrival(uuid, uuid, uuid)
  from public, anon;
grant execute on function
  public.check_in_guests(uuid, uuid, uuid[]),
  public.undo_guest_check_in(uuid, uuid, uuid),
  public.record_vendor_arrival(uuid, uuid, uuid),
  public.undo_vendor_arrival(uuid, uuid, uuid)
  to authenticated;
