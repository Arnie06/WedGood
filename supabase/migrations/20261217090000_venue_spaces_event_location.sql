-- REL-06 venue spaces and event location (ADR-031; docs/06 and docs/07 "Events").
--   * venue_spaces: named rooms or areas under a venue candidate (seated and standing capacity,
--     both optional; unknown stays null). Spaces are archived, never deleted, so an event that
--     points at one keeps a record that can be shown as "no longer at this venue".
--   * event_locations: at most one row per event: a venue candidate plus an optional space of
--     that same venue. Composite foreign keys make a space from another venue or another wedding
--     impossible, not merely refused by the app.
-- events.capacity stays as the couple's own override. Space capacity is only a default.
-- Writes are RPCs only. Spaces follow the vendors lock and permission; the event location follows
-- the events (guests) lock and permission, because it is a change to the event.

create table public.venue_spaces (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null,
  candidate_id uuid not null,
  kind text not null default 'venue' check (kind = 'venue'),
  name text not null check (char_length(name) between 1 and 80 and name = btrim(name)),
  seated_capacity integer check (seated_capacity is null or seated_capacity between 1 and 100000),
  standing_capacity integer check (standing_capacity is null or standing_capacity between 1 and 100000),
  notes text check (notes is null or char_length(notes) between 1 and 500),
  archived_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (wedding_id, candidate_id, id),
  foreign key (wedding_id, candidate_id, kind)
    references public.candidates (wedding_id, id, kind) on delete cascade
);
create unique index venue_spaces_name_uq on public.venue_spaces (candidate_id, lower(name))
  where archived_at is null;
create index venue_spaces_candidate_idx on public.venue_spaces (wedding_id, candidate_id);
create trigger venue_spaces_touch before update on public.venue_spaces
  for each row execute function app_private.touch_updated_at();

create table public.event_locations (
  event_id uuid primary key,
  wedding_id uuid not null,
  candidate_id uuid not null,
  kind text not null default 'venue' check (kind = 'venue'),
  space_id uuid,
  version integer not null default 1,
  set_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (wedding_id, event_id) references public.events (wedding_id, id) on delete cascade,
  foreign key (wedding_id, candidate_id, kind)
    references public.candidates (wedding_id, id, kind),
  -- With a null space_id this is not checked (MATCH SIMPLE); with one it must be a space of
  -- exactly this venue in this wedding.
  foreign key (wedding_id, candidate_id, space_id)
    references public.venue_spaces (wedding_id, candidate_id, id)
);
create index event_locations_wedding_idx on public.event_locations (wedding_id);
create index event_locations_candidate_idx on public.event_locations (wedding_id, candidate_id);
create trigger event_locations_touch before update on public.event_locations
  for each row execute function app_private.touch_updated_at();

alter table public.venue_spaces enable row level security;
alter table public.event_locations enable row level security;
revoke all on public.venue_spaces, public.event_locations from anon, authenticated;
grant select on public.venue_spaces, public.event_locations to authenticated;
-- Venue facts and where an event is held are visible to every member, like venues and events.
create policy venue_spaces_select_member on public.venue_spaces
  for select to authenticated using (app_private.is_member(wedding_id));
create policy event_locations_select_member on public.event_locations
  for select to authenticated using (app_private.is_member(wedding_id));

-- ---------------------------------------------------------------- spaces
create function app_private.assert_space_fields(
  p_name text, p_seated integer, p_standing integer, p_notes text
) returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if char_length(coalesce(p_name, '')) not between 1 and 80
     or (p_seated is not null and p_seated not between 1 and 100000)
     or (p_standing is not null and p_standing not between 1 and 100000)
     or (p_notes is not null and char_length(p_notes) > 500) then
    raise exception 'invalid space' using errcode = '22023';
  end if;
end;
$$;
revoke all on function app_private.assert_space_fields(text, integer, integer, text) from public, anon;
grant execute on function app_private.assert_space_fields(text, integer, integer, text) to authenticated;

create function public.create_venue_space(
  p_wedding uuid,
  p_candidate uuid,
  p_name text,
  p_seated_capacity integer default null,
  p_standing_capacity integer default null,
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
  v_existing public.idempotency_keys%rowtype;
  v_id uuid;
begin
  v_wedding := app_private.lock_wedding_for_vendors(p_wedding);
  perform app_private.assert_space_fields(v_name, p_seated_capacity, p_standing_capacity, v_notes);
  perform 1 from public.candidates
    where id = p_candidate and wedding_id = p_wedding and kind = 'venue' and archived_at is null
    for share;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  if p_idempotency_key is not null then
    v_hash := md5(concat_ws('|', p_candidate::text, v_name, coalesce(p_seated_capacity::text, ''),
      coalesce(p_standing_capacity::text, ''), coalesce(v_notes, '')));
    insert into public.idempotency_keys (actor_scope, operation, key, request_hash)
      values (v_user::text, 'create_venue_space:' || p_wedding::text, p_idempotency_key, v_hash)
      on conflict do nothing;
    select * into v_existing from public.idempotency_keys
      where actor_scope = v_user::text and operation = 'create_venue_space:' || p_wedding::text
        and key = p_idempotency_key
      for update;
    if v_existing.request_hash <> v_hash then
      raise exception 'idempotency key reused with different request' using errcode = '23505';
    end if;
    if v_existing.response_ref is not null then
      return v_existing.response_ref;
    end if;
  end if;

  if (select count(*) from public.venue_spaces
       where candidate_id = p_candidate and archived_at is null) >= 30 then
    raise exception 'too many spaces' using errcode = '54000';
  end if;

  insert into public.venue_spaces (wedding_id, candidate_id, name, seated_capacity, standing_capacity, notes)
    values (p_wedding, p_candidate, v_name, p_seated_capacity, p_standing_capacity, v_notes)
    returning id into v_id;

  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'venue_space', v_id, 'venue_space.created',
            jsonb_build_object('venue', p_candidate), v_wedding.revision);

  if p_idempotency_key is not null then
    update public.idempotency_keys set response_ref = v_id
      where actor_scope = v_user::text and operation = 'create_venue_space:' || p_wedding::text
        and key = p_idempotency_key;
  end if;
  return v_id;
end;
$$;

create function public.update_venue_space(
  p_wedding uuid,
  p_space uuid,
  p_expected_version integer,
  p_name text,
  p_seated_capacity integer default null,
  p_standing_capacity integer default null,
  p_notes text default null
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.venue_spaces%rowtype;
  v_name text := btrim(coalesce(p_name, ''));
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_changed text[] := '{}';
  v_version integer;
begin
  v_wedding := app_private.lock_wedding_for_vendors(p_wedding);
  select * into v_old from public.venue_spaces where id = p_space and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_old.archived_at is not null or v_old.version <> p_expected_version then
    raise exception 'space changed, reload' using errcode = '55000';
  end if;
  perform app_private.assert_space_fields(v_name, p_seated_capacity, p_standing_capacity, v_notes);

  if v_name is distinct from v_old.name then v_changed := array_append(v_changed, 'name'); end if;
  if p_seated_capacity is distinct from v_old.seated_capacity
     or p_standing_capacity is distinct from v_old.standing_capacity
    then v_changed := array_append(v_changed, 'capacity'); end if;
  if v_notes is distinct from v_old.notes then v_changed := array_append(v_changed, 'notes'); end if;
  if coalesce(array_length(v_changed, 1), 0) = 0 then
    return v_old.version;
  end if;

  update public.venue_spaces set name = v_name, seated_capacity = p_seated_capacity,
      standing_capacity = p_standing_capacity, notes = v_notes, version = version + 1
    where id = p_space
    returning version into v_version;

  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'venue_space', p_space, 'venue_space.updated',
            jsonb_build_object('changed', to_jsonb(v_changed)), v_wedding.revision);
  return v_version;
end;
$$;

-- Archiving keeps the row, so events that point at the space still say which one it was.
-- Archiving an archived space is a successful no-op.
create function public.archive_venue_space(p_wedding uuid, p_space uuid, p_expected_version integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.venue_spaces%rowtype;
  v_version integer;
begin
  v_wedding := app_private.lock_wedding_for_vendors(p_wedding);
  select * into v_old from public.venue_spaces where id = p_space and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_old.archived_at is not null then
    return v_old.version;
  end if;
  if v_old.version <> p_expected_version then
    raise exception 'space changed, reload' using errcode = '55000';
  end if;
  update public.venue_spaces set archived_at = now(), version = version + 1
    where id = p_space
    returning version into v_version;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'venue_space', p_space, 'venue_space.archived',
            jsonb_build_object('venue', v_old.candidate_id), v_wedding.revision);
  return v_version;
end;
$$;

-- ---------------------------------------------------------------- event location
-- Case-insensitive, first-occurrence replacement used for agenda places. The app's preview uses
-- the same rule (src/domain/events/location.ts); an integration test compares them.
create function app_private.rewrite_place(p_location text, p_old text, p_new text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_pos integer;
begin
  if p_location is null or p_old is null or btrim(p_old) = '' then
    return null;
  end if;
  v_pos := strpos(lower(p_location), lower(p_old));
  if v_pos = 0 or lower(substr(p_location, v_pos, char_length(p_old))) <> lower(p_old) then
    return null;
  end if;
  return overlay(p_location placing p_new from v_pos for char_length(p_old));
end;
$$;
revoke all on function app_private.rewrite_place(text, text, text) from public, anon;
grant execute on function app_private.rewrite_place(text, text, text) to authenticated;

-- Sets (or, with a null venue, clears) the one place an event is held. p_expected_version is the
-- version the caller saw (0 when the event had no location). Returns the new version and how many
-- agenda places were rewritten. Nothing is sent to a venue and no booking changes.
create function public.set_event_location(
  p_wedding uuid,
  p_event uuid,
  p_expected_version integer,
  p_candidate uuid default null,
  p_space uuid default null,
  p_update_agenda boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.event_locations%rowtype;
  v_old_name text;
  v_new_name text;
  v_version integer;
  v_updated integer := 0;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  perform 1 from public.events where id = p_event and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  select * into v_old from public.event_locations where event_id = p_event;
  if coalesce(v_old.version, 0) <> p_expected_version then
    raise exception 'location changed, reload' using errcode = '55000';
  end if;
  if p_candidate is null and p_space is not null then
    raise exception 'invalid location' using errcode = '22023';
  end if;

  if p_candidate is not null then
    select name into v_new_name from public.candidates
      where id = p_candidate and wedding_id = p_wedding and kind = 'venue' and archived_at is null;
    if not found then
      raise exception 'not permitted' using errcode = '42501';
    end if;
    if p_space is not null then
      perform 1 from public.venue_spaces
        where id = p_space and wedding_id = p_wedding and candidate_id = p_candidate
          and archived_at is null;
      if not found then
        raise exception 'space not at this venue' using errcode = '22023';
      end if;
    end if;
  end if;

  -- Nothing to change: succeed without a version bump, audit entry or agenda rewrite.
  if v_old.event_id is not null
     and v_old.candidate_id is not distinct from p_candidate
     and v_old.space_id is not distinct from p_space then
    return jsonb_build_object('version', v_old.version, 'agenda_updated', 0);
  end if;
  if v_old.event_id is null and p_candidate is null then
    return jsonb_build_object('version', 0, 'agenda_updated', 0);
  end if;

  if p_candidate is null then
    delete from public.event_locations where event_id = p_event;
    v_version := 0;
  elsif v_old.event_id is null then
    insert into public.event_locations (event_id, wedding_id, candidate_id, space_id, set_by)
      values (p_event, p_wedding, p_candidate, p_space, v_user)
      returning version into v_version;
  else
    update public.event_locations
      set candidate_id = p_candidate, space_id = p_space, set_by = v_user, version = version + 1
      where event_id = p_event
      returning version into v_version;
  end if;

  -- Only when the venue itself changed, and only items of this event that name the old venue.
  if p_update_agenda and v_old.event_id is not null and p_candidate is not null
     and v_old.candidate_id <> p_candidate then
    select name into v_old_name from public.candidates where id = v_old.candidate_id;
    update public.timeline_items t
      set location = app_private.rewrite_place(t.location, v_old_name, v_new_name),
          version = t.version + 1
      where t.event_id = p_event and t.wedding_id = p_wedding and t.status = 'scheduled'
        and app_private.rewrite_place(t.location, v_old_name, v_new_name) is not null
        and char_length(app_private.rewrite_place(t.location, v_old_name, v_new_name)) <= 200;
    get diagnostics v_updated = row_count;
  end if;

  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'event', p_event, 'event.location_set',
            jsonb_build_object(
              'venue', jsonb_build_object('from', v_old.candidate_id, 'to', p_candidate),
              'space', jsonb_build_object('from', v_old.space_id, 'to', p_space),
              'agendaUpdated', v_updated),
            v_wedding.revision);
  return jsonb_build_object('version', v_version, 'agenda_updated', v_updated);
end;
$$;

revoke all on function public.create_venue_space(uuid, uuid, text, integer, integer, text, text) from public, anon;
revoke all on function public.update_venue_space(uuid, uuid, integer, text, integer, integer, text) from public, anon;
revoke all on function public.archive_venue_space(uuid, uuid, integer) from public, anon;
revoke all on function public.set_event_location(uuid, uuid, integer, uuid, uuid, boolean) from public, anon;
grant execute on function public.create_venue_space(uuid, uuid, text, integer, integer, text, text) to authenticated;
grant execute on function public.update_venue_space(uuid, uuid, integer, text, integer, integer, text) to authenticated;
grant execute on function public.archive_venue_space(uuid, uuid, integer) to authenticated;
grant execute on function public.set_event_location(uuid, uuid, integer, uuid, uuid, boolean) to authenticated;
