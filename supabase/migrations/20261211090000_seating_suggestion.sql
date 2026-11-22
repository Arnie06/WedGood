-- Suggested seating: apply a reviewed proposal atomically. (ADR-030, slice 5.)
-- The proposal itself is computed in application code (pure, deterministic, never written anywhere).
-- This function is the only database change: it accepts the placements the couple reviewed and applies
-- them all, or none, if and only if the plan has not changed since the proposal was made.
--
--  - 55000: the layout revision differs from the one the proposal was made against (the plan changed).
--  - SE422: a guest in the proposal is not eligible now, or is already seated.
--  - SE409: a table cannot take the guests proposed for it.
--  - 22023: malformed input.
--
-- Guests are placed without a seat number and never as captain. A tentative flag follows the guest's
-- answer, as in `assign_guest_seat`. One revision bump and one audit event (counts only, no names).

create function public.apply_seating_suggestion(
  p_wedding uuid, p_layout uuid, p_expected_revision integer, p_placements jsonb
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_layout public.seating_layouts%rowtype;
  v_item jsonb;
  v_guest jsonb;
  v_tables uuid[] := '{}';
  v_guests uuid[] := '{}';
  v_distinct_tables uuid[];
  v_eligible integer;
  v_count integer;
  v_over record;
begin
  if p_placements is null or jsonb_typeof(p_placements) <> 'array'
     or jsonb_array_length(p_placements) not between 1 and 100 then
    raise exception 'invalid suggestion' using errcode = '22023';
  end if;

  begin
    for v_item in select value from jsonb_array_elements(p_placements) loop
      if jsonb_typeof(v_item) <> 'object' or jsonb_typeof(v_item -> 'guests') <> 'array'
         or jsonb_array_length(v_item -> 'guests') not between 1 and 100 then
        raise exception 'invalid suggestion' using errcode = '22023';
      end if;
      for v_guest in select value from jsonb_array_elements(v_item -> 'guests') loop
        if jsonb_typeof(v_guest) <> 'string' then
          raise exception 'invalid suggestion' using errcode = '22023';
        end if;
        v_tables := v_tables || (v_item ->> 'table')::uuid;
        v_guests := v_guests || (v_guest #>> '{}')::uuid;
      end loop;
    end loop;
  exception when invalid_text_representation then
    raise exception 'invalid suggestion' using errcode = '22023';
  end;
  if cardinality(v_guests) not between 1 and 1000
     or cardinality(v_guests) <> (select count(distinct g) from unnest(v_guests) g) then
    raise exception 'invalid suggestion' using errcode = '22023';
  end if;

  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  v_layout := app_private.lock_layout(p_wedding, p_layout);
  if v_layout.revision <> p_expected_revision then
    raise exception 'version conflict' using errcode = '55000';
  end if;

  -- Every table must belong to this layout. Lock them in a stable order.
  select array_agg(distinct t) into v_distinct_tables from unnest(v_tables) t;
  perform 1 from public.seating_tables
    where id = any (v_distinct_tables) and layout_id = p_layout and wedding_id = p_wedding
    order by id for update;
  if (select count(*) from public.seating_tables
        where id = any (v_distinct_tables) and layout_id = p_layout and wedding_id = p_wedding)
     <> cardinality(v_distinct_tables) then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  -- Everyone must be eligible for this event right now, and not already seated in this layout.
  select count(*) into v_eligible from (
    select im.guest_id
      from public.invitation_members im
      join public.guests g on g.id = im.guest_id and g.wedding_id = im.wedding_id
      where im.wedding_id = p_wedding and im.event_id = v_layout.event_id
        and im.guest_id = any (v_guests) and im.active and g.archived_at is null
        and (im.rsvp_status = 'accepted' or (im.rsvp_status = 'pending' and v_layout.allow_tentative))
      for share of im
  ) e;
  if v_eligible <> cardinality(v_guests) then
    raise exception 'guest not eligible' using errcode = 'SE422';
  end if;
  if exists (select 1 from public.seat_assignments
              where layout_id = p_layout and guest_id = any (v_guests)) then
    raise exception 'guest not eligible' using errcode = 'SE422';
  end if;

  -- Capacity per table, counting who is already there.
  select t.id into v_over
    from public.seating_tables t
    join (select tbl, count(*) as incoming from unnest(v_tables) tbl group by tbl) i on i.tbl = t.id
    where i.incoming + (select count(*) from public.seat_assignments a where a.table_id = t.id) > t.capacity
    limit 1;
  if found then
    raise exception 'table is full' using errcode = 'SE409';
  end if;

  insert into public.seat_assignments (wedding_id, layout_id, table_id, guest_id, seat_number, tentative)
    select p_wedding, p_layout, p.tbl, p.guest, null, (im.rsvp_status = 'pending')
      from unnest(v_tables, v_guests) as p(tbl, guest)
      join public.invitation_members im
        on im.wedding_id = p_wedding and im.event_id = v_layout.event_id
       and im.guest_id = p.guest and im.active;
  get diagnostics v_count = row_count;

  perform app_private.seating_touch(p_layout);
  update public.weddings set revision = revision + 1 where id = p_wedding;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'seating_layout', p_layout, 'seating.suggestion_applied',
            jsonb_build_object('count', v_count, 'tables', cardinality(v_distinct_tables)),
            v_wedding.revision + 1);
  return v_count;
end;
$$;

revoke all on function public.apply_seating_suggestion(uuid, uuid, integer, jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_seating_suggestion(uuid, uuid, integer, jsonb)
  to authenticated;
