-- R1-12 wedding agenda / day-of timeline (docs/06 timeline_items, docs/07 "Tasks, dates and
-- timeline", docs/11 "Wedding day mode").
--
-- Rules:
--  * An item belongs to one event. Times are absolute instants (timestamptz) interpreted in the
--    item's IANA zone, which is the wedding's zone when the item is created. Conversion from wall
--    clock (and rejection of nonexistent/ambiguous local times) happens in src/domain/timeline.
--  * Any member can read the agenda (it is the coordinator handoff); owner and partner write
--    (plan.edit). Clients have SELECT only; every write is an RPC with a version check.
--  * Overlaps are legal. Only the app warns, and only for a shared member, vendor or named person.
--  * The responsible member must be an active member; the vendor must be a candidate of the same
--    wedding (composite FK). Nothing here contacts anyone or reports live status.

create table public.timeline_items (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null,
  event_id uuid not null,
  title text not null check (char_length(title) between 1 and 160 and title = btrim(title)),
  starts_at timestamptz not null
    check (starts_at between timestamptz '1970-01-01 00:00+00' and timestamptz '2200-12-31 00:00+00'),
  ends_at timestamptz
    check (ends_at is null or ends_at between timestamptz '1970-01-01 00:00+00' and timestamptz '2200-12-31 00:00+00'),
  timezone text not null,
  location text check (location is null or char_length(location) between 1 and 200),
  responsible_label text check (responsible_label is null or char_length(responsible_label) between 1 and 120),
  contact text check (contact is null or char_length(contact) between 1 and 200),
  notes text check (notes is null or char_length(notes) between 1 and 2000),
  assignee_user_id uuid references auth.users (id) on delete set null,
  vendor_id uuid,
  status text not null default 'scheduled' check (status in ('scheduled', 'cancelled')),
  created_by uuid references auth.users (id) on delete set null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or ends_at >= starts_at),
  foreign key (wedding_id, event_id) references public.events (wedding_id, id) on delete cascade,
  foreign key (wedding_id, vendor_id) references public.candidates (wedding_id, id)
);
create index timeline_items_event_idx on public.timeline_items (event_id, starts_at, created_at);
create index timeline_items_wedding_idx on public.timeline_items (wedding_id);
create trigger timeline_items_touch before update on public.timeline_items
  for each row execute function app_private.touch_updated_at();

alter table public.timeline_items enable row level security;
revoke all on public.timeline_items from anon, authenticated;
grant select on public.timeline_items to authenticated;
create policy timeline_items_select_member on public.timeline_items
  for select to authenticated using (app_private.is_member(wedding_id));

-- Shared validation for create and update. Raises 22023 on bad input.
create function app_private.timeline_check(
  p_wedding uuid, p_title text, p_starts timestamptz, p_ends timestamptz,
  p_location text, p_label text, p_contact text, p_notes text, p_status text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if char_length(coalesce(p_title, '')) not between 1 and 160
     or p_starts is null
     or p_status not in ('scheduled', 'cancelled')
     or (p_ends is not null and p_ends < p_starts)
     or char_length(coalesce(p_location, '')) > 200
     or char_length(coalesce(p_label, '')) > 120
     or char_length(coalesce(p_contact, '')) > 200
     or char_length(coalesce(p_notes, '')) > 2000
     or p_starts not between timestamptz '1970-01-01 00:00+00' and timestamptz '2200-12-31 00:00+00'
     or (p_ends is not null
         and p_ends not between timestamptz '1970-01-01 00:00+00' and timestamptz '2200-12-31 00:00+00') then
    raise exception 'invalid timeline item' using errcode = '22023';
  end if;
end;
$$;
revoke all on function app_private.timeline_check(uuid, text, timestamptz, timestamptz, text, text, text, text, text)
  from public, anon, authenticated;

create function public.create_timeline_item(
  p_wedding uuid,
  p_event uuid,
  p_title text,
  p_starts_at timestamptz,
  p_ends_at timestamptz default null,
  p_location text default null,
  p_responsible_label text default null,
  p_contact text default null,
  p_notes text default null,
  p_assignee uuid default null,
  p_vendor uuid default null,
  p_status text default 'scheduled',
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
  v_location text := nullif(btrim(coalesce(p_location, '')), '');
  v_label text := nullif(btrim(coalesce(p_responsible_label, '')), '');
  v_contact text := nullif(btrim(coalesce(p_contact, '')), '');
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_hash text;
  v_existing public.idempotency_keys%rowtype;
  v_id uuid;
begin
  v_wedding := app_private.lock_wedding_for_plan(p_wedding);
  perform app_private.timeline_check(p_wedding, v_title, p_starts_at, p_ends_at, v_location,
                                     v_label, v_contact, v_notes, p_status);
  if not exists (select 1 from public.events where id = p_event and wedding_id = p_wedding) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  perform app_private.assert_assignable(p_wedding, p_assignee);

  if p_idempotency_key is not null then
    v_hash := md5(concat_ws('|', p_event::text, v_title, p_starts_at::text, coalesce(p_ends_at::text, ''),
                            coalesce(v_location, ''), coalesce(v_label, ''), coalesce(v_contact, ''),
                            coalesce(v_notes, ''), coalesce(p_assignee::text, ''),
                            coalesce(p_vendor::text, ''), p_status));
    insert into public.idempotency_keys (actor_scope, operation, key, request_hash)
      values (v_user::text, 'create_timeline_item:' || p_wedding::text, p_idempotency_key, v_hash)
      on conflict do nothing;
    select * into v_existing from public.idempotency_keys
      where actor_scope = v_user::text and operation = 'create_timeline_item:' || p_wedding::text
        and key = p_idempotency_key
      for update;
    if v_existing.request_hash <> v_hash then
      raise exception 'idempotency key reused with different request' using errcode = '23505';
    end if;
    if v_existing.response_ref is not null then
      return v_existing.response_ref;
    end if;
  end if;

  insert into public.timeline_items (wedding_id, event_id, title, starts_at, ends_at, timezone, location,
                                     responsible_label, contact, notes, assignee_user_id, vendor_id,
                                     status, created_by)
    values (p_wedding, p_event, v_title, p_starts_at, p_ends_at, v_wedding.timezone, v_location,
            v_label, v_contact, v_notes, p_assignee, p_vendor, p_status, v_user)
    returning id into v_id;

  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'timeline_item', v_id, 'timeline.created', '{}'::jsonb, v_wedding.revision);

  if p_idempotency_key is not null then
    update public.idempotency_keys set response_ref = v_id
      where actor_scope = v_user::text and operation = 'create_timeline_item:' || p_wedding::text
        and key = p_idempotency_key;
  end if;
  return v_id;
end;
$$;

create function public.update_timeline_item(
  p_wedding uuid,
  p_item uuid,
  p_expected_version integer,
  p_title text,
  p_starts_at timestamptz,
  p_ends_at timestamptz default null,
  p_location text default null,
  p_responsible_label text default null,
  p_contact text default null,
  p_notes text default null,
  p_assignee uuid default null,
  p_vendor uuid default null,
  p_status text default 'scheduled'
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.timeline_items%rowtype;
  v_title text := btrim(coalesce(p_title, ''));
  v_location text := nullif(btrim(coalesce(p_location, '')), '');
  v_label text := nullif(btrim(coalesce(p_responsible_label, '')), '');
  v_contact text := nullif(btrim(coalesce(p_contact, '')), '');
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_version integer;
begin
  v_wedding := app_private.lock_wedding_for_plan(p_wedding);
  select * into v_old from public.timeline_items where id = p_item and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_old.version <> p_expected_version then
    raise exception 'timeline item changed, reload' using errcode = '55000';
  end if;
  perform app_private.timeline_check(p_wedding, v_title, p_starts_at, p_ends_at, v_location,
                                     v_label, v_contact, v_notes, p_status);
  perform app_private.assert_assignable(p_wedding, p_assignee);

  if v_title = v_old.title and p_starts_at = v_old.starts_at
     and p_ends_at is not distinct from v_old.ends_at
     and v_location is not distinct from v_old.location
     and v_label is not distinct from v_old.responsible_label
     and v_contact is not distinct from v_old.contact
     and v_notes is not distinct from v_old.notes
     and p_assignee is not distinct from v_old.assignee_user_id
     and p_vendor is not distinct from v_old.vendor_id
     and p_status = v_old.status then
    return v_old.version;
  end if;

  update public.timeline_items set title = v_title, starts_at = p_starts_at, ends_at = p_ends_at,
      location = v_location, responsible_label = v_label, contact = v_contact, notes = v_notes,
      assignee_user_id = p_assignee, vendor_id = p_vendor, status = p_status, version = version + 1
    where id = p_item
    returning version into v_version;

  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'timeline_item', p_item, 'timeline.updated', '{}'::jsonb, v_wedding.revision);
  return v_version;
end;
$$;

create function public.delete_timeline_item(p_wedding uuid, p_item uuid, p_expected_version integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.timeline_items%rowtype;
begin
  v_wedding := app_private.lock_wedding_for_plan(p_wedding);
  select * into v_old from public.timeline_items where id = p_item and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_old.version <> p_expected_version then
    raise exception 'timeline item changed, reload' using errcode = '55000';
  end if;
  delete from public.timeline_items where id = p_item;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'timeline_item', p_item, 'timeline.deleted', '{}'::jsonb, v_wedding.revision);
end;
$$;

revoke all on function public.create_timeline_item(uuid, uuid, text, timestamptz, timestamptz, text, text, text, text, uuid, uuid, text, text) from public, anon;
revoke all on function public.update_timeline_item(uuid, uuid, integer, text, timestamptz, timestamptz, text, text, text, text, uuid, uuid, text) from public, anon;
revoke all on function public.delete_timeline_item(uuid, uuid, integer) from public, anon;
grant execute on function public.create_timeline_item(uuid, uuid, text, timestamptz, timestamptz, text, text, text, text, uuid, uuid, text, text) to authenticated;
grant execute on function public.update_timeline_item(uuid, uuid, integer, text, timestamptz, timestamptz, text, text, text, text, uuid, uuid, text) to authenticated;
grant execute on function public.delete_timeline_item(uuid, uuid, integer) to authenticated;
