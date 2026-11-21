-- R1-03 candidates / manual discovery: venue and vendor candidates the couple
-- enters themselves, with a source link, optional price and (venues) capacity.
--
-- Rules (docs/19-DISCOVERY-AND-COMMERCE.md, docs/07-DOMAIN-RULES.md):
--  * Everything here is user-entered. `source_type` has exactly one value today and
--    there is no "verified" flag: `source_checked_on` is the date the couple says they
--    last looked at the source, nothing more. A source URL is stored, never fetched.
--  * Unknown stays null. A missing price or capacity is never stored as zero.
--  * Price is integer minor units with the currency recorded when it was entered.
--  * Saving a candidate is not booking, not an inquiry and not availability.
-- All writes go through these RPCs; clients only get SELECT through RLS.
-- vendors.manage = owner and partner (mirrors src/domain/permissions).

create table public.candidates (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  kind text not null check (kind in ('venue', 'vendor')),
  category text not null check (category in (
    'venue', 'photographer', 'videographer', 'caterer', 'florist', 'music', 'planner',
    'bakery', 'attire', 'beauty', 'rentals', 'officiant', 'transportation', 'stationery', 'other'
  )),
  name text not null check (char_length(name) between 1 and 160),
  source_type text not null default 'user_entered' check (source_type in ('user_entered')),
  source_url text check (
    source_url is null or (
      char_length(source_url) <= 2000
      and source_url ~* '^https?://[^\s/?#]+'
      and source_url !~ '\s'
      and source_url !~* '^https?://[^/?#]*@'
    )
  ),
  source_checked_on date check (
    source_checked_on is null or source_checked_on between date '1970-01-01' and date '2200-12-31'
  ),
  location text check (location is null or char_length(location) <= 200),
  pricing_display text check (pricing_display is null or char_length(pricing_display) <= 200),
  price_minor bigint check (price_minor is null or price_minor between 0 and 100000000000),
  price_basis text check (price_basis is null or price_basis in ('total', 'per_guest')),
  price_currency text check (price_currency is null or price_currency ~ '^[A-Z]{3}$'),
  notes text check (notes is null or char_length(notes) <= 2000),
  is_favorite boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  archived_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (wedding_id, id),
  unique (wedding_id, id, kind),
  -- A venue is exactly the "venue" category.
  check ((kind = 'venue') = (category = 'venue')),
  -- A price always says what it is a price of, and in which currency.
  check ((price_minor is null) = (price_basis is null) and (price_minor is null) = (price_currency is null))
);
create index candidates_wedding_idx on public.candidates (wedding_id, created_at desc)
  where archived_at is null;
create trigger candidates_touch before update on public.candidates
  for each row execute function app_private.touch_updated_at();

-- Capacity belongs to a venue only. Composite FK pins the parent to kind = 'venue'
-- within the same wedding, so a vendor can never get capacity and a venue row can never
-- point at another tenant's candidate.
create table public.venues (
  candidate_id uuid primary key,
  wedding_id uuid not null,
  kind text not null default 'venue' check (kind = 'venue'),
  seated_capacity integer check (seated_capacity is null or seated_capacity between 1 and 100000),
  ceremony_capacity integer check (ceremony_capacity is null or ceremony_capacity between 1 and 100000),
  version integer not null default 1, -- bumped by the shared touch trigger
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (wedding_id, candidate_id, kind)
    references public.candidates (wedding_id, id, kind) on delete cascade
);
create trigger venues_touch before update on public.venues
  for each row execute function app_private.touch_updated_at();

alter table public.candidates enable row level security;
alter table public.venues enable row level security;
revoke all on public.candidates, public.venues from anon, authenticated;
grant select on public.candidates, public.venues to authenticated;
create policy candidates_select_member on public.candidates
  for select to authenticated using (app_private.is_member(wedding_id));
create policy venues_select_member on public.venues
  for select to authenticated using (app_private.is_member(wedding_id));

create function app_private.can_manage_vendors(p_wedding uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select app_private.has_role(p_wedding, array['owner', 'partner']::public.membership_role[]);
$$;
revoke all on function app_private.can_manage_vendors(uuid) from public, anon;
grant execute on function app_private.can_manage_vendors(uuid) to authenticated;

-- Same shape as lock_wedding_for_plan: share-lock the wedding row, then authorize.
-- Non-members and unknown ids get the same error.
create function app_private.lock_wedding_for_vendors(p_wedding uuid)
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
  if not found or not app_private.can_manage_vendors(p_wedding) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return v_wedding;
end;
$$;
revoke all on function app_private.lock_wedding_for_vendors(uuid) from public, anon;
grant execute on function app_private.lock_wedding_for_vendors(uuid) to authenticated;

-- Shared field validation so create and update cannot drift apart.
create function app_private.assert_candidate_fields(
  p_kind text, p_category text, p_name text, p_price_minor bigint, p_price_basis text,
  p_seated integer, p_ceremony integer
) returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_kind not in ('venue', 'vendor') or char_length(btrim(coalesce(p_name, ''))) not between 1 and 160 then
    raise exception 'invalid candidate' using errcode = '22023';
  end if;
  if (p_kind = 'venue') <> (p_category = 'venue') then
    raise exception 'invalid category' using errcode = '22023';
  end if;
  if (p_price_minor is null) <> (p_price_basis is null) then
    raise exception 'price needs a basis' using errcode = '22023';
  end if;
  if p_kind <> 'venue' and (p_seated is not null or p_ceremony is not null) then
    raise exception 'capacity applies to venues only' using errcode = '22023';
  end if;
end;
$$;
revoke all on function app_private.assert_candidate_fields(text, text, text, bigint, text, integer, integer)
  from public, anon;
grant execute on function app_private.assert_candidate_fields(text, text, text, bigint, text, integer, integer)
  to authenticated;

-- ---------------------------------------------------------------- create
create function public.create_candidate(
  p_wedding uuid,
  p_kind text,
  p_category text,
  p_name text,
  p_source_url text default null,
  p_source_checked_on date default null,
  p_location text default null,
  p_pricing_display text default null,
  p_price_minor bigint default null,
  p_price_basis text default null,
  p_notes text default null,
  p_seated_capacity integer default null,
  p_ceremony_capacity integer default null,
  p_idempotency_key text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_name text := btrim(coalesce(p_name, ''));
  v_hash text;
  v_existing public.idempotency_keys%rowtype;
  v_id uuid;
begin
  v_wedding := app_private.lock_wedding_for_vendors(p_wedding);
  perform app_private.assert_candidate_fields(p_kind, p_category, v_name, p_price_minor, p_price_basis,
                                              p_seated_capacity, p_ceremony_capacity);

  if p_idempotency_key is not null then
    v_hash := md5(concat_ws('|', p_kind, p_category, v_name, coalesce(p_source_url, ''),
      coalesce(p_source_checked_on::text, ''), coalesce(p_location, ''), coalesce(p_pricing_display, ''),
      coalesce(p_price_minor::text, ''), coalesce(p_price_basis, ''), coalesce(p_notes, ''),
      coalesce(p_seated_capacity::text, ''), coalesce(p_ceremony_capacity::text, '')));
    insert into public.idempotency_keys (actor_scope, operation, key, request_hash)
      values (v_user::text, 'create_candidate:' || p_wedding::text, p_idempotency_key, v_hash)
      on conflict do nothing;
    select * into v_existing from public.idempotency_keys
      where actor_scope = v_user::text and operation = 'create_candidate:' || p_wedding::text
        and key = p_idempotency_key
      for update;
    if v_existing.request_hash <> v_hash then
      raise exception 'idempotency key reused with different request' using errcode = '23505';
    end if;
    if v_existing.response_ref is not null then
      return v_existing.response_ref;
    end if;
  end if;

  insert into public.candidates (wedding_id, kind, category, name, source_url, source_checked_on, location,
                                 pricing_display, price_minor, price_basis, price_currency, notes, created_by)
    values (p_wedding, p_kind, p_category, v_name, nullif(btrim(coalesce(p_source_url, '')), ''),
            p_source_checked_on, nullif(btrim(coalesce(p_location, '')), ''),
            nullif(btrim(coalesce(p_pricing_display, '')), ''), p_price_minor, p_price_basis,
            case when p_price_minor is null then null else v_wedding.base_currency end,
            nullif(btrim(coalesce(p_notes, '')), ''), v_user)
    returning id into v_id;

  if p_kind = 'venue' then
    insert into public.venues (candidate_id, wedding_id, seated_capacity, ceremony_capacity)
      values (v_id, p_wedding, p_seated_capacity, p_ceremony_capacity);
  end if;

  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'candidate', v_id, 'candidate.created',
            jsonb_build_object('kind', p_kind, 'category', p_category), v_wedding.revision);

  if p_idempotency_key is not null then
    update public.idempotency_keys set response_ref = v_id
      where actor_scope = v_user::text and operation = 'create_candidate:' || p_wedding::text
        and key = p_idempotency_key;
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------- update
-- Full replacement of the editable fields, guarded by the caller's version. The kind
-- never changes. An unchanged price keeps the currency it was entered in.
create function public.update_candidate(
  p_wedding uuid,
  p_candidate uuid,
  p_expected_version integer,
  p_category text,
  p_name text,
  p_source_url text default null,
  p_source_checked_on date default null,
  p_location text default null,
  p_pricing_display text default null,
  p_price_minor bigint default null,
  p_price_basis text default null,
  p_notes text default null,
  p_seated_capacity integer default null,
  p_ceremony_capacity integer default null
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.candidates%rowtype;
  v_old_venue public.venues%rowtype;
  v_name text := btrim(coalesce(p_name, ''));
  v_url text := nullif(btrim(coalesce(p_source_url, '')), '');
  v_loc text := nullif(btrim(coalesce(p_location, '')), '');
  v_display text := nullif(btrim(coalesce(p_pricing_display, '')), '');
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_currency text;
  v_changed text[] := '{}';
  v_version integer;
begin
  v_wedding := app_private.lock_wedding_for_vendors(p_wedding);
  select * into v_old from public.candidates where id = p_candidate and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_old.archived_at is not null or v_old.version <> p_expected_version then
    raise exception 'candidate changed, reload' using errcode = '55000';
  end if;
  perform app_private.assert_candidate_fields(v_old.kind, p_category, v_name, p_price_minor, p_price_basis,
                                              p_seated_capacity, p_ceremony_capacity);
  select * into v_old_venue from public.venues where candidate_id = p_candidate;

  v_currency := case
    when p_price_minor is null then null
    when p_price_minor is not distinct from v_old.price_minor then v_old.price_currency
    else v_wedding.base_currency end;

  if v_name is distinct from v_old.name then v_changed := array_append(v_changed, 'name'); end if;
  if p_category is distinct from v_old.category then v_changed := array_append(v_changed, 'category'); end if;
  if v_url is distinct from v_old.source_url or p_source_checked_on is distinct from v_old.source_checked_on
    then v_changed := array_append(v_changed, 'source'); end if;
  if v_loc is distinct from v_old.location then v_changed := array_append(v_changed, 'location'); end if;
  if v_display is distinct from v_old.pricing_display or p_price_minor is distinct from v_old.price_minor
     or p_price_basis is distinct from v_old.price_basis
    then v_changed := array_append(v_changed, 'price'); end if;
  if v_notes is distinct from v_old.notes then v_changed := array_append(v_changed, 'notes'); end if;
  if v_old.kind = 'venue' and (p_seated_capacity is distinct from v_old_venue.seated_capacity
     or p_ceremony_capacity is distinct from v_old_venue.ceremony_capacity)
    then v_changed := array_append(v_changed, 'capacity'); end if;
  if coalesce(array_length(v_changed, 1), 0) = 0 then
    return v_old.version;
  end if;

  update public.candidates set category = p_category, name = v_name, source_url = v_url,
      source_checked_on = p_source_checked_on, location = v_loc, pricing_display = v_display,
      price_minor = p_price_minor, price_basis = p_price_basis, price_currency = v_currency,
      notes = v_notes, version = version + 1
    where id = p_candidate
    returning version into v_version;
  if v_old.kind = 'venue' then
    update public.venues set seated_capacity = p_seated_capacity, ceremony_capacity = p_ceremony_capacity
      where candidate_id = p_candidate;
  end if;

  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'candidate', p_candidate, 'candidate.updated',
            jsonb_build_object('changed', to_jsonb(v_changed)), v_wedding.revision);
  return v_version;
end;
$$;

-- ---------------------------------------------------------------- favorite
-- Set semantics, so a retry or a double tap is a successful no-op. Favorites are
-- shared by the whole workspace (a shortlist), not per person.
create function public.set_candidate_favorite(p_wedding uuid, p_candidate uuid, p_favorite boolean)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.candidates%rowtype;
  v_version integer;
begin
  v_wedding := app_private.lock_wedding_for_vendors(p_wedding);
  if p_favorite is null then
    raise exception 'invalid favorite' using errcode = '22023';
  end if;
  select * into v_old from public.candidates where id = p_candidate and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_old.archived_at is not null then
    raise exception 'candidate changed, reload' using errcode = '55000';
  end if;
  if v_old.is_favorite = p_favorite then
    return v_old.version;
  end if;
  update public.candidates set is_favorite = p_favorite, version = version + 1
    where id = p_candidate returning version into v_version;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'candidate', p_candidate,
            case when p_favorite then 'candidate.favorited' else 'candidate.unfavorited' end,
            '{}'::jsonb, v_wedding.revision);
  return v_version;
end;
$$;

-- ---------------------------------------------------------------- archive
-- Soft delete: later comparisons and proposals will reference candidates.
create function public.archive_candidate(p_wedding uuid, p_candidate uuid, p_expected_version integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.candidates%rowtype;
begin
  v_wedding := app_private.lock_wedding_for_vendors(p_wedding);
  select * into v_old from public.candidates where id = p_candidate and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_old.archived_at is not null then
    return;
  end if;
  if v_old.version <> p_expected_version then
    raise exception 'candidate changed, reload' using errcode = '55000';
  end if;
  update public.candidates set archived_at = now(), version = version + 1 where id = p_candidate;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'candidate', p_candidate, 'candidate.archived', '{}'::jsonb, v_wedding.revision);
end;
$$;

revoke all on function public.create_candidate(uuid, text, text, text, text, date, text, text, bigint, text, text, integer, integer, text)
  from public, anon;
revoke all on function public.update_candidate(uuid, uuid, integer, text, text, text, date, text, text, bigint, text, text, integer, integer)
  from public, anon;
revoke all on function public.set_candidate_favorite(uuid, uuid, boolean) from public, anon;
revoke all on function public.archive_candidate(uuid, uuid, integer) from public, anon;
grant execute on function public.create_candidate(uuid, text, text, text, text, date, text, text, bigint, text, text, integer, integer, text)
  to authenticated;
grant execute on function public.update_candidate(uuid, uuid, integer, text, text, text, date, text, text, bigint, text, text, integer, integer)
  to authenticated;
grant execute on function public.set_candidate_favorite(uuid, uuid, boolean) to authenticated;
grant execute on function public.archive_candidate(uuid, uuid, integer) to authenticated;
