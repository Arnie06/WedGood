-- R1-04 vendor pipeline and proposals.
--
-- Rules (docs/06-DATA-MODEL.md, docs/07-DOMAIN-RULES.md):
--  * The pipeline stage lives on the candidate (a venue is a candidate too). Stage changes
--    are explicit, validated and audited. 'booked' and 'cancelled' exist in the vocabulary
--    but cannot be set here: booking must carry a reviewed commitment (R1-07).
--  * A proposal is a quote the couple typed in, with where it came from. Alternatives are
--    never summed; nothing here creates a budget item, commitment or payment.
--  * Unknown stays null. A line with a missing amount is unknown, never zero.
--  * Money is integer minor units in the wedding's base currency at entry time.
-- All writes go through these RPCs; clients only get SELECT through RLS. Authorization is
-- the same capability as candidates (vendors.manage = owner and partner).

alter table public.candidates
  add column stage text not null default 'saved' check (stage in (
    'saved', 'contacted', 'proposal_received', 'considering', 'booked', 'declined', 'cancelled'
  )),
  add column stage_changed_at timestamptz not null default now();

create table public.proposals (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null,
  candidate_id uuid not null,
  title text not null check (char_length(title) between 1 and 160),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  received_on date check (received_on is null or received_on between date '1970-01-01' and date '2200-12-31'),
  valid_until date check (valid_until is null or valid_until between date '1970-01-01' and date '2200-12-31'),
  source_url text check (
    source_url is null or (
      char_length(source_url) <= 2000
      and source_url ~* '^https?://[^\s/?#]+'
      and source_url !~ '\s'
      and source_url !~* '^https?://[^/?#]*@'
    )
  ),
  notes text check (notes is null or char_length(notes) <= 2000),
  status text not null default 'open' check (status in ('open', 'declined')),
  created_by uuid references auth.users (id) on delete set null,
  archived_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (wedding_id, id),
  foreign key (wedding_id, candidate_id)
    references public.candidates (wedding_id, id) on delete cascade
);
create index proposals_candidate_idx on public.proposals (wedding_id, candidate_id, created_at)
  where archived_at is null;
create trigger proposals_touch before update on public.proposals
  for each row execute function app_private.touch_updated_at();

-- cost_mode:
--   fixed      amount_minor (null = unknown)
--   per_guest  amount_minor is the unit price; min_qty/max_qty are the vendor's stated bounds
--   quantity   amount_minor is the unit price; quantity is the units (null = unknown)
--   percent    rate_bp (basis points) of the lines flagged percent_base
--   included   no amount of its own; explains which other line already covers it
create table public.proposal_lines (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null,
  proposal_id uuid not null,
  position integer not null check (position >= 0),
  description text not null check (char_length(description) between 1 and 200),
  cost_mode text not null check (cost_mode in ('fixed', 'per_guest', 'quantity', 'percent', 'included')),
  amount_minor bigint check (amount_minor is null or amount_minor between 0 and 100000000),
  quantity integer check (quantity is null or quantity between 1 and 100000),
  min_qty integer check (min_qty is null or min_qty between 1 and 100000),
  max_qty integer check (max_qty is null or max_qty between 1 and 100000),
  rate_bp integer check (rate_bp is null or rate_bp between 1 and 10000),
  percent_base boolean not null default false,
  required boolean not null default true,
  certainty text not null default 'quoted' check (certainty in ('quoted', 'estimated')),
  included_in_line_id uuid,
  evidence text check (evidence is null or char_length(evidence) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (proposal_id, id),
  foreign key (wedding_id, proposal_id)
    references public.proposals (wedding_id, id) on delete cascade,
  -- An inclusion points at a line of the same proposal.
  foreign key (proposal_id, included_in_line_id)
    references public.proposal_lines (proposal_id, id),
  check (included_in_line_id is distinct from id),
  check (min_qty is null or max_qty is null or min_qty <= max_qty),
  -- Each mode carries only the fields that mean something for it.
  check (cost_mode in ('per_guest') or (min_qty is null and max_qty is null)),
  check (cost_mode = 'quantity' or quantity is null),
  check ((cost_mode = 'percent') = (rate_bp is not null)),
  check (cost_mode <> 'percent' and cost_mode <> 'included' or amount_minor is null),
  check ((cost_mode = 'included') = (included_in_line_id is not null)),
  -- Percent lines can never be a percent base, so a percentage cannot depend on itself.
  check (not percent_base or cost_mode in ('fixed', 'per_guest', 'quantity'))
);
create index proposal_lines_proposal_idx on public.proposal_lines (proposal_id, position, created_at);
-- Lines carry no version of their own (the proposal's version covers them), so they can't use
-- the shared touch trigger, which also bumps `version`.
create function app_private.touch_updated_at_only() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger proposal_lines_touch before update on public.proposal_lines
  for each row execute function app_private.touch_updated_at_only();

alter table public.proposals enable row level security;
alter table public.proposal_lines enable row level security;
revoke all on public.proposals, public.proposal_lines from anon, authenticated;
grant select on public.proposals, public.proposal_lines to authenticated;
create policy proposals_select_member on public.proposals
  for select to authenticated using (app_private.is_member(wedding_id));
create policy proposal_lines_select_member on public.proposal_lines
  for select to authenticated using (app_private.is_member(wedding_id));

-- ---------------------------------------------------------------- stage
-- Open stages move freely among themselves (people misclick and change their minds);
-- declined can be reopened. booked/cancelled are reserved for the booking flow.
create function public.set_candidate_stage(
  p_wedding uuid, p_candidate uuid, p_expected_version integer, p_stage text
) returns integer
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
  if p_stage is null or p_stage not in ('saved', 'contacted', 'proposal_received', 'considering', 'declined') then
    raise exception 'stage not available' using errcode = '22023';
  end if;
  select * into v_old from public.candidates where id = p_candidate and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_old.archived_at is not null or v_old.version <> p_expected_version then
    raise exception 'candidate changed, reload' using errcode = '55000';
  end if;
  if v_old.stage in ('booked', 'cancelled') then
    raise exception 'stage not available' using errcode = '22023';
  end if;
  if v_old.stage = p_stage then
    return v_old.version;
  end if;
  update public.candidates set stage = p_stage, stage_changed_at = now(), version = version + 1
    where id = p_candidate returning version into v_version;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'candidate', p_candidate, 'candidate.stage_changed',
            jsonb_build_object('from', v_old.stage, 'to', p_stage), v_wedding.revision);
  return v_version;
end;
$$;

-- ---------------------------------------------------------------- proposals
create function public.create_proposal(
  p_wedding uuid,
  p_candidate uuid,
  p_title text,
  p_received_on date default null,
  p_valid_until date default null,
  p_source_url text default null,
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
  v_cand public.candidates%rowtype;
  v_title text := btrim(coalesce(p_title, ''));
  v_hash text;
  v_existing public.idempotency_keys%rowtype;
  v_id uuid;
begin
  v_wedding := app_private.lock_wedding_for_vendors(p_wedding);
  if char_length(v_title) not between 1 and 160 then
    raise exception 'invalid proposal' using errcode = '22023';
  end if;
  select * into v_cand from public.candidates where id = p_candidate and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_cand.archived_at is not null then
    raise exception 'candidate changed, reload' using errcode = '55000';
  end if;

  if p_idempotency_key is not null then
    v_hash := md5(concat_ws('|', p_candidate::text, v_title, coalesce(p_received_on::text, ''),
      coalesce(p_valid_until::text, ''), coalesce(p_source_url, ''), coalesce(p_notes, '')));
    insert into public.idempotency_keys (actor_scope, operation, key, request_hash)
      values (v_user::text, 'create_proposal:' || p_wedding::text, p_idempotency_key, v_hash)
      on conflict do nothing;
    select * into v_existing from public.idempotency_keys
      where actor_scope = v_user::text and operation = 'create_proposal:' || p_wedding::text
        and key = p_idempotency_key
      for update;
    if v_existing.request_hash <> v_hash then
      raise exception 'idempotency key reused with different request' using errcode = '23505';
    end if;
    if v_existing.response_ref is not null then
      return v_existing.response_ref;
    end if;
  end if;

  if (select count(*) from public.proposals where candidate_id = p_candidate and archived_at is null) >= 20 then
    raise exception 'too many proposals' using errcode = '54000';
  end if;

  insert into public.proposals (wedding_id, candidate_id, title, currency, received_on, valid_until,
                                source_url, notes, created_by)
    values (p_wedding, p_candidate, v_title, v_wedding.base_currency, p_received_on, p_valid_until,
            nullif(btrim(coalesce(p_source_url, '')), ''), nullif(btrim(coalesce(p_notes, '')), ''), v_user)
    returning id into v_id;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'proposal', v_id, 'proposal.created',
            jsonb_build_object('candidate_id', p_candidate), v_wedding.revision);
  if p_idempotency_key is not null then
    update public.idempotency_keys set response_ref = v_id
      where actor_scope = v_user::text and operation = 'create_proposal:' || p_wedding::text
        and key = p_idempotency_key;
  end if;
  return v_id;
end;
$$;

create function public.update_proposal(
  p_wedding uuid,
  p_proposal uuid,
  p_expected_version integer,
  p_title text,
  p_received_on date default null,
  p_valid_until date default null,
  p_source_url text default null,
  p_notes text default null
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.proposals%rowtype;
  v_title text := btrim(coalesce(p_title, ''));
  v_url text := nullif(btrim(coalesce(p_source_url, '')), '');
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_changed text[] := '{}';
  v_version integer;
begin
  v_wedding := app_private.lock_wedding_for_vendors(p_wedding);
  if char_length(v_title) not between 1 and 160 then
    raise exception 'invalid proposal' using errcode = '22023';
  end if;
  select * into v_old from public.proposals where id = p_proposal and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_old.archived_at is not null or v_old.version <> p_expected_version then
    raise exception 'proposal changed, reload' using errcode = '55000';
  end if;
  if v_title is distinct from v_old.title then v_changed := array_append(v_changed, 'title'); end if;
  if p_received_on is distinct from v_old.received_on or p_valid_until is distinct from v_old.valid_until
    then v_changed := array_append(v_changed, 'dates'); end if;
  if v_url is distinct from v_old.source_url then v_changed := array_append(v_changed, 'source'); end if;
  if v_notes is distinct from v_old.notes then v_changed := array_append(v_changed, 'notes'); end if;
  if coalesce(array_length(v_changed, 1), 0) = 0 then
    return v_old.version;
  end if;
  update public.proposals set title = v_title, received_on = p_received_on, valid_until = p_valid_until,
      source_url = v_url, notes = v_notes, version = version + 1
    where id = p_proposal returning version into v_version;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'proposal', p_proposal, 'proposal.updated',
            jsonb_build_object('changed', to_jsonb(v_changed)), v_wedding.revision);
  return v_version;
end;
$$;

create function public.set_proposal_status(
  p_wedding uuid, p_proposal uuid, p_expected_version integer, p_status text
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.proposals%rowtype;
  v_version integer;
begin
  v_wedding := app_private.lock_wedding_for_vendors(p_wedding);
  if p_status is null or p_status not in ('open', 'declined') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  select * into v_old from public.proposals where id = p_proposal and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_old.archived_at is not null or v_old.version <> p_expected_version then
    raise exception 'proposal changed, reload' using errcode = '55000';
  end if;
  if v_old.status = p_status then
    return v_old.version;
  end if;
  update public.proposals set status = p_status, version = version + 1
    where id = p_proposal returning version into v_version;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'proposal', p_proposal, 'proposal.status_changed',
            jsonb_build_object('from', v_old.status, 'to', p_status), v_wedding.revision);
  return v_version;
end;
$$;

create function public.archive_proposal(p_wedding uuid, p_proposal uuid, p_expected_version integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.proposals%rowtype;
begin
  v_wedding := app_private.lock_wedding_for_vendors(p_wedding);
  select * into v_old from public.proposals where id = p_proposal and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_old.archived_at is not null then
    return;
  end if;
  if v_old.version <> p_expected_version then
    raise exception 'proposal changed, reload' using errcode = '55000';
  end if;
  update public.proposals set archived_at = now(), version = version + 1 where id = p_proposal;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'proposal', p_proposal, 'proposal.archived', '{}'::jsonb, v_wedding.revision);
end;
$$;

-- ---------------------------------------------------------------- lines
-- An inclusion must point at an ordinary additive line of the same proposal, and a line
-- that others point at cannot itself become an inclusion or a percentage. Together with
-- the table checks this keeps inclusions one level deep, so there are no cycles.
create function app_private.assert_line_links(
  p_proposal uuid, p_line uuid, p_mode text, p_included_in uuid
) returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_included_in is not null then
    if not exists (
      select 1 from public.proposal_lines
       where id = p_included_in and proposal_id = p_proposal and cost_mode in ('fixed', 'per_guest', 'quantity')
    ) then
      raise exception 'invalid inclusion' using errcode = '22023';
    end if;
  end if;
  if p_line is not null and p_mode in ('included', 'percent') and exists (
    select 1 from public.proposal_lines where proposal_id = p_proposal and included_in_line_id = p_line
  ) then
    raise exception 'line is referenced' using errcode = '23503';
  end if;
end;
$$;
revoke all on function app_private.assert_line_links(uuid, uuid, text, uuid) from public, anon;
grant execute on function app_private.assert_line_links(uuid, uuid, text, uuid) to authenticated;

create function public.add_proposal_line(
  p_wedding uuid,
  p_proposal uuid,
  p_expected_version integer,
  p_description text,
  p_cost_mode text,
  p_amount_minor bigint default null,
  p_quantity integer default null,
  p_min_qty integer default null,
  p_max_qty integer default null,
  p_rate_bp integer default null,
  p_percent_base boolean default false,
  p_required boolean default true,
  p_certainty text default 'quoted',
  p_included_in_line_id uuid default null,
  p_evidence text default null,
  p_idempotency_key text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_prop public.proposals%rowtype;
  v_desc text := btrim(coalesce(p_description, ''));
  v_hash text;
  v_existing public.idempotency_keys%rowtype;
  v_id uuid;
begin
  v_wedding := app_private.lock_wedding_for_vendors(p_wedding);
  select * into v_prop from public.proposals where id = p_proposal and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  if p_idempotency_key is not null then
    v_hash := md5(concat_ws('|', p_proposal::text, v_desc, p_cost_mode, coalesce(p_amount_minor::text, ''),
      coalesce(p_quantity::text, ''), coalesce(p_min_qty::text, ''), coalesce(p_max_qty::text, ''),
      coalesce(p_rate_bp::text, ''), coalesce(p_percent_base::text, ''), coalesce(p_required::text, ''),
      coalesce(p_certainty, ''), coalesce(p_included_in_line_id::text, ''), coalesce(p_evidence, '')));
    insert into public.idempotency_keys (actor_scope, operation, key, request_hash)
      values (v_user::text, 'add_proposal_line:' || p_wedding::text, p_idempotency_key, v_hash)
      on conflict do nothing;
    select * into v_existing from public.idempotency_keys
      where actor_scope = v_user::text and operation = 'add_proposal_line:' || p_wedding::text
        and key = p_idempotency_key
      for update;
    if v_existing.request_hash <> v_hash then
      raise exception 'idempotency key reused with different request' using errcode = '23505';
    end if;
    if v_existing.response_ref is not null then
      return v_existing.response_ref;
    end if;
  end if;

  if v_prop.archived_at is not null or v_prop.version <> p_expected_version then
    raise exception 'proposal changed, reload' using errcode = '55000';
  end if;
  if (select count(*) from public.proposal_lines where proposal_id = p_proposal) >= 60 then
    raise exception 'too many lines' using errcode = '54000';
  end if;
  perform app_private.assert_line_links(p_proposal, null, p_cost_mode, p_included_in_line_id);

  insert into public.proposal_lines (wedding_id, proposal_id, position, description, cost_mode, amount_minor,
      quantity, min_qty, max_qty, rate_bp, percent_base, required, certainty, included_in_line_id, evidence)
    values (p_wedding, p_proposal,
            coalesce((select max(position) + 1 from public.proposal_lines where proposal_id = p_proposal), 0),
            v_desc, p_cost_mode, p_amount_minor, p_quantity, p_min_qty, p_max_qty, p_rate_bp,
            coalesce(p_percent_base, false), coalesce(p_required, true), coalesce(p_certainty, 'quoted'),
            p_included_in_line_id, nullif(btrim(coalesce(p_evidence, '')), ''))
    returning id into v_id;
  update public.proposals set version = version + 1 where id = p_proposal;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'proposal', p_proposal, 'proposal.line_added',
            jsonb_build_object('line_id', v_id, 'cost_mode', p_cost_mode), v_wedding.revision);
  if p_idempotency_key is not null then
    update public.idempotency_keys set response_ref = v_id
      where actor_scope = v_user::text and operation = 'add_proposal_line:' || p_wedding::text
        and key = p_idempotency_key;
  end if;
  return v_id;
end;
$$;

create function public.update_proposal_line(
  p_wedding uuid,
  p_line uuid,
  p_expected_version integer,
  p_description text,
  p_cost_mode text,
  p_amount_minor bigint default null,
  p_quantity integer default null,
  p_min_qty integer default null,
  p_max_qty integer default null,
  p_rate_bp integer default null,
  p_percent_base boolean default false,
  p_required boolean default true,
  p_certainty text default 'quoted',
  p_included_in_line_id uuid default null,
  p_evidence text default null
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_prop public.proposals%rowtype;
  v_old public.proposal_lines%rowtype;
  v_desc text := btrim(coalesce(p_description, ''));
  v_evidence text := nullif(btrim(coalesce(p_evidence, '')), '');
  v_version integer;
begin
  v_wedding := app_private.lock_wedding_for_vendors(p_wedding);
  select * into v_old from public.proposal_lines where id = p_line and wedding_id = p_wedding;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  select * into v_prop from public.proposals where id = v_old.proposal_id for update;
  if v_prop.archived_at is not null or v_prop.version <> p_expected_version then
    raise exception 'proposal changed, reload' using errcode = '55000';
  end if;
  select * into v_old from public.proposal_lines where id = p_line;
  perform app_private.assert_line_links(v_old.proposal_id, p_line, p_cost_mode, p_included_in_line_id);

  if v_desc = v_old.description and p_cost_mode = v_old.cost_mode
     and p_amount_minor is not distinct from v_old.amount_minor and p_quantity is not distinct from v_old.quantity
     and p_min_qty is not distinct from v_old.min_qty and p_max_qty is not distinct from v_old.max_qty
     and p_rate_bp is not distinct from v_old.rate_bp and coalesce(p_percent_base, false) = v_old.percent_base
     and coalesce(p_required, true) = v_old.required and coalesce(p_certainty, 'quoted') = v_old.certainty
     and p_included_in_line_id is not distinct from v_old.included_in_line_id
     and v_evidence is not distinct from v_old.evidence then
    return v_prop.version;
  end if;

  update public.proposal_lines set description = v_desc, cost_mode = p_cost_mode, amount_minor = p_amount_minor,
      quantity = p_quantity, min_qty = p_min_qty, max_qty = p_max_qty, rate_bp = p_rate_bp,
      percent_base = coalesce(p_percent_base, false), required = coalesce(p_required, true),
      certainty = coalesce(p_certainty, 'quoted'), included_in_line_id = p_included_in_line_id,
      evidence = v_evidence
    where id = p_line;
  update public.proposals set version = version + 1 where id = v_old.proposal_id returning version into v_version;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'proposal', v_old.proposal_id, 'proposal.line_updated',
            jsonb_build_object('line_id', p_line), v_wedding.revision);
  return v_version;
end;
$$;

create function public.remove_proposal_line(p_wedding uuid, p_line uuid, p_expected_version integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_prop public.proposals%rowtype;
  v_old public.proposal_lines%rowtype;
  v_version integer;
begin
  v_wedding := app_private.lock_wedding_for_vendors(p_wedding);
  select * into v_old from public.proposal_lines where id = p_line and wedding_id = p_wedding;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  select * into v_prop from public.proposals where id = v_old.proposal_id for update;
  if v_prop.archived_at is not null or v_prop.version <> p_expected_version then
    raise exception 'proposal changed, reload' using errcode = '55000';
  end if;
  if exists (select 1 from public.proposal_lines where proposal_id = v_old.proposal_id and included_in_line_id = p_line) then
    raise exception 'line is referenced' using errcode = '23503';
  end if;
  delete from public.proposal_lines where id = p_line;
  update public.proposals set version = version + 1 where id = v_old.proposal_id returning version into v_version;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'proposal', v_old.proposal_id, 'proposal.line_removed',
            jsonb_build_object('line_id', p_line), v_wedding.revision);
  return v_version;
end;
$$;

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('set_candidate_stage', 'create_proposal', 'update_proposal', 'set_proposal_status',
                         'archive_proposal', 'add_proposal_line', 'update_proposal_line', 'remove_proposal_line')
  loop
    execute format('revoke all on function %s from public, anon', r.sig);
    execute format('grant execute on function %s to authenticated', r.sig);
  end loop;
end;
$$;
