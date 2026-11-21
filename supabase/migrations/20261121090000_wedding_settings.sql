-- R1-01 onboarding + event settings.
-- * create_wedding gains optional budget / guest target / location (replaces the 5-arg version).
-- * update_wedding_settings: versioned, audited edit of event settings by owners and partners.
-- All values stay nullable: unknown is never stored as zero.

drop function public.create_wedding(text, text, text, date, text);

create function public.create_wedding(
  p_name text,
  p_timezone text,
  p_base_currency text,
  p_date date default null,
  p_idempotency_key text default null,
  p_target_budget_minor bigint default null,
  p_target_guest_count integer default null,
  p_location text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding uuid;
  v_hash text;
  v_existing public.idempotency_keys%rowtype;
  v_location text := nullif(btrim(coalesce(p_location, '')), '');
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if p_name is null or char_length(btrim(p_name)) = 0 then
    raise exception 'name is required' using errcode = '22023';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = p_timezone) then
    raise exception 'unknown IANA time zone' using errcode = '22023';
  end if;
  if p_base_currency is null or p_base_currency !~ '^[A-Z]{3}$' then
    raise exception 'base currency must be a 3-letter ISO code' using errcode = '22023';
  end if;
  if p_target_budget_minor is not null and p_target_budget_minor < 0 then
    raise exception 'budget target cannot be negative' using errcode = '22023';
  end if;
  if p_target_guest_count is not null and p_target_guest_count < 0 then
    raise exception 'guest target cannot be negative' using errcode = '22023';
  end if;
  if v_location is not null and char_length(v_location) > 200 then
    raise exception 'location is too long' using errcode = '22023';
  end if;

  if p_idempotency_key is not null then
    v_hash := md5(concat_ws('|', btrim(p_name), p_timezone, p_base_currency,
      coalesce(p_date::text, ''), coalesce(p_target_budget_minor::text, ''),
      coalesce(p_target_guest_count::text, ''), coalesce(v_location, '')));
    insert into public.idempotency_keys (actor_scope, operation, key, request_hash)
      values (v_user::text, 'create_wedding', p_idempotency_key, v_hash)
      on conflict do nothing;
    select * into v_existing from public.idempotency_keys
      where actor_scope = v_user::text and operation = 'create_wedding' and key = p_idempotency_key
      for update;
    if v_existing.request_hash <> v_hash then
      raise exception 'idempotency key reused with different request' using errcode = '23505';
    end if;
    if v_existing.response_ref is not null then
      return v_existing.response_ref;
    end if;
  end if;

  insert into public.weddings (name, date, timezone, base_currency, target_budget_minor,
                               target_guest_count, location, created_by)
    values (btrim(p_name), p_date, p_timezone, p_base_currency, p_target_budget_minor,
            p_target_guest_count, v_location, v_user)
    returning id into v_wedding;

  insert into public.memberships (wedding_id, user_id, role)
    values (v_wedding, v_user, 'owner');

  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (v_wedding, v_user, 'wedding', v_wedding, 'wedding.created',
            jsonb_build_object('timezone', p_timezone, 'base_currency', p_base_currency), 1);

  if p_idempotency_key is not null then
    update public.idempotency_keys set response_ref = v_wedding
      where actor_scope = v_user::text and operation = 'create_wedding' and key = p_idempotency_key;
  end if;

  return v_wedding;
end;
$$;
revoke all on function public.create_wedding(text, text, text, date, text, bigint, integer, text) from public, anon;
grant execute on function public.create_wedding(text, text, text, date, text, bigint, integer, text) to authenticated;

-- Full replacement of the editable settings (the form submits every field),
-- guarded by the caller's last-seen version. Omitted optional arguments mean
-- "unknown" (null), not "leave unchanged". Returns the new version.
create function public.update_wedding_settings(
  p_wedding uuid,
  p_expected_version integer,
  p_name text,
  p_timezone text,
  p_base_currency text,
  p_date date default null,
  p_target_budget_minor bigint default null,
  p_target_guest_count integer default null,
  p_location text default null
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_old public.weddings%rowtype;
  v_location text := nullif(btrim(coalesce(p_location, '')), '');
  v_name text := btrim(coalesce(p_name, ''));
  v_changed text[] := '{}';
  v_new_version integer;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  -- Lock first so concurrent edits serialize; then authorize. Non-members and
  -- unknown ids get the same error (no existence leak).
  select * into v_old from public.weddings where id = p_wedding for update;
  if not found or not exists (
    select 1 from public.memberships m
    where m.wedding_id = p_wedding and m.user_id = v_user and m.status = 'active'
      and m.role in ('owner', 'partner')
  ) then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  if char_length(v_name) = 0 or char_length(v_name) > 160 then
    raise exception 'invalid name' using errcode = '22023';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = p_timezone) then
    raise exception 'unknown IANA time zone' using errcode = '22023';
  end if;
  if p_base_currency is null or p_base_currency !~ '^[A-Z]{3}$' then
    raise exception 'base currency must be a 3-letter ISO code' using errcode = '22023';
  end if;
  if p_target_budget_minor is not null and p_target_budget_minor < 0 then
    raise exception 'budget target cannot be negative' using errcode = '22023';
  end if;
  if p_target_guest_count is not null and p_target_guest_count < 0 then
    raise exception 'guest target cannot be negative' using errcode = '22023';
  end if;
  if v_location is not null and char_length(v_location) > 200 then
    raise exception 'location is too long' using errcode = '22023';
  end if;

  if v_old.version <> p_expected_version then
    raise exception 'wedding changed, reload' using errcode = '55000';
  end if;

  if v_name is distinct from v_old.name then v_changed := array_append(v_changed, 'name'); end if;
  if p_date is distinct from v_old.date then v_changed := array_append(v_changed, 'date'); end if;
  if p_timezone is distinct from v_old.timezone then v_changed := array_append(v_changed, 'timezone'); end if;
  if p_base_currency is distinct from v_old.base_currency then v_changed := array_append(v_changed, 'baseCurrency'); end if;
  if p_target_budget_minor is distinct from v_old.target_budget_minor then v_changed := array_append(v_changed, 'targetBudgetMinor'); end if;
  if p_target_guest_count is distinct from v_old.target_guest_count then v_changed := array_append(v_changed, 'targetGuestCount'); end if;
  if v_location is distinct from v_old.location then v_changed := array_append(v_changed, 'location'); end if;

  -- A no-op save must not bump versions or write audit noise.
  if coalesce(array_length(v_changed, 1), 0) = 0 then
    return v_old.version;
  end if;

  update public.weddings set
      name = v_name, date = p_date, timezone = p_timezone, base_currency = p_base_currency,
      target_budget_minor = p_target_budget_minor, target_guest_count = p_target_guest_count,
      location = v_location, version = version + 1, revision = revision + 1
    where id = p_wedding
    returning version into v_new_version;

  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'wedding', p_wedding, 'wedding.settings_updated',
            jsonb_build_object('changed', to_jsonb(v_changed)), v_old.revision + 1);

  return v_new_version;
end;
$$;
revoke all on function public.update_wedding_settings(uuid, integer, text, text, text, date, bigint, integer, text) from public, anon;
grant execute on function public.update_wedding_settings(uuid, integer, text, text, text, date, bigint, integer, text) to authenticated;
