-- UX-09: a guest can remove a plus-one they added (wedding_ux_rsvp_audit_output/GAP_BACKLOG.md;
-- ADR-031 UX-09 addendum).
--
-- Until now the only thing a guest could do to a plus-one was mark them "Not attending". The place
-- stayed used, the person stayed on the couple's guest list, and nobody else could be added.
--
-- A response for a plus-one may now carry "remove": true (with status "declined"). In one
-- transaction that:
--   * records the decline exactly as before (reply history, seating and meal eligibility released),
--   * ends the plus-one's membership of this invitation (active = false),
--   * frees the place (plus_ones_used - 1), so the guest can add someone else, even in the same send,
--   * archives the guest record the guest created, unless that person is still attending another
--     event of the same party. Archiving keeps history and is reversible by the couple.
--
-- Only people the guest added can be removed: a member the couple invited (is_plus_one = false)
-- is refused. The deadline, version and token rules are the same as any other send.
--
-- To stop add-and-remove from being used to pile up guest rows, an invitation may only ever create
-- 10 plus-one rows, removed ones included (the quota is at most 5).

-- ---------------------------------------------------------------- the record learns about removals
-- No row is updated: adding a column with a constant default does not fire the append-only trigger.
alter table public.rsvp_submissions
  add column plus_ones_removed integer not null default 0 check (plus_ones_removed >= 0);

-- Same fingerprint as UX-08. A removal is part of what was sent, so it is added to a member's entry
-- only when true; a send without removals hashes exactly as before.
create or replace function app_private.rsvp_payload_hash(p_responses jsonb, p_plus_one jsonb) returns text
language sql immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(
    jsonb_build_object(
      'responses', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'memberId', r ->> 'memberId',
                 'status', r ->> 'status',
                 'mealOptionId', r ->> 'mealOptionId',
                 'dietary', nullif(btrim(r ->> 'dietary'), '') is not null,
                 'accessibility', nullif(btrim(r ->> 'accessibility'), '') is not null)
                 || case when r -> 'remove' = 'true'::jsonb then jsonb_build_object('remove', true)
                         else '{}'::jsonb end
               order by r ->> 'memberId')
          from jsonb_array_elements(p_responses) r), '[]'::jsonb),
      'plusOne', case when jsonb_typeof(p_plus_one) = 'object' then jsonb_build_object(
                 'name', lower(regexp_replace(btrim(p_plus_one ->> 'name'), '\s+', ' ', 'g')),
                 'mealOptionId', p_plus_one ->> 'mealOptionId',
                 'dietary', nullif(btrim(p_plus_one ->> 'dietary'), '') is not null,
                 'accessibility', nullif(btrim(p_plus_one ->> 'accessibility'), '') is not null)
               else 'null'::jsonb end
    )::text, 'UTF8')), 'hex');
$$;
revoke all on function app_private.rsvp_payload_hash(jsonb, jsonb) from public, anon, authenticated;

create or replace function app_private.rsvp_record_submission(
  p_send uuid, p_invitation uuid, p_party uuid, p_responses jsonb, p_plus_one jsonb,
  p_res jsonb, p_revision integer
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv public.invitations%rowtype;
begin
  select * into v_inv from public.invitations where id = p_invitation;
  insert into public.rsvp_submissions (
    wedding_id, send_id, invitation_id, event_id, party_id, payload_hash, invitation_version,
    accepted_revision, accepted_count, declined_count, plus_one_added, details_count, plus_ones_removed)
  values (
    v_inv.wedding_id, p_send, v_inv.id, v_inv.event_id, p_party,
    app_private.rsvp_payload_hash(p_responses, p_plus_one), v_inv.version, p_revision,
    (p_res ->> 'accepted')::int, (p_res ->> 'declined')::int,
    (p_res ->> 'plusOneAdded')::boolean, (p_res ->> 'details')::int, (p_res ->> 'removed')::int);
end;
$$;
revoke all on function app_private.rsvp_record_submission(uuid, uuid, uuid, jsonb, jsonb, jsonb, integer)
  from public, anon, authenticated;

-- ---------------------------------------------------------------- shared answer helper
-- Same as UX-07, plus "remove" on a plus-one's response. Returns
-- { changed, accepted, declined, plusOneAdded, details, removed }.
create or replace function app_private.rsvp_apply_invitation(
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
  v_details integer := 0;
  v_removed integer := 0;
  v_remove boolean;
  v_used integer;
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
       or (jsonb_typeof(v_r -> 'mealOptionId') = 'string' and not app_private.is_uuid(v_r ->> 'mealOptionId'))
       or coalesce(jsonb_typeof(v_r -> 'remove'), 'null') not in ('null', 'boolean') then
      raise exception 'invalid response' using errcode = '22023';
    end if;
    v_member := (v_r ->> 'memberId')::uuid;
    v_meal := nullif(v_r ->> 'mealOptionId', '')::uuid;
    v_remove := coalesce((v_r ->> 'remove')::boolean, false);
    if v_member = any (v_seen) then
      raise exception 'invalid response' using errcode = '22023';
    end if;
    v_seen := v_seen || v_member;
    -- Only this invitation's own active members may be answered; anything else is a forged id.
    if not exists (select 1 from public.invitation_members
                    where id = v_member and invitation_id = v_inv.id and active) then
      raise exception 'invalid response' using errcode = '22023';
    end if;
    -- A removal is a decline of someone the guest added. The couple's own invitees cannot be removed.
    if v_remove and (v_r ->> 'status' <> 'declined'
                     or not exists (select 1 from public.invitation_members
                                     where id = v_member and is_plus_one)) then
      raise exception 'invalid response' using errcode = '22023';
    end if;
    if app_private.apply_member_response(v_member, v_r ->> 'status', v_meal, false) then
      v_changed := true;
      if v_r ->> 'status' = 'accepted' then v_accepted := v_accepted + 1; else v_declined := v_declined + 1; end if;
    end if;
    if v_r ->> 'status' = 'accepted' and app_private.rsvp_save_details(v_member, v_r) then
      v_changed := true;
      v_details := v_details + 1;
    end if;
    if v_remove then
      update public.invitation_members set active = false where id = v_member
        returning guest_id into v_guest;
      update public.invitations set plus_ones_used = greatest(plus_ones_used - 1, 0) where id = v_inv.id;
      -- The guest record goes with them, unless this person is still answering for another event.
      if not exists (select 1 from public.invitation_members where guest_id = v_guest and active) then
        update public.guests set archived_at = now()
          where id = v_guest and wedding_id = v_inv.wedding_id and archived_at is null;
      end if;
      v_removed := v_removed + 1;
      v_changed := true;
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
      -- Read again: a removal earlier in this send has just freed a place.
      select plus_ones_used into v_used from public.invitations where id = v_inv.id;
      if v_used >= v_inv.plus_one_quota
         or (select count(*) from public.invitation_members
              where invitation_id = v_inv.id and is_plus_one) >= 10 then
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
      -- The same person may have been removed from this event earlier in a party: bring that row back.
      select im.id into v_member from public.invitation_members im
        where im.invitation_id = v_inv.id and im.guest_id = v_guest and not im.active;
      if v_member is not null then
        update public.invitation_members
          set active = true, rsvp_status = 'pending', meal_option_id = null, responded_at = null
          where id = v_member;
      else
        insert into public.invitation_members (wedding_id, invitation_id, event_id, guest_id, is_plus_one)
          values (v_inv.wedding_id, v_inv.id, v_inv.event_id, v_guest, true)
          returning id into v_member;
      end if;
      update public.invitations set plus_ones_used = plus_ones_used + 1 where id = v_inv.id;
      v_plus := true;
      v_changed := true;
    end if;
    if app_private.apply_member_response(v_member, 'accepted', v_meal, false) then
      v_changed := true;
      v_accepted := v_accepted + 1;
    end if;
    if app_private.rsvp_save_details(v_member, p_plus_one) then
      v_changed := true;
      v_details := v_details + 1;
    end if;
  end if;

  if v_changed then
    update public.invitations set version = version + 1, last_responded_at = now() where id = v_inv.id;
  end if;
  return jsonb_build_object('changed', v_changed, 'accepted', v_accepted, 'declined', v_declined,
                            'plusOneAdded', v_plus, 'details', v_details, 'removed', v_removed);
end;
$$;
revoke all on function app_private.rsvp_apply_invitation(uuid, jsonb, jsonb, uuid)
  from public, anon, authenticated;

-- ---------------------------------------------------------------- single-event submit
-- Unchanged from UX-08 except that the audit row says when plus-ones were removed (only then, so
-- every other row keeps its exact shape).
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
                                 'plus_one_added', (v_res ->> 'plusOneAdded')::boolean)
              || case when (v_res ->> 'removed')::int > 0
                      then jsonb_build_object('plus_ones_removed', (v_res ->> 'removed')::int)
                      else '{}'::jsonb end,
              v_revision);
    perform app_private.rsvp_record_submission(
      gen_random_uuid(), v_inv.id, null, p_responses, p_plus_one, v_res, v_revision);
  end if;
  return app_private.rsvp_projection(v_inv.id);
end;
$$;

-- ---------------------------------------------------------------- party submit
-- Unchanged from UX-08 except for the same audit detail.
create or replace function public.rsvp_party_submit(p_token_hash text, p_client text, p_replies jsonb) returns jsonb
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
  v_send uuid := gen_random_uuid();
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
                                   'party_link', true)
                || case when (v_res ->> 'removed')::int > 0
                        then jsonb_build_object('plus_ones_removed', (v_res ->> 'removed')::int)
                        else '{}'::jsonb end,
                v_revision);
      select r into v_r from jsonb_array_elements(p_replies) r where (r ->> 'invitationId')::uuid = v_id;
      perform app_private.rsvp_record_submission(
        v_send, v_id, v_pid, coalesce(v_r -> 'responses', 'null'::jsonb), v_r -> 'plusOne', v_res, v_revision);
    end loop;
  end if;
  return app_private.rsvp_party_projection(v_pid);
end;
$$;

revoke all on function public.rsvp_submit(text, text, integer, jsonb, jsonb),
  public.rsvp_party_submit(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.rsvp_submit(text, text, integer, jsonb, jsonb),
  public.rsvp_party_submit(text, text, jsonb) to service_role;
