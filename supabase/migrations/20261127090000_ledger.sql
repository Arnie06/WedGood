-- R1-07 booking and payment ledger: commitments, allocations, installment schedules and payments.
--
-- Rules (docs/07-DOMAIN-RULES.md, ADR-019):
--  * Money is integer minor units in the wedding's base currency. Recorded payments are manual
--    records of money that already moved; nothing here moves money. Scheduled installments are a
--    plan, never "paid".
--  * Booking is one atomic step: commitment + budget allocations + installment schedule + vendor
--    stage 'booked'. An active allocation covers a budget item once (partial unique index), so a
--    booked cost is never counted twice in the forecast.
--  * Amending never edits a signed commitment in place: the old row is kept as 'superseded', a new
--    row supersedes it, and recorded payments are moved to the new row with an audit count.
--  * Payments are append-only facts. A mistaken one is voided (kept, flagged, with a reason); it is
--    never deleted. A refund cannot exceed what is net paid on its target.
--  * All writes go through RPCs (owner and partner); clients only get SELECT through RLS. Writes are
--    audited by field name / counts only and creates accept an idempotency key.

-- ---------------------------------------------------------------- tables
create table public.commitments (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  candidate_id uuid,
  proposal_id uuid,
  title text not null check (char_length(title) between 1 and 160),
  amount_minor bigint not null check (amount_minor between 1 and 100000000),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'active' check (status in ('active', 'superseded', 'cancelled')),
  signed_on date,
  supersedes_id uuid,
  created_by uuid references auth.users (id) on delete set null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (wedding_id, id),
  foreign key (wedding_id, candidate_id) references public.candidates (wedding_id, id),
  foreign key (wedding_id, proposal_id) references public.proposals (wedding_id, id),
  foreign key (wedding_id, supersedes_id) references public.commitments (wedding_id, id)
);
-- One active commitment per venue or vendor: more cost is an amendment, not a second booking.
create unique index commitments_one_active_per_candidate
  on public.commitments (candidate_id) where status = 'active' and candidate_id is not null;
create index commitments_wedding_idx on public.commitments (wedding_id, status);
create trigger commitments_touch before update on public.commitments
  for each row execute function app_private.touch_updated_at();

create table public.commitment_allocations (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null,
  commitment_id uuid not null,
  budget_item_id uuid not null,
  amount_minor bigint not null check (amount_minor between 1 and 100000000),
  -- False once the commitment is superseded; the row stays as history.
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (commitment_id, budget_item_id),
  foreign key (wedding_id, commitment_id) references public.commitments (wedding_id, id) on delete cascade,
  foreign key (wedding_id, budget_item_id) references public.budget_items (wedding_id, id)
);
create unique index commitment_allocations_one_active_item
  on public.commitment_allocations (budget_item_id) where active;

create table public.payment_installments (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null,
  commitment_id uuid not null,
  amount_minor bigint not null check (amount_minor between 1 and 100000000),
  due_on date not null,
  label text check (label is null or char_length(label) between 1 and 80),
  created_at timestamptz not null default now(),
  foreign key (wedding_id, commitment_id) references public.commitments (wedding_id, id) on delete cascade
);
create index payment_installments_commitment_idx on public.payment_installments (commitment_id, due_on);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null,
  commitment_id uuid,
  budget_item_id uuid,
  kind text not null check (kind in ('charge', 'refund')),
  amount_minor bigint not null check (amount_minor between 1 and 100000000),
  paid_on date not null,
  method_label text check (method_label is null or char_length(method_label) between 1 and 60),
  note text check (note is null or char_length(note) between 1 and 500),
  external_ref text check (external_ref is null or char_length(external_ref) between 1 and 120),
  voided_at timestamptz,
  void_reason text check (void_reason is null or char_length(void_reason) between 1 and 200),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  -- Exactly one parent: a booking, or one planned cost with no booking.
  check ((commitment_id is null) <> (budget_item_id is null)),
  check ((voided_at is null) = (void_reason is null)),
  foreign key (wedding_id, commitment_id) references public.commitments (wedding_id, id),
  foreign key (wedding_id, budget_item_id) references public.budget_items (wedding_id, id)
);
create unique index payments_external_ref_idx on public.payments (wedding_id, external_ref)
  where external_ref is not null;
create index payments_commitment_idx on public.payments (commitment_id) where commitment_id is not null;
create index payments_item_idx on public.payments (budget_item_id) where budget_item_id is not null;

alter table public.commitments enable row level security;
alter table public.commitment_allocations enable row level security;
alter table public.payment_installments enable row level security;
alter table public.payments enable row level security;
revoke all on public.commitments, public.commitment_allocations, public.payment_installments, public.payments
  from anon, authenticated;
grant select on public.commitments, public.commitment_allocations, public.payment_installments, public.payments
  to authenticated;
create policy commitments_select_member on public.commitments
  for select to authenticated using (app_private.is_member(wedding_id));
create policy commitment_allocations_select_member on public.commitment_allocations
  for select to authenticated using (app_private.is_member(wedding_id));
create policy payment_installments_select_member on public.payment_installments
  for select to authenticated using (app_private.is_member(wedding_id));
create policy payments_select_member on public.payments
  for select to authenticated using (app_private.is_member(wedding_id));

-- ---------------------------------------------------------------- guards on existing rules
-- Amounts carry no currency of their own, so the base currency cannot change once any budget amount,
-- commitment or payment exists (R1-06 guard, extended). Refused with 55006.
create or replace function app_private.guard_currency_change() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.base_currency is distinct from old.base_currency and (
    exists (select 1 from public.budget_categories where wedding_id = old.id and allocation_minor is not null)
    or exists (select 1 from public.budget_items where wedding_id = old.id and amount_minor is not null)
    or exists (select 1 from public.commitments where wedding_id = old.id)
    or exists (select 1 from public.payments where wedding_id = old.id)
  ) then
    raise exception 'currency cannot change while budget amounts exist' using errcode = '55006';
  end if;
  return new;
end;
$$;

-- A cost that a booking covers, or that has money recorded against it, cannot be removed: it would
-- silently drop booked or paid money out of the forecast.
create or replace function public.archive_budget_item(p_wedding uuid, p_item uuid, p_expected_version integer)
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
  if exists (select 1 from public.commitment_allocations where budget_item_id = p_item and active) then
    raise exception 'cost is booked' using errcode = '22023';
  end if;
  if exists (select 1 from public.payments where budget_item_id = p_item and voided_at is null) then
    raise exception 'cost has payments' using errcode = '22023';
  end if;
  update public.budget_items set archived_at = now() where id = p_item returning version into v_version;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'budget_item', p_item, 'budget.item_archived', '{}'::jsonb, v_wedding.revision);
  return v_version;
end;
$$;

-- ---------------------------------------------------------------- helpers
-- Net money paid on one target (a commitment or a planned cost): charges minus refunds, voided
-- payments ignored. Callers hold a row lock on the target so the figure cannot change under them.
create function app_private.net_paid(p_commitment uuid, p_item uuid) returns bigint
language sql stable
set search_path = ''
as $$
  select coalesce(sum(case kind when 'charge' then amount_minor else -amount_minor end), 0)::bigint
    from public.payments
   where voided_at is null
     and ((p_commitment is not null and commitment_id = p_commitment)
       or (p_item is not null and budget_item_id = p_item));
$$;

-- Validates and writes the allocations and installment schedule of one commitment.
--   p_allocations: [{"itemId": uuid, "amountMinor": n}], 1 to 10, summing to the commitment amount
--   p_installments: [{"dueOn": "YYYY-MM-DD", "amountMinor": n, "label": text?}], 0 to 24
-- The installment total may differ from the amount; the app flags that rather than blocking it.
create function app_private.write_commitment_lines(
  p_wedding uuid, p_commitment uuid, p_amount bigint, p_allocations jsonb, p_installments jsonb
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb;
  v_item uuid;
  v_amount bigint;
  v_sum bigint := 0;
  v_seen uuid[] := '{}';
  v_label text;
  v_due date;
begin
  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array'
     or jsonb_array_length(p_allocations) not between 1 and 10 then
    raise exception 'invalid allocations' using errcode = '22023';
  end if;
  for v_row in select * from jsonb_array_elements(p_allocations) loop
    if jsonb_typeof(v_row) <> 'object'
       or jsonb_typeof(v_row -> 'itemId') <> 'string'
       or jsonb_typeof(v_row -> 'amountMinor') <> 'number'
       or (v_row ->> 'itemId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or (v_row ->> 'amountMinor') !~ '^[0-9]{1,9}$' then
      raise exception 'invalid allocations' using errcode = '22023';
    end if;
    v_item := (v_row ->> 'itemId')::uuid;
    v_amount := (v_row ->> 'amountMinor')::bigint;
    if v_amount not between 1 and 100000000 or v_item = any (v_seen) then
      raise exception 'invalid allocations' using errcode = '22023';
    end if;
    v_seen := array_append(v_seen, v_item);
    v_sum := v_sum + v_amount;
    -- Lock the cost so two bookings cannot cover it at the same moment.
    perform 1 from public.budget_items
      where id = v_item and wedding_id = p_wedding and archived_at is null for update;
    if not found then
      raise exception 'cost not available' using errcode = '22023';
    end if;
    if exists (select 1 from public.commitment_allocations where budget_item_id = v_item and active) then
      raise exception 'cost already booked' using errcode = '22023';
    end if;
    if exists (select 1 from public.payments where budget_item_id = v_item and voided_at is null) then
      raise exception 'cost has payments' using errcode = '22023';
    end if;
    insert into public.commitment_allocations (wedding_id, commitment_id, budget_item_id, amount_minor)
      values (p_wedding, p_commitment, v_item, v_amount);
  end loop;
  if v_sum <> p_amount then
    raise exception 'allocations must add up to the amount' using errcode = '22023';
  end if;

  if p_installments is null or jsonb_typeof(p_installments) <> 'array'
     or jsonb_array_length(p_installments) > 24 then
    raise exception 'invalid installments' using errcode = '22023';
  end if;
  for v_row in select * from jsonb_array_elements(p_installments) loop
    if jsonb_typeof(v_row) <> 'object'
       or jsonb_typeof(v_row -> 'dueOn') <> 'string'
       or jsonb_typeof(v_row -> 'amountMinor') <> 'number'
       or (v_row ->> 'dueOn') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       or (v_row ->> 'amountMinor') !~ '^[0-9]{1,9}$'
       or (v_row ? 'label' and jsonb_typeof(v_row -> 'label') not in ('string', 'null')) then
      raise exception 'invalid installments' using errcode = '22023';
    end if;
    begin
      v_due := (v_row ->> 'dueOn')::date;
    exception when others then
      raise exception 'invalid installments' using errcode = '22023';
    end;
    v_amount := (v_row ->> 'amountMinor')::bigint;
    v_label := nullif(btrim(coalesce(v_row ->> 'label', '')), '');
    if v_amount not between 1 and 100000000 or char_length(coalesce(v_label, 'x')) > 80
       or v_due not between date '2000-01-01' and date '2100-12-31' then
      raise exception 'invalid installments' using errcode = '22023';
    end if;
    insert into public.payment_installments (wedding_id, commitment_id, amount_minor, due_on, label)
      values (p_wedding, p_commitment, v_amount, v_due, v_label);
  end loop;
end;
$$;
revoke all on function app_private.net_paid(uuid, uuid) from public, anon;
revoke all on function app_private.write_commitment_lines(uuid, uuid, bigint, jsonb, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------- booking
-- Records that the couple has signed or explicitly confirmed a booking. p_confirmed must be true:
-- the app shows the review first. No external action happens.
create function public.book_commitment(
  p_wedding uuid,
  p_candidate uuid,
  p_expected_candidate_version integer,
  p_title text,
  p_amount_minor bigint,
  p_allocations jsonb,
  p_installments jsonb,
  p_confirmed boolean,
  p_proposal uuid default null,
  p_signed_on date default null,
  p_idempotency_key text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_candidate public.candidates%rowtype;
  v_title text := btrim(coalesce(p_title, ''));
  v_hash text;
  v_prior uuid;
  v_id uuid;
begin
  v_wedding := app_private.lock_wedding_for_budget(p_wedding);
  if p_confirmed is not true
     or char_length(v_title) not between 1 and 160
     or p_amount_minor is null or p_amount_minor not between 1 and 100000000
     or (p_signed_on is not null and p_signed_on not between date '2000-01-01' and date '2100-12-31') then
    raise exception 'invalid booking' using errcode = '22023';
  end if;
  if p_idempotency_key is not null then
    v_hash := md5(concat_ws('|', p_candidate::text, coalesce(p_proposal::text, ''), v_title,
      p_amount_minor::text, coalesce(p_signed_on::text, ''), p_allocations::text, p_installments::text));
    v_prior := app_private.idem_claim(v_user, 'book_commitment:' || p_wedding::text, p_idempotency_key, v_hash);
    if v_prior is not null then
      return v_prior;
    end if;
  end if;

  select * into v_candidate from public.candidates
    where id = p_candidate and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_candidate.archived_at is not null or v_candidate.version <> p_expected_candidate_version then
    raise exception 'candidate changed, reload' using errcode = '55000';
  end if;
  if v_candidate.stage in ('booked', 'cancelled', 'declined') then
    raise exception 'stage not available' using errcode = '22023';
  end if;
  if p_proposal is not null then
    perform 1 from public.proposals
      where id = p_proposal and wedding_id = p_wedding and candidate_id = p_candidate
        and archived_at is null and status = 'open';
    if not found then
      raise exception 'quote not available' using errcode = '22023';
    end if;
  end if;

  insert into public.commitments (wedding_id, candidate_id, proposal_id, title, amount_minor, currency, signed_on, created_by)
    values (p_wedding, p_candidate, p_proposal, v_title, p_amount_minor, v_wedding.base_currency, p_signed_on, v_user)
    returning id into v_id;
  perform app_private.write_commitment_lines(p_wedding, v_id, p_amount_minor, p_allocations, p_installments);
  update public.candidates set stage = 'booked', stage_changed_at = now(), version = version + 1
    where id = p_candidate;

  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'commitment', v_id, 'ledger.commitment_booked',
            jsonb_build_object('candidateId', p_candidate, 'allocations', jsonb_array_length(p_allocations),
                               'installments', jsonb_array_length(p_installments)),
            v_wedding.revision);
  if p_idempotency_key is not null then
    perform app_private.idem_done(v_user, 'book_commitment:' || p_wedding::text, p_idempotency_key, v_id);
  end if;
  return v_id;
end;
$$;

-- Replaces an active commitment with a reviewed new one. The old row is kept as 'superseded'.
-- Payments recorded against the old commitment move to the new one (counted in the audit event).
-- Returns the new commitment's id.
create function public.amend_commitment(
  p_wedding uuid,
  p_commitment uuid,
  p_expected_version integer,
  p_title text,
  p_amount_minor bigint,
  p_allocations jsonb,
  p_installments jsonb,
  p_confirmed boolean,
  p_signed_on date default null,
  p_idempotency_key text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.commitments%rowtype;
  v_title text := btrim(coalesce(p_title, ''));
  v_hash text;
  v_prior uuid;
  v_id uuid;
  v_moved integer;
begin
  v_wedding := app_private.lock_wedding_for_budget(p_wedding);
  if p_confirmed is not true
     or char_length(v_title) not between 1 and 160
     or p_amount_minor is null or p_amount_minor not between 1 and 100000000
     or (p_signed_on is not null and p_signed_on not between date '2000-01-01' and date '2100-12-31') then
    raise exception 'invalid booking' using errcode = '22023';
  end if;
  if p_idempotency_key is not null then
    v_hash := md5(concat_ws('|', p_commitment::text, p_expected_version::text, v_title,
      p_amount_minor::text, coalesce(p_signed_on::text, ''), p_allocations::text, p_installments::text));
    v_prior := app_private.idem_claim(v_user, 'amend_commitment:' || p_wedding::text, p_idempotency_key, v_hash);
    if v_prior is not null then
      return v_prior;
    end if;
  end if;

  select * into v_old from public.commitments where id = p_commitment and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_old.status <> 'active' or v_old.version <> p_expected_version then
    raise exception 'booking changed, reload' using errcode = '55000';
  end if;

  update public.commitments set status = 'superseded' where id = p_commitment;
  update public.commitment_allocations set active = false where commitment_id = p_commitment;
  insert into public.commitments (wedding_id, candidate_id, proposal_id, title, amount_minor, currency,
                                  signed_on, supersedes_id, created_by)
    values (p_wedding, v_old.candidate_id, v_old.proposal_id, v_title, p_amount_minor, v_old.currency,
            p_signed_on, p_commitment, v_user)
    returning id into v_id;
  perform app_private.write_commitment_lines(p_wedding, v_id, p_amount_minor, p_allocations, p_installments);
  update public.payments set commitment_id = v_id where commitment_id = p_commitment;
  get diagnostics v_moved = row_count;

  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'commitment', v_id, 'ledger.commitment_amended',
            jsonb_build_object('supersedes', p_commitment, 'paymentsMoved', v_moved,
                               'amountChanged', p_amount_minor is distinct from v_old.amount_minor),
            v_wedding.revision);
  if p_idempotency_key is not null then
    perform app_private.idem_done(v_user, 'amend_commitment:' || p_wedding::text, p_idempotency_key, v_id);
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------- payments
-- Records money that already moved, against exactly one of: an active commitment, or a planned cost
-- that no booking covers. A refund cannot exceed what is net paid on that target. Charges above the
-- amount owed are allowed and shown as an overpayment. The paid date cannot be in the future in the
-- wedding's time zone.
create function public.record_payment(
  p_wedding uuid,
  p_kind text,
  p_amount_minor bigint,
  p_paid_on date,
  p_commitment uuid default null,
  p_item uuid default null,
  p_method text default null,
  p_note text default null,
  p_external_ref text default null,
  p_idempotency_key text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_method text := nullif(btrim(coalesce(p_method, '')), '');
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_ref text := nullif(btrim(coalesce(p_external_ref, '')), '');
  v_hash text;
  v_prior uuid;
  v_id uuid;
  v_commitment public.commitments%rowtype;
begin
  v_wedding := app_private.lock_wedding_for_budget(p_wedding);
  if p_kind is null or p_kind not in ('charge', 'refund')
     or p_amount_minor is null or p_amount_minor not between 1 and 100000000
     or p_paid_on is null or p_paid_on < date '2000-01-01'
     or p_paid_on > (now() at time zone v_wedding.timezone)::date
     or (p_commitment is null) = (p_item is null)
     or char_length(coalesce(v_method, 'x')) > 60
     or char_length(coalesce(v_note, 'x')) > 500
     or char_length(coalesce(v_ref, 'x')) > 120 then
    raise exception 'invalid payment' using errcode = '22023';
  end if;
  if p_idempotency_key is not null then
    v_hash := md5(concat_ws('|', p_kind, p_amount_minor::text, p_paid_on::text, coalesce(p_commitment::text, ''),
      coalesce(p_item::text, ''), coalesce(v_method, ''), coalesce(v_note, ''), coalesce(v_ref, '')));
    v_prior := app_private.idem_claim(v_user, 'record_payment:' || p_wedding::text, p_idempotency_key, v_hash);
    if v_prior is not null then
      return v_prior;
    end if;
  end if;

  if p_commitment is not null then
    select * into v_commitment from public.commitments
      where id = p_commitment and wedding_id = p_wedding for update;
    if not found then
      raise exception 'not permitted' using errcode = '42501';
    end if;
    if v_commitment.status <> 'active' then
      raise exception 'booking changed, reload' using errcode = '55000';
    end if;
  else
    perform 1 from public.budget_items where id = p_item and wedding_id = p_wedding and archived_at is null for update;
    if not found then
      raise exception 'cost not available' using errcode = '22023';
    end if;
    if exists (select 1 from public.commitment_allocations where budget_item_id = p_item and active) then
      raise exception 'cost is booked' using errcode = '22023';
    end if;
  end if;
  if p_kind = 'refund' and p_amount_minor > app_private.net_paid(p_commitment, p_item) then
    raise exception 'refund exceeds paid' using errcode = '22023';
  end if;

  insert into public.payments (wedding_id, commitment_id, budget_item_id, kind, amount_minor, paid_on,
                               method_label, note, external_ref, created_by)
    values (p_wedding, p_commitment, p_item, p_kind, p_amount_minor, p_paid_on, v_method, v_note, v_ref, v_user)
    returning id into v_id;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'payment', v_id, 'ledger.payment_recorded',
            jsonb_build_object('kind', p_kind, 'target', case when p_commitment is null then 'item' else 'commitment' end),
            v_wedding.revision);
  if p_idempotency_key is not null then
    perform app_private.idem_done(v_user, 'record_payment:' || p_wedding::text, p_idempotency_key, v_id);
  end if;
  return v_id;
end;
$$;

-- Marks a recorded payment as entered by mistake. It stays in the history. Repeating is harmless.
-- A charge cannot be voided while later refunds depend on it (net paid would go negative).
create function public.void_payment(p_wedding uuid, p_payment uuid, p_reason text) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_pay public.payments%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  v_wedding := app_private.lock_wedding_for_budget(p_wedding);
  if char_length(v_reason) not between 1 and 200 then
    raise exception 'invalid reason' using errcode = '22023';
  end if;
  select * into v_pay from public.payments where id = p_payment and wedding_id = p_wedding;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  -- Serialize with other money changes on the same target before re-reading the payment.
  if v_pay.commitment_id is not null then
    perform 1 from public.commitments where id = v_pay.commitment_id for update;
  else
    perform 1 from public.budget_items where id = v_pay.budget_item_id for update;
  end if;
  select * into v_pay from public.payments where id = p_payment for update;
  if v_pay.voided_at is not null then
    return;
  end if;
  if v_pay.kind = 'charge'
     and app_private.net_paid(v_pay.commitment_id, v_pay.budget_item_id) - v_pay.amount_minor < 0 then
    raise exception 'refunds depend on this payment' using errcode = '22023';
  end if;
  update public.payments set voided_at = now(), void_reason = v_reason where id = p_payment;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'payment', p_payment, 'ledger.payment_voided',
            jsonb_build_object('kind', v_pay.kind), v_wedding.revision);
end;
$$;

-- ---------------------------------------------------------------- grants
revoke all on function public.book_commitment(uuid, uuid, integer, text, bigint, jsonb, jsonb, boolean, uuid, date, text) from public, anon;
revoke all on function public.amend_commitment(uuid, uuid, integer, text, bigint, jsonb, jsonb, boolean, date, text) from public, anon;
revoke all on function public.record_payment(uuid, text, bigint, date, uuid, uuid, text, text, text, text) from public, anon;
revoke all on function public.void_payment(uuid, uuid, text) from public, anon;
grant execute on function public.book_commitment(uuid, uuid, integer, text, bigint, jsonb, jsonb, boolean, uuid, date, text) to authenticated;
grant execute on function public.amend_commitment(uuid, uuid, integer, text, bigint, jsonb, jsonb, boolean, date, text) to authenticated;
grant execute on function public.record_payment(uuid, text, bigint, date, uuid, uuid, text, text, text, text) to authenticated;
grant execute on function public.void_payment(uuid, uuid, text) to authenticated;
