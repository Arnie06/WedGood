-- R0-03 core tenancy: profiles, weddings, memberships, audit, idempotency,
-- atomic wedding creation, RLS, private storage defaults.
-- Mutations go through SECURITY DEFINER functions; authenticated users get
-- SELECT only (RLS-scoped) on tenant tables. See docs/06-DATA-MODEL.md, 10-SECURITY.md.

create schema if not exists app_private;
revoke all on schema app_private from public, anon;
grant usage on schema app_private to authenticated;

-- ---------------------------------------------------------------- enums
create type public.membership_role as enum ('owner', 'partner', 'editor', 'viewer');
create type public.membership_status as enum ('active', 'removed');

-- ---------------------------------------------------------------- helpers
create function app_private.touch_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.version := old.version + 1;
  return new;
end;
$$;

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (display_name is null or char_length(display_name) between 1 and 120),
  locale text not null default 'en' check (char_length(locale) between 2 and 35),
  timezone text,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_touch before update on public.profiles
  for each row execute function app_private.touch_updated_at();

create function app_private.handle_new_user() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id) values (new.id) on conflict do nothing;
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function app_private.handle_new_user();

-- ---------------------------------------------------------------- weddings
create table public.weddings (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 160),
  date date,
  timezone text not null,
  base_currency char(3) not null check (base_currency ~ '^[A-Z]{3}$'),
  target_budget_minor bigint check (target_budget_minor is null or target_budget_minor >= 0),
  target_guest_count integer check (target_guest_count is null or target_guest_count >= 0),
  location text check (location is null or char_length(location) <= 200),
  preferences jsonb not null default '{}'::jsonb check (jsonb_typeof(preferences) = 'object'),
  revision integer not null default 1,
  version integer not null default 1,
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger weddings_touch before update on public.weddings
  for each row execute function app_private.touch_updated_at();

-- ---------------------------------------------------------------- memberships
create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.membership_role not null,
  status public.membership_status not null default 'active',
  permissions jsonb not null default '{}'::jsonb check (jsonb_typeof(permissions) = 'object'),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (wedding_id, user_id),
  unique (wedding_id, id)
);
create index memberships_user_idx on public.memberships (user_id) where status = 'active';
create trigger memberships_touch before update on public.memberships
  for each row execute function app_private.touch_updated_at();

-- ---------------------------------------------------------------- audit (append only)
create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  actor_id uuid references auth.users (id) on delete set null,
  entity_type text not null,
  entity_id uuid not null,
  action text not null,
  safe_changes jsonb not null default '{}'::jsonb,
  revision integer not null,
  request_id uuid,
  occurred_at timestamptz not null default now()
);
create index audit_events_wedding_idx on public.audit_events (wedding_id, occurred_at desc, id);

create function app_private.audit_append_only() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Cascading erasure of a whole wedding is the only permitted deletion.
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'audit_events is append-only' using errcode = '42501';
end;
$$;
create trigger audit_events_no_update before update or delete on public.audit_events
  for each row execute function app_private.audit_append_only();

-- ---------------------------------------------------------------- idempotency
create table public.idempotency_keys (
  actor_scope text not null,
  operation text not null,
  key text not null check (char_length(key) between 8 and 128),
  request_hash text not null,
  response_ref uuid,
  expires_at timestamptz not null default now() + interval '7 days',
  created_at timestamptz not null default now(),
  primary key (actor_scope, operation, key)
);

-- ---------------------------------------------------------------- authorization helpers
-- SECURITY DEFINER so RLS policies on memberships can call them without recursion.
create function app_private.is_member(p_wedding uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.wedding_id = p_wedding and m.user_id = (select auth.uid()) and m.status = 'active'
  );
$$;

create function app_private.has_role(p_wedding uuid, p_roles public.membership_role[]) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.wedding_id = p_wedding and m.user_id = (select auth.uid())
      and m.status = 'active' and m.role = any (p_roles)
  );
$$;

revoke all on function app_private.is_member(uuid) from public, anon;
revoke all on function app_private.has_role(uuid, public.membership_role[]) from public, anon;
grant execute on function app_private.is_member(uuid) to authenticated;
grant execute on function app_private.has_role(uuid, public.membership_role[]) to authenticated;

-- ---------------------------------------------------------------- RLS
alter table public.profiles enable row level security;
alter table public.weddings enable row level security;
alter table public.memberships enable row level security;
alter table public.audit_events enable row level security;
alter table public.idempotency_keys enable row level security;

-- Least privilege: no anon access; authenticated reads only; writes via RPC.
revoke all on public.profiles, public.weddings, public.memberships,
  public.audit_events, public.idempotency_keys from anon, authenticated;
grant select on public.weddings, public.memberships, public.audit_events to authenticated;
grant select, update (display_name, locale, timezone) on public.profiles to authenticated;

create policy profiles_select_own on public.profiles
  for select to authenticated using (user_id = (select auth.uid()));
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy weddings_select_member on public.weddings
  for select to authenticated using (app_private.is_member(id));

create policy memberships_select_member on public.memberships
  for select to authenticated using (app_private.is_member(wedding_id));

create policy audit_select_owner_partner on public.audit_events
  for select to authenticated
  using (app_private.has_role(wedding_id, array['owner', 'partner']::public.membership_role[]));

-- idempotency_keys: RLS on, no policies, no grants => only definer functions touch it.

-- ---------------------------------------------------------------- create_wedding RPC
create function public.create_wedding(
  p_name text,
  p_timezone text,
  p_base_currency text,
  p_date date default null,
  p_idempotency_key text default null
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

  if p_idempotency_key is not null then
    v_hash := md5(concat_ws('|', btrim(p_name), p_timezone, p_base_currency, coalesce(p_date::text, '')));
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

  insert into public.weddings (name, date, timezone, base_currency, created_by)
    values (btrim(p_name), p_date, p_timezone, p_base_currency, v_user)
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
revoke all on function public.create_wedding(text, text, text, date, text) from public, anon;
grant execute on function public.create_wedding(text, text, text, date, text) to authenticated;

-- ---------------------------------------------------------------- private storage default
-- Bucket is private; object keys are '<wedding_id>/...'. Read requires active membership.
-- No insert/update/delete policies yet: uploads arrive with R1-08 (validated, quarantined).
insert into storage.buckets (id, name, public, file_size_limit)
  values ('wedding-documents', 'wedding-documents', false, 26214400)
  on conflict (id) do update set public = false;

create policy wedding_documents_select_member on storage.objects
  for select to authenticated
  using (
    bucket_id = 'wedding-documents'
    and case
      when (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then app_private.is_member(((storage.foldername(name))[1])::uuid)
      else false
    end
  );
