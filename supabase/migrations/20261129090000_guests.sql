-- R1-09 guests, households and CSV import commit (docs/06, docs/07 "Invitations and guests").
--
-- Rules:
--  * Guests are identified by id. Names and emails are never unique; matching is a UI warning.
--  * Owner and partner only for now (docs/10 matrix: editors need an explicit grant, viewers none).
--    RLS limits every read to them and clients have no write grants; all writes are RPCs.
--  * Private details (dietary, accessibility, notes) live in their own table so a later grant can
--    expose guest names without exposing them. Audit events carry field names and counts only,
--    never names, emails or private text.
--  * Imports are atomic and idempotent: one RPC call inserts every row or none, and replaying the
--    same idempotency key returns the same import. Every limit is re-checked here, so a client
--    that bypasses the app cannot store invalid rows.

create function app_private.can_manage_guests(p_wedding uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select app_private.has_role(p_wedding, array['owner', 'partner']::public.membership_role[]);
$$;
revoke all on function app_private.can_manage_guests(uuid) from public, anon;
grant execute on function app_private.can_manage_guests(uuid) to authenticated;

create function app_private.lock_wedding_for_guests(p_wedding uuid)
returns public.weddings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wedding public.weddings%rowtype;
begin
  if (select auth.uid()) is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select * into v_wedding from public.weddings where id = p_wedding for share;
  if not found or not app_private.can_manage_guests(p_wedding) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  -- Serializes guest writes per wedding so the guest cap and household reuse hold under races.
  perform pg_advisory_xact_lock(hashtextextended('guests:' || p_wedding::text, 0));
  return v_wedding;
end;
$$;
revoke all on function app_private.lock_wedding_for_guests(uuid) from public, anon;
grant execute on function app_private.lock_wedding_for_guests(uuid) to authenticated;

create function app_private.tags_ok(p_tags text[]) returns boolean
language sql immutable
set search_path = ''
as $$
  select p_tags is not null
    and coalesce(cardinality(p_tags), 0) <= 10
    and not exists (select 1 from unnest(p_tags) t where t is null or char_length(t) not between 1 and 30);
$$;

-- ---------------------------------------------------------------- tables
create table public.households (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120 and name = btrim(name)),
  address text check (address is null or char_length(address) between 1 and 300),
  notes text check (notes is null or char_length(notes) between 1 and 500),
  archived_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (wedding_id, id)
);
-- One active household per name (ignoring case): imports and forms reuse it instead of splitting a family.
create unique index households_active_name_uq on public.households (wedding_id, lower(name))
  where archived_at is null;
create trigger households_touch before update on public.households
  for each row execute function app_private.touch_updated_at();

create table public.guest_imports (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null,
  guest_count integer not null check (guest_count between 1 and 500),
  new_household_count integer not null check (new_household_count >= 0),
  created_at timestamptz not null default now(),
  unique (wedding_id, id)
);

create table public.guests (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  household_id uuid,
  import_id uuid,
  full_name text not null check (char_length(full_name) between 1 and 120 and full_name = btrim(full_name)),
  email text check (email is null or (char_length(email) <= 254 and email = lower(btrim(email)))),
  phone text check (phone is null or char_length(phone) between 7 and 30),
  age_group text check (age_group is null or age_group in ('adult', 'child')),
  tags text[] not null default '{}' check (app_private.tags_ok(tags)),
  archived_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (wedding_id, id),
  foreign key (wedding_id, household_id) references public.households (wedding_id, id),
  foreign key (wedding_id, import_id) references public.guest_imports (wedding_id, id)
);
create index guests_wedding_idx on public.guests (wedding_id, archived_at, lower(full_name));
create index guests_household_idx on public.guests (household_id);
create index guests_email_idx on public.guests (wedding_id, email) where email is not null;
create trigger guests_touch before update on public.guests
  for each row execute function app_private.touch_updated_at();

create table public.guest_private_details (
  guest_id uuid primary key,
  wedding_id uuid not null,
  dietary text check (dietary is null or char_length(dietary) between 1 and 500),
  accessibility text check (accessibility is null or char_length(accessibility) between 1 and 500),
  notes text check (notes is null or char_length(notes) between 1 and 500),
  updated_at timestamptz not null default now(),
  foreign key (wedding_id, guest_id) references public.guests (wedding_id, id) on delete cascade,
  check (num_nonnulls(dietary, accessibility, notes) >= 1)
);

alter table public.households enable row level security;
alter table public.guest_imports enable row level security;
alter table public.guests enable row level security;
alter table public.guest_private_details enable row level security;
revoke all on public.households, public.guest_imports, public.guests, public.guest_private_details
  from anon, authenticated;
grant select on public.households, public.guest_imports, public.guests, public.guest_private_details
  to authenticated;
create policy households_select_managers on public.households
  for select to authenticated using (app_private.can_manage_guests(wedding_id));
create policy guest_imports_select_managers on public.guest_imports
  for select to authenticated using (app_private.can_manage_guests(wedding_id));
create policy guests_select_managers on public.guests
  for select to authenticated using (app_private.can_manage_guests(wedding_id));
create policy guest_private_select_managers on public.guest_private_details
  for select to authenticated using (app_private.can_manage_guests(wedding_id));

-- ---------------------------------------------------------------- validation and helpers
create function app_private.jtext(j jsonb, k text) returns text
language sql immutable
set search_path = ''
as $$ select nullif(btrim(j ->> k), '') $$;

-- True when a guest payload is storable. Optional keys may be absent or JSON null.
create function app_private.guest_row_ok(j jsonb) returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  k text;
  v text;
  tag jsonb;
begin
  if j is null or jsonb_typeof(j) <> 'object' then return false; end if;
  foreach k in array array['name', 'email', 'phone', 'household', 'age_group', 'dietary', 'accessibility', 'notes'] loop
    if coalesce(jsonb_typeof(j -> k), 'null') not in ('null', 'string') then return false; end if;
  end loop;
  if char_length(coalesce(app_private.jtext(j, 'name'), '')) not between 1 and 120 then return false; end if;
  v := app_private.jtext(j, 'email');
  if v is not null and (char_length(v) > 254
      or v !~ '^[^\s@<>()\\,;:"]+@[^\s@<>()\\,;:"]+\.[^\s@<>()\\,;:"]{2,}$') then
    return false;
  end if;
  v := app_private.jtext(j, 'phone');
  if v is not null and (v !~ '^\+?[0-9 ().-]{7,30}$'
      or char_length(regexp_replace(v, '\D', '', 'g')) not between 7 and 15) then
    return false;
  end if;
  if char_length(coalesce(app_private.jtext(j, 'household'), '')) > 120 then return false; end if;
  v := app_private.jtext(j, 'age_group');
  if v is not null and v not in ('adult', 'child') then return false; end if;
  foreach k in array array['dietary', 'accessibility', 'notes'] loop
    if char_length(coalesce(app_private.jtext(j, k), '')) > 500 then return false; end if;
  end loop;
  if coalesce(jsonb_typeof(j -> 'tags'), 'null') not in ('null', 'array') then return false; end if;
  if jsonb_typeof(j -> 'tags') = 'array' then
    if jsonb_array_length(j -> 'tags') > 10 then return false; end if;
    for tag in select * from jsonb_array_elements(j -> 'tags') loop
      if jsonb_typeof(tag) <> 'string' or char_length(btrim(tag #>> '{}')) not between 1 and 30 then
        return false;
      end if;
    end loop;
  end if;
  return true;
end;
$$;

create function app_private.json_tags(j jsonb) returns text[]
language sql immutable
set search_path = ''
as $$
  select coalesce(
    (select array_agg(t order by first_ord)
       from (select (array_agg(btrim(e #>> '{}') order by ord))[1] as t, min(ord) as first_ord
               from jsonb_array_elements(case when jsonb_typeof(j -> 'tags') = 'array' then j -> 'tags' else '[]'::jsonb end)
                    with ordinality as x(e, ord)
              group by lower(btrim(e #>> '{}'))) s),
    '{}'::text[]);
$$;

-- Finds the active household with this name (ignoring case) or creates it. Callers hold the
-- wedding guest lock, and the unique index backs it up.
create function app_private.resolve_household(p_wedding uuid, p_name text, out o_id uuid, out o_created boolean)
language plpgsql
security definer
set search_path = ''
as $$
begin
  o_created := false;
  select id into o_id from public.households
    where wedding_id = p_wedding and archived_at is null and lower(name) = lower(p_name);
  if o_id is null then
    insert into public.households (wedding_id, name) values (p_wedding, p_name) returning id into o_id;
    o_created := true;
  end if;
end;
$$;
revoke all on function app_private.resolve_household(uuid, text) from public, anon, authenticated;

create function app_private.insert_guest(p_wedding uuid, p_j jsonb, p_household uuid, p_import uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := gen_random_uuid();
  v_diet text := app_private.jtext(p_j, 'dietary');
  v_access text := app_private.jtext(p_j, 'accessibility');
  v_notes text := app_private.jtext(p_j, 'notes');
begin
  insert into public.guests (id, wedding_id, household_id, import_id, full_name, email, phone, age_group, tags)
    values (v_id, p_wedding, p_household, p_import, app_private.jtext(p_j, 'name'),
            lower(app_private.jtext(p_j, 'email')), app_private.jtext(p_j, 'phone'),
            app_private.jtext(p_j, 'age_group'), app_private.json_tags(p_j));
  if num_nonnulls(v_diet, v_access, v_notes) > 0 then
    insert into public.guest_private_details (guest_id, wedding_id, dietary, accessibility, notes)
      values (v_id, p_wedding, v_diet, v_access, v_notes);
  end if;
  return v_id;
end;
$$;
revoke all on function app_private.insert_guest(uuid, jsonb, uuid, uuid) from public, anon, authenticated;

create function app_private.assert_guest_cap(p_wedding uuid, p_adding integer) returns void
language plpgsql
set search_path = ''
as $$
begin
  if (select count(*) from public.guests where wedding_id = p_wedding and archived_at is null) + p_adding > 2000 then
    raise exception 'too many guests' using errcode = '54000';
  end if;
end;
$$;
revoke all on function app_private.assert_guest_cap(uuid, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------- RPCs
-- p_household set: use that household (must be active, same wedding). Otherwise a non-empty
-- "household" name in the payload finds or creates one. Otherwise the guest has no household.
create function public.create_guest(
  p_wedding uuid,
  p_guest jsonb,
  p_household uuid default null,
  p_idempotency_key text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_hash text;
  v_prior uuid;
  v_household uuid := p_household;
  v_hname text;
  v_id uuid;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  if not app_private.guest_row_ok(p_guest) then
    raise exception 'invalid guest' using errcode = '22023';
  end if;
  if p_idempotency_key is not null then
    v_hash := md5(p_guest::text || '|' || coalesce(p_household::text, ''));
    v_prior := app_private.idem_claim(v_user, 'create_guest:' || p_wedding::text, p_idempotency_key, v_hash);
    if v_prior is not null then
      return v_prior;
    end if;
  end if;
  perform app_private.assert_guest_cap(p_wedding, 1);
  if v_household is not null then
    if not exists (select 1 from public.households
                   where id = v_household and wedding_id = p_wedding and archived_at is null) then
      raise exception 'invalid household' using errcode = '22023';
    end if;
  else
    v_hname := app_private.jtext(p_guest, 'household');
    if v_hname is not null then
      v_household := (app_private.resolve_household(p_wedding, v_hname)).o_id;
    end if;
  end if;
  v_id := app_private.insert_guest(p_wedding, p_guest, v_household, null);
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'guest', v_id, 'guest.created', '{}'::jsonb, v_wedding.revision);
  if p_idempotency_key is not null then
    perform app_private.idem_done(v_user, 'create_guest:' || p_wedding::text, p_idempotency_key, v_id);
  end if;
  return v_id;
end;
$$;

create function public.update_guest(
  p_wedding uuid,
  p_guest_id uuid,
  p_expected_version integer,
  p_guest jsonb,
  p_household uuid default null
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.guests%rowtype;
  v_old_d public.guest_private_details%rowtype;
  v_household uuid := p_household;
  v_hname text;
  v_name text := app_private.jtext(p_guest, 'name');
  v_email text := lower(app_private.jtext(p_guest, 'email'));
  v_phone text := app_private.jtext(p_guest, 'phone');
  v_age text := app_private.jtext(p_guest, 'age_group');
  v_tags text[];
  v_diet text := app_private.jtext(p_guest, 'dietary');
  v_access text := app_private.jtext(p_guest, 'accessibility');
  v_notes text := app_private.jtext(p_guest, 'notes');
  v_details_changed boolean;
  v_fields text[];
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  if not app_private.guest_row_ok(p_guest) then
    raise exception 'invalid guest' using errcode = '22023';
  end if;
  select * into v_old from public.guests where id = p_guest_id and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_old.version <> p_expected_version or v_old.archived_at is not null then
    raise exception 'guest changed, reload' using errcode = '55000';
  end if;
  v_tags := app_private.json_tags(p_guest);
  if v_household is not null then
    if not exists (select 1 from public.households
                   where id = v_household and wedding_id = p_wedding and archived_at is null) then
      raise exception 'invalid household' using errcode = '22023';
    end if;
  else
    v_hname := app_private.jtext(p_guest, 'household');
    if v_hname is not null then
      v_household := (app_private.resolve_household(p_wedding, v_hname)).o_id;
    end if;
  end if;
  select * into v_old_d from public.guest_private_details where guest_id = p_guest_id;
  v_details_changed :=
    v_old_d.dietary is distinct from v_diet
    or v_old_d.accessibility is distinct from v_access
    or v_old_d.notes is distinct from v_notes;
  v_fields := array_remove(array[
    case when v_old.full_name <> v_name then 'name' end,
    case when v_old.email is distinct from v_email then 'email' end,
    case when v_old.phone is distinct from v_phone then 'phone' end,
    case when v_old.age_group is distinct from v_age then 'age_group' end,
    case when v_old.tags is distinct from v_tags then 'tags' end,
    case when v_old.household_id is distinct from v_household then 'household' end,
    case when v_details_changed then 'private_details' end], null);
  if cardinality(v_fields) = 0 then
    return;
  end if;
  update public.guests
    set full_name = v_name, email = v_email, phone = v_phone, age_group = v_age, tags = v_tags,
        household_id = v_household
    where id = p_guest_id;
  if v_details_changed then
    if num_nonnulls(v_diet, v_access, v_notes) = 0 then
      delete from public.guest_private_details where guest_id = p_guest_id;
    else
      insert into public.guest_private_details (guest_id, wedding_id, dietary, accessibility, notes)
        values (p_guest_id, p_wedding, v_diet, v_access, v_notes)
        on conflict (guest_id) do update
          set dietary = excluded.dietary, accessibility = excluded.accessibility,
              notes = excluded.notes, updated_at = now();
    end if;
  end if;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'guest', p_guest_id, 'guest.updated',
            jsonb_build_object('fields', to_jsonb(v_fields)), v_wedding.revision);
end;
$$;

-- Archiving keeps history (and later, response records); restoring is the same call reversed.
create function public.set_guest_archived(
  p_wedding uuid,
  p_guest_id uuid,
  p_expected_version integer,
  p_archived boolean
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.guests%rowtype;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  select * into v_old from public.guests where id = p_guest_id and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_old.version <> p_expected_version then
    raise exception 'guest changed, reload' using errcode = '55000';
  end if;
  if (v_old.archived_at is not null) = p_archived then
    return;
  end if;
  if not p_archived then
    perform app_private.assert_guest_cap(p_wedding, 1);
  end if;
  update public.guests set archived_at = case when p_archived then now() end where id = p_guest_id;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'guest', p_guest_id,
            case when p_archived then 'guest.archived' else 'guest.restored' end,
            '{}'::jsonb, v_wedding.revision);
end;
$$;

create function public.update_household(
  p_wedding uuid,
  p_household_id uuid,
  p_expected_version integer,
  p_name text,
  p_address text,
  p_notes text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.households%rowtype;
  v_name text := btrim(coalesce(p_name, ''));
  v_address text := nullif(btrim(coalesce(p_address, '')), '');
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  if char_length(v_name) not between 1 and 120
     or char_length(coalesce(v_address, '')) > 300 or char_length(coalesce(v_notes, '')) > 500 then
    raise exception 'invalid household' using errcode = '22023';
  end if;
  select * into v_old from public.households
    where id = p_household_id and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_old.version <> p_expected_version or v_old.archived_at is not null then
    raise exception 'household changed, reload' using errcode = '55000';
  end if;
  if v_old.name = v_name and v_old.address is not distinct from v_address
     and v_old.notes is not distinct from v_notes then
    return;
  end if;
  if lower(v_old.name) <> lower(v_name) and exists (
       select 1 from public.households
        where wedding_id = p_wedding and archived_at is null and lower(name) = lower(v_name)) then
    raise exception 'household name in use' using errcode = '23505';
  end if;
  update public.households set name = v_name, address = v_address, notes = v_notes where id = p_household_id;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'household', p_household_id, 'household.updated',
            jsonb_build_object('fields', to_jsonb(array_remove(array[
              case when v_old.name <> v_name then 'name' end,
              case when v_old.address is distinct from v_address then 'address' end,
              case when v_old.notes is distinct from v_notes then 'notes' end], null))),
            v_wedding.revision);
end;
$$;

-- Commits an already-validated import atomically. A key is mandatory: replaying it returns the
-- original import (and adds nothing), reusing it for different rows is refused.
create function public.commit_guest_import(
  p_wedding uuid,
  p_rows jsonb,
  p_idempotency_key text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_hash text;
  v_prior uuid;
  v_import uuid := gen_random_uuid();
  v_row jsonb;
  v_household uuid;
  v_hname text;
  v_res record;
  v_new_households integer := 0;
  v_n integer;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 128
     or p_rows is null or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) not between 1 and 500 then
    raise exception 'invalid import' using errcode = '22023';
  end if;
  for v_row in select * from jsonb_array_elements(p_rows) loop
    if not app_private.guest_row_ok(v_row) then
      raise exception 'invalid import row' using errcode = '22023';
    end if;
  end loop;
  v_hash := md5(p_rows::text);
  v_prior := app_private.idem_claim(v_user, 'commit_guest_import:' || p_wedding::text, p_idempotency_key, v_hash);
  if v_prior is not null then
    return v_prior;
  end if;
  v_n := jsonb_array_length(p_rows);
  perform app_private.assert_guest_cap(p_wedding, v_n);
  -- The import row comes first so guests can reference it; its household count is set after.
  insert into public.guest_imports (id, wedding_id, created_by, guest_count, new_household_count)
    values (v_import, p_wedding, v_user, v_n, 0);
  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_household := null;
    v_hname := app_private.jtext(v_row, 'household');
    if v_hname is not null then
      select * into v_res from app_private.resolve_household(p_wedding, v_hname);
      v_household := v_res.o_id;
      if v_res.o_created then v_new_households := v_new_households + 1; end if;
    end if;
    perform app_private.insert_guest(p_wedding, v_row, v_household, v_import);
  end loop;
  update public.guest_imports set new_household_count = v_new_households where id = v_import;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'guest_import', v_import, 'guest.imported',
            jsonb_build_object('guests', v_n, 'new_households', v_new_households), v_wedding.revision);
  perform app_private.idem_done(v_user, 'commit_guest_import:' || p_wedding::text, p_idempotency_key, v_import);
  return v_import;
end;
$$;

revoke all on function public.create_guest(uuid, jsonb, uuid, text),
  public.update_guest(uuid, uuid, integer, jsonb, uuid),
  public.set_guest_archived(uuid, uuid, integer, boolean),
  public.update_household(uuid, uuid, integer, text, text, text),
  public.commit_guest_import(uuid, jsonb, text) from public, anon;
grant execute on function public.create_guest(uuid, jsonb, uuid, text),
  public.update_guest(uuid, uuid, integer, jsonb, uuid),
  public.set_guest_archived(uuid, uuid, integer, boolean),
  public.update_household(uuid, uuid, integer, text, text, text),
  public.commit_guest_import(uuid, jsonb, text) to authenticated;
