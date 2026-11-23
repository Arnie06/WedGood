-- REL-09 invoices: a vendor's request for money on a booking, kept apart from the contract and from
-- payments (ADR-031).
--
-- The ladder on a booking is: contract (commitments.amount_minor) -> invoiced (this table) -> paid
-- (payments) -> still to pay. An invoice never changes the contract or the budget forecast: only an
-- amendment moves a commitment amount, and only a recorded payment moves paid.
--
--  * An invoice belongs to the active commitment of one vendor. Amending a commitment moves its
--    invoices to the new row, and the payments linked to them, exactly as payments already move.
--  * A payment may name the invoice it pays. The database refuses an invoice from another booking
--    (composite foreign key on invoice and commitment), and a refund cannot name an invoice: a refund
--    is a fact about the booking. Overpaying an invoice is allowed and shown, as for a booking.
--  * Invoices are append-only facts: a mistaken one is voided (kept, with a reason), never deleted.
--    Voiding detaches the payments that named it; the payments themselves are unchanged.
--  * An invoice larger than the contract, or invoices adding up to more than it, are shown as a
--    warning in the app and are not blocked here (a vendor can bill for extras not yet amended in).

-- ---------------------------------------------------------------- table
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null,
  commitment_id uuid not null,
  number text check (number is null or char_length(number) between 1 and 60),
  amount_minor bigint not null check (amount_minor between 1 and 100000000),
  issued_on date check (issued_on is null or issued_on between date '2000-01-01' and date '2100-12-31'),
  due_on date check (due_on is null or due_on between date '2000-01-01' and date '2100-12-31'),
  note text check (note is null or char_length(note) between 1 and 500),
  voided_at timestamptz,
  void_reason text check (void_reason is null or char_length(void_reason) between 1 and 200),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  check ((voided_at is null) = (void_reason is null)),
  check (issued_on is null or due_on is null or due_on >= issued_on),
  unique (wedding_id, id),
  -- Lets a payment point at an invoice and its booking together, so they cannot disagree.
  unique (id, commitment_id),
  foreign key (wedding_id, commitment_id) references public.commitments (wedding_id, id)
);
create index invoices_commitment_idx on public.invoices (commitment_id, created_at);
-- The same number twice on one booking is almost always a double entry. Voided ones do not count.
create unique index invoices_number_idx on public.invoices (commitment_id, lower(number))
  where number is not null and voided_at is null;

alter table public.invoices enable row level security;
revoke all on public.invoices from anon, authenticated;
grant select on public.invoices to authenticated;
create policy invoices_select_member on public.invoices
  for select to authenticated using (app_private.is_member(wedding_id));

-- ---------------------------------------------------------------- payments name an invoice
alter table public.payments add column invoice_id uuid;
alter table public.payments
  add constraint payments_invoice_needs_booking_charge
  check (invoice_id is null or (commitment_id is not null and kind = 'charge'));
-- (invoice, booking) must be a real pair. Cascade: when an amendment moves an invoice to the new
-- commitment, the payments that name it move in the same statement and stay consistent.
alter table public.payments
  add constraint payments_invoice_fk
  foreign key (invoice_id, commitment_id) references public.invoices (id, commitment_id)
  on update cascade;
create index payments_invoice_idx on public.payments (invoice_id) where invoice_id is not null;

-- ---------------------------------------------------------------- create and void
-- Records an invoice a vendor sent. Nothing is paid and the contract is unchanged.
create function public.create_invoice(
  p_wedding uuid,
  p_commitment uuid,
  p_amount_minor bigint,
  p_number text default null,
  p_issued_on date default null,
  p_due_on date default null,
  p_note text default null,
  p_idempotency_key text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_number text := nullif(btrim(coalesce(p_number, '')), '');
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_hash text;
  v_prior uuid;
  v_id uuid;
  v_commitment public.commitments%rowtype;
begin
  v_wedding := app_private.lock_wedding_for_budget(p_wedding);
  if p_amount_minor is null or p_amount_minor not between 1 and 100000000
     or char_length(coalesce(v_number, 'x')) > 60
     or char_length(coalesce(v_note, 'x')) > 500
     or (p_issued_on is not null and p_issued_on not between date '2000-01-01' and date '2100-12-31')
     or (p_due_on is not null and p_due_on not between date '2000-01-01' and date '2100-12-31')
     or (p_issued_on is not null and p_due_on is not null and p_due_on < p_issued_on) then
    raise exception 'invalid invoice' using errcode = '22023';
  end if;
  if p_idempotency_key is not null then
    v_hash := md5(concat_ws('|', p_commitment::text, p_amount_minor::text, coalesce(v_number, ''),
      coalesce(p_issued_on::text, ''), coalesce(p_due_on::text, ''), coalesce(v_note, '')));
    v_prior := app_private.idem_claim(v_user, 'create_invoice:' || p_wedding::text, p_idempotency_key, v_hash);
    if v_prior is not null then
      return v_prior;
    end if;
  end if;

  select * into v_commitment from public.commitments
    where id = p_commitment and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_commitment.status <> 'active' then
    raise exception 'booking changed, reload' using errcode = '55000';
  end if;

  insert into public.invoices (wedding_id, commitment_id, number, amount_minor, issued_on, due_on, note, created_by)
    values (p_wedding, p_commitment, v_number, p_amount_minor, p_issued_on, p_due_on, v_note, v_user)
    returning id into v_id;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'invoice', v_id, 'ledger.invoice_created',
            jsonb_build_object('commitmentId', p_commitment), v_wedding.revision);
  if p_idempotency_key is not null then
    perform app_private.idem_done(v_user, 'create_invoice:' || p_wedding::text, p_idempotency_key, v_id);
  end if;
  return v_id;
end;
$$;

-- Marks an invoice as entered by mistake. It stays in the history. Payments that named it keep
-- existing as payments on the booking. Repeating is harmless.
create function public.void_invoice(p_wedding uuid, p_invoice uuid, p_reason text) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_inv public.invoices%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_detached integer;
begin
  v_wedding := app_private.lock_wedding_for_budget(p_wedding);
  if char_length(v_reason) not between 1 and 200 then
    raise exception 'invalid reason' using errcode = '22023';
  end if;
  select * into v_inv from public.invoices where id = p_invoice and wedding_id = p_wedding;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  -- Same lock order as record_payment (booking, then invoice), so the two cannot deadlock.
  perform 1 from public.commitments where id = v_inv.commitment_id for update;
  select * into v_inv from public.invoices where id = p_invoice for update;
  if v_inv.voided_at is not null then
    return;
  end if;
  update public.payments set invoice_id = null where invoice_id = p_invoice;
  get diagnostics v_detached = row_count;
  update public.invoices set voided_at = now(), void_reason = v_reason where id = p_invoice;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'invoice', p_invoice, 'ledger.invoice_voided',
            jsonb_build_object('paymentsDetached', v_detached), v_wedding.revision);
end;
$$;

-- ---------------------------------------------------------------- record_payment gains an invoice
-- Replaces the R1-07 function (a different argument list would be a second overload). Same rules,
-- plus: a payment may name an invoice of the same booking that is not void. Only charges can.
drop function public.record_payment(uuid, text, bigint, date, uuid, uuid, text, text, text, text);
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
  p_idempotency_key text default null,
  p_invoice uuid default null
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
     or (p_invoice is not null and (p_commitment is null or p_kind <> 'charge'))
     or char_length(coalesce(v_method, 'x')) > 60
     or char_length(coalesce(v_note, 'x')) > 500
     or char_length(coalesce(v_ref, 'x')) > 120 then
    raise exception 'invalid payment' using errcode = '22023';
  end if;
  if p_idempotency_key is not null then
    v_hash := md5(concat_ws('|', p_kind, p_amount_minor::text, p_paid_on::text, coalesce(p_commitment::text, ''),
      coalesce(p_item::text, ''), coalesce(v_method, ''), coalesce(v_note, ''), coalesce(v_ref, ''),
      coalesce(p_invoice::text, '')));
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
    if p_invoice is not null then
      perform 1 from public.invoices
        where id = p_invoice and wedding_id = p_wedding and commitment_id = p_commitment
          and voided_at is null
        for update;
      if not found then
        raise exception 'invoice not available' using errcode = '22023';
      end if;
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

  insert into public.payments (wedding_id, commitment_id, budget_item_id, invoice_id, kind, amount_minor,
                               paid_on, method_label, note, external_ref, created_by)
    values (p_wedding, p_commitment, p_item, p_invoice, p_kind, p_amount_minor, p_paid_on, v_method, v_note,
            v_ref, v_user)
    returning id into v_id;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'payment', v_id, 'ledger.payment_recorded',
            jsonb_build_object('kind', p_kind, 'target', case when p_commitment is null then 'item' else 'commitment' end,
                               'invoiced', p_invoice is not null),
            v_wedding.revision);
  if p_idempotency_key is not null then
    perform app_private.idem_done(v_user, 'record_payment:' || p_wedding::text, p_idempotency_key, v_id);
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------- amend_commitment moves invoices
-- Same as R1-07, plus: invoices (and the payments that name them) move to the new commitment.
create or replace function public.amend_commitment(
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
  v_invoices integer;
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
  -- Invoices first: the foreign key moves the payments that name them in the same statement.
  update public.invoices set commitment_id = v_id where commitment_id = p_commitment;
  get diagnostics v_invoices = row_count;
  update public.payments set commitment_id = v_id where commitment_id = p_commitment;
  get diagnostics v_moved = row_count;
  select count(*) into v_moved from public.payments where commitment_id = v_id;

  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'commitment', v_id, 'ledger.commitment_amended',
            jsonb_build_object('supersedes', p_commitment, 'paymentsMoved', v_moved,
                               'invoicesMoved', v_invoices,
                               'amountChanged', p_amount_minor is distinct from v_old.amount_minor),
            v_wedding.revision);
  if p_idempotency_key is not null then
    perform app_private.idem_done(v_user, 'amend_commitment:' || p_wedding::text, p_idempotency_key, v_id);
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------- grants
revoke all on function public.create_invoice(uuid, uuid, bigint, text, date, date, text, text) from public, anon;
revoke all on function public.void_invoice(uuid, uuid, text) from public, anon;
revoke all on function public.record_payment(uuid, text, bigint, date, uuid, uuid, text, text, text, text, uuid) from public, anon;
grant execute on function public.create_invoice(uuid, uuid, bigint, text, date, date, text, text) to authenticated;
grant execute on function public.void_invoice(uuid, uuid, text) to authenticated;
grant execute on function public.record_payment(uuid, text, bigint, date, uuid, uuid, text, text, text, text, uuid) to authenticated;
