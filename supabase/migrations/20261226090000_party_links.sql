-- UX-06 one link per party (wedding_ux_rsvp_audit_output/GAP_BACKLOG.md; ADR-031 UX-06 addendum).
--
-- Rules:
--  * A party link groups a household's existing per-event invitations (one per event) under one
--    token. Invitations, members and answers are unchanged: the party is only a second way in.
--    Each per-event link keeps working, and both ways write the same invitation_members rows.
--  * Owner and partner create, reissue and revoke party links (the guests gate). Clients have
--    SELECT only, without token_hash. Revoking a party link stops only that token.
--  * All of a party's invitations share one household, or (no household) the same invited people,
--    so a party link never shows one household another household's names.
--  * rsvp_party_submit locks every live invitation in the party and applies every event's answers
--    in one transaction: all events are saved, or none. Each event keeps its own reply-by date and
--    version check; a stale or closed event refuses the whole send.
--  * A plus-one named for two events of the same party is one guest, not two.
--  * The answer rules (validation, history, seating hook, quota) live in one helper shared with
--    rsvp_submit, so the single-event and party paths cannot drift. rsvp_submit's behaviour is
--    unchanged.

-- ---------------------------------------------------------------- tables
create table public.invitation_parties (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  household_id uuid,
  label text not null check (char_length(label) between 1 and 120),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (wedding_id, id),
  foreign key (wedding_id, household_id) references public.households (wedding_id, id)
);
create index invitation_parties_wedding_idx on public.invitation_parties (wedding_id);
create trigger invitation_parties_touch before update on public.invitation_parties
  for each row execute function app_private.touch_updated_at();

alter table public.invitations add column party_id uuid;
alter table public.invitations add constraint invitations_party_fk
  foreign key (wedding_id, party_id) references public.invitation_parties (wedding_id, id);
-- One live invitation per event inside a party.
create unique index invitations_party_event_uq on public.invitations (party_id, event_id)
  where party_id is not null and revoked_at is null;

alter table public.invitation_parties enable row level security;
revoke all on public.invitation_parties from anon, authenticated;
-- token_hash is intentionally absent from this column list.
grant select (id, wedding_id, household_id, label, expires_at, revoked_at, version, created_at)
  on public.invitation_parties to authenticated;
grant select (party_id) on public.invitations to authenticated;
create policy invitation_parties_select_managers on public.invitation_parties
  for select to authenticated using (app_private.can_manage_guests(wedding_id));

-- ---------------------------------------------------------------- shared answer helper
-- Applies one invitation's answers and optional plus-one. The caller holds the guests advisory
-- lock and the invitation row lock, and has already checked revocation, expiry, reply-by date and
-- version. Bumps the invitation's version when something changed. The caller bumps the wedding
-- revision and writes the audit row. p_party is set on the party path, so a plus-one already
-- named on another event of the same party is reused instead of becoming a second guest.
-- Returns { changed, accepted, declined, plusOneAdded }.
create function app_private.rsvp_apply_invitation(
  p_invitation uuid, p_responses jsonb, p_plus_one jsonb, p_party uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv public.invitations%rowtype;
  v_r jsonb;
  v_seen uuid[] := '{}';
  v_member uuid;
  v_meal uuid;
  v_changed boolean := false;
  v_name text;
  v_guest uuid;
  v_plus boolean := false;
  v_accepted integer := 0;
  v_declined integer := 0;
begin
  select * into v_inv from public.invitations where id = p_invitation;
  if not found then
    raise exception 'invalid response' using errcode = '22023';
  end if;
  if p_responses is null or jsonb_typeof(p_responses) <> 'array' or jsonb_array_length(p_responses) > 13
     or coalesce(jsonb_typeof(p_plus_one), 'null') not in ('null', 'object')
     or (jsonb_array_length(p_responses) = 0 and coalesce(jsonb_typeof(p_plus_one), 'null') = 'null') then
    raise exception 'invalid response' using errcode = '22023';
  end if;

  for v_r in select * from jsonb_array_elements(p_responses) loop
    if jsonb_typeof(v_r) <> 'object'
       or coalesce(jsonb_typeof(v_r -> 'memberId'), '') <> 'string'
       or not app_private.is_uuid(v_r ->> 'memberId')
       or coalesce(jsonb_typeof(v_r -> 'status'), '') <> 'string'
       or coalesce(jsonb_typeof(v_r -> 'mealOptionId'), 'null') not in ('null', 'string')
       or (jsonb_typeof(v_r -> 'mealOptionId') = 'string' and not app_private.is_uuid(v_r ->> 'mealOptionId')) then
      raise exception 'invalid response' using errcode = '22023';
    end if;
    v_member := (v_r ->> 'memberId')::uuid;
    v_meal := nullif(v_r ->> 'mealOptionId', '')::uuid;
    if v_member = any (v_seen) then
      raise exception 'invalid response' using errcode = '22023';
    end if;
    v_seen := v_seen || v_member;
    -- Only this invitation's own active members may be answered; anything else is a forged id.
    if not exists (select 1 from public.invitation_members
                    where id = v_member and invitation_id = v_inv.id and active) then
      raise exception 'invalid response' using errcode = '22023';
    end if;
    if app_private.apply_member_response(v_member, v_r ->> 'status', v_meal, false) then
      v_changed := true;
      if v_r ->> 'status' = 'accepted' then v_accepted := v_accepted + 1; else v_declined := v_declined + 1; end if;
    end if;
  end loop;

  if jsonb_typeof(p_plus_one) = 'object' then
    if coalesce(jsonb_typeof(p_plus_one -> 'name'), '') <> 'string'
       or coalesce(jsonb_typeof(p_plus_one -> 'mealOptionId'), 'null') not in ('null', 'string')
       or (jsonb_typeof(p_plus_one -> 'mealOptionId') = 'string'
           and not app_private.is_uuid(p_plus_one ->> 'mealOptionId')) then
      raise exception 'invalid response' using errcode = '22023';
    end if;
    v_name := regexp_replace(btrim(p_plus_one ->> 'name'), '\s+', ' ', 'g');
    if char_length(v_name) not between 1 and 120 then
      raise exception 'invalid response' using errcode = '22023';
    end if;
    v_meal := nullif(p_plus_one ->> 'mealOptionId', '')::uuid;
    -- A repeat of the same plus-one request finds the guest it already created.
    select im.id into v_member from public.invitation_members im
      join public.guests g on g.id = im.guest_id
      where im.invitation_id = v_inv.id and im.is_plus_one and im.active and lower(g.full_name) = lower(v_name);
    if v_member is null then
      if v_inv.plus_ones_used >= v_inv.plus_one_quota then
        raise exception 'plus-one quota used' using errcode = 'RS422';
      end if;
      v_guest := null;
      if p_party is not null then
        -- The same person named for another event of this party (still an active plus-one there).
        select im.guest_id into v_guest from public.invitation_members im
          join public.invitations i2 on i2.id = im.invitation_id
          join public.guests g on g.id = im.guest_id and g.wedding_id = im.wedding_id
          where i2.party_id = p_party and i2.id <> v_inv.id and i2.revoked_at is null
            and im.is_plus_one and im.active and g.archived_at is null
            and lower(g.full_name) = lower(v_name)
            and not exists (select 1 from public.invitation_members x
                             where x.event_id = v_inv.event_id and x.guest_id = im.guest_id and x.active)
          order by im.created_at, im.id
          limit 1;
      end if;
      if v_guest is null then
        if (select count(*) from public.guests where wedding_id = v_inv.wedding_id and archived_at is null) + 1 > 2000 then
          raise exception 'too many guests' using errcode = '54000';
        end if;
        insert into public.guests (wedding_id, household_id, full_name, tags)
          values (v_inv.wedding_id, v_inv.household_id, v_name, array['plus-one'])
          returning id into v_guest;
      end if;
      insert into public.invitation_members (wedding_id, invitation_id, event_id, guest_id, is_plus_one)
        values (v_inv.wedding_id, v_inv.id, v_inv.event_id, v_guest, true)
        returning id into v_member;
      update public.invitations set plus_ones_used = plus_ones_used + 1 where id = v_inv.id;
      v_plus := true;
      v_changed := true;
    end if;
    if app_private.apply_member_response(v_member, 'accepted', v_meal, false) then
      v_changed := true;
      v_accepted := v_accepted + 1;
    end if;
  end if;

  if v_changed then
    update public.invitations set version = version + 1, last_responded_at = now() where id = v_inv.id;
  end if;
  return jsonb_build_object('changed', v_changed, 'accepted', v_accepted, 'declined', v_declined,
                            'plusOneAdded', v_plus);
end;
$$;
revoke all on function app_private.rsvp_apply_invitation(uuid, jsonb, jsonb, uuid)
  from public, anon, authenticated;

-- ---------------------------------------------------------------- single-event submit (same behaviour)
create or replace function public.rsvp_submit(
  p_token_hash text, p_client text, p_expected_version integer, p_responses jsonb, p_plus_one jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv public.invitations%rowtype;
  v_id uuid;
  v_res jsonb;
  v_revision integer;
begin
  perform app_private.rsvp_throttle(p_client, false);
  select i.id into v_id from public.invitations i
    where i.token_hash = p_token_hash and i.revoked_at is null and i.expires_at > now();
  if v_id is null then
    perform app_private.rsvp_throttle(p_client, true);
    return null;
  end if;
  -- Same advisory lock as owner guest writes, so the guest cap and plus-one creation serialize.
  select * into v_inv from public.invitations where id = v_id;
  perform pg_advisory_xact_lock(hashtextextended('guests:' || v_inv.wedding_id::text, 0));
  select * into v_inv from public.invitations where id = v_id for update;
  if v_inv.revoked_at is not null or v_inv.expires_at <= now() then
    perform app_private.rsvp_throttle(p_client, true);
    return null;
  end if;
  if v_inv.deadline is not null and now() > v_inv.deadline then
    raise exception 'responses closed' using errcode = 'RS410';
  end if;
  if v_inv.version <> p_expected_version then
    raise exception 'version conflict' using errcode = '55000';
  end if;
  v_res := app_private.rsvp_apply_invitation(v_inv.id, p_responses, p_plus_one, null);
  if (v_res ->> 'changed')::boolean then
    update public.weddings set revision = revision + 1 where id = v_inv.wedding_id
      returning revision into v_revision;
    insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
      values (v_inv.wedding_id, null, 'invitation', v_inv.id, 'rsvp.responded',
              jsonb_build_object('accepted', (v_res ->> 'accepted')::int,
                                 'declined', (v_res ->> 'declined')::int,
                                 'plus_one_added', (v_res ->> 'plusOneAdded')::boolean),
              v_revision);
  end if;
  return app_private.rsvp_projection(v_inv.id);
end;
$$;

-- ---------------------------------------------------------------- party projection
-- What a party link shows: the party's label and, per live invitation (not revoked, not expired),
-- the same narrow single-event projection, without the wedding-level fields repeated. Events are
-- in date order. No workspace id reaches the guest (the server strips it).
create function app_private.rsvp_party_projection(p_party uuid) returns jsonb
language sql stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'workspaceId', p.wedding_id,
    'weddingName', w.name,
    'label', p.label,
    'events', coalesce((
      select jsonb_agg(
               (app_private.rsvp_projection(i.id) - 'workspaceId' - 'weddingName' - 'label')
                 || jsonb_build_object('invitationId', i.id)
               order by e.local_date nulls last, e.name, i.id)
        from public.invitations i
        join public.events e on e.id = i.event_id and e.wedding_id = i.wedding_id
        where i.party_id = p.id and i.wedding_id = p.wedding_id
          and i.revoked_at is null and i.expires_at > now()), '[]'::jsonb))
  from public.invitation_parties p
  join public.weddings w on w.id = p.wedding_id
  where p.id = p_party;
$$;
revoke all on function app_private.rsvp_party_projection(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- owner RPCs
-- Groups 2 to 12 existing invitations (one per event, same household or same invited people)
-- under one new token. A replayed key returns the same party (its raw link is not recoverable;
-- reissue to get a new one). An invitation already in a live party link fails with 23505.
create function public.create_party_link(
  p_wedding uuid,
  p_invitation_ids uuid[],
  p_expires_at timestamptz,
  p_token_hash text,
  p_idempotency_key text
) returns table (o_party_id uuid, o_label text, o_replayed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_prior uuid;
  v_n integer := coalesce(cardinality(p_invitation_ids), 0);
  v_household uuid;
  v_label text;
  v_party uuid;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 128
     or v_n not between 2 and 12
     or exists (select 1 from unnest(p_invitation_ids) x where x is null)
     or (select count(distinct x) from unnest(p_invitation_ids) x) <> v_n
     or p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '2 years'
     or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid party link' using errcode = '22023';
  end if;
  v_prior := app_private.idem_claim(v_user, 'create_party_link:' || p_wedding::text, p_idempotency_key,
    md5((select string_agg(x::text, ',' order by x) from unnest(p_invitation_ids) x)
        || '|' || p_expires_at::text));
  if v_prior is not null then
    return query select p.id, p.label, true from public.invitation_parties p
      where p.id = v_prior and p.wedding_id = p_wedding;
    return;
  end if;

  perform 1 from public.invitations where id = any (p_invitation_ids) and wedding_id = p_wedding
    order by id for update;
  if (select count(*) from public.invitations where id = any (p_invitation_ids) and wedding_id = p_wedding) <> v_n then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if exists (select 1 from public.invitations where id = any (p_invitation_ids)
              and (revoked_at is not null or expires_at <= now()))
     or (select count(distinct event_id) from public.invitations where id = any (p_invitation_ids)) <> v_n
     or (select count(distinct household_id) from public.invitations where id = any (p_invitation_ids)) > 1
     or (exists (select 1 from public.invitations where id = any (p_invitation_ids) and household_id is null)
         and exists (select 1 from public.invitations where id = any (p_invitation_ids) and household_id is not null)) then
    raise exception 'invalid party link' using errcode = '22023';
  end if;
  select household_id into v_household from public.invitations where id = p_invitation_ids[1];
  if v_household is null then
    -- Without a household, every invitation must invite exactly the same people (plus-ones aside).
    if (select count(distinct people) from (
          select i.id, coalesce((select array_agg(im.guest_id order by im.guest_id)
                                   from public.invitation_members im
                                   where im.invitation_id = i.id and im.active and not im.is_plus_one),
                                '{}') as people
            from public.invitations i where i.id = any (p_invitation_ids)) s) <> 1
       or exists (select 1 from public.invitations i where i.id = any (p_invitation_ids)
                   and not exists (select 1 from public.invitation_members im
                                    where im.invitation_id = i.id and im.active and not im.is_plus_one)) then
      raise exception 'invalid party link' using errcode = '22023';
    end if;
  end if;
  if exists (select 1 from public.invitations i
               join public.invitation_parties p on p.id = i.party_id
              where i.id = any (p_invitation_ids) and p.revoked_at is null and p.expires_at > now()) then
    raise exception 'already in a party link' using errcode = '23505';
  end if;

  if v_household is not null then
    select h.name into v_label from public.households h where h.id = v_household and h.wedding_id = p_wedding;
  end if;
  if v_label is null then
    select i.label into v_label from public.invitations i
      where i.id = any (p_invitation_ids) order by i.label, i.id limit 1;
  end if;
  insert into public.invitation_parties (wedding_id, household_id, label, token_hash, expires_at, created_by)
    values (p_wedding, v_household, v_label, p_token_hash, p_expires_at, v_user)
    returning id into v_party;
  update public.invitations set party_id = v_party where id = any (p_invitation_ids);
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'invitation_party', v_party, 'invitation_party.created',
            jsonb_build_object('invitations', v_n), v_wedding.revision);
  perform app_private.idem_done(v_user, 'create_party_link:' || p_wedding::text, p_idempotency_key, v_party);
  return query select v_party, v_label, false;
end;
$$;

-- Replaces the party link: the old token stops working at once. Per-event links are untouched.
create function public.reissue_party_link(
  p_wedding uuid, p_party_id uuid, p_expected_version integer, p_token_hash text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_party public.invitation_parties%rowtype;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid token digest' using errcode = '22023';
  end if;
  select * into v_party from public.invitation_parties where id = p_party_id and wedding_id = p_wedding for update;
  if not found then raise exception 'not permitted' using errcode = '42501'; end if;
  if v_party.version <> p_expected_version or v_party.revoked_at is not null then
    raise exception 'version conflict' using errcode = '55000';
  end if;
  update public.invitation_parties set token_hash = p_token_hash, version = version + 1 where id = p_party_id;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'invitation_party', p_party_id, 'invitation_party.reissued', '{}'::jsonb,
            v_wedding.revision);
end;
$$;

-- Stops the party link only. Its invitations, answers and per-event links are untouched.
create function public.revoke_party_link(p_wedding uuid, p_party_id uuid, p_expected_version integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_party public.invitation_parties%rowtype;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  select * into v_party from public.invitation_parties where id = p_party_id and wedding_id = p_wedding for update;
  if not found then raise exception 'not permitted' using errcode = '42501'; end if;
  if v_party.version <> p_expected_version or v_party.revoked_at is not null then
    raise exception 'version conflict' using errcode = '55000';
  end if;
  update public.invitation_parties set revoked_at = now(), version = version + 1 where id = p_party_id;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'invitation_party', p_party_id, 'invitation_party.revoked', '{}'::jsonb,
            v_wedding.revision);
end;
$$;

-- ---------------------------------------------------------------- public party RPCs (service_role)
-- Returns the party projection, or null when the token is unknown, revoked or expired (the three
-- cases are indistinguishable, as for rsvp_view).
create function public.rsvp_party_view(p_token_hash text, p_client text) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_party uuid;
begin
  perform app_private.rsvp_throttle(p_client, false);
  select p.id into v_party from public.invitation_parties p
    where p.token_hash = p_token_hash and p.revoked_at is null and p.expires_at > now();
  if v_party is null then
    perform app_private.rsvp_throttle(p_client, true);
    return null;
  end if;
  return app_private.rsvp_party_projection(v_party);
end;
$$;

-- p_replies: [{ "invitationId": uuid, "expectedVersion": int,
--               "responses": [{ "memberId", "status", "mealOptionId" }], "plusOne": null | { "name", "mealOptionId" } }]
-- One entry per event the guest answers (1 to 12, each a live invitation of this party). Every
-- entry is checked before anything is written; any failure writes nothing.
-- Errors: 55000 an event changed since it was read, RS410 an event's reply-by date passed,
-- RS422 plus-one quota, 22023 invalid payload (including an invitation outside this party),
-- 54000 guest list full, RS429 throttled. Unknown/revoked/expired token returns null.
create function public.rsvp_party_submit(p_token_hash text, p_client text, p_replies jsonb) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_party public.invitation_parties%rowtype;
  v_pid uuid;
  v_r jsonb;
  v_inv public.invitations%rowtype;
  v_ids uuid[] := '{}';
  v_id uuid;
  v_res jsonb;
  v_changed uuid[] := '{}';
  v_results jsonb := '{}'::jsonb;
  v_revision integer;
begin
  perform app_private.rsvp_throttle(p_client, false);
  select p.id into v_pid from public.invitation_parties p
    where p.token_hash = p_token_hash and p.revoked_at is null and p.expires_at > now();
  if v_pid is null then
    perform app_private.rsvp_throttle(p_client, true);
    return null;
  end if;
  select * into v_party from public.invitation_parties where id = v_pid;
  perform pg_advisory_xact_lock(hashtextextended('guests:' || v_party.wedding_id::text, 0));
  select * into v_party from public.invitation_parties where id = v_pid for update;
  if v_party.revoked_at is not null or v_party.expires_at <= now() then
    perform app_private.rsvp_throttle(p_client, true);
    return null;
  end if;
  -- Every live invitation of the party, in one fixed order.
  perform 1 from public.invitations
    where party_id = v_pid and wedding_id = v_party.wedding_id and revoked_at is null and expires_at > now()
    order by id for update;

  if p_replies is null or jsonb_typeof(p_replies) <> 'array' or jsonb_array_length(p_replies) not between 1 and 12 then
    raise exception 'invalid response' using errcode = '22023';
  end if;
  -- Check every entry first, so the outcome does not depend on the order they were sent in.
  for v_r in select * from jsonb_array_elements(p_replies) loop
    if jsonb_typeof(v_r) <> 'object'
       or coalesce(jsonb_typeof(v_r -> 'invitationId'), '') <> 'string'
       or not app_private.is_uuid(v_r ->> 'invitationId')
       or coalesce(jsonb_typeof(v_r -> 'expectedVersion'), '') <> 'number'
       or (v_r ->> 'expectedVersion') !~ '^\d{1,9}$' then
      raise exception 'invalid response' using errcode = '22023';
    end if;
    v_id := (v_r ->> 'invitationId')::uuid;
    if v_id = any (v_ids) then
      raise exception 'invalid response' using errcode = '22023';
    end if;
    v_ids := v_ids || v_id;
    select * into v_inv from public.invitations
      where id = v_id and party_id = v_pid and wedding_id = v_party.wedding_id
        and revoked_at is null and expires_at > now();
    if not found then
      raise exception 'invalid response' using errcode = '22023';
    end if;
  end loop;
  for v_r in select * from jsonb_array_elements(p_replies) loop
    select * into v_inv from public.invitations where id = (v_r ->> 'invitationId')::uuid;
    if v_inv.deadline is not null and now() > v_inv.deadline then
      raise exception 'responses closed' using errcode = 'RS410';
    end if;
  end loop;
  for v_r in select * from jsonb_array_elements(p_replies) loop
    select * into v_inv from public.invitations where id = (v_r ->> 'invitationId')::uuid;
    if v_inv.version <> (v_r ->> 'expectedVersion')::integer then
      raise exception 'version conflict' using errcode = '55000';
    end if;
  end loop;

  for v_r in select * from jsonb_array_elements(p_replies) loop
    v_id := (v_r ->> 'invitationId')::uuid;
    v_res := app_private.rsvp_apply_invitation(
      v_id, coalesce(v_r -> 'responses', 'null'::jsonb), v_r -> 'plusOne', v_pid);
    if (v_res ->> 'changed')::boolean then
      v_changed := v_changed || v_id;
      v_results := v_results || jsonb_build_object(v_id::text, v_res);
    end if;
  end loop;

  if cardinality(v_changed) > 0 then
    update public.weddings set revision = revision + 1 where id = v_party.wedding_id
      returning revision into v_revision;
    foreach v_id in array v_changed loop
      v_res := v_results -> v_id::text;
      insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
        values (v_party.wedding_id, null, 'invitation', v_id, 'rsvp.responded',
                jsonb_build_object('accepted', (v_res ->> 'accepted')::int,
                                   'declined', (v_res ->> 'declined')::int,
                                   'plus_one_added', (v_res ->> 'plusOneAdded')::boolean,
                                   'party_link', true),
                v_revision);
    end loop;
  end if;
  return app_private.rsvp_party_projection(v_pid);
end;
$$;

revoke all on function public.create_party_link(uuid, uuid[], timestamptz, text, text),
  public.reissue_party_link(uuid, uuid, integer, text),
  public.revoke_party_link(uuid, uuid, integer),
  public.rsvp_party_view(text, text),
  public.rsvp_party_submit(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.create_party_link(uuid, uuid[], timestamptz, text, text),
  public.reissue_party_link(uuid, uuid, integer, text),
  public.revoke_party_link(uuid, uuid, integer) to authenticated;
grant execute on function public.rsvp_party_view(text, text),
  public.rsvp_party_submit(text, text, jsonb) to service_role;
