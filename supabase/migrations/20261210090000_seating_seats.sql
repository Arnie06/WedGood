-- Numbered seats: swap two seated guests atomically, and number a table's unnumbered guests.
-- (ADR-030, slice 3.) Builds on 20261201090000_seating.sql (seat_number, unique per table) and
-- 20261208090000_seating_details.sql (captains); nothing there is edited.
--
-- Seat numbers were already stored, unique per table and inside the table's capacity, and are already in
-- the finalized snapshot. What was missing was a way to move between two occupied seats: a plain
-- "assign" would collide on the unique index. A swap takes both guests' places in one transaction.
--
-- Both changes alter who sits where, so they advance the layout revision (a finalized copy becomes
-- stale) and write an audit event that carries no guest names.

-- ---------------------------------------------------------------- swap two seated guests
-- Each guest takes the other's table and seat number. Works within a table (exchange numbers) and
-- across tables (exchange places; table sizes are unchanged so capacity cannot be exceeded). A guest's
-- tentative flag stays with the guest. A captain who changes table stops being captain; a captain who
-- only changes seat number at the same table stays captain.
-- SE404 = one of them is not seated in this layout. 22023 = same guest twice or a missing guest.
create function public.swap_guest_seats(p_wedding uuid, p_layout uuid, p_guest_a uuid, p_guest_b uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_a public.seat_assignments%rowtype;
  v_b public.seat_assignments%rowtype;
begin
  if p_guest_a is null or p_guest_b is null or p_guest_a = p_guest_b then
    raise exception 'invalid swap' using errcode = '22023';
  end if;
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  perform app_private.lock_layout(p_wedding, p_layout);
  select * into v_a from public.seat_assignments
    where layout_id = p_layout and wedding_id = p_wedding and guest_id = p_guest_a for update;
  if not found then raise exception 'not seated' using errcode = 'SE404'; end if;
  select * into v_b from public.seat_assignments
    where layout_id = p_layout and wedding_id = p_wedding and guest_id = p_guest_b for update;
  if not found then raise exception 'not seated' using errcode = 'SE404'; end if;

  -- Free both seat numbers first (the unique index is per table and checked row by row), and drop a
  -- captain flag that would not survive the move.
  update public.seat_assignments
    set seat_number = null,
        is_captain = is_captain and v_a.table_id = v_b.table_id
    where id in (v_a.id, v_b.id);
  update public.seat_assignments
    set table_id = v_b.table_id, seat_number = v_b.seat_number, assigned_at = now()
    where id = v_a.id;
  update public.seat_assignments
    set table_id = v_a.table_id, seat_number = v_a.seat_number, assigned_at = now()
    where id = v_b.id;

  perform app_private.seating_touch(p_layout);
  update public.weddings set revision = revision + 1 where id = p_wedding;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'seating_layout', p_layout, 'seating.seats_swapped',
            jsonb_build_object('sameTable', v_a.table_id = v_b.table_id), v_wedding.revision + 1);
end;
$$;

-- ---------------------------------------------------------------- number a table's seats
-- Gives every guest at the table who has no seat number the lowest free number, in name order, so the
-- result is deterministic. Guests who already have a number keep it. Returns how many were numbered;
-- 0 changes nothing and does not touch the revision.
create function public.number_table_seats(p_wedding uuid, p_table uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_t public.seating_tables%rowtype;
  v_count integer;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  select * into v_t from public.seating_tables where id = p_table and wedding_id = p_wedding;
  if not found then raise exception 'not permitted' using errcode = '42501'; end if;
  perform app_private.lock_layout(p_wedding, v_t.layout_id);
  select * into v_t from public.seating_tables where id = p_table for update;

  with free as (
    select n, row_number() over (order by n) as rn
      from generate_series(1, v_t.capacity) n
      where n not in (
        select seat_number from public.seat_assignments
          where table_id = p_table and seat_number is not null)
  ),
  waiting as (
    select a.id, row_number() over (order by g.full_name, a.guest_id) as rn
      from public.seat_assignments a
      join public.guests g on g.id = a.guest_id and g.wedding_id = a.wedding_id
      where a.table_id = p_table and a.seat_number is null
  )
  update public.seat_assignments a
    set seat_number = free.n
    from waiting join free on free.rn = waiting.rn
    where a.id = waiting.id;
  get diagnostics v_count = row_count;

  if v_count > 0 then
    perform app_private.seating_touch(v_t.layout_id);
    update public.weddings set revision = revision + 1 where id = p_wedding;
    insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
      values (p_wedding, v_user, 'seating_table', p_table, 'seating.seats_numbered',
              jsonb_build_object('count', v_count), v_wedding.revision + 1);
  end if;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------- grants
revoke all on function public.swap_guest_seats(uuid, uuid, uuid, uuid),
  public.number_table_seats(uuid, uuid) from public, anon, authenticated;
grant execute on function public.swap_guest_seats(uuid, uuid, uuid, uuid),
  public.number_table_seats(uuid, uuid) to authenticated;
