-- R1-06 budget model: categories with optional targets, planned cost items with cost modes,
-- and a reserve percentage.
--
-- Rules (docs/07-DOMAIN-RULES.md):
--  * Money is integer minor units in the wedding's base currency. A null amount is UNKNOWN, never
--    zero. A null category target or wedding target is unset, and an explicit zero is a real value.
--  * Category targets are guidance: their sum may exceed the wedding target (a warning in the
--    summary, not a database gate).
--  * Items are estimates, not obligations. Commitments, installments and payments arrive in R1-07
--    and will cover items through commitment_allocations; nothing here records money moving.
--  * All writes go through these RPCs (owner and partner, the budget.manage capability); clients
--    only get SELECT through RLS. Writes are versioned, audited by field name only, and creates
--    accept an idempotency key.

-- ---------------------------------------------------------------- tables
create table public.budget_categories (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  allocation_minor bigint check (allocation_minor is null or allocation_minor between 0 and 10000000000),
  sort_order integer not null default 1000,
  archived_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (wedding_id, id)
);
create unique index budget_categories_name_idx
  on public.budget_categories (wedding_id, lower(name)) where archived_at is null;
create trigger budget_categories_touch before update on public.budget_categories
  for each row execute function app_private.touch_updated_at();

create table public.budget_items (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null,
  category_id uuid not null,
  name text not null check (char_length(name) between 1 and 160),
  cost_mode text not null default 'fixed' check (cost_mode in ('fixed', 'per_guest', 'quantity')),
  -- The whole amount (fixed) or the price per guest / per unit. Null = not known yet.
  amount_minor bigint check (amount_minor is null or amount_minor between 0 and 100000000),
  quantity integer check (quantity is null or quantity between 1 and 100000),
  min_qty integer check (min_qty is null or min_qty between 1 and 100000),
  notes text check (notes is null or char_length(notes) <= 1000),
  archived_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (wedding_id, id),
  foreign key (wedding_id, category_id) references public.budget_categories (wedding_id, id) on delete cascade,
  check (quantity is null or cost_mode = 'quantity'),
  check (min_qty is null or cost_mode = 'per_guest')
);
create index budget_items_category_idx on public.budget_items (wedding_id, category_id) where archived_at is null;
create trigger budget_items_touch before update on public.budget_items
  for each row execute function app_private.touch_updated_at();

-- One row per wedding, created on first save. reserve_bp is a percentage of the known subtotal in
-- basis points (1000 = 10%); null = no reserve planned. A plan, not a payment or obligation.
create table public.budget_settings (
  wedding_id uuid primary key references public.weddings (id) on delete cascade,
  reserve_bp integer check (reserve_bp is null or reserve_bp between 0 and 10000),
  version integer not null default 1,
  updated_at timestamptz not null default now()
);
create trigger budget_settings_touch before update on public.budget_settings
  for each row execute function app_private.touch_updated_at();

alter table public.budget_categories enable row level security;
alter table public.budget_items enable row level security;
alter table public.budget_settings enable row level security;
revoke all on public.budget_categories, public.budget_items, public.budget_settings from anon, authenticated;
grant select on public.budget_categories, public.budget_items, public.budget_settings to authenticated;
create policy budget_categories_select_member on public.budget_categories
  for select to authenticated using (app_private.is_member(wedding_id));
create policy budget_items_select_member on public.budget_items
  for select to authenticated using (app_private.is_member(wedding_id));
create policy budget_settings_select_member on public.budget_settings
  for select to authenticated using (app_private.is_member(wedding_id));

-- ---------------------------------------------------------------- guards
create function app_private.can_manage_budget(p_wedding uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select app_private.has_role(p_wedding, array['owner', 'partner']::public.membership_role[]);
$$;
revoke all on function app_private.can_manage_budget(uuid) from public, anon;
grant execute on function app_private.can_manage_budget(uuid) to authenticated;

create function app_private.lock_wedding_for_budget(p_wedding uuid)
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
  if not found or not app_private.can_manage_budget(p_wedding) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return v_wedding;
end;
$$;
revoke all on function app_private.lock_wedding_for_budget(uuid) from public, anon;
grant execute on function app_private.lock_wedding_for_budget(uuid) to authenticated;

-- Amounts are stored without a currency, so the base currency cannot change under existing
-- budget figures. Changing it would silently reinterpret every amount. (Money is never converted
-- implicitly.) Refused with 55006; archived rows count too, since they are history.
create function app_private.guard_currency_change() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.base_currency is distinct from old.base_currency and (
    exists (select 1 from public.budget_categories where wedding_id = old.id and allocation_minor is not null)
    or exists (select 1 from public.budget_items where wedding_id = old.id and amount_minor is not null)
  ) then
    raise exception 'currency cannot change while budget amounts exist' using errcode = '55006';
  end if;
  return new;
end;
$$;
create trigger weddings_currency_guard before update of base_currency on public.weddings
  for each row execute function app_private.guard_currency_change();

-- ---------------------------------------------------------------- categories
create function public.create_budget_category(
  p_wedding uuid,
  p_name text,
  p_allocation_minor bigint default null,
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
  v_prior uuid;
  v_id uuid;
begin
  v_wedding := app_private.lock_wedding_for_budget(p_wedding);
  if char_length(v_name) not between 1 and 80
     or (p_allocation_minor is not null and p_allocation_minor not between 0 and 10000000000) then
    raise exception 'invalid category' using errcode = '22023';
  end if;
  if p_idempotency_key is not null then
    v_hash := md5(concat_ws('|', v_name, coalesce(p_allocation_minor::text, '')));
    v_prior := app_private.idem_claim(v_user, 'create_budget_category:' || p_wedding::text, p_idempotency_key, v_hash);
    if v_prior is not null then
      return v_prior;
    end if;
  end if;
  if (select count(*) from public.budget_categories where wedding_id = p_wedding and archived_at is null) >= 40 then
    raise exception 'too many categories' using errcode = '54000';
  end if;
  if exists (select 1 from public.budget_categories
             where wedding_id = p_wedding and archived_at is null and lower(name) = lower(v_name)) then
    raise exception 'category name in use' using errcode = '22023';
  end if;
  insert into public.budget_categories (wedding_id, name, allocation_minor, sort_order, created_by)
    values (p_wedding, v_name, p_allocation_minor,
            coalesce((select max(sort_order) + 10 from public.budget_categories where wedding_id = p_wedding), 1000),
            v_user)
    returning id into v_id;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'budget_category', v_id, 'budget.category_created',
            jsonb_build_object('hasAllocation', p_allocation_minor is not null), v_wedding.revision);
  if p_idempotency_key is not null then
    perform app_private.idem_done(v_user, 'create_budget_category:' || p_wedding::text, p_idempotency_key, v_id);
  end if;
  return v_id;
end;
$$;

-- p_names: array of strings. Adds the ones not already present (ignoring case) and never brings
-- back an archived name's row; safe to repeat. Returns how many were added.
create function public.add_suggested_budget_categories(p_wedding uuid, p_names jsonb) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_name jsonb;
  v_text text;
  v_added integer := 0;
  v_base integer;
begin
  v_wedding := app_private.lock_wedding_for_budget(p_wedding);
  if p_names is null or jsonb_typeof(p_names) <> 'array' or jsonb_array_length(p_names) > 20 then
    raise exception 'invalid suggestions' using errcode = '22023';
  end if;
  select coalesce(max(sort_order), 990) + 10 into v_base from public.budget_categories where wedding_id = p_wedding;
  for v_name in select * from jsonb_array_elements(p_names) loop
    if jsonb_typeof(v_name) <> 'string' or char_length(btrim(v_name #>> '{}')) not between 1 and 80 then
      raise exception 'invalid suggestion' using errcode = '22023';
    end if;
    v_text := btrim(v_name #>> '{}');
    if not exists (select 1 from public.budget_categories
                   where wedding_id = p_wedding and archived_at is null and lower(name) = lower(v_text)) then
      if (select count(*) from public.budget_categories where wedding_id = p_wedding and archived_at is null) >= 40 then
        raise exception 'too many categories' using errcode = '54000';
      end if;
      insert into public.budget_categories (wedding_id, name, sort_order, created_by)
        values (p_wedding, v_text, v_base + v_added * 10, v_user);
      v_added := v_added + 1;
    end if;
  end loop;
  if v_added > 0 then
    insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
      values (p_wedding, v_user, 'wedding', p_wedding, 'budget.categories_suggested',
              jsonb_build_object('added', v_added), v_wedding.revision);
  end if;
  return v_added;
end;
$$;

create function public.update_budget_category(
  p_wedding uuid,
  p_category uuid,
  p_expected_version integer,
  p_name text,
  p_allocation_minor bigint default null
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.budget_categories%rowtype;
  v_name text := btrim(coalesce(p_name, ''));
  v_changed text[] := '{}';
  v_version integer;
begin
  v_wedding := app_private.lock_wedding_for_budget(p_wedding);
  if char_length(v_name) not between 1 and 80
     or (p_allocation_minor is not null and p_allocation_minor not between 0 and 10000000000) then
    raise exception 'invalid category' using errcode = '22023';
  end if;
  select * into v_old from public.budget_categories where id = p_category and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_old.archived_at is not null or v_old.version <> p_expected_version then
    raise exception 'category changed, reload' using errcode = '55000';
  end if;
  if exists (select 1 from public.budget_categories
             where wedding_id = p_wedding and archived_at is null and id <> p_category
               and lower(name) = lower(v_name)) then
    raise exception 'category name in use' using errcode = '22023';
  end if;
  if v_name is distinct from v_old.name then v_changed := array_append(v_changed, 'name'); end if;
  if p_allocation_minor is distinct from v_old.allocation_minor then v_changed := array_append(v_changed, 'allocation'); end if;
  if coalesce(array_length(v_changed, 1), 0) = 0 then
    return v_old.version;
  end if;
  update public.budget_categories set name = v_name, allocation_minor = p_allocation_minor
    where id = p_category returning version into v_version;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'budget_category', p_category, 'budget.category_updated',
            jsonb_build_object('changed', to_jsonb(v_changed)), v_wedding.revision);
  return v_version;
end;
$$;

-- A category with active items cannot be archived: move or remove them first, so no estimate
-- silently drops out of the forecast.
create function public.archive_budget_category(p_wedding uuid, p_category uuid, p_expected_version integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.budget_categories%rowtype;
  v_version integer;
begin
  v_wedding := app_private.lock_wedding_for_budget(p_wedding);
  select * into v_old from public.budget_categories where id = p_category and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_old.archived_at is not null or v_old.version <> p_expected_version then
    raise exception 'category changed, reload' using errcode = '55000';
  end if;
  if exists (select 1 from public.budget_items
             where wedding_id = p_wedding and category_id = p_category and archived_at is null) then
    raise exception 'category still has costs' using errcode = '22023';
  end if;
  update public.budget_categories set archived_at = now() where id = p_category returning version into v_version;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'budget_category', p_category, 'budget.category_archived', '{}'::jsonb, v_wedding.revision);
  return v_version;
end;
$$;

-- ---------------------------------------------------------------- items
create function app_private.assert_budget_item_fields(
  p_name text, p_cost_mode text, p_amount bigint, p_quantity integer, p_min_qty integer, p_notes text
) returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if char_length(btrim(coalesce(p_name, ''))) not between 1 and 160
     or p_cost_mode is null or p_cost_mode not in ('fixed', 'per_guest', 'quantity')
     or (p_amount is not null and p_amount not between 0 and 100000000)
     or (p_quantity is not null and (p_cost_mode <> 'quantity' or p_quantity not between 1 and 100000))
     or (p_min_qty is not null and (p_cost_mode <> 'per_guest' or p_min_qty not between 1 and 100000))
     or char_length(coalesce(p_notes, '')) > 1000 then
    raise exception 'invalid cost' using errcode = '22023';
  end if;
end;
$$;

create function public.create_budget_item(
  p_wedding uuid,
  p_category uuid,
  p_name text,
  p_cost_mode text default 'fixed',
  p_amount_minor bigint default null,
  p_quantity integer default null,
  p_min_qty integer default null,
  p_notes text default null,
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
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_hash text;
  v_prior uuid;
  v_id uuid;
begin
  v_wedding := app_private.lock_wedding_for_budget(p_wedding);
  perform app_private.assert_budget_item_fields(v_name, p_cost_mode, p_amount_minor, p_quantity, p_min_qty, v_notes);
  if p_idempotency_key is not null then
    v_hash := md5(concat_ws('|', p_category::text, v_name, p_cost_mode, coalesce(p_amount_minor::text, ''),
      coalesce(p_quantity::text, ''), coalesce(p_min_qty::text, ''), coalesce(v_notes, '')));
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
  if (select count(*) from public.budget_items where wedding_id = p_wedding and archived_at is null) >= 300 then
    raise exception 'too many costs' using errcode = '54000';
  end if;
  insert into public.budget_items (wedding_id, category_id, name, cost_mode, amount_minor, quantity, min_qty, notes, created_by)
    values (p_wedding, p_category, v_name, p_cost_mode, p_amount_minor, p_quantity, p_min_qty, v_notes, v_user)
    returning id into v_id;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'budget_item', v_id, 'budget.item_created',
            jsonb_build_object('costMode', p_cost_mode, 'amountKnown', p_amount_minor is not null), v_wedding.revision);
  if p_idempotency_key is not null then
    perform app_private.idem_done(v_user, 'create_budget_item:' || p_wedding::text, p_idempotency_key, v_id);
  end if;
  return v_id;
end;
$$;

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
  p_notes text default null
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
  if v_name is distinct from v_old.name then v_changed := array_append(v_changed, 'name'); end if;
  if p_cost_mode is distinct from v_old.cost_mode then v_changed := array_append(v_changed, 'costMode'); end if;
  if p_amount_minor is distinct from v_old.amount_minor then v_changed := array_append(v_changed, 'amount'); end if;
  if p_quantity is distinct from v_old.quantity or p_min_qty is distinct from v_old.min_qty
    then v_changed := array_append(v_changed, 'quantity'); end if;
  if v_notes is distinct from v_old.notes then v_changed := array_append(v_changed, 'notes'); end if;
  if coalesce(array_length(v_changed, 1), 0) = 0 then
    return v_old.version;
  end if;
  update public.budget_items set category_id = p_category, name = v_name, cost_mode = p_cost_mode,
      amount_minor = p_amount_minor, quantity = p_quantity, min_qty = p_min_qty, notes = v_notes
    where id = p_item returning version into v_version;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'budget_item', p_item, 'budget.item_updated',
            jsonb_build_object('changed', to_jsonb(v_changed)), v_wedding.revision);
  return v_version;
end;
$$;

create function public.archive_budget_item(p_wedding uuid, p_item uuid, p_expected_version integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.budget_items%rowtype;
  v_version integer;
begin
  v_wedding := app_private.lock_wedding_for_budget(p_wedding);
  select * into v_old from public.budget_items where id = p_item and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_old.archived_at is not null or v_old.version <> p_expected_version then
    raise exception 'cost changed, reload' using errcode = '55000';
  end if;
  update public.budget_items set archived_at = now() where id = p_item returning version into v_version;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'budget_item', p_item, 'budget.item_archived', '{}'::jsonb, v_wedding.revision);
  return v_version;
end;
$$;

-- ---------------------------------------------------------------- reserve
-- p_expected_version is 0 when no settings row exists yet.
create function public.set_budget_reserve(p_wedding uuid, p_expected_version integer, p_reserve_bp integer default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.budget_settings%rowtype;
  v_inserted integer;
  v_version integer;
begin
  v_wedding := app_private.lock_wedding_for_budget(p_wedding);
  if p_reserve_bp is not null and p_reserve_bp not between 0 and 10000 then
    raise exception 'invalid reserve' using errcode = '22023';
  end if;
  select * into v_old from public.budget_settings where wedding_id = p_wedding for update;
  if not found then
    if p_expected_version <> 0 then
      raise exception 'budget changed, reload' using errcode = '55000';
    end if;
    insert into public.budget_settings (wedding_id, reserve_bp) values (p_wedding, p_reserve_bp)
      on conflict do nothing;
    get diagnostics v_inserted = row_count;
    if v_inserted = 0 then
      raise exception 'budget changed, reload' using errcode = '55000';
    end if;
    v_version := 1;
  else
    if v_old.version <> p_expected_version then
      raise exception 'budget changed, reload' using errcode = '55000';
    end if;
    if p_reserve_bp is not distinct from v_old.reserve_bp then
      return v_old.version;
    end if;
    update public.budget_settings set reserve_bp = p_reserve_bp
      where wedding_id = p_wedding returning version into v_version;
  end if;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'wedding', p_wedding, 'budget.reserve_updated',
            jsonb_build_object('changed', to_jsonb(array['reserve'])), v_wedding.revision);
  return v_version;
end;
$$;

-- ---------------------------------------------------------------- grants
revoke all on function public.create_budget_category(uuid, text, bigint, text) from public, anon;
revoke all on function public.add_suggested_budget_categories(uuid, jsonb) from public, anon;
revoke all on function public.update_budget_category(uuid, uuid, integer, text, bigint) from public, anon;
revoke all on function public.archive_budget_category(uuid, uuid, integer) from public, anon;
revoke all on function public.create_budget_item(uuid, uuid, text, text, bigint, integer, integer, text, text) from public, anon;
revoke all on function public.update_budget_item(uuid, uuid, integer, uuid, text, text, bigint, integer, integer, text) from public, anon;
revoke all on function public.archive_budget_item(uuid, uuid, integer) from public, anon;
revoke all on function public.set_budget_reserve(uuid, integer, integer) from public, anon;
revoke all on function app_private.assert_budget_item_fields(text, text, bigint, integer, integer, text) from public, anon;
grant execute on function public.create_budget_category(uuid, text, bigint, text) to authenticated;
grant execute on function public.add_suggested_budget_categories(uuid, jsonb) to authenticated;
grant execute on function public.update_budget_category(uuid, uuid, integer, text, bigint) to authenticated;
grant execute on function public.archive_budget_category(uuid, uuid, integer) to authenticated;
grant execute on function public.create_budget_item(uuid, uuid, text, text, bigint, integer, integer, text, text) to authenticated;
grant execute on function public.update_budget_item(uuid, uuid, integer, uuid, text, text, bigint, integer, integer, text) to authenticated;
grant execute on function public.archive_budget_item(uuid, uuid, integer) to authenticated;
grant execute on function public.set_budget_reserve(uuid, integer, integer) to authenticated;
grant execute on function app_private.assert_budget_item_fields(text, text, bigint, integer, integer, text) to authenticated;
