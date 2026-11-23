-- REL-12 per-event time zone (ADR-031 addendum).
--
-- An event may name its own IANA zone; null means "follow the wedding", so changing the wedding's
-- zone moves every event that has not chosen one. An agenda item keeps an absolute instant plus the
-- zone its clock times are read in, and that zone is always its event's effective zone. The database
-- keeps that true with triggers (insert, event zone change, wedding zone change), so no RPC has to
-- remember to. Changing a zone never moves an instant: the same moment is shown on a different clock,
-- and each re-labelled item gets a new version so a form opened before the change cannot save a
-- wall-clock time that was typed against the old zone.
--
-- Only the agenda and the Event page read the event zone. Deadlines, payment dates, "today" and the
-- caterer lock stay in the wedding's zone.

alter table public.events
  add column time_zone text check (time_zone is null or char_length(time_zone) between 1 and 64);

-- ---------------------------------------------------------------- a stored zone must be a real one
create function app_private.events_check_zone() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.time_zone is not null
     and not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = new.time_zone) then
    raise exception 'unknown time zone' using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke all on function app_private.events_check_zone() from public, anon, authenticated;
create trigger events_check_zone before insert or update of time_zone on public.events
  for each row execute function app_private.events_check_zone();

-- ---------------------------------------------------------------- items follow their event's zone
-- A new item is read in its event's effective zone, whatever the caller supplied.
create function app_private.timeline_items_set_zone() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_zone text;
begin
  select coalesce(e.time_zone, w.timezone) into v_zone
    from public.events e join public.weddings w on w.id = e.wedding_id
    where e.id = new.event_id;
  if v_zone is null then
    raise exception 'unknown event' using errcode = '23503';
  end if;
  new.timezone := v_zone;
  return new;
end;
$$;
revoke all on function app_private.timeline_items_set_zone() from public, anon, authenticated;
create trigger timeline_items_set_zone before insert on public.timeline_items
  for each row execute function app_private.timeline_items_set_zone();

-- When an event picks, changes or drops its own zone, its items are re-labelled to the new effective
-- zone. Instants are untouched.
create function app_private.events_relabel_items() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.timeline_items i
     set timezone = coalesce(new.time_zone, w.timezone), version = i.version + 1
    from public.weddings w
   where w.id = new.wedding_id and i.event_id = new.id
     and i.timezone is distinct from coalesce(new.time_zone, w.timezone);
  return null;
end;
$$;
revoke all on function app_private.events_relabel_items() from public, anon, authenticated;
create trigger events_relabel_items after update of time_zone on public.events
  for each row when (old.time_zone is distinct from new.time_zone)
  execute function app_private.events_relabel_items();

-- When the wedding's zone changes, events that follow it move with it.
create function app_private.weddings_relabel_items() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.timeline_items i
     set timezone = new.timezone, version = i.version + 1
    from public.events e
   where e.id = i.event_id and e.wedding_id = new.id and e.time_zone is null
     and i.timezone is distinct from new.timezone;
  return null;
end;
$$;
revoke all on function app_private.weddings_relabel_items() from public, anon, authenticated;
create trigger weddings_relabel_items after update of timezone on public.weddings
  for each row when (old.timezone is distinct from new.timezone)
  execute function app_private.weddings_relabel_items();

-- Existing items were labelled with the wedding's zone at creation and no event has its own zone yet.
-- Bring any item whose wedding zone has since changed in line (a no-op on a consistent database).
update public.timeline_items i
   set timezone = w.timezone
  from public.events e, public.weddings w
 where e.id = i.event_id and w.id = e.wedding_id and e.time_zone is null
   and i.timezone is distinct from w.timezone;

-- ---------------------------------------------------------------- event payload and writes
-- 'timeZone' is optional: absent keeps the stored value on update and follows the wedding on create;
-- JSON null or blank means "follow the wedding".
create or replace function app_private.event_ok(j jsonb) returns boolean
language plpgsql stable
set search_path = ''
as $$
declare
  k text;
  n text;
begin
  if j is null or jsonb_typeof(j) <> 'object' then return false; end if;
  foreach k in array array['name', 'kind', 'localDate', 'planningBasis', 'timeZone'] loop
    if coalesce(jsonb_typeof(j -> k), 'null') not in ('null', 'string') then return false; end if;
  end loop;
  foreach k in array array['targetAttendance', 'capacity'] loop
    if coalesce(jsonb_typeof(j -> k), 'null') not in ('null', 'number') then return false; end if;
  end loop;
  foreach k in array array['planOpenPlusOnes', 'invitationsFinal'] loop
    if coalesce(jsonb_typeof(j -> k), 'null') not in ('null', 'boolean') then return false; end if;
  end loop;
  if char_length(coalesce(app_private.jtext(j, 'name'), '')) not between 1 and 120 then return false; end if;
  if coalesce(app_private.jtext(j, 'kind'), 'other')
       not in ('ceremony', 'reception', 'rehearsal', 'welcome', 'brunch', 'other') then
    return false;
  end if;
  if app_private.jtext(j, 'planningBasis') is not null
     and app_private.jtext(j, 'planningBasis') not in ('auto', 'yes', 'yes_waiting') then
    return false;
  end if;
  n := app_private.jtext(j, 'localDate');
  if n is not null and (n !~ '^\d{4}-\d{2}-\d{2}$' or to_char(n::date, 'YYYY-MM-DD') <> n) then
    return false;
  end if;
  n := app_private.jtext(j, 'timeZone');
  if n is not null and (char_length(n) > 64
     or not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = n)) then
    return false;
  end if;
  if jsonb_typeof(j -> 'targetAttendance') = 'number'
     and ((j ->> 'targetAttendance') !~ '^\d{1,4}$' or (j ->> 'targetAttendance')::int > 5000) then
    return false;
  end if;
  if jsonb_typeof(j -> 'capacity') = 'number'
     and ((j ->> 'capacity') !~ '^\d{1,4}$' or (j ->> 'capacity')::int not between 1 and 5000) then
    return false;
  end if;
  return true;
exception when others then
  return false;
end;
$$;

create or replace function public.create_event(p_wedding uuid, p_event jsonb, p_idempotency_key text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_prior uuid;
  v_id uuid;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  if not app_private.event_ok(p_event) then
    raise exception 'invalid event' using errcode = '22023';
  end if;
  if p_idempotency_key is not null then
    v_prior := app_private.idem_claim(v_user, 'create_event:' || p_wedding::text, p_idempotency_key, md5(p_event::text));
    if v_prior is not null then return v_prior; end if;
  end if;
  if (select count(*) from public.events where wedding_id = p_wedding) >= 12 then
    raise exception 'too many events' using errcode = '54000';
  end if;
  insert into public.events (wedding_id, name, kind, local_date, target_attendance, capacity,
                             planning_basis, plan_open_plus_ones, invitations_final, time_zone)
    values (p_wedding, app_private.jtext(p_event, 'name'), coalesce(app_private.jtext(p_event, 'kind'), 'other'),
            (app_private.jtext(p_event, 'localDate'))::date,
            (p_event ->> 'targetAttendance')::int, (p_event ->> 'capacity')::int,
            coalesce(app_private.jtext(p_event, 'planningBasis'), 'auto'),
            coalesce((p_event ->> 'planOpenPlusOnes')::boolean, false),
            coalesce((p_event ->> 'invitationsFinal')::boolean, false),
            app_private.jtext(p_event, 'timeZone'))
    returning id into v_id;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'event', v_id, 'event.created',
            case when (p_event ->> 'targetAttendance') is null then '{}'::jsonb
                 else jsonb_build_object('plannedAttendance', jsonb_build_object('to', (p_event ->> 'targetAttendance')::int)) end,
            v_wedding.revision);
  if p_idempotency_key is not null then
    perform app_private.idem_done(v_user, 'create_event:' || p_wedding::text, p_idempotency_key, v_id);
  end if;
  return v_id;
end;
$$;

-- Full replacement from the form, except that an omitted planning field or an omitted time zone keeps
-- its stored value. A save that changes nothing does not bump the version or write audit noise.
create or replace function public.update_event(p_wedding uuid, p_event_id uuid, p_expected_version integer, p_event jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.events%rowtype;
  v_basis text;
  v_plus boolean;
  v_final boolean;
  v_zone text;
  v_changed text[] := '{}';
  v_details jsonb;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  if not app_private.event_ok(p_event) then
    raise exception 'invalid event' using errcode = '22023';
  end if;
  select * into v_old from public.events where id = p_event_id and wedding_id = p_wedding for update;
  if not found then raise exception 'not permitted' using errcode = '42501'; end if;
  if v_old.version <> p_expected_version then
    raise exception 'version conflict' using errcode = '55000';
  end if;
  v_basis := coalesce(app_private.jtext(p_event, 'planningBasis'), v_old.planning_basis);
  v_plus := coalesce((p_event ->> 'planOpenPlusOnes')::boolean, v_old.plan_open_plus_ones);
  v_final := coalesce((p_event ->> 'invitationsFinal')::boolean, v_old.invitations_final);
  -- Absent key keeps the stored zone; present (even blank or null) sets it, and blank means follow the wedding.
  v_zone := case when p_event ? 'timeZone' then app_private.jtext(p_event, 'timeZone') else v_old.time_zone end;

  if app_private.jtext(p_event, 'name') is distinct from v_old.name then v_changed := array_append(v_changed, 'name'); end if;
  if coalesce(app_private.jtext(p_event, 'kind'), 'other') is distinct from v_old.kind then v_changed := array_append(v_changed, 'kind'); end if;
  if (app_private.jtext(p_event, 'localDate'))::date is distinct from v_old.local_date then v_changed := array_append(v_changed, 'localDate'); end if;
  if (p_event ->> 'targetAttendance')::int is distinct from v_old.target_attendance then v_changed := array_append(v_changed, 'targetAttendance'); end if;
  if (p_event ->> 'capacity')::int is distinct from v_old.capacity then v_changed := array_append(v_changed, 'capacity'); end if;
  if v_basis is distinct from v_old.planning_basis then v_changed := array_append(v_changed, 'planningBasis'); end if;
  if v_plus is distinct from v_old.plan_open_plus_ones then v_changed := array_append(v_changed, 'planOpenPlusOnes'); end if;
  if v_final is distinct from v_old.invitations_final then v_changed := array_append(v_changed, 'invitationsFinal'); end if;
  if v_zone is distinct from v_old.time_zone then v_changed := array_append(v_changed, 'timeZone'); end if;
  if coalesce(array_length(v_changed, 1), 0) = 0 then return; end if;

  v_details := jsonb_build_object('changed', to_jsonb(v_changed));
  if 'targetAttendance' = any (v_changed) then
    v_details := v_details || jsonb_build_object('plannedAttendance',
      jsonb_build_object('from', v_old.target_attendance, 'to', (p_event ->> 'targetAttendance')::int));
  end if;
  if 'timeZone' = any (v_changed) then
    v_details := v_details || jsonb_build_object('timeZone',
      jsonb_build_object('from', v_old.time_zone, 'to', v_zone));
  end if;

  update public.events
    set name = app_private.jtext(p_event, 'name'), kind = coalesce(app_private.jtext(p_event, 'kind'), 'other'),
        local_date = (app_private.jtext(p_event, 'localDate'))::date,
        target_attendance = (p_event ->> 'targetAttendance')::int, capacity = (p_event ->> 'capacity')::int,
        planning_basis = v_basis, plan_open_plus_ones = v_plus, invitations_final = v_final,
        time_zone = v_zone, version = version + 1
    where id = p_event_id;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'event', p_event_id, 'event.updated', v_details, v_wedding.revision);
end;
$$;

-- ---------------------------------------------------------------- labels carry the event's own zone
-- Every member reads this (the agenda is the coordinator handoff). `time_zone` is the event's own
-- choice (null: follows the wedding); `effective_time_zone` is what the agenda is read in.
drop function public.list_event_labels(uuid);
create function public.list_event_labels(p_wedding uuid)
returns table (id uuid, name text, kind text, local_date date, time_zone text, effective_time_zone text)
language sql
stable
security definer
set search_path = ''
as $$
  select e.id, e.name, e.kind, e.local_date, e.time_zone, coalesce(e.time_zone, w.timezone)
    from public.events e
    join public.weddings w on w.id = e.wedding_id
   where e.wedding_id = p_wedding and app_private.is_member(p_wedding)
   order by e.local_date nulls last, e.name
   limit 50
$$;
revoke all on function public.list_event_labels(uuid) from public, anon;
grant execute on function public.list_event_labels(uuid) to authenticated;

-- ---------------------------------------------------------------- creating an item names the zone it was typed in
-- The page converts the typed clock time using the event's zone it just read. If that zone changed
-- before the save, the instant would be wrong, so the write is refused (55000) instead of guessed.
drop function public.create_timeline_item(uuid, uuid, text, timestamptz, timestamptz, text, text, text, text, uuid, uuid, text, text);
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
  p_idempotency_key text default null,
  p_expected_zone text default null
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
  v_zone text;
  v_hash text;
  v_existing public.idempotency_keys%rowtype;
  v_id uuid;
begin
  v_wedding := app_private.lock_wedding_for_plan(p_wedding);
  perform app_private.timeline_check(p_wedding, v_title, p_starts_at, p_ends_at, v_location,
                                     v_label, v_contact, v_notes, p_status);
  select coalesce(e.time_zone, v_wedding.timezone) into v_zone
    from public.events e where e.id = p_event and e.wedding_id = p_wedding;
  if v_zone is null then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_expected_zone is not null and p_expected_zone <> v_zone then
    raise exception 'event time zone changed, reload' using errcode = '55000';
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

  -- The zone column is set by the timeline_items_set_zone trigger.
  insert into public.timeline_items (wedding_id, event_id, title, starts_at, ends_at, timezone, location,
                                     responsible_label, contact, notes, assignee_user_id, vendor_id,
                                     status, created_by)
    values (p_wedding, p_event, v_title, p_starts_at, p_ends_at, v_zone, v_location,
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
revoke all on function public.create_timeline_item(uuid, uuid, text, timestamptz, timestamptz, text, text, text, text, uuid, uuid, text, text, text) from public, anon;
grant execute on function public.create_timeline_item(uuid, uuid, text, timestamptz, timestamptz, text, text, text, text, uuid, uuid, text, text, text) to authenticated;
