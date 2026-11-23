-- UX-16: guest email outbox (wedding_ux_rsvp_audit_output/GAP_BACKLOG.md; ADR-031 UX-16 addendum).
--
-- The couple can prepare two kinds of email to guests, review each one, and approve it one at a time:
--
--   rsvp_confirmation  "we have your reply": who is attending each event and any meal chosen.
--   reply_reminder     "we're still waiting for your reply" to people whose answer is pending.
--
-- Nothing here sends mail. The app composes the text from the current guest state, stores it as a
-- draft, and an owner approves it. Approval moves the row to 'sending' (begin_guest_message_send);
-- the app then calls the mail provider and records what the provider said
-- (finish_guest_message_send). Until a provider is chosen the app reports "email isn't set up" and
-- never claims a send. The row id is the provider idempotency key, so a retry after a lost answer
-- cannot send twice through a provider that honours it.
--
-- Rules:
--   * Prepare and discard: anyone who manages guests (owner, partner, a planner with the guests
--     grant). Approving a send: the owner only, matching the `external.send` capability.
--   * The recipient address is copied from the guest row when the draft is made, never taken from
--     the caller. Approval refuses (GM409) if the guest's address changed or was removed, if the
--     invitation was revoked, or (for a reminder) if the person has since replied.
--   * One draft per dedupe key: repeating "prepare" cannot create a second copy of the same message.
--   * Each draft carries a fingerprint of the invitation's replies (who, answer, meal) taken from the
--     same read the text was written from. Prepare skips an item whose fingerprint no longer
--     matches, and approval refuses (GM409) once a reply or meal changed, so an approved message
--     never describes replies that are out of date.
--   * Bodies never contain the RSVP link (raw tokens are not stored, ADR-028), dietary or access
--     notes, private notes, or answers to the couple's questions. The text itself is not copied into
--     audit_events.
--   * A stale 'sending' row (no outcome after 10 minutes, such as a crash mid-send) can be approved
--     again; the provider key stays the same.

-- ---------------------------------------------------------------- the table
create table public.guest_messages (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  event_id uuid not null,
  invitation_id uuid not null,
  guest_id uuid not null,
  kind text not null check (kind in ('rsvp_confirmation', 'reply_reminder')),
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 200),
  recipient_email text not null
    check (char_length(recipient_email) between 3 and 254 and recipient_email = lower(btrim(recipient_email))),
  subject text not null check (char_length(subject) between 1 and 200 and subject !~ '[[:cntrl:]]'),
  body text not null check (char_length(body) between 1 and 5000),
  state_hash text not null check (state_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'draft' check (status in ('draft', 'sending', 'sent', 'failed', 'cancelled')),
  attempts integer not null default 0 check (attempts >= 0),
  provider text check (provider is null or char_length(provider) between 1 and 40),
  provider_receipt text check (provider_receipt is null or char_length(provider_receipt) between 1 and 200),
  last_error text check (last_error is null or char_length(last_error) between 1 and 300),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  sending_since timestamptz,
  sent_at timestamptz,
  cancelled_at timestamptz,
  version integer not null default 1 check (version >= 1),
  updated_at timestamptz not null default now(),
  unique (wedding_id, id),
  unique (wedding_id, dedupe_key),
  check ((status = 'sending') = (sending_since is not null)),
  check ((status = 'sent') = (sent_at is not null and provider_receipt is not null)),
  foreign key (wedding_id, invitation_id, event_id)
    references public.invitations (wedding_id, id, event_id) on delete cascade,
  foreign key (wedding_id, guest_id) references public.guests (wedding_id, id) on delete cascade
);
create index guest_messages_event_idx on public.guest_messages (wedding_id, event_id, created_at desc, id);
create trigger guest_messages_touch before update on public.guest_messages
  for each row execute function app_private.touch_updated_at();

alter table public.guest_messages enable row level security;
revoke all on public.guest_messages from anon, authenticated;
grant select on public.guest_messages to authenticated;
create policy guest_messages_select_managers on public.guest_messages
  for select to authenticated using (app_private.can_manage_guests(wedding_id));

-- ---------------------------------------------------------------- reply fingerprint
-- SHA-256 over the invitation's active people in guest id order: "guestId:status:mealId" joined by
-- commas (empty meal id when none). src/server/guests/messages.ts builds the same string.
create function app_private.guest_message_state(p_invitation uuid) returns text
language sql stable
set search_path = ''
as $$
  select encode(sha256(convert_to(coalesce(string_agg(
           m.guest_id::text || ':' || m.rsvp_status || ':' || coalesce(m.meal_option_id::text, ''),
           ',' order by m.guest_id), ''), 'UTF8')), 'hex')
    from public.invitation_members m
   where m.invitation_id = p_invitation and m.active;
$$;
revoke all on function app_private.guest_message_state(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- checks shared by prepare and send
-- Null when the message may still go out; otherwise a short reason. Caller holds the guests lock.
create function app_private.guest_message_blocker(
  p_wedding uuid, p_kind text, p_invitation uuid, p_guest uuid, p_email text, p_state text
) returns text
language plpgsql stable
set search_path = ''
as $$
declare
  v_inv public.invitations%rowtype;
  v_member public.invitation_members%rowtype;
  v_guest public.guests%rowtype;
begin
  select * into v_inv from public.invitations where id = p_invitation and wedding_id = p_wedding;
  if not found or v_inv.revoked_at is not null then
    return 'invitation';
  end if;
  select * into v_member from public.invitation_members
    where invitation_id = p_invitation and guest_id = p_guest and active;
  if not found then
    return 'member';
  end if;
  select * into v_guest from public.guests where id = p_guest and wedding_id = p_wedding;
  if not found or v_guest.archived_at is not null then
    return 'guest';
  end if;
  if v_guest.email is null or (p_email is not null and v_guest.email <> p_email) then
    return 'email';
  end if;
  if app_private.guest_message_state(p_invitation) <> p_state then
    return 'changed';
  end if;
  if p_kind = 'reply_reminder' then
    if v_member.rsvp_status <> 'pending' then
      return 'replied';
    end if;
    if v_inv.expires_at <= now() or (v_inv.deadline is not null and v_inv.deadline <= now()) then
      return 'closed';
    end if;
  elsif p_kind = 'rsvp_confirmation' then
    if not exists (select 1 from public.rsvp_submissions where invitation_id = p_invitation) then
      return 'no_reply';
    end if;
  end if;
  return null;
end;
$$;
revoke all on function app_private.guest_message_blocker(uuid, text, uuid, uuid, text, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------- prepare
-- p_items: up to 200 of { kind, invitationId, guestId, dedupeKey, stateHash, subject, body }. Malformed input
-- raises 22023. An item that no longer applies (replied, revoked, no address...) or whose key already
-- exists is skipped. Returns { created, skipped }.
create function public.prepare_guest_messages(p_wedding uuid, p_items jsonb) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_item jsonb;
  v_kind text;
  v_inv uuid;
  v_guest uuid;
  v_event uuid;
  v_email text;
  v_created integer := 0;
  v_skipped integer := 0;
  v_id uuid;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) > 200 then
    raise exception 'invalid items' using errcode = '22023';
  end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) <> 'object'
       or coalesce(jsonb_typeof(v_item -> 'kind'), '') <> 'string'
       or (v_item ->> 'kind') not in ('rsvp_confirmation', 'reply_reminder')
       or coalesce(jsonb_typeof(v_item -> 'invitationId'), '') <> 'string'
       or (v_item ->> 'invitationId') !~ '^[0-9a-f-]{36}$'
       or coalesce(jsonb_typeof(v_item -> 'guestId'), '') <> 'string'
       or (v_item ->> 'guestId') !~ '^[0-9a-f-]{36}$'
       or coalesce(jsonb_typeof(v_item -> 'dedupeKey'), '') <> 'string'
       or coalesce(jsonb_typeof(v_item -> 'stateHash'), '') <> 'string'
       or (v_item ->> 'stateHash') !~ '^[0-9a-f]{64}$'
       or coalesce(jsonb_typeof(v_item -> 'subject'), '') <> 'string'
       or coalesce(jsonb_typeof(v_item -> 'body'), '') <> 'string'
       or char_length(v_item ->> 'dedupeKey') not between 1 and 200
       or char_length(v_item ->> 'subject') not between 1 and 200
       or (v_item ->> 'subject') ~ '[[:cntrl:]]'
       or char_length(v_item ->> 'body') not between 1 and 5000 then
      raise exception 'invalid items' using errcode = '22023';
    end if;
    v_kind := v_item ->> 'kind';
    v_inv := (v_item ->> 'invitationId')::uuid;
    v_guest := (v_item ->> 'guestId')::uuid;
    if app_private.guest_message_blocker(
         p_wedding, v_kind, v_inv, v_guest, null, v_item ->> 'stateHash') is not null then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    select event_id into v_event from public.invitations where id = v_inv;
    select email into v_email from public.guests where id = v_guest;
    insert into public.guest_messages (
      wedding_id, event_id, invitation_id, guest_id, kind, dedupe_key, recipient_email, subject, body,
      state_hash, created_by)
    values (p_wedding, v_event, v_inv, v_guest, v_kind, v_item ->> 'dedupeKey', v_email,
            v_item ->> 'subject', v_item ->> 'body', v_item ->> 'stateHash', v_user)
    on conflict (wedding_id, dedupe_key) do nothing
    returning id into v_id;
    if v_id is null then
      v_skipped := v_skipped + 1;
    else
      v_created := v_created + 1;
    end if;
    v_id := null;
  end loop;
  if v_created > 0 then
    insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
      values (p_wedding, v_user, 'wedding', p_wedding, 'guest_messages.prepared',
              jsonb_build_object('created', v_created, 'skipped', v_skipped), v_wedding.revision);
  end if;
  return jsonb_build_object('created', v_created, 'skipped', v_skipped);
end;
$$;

-- ---------------------------------------------------------------- discard
-- A draft or failed message the couple doesn't want. Errors: 42501, 55000 (changed since read or
-- not discardable).
create function public.discard_guest_message(p_wedding uuid, p_message uuid, p_expected_version integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_msg public.guest_messages%rowtype;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  select * into v_msg from public.guest_messages
    where id = p_message and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_msg.version <> p_expected_version or v_msg.status not in ('draft', 'failed') then
    raise exception 'version conflict' using errcode = '55000';
  end if;
  update public.guest_messages
     set status = 'cancelled', cancelled_at = now(), version = version + 1
   where id = p_message
   returning * into v_msg;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'guest_message', p_message, 'guest_message.discarded',
            jsonb_build_object('kind', v_msg.kind), v_wedding.revision);
  return v_msg.version;
end;
$$;

-- ---------------------------------------------------------------- approve and send (step 1)
-- The owner approves one message. Returns what to send: { id, version, to, subject, body }.
-- Errors: 28000, 42501 (not the owner), 55000 (changed since read, or already sent/cancelled/in
-- flight), GM409 (no longer applies: address changed, revoked, replies changed, reply date passed).
create function public.begin_guest_message_send(p_wedding uuid, p_message uuid, p_expected_version integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_msg public.guest_messages%rowtype;
  v_blocker text;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app_private.has_role(p_wedding, array['owner']::public.membership_role[]) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('guests:' || p_wedding::text, 0));
  select * into v_wedding from public.weddings where id = p_wedding for share;
  select * into v_msg from public.guest_messages
    where id = p_message and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_msg.version <> p_expected_version
     or not (v_msg.status in ('draft', 'failed')
             or (v_msg.status = 'sending' and v_msg.sending_since < now() - interval '10 minutes')) then
    raise exception 'version conflict' using errcode = '55000';
  end if;
  v_blocker := app_private.guest_message_blocker(
    p_wedding, v_msg.kind, v_msg.invitation_id, v_msg.guest_id, v_msg.recipient_email, v_msg.state_hash);
  if v_blocker is not null then
    raise exception 'message no longer applies: %', v_blocker using errcode = 'GM409';
  end if;
  update public.guest_messages
     set status = 'sending', sending_since = now(), approved_by = v_user, approved_at = now(),
         attempts = attempts + 1, last_error = null, version = version + 1
   where id = p_message
   returning * into v_msg;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'guest_message', p_message, 'guest_message.approved',
            jsonb_build_object('kind', v_msg.kind, 'attempt', v_msg.attempts), v_wedding.revision);
  return jsonb_build_object('id', v_msg.id, 'version', v_msg.version, 'to', v_msg.recipient_email,
                            'subject', v_msg.subject, 'body', v_msg.body);
end;
$$;

-- ---------------------------------------------------------------- approve and send (step 2)
-- Records what the provider said for the attempt begun at p_version.
--   succeeded     → sent (provider and receipt required)
--   failed        → failed (p_error, short and free of message content)
--   rate_limited  → failed
--   unconfigured  → back to draft; nothing was sent
-- Errors: 28000, 42501, 55000 (not the attempt in flight), 22023 (bad outcome).
create function public.finish_guest_message_send(
  p_wedding uuid, p_message uuid, p_version integer, p_outcome text,
  p_provider text default null, p_receipt text default null, p_error text default null
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_msg public.guest_messages%rowtype;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app_private.has_role(p_wedding, array['owner']::public.membership_role[]) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_outcome not in ('succeeded', 'failed', 'rate_limited', 'unconfigured')
     or (p_outcome = 'succeeded' and (nullif(btrim(p_provider), '') is null or nullif(btrim(p_receipt), '') is null)) then
    raise exception 'invalid outcome' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('guests:' || p_wedding::text, 0));
  select * into v_wedding from public.weddings where id = p_wedding for share;
  select * into v_msg from public.guest_messages
    where id = p_message and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_msg.status <> 'sending' or v_msg.version <> p_version then
    raise exception 'version conflict' using errcode = '55000';
  end if;
  if p_outcome = 'succeeded' then
    update public.guest_messages
       set status = 'sent', sending_since = null, sent_at = now(), provider = left(btrim(p_provider), 40),
           provider_receipt = left(btrim(p_receipt), 200), version = version + 1
     where id = p_message returning * into v_msg;
  elsif p_outcome = 'unconfigured' then
    update public.guest_messages
       set status = 'draft', sending_since = null, approved_by = null, approved_at = null,
           version = version + 1
     where id = p_message returning * into v_msg;
  else
    update public.guest_messages
       set status = 'failed', sending_since = null,
           last_error = left(coalesce(nullif(btrim(p_error), ''), p_outcome), 300),
           provider = left(nullif(btrim(p_provider), ''), 40), version = version + 1
     where id = p_message returning * into v_msg;
  end if;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'guest_message', p_message,
            case p_outcome when 'succeeded' then 'guest_message.sent'
                           when 'unconfigured' then 'guest_message.not_sent'
                           else 'guest_message.failed' end,
            jsonb_build_object('kind', v_msg.kind, 'outcome', p_outcome, 'provider', v_msg.provider),
            v_wedding.revision);
  return v_msg.version;
end;
$$;

revoke all on function public.prepare_guest_messages(uuid, jsonb),
  public.discard_guest_message(uuid, uuid, integer),
  public.begin_guest_message_send(uuid, uuid, integer),
  public.finish_guest_message_send(uuid, uuid, integer, text, text, text, text)
  from public, anon;
grant execute on function public.prepare_guest_messages(uuid, jsonb),
  public.discard_guest_message(uuid, uuid, integer),
  public.begin_guest_message_send(uuid, uuid, integer),
  public.finish_guest_message_send(uuid, uuid, integer, text, text, text, text)
  to authenticated;
