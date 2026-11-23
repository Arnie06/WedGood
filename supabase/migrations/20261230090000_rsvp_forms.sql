-- UX-11: RSVP form builder (wedding_ux_rsvp_audit_output/GAP_BACKLOG.md; ADR-031 UX-11 addendum).
--
-- The couple can add their own questions to each event's guest reply. The built-in steps
-- (attendance, meals, notes for the couple, plus-one) stay fixed and are not part of the form.
--
--   rsvp_forms          one per event: the draft the couple is editing, with an optimistic version,
--                       and which published version guests see.
--   rsvp_form_versions  immutable published definitions (append-only). Guests always answer a
--                       published version, never the draft.
--   rsvp_answers        the current answer per person and question. Answer-only: nothing else in the
--                       app reads these values (no mapping to dietary, seating, budget or any module).
--
-- Rules:
--   * A question keeps its type for the life of the form (its key is never reused for another
--     type), so a stored answer always means what it meant when it was given (RF409).
--   * A guest send names the published version it answered. If the couple published again since
--     the guest opened the link, the send is refused as stale (55000) and the guest sees the new form.
--   * Required questions must have an answer (sent now or stored earlier) for every attending
--     person when the send names a version (RF422). A send that names no version (the feature switch
--     is off, or an old page) carries no answers and is accepted as before.
--   * Answers are never returned through a guest link (a party link is shared by a household): the
--     link only learns which questions are answered. They never reach audit_events, rsvp_changes or
--     rsvp_submissions as text.

-- ---------------------------------------------------------------- tables
create table public.rsvp_forms (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  event_id uuid not null,
  draft jsonb not null default '{"questions": []}'::jsonb,
  version integer not null default 1 check (version >= 1),
  published_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (wedding_id, id),
  unique (event_id),
  foreign key (wedding_id, event_id) references public.events (wedding_id, id) on delete cascade
);

create table public.rsvp_form_versions (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  form_id uuid not null,
  event_id uuid not null,
  version integer not null check (version >= 1),
  definition jsonb not null,
  published_at timestamptz not null default now(),
  published_by uuid,
  unique (wedding_id, id),
  unique (wedding_id, id, event_id),
  unique (form_id, version),
  foreign key (wedding_id, form_id) references public.rsvp_forms (wedding_id, id) on delete cascade
);
create trigger rsvp_form_versions_no_update before update or delete on public.rsvp_form_versions
  for each row execute function app_private.history_append_only();

alter table public.rsvp_forms
  add foreign key (wedding_id, published_version_id)
  references public.rsvp_form_versions (wedding_id, id);

create table public.rsvp_answers (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  event_id uuid not null,
  invitation_id uuid not null,
  member_id uuid not null,
  guest_id uuid not null,
  -- The published version the current value was given in; its definition names the question.
  form_version_id uuid not null,
  question_key text not null check (question_key ~ '^q_[a-z0-9]{8}$'),
  value text not null check (char_length(value) between 1 and 500),
  answered_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (member_id, question_key),
  foreign key (wedding_id, member_id) references public.invitation_members (wedding_id, id) on delete cascade,
  foreign key (wedding_id, invitation_id, event_id)
    references public.invitations (wedding_id, id, event_id) on delete cascade,
  foreign key (wedding_id, form_version_id, event_id)
    references public.rsvp_form_versions (wedding_id, id, event_id),
  foreign key (wedding_id, guest_id) references public.guests (wedding_id, id)
);
create index rsvp_answers_event_idx on public.rsvp_answers (wedding_id, event_id, question_key);

alter table public.rsvp_forms enable row level security;
alter table public.rsvp_form_versions enable row level security;
alter table public.rsvp_answers enable row level security;
revoke all on public.rsvp_forms, public.rsvp_form_versions, public.rsvp_answers from anon, authenticated;
grant select on public.rsvp_forms, public.rsvp_form_versions, public.rsvp_answers to authenticated;
create policy rsvp_forms_select_managers on public.rsvp_forms
  for select to authenticated using (app_private.can_manage_guests(wedding_id));
create policy rsvp_form_versions_select_managers on public.rsvp_form_versions
  for select to authenticated using (app_private.can_manage_guests(wedding_id));
create policy rsvp_answers_select_managers on public.rsvp_answers
  for select to authenticated using (app_private.can_manage_guests(wedding_id));

-- The record of each send learns which published form it answered and for how many people.
-- Nullable with no default: existing rows are untouched (the append-only trigger is not involved).
-- form_version keeps meaning "1 = the fixed form" when form_version_id is null.
alter table public.rsvp_submissions
  add column form_version_id uuid,
  add column answers_count integer not null default 0 check (answers_count >= 0),
  add foreign key (wedding_id, form_version_id) references public.rsvp_form_versions (wedding_id, id);

-- ---------------------------------------------------------------- definition checks
-- Returns the canonical definition or raises 22023. Canonical: { "questions": [ { key, type, label,
-- help (text or null), required, options ([] unless type is choice) } ] }. Labels are trimmed and
-- spaces collapsed. Limits match src/domain/guests/rsvp-form.ts.
create function app_private.rsvp_form_normalize(p_def jsonb) returns jsonb
language plpgsql immutable
set search_path = ''
as $$
declare
  v_q jsonb;
  v_o jsonb;
  v_out jsonb := '[]'::jsonb;
  v_opts jsonb;
  v_keys text[] := '{}';
  v_okeys text[];
  v_olabels text[];
  v_label text;
  v_help text;
  v_olabel text;
begin
  if jsonb_typeof(p_def) is distinct from 'object'
     or jsonb_typeof(p_def -> 'questions') is distinct from 'array'
     or jsonb_array_length(p_def -> 'questions') > 10 then
    raise exception 'invalid form' using errcode = '22023';
  end if;
  for v_q in select * from jsonb_array_elements(p_def -> 'questions') loop
    if jsonb_typeof(v_q) <> 'object'
       or coalesce(jsonb_typeof(v_q -> 'key'), '') <> 'string'
       or (v_q ->> 'key') !~ '^q_[a-z0-9]{8}$'
       or (v_q ->> 'key') = any (v_keys)
       or coalesce(jsonb_typeof(v_q -> 'type'), '') <> 'string'
       or (v_q ->> 'type') not in ('text', 'yes_no', 'choice')
       or coalesce(jsonb_typeof(v_q -> 'label'), '') <> 'string'
       or coalesce(jsonb_typeof(v_q -> 'help'), 'null') not in ('null', 'string')
       or coalesce(jsonb_typeof(v_q -> 'required'), '') <> 'boolean'
       or coalesce(jsonb_typeof(v_q -> 'options'), 'null') not in ('null', 'array') then
      raise exception 'invalid form' using errcode = '22023';
    end if;
    v_keys := v_keys || (v_q ->> 'key');
    v_label := regexp_replace(btrim(v_q ->> 'label'), '\s+', ' ', 'g');
    v_help := nullif(regexp_replace(btrim(coalesce(v_q ->> 'help', '')), '\s+', ' ', 'g'), '');
    if char_length(v_label) not between 1 and 200 or char_length(v_help) > 300 then
      raise exception 'invalid form' using errcode = '22023';
    end if;
    v_opts := '[]'::jsonb;
    if v_q ->> 'type' = 'choice' then
      if jsonb_typeof(v_q -> 'options') is distinct from 'array'
         or jsonb_array_length(v_q -> 'options') not between 2 and 10 then
        raise exception 'invalid form' using errcode = '22023';
      end if;
      v_okeys := '{}';
      v_olabels := '{}';
      for v_o in select * from jsonb_array_elements(v_q -> 'options') loop
        if jsonb_typeof(v_o) <> 'object'
           or coalesce(jsonb_typeof(v_o -> 'key'), '') <> 'string'
           or (v_o ->> 'key') !~ '^o_[a-z0-9]{6}$'
           or (v_o ->> 'key') = any (v_okeys)
           or coalesce(jsonb_typeof(v_o -> 'label'), '') <> 'string' then
          raise exception 'invalid form' using errcode = '22023';
        end if;
        v_olabel := regexp_replace(btrim(v_o ->> 'label'), '\s+', ' ', 'g');
        if char_length(v_olabel) not between 1 and 80 or lower(v_olabel) = any (v_olabels) then
          raise exception 'invalid form' using errcode = '22023';
        end if;
        v_okeys := v_okeys || (v_o ->> 'key');
        v_olabels := v_olabels || lower(v_olabel);
        v_opts := v_opts || jsonb_build_array(jsonb_build_object('key', v_o ->> 'key', 'label', v_olabel));
      end loop;
    elsif jsonb_typeof(v_q -> 'options') = 'array' and jsonb_array_length(v_q -> 'options') > 0 then
      raise exception 'invalid form' using errcode = '22023';
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'key', v_q ->> 'key', 'type', v_q ->> 'type', 'label', v_label, 'help', v_help,
      'required', (v_q ->> 'required')::boolean, 'options', v_opts));
  end loop;
  return jsonb_build_object('questions', v_out);
end;
$$;
revoke all on function app_private.rsvp_form_normalize(jsonb) from public, anon, authenticated;

-- A question key keeps the type it was first published with (RF409).
create function app_private.rsvp_form_check_types(p_form uuid, p_def jsonb) returns void
language plpgsql stable
set search_path = ''
as $$
begin
  if exists (
    select 1
      from jsonb_array_elements(p_def -> 'questions') q
      join public.rsvp_form_versions v on v.form_id = p_form
      cross join lateral jsonb_array_elements(v.definition -> 'questions') old
     where old ->> 'key' = q ->> 'key' and old ->> 'type' <> q ->> 'type') then
    raise exception 'question type changed' using errcode = 'RF409';
  end if;
end;
$$;
revoke all on function app_private.rsvp_form_check_types(uuid, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------- owner RPCs
-- Saves the whole draft. p_expected_version 0 means "no form yet". Returns the new draft version.
-- Errors: 42501 not permitted, 55000 someone saved first, 22023 invalid draft, RF409 a published
-- question's type changed.
create function public.save_rsvp_form_draft(
  p_wedding uuid, p_event_id uuid, p_expected_version integer, p_draft jsonb
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_def jsonb;
  v_form public.rsvp_forms%rowtype;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  if not exists (select 1 from public.events where id = p_event_id and wedding_id = p_wedding) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  v_def := app_private.rsvp_form_normalize(p_draft);
  select * into v_form from public.rsvp_forms
    where wedding_id = p_wedding and event_id = p_event_id for update;
  if not found then
    if p_expected_version <> 0 then
      raise exception 'version conflict' using errcode = '55000';
    end if;
    insert into public.rsvp_forms (wedding_id, event_id, draft)
      values (p_wedding, p_event_id, v_def)
      returning * into v_form;
  else
    if v_form.version <> p_expected_version then
      raise exception 'version conflict' using errcode = '55000';
    end if;
    perform app_private.rsvp_form_check_types(v_form.id, v_def);
    if v_form.draft = v_def then
      return v_form.version; -- nothing changed
    end if;
    update public.rsvp_forms set draft = v_def, version = version + 1, updated_at = now()
      where id = v_form.id
      returning * into v_form;
  end if;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'rsvp_form', v_form.id, 'rsvp_form.draft_saved',
            jsonb_build_object('questions', jsonb_array_length(v_def -> 'questions')), v_wedding.revision);
  return v_form.version;
end;
$$;

-- Publishes the saved draft the caller was looking at. Returns the published version number;
-- publishing a draft identical to what guests already see returns that version and writes nothing.
-- Errors: 42501, 55000 (no form, or the draft changed since it was read), RF409.
create function public.publish_rsvp_form(p_wedding uuid, p_event_id uuid, p_expected_version integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_form public.rsvp_forms%rowtype;
  v_current public.rsvp_form_versions%rowtype;
  v_next integer;
  v_id uuid;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  select * into v_form from public.rsvp_forms
    where wedding_id = p_wedding and event_id = p_event_id for update;
  if not found or v_form.version <> p_expected_version then
    raise exception 'version conflict' using errcode = '55000';
  end if;
  perform app_private.rsvp_form_check_types(v_form.id, v_form.draft);
  if v_form.published_version_id is not null then
    select * into v_current from public.rsvp_form_versions where id = v_form.published_version_id;
    if v_current.definition = v_form.draft then
      return v_current.version;
    end if;
  end if;
  select coalesce(max(version), 0) + 1 into v_next from public.rsvp_form_versions where form_id = v_form.id;
  insert into public.rsvp_form_versions (wedding_id, form_id, event_id, version, definition, published_by)
    values (p_wedding, v_form.id, p_event_id, v_next, v_form.draft, v_user)
    returning id into v_id;
  update public.rsvp_forms
    set published_version_id = v_id, version = version + 1, updated_at = now()
    where id = v_form.id;
  update public.weddings set revision = revision + 1 where id = p_wedding
    returning * into v_wedding;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'rsvp_form', v_form.id, 'rsvp_form.published',
            jsonb_build_object('version', v_next,
                               'questions', jsonb_array_length(v_form.draft -> 'questions')),
            v_wedding.revision);
  return v_next;
end;
$$;

revoke all on function public.save_rsvp_form_draft(uuid, uuid, integer, jsonb),
  public.publish_rsvp_form(uuid, uuid, integer) from public, anon;
grant execute on function public.save_rsvp_form_draft(uuid, uuid, integer, jsonb),
  public.publish_rsvp_form(uuid, uuid, integer) to authenticated;

-- ---------------------------------------------------------------- storing one person's answers
-- p_src is the member's response object (or the plus-one object); its "answers" is null or an
-- object { questionKey: text }. Blank means "keep what is stored". Values: text 1..500 characters,
-- yes_no "yes" or "no", choice an option key of that question. Anything else, or a key not in the
-- version, is refused (22023). Then every required question of the version must have an answer
-- for this person (RF422). Returns the number of answers written (a retry that says what is
-- already stored writes nothing). The caller holds the guests advisory lock.
create function app_private.rsvp_save_answers(p_member uuid, p_src jsonb, p_version uuid) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_m public.invitation_members%rowtype;
  v_def jsonb;
  v_ans jsonb;
  v_key text;
  v_raw jsonb;
  v_val text;
  v_q jsonb;
  v_n integer := 0;
  v_rows integer;
begin
  v_ans := case when jsonb_typeof(p_src) = 'object' then p_src -> 'answers' end;
  if coalesce(jsonb_typeof(v_ans), 'null') not in ('null', 'object') then
    raise exception 'invalid response' using errcode = '22023';
  end if;
  if p_version is null then
    if jsonb_typeof(v_ans) = 'object' and v_ans <> '{}'::jsonb then
      raise exception 'invalid response' using errcode = '22023';
    end if;
    return 0;
  end if;
  select * into v_m from public.invitation_members where id = p_member and active;
  if not found then
    raise exception 'invalid response' using errcode = '22023';
  end if;
  select definition into v_def from public.rsvp_form_versions
    where id = p_version and wedding_id = v_m.wedding_id and event_id = v_m.event_id;
  if v_def is null then
    raise exception 'invalid response' using errcode = '22023';
  end if;
  v_ans := coalesce(v_ans, '{}'::jsonb);

  for v_key, v_raw in select * from jsonb_each(v_ans) loop
    select q into v_q from jsonb_array_elements(v_def -> 'questions') q where q ->> 'key' = v_key;
    if v_q is null or jsonb_typeof(v_raw) <> 'string' then
      raise exception 'invalid response' using errcode = '22023';
    end if;
    v_val := btrim(v_raw #>> '{}');
    if v_val = '' then
      continue;
    end if;
    if (v_q ->> 'type' = 'text' and char_length(v_val) > 500)
       or (v_q ->> 'type' = 'yes_no' and v_val not in ('yes', 'no'))
       or (v_q ->> 'type' = 'choice' and not exists (
             select 1 from jsonb_array_elements(v_q -> 'options') o where o ->> 'key' = v_val)) then
      raise exception 'invalid response' using errcode = '22023';
    end if;
    insert into public.rsvp_answers (wedding_id, event_id, invitation_id, member_id, guest_id,
                                     form_version_id, question_key, value)
      values (v_m.wedding_id, v_m.event_id, v_m.invitation_id, v_m.id, v_m.guest_id,
              p_version, v_key, v_val)
      on conflict (member_id, question_key) do update
        set value = excluded.value, form_version_id = excluded.form_version_id, updated_at = now()
        where public.rsvp_answers.value is distinct from excluded.value;
    get diagnostics v_rows = row_count;
    v_n := v_n + v_rows;
  end loop;

  if exists (
    select 1 from jsonb_array_elements(v_def -> 'questions') q
     where (q ->> 'required')::boolean
       and not exists (select 1 from public.rsvp_answers a
                        where a.member_id = v_m.id and a.question_key = q ->> 'key')) then
    raise exception 'answer required' using errcode = 'RF422';
  end if;
  return v_n;
end;
$$;
revoke all on function app_private.rsvp_save_answers(uuid, jsonb, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- one invitation, with the form
-- Runs the unchanged UX-09 apply helper, then the form answers for each person attending in this
-- send (and the new plus-one, found the same way the helper finds them). An answers-only change
-- counts as a change: the invitation version moves, so a stale second tab is refused. Declines carry
-- no answers (ignored, like notes). Returns the helper's result plus "answers" (people whose answers
-- changed).
create function app_private.rsvp_apply_with_form(
  p_invitation uuid, p_responses jsonb, p_plus_one jsonb, p_party uuid, p_form uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv public.invitations%rowtype;
  v_published uuid;
  v_res jsonb;
  v_r jsonb;
  v_people integer := 0;
  v_name text;
  v_member uuid;
begin
  select * into v_inv from public.invitations where id = p_invitation;
  select f.published_version_id into v_published from public.rsvp_forms f
    where f.event_id = v_inv.event_id and f.wedding_id = v_inv.wedding_id;
  -- The guest answered a form the couple has since replaced: show them the new one.
  if p_form is not null and p_form is distinct from v_published then
    raise exception 'form changed' using errcode = '55000';
  end if;

  v_res := app_private.rsvp_apply_invitation(p_invitation, p_responses, p_plus_one, p_party);

  for v_r in select * from jsonb_array_elements(p_responses) loop
    if v_r ->> 'status' = 'accepted' then
      if app_private.rsvp_save_answers((v_r ->> 'memberId')::uuid, v_r, p_form) > 0 then
        v_people := v_people + 1;
      end if;
    end if;
  end loop;
  if jsonb_typeof(p_plus_one) = 'object' then
    v_name := regexp_replace(btrim(p_plus_one ->> 'name'), '\s+', ' ', 'g');
    select im.id into v_member from public.invitation_members im
      join public.guests g on g.id = im.guest_id
      where im.invitation_id = v_inv.id and im.is_plus_one and im.active
        and lower(g.full_name) = lower(v_name);
    if app_private.rsvp_save_answers(v_member, p_plus_one, p_form) > 0 then
      v_people := v_people + 1;
    end if;
  end if;

  if v_people > 0 and not (v_res ->> 'changed')::boolean then
    update public.invitations set version = version + 1, last_responded_at = now() where id = v_inv.id;
  end if;
  return v_res || jsonb_build_object('changed', (v_res ->> 'changed')::boolean or v_people > 0,
                                     'answers', v_people);
end;
$$;
revoke all on function app_private.rsvp_apply_with_form(uuid, jsonb, jsonb, uuid, uuid)
  from public, anon, authenticated;

-- ---------------------------------------------------------------- fingerprint and record
-- Same as UX-09, plus a member's (or the plus-one's) answers when any were sent. A send without
-- answers hashes exactly as before. Answer values are included: the record is readable only by the
-- same people who can read rsvp_answers, unlike notes, which need the private-details grant.
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
                 || case when jsonb_typeof(r -> 'answers') = 'object' and r -> 'answers' <> '{}'::jsonb
                         then jsonb_build_object('answers', r -> 'answers') else '{}'::jsonb end
               order by r ->> 'memberId')
          from jsonb_array_elements(p_responses) r), '[]'::jsonb),
      'plusOne', case when jsonb_typeof(p_plus_one) = 'object' then jsonb_build_object(
                 'name', lower(regexp_replace(btrim(p_plus_one ->> 'name'), '\s+', ' ', 'g')),
                 'mealOptionId', p_plus_one ->> 'mealOptionId',
                 'dietary', nullif(btrim(p_plus_one ->> 'dietary'), '') is not null,
                 'accessibility', nullif(btrim(p_plus_one ->> 'accessibility'), '') is not null)
                 || case when jsonb_typeof(p_plus_one -> 'answers') = 'object'
                              and p_plus_one -> 'answers' <> '{}'::jsonb
                         then jsonb_build_object('answers', p_plus_one -> 'answers') else '{}'::jsonb end
               else 'null'::jsonb end
    )::text, 'UTF8')), 'hex');
$$;
revoke all on function app_private.rsvp_payload_hash(jsonb, jsonb) from public, anon, authenticated;

drop function app_private.rsvp_record_submission(uuid, uuid, uuid, jsonb, jsonb, jsonb, integer);
create function app_private.rsvp_record_submission(
  p_send uuid, p_invitation uuid, p_party uuid, p_responses jsonb, p_plus_one jsonb,
  p_res jsonb, p_revision integer, p_form uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv public.invitations%rowtype;
  v_form_number integer;
begin
  select * into v_inv from public.invitations where id = p_invitation;
  select version into v_form_number from public.rsvp_form_versions where id = p_form;
  insert into public.rsvp_submissions (
    wedding_id, send_id, invitation_id, event_id, party_id, form_version, form_version_id,
    payload_hash, invitation_version, accepted_revision, accepted_count, declined_count,
    plus_one_added, details_count, plus_ones_removed, answers_count)
  values (
    v_inv.wedding_id, p_send, v_inv.id, v_inv.event_id, p_party, coalesce(v_form_number, 1), p_form,
    app_private.rsvp_payload_hash(p_responses, p_plus_one), v_inv.version, p_revision,
    (p_res ->> 'accepted')::int, (p_res ->> 'declined')::int,
    (p_res ->> 'plusOneAdded')::boolean, (p_res ->> 'details')::int, (p_res ->> 'removed')::int,
    coalesce((p_res ->> 'answers')::int, 0));
end;
$$;
revoke all on function app_private.rsvp_record_submission(uuid, uuid, uuid, jsonb, jsonb, jsonb, integer, uuid)
  from public, anon, authenticated;

-- Audit detail shared by both submits. Extra keys appear only when non-zero, so other rows keep
-- their exact shape.
create function app_private.rsvp_audit_changes(p_res jsonb, p_party boolean) returns jsonb
language sql immutable
set search_path = ''
as $$
  select jsonb_build_object('accepted', (p_res ->> 'accepted')::int,
                            'declined', (p_res ->> 'declined')::int,
                            'plus_one_added', (p_res ->> 'plusOneAdded')::boolean)
         || case when p_party then jsonb_build_object('party_link', true) else '{}'::jsonb end
         || case when (p_res ->> 'removed')::int > 0
                 then jsonb_build_object('plus_ones_removed', (p_res ->> 'removed')::int)
                 else '{}'::jsonb end
         || case when coalesce((p_res ->> 'answers')::int, 0) > 0
                 then jsonb_build_object('answers', (p_res ->> 'answers')::int)
                 else '{}'::jsonb end;
$$;
revoke all on function app_private.rsvp_audit_changes(jsonb, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------- guest projection
-- Adds 'form' (null, or the published version: id, number and questions) and, per person,
-- 'answered' (the question keys with a stored answer; never the values). Unchanged otherwise.
create or replace function app_private.rsvp_projection(p_invitation uuid) returns jsonb
language sql stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'workspaceId', i.wedding_id,
    'weddingName', w.name,
    'label', i.label,
    'version', i.version,
    'deadline', i.deadline,
    'closed', (i.deadline is not null and now() > i.deadline),
    'plusOneRemaining', greatest(i.plus_one_quota - i.plus_ones_used, 0),
    'event', jsonb_build_object('name', e.name, 'kind', e.kind, 'localDate', e.local_date,
                                'timezone', coalesce(e.time_zone, w.timezone)),
    'mealOptions', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name) order by m.created_at, m.id)
                               from public.meal_options m where m.event_id = e.id and m.active), '[]'::jsonb),
    'form', (select jsonb_build_object('versionId', v.id, 'version', v.version,
                                       'questions', v.definition -> 'questions')
               from public.rsvp_forms f
               join public.rsvp_form_versions v on v.id = f.published_version_id
              where f.event_id = e.id and f.wedding_id = i.wedding_id),
    'members', coalesce((select jsonb_agg(jsonb_build_object(
                  'id', im.id, 'name', g.full_name, 'isPlusOne', im.is_plus_one,
                  'status', im.rsvp_status, 'mealOptionId', im.meal_option_id,
                  'detailsSaved', coalesce(d.guest_answered_at is not null
                                           and (d.dietary is not null or d.accessibility is not null), false),
                  'personKey', md5(i.wedding_id::text || ':' || g.id::text),
                  'answered', coalesce((select jsonb_agg(a.question_key order by a.question_key)
                                          from public.rsvp_answers a where a.member_id = im.id), '[]'::jsonb))
                  order by im.is_plus_one, g.full_name, im.id)
                from public.invitation_members im
                join public.guests g on g.id = im.guest_id and g.wedding_id = im.wedding_id
                left join public.guest_private_details d on d.guest_id = g.id
                where im.invitation_id = i.id and im.active), '[]'::jsonb))
  from public.invitations i
  join public.events e on e.id = i.event_id and e.wedding_id = i.wedding_id
  join public.weddings w on w.id = i.wedding_id
  where i.id = p_invitation;
$$;
revoke all on function app_private.rsvp_projection(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- single-event submit
-- Same as UX-09 plus p_form_version: the published form version the guest answered (null when the
-- page shows no custom questions).
drop function public.rsvp_submit(text, text, integer, jsonb, jsonb);
create function public.rsvp_submit(
  p_token_hash text, p_client text, p_expected_version integer, p_responses jsonb,
  p_plus_one jsonb default null, p_form_version uuid default null
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
  v_res := app_private.rsvp_apply_with_form(v_inv.id, p_responses, p_plus_one, null, p_form_version);
  if (v_res ->> 'changed')::boolean then
    update public.weddings set revision = revision + 1 where id = v_inv.wedding_id
      returning revision into v_revision;
    insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
      values (v_inv.wedding_id, null, 'invitation', v_inv.id, 'rsvp.responded',
              app_private.rsvp_audit_changes(v_res, false), v_revision);
    perform app_private.rsvp_record_submission(
      gen_random_uuid(), v_inv.id, null, p_responses, p_plus_one, v_res, v_revision, p_form_version);
  end if;
  return app_private.rsvp_projection(v_inv.id);
end;
$$;

-- ---------------------------------------------------------------- party submit
-- Same as UX-09; each reply may carry "formVersionId" (null or the published version of that
-- event's form the guest answered).
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
  v_form uuid;
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
  perform 1 from public.invitations
    where party_id = v_pid and wedding_id = v_party.wedding_id and revoked_at is null and expires_at > now()
    order by id for update;

  if p_replies is null or jsonb_typeof(p_replies) <> 'array' or jsonb_array_length(p_replies) not between 1 and 12 then
    raise exception 'invalid response' using errcode = '22023';
  end if;
  for v_r in select * from jsonb_array_elements(p_replies) loop
    if jsonb_typeof(v_r) <> 'object'
       or coalesce(jsonb_typeof(v_r -> 'invitationId'), '') <> 'string'
       or not app_private.is_uuid(v_r ->> 'invitationId')
       or coalesce(jsonb_typeof(v_r -> 'expectedVersion'), '') <> 'number'
       or (v_r ->> 'expectedVersion') !~ '^\d{1,9}$'
       or coalesce(jsonb_typeof(v_r -> 'formVersionId'), 'null') not in ('null', 'string')
       or (jsonb_typeof(v_r -> 'formVersionId') = 'string' and not app_private.is_uuid(v_r ->> 'formVersionId')) then
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
    v_form := nullif(v_r ->> 'formVersionId', '')::uuid;
    v_res := app_private.rsvp_apply_with_form(
      v_id, coalesce(v_r -> 'responses', 'null'::jsonb), v_r -> 'plusOne', v_pid, v_form);
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
                app_private.rsvp_audit_changes(v_res, true), v_revision);
      select r into v_r from jsonb_array_elements(p_replies) r where (r ->> 'invitationId')::uuid = v_id;
      perform app_private.rsvp_record_submission(
        v_send, v_id, v_pid, coalesce(v_r -> 'responses', 'null'::jsonb), v_r -> 'plusOne', v_res,
        v_revision, nullif(v_r ->> 'formVersionId', '')::uuid);
    end loop;
  end if;
  return app_private.rsvp_party_projection(v_pid);
end;
$$;

revoke all on function public.rsvp_submit(text, text, integer, jsonb, jsonb, uuid),
  public.rsvp_party_submit(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.rsvp_submit(text, text, integer, jsonb, jsonb, uuid),
  public.rsvp_party_submit(text, text, jsonb) to service_role;
