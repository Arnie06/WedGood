-- UX-08: an append-only record of every guest send (wedding_ux_rsvp_audit_output/GAP_BACKLOG.md;
-- ADR-031 UX-08 addendum).
--
-- Until now the app kept what changed (rsvp_changes, one row per person and event) but not the send
-- itself. This adds one row per invitation per Send: when, through which link (one event or a party),
-- which version of the form, a fingerprint of what was sent, and the revision of the workspace once
-- it was accepted. A party send writes one row per event it changed, all sharing one send_id.
--
-- What is NOT stored: the answers themselves (they live in invitation_members and rsvp_changes),
-- names, and the text of any dietary or accessibility note (decision Q2). The fingerprint is a
-- SHA-256 over a canonical form of the send in which notes are reduced to "present or not", so the
-- record cannot be used to guess what a guest wrote.
--
-- Only sends that change something are recorded, like audit_events and rsvp_changes: a retry that
-- says what is already saved writes nothing. Clients cannot write; owner and partner can read.

-- ---------------------------------------------------------------- the table
create table public.rsvp_submissions (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  -- Shared by every row written by one party send.
  send_id uuid not null,
  invitation_id uuid not null,
  event_id uuid not null,
  -- Set when the guest used the one link for all events.
  party_id uuid,
  submitted_at timestamptz not null default now(),
  -- The guest form is fixed today (no form builder yet), so this is always 1. A later form builder
  -- records the published version here.
  form_version integer not null default 1 check (form_version >= 1),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  -- The invitation's version and the workspace revision once this send was accepted.
  invitation_version integer not null check (invitation_version >= 1),
  accepted_revision integer not null check (accepted_revision >= 0),
  accepted_count integer not null default 0 check (accepted_count >= 0),
  declined_count integer not null default 0 check (declined_count >= 0),
  plus_one_added boolean not null default false,
  details_count integer not null default 0 check (details_count >= 0),
  foreign key (wedding_id, invitation_id, event_id)
    references public.invitations (wedding_id, id, event_id) on delete cascade,
  foreign key (wedding_id, party_id) references public.invitation_parties (wedding_id, id) on delete cascade
);
create index rsvp_submissions_invitation_idx
  on public.rsvp_submissions (wedding_id, invitation_id, submitted_at desc, id);
create index rsvp_submissions_event_idx
  on public.rsvp_submissions (wedding_id, event_id, submitted_at desc, id);
create index rsvp_submissions_send_idx on public.rsvp_submissions (wedding_id, send_id);

-- Same rule as rsvp_changes: no update, no delete, except the cascade of erasing a whole wedding,
-- event or invitation.
create trigger rsvp_submissions_no_update before update or delete on public.rsvp_submissions
  for each row execute function app_private.history_append_only();

alter table public.rsvp_submissions enable row level security;
revoke all on public.rsvp_submissions from anon, authenticated;
grant select on public.rsvp_submissions to authenticated;
create policy rsvp_submissions_select_managers on public.rsvp_submissions
  for select to authenticated using (app_private.can_manage_guests(wedding_id));

-- ---------------------------------------------------------------- fingerprint
-- Canonical form of one invitation's send: answers sorted by member id, meal ids as sent, a
-- plus-one's name lower-cased with spaces collapsed (the same match the apply helper uses), and for
-- every note only whether it was filled in. Called after the apply helper has validated the payload.
create function app_private.rsvp_payload_hash(p_responses jsonb, p_plus_one jsonb) returns text
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

-- ---------------------------------------------------------------- recording one row
-- The caller holds the guests advisory lock and has already applied the send, bumped the workspace
-- revision and the invitation version (p_res is rsvp_apply_invitation's result).
create function app_private.rsvp_record_submission(
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
    accepted_revision, accepted_count, declined_count, plus_one_added, details_count)
  values (
    v_inv.wedding_id, p_send, v_inv.id, v_inv.event_id, p_party,
    app_private.rsvp_payload_hash(p_responses, p_plus_one), v_inv.version, p_revision,
    (p_res ->> 'accepted')::int, (p_res ->> 'declined')::int,
    (p_res ->> 'plusOneAdded')::boolean, (p_res ->> 'details')::int);
end;
$$;
revoke all on function app_private.rsvp_record_submission(uuid, uuid, uuid, jsonb, jsonb, jsonb, integer)
  from public, anon, authenticated;

-- ---------------------------------------------------------------- single-event submit
-- Unchanged from UX-06 except that a send that changed something is also recorded.
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
    perform app_private.rsvp_record_submission(
      gen_random_uuid(), v_inv.id, null, p_responses, p_plus_one, v_res, v_revision);
  end if;
  return app_private.rsvp_projection(v_inv.id);
end;
$$;

-- ---------------------------------------------------------------- party submit
-- Unchanged from UX-06 except that every event the send changed is also recorded, all under one
-- send_id.
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
                                   'party_link', true),
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
