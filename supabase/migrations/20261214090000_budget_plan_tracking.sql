-- REL-03 follow-up: a permanent plan, with replies tracked against it.
--
-- The plan is the event's "planned attendance" (events.target_attendance). It is never replaced by
-- replies; the couple edits it on purpose, and every change records its old and new value in the audit
-- log so the original can be compared with the actual at the end.
--
-- A reply-based cost is priced by:
--   * the larger of the plan and the actual count, while invitations are still going out, so the
--     forecast does not understate a plan that has only half its invitations sent, and does not hide
--     an overrun either;
--   * the actual count alone once the couple marks the event's invitations complete
--     (events.invitations_final), so a plan of 120 does not keep pricing a 90-guest reception.
-- With no plan and nobody invited the cost is unknown, as before.
--
-- budget_item_counts returns plan and priced counts to every member (the plan is the couple's own
-- expectation, not guest data) and the actual count only to those who may read guest totals (D2).

alter table public.events add column invitations_final boolean not null default false;

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
  foreach k in array array['planOpenPlusOnes', 'invitationsFinal'] loop
    if coalesce(jsonb_typeof(j -> k), 'null') not in ('null', 'boolean') then return false; end if;
  end loop;
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
                             planning_basis, plan_open_plus_ones, invitations_final)
    values (p_wedding, app_private.jtext(p_event, 'name'), coalesce(app_private.jtext(p_event, 'kind'), 'other'),
            (app_private.jtext(p_event, 'localDate'))::date,
            (p_event ->> 'targetAttendance')::int, (p_event ->> 'capacity')::int,
            coalesce(app_private.jtext(p_event, 'planningBasis'), 'auto'),
            coalesce((p_event ->> 'planOpenPlusOnes')::boolean, false),
            coalesce((p_event ->> 'invitationsFinal')::boolean, false))
    returning id into v_id;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'event', v_id, 'event.created',
            case when (p_event ->> 'targetAttendance') is null then '{}'::jsonb
                 else jsonb_build_object('plannedAttendance', jsonb_build_object('to', (p_event ->> 'targetAttendance')::int)) end,
            v_wedding.revision);
  if p_idempotency_key is not null then
    perform app_private.idem_done(v_user, 'create_event:' || p_wedding::text, p_idempotency_key, v_id);
  end if;
  return v_id;
end;
$$;

-- Full replacement from the form, except that an omitted planning field keeps its stored value.
-- A save that changes nothing does not bump the version or write audit noise. A change to the planned
-- attendance records the old and new number, so the original plan is never lost.
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
  v_final boolean;
  v_changed text[] := '{}';
  v_details jsonb;
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
  v_final := coalesce((p_event ->> 'invitationsFinal')::boolean, v_old.invitations_final);

  if app_private.jtext(p_event, 'name') is distinct from v_old.name then v_changed := array_append(v_changed, 'name'); end if;
  if coalesce(app_private.jtext(p_event, 'kind'), 'other') is distinct from v_old.kind then v_changed := array_append(v_changed, 'kind'); end if;
  if (app_private.jtext(p_event, 'localDate'))::date is distinct from v_old.local_date then v_changed := array_append(v_changed, 'localDate'); end if;
  if (p_event ->> 'targetAttendance')::int is distinct from v_old.target_attendance then v_changed := array_append(v_changed, 'targetAttendance'); end if;
  if (p_event ->> 'capacity')::int is distinct from v_old.capacity then v_changed := array_append(v_changed, 'capacity'); end if;
  if v_basis is distinct from v_old.planning_basis then v_changed := array_append(v_changed, 'planningBasis'); end if;
  if v_plus is distinct from v_old.plan_open_plus_ones then v_changed := array_append(v_changed, 'planOpenPlusOnes'); end if;
  if v_final is distinct from v_old.invitations_final then v_changed := array_append(v_changed, 'invitationsFinal'); end if;
  if coalesce(array_length(v_changed, 1), 0) = 0 then return; end if;

  v_details := jsonb_build_object('changed', to_jsonb(v_changed));
  if 'targetAttendance' = any (v_changed) then
    v_details := v_details || jsonb_build_object('plannedAttendance',
      jsonb_build_object('from', v_old.target_attendance, 'to', (p_event ->> 'targetAttendance')::int));
  end if;

  update public.events
    set name = app_private.jtext(p_event, 'name'), kind = coalesce(app_private.jtext(p_event, 'kind'), 'other'),
        local_date = (app_private.jtext(p_event, 'localDate'))::date,
        target_attendance = (p_event ->> 'targetAttendance')::int, capacity = (p_event ->> 'capacity')::int,
        planning_basis = v_basis, plan_open_plus_ones = v_plus, invitations_final = v_final,
        version = version + 1
    where id = p_event_id;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'event', p_event_id, 'event.updated', v_details, v_wedding.revision);
end;
$$;

-- ---------------------------------------------------------------- plan, actual and priced count per item
drop function public.budget_item_counts(uuid);
create function public.budget_item_counts(p_wedding uuid)
returns table (
  item_id uuid,
  event_id uuid,
  item_count integer,
  plan_count integer,
  actual_count integer,
  invitations_final boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_share boolean;
  v_see boolean;
begin
  if (select auth.uid()) is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app_private.is_member(p_wedding) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  select w.share_guest_totals into v_share from public.weddings w where w.id = p_wedding;
  v_see := app_private.can_manage_guests(p_wedding) or coalesce(v_share, false);

  return query
  with base as (
    select bi.id as item, e.id as event, bi.created_at,
      e.target_attendance as plan, e.invitations_final as final,
      -- actual: null until somebody is invited. Mirrors src/domain/events/demand.ts (planningNumber);
      -- the integration test compares the two.
      case
        when d.event_id is null or d.invited = 0 then null
        when bi.count_source = 'event_yes' then d.yes
        else d.yes
          + case d.planning_basis
              when 'auto' then d.waiting_open
              when 'yes_waiting' then d.waiting_open + d.waiting_closed
              else 0 end
          + case when d.plan_open_plus_ones then d.open_plus_ones else 0 end
      end as actual
    from public.budget_items bi
    join public.events e on e.id = bi.count_event_id and e.wedding_id = bi.wedding_id
    left join app_private.event_demand_rows(p_wedding) d on d.event_id = e.id
    where bi.wedding_id = p_wedding and bi.archived_at is null
      and bi.count_source in ('event_plan', 'event_yes')
  )
  select b.item, b.event,
    case when b.final then b.actual else greatest(b.plan, b.actual) end,
    b.plan,
    case when v_see then b.actual else null end,
    b.final
  from base b
  order by b.created_at, b.item;
end;
$$;
revoke all on function public.budget_item_counts(uuid) from public, anon;
grant execute on function public.budget_item_counts(uuid) to authenticated;
