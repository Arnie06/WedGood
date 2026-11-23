-- REL-01 event demand (ADR-031 D2, D3; docs/07 "Invitations and guests").
--
-- One server-computed headcount per event, read by every page that needs reply counts.
--  * events.planning_basis (D3): 'auto' = yes plus waiting until a guest's reply date passes, then yes
--    only; 'yes' = yes only; 'yes_waiting' = yes plus waiting always. events.plan_open_plus_ones is the
--    explicit opt-in to add plus-ones that are allowed but not named yet.
--  * weddings.share_guest_totals (D2): owner-only. Off by default. When on, editors and viewers may read
--    totals from event_demand; they never get names or per-guest rows (those stay owner/partner RLS).
--  * event_demand(p_wedding) returns raw counts, one row per event. The pure planning-number rule lives
--    in src/domain/events/demand.ts so the deadline rule is tested without a database.
-- Counts use the same population as seating: active responses of guests who are not archived.

alter table public.events
  add column planning_basis text not null default 'auto'
    check (planning_basis in ('auto', 'yes', 'yes_waiting')),
  add column plan_open_plus_ones boolean not null default false;

alter table public.weddings
  add column share_guest_totals boolean not null default false;

-- ---------------------------------------------------------------- event payload validation
create or replace function app_private.event_ok(j jsonb) returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  k text;
  n text;
begin
  if j is null or jsonb_typeof(j) <> 'object' then return false; end if;
  foreach k in array array['name', 'kind', 'localDate', 'planningBasis'] loop
    if coalesce(jsonb_typeof(j -> k), 'null') not in ('null', 'string') then return false; end if;
  end loop;
  foreach k in array array['targetAttendance', 'capacity'] loop
    if coalesce(jsonb_typeof(j -> k), 'null') not in ('null', 'number') then return false; end if;
  end loop;
  if coalesce(jsonb_typeof(j -> 'planOpenPlusOnes'), 'null') not in ('null', 'boolean') then
    return false;
  end if;
  if char_length(coalesce(app_private.jtext(j, 'name'), '')) not between 1 and 120 then return false; end if;
  if coalesce(app_private.jtext(j, 'kind'), 'other')
       not in ('ceremony', 'reception', 'rehearsal', 'welcome', 'brunch', 'other') then
    return false;
  end if;
  if app_private.jtext(j, 'planningBasis') is not null
     and app_private.jtext(j, 'planningBasis') not in ('auto', 'yes', 'yes_waiting') then
    return false;
  end if;
  n := app_private.jtext(j, 'localDate');
  if n is not null and (n !~ '^\d{4}-\d{2}-\d{2}$' or to_char(n::date, 'YYYY-MM-DD') <> n) then
    return false;
  end if;
  if jsonb_typeof(j -> 'targetAttendance') = 'number'
     and ((j ->> 'targetAttendance') !~ '^\d{1,4}$' or (j ->> 'targetAttendance')::int > 5000) then
    return false;
  end if;
  if jsonb_typeof(j -> 'capacity') = 'number'
     and ((j ->> 'capacity') !~ '^\d{1,4}$' or (j ->> 'capacity')::int not between 1 and 5000) then
    return false;
  end if;
  return true;
exception when others then
  return false;
end;
$$;

-- ---------------------------------------------------------------- event writes
create or replace function public.create_event(p_wedding uuid, p_event jsonb, p_idempotency_key text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_prior uuid;
  v_id uuid;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  if not app_private.event_ok(p_event) then
    raise exception 'invalid event' using errcode = '22023';
  end if;
  if p_idempotency_key is not null then
    v_prior := app_private.idem_claim(v_user, 'create_event:' || p_wedding::text, p_idempotency_key, md5(p_event::text));
    if v_prior is not null then return v_prior; end if;
  end if;
  if (select count(*) from public.events where wedding_id = p_wedding) >= 12 then
    raise exception 'too many events' using errcode = '54000';
  end if;
  insert into public.events (wedding_id, name, kind, local_date, target_attendance, capacity,
                             planning_basis, plan_open_plus_ones)
    values (p_wedding, app_private.jtext(p_event, 'name'), coalesce(app_private.jtext(p_event, 'kind'), 'other'),
            (app_private.jtext(p_event, 'localDate'))::date,
            (p_event ->> 'targetAttendance')::int, (p_event ->> 'capacity')::int,
            coalesce(app_private.jtext(p_event, 'planningBasis'), 'auto'),
            coalesce((p_event ->> 'planOpenPlusOnes')::boolean, false))
    returning id into v_id;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'event', v_id, 'event.created', '{}'::jsonb, v_wedding.revision);
  if p_idempotency_key is not null then
    perform app_private.idem_done(v_user, 'create_event:' || p_wedding::text, p_idempotency_key, v_id);
  end if;
  return v_id;
end;
$$;

-- Full replacement from the form, except that an omitted planning field keeps its stored value.
-- A save that changes nothing does not bump the version or write audit noise.
create or replace function public.update_event(p_wedding uuid, p_event_id uuid, p_expected_version integer, p_event jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.events%rowtype;
  v_basis text;
  v_plus boolean;
  v_changed text[] := '{}';
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  if not app_private.event_ok(p_event) then
    raise exception 'invalid event' using errcode = '22023';
  end if;
  select * into v_old from public.events where id = p_event_id and wedding_id = p_wedding for update;
  if not found then raise exception 'not permitted' using errcode = '42501'; end if;
  if v_old.version <> p_expected_version then
    raise exception 'version conflict' using errcode = '55000';
  end if;
  v_basis := coalesce(app_private.jtext(p_event, 'planningBasis'), v_old.planning_basis);
  v_plus := coalesce((p_event ->> 'planOpenPlusOnes')::boolean, v_old.plan_open_plus_ones);

  if app_private.jtext(p_event, 'name') is distinct from v_old.name then v_changed := array_append(v_changed, 'name'); end if;
  if coalesce(app_private.jtext(p_event, 'kind'), 'other') is distinct from v_old.kind then v_changed := array_append(v_changed, 'kind'); end if;
  if (app_private.jtext(p_event, 'localDate'))::date is distinct from v_old.local_date then v_changed := array_append(v_changed, 'localDate'); end if;
  if (p_event ->> 'targetAttendance')::int is distinct from v_old.target_attendance then v_changed := array_append(v_changed, 'targetAttendance'); end if;
  if (p_event ->> 'capacity')::int is distinct from v_old.capacity then v_changed := array_append(v_changed, 'capacity'); end if;
  if v_basis is distinct from v_old.planning_basis then v_changed := array_append(v_changed, 'planningBasis'); end if;
  if v_plus is distinct from v_old.plan_open_plus_ones then v_changed := array_append(v_changed, 'planOpenPlusOnes'); end if;
  if coalesce(array_length(v_changed, 1), 0) = 0 then return; end if;

  update public.events
    set name = app_private.jtext(p_event, 'name'), kind = coalesce(app_private.jtext(p_event, 'kind'), 'other'),
        local_date = (app_private.jtext(p_event, 'localDate'))::date,
        target_attendance = (p_event ->> 'targetAttendance')::int, capacity = (p_event ->> 'capacity')::int,
        planning_basis = v_basis, plan_open_plus_ones = v_plus,
        version = version + 1
    where id = p_event_id;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'event', p_event_id, 'event.updated',
            jsonb_build_object('changed', to_jsonb(v_changed)), v_wedding.revision);
end;
$$;

-- ---------------------------------------------------------------- guest-totals setting (D2)
create function public.set_share_guest_totals(p_wedding uuid, p_enabled boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_old public.weddings%rowtype;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if p_enabled is null then
    raise exception 'invalid setting' using errcode = '22023';
  end if;
  select * into v_old from public.weddings where id = p_wedding for update;
  -- Only an owner may change who sees guest totals. Non-members get the same error as unknown ids.
  if not found or not app_private.has_role(p_wedding, array['owner']::public.membership_role[]) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_old.share_guest_totals = p_enabled then
    return p_enabled;
  end if;
  update public.weddings set share_guest_totals = p_enabled where id = p_wedding;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'wedding', p_wedding, 'wedding.guest_totals_sharing_changed',
            jsonb_build_object('shareGuestTotals', p_enabled), v_old.revision);
  return p_enabled;
end;
$$;
revoke all on function public.set_share_guest_totals(uuid, boolean) from public, anon;
grant execute on function public.set_share_guest_totals(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------- the headcount
-- One row per event, with the event's planning settings so no other table read is needed. Owner and partner always; editors and viewers only while the owner has turned
-- sharing on; everyone else (and strangers) get no rows. Counts only: no names, no private details.
--   invited: active responses (named guests, plus-ones included), guests not archived
--   yes / waiting / no: their answers; waiting is split by whether the reply window is still open
--   (invitation not expired and its reply date not passed)
--   open_plus_ones: unused plus-one places on invitations that can still be answered and still have a
--   named guest who has not declined; reported separately, never inside yes
--   seated_*: seats in the event's layout held by guests who are still attending (confirmed) or waiting
--   (tentative), the same population the seating page counts
--   yes_without_meal: attending guests with no meal choice
--   meals: attending guests per meal option (active options, plus retired ones still chosen)
create function public.event_demand(p_wedding uuid)
returns table (
  event_id uuid,
  planning_basis text,
  plan_open_plus_ones boolean,
  invited integer,
  yes integer,
  waiting_open integer,
  waiting_closed integer,
  no integer,
  open_plus_ones integer,
  seated_confirmed integer,
  seated_tentative integer,
  yes_without_meal integer,
  meals jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_share boolean;
begin
  if (select auth.uid()) is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app_private.is_member(p_wedding) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  select w.share_guest_totals into v_share from public.weddings w where w.id = p_wedding;
  if not (app_private.can_manage_guests(p_wedding) or coalesce(v_share, false)) then
    return;
  end if;

  return query
  select
    e.id,
    e.planning_basis,
    e.plan_open_plus_ones,
    coalesce(m.invited, 0),
    coalesce(m.yes, 0),
    coalesce(m.waiting_open, 0),
    coalesce(m.waiting_closed, 0),
    coalesce(m.no, 0),
    coalesce(p.open_plus_ones, 0),
    coalesce(s.confirmed, 0),
    coalesce(s.tentative, 0),
    coalesce(m.yes_without_meal, 0),
    coalesce(ml.meals, '[]'::jsonb)
  from public.events e
  left join lateral (
    select
      count(*)::int as invited,
      (count(*) filter (where im.rsvp_status = 'accepted'))::int as yes,
      (count(*) filter (where im.rsvp_status = 'pending'
         and i.expires_at > now() and (i.deadline is null or i.deadline >= now())))::int as waiting_open,
      (count(*) filter (where im.rsvp_status = 'pending'
         and not (i.expires_at > now() and (i.deadline is null or i.deadline >= now()))))::int as waiting_closed,
      (count(*) filter (where im.rsvp_status = 'declined'))::int as no,
      (count(*) filter (where im.rsvp_status = 'accepted' and im.meal_option_id is null))::int as yes_without_meal
    from public.invitation_members im
    join public.invitations i on i.id = im.invitation_id and i.wedding_id = im.wedding_id
    join public.guests g on g.id = im.guest_id and g.wedding_id = im.wedding_id
    where im.event_id = e.id and im.wedding_id = e.wedding_id and im.active and g.archived_at is null
  ) m on true
  left join lateral (
    select coalesce(sum(greatest(i.plus_one_quota - i.plus_ones_used, 0)), 0)::int as open_plus_ones
    from public.invitations i
    where i.event_id = e.id and i.wedding_id = e.wedding_id
      and i.revoked_at is null and i.expires_at > now()
      and (i.deadline is null or i.deadline >= now())
      and exists (
        select 1 from public.invitation_members im
        join public.guests g on g.id = im.guest_id and g.wedding_id = im.wedding_id
        where im.invitation_id = i.id and im.active and not im.is_plus_one
          and im.rsvp_status <> 'declined' and g.archived_at is null)
  ) p on true
  left join lateral (
    select
      (count(*) filter (where not sa.tentative))::int as confirmed,
      (count(*) filter (where sa.tentative))::int as tentative
    from public.seating_layouts l
    join public.seat_assignments sa on sa.layout_id = l.id and sa.wedding_id = l.wedding_id
    join public.guests g on g.id = sa.guest_id and g.wedding_id = sa.wedding_id
    where l.event_id = e.id and l.wedding_id = e.wedding_id and g.archived_at is null
  ) s on true
  left join lateral (
    select jsonb_agg(jsonb_build_object('id', mo.id, 'name', mo.name, 'active', mo.active, 'count', mo.n)
                     order by mo.created_at, mo.id) as meals
    from (
      select o.id, o.name, o.active, o.created_at,
             (select count(*) from public.invitation_members im
                join public.guests g on g.id = im.guest_id and g.wedding_id = im.wedding_id
               where im.meal_option_id = o.id and im.active and im.rsvp_status = 'accepted'
                 and g.archived_at is null)::int as n
      from public.meal_options o
      where o.event_id = e.id and o.wedding_id = e.wedding_id
    ) mo
    where mo.active or mo.n > 0
  ) ml on true
  where e.wedding_id = p_wedding
  order by e.local_date nulls last, e.name;
end;
$$;
revoke all on function public.event_demand(uuid) from public, anon;
grant execute on function public.event_demand(uuid) to authenticated;
