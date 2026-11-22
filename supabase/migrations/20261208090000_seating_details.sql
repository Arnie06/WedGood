-- Seating details: table captains, table shape and notes, seating a household together.
-- (ADR-030, slice 1.) Builds on 20261201090000_seating.sql; nothing there is edited.
--
-- Captain model: the captain flag lives on the seat assignment, not on the table. A captain is
-- therefore always someone who is seated at that table: unseating, a decline, archiving, moving
-- to another table or removing the table clears it with no extra code, and a table can never point
-- at a guest who is not there. One captain per table (partial unique index).

alter table public.seat_assignments add column is_captain boolean not null default false;
create unique index seat_assignments_captain_uq on public.seat_assignments (table_id)
  where is_captain;

alter table public.seating_tables
  add column shape text not null default 'round' check (shape in ('round', 'rectangle')),
  add column notes text check (notes is null or (char_length(notes) between 1 and 300 and notes = btrim(notes)));

-- ---------------------------------------------------------------- tables: shape and notes
drop function public.add_seating_table(uuid, uuid, text, integer);
create function public.add_seating_table(
  p_wedding uuid, p_layout uuid, p_label text, p_capacity integer, p_shape text default 'round'
) returns uuid
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
  if char_length(v_label) not between 1 and 60 or p_capacity is null or p_capacity not between 1 and 50
     or p_shape is null or p_shape not in ('round', 'rectangle') then
    raise exception 'invalid table' using errcode = '22023';
  end if;
  if (select count(*) from public.seating_tables where layout_id = p_layout) >= 100 then
    raise exception 'too many tables' using errcode = '54000';
  end if;
  insert into public.seating_tables (wedding_id, layout_id, label, capacity, shape)
    values (p_wedding, p_layout, v_label, p_capacity, p_shape) returning id into v_id;
  perform app_private.seating_touch(p_layout);
  update public.weddings set revision = revision + 1 where id = p_wedding;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'seating_table', v_id, 'seating.table_added', '{}'::jsonb, v_wedding.revision + 1);
  return v_id;
end;
$$;

-- Shape and notes are optional: null keeps the current shape, null or blank notes clears the note.
-- Capacity may not drop below the guests already seated or the highest numbered seat in use.
drop function public.update_seating_table(uuid, uuid, integer, text, integer);
create function public.update_seating_table(
  p_wedding uuid, p_table uuid, p_expected_version integer, p_label text, p_capacity integer,
  p_shape text default null, p_notes text default null
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_label text := regexp_replace(btrim(coalesce(p_label, '')), '\s+', ' ', 'g');
  v_notes text := nullif(regexp_replace(btrim(coalesce(p_notes, '')), '\s+', ' ', 'g'), '');
  v_t public.seating_tables%rowtype;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  select * into v_t from public.seating_tables where id = p_table and wedding_id = p_wedding for update;
  if not found then raise exception 'not permitted' using errcode = '42501'; end if;
  perform app_private.lock_layout(p_wedding, v_t.layout_id);
  if char_length(v_label) not between 1 and 60 or p_capacity is null or p_capacity not between 1 and 50
     or (p_shape is not null and p_shape not in ('round', 'rectangle'))
     or (v_notes is not null and char_length(v_notes) > 300) then
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
  update public.seating_tables
    set label = v_label, capacity = p_capacity, shape = coalesce(p_shape, shape), notes = v_notes,
        version = version + 1
    where id = p_table;
  perform app_private.seating_touch(v_t.layout_id);
  update public.weddings set revision = revision + 1 where id = p_wedding;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'seating_table', p_table, 'seating.table_updated', '{}'::jsonb, v_wedding.revision + 1);
end;
$$;

-- ---------------------------------------------------------------- seating a guest
-- Same as before, plus: moving a guest to another table clears the captain flag. Changing only the
-- seat number at the same table keeps it.
create or replace function public.assign_guest_seat(
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
          tentative = excluded.tentative, assigned_at = now(),
          is_captain = public.seat_assignments.is_captain
                       and public.seat_assignments.table_id = excluded.table_id;
  perform app_private.seating_touch(p_layout);
  update public.weddings set revision = revision + 1 where id = p_wedding;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'seating_layout', p_layout, 'seating.guest_seated',
            jsonb_build_object('tentative', v_tentative), v_wedding.revision + 1);
end;
$$;

-- Seats several guests at one table in a single transaction (a household or a guest with a plus-one).
-- All or nothing: if the table can't take everyone not already there, or anyone isn't eligible, nobody
-- moves. SE409 = no room, SE422 = someone isn't eligible. Returns how many were placed or moved.
create function public.assign_household_seats(
  p_wedding uuid, p_layout uuid, p_table uuid, p_guests uuid[]
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_layout public.seating_layouts%rowtype;
  v_t public.seating_tables%rowtype;
  v_ids uuid[];
  v_guest uuid;
  v_status text;
  v_tentative boolean;
  v_used integer;
  v_incoming integer := 0;
  v_moved integer := 0;
  v_here boolean;
begin
  if p_guests is null or cardinality(p_guests) not between 1 and 20 then
    raise exception 'invalid group' using errcode = '22023';
  end if;
  select array_agg(distinct g) into v_ids from unnest(p_guests) g where g is not null;
  if v_ids is null or cardinality(v_ids) <> cardinality(p_guests) then
    raise exception 'invalid group' using errcode = '22023';
  end if;
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  v_layout := app_private.lock_layout(p_wedding, p_layout);
  select * into v_t from public.seating_tables
    where id = p_table and layout_id = p_layout and wedding_id = p_wedding for update;
  if not found then raise exception 'not permitted' using errcode = '42501'; end if;

  -- Eligibility first, in a stable order, so nothing is written when anyone is refused.
  foreach v_guest in array v_ids loop
    select im.rsvp_status into v_status
      from public.invitation_members im
      join public.guests g on g.id = im.guest_id and g.wedding_id = im.wedding_id
      where im.wedding_id = p_wedding and im.event_id = v_layout.event_id and im.guest_id = v_guest
        and im.active and g.archived_at is null
      for share of im;
    if v_status is null or v_status = 'declined' or (v_status = 'pending' and not v_layout.allow_tentative) then
      raise exception 'guest not eligible' using errcode = 'SE422';
    end if;
  end loop;

  select count(*) into v_used from public.seat_assignments
    where table_id = p_table and not (guest_id = any (v_ids));
  v_incoming := cardinality(v_ids);
  if v_used + v_incoming > v_t.capacity then
    raise exception 'table is full' using errcode = 'SE409';
  end if;

  foreach v_guest in array v_ids loop
    select exists (select 1 from public.seat_assignments
                    where layout_id = p_layout and guest_id = v_guest and table_id = p_table)
      into v_here;
    if v_here then continue; end if;
    select (im.rsvp_status = 'pending') into v_tentative
      from public.invitation_members im
      where im.wedding_id = p_wedding and im.event_id = v_layout.event_id and im.guest_id = v_guest
        and im.active;
    insert into public.seat_assignments (wedding_id, layout_id, table_id, guest_id, seat_number, tentative)
      values (p_wedding, p_layout, p_table, v_guest, null, v_tentative)
      on conflict (layout_id, guest_id) do update
        set table_id = excluded.table_id, seat_number = null, tentative = excluded.tentative,
            assigned_at = now(), is_captain = false;
    v_moved := v_moved + 1;
  end loop;

  if v_moved = 0 then return 0; end if;
  perform app_private.seating_touch(p_layout);
  update public.weddings set revision = revision + 1 where id = p_wedding;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'seating_layout', p_layout, 'seating.group_seated',
            jsonb_build_object('count', v_moved), v_wedding.revision + 1);
  return v_moved;
end;
$$;

-- Makes one seated guest the captain of their table, or clears the captain when p_guest is null.
-- Idempotent. SE422 = that guest isn't seated at this table.
create function public.set_table_captain(p_wedding uuid, p_table uuid, p_guest uuid default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_t public.seating_tables%rowtype;
  v_current uuid;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  select * into v_t from public.seating_tables where id = p_table and wedding_id = p_wedding for update;
  if not found then raise exception 'not permitted' using errcode = '42501'; end if;
  perform app_private.lock_layout(p_wedding, v_t.layout_id);
  select guest_id into v_current from public.seat_assignments where table_id = p_table and is_captain;
  if p_guest is null then
    if v_current is null then return; end if;
  else
    if v_current = p_guest then return; end if;
    if not exists (select 1 from public.seat_assignments where table_id = p_table and guest_id = p_guest) then
      raise exception 'guest not seated here' using errcode = 'SE422';
    end if;
  end if;
  update public.seat_assignments set is_captain = false where table_id = p_table and is_captain;
  if p_guest is not null then
    update public.seat_assignments set is_captain = true where table_id = p_table and guest_id = p_guest;
  end if;
  perform app_private.seating_touch(v_t.layout_id);
  update public.weddings set revision = revision + 1 where id = p_wedding;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'seating_table', p_table, 'seating.captain_changed',
            jsonb_build_object('cleared', p_guest is null), v_wedding.revision + 1);
end;
$$;

-- ---------------------------------------------------------------- finalized snapshot
-- Same freeze as before, plus table shape and notes and who the captain is.
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
  update public.weddings set revision = revision + 1 where id = p_wedding;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'seating_layout', p_layout, 'seating.finalized',
            jsonb_build_object('layoutRevision', v_layout.revision), v_wedding.revision + 1);
end;
$$;

-- ---------------------------------------------------------------- grants
revoke all on function public.add_seating_table(uuid, uuid, text, integer, text),
  public.update_seating_table(uuid, uuid, integer, text, integer, text, text),
  public.assign_household_seats(uuid, uuid, uuid, uuid[]),
  public.set_table_captain(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.add_seating_table(uuid, uuid, text, integer, text),
  public.update_seating_table(uuid, uuid, integer, text, integer, text, text),
  public.assign_household_seats(uuid, uuid, uuid, uuid[]),
  public.set_table_captain(uuid, uuid, uuid) to authenticated;
