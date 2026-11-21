-- R1-13 design board (docs/06 boards / board_items, docs/01 P10).
--
-- Rules:
--  * Any member can read boards and view images; owner and partner write (plan.edit). Clients have
--    SELECT only; every write is an RPC with a version check and an audit event.
--  * An item is an uploaded image, a saved link or a note. Links are stored text only. Nothing in
--    this system fetches, previews or resolves a saved URL (no SSRF surface).
--  * Image bytes live in a separate private bucket 'wedding-design'. Same pipeline as documents
--    (ADR-020): an RPC records an intent, the server validates the bytes and stores them with the
--    service role, then completes the item. Clients never write storage. Every image carries a
--    rights statement chosen by the uploader. Images are private to members: nothing here is
--    published (guest website images need a separate publication and rights approval, R1-14).
--  * No malware scanner is configured; images are never described as scanned.

create function app_private.valid_palette(p text[]) returns boolean
language sql immutable
set search_path = ''
as $$
  select p is not null
    and coalesce(cardinality(p), 0) <= 8
    and not exists (select 1 from unnest(p) c where c is null or c !~ '^#[0-9a-f]{6}$')
    and (select count(*) = count(distinct c) from unnest(p) c);
$$;

create table public.design_boards (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120 and title = btrim(title)),
  description text check (description is null or char_length(description) between 1 and 1000),
  palette text[] not null default '{}' check (app_private.valid_palette(palette)),
  archived_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (wedding_id, id)
);
create index design_boards_wedding_idx on public.design_boards (wedding_id, archived_at, created_at);
create trigger design_boards_touch before update on public.design_boards
  for each row execute function app_private.touch_updated_at();

create table public.design_items (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null,
  board_id uuid not null,
  kind text not null check (kind in ('image', 'link', 'note')),
  title text not null check (char_length(title) between 1 and 160 and title = btrim(title)),
  note text check (note is null or char_length(note) between 1 and 1000),
  url text check (url is null or (char_length(url) <= 2048 and url ~ '^https?://[^[:space:]@]+$')),
  candidate_id uuid,
  favorite boolean not null default false,
  position integer not null check (position >= 0),
  -- image-only fields
  status text not null default 'ready' check (status in ('pending', 'ready', 'rejected')),
  rights text check (rights is null or rights in ('own', 'permission', 'reference')),
  storage_key text unique,
  mime text check (mime is null or mime in ('image/jpeg', 'image/png', 'image/webp')),
  bytes bigint check (bytes is null or bytes between 1 and 5242880),
  checksum text check (checksum is null or checksum ~ '^[0-9a-f]{64}$'),
  original_name text check (original_name is null or char_length(original_name) between 1 and 200),
  reject_reason text check (reject_reason is null or char_length(reject_reason) between 1 and 200),
  created_by uuid references auth.users (id) on delete set null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (wedding_id, board_id) references public.design_boards (wedding_id, id) on delete cascade,
  foreign key (wedding_id, candidate_id) references public.candidates (wedding_id, id),
  check (storage_key is null or storage_key = wedding_id::text || '/' || id::text),
  check ((kind = 'link') = (url is not null)),
  check (kind = 'image' or (status = 'ready' and rights is null and storage_key is null
                            and mime is null and bytes is null and checksum is null
                            and original_name is null and reject_reason is null)),
  check (kind <> 'image' or (rights is not null and storage_key is not null
                             and mime is not null and bytes is not null)),
  check ((status = 'rejected') = (reject_reason is not null)),
  check (status <> 'ready' or kind <> 'image' or checksum is not null)
);
create index design_items_board_idx on public.design_items (board_id, position, created_at);
create index design_items_wedding_idx on public.design_items (wedding_id);
create trigger design_items_touch before update on public.design_items
  for each row execute function app_private.touch_updated_at();

alter table public.design_boards enable row level security;
alter table public.design_items enable row level security;
revoke all on public.design_boards, public.design_items from anon, authenticated;
grant select on public.design_boards, public.design_items to authenticated;
create policy design_boards_select_member on public.design_boards
  for select to authenticated using (app_private.is_member(wedding_id));
-- Pending and rejected uploads were never items from the reader's point of view.
create policy design_items_select_member on public.design_items
  for select to authenticated using (app_private.is_member(wedding_id) and status = 'ready');

-- ---------------------------------------------------------------- storage
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('wedding-design', 'wedding-design', false, 5242880,
          array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do nothing;

create function app_private.can_read_design_object(p_name text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.design_items i
    join public.design_boards b on b.wedding_id = i.wedding_id and b.id = i.board_id
    where i.storage_key = p_name
      and i.kind = 'image'
      and i.status = 'ready'
      and b.archived_at is null
      and app_private.is_member(i.wedding_id)
  );
$$;
revoke all on function app_private.can_read_design_object(text) from public, anon;
grant execute on function app_private.can_read_design_object(text) to authenticated;

create policy wedding_design_select_available on storage.objects
  for select to authenticated
  using (bucket_id = 'wedding-design' and app_private.can_read_design_object(name));

-- ---------------------------------------------------------------- RPCs: boards
create function public.create_design_board(
  p_wedding uuid,
  p_title text,
  p_description text default null,
  p_palette text[] default '{}',
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
  v_desc text := nullif(btrim(coalesce(p_description, '')), '');
  v_palette text[] := coalesce(p_palette, '{}');
  v_hash text;
  v_prior uuid;
  v_id uuid;
begin
  v_wedding := app_private.lock_wedding_for_plan(p_wedding);
  if char_length(v_title) not between 1 and 120
     or char_length(coalesce(v_desc, 'x')) > 1000
     or not app_private.valid_palette(v_palette) then
    raise exception 'invalid board' using errcode = '22023';
  end if;
  if p_idempotency_key is not null then
    v_hash := md5(concat_ws('|', v_title, coalesce(v_desc, ''), array_to_string(v_palette, ',')));
    v_prior := app_private.idem_claim(v_user, 'create_design_board:' || p_wedding::text, p_idempotency_key, v_hash);
    if v_prior is not null then
      return v_prior;
    end if;
  end if;
  if (select count(*) from public.design_boards where wedding_id = p_wedding and archived_at is null) >= 50 then
    raise exception 'too many boards' using errcode = '54000';
  end if;
  insert into public.design_boards (wedding_id, title, description, palette, created_by)
    values (p_wedding, v_title, v_desc, v_palette, v_user)
    returning id into v_id;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'design_board', v_id, 'design_board.created', '{}'::jsonb, v_wedding.revision);
  if p_idempotency_key is not null then
    perform app_private.idem_done(v_user, 'create_design_board:' || p_wedding::text, p_idempotency_key, v_id);
  end if;
  return v_id;
end;
$$;

create function public.update_design_board(
  p_wedding uuid,
  p_board uuid,
  p_expected_version integer,
  p_title text,
  p_description text default null,
  p_palette text[] default '{}'
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_title text := btrim(coalesce(p_title, ''));
  v_desc text := nullif(btrim(coalesce(p_description, '')), '');
  v_palette text[] := coalesce(p_palette, '{}');
  v_old public.design_boards%rowtype;
  v_version integer;
begin
  v_wedding := app_private.lock_wedding_for_plan(p_wedding);
  select * into v_old from public.design_boards where id = p_board and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_old.version <> p_expected_version or v_old.archived_at is not null then
    raise exception 'board changed, reload' using errcode = '55000';
  end if;
  if char_length(v_title) not between 1 and 120
     or char_length(coalesce(v_desc, 'x')) > 1000
     or not app_private.valid_palette(v_palette) then
    raise exception 'invalid board' using errcode = '22023';
  end if;
  if v_title = v_old.title and v_desc is not distinct from v_old.description and v_palette = v_old.palette then
    return v_old.version;
  end if;
  update public.design_boards
    set title = v_title, description = v_desc, palette = v_palette, version = version + 1
    where id = p_board returning version into v_version;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'design_board', p_board, 'design_board.updated',
            jsonb_build_object('fields', to_jsonb(array_remove(array[
              case when v_old.title <> v_title then 'title' end,
              case when v_old.description is distinct from v_desc then 'description' end,
              case when v_old.palette <> v_palette then 'palette' end], null))), v_wedding.revision);
  return v_version;
end;
$$;

-- Archiving hides the board and its images. Rows and objects remain until the owner removes items.
create function public.archive_design_board(p_wedding uuid, p_board uuid, p_expected_version integer) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.design_boards%rowtype;
begin
  v_wedding := app_private.lock_wedding_for_plan(p_wedding);
  select * into v_old from public.design_boards where id = p_board and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_old.archived_at is not null then
    return;
  end if;
  if v_old.version <> p_expected_version then
    raise exception 'board changed, reload' using errcode = '55000';
  end if;
  update public.design_boards set archived_at = now(), version = version + 1 where id = p_board;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'design_board', p_board, 'design_board.archived', '{}'::jsonb, v_wedding.revision);
end;
$$;

-- ---------------------------------------------------------------- RPCs: items
-- Shared checks: board is active and has room; candidate belongs to the wedding.
create function app_private.design_board_for_add(p_wedding uuid, p_board uuid, p_candidate uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.design_boards
    where id = p_board and wedding_id = p_wedding and archived_at is null for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_candidate is not null
     and not exists (select 1 from public.candidates where id = p_candidate and wedding_id = p_wedding) then
    raise exception 'invalid item' using errcode = '22023';
  end if;
  if (select count(*) from public.design_items
        where board_id = p_board and (status = 'ready' or created_at > now() - interval '1 hour')) >= 200 then
    raise exception 'too many items' using errcode = '54000';
  end if;
end;
$$;
revoke all on function app_private.design_board_for_add(uuid, uuid, uuid) from public, anon, authenticated;

-- A saved link or a note. The URL is validated by the app and the table; it is never fetched.
create function public.add_design_item(
  p_wedding uuid,
  p_board uuid,
  p_kind text,
  p_title text,
  p_note text default null,
  p_url text default null,
  p_candidate uuid default null,
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
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_url text := nullif(btrim(coalesce(p_url, '')), '');
  v_hash text;
  v_prior uuid;
  v_id uuid;
begin
  v_wedding := app_private.lock_wedding_for_plan(p_wedding);
  if p_kind is null or p_kind not in ('link', 'note')
     or char_length(v_title) not between 1 and 160
     or char_length(coalesce(v_note, 'x')) > 1000
     or (p_kind = 'link' and (v_url is null or char_length(v_url) > 2048 or v_url !~ '^https?://[^[:space:]@]+$'))
     or (p_kind = 'note' and v_url is not null) then
    raise exception 'invalid item' using errcode = '22023';
  end if;
  if p_idempotency_key is not null then
    v_hash := md5(concat_ws('|', p_board::text, p_kind, v_title, coalesce(v_note, ''), coalesce(v_url, ''),
                            coalesce(p_candidate::text, '')));
    v_prior := app_private.idem_claim(v_user, 'add_design_item:' || p_wedding::text, p_idempotency_key, v_hash);
    if v_prior is not null then
      return v_prior;
    end if;
  end if;
  perform app_private.design_board_for_add(p_wedding, p_board, p_candidate);
  insert into public.design_items (wedding_id, board_id, kind, title, note, url, candidate_id, position, created_by)
    values (p_wedding, p_board, p_kind, v_title, v_note, v_url, p_candidate,
            coalesce((select max(position) + 1 from public.design_items where board_id = p_board), 0), v_user)
    returning id into v_id;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'design_item', v_id, 'design_item.added',
            jsonb_build_object('kind', p_kind), v_wedding.revision);
  if p_idempotency_key is not null then
    perform app_private.idem_done(v_user, 'add_design_item:' || p_wedding::text, p_idempotency_key, v_id);
  end if;
  return v_id;
end;
$$;

-- Records that an image upload is about to happen. Not readable until the server completes it.
create function public.create_design_image_intent(
  p_wedding uuid,
  p_board uuid,
  p_title text,
  p_rights text,
  p_mime text,
  p_bytes bigint,
  p_note text default null,
  p_original_name text default null,
  p_candidate uuid default null,
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
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_name text := nullif(btrim(coalesce(p_original_name, '')), '');
  v_hash text;
  v_prior uuid;
  v_id uuid := gen_random_uuid();
begin
  v_wedding := app_private.lock_wedding_for_plan(p_wedding);
  if char_length(v_title) not between 1 and 160
     or char_length(coalesce(v_note, 'x')) > 1000
     or char_length(coalesce(v_name, 'x')) > 200
     or p_rights is null or p_rights not in ('own', 'permission', 'reference')
     or p_mime is null or p_mime not in ('image/jpeg', 'image/png', 'image/webp')
     or p_bytes is null or p_bytes not between 1 and 5242880 then
    raise exception 'invalid item' using errcode = '22023';
  end if;
  if p_idempotency_key is not null then
    v_hash := md5(concat_ws('|', p_board::text, v_title, coalesce(v_note, ''), p_rights, p_mime, p_bytes::text,
                            coalesce(v_name, ''), coalesce(p_candidate::text, '')));
    v_prior := app_private.idem_claim(v_user, 'create_design_image_intent:' || p_wedding::text, p_idempotency_key, v_hash);
    if v_prior is not null then
      return v_prior;
    end if;
  end if;
  perform app_private.design_board_for_add(p_wedding, p_board, p_candidate);
  if (select count(*) from public.design_items
        where wedding_id = p_wedding and status = 'pending' and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'too many items' using errcode = '54000';
  end if;
  insert into public.design_items (id, wedding_id, board_id, kind, title, note, candidate_id, position, status,
                                   rights, storage_key, mime, bytes, original_name, created_by)
    values (v_id, p_wedding, p_board, 'image', v_title, v_note, p_candidate,
            coalesce((select max(position) + 1 from public.design_items where board_id = p_board), 0),
            'pending', p_rights, p_wedding::text || '/' || v_id::text, p_mime, p_bytes, v_name, v_user);
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'design_item', v_id, 'design_item.upload_started',
            jsonb_build_object('rights', p_rights), v_wedding.revision);
  if p_idempotency_key is not null then
    perform app_private.idem_done(v_user, 'create_design_image_intent:' || p_wedding::text, p_idempotency_key, v_id);
  end if;
  return v_id;
end;
$$;

-- Server only (service role): the bytes were validated and stored; confirm and mark ready.
create function public.complete_design_image(p_item uuid, p_checksum text, p_bytes bigint) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.design_items%rowtype;
  v_size bigint;
begin
  select * into v_item from public.design_items where id = p_item for update;
  if not found or v_item.status <> 'pending' then
    raise exception 'item not pending' using errcode = '55000';
  end if;
  if p_checksum is null or p_checksum !~ '^[0-9a-f]{64}$' or p_bytes is distinct from v_item.bytes then
    raise exception 'invalid item' using errcode = '22023';
  end if;
  select (o.metadata ->> 'size')::bigint into v_size from storage.objects o
    where o.bucket_id = 'wedding-design' and o.name = v_item.storage_key;
  if v_size is null or v_size <> p_bytes then
    raise exception 'object missing or wrong size' using errcode = '22023';
  end if;
  update public.design_items set status = 'ready', checksum = p_checksum, version = version + 1
    where id = p_item;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    select v_item.wedding_id, v_item.created_by, 'design_item', v_item.id, 'design_item.uploaded',
           '{}'::jsonb, w.revision
    from public.weddings w where w.id = v_item.wedding_id;
end;
$$;

create function public.reject_design_image(p_item uuid, p_reason text) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.design_items%rowtype;
  v_reason text := left(btrim(coalesce(p_reason, '')), 200);
begin
  select * into v_item from public.design_items where id = p_item for update;
  if not found or v_item.status <> 'pending' then
    raise exception 'item not pending' using errcode = '55000';
  end if;
  if v_reason = '' then
    raise exception 'invalid item' using errcode = '22023';
  end if;
  update public.design_items set status = 'rejected', reject_reason = v_reason, version = version + 1
    where id = p_item;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    select v_item.wedding_id, v_item.created_by, 'design_item', v_item.id, 'design_item.rejected',
           '{}'::jsonb, w.revision
    from public.weddings w where w.id = v_item.wedding_id;
end;
$$;

-- p_rights applies to images only and must be null for links and notes. p_url applies to links only.
create function public.update_design_item(
  p_wedding uuid,
  p_item uuid,
  p_expected_version integer,
  p_title text,
  p_note text default null,
  p_url text default null,
  p_candidate uuid default null,
  p_rights text default null
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.design_items%rowtype;
  v_title text := btrim(coalesce(p_title, ''));
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_url text := nullif(btrim(coalesce(p_url, '')), '');
  v_version integer;
begin
  v_wedding := app_private.lock_wedding_for_plan(p_wedding);
  select * into v_old from public.design_items
    where id = p_item and wedding_id = p_wedding and status = 'ready' for update;
  if not found or not exists (select 1 from public.design_boards
                               where id = v_old.board_id and wedding_id = p_wedding and archived_at is null) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_old.version <> p_expected_version then
    raise exception 'item changed, reload' using errcode = '55000';
  end if;
  if char_length(v_title) not between 1 and 160
     or char_length(coalesce(v_note, 'x')) > 1000
     or (v_old.kind = 'link' and (v_url is null or char_length(v_url) > 2048 or v_url !~ '^https?://[^[:space:]@]+$'))
     or (v_old.kind <> 'link' and v_url is not null)
     or (v_old.kind = 'image' and (p_rights is null or p_rights not in ('own', 'permission', 'reference')))
     or (v_old.kind <> 'image' and p_rights is not null)
     or (p_candidate is not null
         and not exists (select 1 from public.candidates where id = p_candidate and wedding_id = p_wedding)) then
    raise exception 'invalid item' using errcode = '22023';
  end if;
  if v_title = v_old.title and v_note is not distinct from v_old.note and v_url is not distinct from v_old.url
     and p_candidate is not distinct from v_old.candidate_id and p_rights is not distinct from v_old.rights then
    return v_old.version;
  end if;
  update public.design_items
    set title = v_title, note = v_note, url = v_url, candidate_id = p_candidate, rights = p_rights,
        version = version + 1
    where id = p_item returning version into v_version;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'design_item', p_item, 'design_item.updated',
            jsonb_build_object('fields', to_jsonb(array_remove(array[
              case when v_old.title <> v_title then 'title' end,
              case when v_old.note is distinct from v_note then 'note' end,
              case when v_old.url is distinct from v_url then 'url' end,
              case when v_old.candidate_id is distinct from p_candidate then 'candidate' end,
              case when v_old.rights is distinct from p_rights then 'rights' end], null))), v_wedding.revision);
  return v_version;
end;
$$;

create function public.set_design_favorite(p_wedding uuid, p_item uuid, p_expected_version integer, p_favorite boolean)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.design_items%rowtype;
  v_version integer;
begin
  v_wedding := app_private.lock_wedding_for_plan(p_wedding);
  if p_favorite is null then
    raise exception 'invalid item' using errcode = '22023';
  end if;
  select * into v_old from public.design_items
    where id = p_item and wedding_id = p_wedding and status = 'ready' for update;
  if not found or not exists (select 1 from public.design_boards
                               where id = v_old.board_id and wedding_id = p_wedding and archived_at is null) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_old.version <> p_expected_version then
    raise exception 'item changed, reload' using errcode = '55000';
  end if;
  if v_old.favorite = p_favorite then
    return v_old.version;
  end if;
  update public.design_items set favorite = p_favorite, version = version + 1
    where id = p_item returning version into v_version;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'design_item', p_item, 'design_item.updated',
            jsonb_build_object('fields', to_jsonb(array['favorite'])), v_wedding.revision);
  return v_version;
end;
$$;

-- Keyboard- and touch-friendly reordering: swap with the neighbour in the given direction.
create function public.move_design_item(p_wedding uuid, p_item uuid, p_direction text) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_item public.design_items%rowtype;
  v_other public.design_items%rowtype;
begin
  v_wedding := app_private.lock_wedding_for_plan(p_wedding);
  if p_direction is null or p_direction not in ('earlier', 'later') then
    raise exception 'invalid item' using errcode = '22023';
  end if;
  select * into v_item from public.design_items
    where id = p_item and wedding_id = p_wedding and status = 'ready';
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  -- Serialize reordering within the board.
  perform 1 from public.design_boards
    where id = v_item.board_id and wedding_id = p_wedding and archived_at is null for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  select * into v_item from public.design_items where id = p_item for update;
  if p_direction = 'earlier' then
    select * into v_other from public.design_items
      where board_id = v_item.board_id and status = 'ready'
        and (position, created_at, id) < (v_item.position, v_item.created_at, v_item.id)
      order by position desc, created_at desc, id desc limit 1 for update;
  else
    select * into v_other from public.design_items
      where board_id = v_item.board_id and status = 'ready'
        and (position, created_at, id) > (v_item.position, v_item.created_at, v_item.id)
      order by position, created_at, id limit 1 for update;
  end if;
  if not found then
    return;
  end if;
  if v_other.position = v_item.position then
    -- Equal positions cannot occur through the RPCs, but keep the swap meaningful if they do.
    update public.design_items set position = position + 1
      where id = case when p_direction = 'earlier' then v_item.id else v_other.id end;
  else
    update public.design_items set position = v_other.position where id = v_item.id;
    update public.design_items set position = v_item.position where id = v_other.id;
  end if;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'design_item', p_item, 'design_item.moved', '{}'::jsonb, v_wedding.revision);
end;
$$;

-- Deletes the row (which also makes the image unreadable at once). The app then removes the
-- object with the service role; an orphaned object is unreachable but not yet cleaned up.
-- Returns the storage key to remove, or null.
create function public.remove_design_item(p_wedding uuid, p_item uuid, p_expected_version integer) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.design_items%rowtype;
begin
  v_wedding := app_private.lock_wedding_for_plan(p_wedding);
  select * into v_old from public.design_items
    where id = p_item and wedding_id = p_wedding and status = 'ready' for update;
  if not found then
    return null;
  end if;
  if v_old.version <> p_expected_version then
    raise exception 'item changed, reload' using errcode = '55000';
  end if;
  delete from public.design_items where id = p_item;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'design_item', p_item, 'design_item.removed',
            jsonb_build_object('kind', v_old.kind), v_wedding.revision);
  return v_old.storage_key;
end;
$$;

revoke all on function public.create_design_board(uuid, text, text, text[], text) from public, anon;
revoke all on function public.update_design_board(uuid, uuid, integer, text, text, text[]) from public, anon;
revoke all on function public.archive_design_board(uuid, uuid, integer) from public, anon;
revoke all on function public.add_design_item(uuid, uuid, text, text, text, text, uuid, text) from public, anon;
revoke all on function public.create_design_image_intent(uuid, uuid, text, text, text, bigint, text, text, uuid, text) from public, anon;
revoke all on function public.complete_design_image(uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.reject_design_image(uuid, text) from public, anon, authenticated;
revoke all on function public.update_design_item(uuid, uuid, integer, text, text, text, uuid, text) from public, anon;
revoke all on function public.set_design_favorite(uuid, uuid, integer, boolean) from public, anon;
revoke all on function public.move_design_item(uuid, uuid, text) from public, anon;
revoke all on function public.remove_design_item(uuid, uuid, integer) from public, anon;
grant execute on function public.create_design_board(uuid, text, text, text[], text) to authenticated;
grant execute on function public.update_design_board(uuid, uuid, integer, text, text, text[]) to authenticated;
grant execute on function public.archive_design_board(uuid, uuid, integer) to authenticated;
grant execute on function public.add_design_item(uuid, uuid, text, text, text, text, uuid, text) to authenticated;
grant execute on function public.create_design_image_intent(uuid, uuid, text, text, text, bigint, text, text, uuid, text) to authenticated;
grant execute on function public.complete_design_image(uuid, text, bigint) to service_role;
grant execute on function public.reject_design_image(uuid, text) to service_role;
grant execute on function public.update_design_item(uuid, uuid, integer, text, text, text, uuid, text) to authenticated;
grant execute on function public.set_design_favorite(uuid, uuid, integer, boolean) to authenticated;
grant execute on function public.move_design_item(uuid, uuid, text) to authenticated;
grant execute on function public.remove_design_item(uuid, uuid, integer) to authenticated;
