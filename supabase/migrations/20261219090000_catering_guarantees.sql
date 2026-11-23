-- REL-08 caterer count, the guarantee (ADR-031 D5).
--   * catering_guarantees: the head count the couple tells a caterer for one event. One row per
--     lock; at most one row per event is 'locked' at a time. A later reply never changes it.
--   * Changing it is an explicit revision with a reason: the old row becomes 'superseded' and a new
--     'locked' row points back at it (supersedes_id). Superseded rows are kept as history.
--   * The row holds a snapshot of the replies at the moment of locking (attending, attending per
--     meal, attending without a meal) so a later report can show what the number rested on.
--   * Locking and revising are RPCs. The caller sends what they previewed (attending, per-meal
--     counts); if replies changed since, the call is refused so nobody locks a number against a
--     breakdown they did not see.
--   * Readable by owner and partner, and by other members only while the owner shares guest totals
--     (ADR-031 D2): the snapshot is reply data. Writes are owner and partner (the guests lock).
--   * Nothing is sent to the caterer. An optional due date creates one checklist task so the couple
--     is reminded to send the count themselves.

-- Same rule event_demand applies: owner and partner always; others only while totals are shared.
create function app_private.can_read_guest_totals(p_wedding uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select app_private.is_member(p_wedding)
    and (app_private.can_manage_guests(p_wedding)
         or coalesce((select w.share_guest_totals from public.weddings w where w.id = p_wedding), false));
$$;
revoke all on function app_private.can_read_guest_totals(uuid) from public, anon;
grant execute on function app_private.can_read_guest_totals(uuid) to authenticated;

create table public.catering_guarantees (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  event_id uuid not null,
  -- The caterer, chosen from the vendors working at this event. Optional: a couple may not have saved
  -- their caterer yet. `kind` exists so a composite foreign key can pin the row to a vendor.
  candidate_id uuid,
  kind text not null default 'vendor' check (kind = 'vendor'),
  status text not null default 'locked' check (status in ('locked', 'superseded')),
  guaranteed_count integer not null check (guaranteed_count between 1 and 5000),
  -- What the replies said when this was locked.
  yes_at_lock integer not null check (yes_at_lock >= 0),
  without_meal_at_lock integer not null check (without_meal_at_lock >= 0),
  meals jsonb not null check (jsonb_typeof(meals) = 'array' and jsonb_array_length(meals) <= 40),
  due_on date check (due_on is null or due_on between date '1970-01-01' and date '2200-12-31'),
  supersedes_id uuid,
  reason text check (reason is null or char_length(reason) between 1 and 500),
  locked_by uuid references auth.users (id) on delete set null,
  locked_at timestamptz not null default now(),
  superseded_at timestamptz,
  unique (wedding_id, id),
  foreign key (wedding_id, event_id) references public.events (wedding_id, id) on delete cascade,
  foreign key (wedding_id, candidate_id, kind) references public.candidates (wedding_id, id, kind),
  foreign key (wedding_id, supersedes_id) references public.catering_guarantees (wedding_id, id),
  check ((status = 'superseded') = (superseded_at is not null)),
  check (supersedes_id is null or supersedes_id <> id),
  -- A first lock has no reason; a revision must give one.
  check ((supersedes_id is null) = (reason is null))
);
create unique index catering_guarantees_one_locked on public.catering_guarantees (event_id)
  where status = 'locked';
create unique index catering_guarantees_one_revision on public.catering_guarantees (supersedes_id)
  where supersedes_id is not null;
create index catering_guarantees_event_idx on public.catering_guarantees (wedding_id, event_id, locked_at desc, id);

-- Rows are history. The only change allowed is the one transition locked -> superseded; nothing is
-- deleted except by the cascade from deleting a wedding or an event.
create function app_private.guarantee_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then
      return old;
    end if;
    raise exception 'catering_guarantees is append-only' using errcode = '42501';
  end if;
  if old.status = 'locked' and new.status = 'superseded' and new.superseded_at is not null
     and (to_jsonb(new) - 'status' - 'superseded_at') = (to_jsonb(old) - 'status' - 'superseded_at') then
    return new;
  end if;
  raise exception 'catering_guarantees is append-only' using errcode = '42501';
end;
$$;
create trigger catering_guarantees_guard before update or delete on public.catering_guarantees
  for each row execute function app_private.guarantee_guard();

alter table public.catering_guarantees enable row level security;
revoke all on public.catering_guarantees from anon, authenticated;
grant select on public.catering_guarantees to authenticated;
create policy catering_guarantees_select on public.catering_guarantees
  for select to authenticated using (app_private.can_read_guest_totals(wedding_id));

-- ---------------------------------------------------------------- shared checks
-- The previewed breakdown must still be true. `p_seen` = {yes, withoutMeal, meals: [{id, count}]}.
-- Returns the snapshot to store (names included so a renamed option still reads right later).
create function app_private.guarantee_snapshot(p_wedding uuid, p_event uuid, p_seen jsonb)
returns table (yes integer, without_meal integer, meals jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  m jsonb;
  v_seen jsonb := '{}'::jsonb;
  v_now jsonb;
  v_n integer := 0;
begin
  if p_seen is null or jsonb_typeof(p_seen) <> 'object'
     or jsonb_typeof(p_seen -> 'yes') is distinct from 'number'
     or (p_seen ->> 'yes') !~ '^\d{1,5}$'
     or jsonb_typeof(p_seen -> 'withoutMeal') is distinct from 'number'
     or (p_seen ->> 'withoutMeal') !~ '^\d{1,5}$'
     or jsonb_typeof(p_seen -> 'meals') is distinct from 'array'
     or jsonb_array_length(p_seen -> 'meals') > 40 then
    raise exception 'invalid preview' using errcode = '22023';
  end if;
  for m in select * from jsonb_array_elements(p_seen -> 'meals') loop
    if jsonb_typeof(m) <> 'object'
       or jsonb_typeof(m -> 'id') is distinct from 'string'
       or jsonb_typeof(m -> 'count') is distinct from 'number'
       or (m ->> 'count') !~ '^\d{1,5}$' then
      raise exception 'invalid preview' using errcode = '22023';
    end if;
    v_seen := v_seen || jsonb_build_object(m ->> 'id', (m ->> 'count')::integer);
    v_n := v_n + 1;
  end loop;
  -- A repeated id would let the last one win and hide a mismatch.
  if (select count(*) from jsonb_object_keys(v_seen)) <> v_n then
    raise exception 'invalid preview' using errcode = '22023';
  end if;

  select d.* into r from app_private.event_demand_rows(p_wedding) d where d.event_id = p_event;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  v_now := coalesce(
    (select jsonb_object_agg(x ->> 'id', (x ->> 'count')::integer) from jsonb_array_elements(r.meals) x),
    '{}'::jsonb);
  if (p_seen ->> 'yes')::integer <> r.yes
     or (p_seen ->> 'withoutMeal')::integer <> r.yes_without_meal
     or v_seen <> v_now then
    -- Replies changed since the preview was drawn.
    raise exception 'preview changed' using errcode = 'CG412';
  end if;
  return query select r.yes, r.yes_without_meal, r.meals;
end;
$$;
revoke all on function app_private.guarantee_snapshot(uuid, uuid, jsonb) from public, anon, authenticated;

-- The caterer must be a vendor that works at this event and is still current. A revision may keep
-- the caterer it already has even if that vendor was passed on since (p_keep).
create function app_private.assert_guarantee_caterer(p_wedding uuid, p_event uuid, p_candidate uuid, p_keep uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_candidate is null or p_candidate is not distinct from p_keep then
    return;
  end if;
  if not exists (
    select 1
    from public.event_vendors ev
    join public.candidates c on c.id = ev.candidate_id and c.wedding_id = ev.wedding_id
    where ev.wedding_id = p_wedding and ev.event_id = p_event and ev.candidate_id = p_candidate
      and c.kind = 'vendor' and c.archived_at is null and c.stage not in ('declined', 'cancelled')
  ) then
    raise exception 'caterer not at this event' using errcode = '22023';
  end if;
end;
$$;
revoke all on function app_private.assert_guarantee_caterer(uuid, uuid, uuid, uuid) from public, anon, authenticated;

-- One checklist task so the couple remembers to send the number. The title carries the event name
-- and no figure (every member can read tasks, but not every member may read guest totals). It falls
-- due a week before the caterer's date, or today if that is already past, or on the date itself
-- when the date has gone by.
create function app_private.guarantee_reminder(p_wedding uuid, p_user uuid, p_event_name text, p_due date, p_revised boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date;
begin
  if p_due is null then
    return;
  end if;
  select (now() at time zone w.timezone)::date into v_today from public.weddings w where w.id = p_wedding;
  insert into public.tasks (wedding_id, title, notes, due_date, created_by)
    values (
      p_wedding,
      case when p_revised then 'Send the revised guest count to the caterer'
           else 'Send the final guest count to the caterer' end
        || ' (' || left(p_event_name, 60) || ')',
      'Nothing is sent from this app. Give the count to your caterer yourself.',
      least(p_due, greatest(p_due - 7, v_today)),
      p_user);
end;
$$;
revoke all on function app_private.guarantee_reminder(uuid, uuid, text, date, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------- lock
-- Fails with CG409 when the event already has a locked count (someone else got there first) and CG412
-- when replies changed since the preview. Idempotent per key.
create function public.lock_guarantee(
  p_wedding uuid,
  p_event uuid,
  p_count integer,
  p_seen jsonb,
  p_candidate uuid default null,
  p_due date default null,
  p_idempotency_key text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_event public.events%rowtype;
  v_snap record;
  v_prior uuid;
  v_id uuid;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  if p_count is null or p_count not between 1 and 5000
     or (p_due is not null and p_due not between date '1970-01-01' and date '2200-12-31')
     or (p_idempotency_key is not null and char_length(p_idempotency_key) not between 8 and 80) then
    raise exception 'invalid count' using errcode = '22023';
  end if;
  if p_idempotency_key is not null then
    v_prior := app_private.idem_claim(
      v_user, 'lock_guarantee:' || p_wedding::text, p_idempotency_key,
      md5(concat_ws('|', p_event, p_count, p_seen::text, p_candidate, p_due)));
    if v_prior is not null then return v_prior; end if;
  end if;

  select * into v_event from public.events where id = p_event and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if exists (select 1 from public.catering_guarantees where event_id = p_event and status = 'locked') then
    raise exception 'already locked' using errcode = 'CG409';
  end if;
  perform app_private.assert_guarantee_caterer(p_wedding, p_event, p_candidate, null);
  select * into v_snap from app_private.guarantee_snapshot(p_wedding, p_event, p_seen);

  insert into public.catering_guarantees
    (wedding_id, event_id, candidate_id, guaranteed_count, yes_at_lock, without_meal_at_lock, meals, due_on, locked_by)
    values (p_wedding, p_event, p_candidate, p_count, v_snap.yes, v_snap.without_meal, v_snap.meals, p_due, v_user)
    returning id into v_id;
  perform app_private.guarantee_reminder(p_wedding, v_user, v_event.name, p_due, false);

  -- Field names and flags only: no counts, names or notes.
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'catering_guarantee', v_id, 'catering.locked',
            jsonb_build_object('eventId', p_event, 'hasCaterer', p_candidate is not null, 'hasDue', p_due is not null),
            v_wedding.revision);
  if p_idempotency_key is not null then
    perform app_private.idem_done(v_user, 'lock_guarantee:' || p_wedding::text, p_idempotency_key, v_id);
  end if;
  return v_id;
end;
$$;
revoke all on function public.lock_guarantee(uuid, uuid, integer, jsonb, uuid, date, text) from public, anon;
grant execute on function public.lock_guarantee(uuid, uuid, integer, jsonb, uuid, date, text) to authenticated;

-- ---------------------------------------------------------------- revise
-- p_guarantee is the locked row the person was looking at. If it is no longer the locked one (someone
-- revised first) the call fails with 55000. The old row is kept as superseded. A revision that changes
-- nothing writes nothing and returns the same id.
create function public.revise_guarantee(
  p_wedding uuid,
  p_guarantee uuid,
  p_count integer,
  p_seen jsonb,
  p_reason text,
  p_candidate uuid default null,
  p_due date default null,
  p_idempotency_key text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.catering_guarantees%rowtype;
  v_event public.events%rowtype;
  v_snap record;
  v_prior uuid;
  v_id uuid;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_changed text[] := '{}';
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  if p_count is null or p_count not between 1 and 5000
     or char_length(v_reason) not between 1 and 500
     or (p_due is not null and p_due not between date '1970-01-01' and date '2200-12-31')
     or (p_idempotency_key is not null and char_length(p_idempotency_key) not between 8 and 80) then
    raise exception 'invalid revision' using errcode = '22023';
  end if;
  if p_idempotency_key is not null then
    v_prior := app_private.idem_claim(
      v_user, 'revise_guarantee:' || p_wedding::text, p_idempotency_key,
      md5(concat_ws('|', p_guarantee, p_count, p_seen::text, p_reason, p_candidate, p_due)));
    if v_prior is not null then return v_prior; end if;
  end if;

  select * into v_old from public.catering_guarantees
    where id = p_guarantee and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_old.status <> 'locked' then
    raise exception 'already revised' using errcode = '55000';
  end if;
  select * into v_event from public.events where id = v_old.event_id and wedding_id = p_wedding for update;
  perform app_private.assert_guarantee_caterer(p_wedding, v_old.event_id, p_candidate, v_old.candidate_id);
  select * into v_snap from app_private.guarantee_snapshot(p_wedding, v_old.event_id, p_seen);

  if p_count <> v_old.guaranteed_count then v_changed := array_append(v_changed, 'count'); end if;
  if p_candidate is distinct from v_old.candidate_id then v_changed := array_append(v_changed, 'caterer'); end if;
  if p_due is distinct from v_old.due_on then v_changed := array_append(v_changed, 'due'); end if;
  if v_snap.meals is distinct from v_old.meals or v_snap.yes <> v_old.yes_at_lock then
    v_changed := array_append(v_changed, 'replies');
  end if;
  if coalesce(array_length(v_changed, 1), 0) = 0 then
    if p_idempotency_key is not null then
      perform app_private.idem_done(v_user, 'revise_guarantee:' || p_wedding::text, p_idempotency_key, p_guarantee);
    end if;
    return p_guarantee;
  end if;

  update public.catering_guarantees set status = 'superseded', superseded_at = now() where id = v_old.id;
  insert into public.catering_guarantees
    (wedding_id, event_id, candidate_id, guaranteed_count, yes_at_lock, without_meal_at_lock, meals, due_on,
     supersedes_id, reason, locked_by)
    values (p_wedding, v_old.event_id, p_candidate, p_count, v_snap.yes, v_snap.without_meal, v_snap.meals, p_due,
            v_old.id, v_reason, v_user)
    returning id into v_id;
  -- A new reminder only when there is something new to send.
  if p_due is not null and (v_changed && array['count', 'due']) then
    perform app_private.guarantee_reminder(p_wedding, v_user, v_event.name, p_due, true);
  end if;

  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'catering_guarantee', v_id, 'catering.revised',
            jsonb_build_object('eventId', v_old.event_id, 'changed', to_jsonb(v_changed)), v_wedding.revision);
  if p_idempotency_key is not null then
    perform app_private.idem_done(v_user, 'revise_guarantee:' || p_wedding::text, p_idempotency_key, v_id);
  end if;
  return v_id;
end;
$$;
revoke all on function public.revise_guarantee(uuid, uuid, integer, jsonb, text, uuid, date, text) from public, anon;
grant execute on function public.revise_guarantee(uuid, uuid, integer, jsonb, text, uuid, date, text) to authenticated;
