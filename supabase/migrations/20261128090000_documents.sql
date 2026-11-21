-- R1-08 private documents: upload intent, metadata, validation state, links (ADR-020).
--
-- Rules (docs/10-SECURITY.md "Storage and exports"):
--  * Owner and partner only (contracts and receipts are budget-level data). Editors and viewers
--    can neither list rows nor read objects.
--  * Storage keys are random: '<wedding_id>/<document_id>'. The original file name is display
--    metadata only and never part of a path.
--  * Clients never write storage objects and never mark a file validated. A user-authorized RPC
--    records an upload intent (status 'pending'); only the server, using the service role after it
--    has validated the bytes itself, uploads the object and calls complete_document /
--    reject_document (granted to service_role only).
--  * No malware scanner is configured. A validated file is 'unscanned', never 'clean'. The app
--    blocks downloads of unscanned files unless an operator explicitly enables them for local use.
--  * Reads pass a short-lived signed URL that is itself checked against the storage policy below.

-- ---------------------------------------------------------------- tables
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  kind text not null check (kind in ('contract', 'receipt', 'invoice', 'proposal', 'other')),
  title text not null check (char_length(title) between 1 and 160),
  storage_key text not null unique,
  mime text not null check (mime in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  bytes bigint not null check (bytes between 1 and 10485760),
  checksum text check (checksum is null or checksum ~ '^[0-9a-f]{64}$'),
  original_name text check (original_name is null or char_length(original_name) between 1 and 200),
  scan_status text not null default 'pending'
    check (scan_status in ('pending', 'unscanned', 'clean', 'rejected')),
  reject_reason text check (reject_reason is null or char_length(reject_reason) between 1 and 200),
  uploaded_by uuid references auth.users (id) on delete set null,
  archived_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (wedding_id, id),
  check (storage_key = wedding_id::text || '/' || id::text),
  check ((scan_status = 'rejected') = (reject_reason is not null)),
  check (scan_status in ('pending', 'rejected') or checksum is not null)
);
create index documents_wedding_idx on public.documents (wedding_id, archived_at, created_at desc);
create trigger documents_touch before update on public.documents
  for each row execute function app_private.touch_updated_at();

-- Composite tenant FKs from links need a (wedding_id, id) key on payments.
alter table public.payments add constraint payments_wedding_id_id_key unique (wedding_id, id);

-- Concrete foreign keys (docs/06): exactly one target per link, tenant-checked by composite FKs.
create table public.document_links (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null,
  document_id uuid not null,
  commitment_id uuid,
  payment_id uuid,
  candidate_id uuid,
  proposal_id uuid,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  check (num_nonnulls(commitment_id, payment_id, candidate_id, proposal_id) = 1),
  foreign key (wedding_id, document_id) references public.documents (wedding_id, id) on delete cascade,
  foreign key (wedding_id, commitment_id) references public.commitments (wedding_id, id),
  foreign key (wedding_id, payment_id) references public.payments (wedding_id, id),
  foreign key (wedding_id, candidate_id) references public.candidates (wedding_id, id),
  foreign key (wedding_id, proposal_id) references public.proposals (wedding_id, id)
);
create unique index document_links_commitment_uq on public.document_links (document_id, commitment_id) where commitment_id is not null;
create unique index document_links_payment_uq on public.document_links (document_id, payment_id) where payment_id is not null;
create unique index document_links_candidate_uq on public.document_links (document_id, candidate_id) where candidate_id is not null;
create unique index document_links_proposal_uq on public.document_links (document_id, proposal_id) where proposal_id is not null;
create index document_links_document_idx on public.document_links (document_id);

alter table public.documents enable row level security;
alter table public.document_links enable row level security;
revoke all on public.documents, public.document_links from anon, authenticated;
grant select on public.documents, public.document_links to authenticated;
create policy documents_select_managers on public.documents
  for select to authenticated using (app_private.can_manage_budget(wedding_id));
create policy document_links_select_managers on public.document_links
  for select to authenticated using (app_private.can_manage_budget(wedding_id));

-- ---------------------------------------------------------------- storage access
-- The bucket is private. Objects are readable only by owner/partner, only when the matching
-- document row exists, is not rejected or still pending, and is not archived.
-- Tightens the R0-03 policy (any member could read anything under the wedding prefix).

create function app_private.can_read_document_object(p_name text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.documents d
    where d.storage_key = p_name
      and d.archived_at is null
      and d.scan_status in ('unscanned', 'clean')
      and app_private.can_manage_budget(d.wedding_id)
  );
$$;
revoke all on function app_private.can_read_document_object(text) from public, anon;
grant execute on function app_private.can_read_document_object(text) to authenticated;

drop policy wedding_documents_select_member on storage.objects;
create policy wedding_documents_select_available on storage.objects
  for select to authenticated
  using (bucket_id = 'wedding-documents' and app_private.can_read_document_object(name));

-- Defense in depth beside the application checks: same size cap and an allowlist of types.
update storage.buckets
  set file_size_limit = 10485760,
      allowed_mime_types = array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
  where id = 'wedding-documents';

-- ---------------------------------------------------------------- RPCs
-- Records that an upload is about to happen. Nothing is readable until the server completes it.
create function public.create_document_intent(
  p_wedding uuid,
  p_kind text,
  p_title text,
  p_mime text,
  p_bytes bigint,
  p_original_name text default null,
  p_idempotency_key text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_title text := btrim(coalesce(p_title, ''));
  v_name text := nullif(btrim(coalesce(p_original_name, '')), '');
  v_hash text;
  v_prior uuid;
  v_id uuid := gen_random_uuid();
begin
  v_wedding := app_private.lock_wedding_for_budget(p_wedding);
  if p_kind is null or p_kind not in ('contract', 'receipt', 'invoice', 'proposal', 'other')
     or char_length(v_title) not between 1 and 160
     or p_mime is null or p_mime not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
     or p_bytes is null or p_bytes not between 1 and 10485760
     or char_length(coalesce(v_name, 'x')) > 200 then
    raise exception 'invalid document' using errcode = '22023';
  end if;
  if p_idempotency_key is not null then
    v_hash := md5(concat_ws('|', p_kind, v_title, p_mime, p_bytes::text, coalesce(v_name, '')));
    v_prior := app_private.idem_claim(v_user, 'create_document_intent:' || p_wedding::text, p_idempotency_key, v_hash);
    if v_prior is not null then
      return v_prior;
    end if;
  end if;
  -- Bounded abuse surface: a few in-flight uploads, a generous cap on stored documents.
  if (select count(*) from public.documents
        where wedding_id = p_wedding and scan_status = 'pending' and created_at > now() - interval '1 hour') >= 10
     or (select count(*) from public.documents
           where wedding_id = p_wedding and archived_at is null and scan_status <> 'rejected') >= 500 then
    raise exception 'too many documents' using errcode = '54000';
  end if;
  insert into public.documents (id, wedding_id, kind, title, storage_key, mime, bytes, original_name, uploaded_by)
    values (v_id, p_wedding, p_kind, v_title, p_wedding::text || '/' || v_id::text, p_mime, p_bytes, v_name, v_user);
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'document', v_id, 'document.upload_started',
            jsonb_build_object('kind', p_kind, 'mime', p_mime), v_wedding.revision);
  if p_idempotency_key is not null then
    perform app_private.idem_done(v_user, 'create_document_intent:' || p_wedding::text, p_idempotency_key, v_id);
  end if;
  return v_id;
end;
$$;

-- Server only (service role). The server has validated type, signature and size and uploaded the
-- object; this confirms the object exists with the declared size, then marks it 'unscanned'.
create function public.complete_document(p_document uuid, p_checksum text, p_bytes bigint) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents%rowtype;
  v_size bigint;
begin
  select * into v_doc from public.documents where id = p_document for update;
  if not found or v_doc.scan_status <> 'pending' then
    raise exception 'document not pending' using errcode = '55000';
  end if;
  if p_checksum is null or p_checksum !~ '^[0-9a-f]{64}$' or p_bytes is distinct from v_doc.bytes then
    raise exception 'invalid document' using errcode = '22023';
  end if;
  select (o.metadata ->> 'size')::bigint into v_size from storage.objects o
    where o.bucket_id = 'wedding-documents' and o.name = v_doc.storage_key;
  if v_size is null or v_size <> p_bytes then
    raise exception 'object missing or wrong size' using errcode = '22023';
  end if;
  update public.documents set scan_status = 'unscanned', checksum = p_checksum, version = version + 1
    where id = p_document;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    select v_doc.wedding_id, v_doc.uploaded_by, 'document', v_doc.id, 'document.uploaded',
           jsonb_build_object('scan_status', 'unscanned'), w.revision
    from public.weddings w where w.id = v_doc.wedding_id;
end;
$$;

-- Server only (service role). The file failed validation or the object could not be stored.
create function public.reject_document(p_document uuid, p_reason text) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents%rowtype;
  v_reason text := left(btrim(coalesce(p_reason, '')), 200);
begin
  select * into v_doc from public.documents where id = p_document for update;
  if not found or v_doc.scan_status <> 'pending' then
    raise exception 'document not pending' using errcode = '55000';
  end if;
  if v_reason = '' then
    raise exception 'invalid document' using errcode = '22023';
  end if;
  update public.documents set scan_status = 'rejected', reject_reason = v_reason, version = version + 1
    where id = p_document;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    select v_doc.wedding_id, v_doc.uploaded_by, 'document', v_doc.id, 'document.rejected',
           '{}'::jsonb, w.revision
    from public.weddings w where w.id = v_doc.wedding_id;
end;
$$;

create function public.update_document(
  p_wedding uuid,
  p_document uuid,
  p_expected_version integer,
  p_title text,
  p_kind text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_title text := btrim(coalesce(p_title, ''));
  v_doc public.documents%rowtype;
begin
  v_wedding := app_private.lock_wedding_for_budget(p_wedding);
  if char_length(v_title) not between 1 and 160
     or p_kind is null or p_kind not in ('contract', 'receipt', 'invoice', 'proposal', 'other') then
    raise exception 'invalid document' using errcode = '22023';
  end if;
  select * into v_doc from public.documents where id = p_document and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_doc.version <> p_expected_version or v_doc.archived_at is not null
     or v_doc.scan_status not in ('unscanned', 'clean') then
    raise exception 'document changed, reload' using errcode = '55000';
  end if;
  if v_doc.title = v_title and v_doc.kind = p_kind then
    return;
  end if;
  update public.documents set title = v_title, kind = p_kind, version = version + 1 where id = p_document;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'document', p_document, 'document.updated',
            jsonb_build_object('fields', to_jsonb(array_remove(array[
              case when v_doc.title <> v_title then 'title' end,
              case when v_doc.kind <> p_kind then 'kind' end], null))), v_wedding.revision);
end;
$$;

-- Archived documents stay stored and linked as history but can no longer be downloaded.
create function public.archive_document(p_wedding uuid, p_document uuid, p_expected_version integer) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_doc public.documents%rowtype;
begin
  v_wedding := app_private.lock_wedding_for_budget(p_wedding);
  select * into v_doc from public.documents where id = p_document and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_doc.archived_at is not null then
    return;
  end if;
  if v_doc.version <> p_expected_version or v_doc.scan_status not in ('unscanned', 'clean') then
    raise exception 'document changed, reload' using errcode = '55000';
  end if;
  update public.documents set archived_at = now(), version = version + 1 where id = p_document;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'document', p_document, 'document.archived', '{}'::jsonb, v_wedding.revision);
end;
$$;

-- p_target_type: 'commitment' | 'payment' | 'candidate' | 'proposal'. Repeating is harmless.
create function public.link_document(p_wedding uuid, p_document uuid, p_target_type text, p_target uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_doc public.documents%rowtype;
  v_inserted integer;
  v_ok boolean;
begin
  v_wedding := app_private.lock_wedding_for_budget(p_wedding);
  if p_target_type is null or p_target_type not in ('commitment', 'payment', 'candidate', 'proposal') or p_target is null then
    raise exception 'invalid link' using errcode = '22023';
  end if;
  select * into v_doc from public.documents where id = p_document and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_doc.archived_at is not null or v_doc.scan_status not in ('unscanned', 'clean') then
    raise exception 'document changed, reload' using errcode = '55000';
  end if;
  -- The target must exist in this wedding (composite FKs enforce it again at insert).
  if p_target_type = 'commitment' then
    v_ok := exists (select 1 from public.commitments where id = p_target and wedding_id = p_wedding);
  elsif p_target_type = 'payment' then
    v_ok := exists (select 1 from public.payments where id = p_target and wedding_id = p_wedding);
  elsif p_target_type = 'candidate' then
    v_ok := exists (select 1 from public.candidates where id = p_target and wedding_id = p_wedding);
  else
    v_ok := exists (select 1 from public.proposals where id = p_target and wedding_id = p_wedding);
  end if;
  if not v_ok then
    raise exception 'link target not available' using errcode = '22023';
  end if;
  insert into public.document_links (wedding_id, document_id, commitment_id, payment_id, candidate_id, proposal_id, created_by)
    values (p_wedding, p_document,
            case when p_target_type = 'commitment' then p_target end,
            case when p_target_type = 'payment' then p_target end,
            case when p_target_type = 'candidate' then p_target end,
            case when p_target_type = 'proposal' then p_target end,
            v_user)
    on conflict do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted > 0 then
    insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
      values (p_wedding, v_user, 'document', p_document, 'document.linked',
              jsonb_build_object('target', p_target_type), v_wedding.revision);
  end if;
end;
$$;

create function public.unlink_document(p_wedding uuid, p_document uuid, p_target_type text, p_target uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_deleted integer;
begin
  v_wedding := app_private.lock_wedding_for_budget(p_wedding);
  if p_target_type is null or p_target_type not in ('commitment', 'payment', 'candidate', 'proposal') or p_target is null then
    raise exception 'invalid link' using errcode = '22023';
  end if;
  delete from public.document_links
    where wedding_id = p_wedding and document_id = p_document
      and ((p_target_type = 'commitment' and commitment_id = p_target)
        or (p_target_type = 'payment' and payment_id = p_target)
        or (p_target_type = 'candidate' and candidate_id = p_target)
        or (p_target_type = 'proposal' and proposal_id = p_target));
  get diagnostics v_deleted = row_count;
  if v_deleted > 0 then
    insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
      values (p_wedding, v_user, 'document', p_document, 'document.unlinked',
              jsonb_build_object('target', p_target_type), v_wedding.revision);
  end if;
end;
$$;

revoke all on function public.create_document_intent(uuid, text, text, text, bigint, text, text) from public, anon;
revoke all on function public.complete_document(uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.reject_document(uuid, text) from public, anon, authenticated;
revoke all on function public.update_document(uuid, uuid, integer, text, text) from public, anon;
revoke all on function public.archive_document(uuid, uuid, integer) from public, anon;
revoke all on function public.link_document(uuid, uuid, text, uuid) from public, anon;
revoke all on function public.unlink_document(uuid, uuid, text, uuid) from public, anon;
grant execute on function public.create_document_intent(uuid, text, text, text, bigint, text, text) to authenticated;
grant execute on function public.complete_document(uuid, text, bigint) to service_role;
grant execute on function public.reject_document(uuid, text) to service_role;
grant execute on function public.update_document(uuid, uuid, integer, text, text) to authenticated;
grant execute on function public.archive_document(uuid, uuid, integer) to authenticated;
grant execute on function public.link_document(uuid, uuid, text, uuid) to authenticated;
grant execute on function public.unlink_document(uuid, uuid, text, uuid) to authenticated;
