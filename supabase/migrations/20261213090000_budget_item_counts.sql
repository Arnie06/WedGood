-- REL-03 budget items count from replies (ADR-031 D1, D2).
--
-- A per-guest budget item chooses what it counts:
--   'event_plan'   the planning number of one event (D3; follows replies)
--   'event_yes'    the attending count of one event
--   'guest_target' the wedding's target guest count (what every item used before this migration)
--   'typed'        a number the couple typed on the item (null = not known yet)
-- Existing items keep 'guest_target' through the column default, so no forecast changes on upgrade.
-- Only per_guest items may use another source. The count itself is never stored: it is read from the
-- replies each time, so it can never go stale.
--
-- Visibility (D2). Budget amounts stay readable by every member. Reply counts do not: they come from
-- event_demand, which collaborators can read only while the owner shares guest totals. The forecast
-- still has to follow replies for everyone, so budget_item_counts returns one number per reply-based
-- item (no yes/waiting/no breakdown, no names) to any member. A member who knows an item's price per
-- guest and amount can already work that number out (the documented limit in ADR-031 D2).

-- ---------------------------------------------------------------- columns
alter table public.budget_items
  add column count_source text not null default 'guest_target'
    check (count_source in ('event_plan', 'event_yes', 'guest_target', 'typed')),
  add column count_event_id uuid,
  add column count_typed integer check (count_typed is null or count_typed between 1 and 100000),
  add constraint budget_items_count_event_fk
    foreign key (wedding_id, count_event_id) references public.events (wedding_id, id),
  add constraint budget_items_count_shape check (
    (count_source in ('event_plan', 'event_yes')) = (count_event_id is not null)
    and (count_typed is null or count_source = 'typed')
    and (count_source = 'guest_target' or cost_mode = 'per_guest')
  );
create index budget_items_count_event_idx on public.budget_items (wedding_id, count_event_id)
  where count_event_id is not null;

-- ---------------------------------------------------------------- the headcount, split from its check
-- event_demand keeps its contract (owner and partner always; others only while sharing is on). Its
-- query moves into an internal function with no permission check so budget_item_counts can use the
-- same population and rules. Nothing outside the two public functions may call it.
create function app_private.event_demand_rows(p_wedding uuid)
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
language sql
stable
security definer
set search_path = ''
as $$
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
$$;
revoke all on function app_private.event_demand_rows(uuid) from public, anon, authenticated;

create or replace function public.event_demand(p_wedding uuid)
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
  return query select * from app_private.event_demand_rows(p_wedding);
end;
$$;
revoke all on function public.event_demand(uuid) from public, anon;
grant execute on function public.event_demand(uuid) to authenticated;

-- ---------------------------------------------------------------- one number per reply-based item
-- item_count is null when nobody is invited to the event yet: that is "no count yet", never zero.
-- The planning-number rule mirrors src/domain/events/demand.ts (planningNumber); the integration test
-- compares the two so they cannot drift.
create function public.budget_item_counts(p_wedding uuid)
returns table (item_id uuid, event_id uuid, item_count integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app_private.is_member(p_wedding) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return query
  select bi.id, bi.count_event_id,
    case
      when d.event_id is null or d.invited = 0 then null
      when bi.count_source = 'event_yes' then d.yes
      else d.yes
        + case d.planning_basis
            when 'auto' then d.waiting_open
            when 'yes_waiting' then d.waiting_open + d.waiting_closed
            else 0 end
        + case when d.plan_open_plus_ones then d.open_plus_ones else 0 end
    end
  from public.budget_items bi
  left join app_private.event_demand_rows(p_wedding) d on d.event_id = bi.count_event_id
  where bi.wedding_id = p_wedding and bi.archived_at is null
    and bi.count_source in ('event_plan', 'event_yes')
  order by bi.created_at, bi.id;
end;
$$;
revoke all on function public.budget_item_counts(uuid) from public, anon;
grant execute on function public.budget_item_counts(uuid) to authenticated;

-- ---------------------------------------------------------------- item writes
create function app_private.assert_budget_item_count(
  p_cost_mode text, p_source text, p_event uuid, p_typed integer
) returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_source is null or p_source not in ('event_plan', 'event_yes', 'guest_target', 'typed')
     or (p_source <> 'guest_target' and p_cost_mode is distinct from 'per_guest')
     or ((p_source in ('event_plan', 'event_yes')) <> (p_event is not null))
     or (p_typed is not null and (p_source <> 'typed' or p_typed not between 1 and 100000)) then
    raise exception 'invalid count' using errcode = '22023';
  end if;
end;
$$;
revoke all on function app_private.assert_budget_item_count(text, text, uuid, integer) from public, anon;
grant execute on function app_private.assert_budget_item_count(text, text, uuid, integer) to authenticated;

-- New optional arguments change the signature, so the old functions are replaced, not overloaded.
drop function public.create_budget_item(uuid, uuid, text, text, bigint, integer, integer, text, text);
drop function public.update_budget_item(uuid, uuid, integer, uuid, text, text, bigint, integer, integer, text);

create function public.create_budget_item(
  p_wedding uuid,
  p_category uuid,
  p_name text,
  p_cost_mode text default 'fixed',
  p_amount_minor bigint default null,
  p_quantity integer default null,
  p_min_qty integer default null,
  p_notes text default null,
  p_idempotency_key text default null,
  p_count_source text default 'guest_target',
  p_count_event uuid default null,
  p_count_typed integer default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_name text := btrim(coalesce(p_name, ''));
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_hash text;
  v_prior uuid;
  v_id uuid;
begin
  v_wedding := app_private.lock_wedding_for_budget(p_wedding);
  perform app_private.assert_budget_item_fields(v_name, p_cost_mode, p_amount_minor, p_quantity, p_min_qty, v_notes);
  perform app_private.assert_budget_item_count(p_cost_mode, p_count_source, p_count_event, p_count_typed);
  if p_idempotency_key is not null then
    v_hash := md5(concat_ws('|', p_category::text, v_name, p_cost_mode, coalesce(p_amount_minor::text, ''),
      coalesce(p_quantity::text, ''), coalesce(p_min_qty::text, ''), coalesce(v_notes, ''),
      p_count_source, coalesce(p_count_event::text, ''), coalesce(p_count_typed::text, '')));
    v_prior := app_private.idem_claim(v_user, 'create_budget_item:' || p_wedding::text, p_idempotency_key, v_hash);
    if v_prior is not null then
      return v_prior;
    end if;
  end if;
  perform 1 from public.budget_categories
    where id = p_category and wedding_id = p_wedding and archived_at is null for share;
  if not found then
    raise exception 'category not available' using errcode = '22023';
  end if;
  if p_count_event is not null then
    perform 1 from public.events where id = p_count_event and wedding_id = p_wedding for share;
    if not found then
      raise exception 'event not available' using errcode = '22023';
    end if;
  end if;
  if (select count(*) from public.budget_items where wedding_id = p_wedding and archived_at is null) >= 300 then
    raise exception 'too many costs' using errcode = '54000';
  end if;
  insert into public.budget_items (wedding_id, category_id, name, cost_mode, amount_minor, quantity, min_qty, notes,
                                   count_source, count_event_id, count_typed, created_by)
    values (p_wedding, p_category, v_name, p_cost_mode, p_amount_minor, p_quantity, p_min_qty, v_notes,
            p_count_source, p_count_event, p_count_typed, v_user)
    returning id into v_id;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'budget_item', v_id, 'budget.item_created',
            jsonb_build_object('costMode', p_cost_mode, 'amountKnown', p_amount_minor is not null,
                               'countSource', p_count_source), v_wedding.revision);
  if p_idempotency_key is not null then
    perform app_private.idem_done(v_user, 'create_budget_item:' || p_wedding::text, p_idempotency_key, v_id);
  end if;
  return v_id;
end;
$$;

-- Full replacement from the form. A save that changes nothing does not bump the version.
create function public.update_budget_item(
  p_wedding uuid,
  p_item uuid,
  p_expected_version integer,
  p_category uuid,
  p_name text,
  p_cost_mode text,
  p_amount_minor bigint default null,
  p_quantity integer default null,
  p_min_qty integer default null,
  p_notes text default null,
  p_count_source text default 'guest_target',
  p_count_event uuid default null,
  p_count_typed integer default null
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.budget_items%rowtype;
  v_name text := btrim(coalesce(p_name, ''));
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_changed text[] := '{}';
  v_version integer;
begin
  v_wedding := app_private.lock_wedding_for_budget(p_wedding);
  perform app_private.assert_budget_item_fields(v_name, p_cost_mode, p_amount_minor, p_quantity, p_min_qty, v_notes);
  perform app_private.assert_budget_item_count(p_cost_mode, p_count_source, p_count_event, p_count_typed);
  select * into v_old from public.budget_items where id = p_item and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_old.archived_at is not null or v_old.version <> p_expected_version then
    raise exception 'cost changed, reload' using errcode = '55000';
  end if;
  if p_category is distinct from v_old.category_id then
    perform 1 from public.budget_categories
      where id = p_category and wedding_id = p_wedding and archived_at is null for share;
    if not found then
      raise exception 'category not available' using errcode = '22023';
    end if;
    v_changed := array_append(v_changed, 'category');
  end if;
  if p_count_event is not null and p_count_event is distinct from v_old.count_event_id then
    perform 1 from public.events where id = p_count_event and wedding_id = p_wedding for share;
    if not found then
      raise exception 'event not available' using errcode = '22023';
    end if;
  end if;
  if v_name is distinct from v_old.name then v_changed := array_append(v_changed, 'name'); end if;
  if p_cost_mode is distinct from v_old.cost_mode then v_changed := array_append(v_changed, 'costMode'); end if;
  if p_amount_minor is distinct from v_old.amount_minor then v_changed := array_append(v_changed, 'amount'); end if;
  if p_quantity is distinct from v_old.quantity or p_min_qty is distinct from v_old.min_qty
    then v_changed := array_append(v_changed, 'quantity'); end if;
  if p_count_source is distinct from v_old.count_source
     or p_count_event is distinct from v_old.count_event_id
     or p_count_typed is distinct from v_old.count_typed
    then v_changed := array_append(v_changed, 'countSource'); end if;
  if v_notes is distinct from v_old.notes then v_changed := array_append(v_changed, 'notes'); end if;
  if coalesce(array_length(v_changed, 1), 0) = 0 then
    return v_old.version;
  end if;
  update public.budget_items set category_id = p_category, name = v_name, cost_mode = p_cost_mode,
      amount_minor = p_amount_minor, quantity = p_quantity, min_qty = p_min_qty, notes = v_notes,
      count_source = p_count_source, count_event_id = p_count_event, count_typed = p_count_typed
    where id = p_item returning version into v_version;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'budget_item', p_item, 'budget.item_updated',
            jsonb_build_object('changed', to_jsonb(v_changed)), v_wedding.revision);
  return v_version;
end;
$$;

revoke all on function public.create_budget_item(uuid, uuid, text, text, bigint, integer, integer, text, text, text, uuid, integer) from public, anon;
revoke all on function public.update_budget_item(uuid, uuid, integer, uuid, text, text, bigint, integer, integer, text, text, uuid, integer) from public, anon;
grant execute on function public.create_budget_item(uuid, uuid, text, text, bigint, integer, integer, text, text, text, uuid, integer) to authenticated;
grant execute on function public.update_budget_item(uuid, uuid, integer, uuid, text, text, bigint, integer, integer, text, text, uuid, integer) to authenticated;
