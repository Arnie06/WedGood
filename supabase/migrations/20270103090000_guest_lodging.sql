-- UX-17 second slice: lodging (hotels, room blocks, who is staying where). ADR-031 UX-17 lodging
-- addendum. Release switch GUEST_LODGING=on in the app (off by default); the database does not
-- depend on it.
--
--   lodging_hotels   a hotel the couple recommends. Archived, never deleted, so a guest's answer that
--                    names it keeps its meaning. Optional link to a vendor (candidate).
--   lodging_blocks   a room block at a hotel: dates, rooms per night, nightly rate, attrition terms,
--                    book-by date, booking link/code, the hotel's latest pickup report, and the
--                    budget category its possible charge is filed under.
--   lodging_stays    one row per guest: the planner's choice and the guest's own answer, kept in
--                    separate columns so neither overwrites the other (review fix 1 rule). The guest
--                    columns are written only by the RSVP path (next migration).
--
-- Rules:
--   * Reads: people who manage guests (can_manage_guests), like shuttles; the lists show who is
--     attending. Clients have SELECT only; every write is an RPC under the guests advisory lock.
--   * Money: integer minor units. Attrition exposure is computed in the app from raw numbers and is
--     shown BESIDE the forecast, never in it (owner decision 2026-11-23). Unknown inputs stay null.
--   * lodging_possible_costs gives any member the raw block numbers for the Budget page (budget reads
--     are member-wide). It carries no guest data.
--   * The guest website shows hotels only when the draft says so and only hotels marked for guests,
--     through the published snapshot. Rooms held, pickup and attrition are never published; the
--     nightly rate only where the couple ticked "Show the rate to guests".
--   * Audit rows carry field names and counts, never free text.

-- ---------------------------------------------------------------- tables
create table public.lodging_hotels (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  address text check (address is null or char_length(address) between 1 and 300),
  phone text check (phone is null or char_length(phone) between 1 and 40),
  website_url text check (website_url is null or (char_length(website_url) <= 2048
    and website_url ~ '^https://[^[:space:][:cntrl:]@]+$')),
  guest_note text check (guest_note is null or char_length(guest_note) between 1 and 500),
  show_to_guests boolean not null default false,
  show_rate boolean not null default false,
  candidate_id uuid,
  archived_at timestamptz,
  version integer not null default 1,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (wedding_id, id),
  foreign key (wedding_id, candidate_id) references public.candidates (wedding_id, id)
);
create index lodging_hotels_wedding_idx on public.lodging_hotels (wedding_id, created_at);
create trigger lodging_hotels_touch before update on public.lodging_hotels
  for each row execute function app_private.touch_updated_at();

create table public.lodging_blocks (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null,
  hotel_id uuid not null,
  label text check (label is null or char_length(label) between 1 and 60),
  check_in date not null check (check_in between date '2000-01-01' and date '2100-12-31'),
  check_out date not null check (check_out between date '2000-01-01' and date '2100-12-31'),
  rooms_per_night integer not null check (rooms_per_night between 1 and 500),
  nightly_rate_minor bigint check (nightly_rate_minor is null or nightly_rate_minor between 1 and 10000000),
  -- Share of held room-nights the hotel lets go unbooked without charge, in basis points.
  attrition_allowed_bp integer check (attrition_allowed_bp is null or attrition_allowed_bp between 0 and 10000),
  -- Charge per unbooked room-night below the required pickup; null means the nightly rate.
  attrition_charge_minor bigint
    check (attrition_charge_minor is null or attrition_charge_minor between 1 and 10000000),
  cutoff_date date check (cutoff_date is null or cutoff_date between date '2000-01-01' and date '2100-12-31'),
  booking_url text check (booking_url is null or (char_length(booking_url) <= 2048
    and booking_url ~ '^https://[^[:space:][:cntrl:]@]+$')),
  booking_code text check (booking_code is null or char_length(booking_code) between 1 and 60),
  -- The hotel's latest pickup report: room-nights booked in the block, and the day it was reported.
  picked_up_room_nights integer check (picked_up_room_nights is null or picked_up_room_nights >= 0),
  picked_up_as_of date,
  budget_category_id uuid,
  version integer not null default 1,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (check_out > check_in and check_out - check_in <= 30),
  check ((picked_up_room_nights is null) = (picked_up_as_of is null)),
  check (picked_up_room_nights is null
         or picked_up_room_nights <= rooms_per_night * (check_out - check_in)),
  unique (wedding_id, id),
  foreign key (wedding_id, hotel_id) references public.lodging_hotels (wedding_id, id) on delete cascade,
  foreign key (wedding_id, budget_category_id) references public.budget_categories (wedding_id, id)
);
create index lodging_blocks_hotel_idx on public.lodging_blocks (hotel_id, check_in);
create trigger lodging_blocks_touch before update on public.lodging_blocks
  for each row execute function app_private.touch_updated_at();

create table public.lodging_stays (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null,
  guest_id uuid not null,
  planner_kind text check (planner_kind in ('hotel', 'elsewhere', 'not_staying')),
  planner_hotel_id uuid,
  guest_kind text check (guest_kind in ('hotel', 'elsewhere', 'not_staying')),
  guest_hotel_id uuid,
  guest_answered_at timestamptz,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  unique (guest_id),
  check ((planner_kind = 'hotel') = (planner_hotel_id is not null)),
  check ((guest_kind = 'hotel') = (guest_hotel_id is not null)),
  check ((guest_kind is null) = (guest_answered_at is null)),
  check (planner_kind is not null or guest_kind is not null),
  foreign key (wedding_id, guest_id) references public.guests (wedding_id, id) on delete cascade,
  foreign key (wedding_id, planner_hotel_id) references public.lodging_hotels (wedding_id, id),
  foreign key (wedding_id, guest_hotel_id) references public.lodging_hotels (wedding_id, id)
);
create index lodging_stays_wedding_idx on public.lodging_stays (wedding_id);
create trigger lodging_stays_touch before update on public.lodging_stays
  for each row execute function app_private.touch_updated_at();

alter table public.lodging_hotels enable row level security;
alter table public.lodging_blocks enable row level security;
alter table public.lodging_stays enable row level security;
revoke all on public.lodging_hotels, public.lodging_blocks, public.lodging_stays from anon, authenticated;
grant select on public.lodging_hotels, public.lodging_blocks, public.lodging_stays to authenticated;
create policy lodging_hotels_select_managers on public.lodging_hotels
  for select to authenticated using (app_private.can_manage_guests(wedding_id));
create policy lodging_blocks_select_managers on public.lodging_blocks
  for select to authenticated using (app_private.can_manage_guests(wedding_id));
create policy lodging_stays_select_managers on public.lodging_stays
  for select to authenticated using (app_private.can_manage_guests(wedding_id));

-- ---------------------------------------------------------------- input helpers (raise 22023)
-- Optional text: absent, null or blank is null; otherwise a string within the limit with no
-- control characters except newline and tab. Spaces are trimmed.
create function app_private.lodging_text(j jsonb, k text, p_max integer) returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v text;
begin
  if not (j ? k) or jsonb_typeof(j -> k) = 'null' then
    return null;
  end if;
  if jsonb_typeof(j -> k) <> 'string' then
    raise exception 'invalid lodging' using errcode = '22023';
  end if;
  v := btrim(j ->> k);
  if v = '' then
    return null;
  end if;
  if char_length(v) > p_max or v ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]' then
    raise exception 'invalid lodging' using errcode = '22023';
  end if;
  return v;
end;
$$;

create function app_private.lodging_url(j jsonb, k text) returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v text := app_private.lodging_text(j, k, 2048);
begin
  if v is not null and v !~ '^https://[^[:space:][:cntrl:]@]+$' then
    raise exception 'invalid lodging' using errcode = '22023';
  end if;
  return v;
end;
$$;

-- Optional whole number within bounds; absent or null is null.
create function app_private.lodging_int(j jsonb, k text, p_min bigint, p_max bigint) returns bigint
language plpgsql immutable
set search_path = ''
as $$
begin
  if not (j ? k) or jsonb_typeof(j -> k) = 'null' then
    return null;
  end if;
  if jsonb_typeof(j -> k) <> 'number' or (j ->> k) !~ '^\d{1,12}$'
     or (j ->> k)::bigint not between p_min and p_max then
    raise exception 'invalid lodging' using errcode = '22023';
  end if;
  return (j ->> k)::bigint;
end;
$$;

create function app_private.lodging_date(j jsonb, k text) returns date
language plpgsql immutable
set search_path = ''
as $$
begin
  if not (j ? k) or jsonb_typeof(j -> k) = 'null' then
    return null;
  end if;
  if jsonb_typeof(j -> k) <> 'string' or not app_private.site_valid_date(j ->> k)
     or (j ->> k)::date not between date '2000-01-01' and date '2100-12-31' then
    raise exception 'invalid lodging' using errcode = '22023';
  end if;
  return (j ->> k)::date;
end;
$$;

create function app_private.lodging_bool(j jsonb, k text) returns boolean
language plpgsql immutable
set search_path = ''
as $$
begin
  if not (j ? k) or jsonb_typeof(j -> k) = 'null' then
    return false;
  end if;
  if jsonb_typeof(j -> k) <> 'boolean' then
    raise exception 'invalid lodging' using errcode = '22023';
  end if;
  return (j ->> k)::boolean;
end;
$$;

-- An optional id that must belong to this wedding in the given table.
create function app_private.lodging_ref(j jsonb, k text) returns uuid
language plpgsql immutable
set search_path = ''
as $$
begin
  if not (j ? k) or jsonb_typeof(j -> k) = 'null' then
    return null;
  end if;
  if jsonb_typeof(j -> k) <> 'string' or not app_private.is_uuid(j ->> k) then
    raise exception 'invalid lodging' using errcode = '22023';
  end if;
  return (j ->> k)::uuid;
end;
$$;

revoke all on function app_private.lodging_text(jsonb, text, integer), app_private.lodging_url(jsonb, text),
  app_private.lodging_int(jsonb, text, bigint, bigint), app_private.lodging_date(jsonb, text),
  app_private.lodging_bool(jsonb, text), app_private.lodging_ref(jsonb, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------- hotels
-- p_hotel: { name, address?, phone?, websiteUrl?, guestNote?, showToGuests?, showRate?, candidateId? }
create function app_private.lodging_hotel_input(p_wedding uuid, j jsonb)
returns table (o_name text, o_address text, o_phone text, o_url text, o_note text,
               o_show boolean, o_rate boolean, o_candidate uuid)
language plpgsql stable
set search_path = ''
as $$
begin
  if jsonb_typeof(j) is distinct from 'object'
     or not app_private.site_keys_ok(j, array['name', 'address', 'phone', 'websiteUrl', 'guestNote',
                                              'showToGuests', 'showRate', 'candidateId']) then
    raise exception 'invalid lodging' using errcode = '22023';
  end if;
  o_name := regexp_replace(coalesce(app_private.lodging_text(j, 'name', 120), ''), '\s+', ' ', 'g');
  if o_name = '' then
    raise exception 'invalid lodging' using errcode = '22023';
  end if;
  o_address := app_private.lodging_text(j, 'address', 300);
  o_phone := app_private.lodging_text(j, 'phone', 40);
  o_url := app_private.lodging_url(j, 'websiteUrl');
  o_note := app_private.lodging_text(j, 'guestNote', 500);
  o_show := app_private.lodging_bool(j, 'showToGuests');
  o_rate := app_private.lodging_bool(j, 'showRate');
  o_candidate := app_private.lodging_ref(j, 'candidateId');
  if o_candidate is not null and not exists (
    select 1 from public.candidates where id = o_candidate and wedding_id = p_wedding) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return next;
end;
$$;
revoke all on function app_private.lodging_hotel_input(uuid, jsonb) from public, anon, authenticated;

create function public.add_lodging_hotel(p_wedding uuid, p_hotel jsonb) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v record;
  v_id uuid;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  select * into v from app_private.lodging_hotel_input(p_wedding, p_hotel);
  if (select count(*) from public.lodging_hotels where wedding_id = p_wedding) >= 30 then
    raise exception 'too many hotels' using errcode = '54000';
  end if;
  insert into public.lodging_hotels (wedding_id, name, address, phone, website_url, guest_note,
                                     show_to_guests, show_rate, candidate_id, created_by)
    values (p_wedding, v.o_name, v.o_address, v.o_phone, v.o_url, v.o_note, v.o_show, v.o_rate,
            v.o_candidate, v_user)
    returning id into v_id;
  update public.weddings set revision = revision + 1 where id = p_wedding;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'lodging_hotel', v_id, 'lodging.hotel_added',
            jsonb_build_object('showToGuests', v.o_show), v_wedding.revision + 1);
  return v_id;
end;
$$;

create function public.update_lodging_hotel(
  p_wedding uuid, p_hotel_id uuid, p_expected_version integer, p_hotel jsonb
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.lodging_hotels%rowtype;
  v record;
  v_changed text[];
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  select * into v_old from public.lodging_hotels where id = p_hotel_id and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  select * into v from app_private.lodging_hotel_input(p_wedding, p_hotel);
  if v_old.version <> p_expected_version then
    raise exception 'version conflict' using errcode = '55000';
  end if;
  v_changed := array_remove(array[
    case when v_old.name is distinct from v.o_name then 'name' end,
    case when v_old.address is distinct from v.o_address then 'address' end,
    case when v_old.phone is distinct from v.o_phone then 'phone' end,
    case when v_old.website_url is distinct from v.o_url then 'websiteUrl' end,
    case when v_old.guest_note is distinct from v.o_note then 'guestNote' end,
    case when v_old.show_to_guests is distinct from v.o_show then 'showToGuests' end,
    case when v_old.show_rate is distinct from v.o_rate then 'showRate' end,
    case when v_old.candidate_id is distinct from v.o_candidate then 'candidateId' end], null);
  if cardinality(v_changed) = 0 then
    return v_old.version;
  end if;
  update public.lodging_hotels
     set name = v.o_name, address = v.o_address, phone = v.o_phone, website_url = v.o_url,
         guest_note = v.o_note, show_to_guests = v.o_show, show_rate = v.o_rate,
         candidate_id = v.o_candidate, version = version + 1
   where id = p_hotel_id;
  update public.weddings set revision = revision + 1 where id = p_wedding;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'lodging_hotel', p_hotel_id, 'lodging.hotel_updated',
            jsonb_build_object('fields', to_jsonb(v_changed)), v_wedding.revision + 1);
  return v_old.version + 1;
end;
$$;

-- Archiving hides a hotel from guests and from new choices; existing answers keep pointing at it.
create function public.set_lodging_hotel_archived(
  p_wedding uuid, p_hotel_id uuid, p_expected_version integer, p_archived boolean
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.lodging_hotels%rowtype;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  if p_archived is null then
    raise exception 'invalid lodging' using errcode = '22023';
  end if;
  select * into v_old from public.lodging_hotels where id = p_hotel_id and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_old.version <> p_expected_version then
    raise exception 'version conflict' using errcode = '55000';
  end if;
  if (v_old.archived_at is not null) = p_archived then
    return v_old.version;
  end if;
  update public.lodging_hotels
     set archived_at = case when p_archived then now() end, version = version + 1
   where id = p_hotel_id;
  update public.weddings set revision = revision + 1 where id = p_wedding;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'lodging_hotel', p_hotel_id,
            case when p_archived then 'lodging.hotel_archived' else 'lodging.hotel_restored' end,
            '{}'::jsonb, v_wedding.revision + 1);
  return v_old.version + 1;
end;
$$;

-- ---------------------------------------------------------------- blocks
-- p_block: { label?, checkIn, checkOut, roomsPerNight, nightlyRateMinor?, attritionAllowedBp?,
--            attritionChargeMinor?, cutoffDate?, bookingUrl?, bookingCode?, budgetCategoryId? }
create function app_private.lodging_block_input(p_wedding uuid, j jsonb)
returns table (o_label text, o_in date, o_out date, o_rooms integer, o_rate bigint, o_bp integer,
               o_charge bigint, o_cutoff date, o_url text, o_code text, o_category uuid)
language plpgsql stable
set search_path = ''
as $$
begin
  if jsonb_typeof(j) is distinct from 'object'
     or not app_private.site_keys_ok(j, array['label', 'checkIn', 'checkOut', 'roomsPerNight',
          'nightlyRateMinor', 'attritionAllowedBp', 'attritionChargeMinor', 'cutoffDate',
          'bookingUrl', 'bookingCode', 'budgetCategoryId']) then
    raise exception 'invalid lodging' using errcode = '22023';
  end if;
  o_label := app_private.lodging_text(j, 'label', 60);
  o_in := app_private.lodging_date(j, 'checkIn');
  o_out := app_private.lodging_date(j, 'checkOut');
  o_rooms := app_private.lodging_int(j, 'roomsPerNight', 1, 500);
  o_rate := app_private.lodging_int(j, 'nightlyRateMinor', 1, 10000000);
  o_bp := app_private.lodging_int(j, 'attritionAllowedBp', 0, 10000);
  o_charge := app_private.lodging_int(j, 'attritionChargeMinor', 1, 10000000);
  o_cutoff := app_private.lodging_date(j, 'cutoffDate');
  o_url := app_private.lodging_url(j, 'bookingUrl');
  o_code := app_private.lodging_text(j, 'bookingCode', 60);
  o_category := app_private.lodging_ref(j, 'budgetCategoryId');
  if o_in is null or o_out is null or o_rooms is null or o_out <= o_in or o_out - o_in > 30 then
    raise exception 'invalid lodging' using errcode = '22023';
  end if;
  if o_category is not null and not exists (
    select 1 from public.budget_categories
     where id = o_category and wedding_id = p_wedding and archived_at is null) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return next;
end;
$$;
revoke all on function app_private.lodging_block_input(uuid, jsonb) from public, anon, authenticated;

create function public.add_lodging_block(p_wedding uuid, p_hotel_id uuid, p_block jsonb) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v record;
  v_id uuid;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  perform 1 from public.lodging_hotels where id = p_hotel_id and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  select * into v from app_private.lodging_block_input(p_wedding, p_block);
  if (select count(*) from public.lodging_blocks where hotel_id = p_hotel_id) >= 10 then
    raise exception 'too many blocks' using errcode = '54000';
  end if;
  insert into public.lodging_blocks (wedding_id, hotel_id, label, check_in, check_out, rooms_per_night,
                                     nightly_rate_minor, attrition_allowed_bp, attrition_charge_minor,
                                     cutoff_date, booking_url, booking_code, budget_category_id, created_by)
    values (p_wedding, p_hotel_id, v.o_label, v.o_in, v.o_out, v.o_rooms, v.o_rate, v.o_bp, v.o_charge,
            v.o_cutoff, v.o_url, v.o_code, v.o_category, v_user)
    returning id into v_id;
  update public.weddings set revision = revision + 1 where id = p_wedding;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'lodging_block', v_id, 'lodging.block_added',
            jsonb_build_object('rooms', v.o_rooms, 'nights', v.o_out - v.o_in), v_wedding.revision + 1);
  return v_id;
end;
$$;

-- A recorded pickup above the new number of room-nights held is refused (the check constraint).
create function public.update_lodging_block(
  p_wedding uuid, p_block_id uuid, p_expected_version integer, p_block jsonb
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.lodging_blocks%rowtype;
  v record;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  select * into v_old from public.lodging_blocks where id = p_block_id and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  select * into v from app_private.lodging_block_input(p_wedding, p_block);
  if v_old.version <> p_expected_version then
    raise exception 'version conflict' using errcode = '55000';
  end if;
  if v_old.picked_up_room_nights is not null
     and v_old.picked_up_room_nights > v.o_rooms * (v.o_out - v.o_in) then
    raise exception 'pickup above rooms held' using errcode = 'LG409';
  end if;
  update public.lodging_blocks
     set label = v.o_label, check_in = v.o_in, check_out = v.o_out, rooms_per_night = v.o_rooms,
         nightly_rate_minor = v.o_rate, attrition_allowed_bp = v.o_bp, attrition_charge_minor = v.o_charge,
         cutoff_date = v.o_cutoff, booking_url = v.o_url, booking_code = v.o_code,
         budget_category_id = v.o_category, version = version + 1
   where id = p_block_id;
  update public.weddings set revision = revision + 1 where id = p_wedding;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'lodging_block', p_block_id, 'lodging.block_updated',
            jsonb_build_object('rooms', v.o_rooms, 'nights', v.o_out - v.o_in), v_wedding.revision + 1);
  return v_old.version + 1;
end;
$$;

create function public.remove_lodging_block(p_wedding uuid, p_block_id uuid, p_expected_version integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.lodging_blocks%rowtype;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  select * into v_old from public.lodging_blocks where id = p_block_id and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_old.version <> p_expected_version then
    raise exception 'version conflict' using errcode = '55000';
  end if;
  delete from public.lodging_blocks where id = p_block_id;
  update public.weddings set revision = revision + 1 where id = p_wedding;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'lodging_block', p_block_id, 'lodging.block_removed', '{}'::jsonb,
            v_wedding.revision + 1);
end;
$$;

-- The hotel's pickup report. Both null clears it. The report day cannot be in the future (wedding
-- zone) and the number cannot exceed the room-nights held.
create function public.record_lodging_pickup(
  p_wedding uuid, p_block_id uuid, p_expected_version integer, p_room_nights integer default null,
  p_as_of date default null
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.lodging_blocks%rowtype;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  select * into v_old from public.lodging_blocks where id = p_block_id and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if (p_room_nights is null) <> (p_as_of is null)
     or p_room_nights < 0
     or p_as_of < date '2000-01-01'
     or p_as_of > (now() at time zone v_wedding.timezone)::date then
    raise exception 'invalid lodging' using errcode = '22023';
  end if;
  if p_room_nights > v_old.rooms_per_night * (v_old.check_out - v_old.check_in) then
    raise exception 'pickup above rooms held' using errcode = 'LG409';
  end if;
  if v_old.version <> p_expected_version then
    raise exception 'version conflict' using errcode = '55000';
  end if;
  update public.lodging_blocks
     set picked_up_room_nights = p_room_nights, picked_up_as_of = p_as_of, version = version + 1
   where id = p_block_id;
  update public.weddings set revision = revision + 1 where id = p_wedding;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'lodging_block', p_block_id, 'lodging.pickup_recorded',
            jsonb_build_object('cleared', p_room_nights is null), v_wedding.revision + 1);
  return v_old.version + 1;
end;
$$;

-- ---------------------------------------------------------------- who is staying where (planner)
-- Sets the planner's choice for up to 20 guests at once, all or nothing. p_kind null clears it.
-- Never changes what a guest answered.
create function public.set_lodging_stays(
  p_wedding uuid, p_guests uuid[], p_kind text default null, p_hotel_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_guests uuid[];
  v_n integer := 0;
  v_rows integer;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  select coalesce(array_agg(distinct g), '{}') into v_guests from unnest(p_guests) g where g is not null;
  if cardinality(v_guests) = 0
     or (p_kind is null and p_hotel_id is not null)
     or (p_kind is not null and p_kind not in ('hotel', 'elsewhere', 'not_staying'))
     or (p_kind = 'hotel' and p_hotel_id is null)
     or (p_kind in ('elsewhere', 'not_staying') and p_hotel_id is not null) then
    raise exception 'invalid lodging' using errcode = '22023';
  end if;
  if cardinality(v_guests) > 20 then
    raise exception 'too many guests' using errcode = '54000';
  end if;
  if p_hotel_id is not null and not exists (
    select 1 from public.lodging_hotels where id = p_hotel_id and wedding_id = p_wedding and archived_at is null) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if (select count(*) from public.guests
       where wedding_id = p_wedding and id = any (v_guests) and archived_at is null) <> cardinality(v_guests) then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  if p_kind is null then
    update public.lodging_stays set planner_kind = null, planner_hotel_id = null
     where wedding_id = p_wedding and guest_id = any (v_guests) and planner_kind is not null
       and guest_kind is not null;
    get diagnostics v_rows = row_count;
    v_n := v_rows;
    delete from public.lodging_stays
     where wedding_id = p_wedding and guest_id = any (v_guests) and guest_kind is null;
    get diagnostics v_rows = row_count;
    v_n := v_n + v_rows;
  else
    insert into public.lodging_stays (wedding_id, guest_id, planner_kind, planner_hotel_id)
      select p_wedding, g, p_kind, p_hotel_id from unnest(v_guests) g
      on conflict (guest_id) do update
        set planner_kind = excluded.planner_kind, planner_hotel_id = excluded.planner_hotel_id
        where public.lodging_stays.planner_kind is distinct from excluded.planner_kind
           or public.lodging_stays.planner_hotel_id is distinct from excluded.planner_hotel_id;
    get diagnostics v_n = row_count;
  end if;
  if v_n = 0 then
    return 0;
  end if;
  update public.weddings set revision = revision + 1 where id = p_wedding;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'wedding', p_wedding, 'lodging.stays_set',
            jsonb_build_object('guests', v_n, 'cleared', p_kind is null), v_wedding.revision + 1);
  return v_n;
end;
$$;

-- ---------------------------------------------------------------- the Budget page's possible costs
-- Raw block numbers for any member. No guest data, no booking links or codes.
create function public.lodging_possible_costs(p_wedding uuid)
returns table (block_id uuid, hotel_name text, hotel_archived boolean, label text, check_in date,
               check_out date, rooms_per_night integer, nightly_rate_minor bigint,
               attrition_allowed_bp integer, attrition_charge_minor bigint, cutoff_date date,
               picked_up_room_nights integer, picked_up_as_of date, budget_category_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select b.id, h.name, h.archived_at is not null, b.label, b.check_in, b.check_out, b.rooms_per_night,
         b.nightly_rate_minor, b.attrition_allowed_bp, b.attrition_charge_minor, b.cutoff_date,
         b.picked_up_room_nights, b.picked_up_as_of, b.budget_category_id
    from public.lodging_blocks b
    join public.lodging_hotels h on h.id = b.hotel_id and h.wedding_id = b.wedding_id
   where b.wedding_id = p_wedding and app_private.is_member(p_wedding)
   order by b.check_in, h.name, b.id
   limit 200
$$;

-- ---------------------------------------------------------------- the guest website
-- Same as R1-14, plus the optional boolean key "hotels".
create or replace function app_private.site_draft_ok(j jsonb, p_wedding uuid) returns boolean
language plpgsql stable
set search_path = ''
as $$
declare
  e jsonb;
  ids text[] := '{}';
begin
  if not app_private.site_keys_ok(j, array['template', 'title', 'tagline', 'date', 'location',
       'story', 'travel', 'faq', 'registry', 'events', 'hotels']) then
    return false;
  end if;
  if j ? 'hotels' and jsonb_typeof(j -> 'hotels') <> 'boolean' then
    return false;
  end if;
  if j ->> 'template' is null or j ->> 'template' not in ('classic', 'garden', 'modern') then
    return false;
  end if;
  if not (j ? 'title') or not app_private.site_text(j, 'title', 120)
     or not app_private.site_text(j, 'tagline', 200)
     or not app_private.site_text(j, 'location', 200)
     or not app_private.site_text(j, 'story', 3000)
     or not app_private.site_text(j, 'travel', 3000) then
    return false;
  end if;
  if j ? 'date' and not (jsonb_typeof(j -> 'date') = 'string' and app_private.site_valid_date(j ->> 'date')) then
    return false;
  end if;

  if j ? 'faq' then
    if jsonb_typeof(j -> 'faq') <> 'array' or jsonb_array_length(j -> 'faq') > 10 then return false; end if;
    for e in select * from jsonb_array_elements(j -> 'faq') loop
      if not app_private.site_keys_ok(e, array['q', 'a'])
         or not (e ? 'q' and e ? 'a')
         or not app_private.site_text(e, 'q', 200) or not app_private.site_text(e, 'a', 1000) then
        return false;
      end if;
    end loop;
  end if;

  if j ? 'registry' then
    if jsonb_typeof(j -> 'registry') <> 'array' or jsonb_array_length(j -> 'registry') > 6 then return false; end if;
    for e in select * from jsonb_array_elements(j -> 'registry') loop
      if not app_private.site_keys_ok(e, array['label', 'url'])
         or not (e ? 'label' and e ? 'url')
         or not app_private.site_text(e, 'label', 80)
         or jsonb_typeof(e -> 'url') <> 'string'
         or char_length(e ->> 'url') > 2048
         or (e ->> 'url') !~ '^https://[^[:space:][:cntrl:]@]+$' then
        return false;
      end if;
    end loop;
  end if;

  if j ? 'events' then
    if jsonb_typeof(j -> 'events') <> 'array' or jsonb_array_length(j -> 'events') > 12 then return false; end if;
    for e in select * from jsonb_array_elements(j -> 'events') loop
      if not app_private.site_keys_ok(e, array['eventId', 'visibility', 'when', 'where', 'notes'])
         or not (e ? 'eventId' and e ? 'visibility')
         or jsonb_typeof(e -> 'eventId') <> 'string'
         or not app_private.is_uuid(e ->> 'eventId')
         or (e ->> 'visibility') not in ('public', 'invited')
         or not app_private.site_text(e, 'when', 120)
         or not app_private.site_text(e, 'where', 200)
         or not app_private.site_text(e, 'notes', 500) then
        return false;
      end if;
      if (e ->> 'eventId') = any (ids) then return false; end if;
      ids := ids || (e ->> 'eventId');
      if not exists (select 1 from public.events ev
                      where ev.id = (e ->> 'eventId')::uuid and ev.wedding_id = p_wedding) then
        return false;
      end if;
    end loop;
  end if;
  return true;
end;
$$;

-- Same as R1-14, plus "hotels": copied at publish time from hotels marked for guests (not archived),
-- with explicit fields only and no ids. The rate only where the couple chose to show it.
create or replace function app_private.site_snapshot(p_wedding uuid, p_draft jsonb) returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'template', p_draft ->> 'template',
    'title', p_draft ->> 'title',
    'tagline', p_draft ->> 'tagline',
    'date', p_draft ->> 'date',
    'location', p_draft ->> 'location',
    'story', p_draft ->> 'story',
    'travel', p_draft ->> 'travel',
    'faq', coalesce((select jsonb_agg(jsonb_build_object('q', f ->> 'q', 'a', f ->> 'a'))
                       from jsonb_array_elements(coalesce(p_draft -> 'faq', '[]'::jsonb)) f), '[]'::jsonb),
    'registry', coalesce((select jsonb_agg(jsonb_build_object('label', r ->> 'label', 'url', r ->> 'url'))
                            from jsonb_array_elements(coalesce(p_draft -> 'registry', '[]'::jsonb)) r), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                  'eventId', ev.id,
                  'name', ev.name,
                  'kind', ev.kind,
                  'localDate', ev.local_date,
                  'visibility', d ->> 'visibility',
                  'when', d ->> 'when',
                  'where', d ->> 'where',
                  'notes', d ->> 'notes'))
                  order by ev.local_date nulls last, ev.created_at, ev.id)
                from jsonb_array_elements(coalesce(p_draft -> 'events', '[]'::jsonb)) d
                join public.events ev on ev.id = (d ->> 'eventId')::uuid and ev.wedding_id = p_wedding),
                '[]'::jsonb),
    'hotels', case when (p_draft ->> 'hotels')::boolean is true then coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
               'name', h.name,
               'address', h.address,
               'phone', h.phone,
               'websiteUrl', h.website_url,
               'note', h.guest_note,
               'blocks', coalesce((
                 select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                          'label', b.label,
                          'checkIn', b.check_in,
                          'checkOut', b.check_out,
                          'bookBy', b.cutoff_date,
                          'bookingUrl', b.booking_url,
                          'bookingCode', b.booking_code,
                          'nightlyRateMinor', case when h.show_rate then b.nightly_rate_minor end,
                          'currency', case when h.show_rate and b.nightly_rate_minor is not null then
                            (select w.base_currency from public.weddings w where w.id = p_wedding) end))
                          order by b.check_in, b.id)
                   from public.lodging_blocks b where b.hotel_id = h.id), '[]'::jsonb)))
               order by h.created_at, h.id)
        from public.lodging_hotels h
       where h.wedding_id = p_wedding and h.show_to_guests and h.archived_at is null), '[]'::jsonb)
    end));
$$;

-- ---------------------------------------------------------------- grants
revoke all on function
  public.add_lodging_hotel(uuid, jsonb),
  public.update_lodging_hotel(uuid, uuid, integer, jsonb),
  public.set_lodging_hotel_archived(uuid, uuid, integer, boolean),
  public.add_lodging_block(uuid, uuid, jsonb),
  public.update_lodging_block(uuid, uuid, integer, jsonb),
  public.remove_lodging_block(uuid, uuid, integer),
  public.record_lodging_pickup(uuid, uuid, integer, integer, date),
  public.set_lodging_stays(uuid, uuid[], text, uuid),
  public.lodging_possible_costs(uuid)
  from public, anon;
grant execute on function
  public.add_lodging_hotel(uuid, jsonb),
  public.update_lodging_hotel(uuid, uuid, integer, jsonb),
  public.set_lodging_hotel_archived(uuid, uuid, integer, boolean),
  public.add_lodging_block(uuid, uuid, jsonb),
  public.update_lodging_block(uuid, uuid, integer, jsonb),
  public.remove_lodging_block(uuid, uuid, integer),
  public.record_lodging_pickup(uuid, uuid, integer, integer, date),
  public.set_lodging_stays(uuid, uuid[], text, uuid),
  public.lodging_possible_costs(uuid)
  to authenticated;
