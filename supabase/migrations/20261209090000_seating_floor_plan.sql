-- Seating floor plan: where tables and venue elements sit in the room.
-- (ADR-030, slice 2.) Builds on 20261208090000_seating_details.sql; nothing there is edited.
--
-- The room is an abstract grid of 120 x 80 units (docs/07: schematic only, no real-world scale and no
-- clearance or fire-code claim). A table's position is its centre; null means "not placed yet" and the
-- page lays unplaced tables out on a tidy grid until someone moves them. An element's x and y are its
-- top-left corner. Bounds are enforced here; overlap is deliberately NOT forbidden (a head table may
-- sit on a stage), the page shows it as an advisory instead.
--
-- Positions are not part of the finalized snapshot (names, tables and meals only), so moving things
-- does not make a finalized plan stale and does not bump the layout revision. A move is last-write-wins
-- (it takes no expected version, so dragging never fails on a stale one). The row's own version does
-- still advance on every update, so an edit form left open while the other partner moves the table is
-- refused with the usual "reload" message instead of silently overwriting.

alter table public.seating_tables
  add column pos_x integer check (pos_x is null or pos_x between 0 and 120),
  add column pos_y integer check (pos_y is null or pos_y between 0 and 80),
  add constraint seating_tables_pos_pair check ((pos_x is null) = (pos_y is null));

create table public.seating_elements (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null,
  layout_id uuid not null,
  kind text not null check (kind in
    ('dance_floor', 'stage', 'head_table', 'bar', 'buffet', 'entrance', 'dj', 'cake', 'photo', 'other')),
  label text not null check (char_length(label) between 1 and 60 and label = btrim(label)),
  x integer not null check (x between 0 and 118),
  y integer not null check (y between 0 and 78),
  w integer not null check (w between 2 and 120),
  h integer not null check (h between 2 and 80),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint seating_elements_inside check (x + w <= 120 and y + h <= 80),
  foreign key (wedding_id, layout_id) references public.seating_layouts (wedding_id, id) on delete cascade
);
create index seating_elements_layout_idx on public.seating_elements (layout_id);
create trigger seating_elements_touch before update on public.seating_elements
  for each row execute function app_private.touch_updated_at();

alter table public.seating_elements enable row level security;
revoke all on public.seating_elements from anon, authenticated;
grant select on public.seating_elements to authenticated;
create policy seating_elements_select_managers on public.seating_elements
  for select to authenticated using (app_private.can_manage_guests(wedding_id));

-- ---------------------------------------------------------------- moving a table
-- Idempotent. Null x and y return the table to "not placed".
create function public.move_seating_table(p_wedding uuid, p_table uuid, p_x integer, p_y integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t public.seating_tables%rowtype;
begin
  perform app_private.lock_wedding_for_guests(p_wedding);
  select * into v_t from public.seating_tables where id = p_table and wedding_id = p_wedding for update;
  if not found then raise exception 'not permitted' using errcode = '42501'; end if;
  if (p_x is null) <> (p_y is null)
     or (p_x is not null and (p_x not between 0 and 120 or p_y not between 0 and 80)) then
    raise exception 'invalid position' using errcode = '22023';
  end if;
  if v_t.pos_x is not distinct from p_x and v_t.pos_y is not distinct from p_y then return; end if;
  update public.seating_tables set pos_x = p_x, pos_y = p_y where id = p_table;
end;
$$;

-- ---------------------------------------------------------------- venue elements
create function public.add_seating_element(
  p_wedding uuid, p_layout uuid, p_kind text, p_label text, p_x integer, p_y integer,
  p_w integer, p_h integer
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
  if char_length(v_label) not between 1 and 60
     or p_kind is null or p_kind not in
       ('dance_floor', 'stage', 'head_table', 'bar', 'buffet', 'entrance', 'dj', 'cake', 'photo', 'other')
     or p_x is null or p_y is null or p_w is null or p_h is null
     or p_w not between 2 and 120 or p_h not between 2 and 80
     or p_x < 0 or p_y < 0 or p_x + p_w > 120 or p_y + p_h > 80 then
    raise exception 'invalid element' using errcode = '22023';
  end if;
  if (select count(*) from public.seating_elements where layout_id = p_layout) >= 40 then
    raise exception 'too many elements' using errcode = '54000';
  end if;
  insert into public.seating_elements (wedding_id, layout_id, kind, label, x, y, w, h)
    values (p_wedding, p_layout, p_kind, v_label, p_x, p_y, p_w, p_h) returning id into v_id;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'seating_element', v_id, 'seating.element_added',
            jsonb_build_object('kind', p_kind), v_wedding.revision);
  return v_id;
end;
$$;

-- Label, size and position together, with a version check (the edit form). Dragging uses
-- move_seating_element, which is last-write-wins like a table move.
create function public.update_seating_element(
  p_wedding uuid, p_element uuid, p_expected_version integer, p_label text,
  p_x integer, p_y integer, p_w integer, p_h integer
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_label text := regexp_replace(btrim(coalesce(p_label, '')), '\s+', ' ', 'g');
  v_e public.seating_elements%rowtype;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  select * into v_e from public.seating_elements where id = p_element and wedding_id = p_wedding for update;
  if not found then raise exception 'not permitted' using errcode = '42501'; end if;
  if char_length(v_label) not between 1 and 60
     or p_x is null or p_y is null or p_w is null or p_h is null
     or p_w not between 2 and 120 or p_h not between 2 and 80
     or p_x < 0 or p_y < 0 or p_x + p_w > 120 or p_y + p_h > 80 then
    raise exception 'invalid element' using errcode = '22023';
  end if;
  if v_e.version <> p_expected_version then
    raise exception 'version conflict' using errcode = '55000';
  end if;
  update public.seating_elements
    set label = v_label, x = p_x, y = p_y, w = p_w, h = p_h, version = version + 1
    where id = p_element;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'seating_element', p_element, 'seating.element_updated', '{}'::jsonb,
            v_wedding.revision);
end;
$$;

create function public.move_seating_element(p_wedding uuid, p_element uuid, p_x integer, p_y integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_e public.seating_elements%rowtype;
begin
  perform app_private.lock_wedding_for_guests(p_wedding);
  select * into v_e from public.seating_elements where id = p_element and wedding_id = p_wedding for update;
  if not found then raise exception 'not permitted' using errcode = '42501'; end if;
  if p_x is null or p_y is null or p_x < 0 or p_y < 0 or p_x + v_e.w > 120 or p_y + v_e.h > 80 then
    raise exception 'invalid position' using errcode = '22023';
  end if;
  if v_e.x = p_x and v_e.y = p_y then return; end if;
  update public.seating_elements set x = p_x, y = p_y where id = p_element;
end;
$$;

create function public.remove_seating_element(p_wedding uuid, p_element uuid, p_expected_version integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_e public.seating_elements%rowtype;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  select * into v_e from public.seating_elements where id = p_element and wedding_id = p_wedding for update;
  if not found then raise exception 'not permitted' using errcode = '42501'; end if;
  if v_e.version <> p_expected_version then
    raise exception 'version conflict' using errcode = '55000';
  end if;
  delete from public.seating_elements where id = p_element;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'seating_element', p_element, 'seating.element_removed',
            jsonb_build_object('kind', v_e.kind), v_wedding.revision);
end;
$$;

-- ---------------------------------------------------------------- grants
revoke all on function public.move_seating_table(uuid, uuid, integer, integer),
  public.add_seating_element(uuid, uuid, text, text, integer, integer, integer, integer),
  public.update_seating_element(uuid, uuid, integer, text, integer, integer, integer, integer),
  public.move_seating_element(uuid, uuid, integer, integer),
  public.remove_seating_element(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.move_seating_table(uuid, uuid, integer, integer),
  public.add_seating_element(uuid, uuid, text, text, integer, integer, integer, integer),
  public.update_seating_element(uuid, uuid, integer, text, integer, integer, integer, integer),
  public.move_seating_element(uuid, uuid, integer, integer),
  public.remove_seating_element(uuid, uuid, integer) to authenticated;
