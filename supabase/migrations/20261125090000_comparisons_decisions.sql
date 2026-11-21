-- R1-05 comparisons and decisions.
--
-- Rules (docs/06-DATA-MODEL.md, docs/07-DOMAIN-RULES.md):
--  * A comparison puts 2–4 open quotes side by side for ONE scenario (guest count, currency).
--    Alternatives are never summed. Nothing here books, commits or pays.
--  * Ratings and weights are the couple's own; a missing rating is unknown, never zero.
--  * A decision is an append-only record: the chosen quote, the inputs at that moment and the
--    figures the couple saw. Later changes make it stale (see comparison_source_state); they
--    never rewrite it. A new decision supersedes the previous one, which is kept.
--  * Selecting a quote is not booking. At most it moves an early-stage vendor to 'considering'.
-- All writes go through these RPCs; clients get SELECT through RLS. Authorization is the
-- vendor capability (owner and partner), as for candidates and quotes.

-- ---------------------------------------------------------------- helpers
-- Claim an idempotency key. Returns the stored response when the request already completed,
-- else null (the key is claimed and locked for this transaction).
create function app_private.idem_claim(p_user uuid, p_op text, p_key text, p_hash text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.idempotency_keys%rowtype;
begin
  insert into public.idempotency_keys (actor_scope, operation, key, request_hash)
    values (p_user::text, p_op, p_key, p_hash)
    on conflict do nothing;
  select * into v_existing from public.idempotency_keys
    where actor_scope = p_user::text and operation = p_op and key = p_key
    for update;
  if v_existing.request_hash <> p_hash then
    raise exception 'idempotency key reused with different request' using errcode = '23505';
  end if;
  return v_existing.response_ref;
end;
$$;
create function app_private.idem_done(p_user uuid, p_op text, p_key text, p_ref uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.idempotency_keys set response_ref = p_ref
    where actor_scope = p_user::text and operation = p_op and key = p_key;
$$;
revoke all on function app_private.idem_claim(uuid, text, text, text) from public, anon, authenticated;
revoke all on function app_private.idem_done(uuid, text, text, uuid) from public, anon, authenticated;

-- criteria: array of up to 8 {id, label, weight 0..10}, ids unique, labels unique ignoring case.
create function app_private.assert_criteria(p_criteria jsonb) returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  c jsonb;
begin
  if p_criteria is null or jsonb_typeof(p_criteria) <> 'array' or jsonb_array_length(p_criteria) > 8 then
    raise exception 'invalid criteria' using errcode = '22023';
  end if;
  for c in select * from jsonb_array_elements(p_criteria) loop
    if jsonb_typeof(c) <> 'object'
       or (select count(*) from jsonb_object_keys(c)) <> 3
       or jsonb_typeof(c -> 'id') <> 'string' or (c ->> 'id') !~ '^[A-Za-z0-9-]{1,40}$'
       or jsonb_typeof(c -> 'label') <> 'string' or char_length(btrim(c ->> 'label')) not between 1 and 60
       or jsonb_typeof(c -> 'weight') <> 'number' or (c ->> 'weight') !~ '^([0-9]|10)$' then
      raise exception 'invalid criteria' using errcode = '22023';
    end if;
  end loop;
  if (select count(distinct (e ->> 'id')) from jsonb_array_elements(p_criteria) e) <> jsonb_array_length(p_criteria)
     or (select count(distinct lower(btrim(e ->> 'label'))) from jsonb_array_elements(p_criteria) e)
        <> jsonb_array_length(p_criteria) then
    raise exception 'invalid criteria' using errcode = '22023';
  end if;
end;
$$;

-- ratings for one option: object of criterion id -> integer 0..100, only known criterion ids.
create function app_private.assert_ratings(p_ratings jsonb, p_criteria jsonb) returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  k text;
  v jsonb;
begin
  if p_ratings is null or jsonb_typeof(p_ratings) <> 'object' then
    raise exception 'invalid ratings' using errcode = '22023';
  end if;
  for k, v in select * from jsonb_each(p_ratings) loop
    if jsonb_typeof(v) <> 'number' or (v #>> '{}') !~ '^([0-9]{1,2}|100)$'
       or not exists (select 1 from jsonb_array_elements(p_criteria) e where e ->> 'id' = k) then
      raise exception 'invalid ratings' using errcode = '22023';
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------- tables
create table public.comparisons (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 160),
  scenario_guest_count integer not null check (scenario_guest_count between 1 and 100000),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  criteria jsonb not null default '[]'::jsonb check (jsonb_typeof(criteria) = 'array'),
  -- The couple's explicit choice to rank options even though some required fees are unknown.
  accepts_unknowns boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  archived_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (wedding_id, id)
);
create index comparisons_wedding_idx on public.comparisons (wedding_id, created_at desc)
  where archived_at is null;
create trigger comparisons_touch before update on public.comparisons
  for each row execute function app_private.touch_updated_at();

create table public.comparison_options (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null,
  comparison_id uuid not null,
  proposal_id uuid not null,
  position integer not null check (position between 0 and 3),
  ratings jsonb not null default '{}'::jsonb check (jsonb_typeof(ratings) = 'object'),
  created_at timestamptz not null default now(),
  unique (comparison_id, proposal_id),
  unique (comparison_id, position),
  unique (comparison_id, id),
  foreign key (wedding_id, comparison_id)
    references public.comparisons (wedding_id, id) on delete cascade,
  foreign key (wedding_id, proposal_id)
    references public.proposals (wedding_id, id) on delete cascade
);

create table public.decisions (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null,
  comparison_id uuid not null,
  chosen_proposal_id uuid not null,
  note text check (note is null or char_length(note) <= 1000),
  -- {inputs: criteria/ratings/guest count the decision rested on, figures: what was shown}
  snapshot jsonb not null,
  source_state jsonb not null,
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz not null default now(),
  superseded_at timestamptz,
  foreign key (wedding_id, comparison_id)
    references public.comparisons (wedding_id, id) on delete cascade,
  foreign key (wedding_id, chosen_proposal_id)
    references public.proposals (wedding_id, id) on delete cascade
);
-- One current decision per comparison.
create unique index decisions_current_idx on public.decisions (comparison_id) where superseded_at is null;

alter table public.comparisons enable row level security;
alter table public.comparison_options enable row level security;
alter table public.decisions enable row level security;
revoke all on public.comparisons, public.comparison_options, public.decisions from anon, authenticated;
grant select on public.comparisons, public.comparison_options, public.decisions to authenticated;
create policy comparisons_select_member on public.comparisons
  for select to authenticated using (app_private.is_member(wedding_id));
create policy comparison_options_select_member on public.comparison_options
  for select to authenticated using (app_private.is_member(wedding_id));
create policy decisions_select_member on public.decisions
  for select to authenticated using (app_private.is_member(wedding_id));

-- Decisions are history: even the cascade from an erased wedding is the only way they go.
create function app_private.decisions_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then
      return old;
    end if;
    raise exception 'decisions are append-only' using errcode = '42501';
  end if;
  if (new.id, new.wedding_id, new.comparison_id, new.chosen_proposal_id, new.snapshot, new.source_state,
      new.decided_by, new.decided_at, new.note)
     is distinct from
     (old.id, old.wedding_id, old.comparison_id, old.chosen_proposal_id, old.snapshot, old.source_state,
      old.decided_by, old.decided_at, old.note) then
    raise exception 'decisions are append-only' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger decisions_guard before update or delete on public.decisions
  for each row execute function app_private.decisions_guard();

-- ---------------------------------------------------------------- source state
-- What a decision rests on, built in one place so the recorded and the current state can
-- be compared. inputs_hash covers weights, labels, guest count and every rating.
create function app_private.comparison_state(p_comparison uuid) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'guestCount', c.scenario_guest_count,
    'currency', c.currency,
    'inputsHash', md5(
      c.criteria::text || '|' || c.scenario_guest_count::text || '|' ||
      coalesce((select string_agg(o.proposal_id::text || ':' || o.ratings::text, ',' order by o.position)
                from public.comparison_options o where o.comparison_id = c.id), '')
    ),
    'options', coalesce((
      select jsonb_agg(jsonb_build_object(
        'proposalId', o.proposal_id,
        'proposalVersion', p.version,
        'proposalArchived', p.archived_at is not null,
        'candidateId', p.candidate_id,
        'candidateVersion', k.version
      ) order by o.position)
      from public.comparison_options o
      join public.proposals p on p.id = o.proposal_id
      join public.candidates k on k.id = p.candidate_id
      where o.comparison_id = c.id
    ), '[]'::jsonb)
  )
  from public.comparisons c where c.id = p_comparison;
$$;
revoke all on function app_private.comparison_state(uuid) from public, anon, authenticated;

create function public.comparison_source_state(p_wedding uuid, p_comparison uuid) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app_private.is_member(p_wedding)
     or not exists (select 1 from public.comparisons where id = p_comparison and wedding_id = p_wedding) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return app_private.comparison_state(p_comparison);
end;
$$;
revoke all on function public.comparison_source_state(uuid, uuid) from public, anon;
grant execute on function public.comparison_source_state(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------- create
create function public.create_comparison(
  p_wedding uuid,
  p_title text,
  p_guest_count integer,
  p_proposals uuid[],
  p_criteria jsonb,
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
  v_ids uuid[];
  v_hash text;
  v_prior uuid;
  v_id uuid;
  v_ok integer;
  v_pid uuid;
  v_pos integer := 0;
begin
  v_wedding := app_private.lock_wedding_for_vendors(p_wedding);
  if char_length(v_title) not between 1 and 160 or p_guest_count is null
     or p_guest_count not between 1 and 100000 or p_proposals is null then
    raise exception 'invalid comparison' using errcode = '22023';
  end if;
  perform app_private.assert_criteria(p_criteria);
  select array_agg(distinct x order by x) into v_ids from unnest(p_proposals) x where x is not null;
  if coalesce(array_length(v_ids, 1), 0) not between 2 and 4
     or array_length(v_ids, 1) <> (select count(*) from unnest(p_proposals) x) then
    raise exception 'choose 2 to 4 quotes' using errcode = '22023';
  end if;

  if p_idempotency_key is not null then
    v_hash := md5(concat_ws('|', v_title, p_guest_count::text, array_to_string(p_proposals, ','), p_criteria::text));
    v_prior := app_private.idem_claim(v_user, 'create_comparison:' || p_wedding::text, p_idempotency_key, v_hash);
    if v_prior is not null then
      return v_prior;
    end if;
  end if;

  -- Lock the quotes so none can be archived or edited while the comparison is created.
  select count(*) into v_ok from (
    select 1 from public.proposals
      where id = any (v_ids) and wedding_id = p_wedding and archived_at is null
        and status = 'open' and currency = v_wedding.base_currency
      order by id for share
  ) q;
  if v_ok <> array_length(v_ids, 1) then
    raise exception 'quotes not available' using errcode = '22023';
  end if;
  if (select count(*) from public.comparisons where wedding_id = p_wedding and archived_at is null) >= 50 then
    raise exception 'too many comparisons' using errcode = '54000';
  end if;

  insert into public.comparisons (wedding_id, title, scenario_guest_count, currency, criteria, created_by)
    values (p_wedding, v_title, p_guest_count, v_wedding.base_currency, p_criteria, v_user)
    returning id into v_id;
  -- Keep the order the person chose.
  foreach v_pid in array p_proposals loop
    insert into public.comparison_options (wedding_id, comparison_id, proposal_id, position)
      values (p_wedding, v_id, v_pid, v_pos);
    v_pos := v_pos + 1;
  end loop;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'comparison', v_id, 'comparison.created',
            jsonb_build_object('options', array_length(v_ids, 1)), v_wedding.revision);
  if p_idempotency_key is not null then
    perform app_private.idem_done(v_user, 'create_comparison:' || p_wedding::text, p_idempotency_key, v_id);
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------- update
create function public.update_comparison(
  p_wedding uuid,
  p_comparison uuid,
  p_expected_version integer,
  p_title text,
  p_guest_count integer,
  p_criteria jsonb,
  p_accepts_unknowns boolean
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.comparisons%rowtype;
  v_title text := btrim(coalesce(p_title, ''));
  v_changed text[] := '{}';
  v_version integer;
begin
  v_wedding := app_private.lock_wedding_for_vendors(p_wedding);
  if char_length(v_title) not between 1 and 160 or p_guest_count is null
     or p_guest_count not between 1 and 100000 or p_accepts_unknowns is null then
    raise exception 'invalid comparison' using errcode = '22023';
  end if;
  perform app_private.assert_criteria(p_criteria);
  select * into v_old from public.comparisons where id = p_comparison and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_old.archived_at is not null or v_old.version <> p_expected_version then
    raise exception 'comparison changed, reload' using errcode = '55000';
  end if;
  if v_title is distinct from v_old.title then v_changed := array_append(v_changed, 'title'); end if;
  if p_guest_count <> v_old.scenario_guest_count then v_changed := array_append(v_changed, 'guest_count'); end if;
  if p_criteria is distinct from v_old.criteria then v_changed := array_append(v_changed, 'criteria'); end if;
  if p_accepts_unknowns <> v_old.accepts_unknowns then v_changed := array_append(v_changed, 'accepts_unknowns'); end if;
  if coalesce(array_length(v_changed, 1), 0) = 0 then
    return v_old.version;
  end if;
  update public.comparisons set title = v_title, scenario_guest_count = p_guest_count, criteria = p_criteria,
      accepts_unknowns = p_accepts_unknowns, version = version + 1
    where id = p_comparison returning version into v_version;
  -- A removed criterion takes its ratings with it.
  update public.comparison_options o set ratings = coalesce((
      select jsonb_object_agg(r.key, r.value) from jsonb_each(o.ratings) r
      where exists (select 1 from jsonb_array_elements(p_criteria) e where e ->> 'id' = r.key)
    ), '{}'::jsonb)
    where o.comparison_id = p_comparison;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'comparison', p_comparison, 'comparison.updated',
            jsonb_build_object('changed', to_jsonb(v_changed)), v_wedding.revision);
  return v_version;
end;
$$;

-- p_ratings: {comparison_option_id: {criterion_id: 0..100}} for every option at once, so a
-- single form save is one atomic write. An option or criterion left out is simply unrated.
create function public.set_comparison_ratings(
  p_wedding uuid,
  p_comparison uuid,
  p_expected_version integer,
  p_ratings jsonb
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.comparisons%rowtype;
  v_key text;
  v_val jsonb;
  v_version integer;
begin
  v_wedding := app_private.lock_wedding_for_vendors(p_wedding);
  if p_ratings is null or jsonb_typeof(p_ratings) <> 'object' then
    raise exception 'invalid ratings' using errcode = '22023';
  end if;
  select * into v_old from public.comparisons where id = p_comparison and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_old.archived_at is not null or v_old.version <> p_expected_version then
    raise exception 'comparison changed, reload' using errcode = '55000';
  end if;
  for v_key, v_val in select * from jsonb_each(p_ratings) loop
    if v_key !~ '^[0-9a-f-]{36}$'
       or not exists (select 1 from public.comparison_options where id = v_key::uuid and comparison_id = p_comparison) then
      raise exception 'invalid ratings' using errcode = '22023';
    end if;
    perform app_private.assert_ratings(v_val, v_old.criteria);
  end loop;
  update public.comparison_options o set ratings = coalesce(p_ratings -> (o.id::text), '{}'::jsonb)
    where o.comparison_id = p_comparison;
  update public.comparisons set version = version + 1 where id = p_comparison returning version into v_version;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'comparison', p_comparison, 'comparison.ratings_set',
            '{}'::jsonb, v_wedding.revision);
  return v_version;
end;
$$;

create function public.archive_comparison(p_wedding uuid, p_comparison uuid, p_expected_version integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.comparisons%rowtype;
begin
  v_wedding := app_private.lock_wedding_for_vendors(p_wedding);
  select * into v_old from public.comparisons where id = p_comparison and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_old.archived_at is not null or v_old.version <> p_expected_version then
    raise exception 'comparison changed, reload' using errcode = '55000';
  end if;
  update public.comparisons set archived_at = now(), version = version + 1 where id = p_comparison;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'comparison', p_comparison, 'comparison.archived', '{}'::jsonb, v_wedding.revision);
end;
$$;

-- ---------------------------------------------------------------- decide
-- Records which quote the couple chose, from exactly the version they were looking at.
-- p_acknowledged covers warnings the couple was shown: a venue verified smaller than the
-- guest count, or required fees still unknown. The database enforces the capacity one itself.
-- Does NOT create a booking, commitment, payment or budget item.
create function public.decide_comparison(
  p_wedding uuid,
  p_comparison uuid,
  p_expected_version integer,
  p_proposal uuid,
  p_figures jsonb,
  p_acknowledged boolean,
  p_note text default null,
  p_idempotency_key text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_cmp public.comparisons%rowtype;
  v_prop public.proposals%rowtype;
  v_cand public.candidates%rowtype;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_capacity integer;
  v_hash text;
  v_prior uuid;
  v_id uuid;
  v_inputs jsonb;
begin
  v_wedding := app_private.lock_wedding_for_vendors(p_wedding);
  if p_acknowledged is null or p_figures is null or jsonb_typeof(p_figures) <> 'object'
     or octet_length(p_figures::text) > 30000 or (v_note is not null and char_length(v_note) > 1000) then
    raise exception 'invalid decision' using errcode = '22023';
  end if;

  if p_idempotency_key is not null then
    v_hash := md5(concat_ws('|', p_comparison::text, p_expected_version::text, p_proposal::text,
                            p_acknowledged::text, coalesce(v_note, ''), p_figures::text));
    v_prior := app_private.idem_claim(v_user, 'decide_comparison:' || p_wedding::text, p_idempotency_key, v_hash);
    if v_prior is not null then
      return v_prior;
    end if;
  end if;

  select * into v_cmp from public.comparisons where id = p_comparison and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_cmp.archived_at is not null or v_cmp.version <> p_expected_version then
    raise exception 'comparison changed, reload' using errcode = '55000';
  end if;
  if not exists (select 1 from public.comparison_options where comparison_id = p_comparison and proposal_id = p_proposal) then
    raise exception 'invalid decision' using errcode = '22023';
  end if;
  -- Lock the chosen quote and its vendor so the snapshot matches what is stored.
  select * into v_prop from public.proposals where id = p_proposal and wedding_id = p_wedding for update;
  if not found or v_prop.archived_at is not null or v_prop.status <> 'open' then
    raise exception 'comparison changed, reload' using errcode = '55000';
  end if;
  select * into v_cand from public.candidates where id = v_prop.candidate_id for update;
  if v_cand.archived_at is not null then
    raise exception 'comparison changed, reload' using errcode = '55000';
  end if;
  -- Hard requirement: verified seating below the scenario headcount needs explicit acknowledgement.
  select seated_capacity into v_capacity from public.venues where candidate_id = v_cand.id;
  if v_capacity is not null and v_capacity < v_cmp.scenario_guest_count and not p_acknowledged then
    raise exception 'acknowledge capacity warning' using errcode = '22023';
  end if;

  -- Selecting a quote moves an early-stage vendor to considering, nothing further.
  if v_cand.stage in ('saved', 'contacted', 'proposal_received') then
    update public.candidates set stage = 'considering', stage_changed_at = now(), version = version + 1
      where id = v_cand.id;
    insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
      values (p_wedding, v_user, 'candidate', v_cand.id, 'candidate.stage_changed',
              jsonb_build_object('from', v_cand.stage, 'to', 'considering', 'via', 'decision'), v_wedding.revision);
  end if;

  update public.decisions set superseded_at = now()
    where comparison_id = p_comparison and superseded_at is null;
  v_inputs := jsonb_build_object(
    'title', v_cmp.title,
    'guestCount', v_cmp.scenario_guest_count,
    'currency', v_cmp.currency,
    'criteria', v_cmp.criteria,
    'acceptsUnknowns', v_cmp.accepts_unknowns,
    'acknowledged', p_acknowledged,
    'options', (select jsonb_agg(jsonb_build_object(
        'optionId', o.id, 'proposalId', o.proposal_id, 'ratings', o.ratings) order by o.position)
      from public.comparison_options o where o.comparison_id = p_comparison)
  );
  -- State is captured after the stage change above, so the decision is not stale on arrival.
  insert into public.decisions (wedding_id, comparison_id, chosen_proposal_id, note, snapshot, source_state, decided_by)
    values (p_wedding, p_comparison, p_proposal, v_note,
            jsonb_build_object('inputs', v_inputs, 'figures', p_figures),
            app_private.comparison_state(p_comparison), v_user)
    returning id into v_id;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'decision', v_id, 'decision.recorded',
            jsonb_build_object('comparison_id', p_comparison, 'proposal_id', p_proposal), v_wedding.revision);
  if p_idempotency_key is not null then
    perform app_private.idem_done(v_user, 'decide_comparison:' || p_wedding::text, p_idempotency_key, v_id);
  end if;
  return v_id;
end;
$$;

-- Callable by signed-in users only; each function re-checks the actor itself.
revoke all on function
  public.create_comparison(uuid, text, integer, uuid[], jsonb, text),
  public.update_comparison(uuid, uuid, integer, text, integer, jsonb, boolean),
  public.set_comparison_ratings(uuid, uuid, integer, jsonb),
  public.archive_comparison(uuid, uuid, integer),
  public.decide_comparison(uuid, uuid, integer, uuid, jsonb, boolean, text, text)
from public, anon;
grant execute on function
  public.create_comparison(uuid, text, integer, uuid[], jsonb, text),
  public.update_comparison(uuid, uuid, integer, text, integer, jsonb, boolean),
  public.set_comparison_ratings(uuid, uuid, integer, jsonb),
  public.archive_comparison(uuid, uuid, integer),
  public.decide_comparison(uuid, uuid, integer, uuid, jsonb, boolean, text, text)
to authenticated;
