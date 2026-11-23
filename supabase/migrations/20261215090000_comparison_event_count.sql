-- REL-04 live count in comparisons (ADR-031).
--
-- A comparison prices every option for one guest count. That number is a record of the scenario the
-- couple looked at, so it never changes by itself. New here:
--   * comparisons.count_event_id: the event whose planning number the count was taken from. It is a
--     pointer used only to say "replies now suggest N"; the stored count is still the scenario.
--   * create_comparison accepts the event (checked to belong to the wedding).
--   * update_comparison drops the pointer when the couple types a different count: a number they
--     chose themselves is not a reply-based number.
--   * reprice_comparison makes a COPY at a new count (options, ratings, weights, unknown-fee choice).
--     The original, and any decision on it, is not touched. The copy has no decision.
-- Nothing here books, commits or pays.

alter table public.comparisons
  add column count_event_id uuid,
  add constraint comparisons_count_event_fk
    foreign key (wedding_id, count_event_id) references public.events (wedding_id, id);
create index comparisons_count_event_idx on public.comparisons (wedding_id, count_event_id)
  where count_event_id is not null;

-- ---------------------------------------------------------------- create
drop function public.create_comparison(uuid, text, integer, uuid[], jsonb, text);
create function public.create_comparison(
  p_wedding uuid,
  p_title text,
  p_guest_count integer,
  p_proposals uuid[],
  p_criteria jsonb,
  p_idempotency_key text default null,
  p_count_event uuid default null
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
  if p_count_event is not null
     and not exists (select 1 from public.events where id = p_count_event and wedding_id = p_wedding) then
    raise exception 'invalid comparison' using errcode = '22023';
  end if;
  perform app_private.assert_criteria(p_criteria);
  select array_agg(distinct x order by x) into v_ids from unnest(p_proposals) x where x is not null;
  if coalesce(array_length(v_ids, 1), 0) not between 2 and 4
     or array_length(v_ids, 1) <> (select count(*) from unnest(p_proposals) x) then
    raise exception 'choose 2 to 4 quotes' using errcode = '22023';
  end if;

  if p_idempotency_key is not null then
    v_hash := md5(concat_ws('|', v_title, p_guest_count::text, array_to_string(p_proposals, ','),
                            p_criteria::text, coalesce(p_count_event::text, '')));
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

  insert into public.comparisons (wedding_id, title, scenario_guest_count, currency, criteria, created_by,
                                  count_event_id)
    values (p_wedding, v_title, p_guest_count, v_wedding.base_currency, p_criteria, v_user, p_count_event)
    returning id into v_id;
  -- Keep the order the person chose.
  foreach v_pid in array p_proposals loop
    insert into public.comparison_options (wedding_id, comparison_id, proposal_id, position)
      values (p_wedding, v_id, v_pid, v_pos);
    v_pos := v_pos + 1;
  end loop;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'comparison', v_id, 'comparison.created',
            jsonb_build_object('options', array_length(v_ids, 1), 'fromEvent', p_count_event is not null),
            v_wedding.revision);
  if p_idempotency_key is not null then
    perform app_private.idem_done(v_user, 'create_comparison:' || p_wedding::text, p_idempotency_key, v_id);
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------- update
-- Same as before, plus: a changed guest count is the couple's own number, so the event pointer goes.
create or replace function public.update_comparison(
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
      accepts_unknowns = p_accepts_unknowns, version = version + 1,
      count_event_id = case when p_guest_count <> v_old.scenario_guest_count then null else count_event_id end
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

-- ---------------------------------------------------------------- reprice (copy)
-- Copies a comparison that follows an event to a new guest count. The source is only read.
-- The caller (server action) takes the number from the event's current planning number; the
-- database checks only that it is a valid count, as for any comparison.
create function public.reprice_comparison(
  p_wedding uuid,
  p_comparison uuid,
  p_guest_count integer,
  p_idempotency_key text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_src public.comparisons%rowtype;
  v_hash text;
  v_prior uuid;
  v_id uuid;
  v_ok integer;
  v_total integer;
  v_suffix text := ' (for ' || coalesce(p_guest_count::text, '?') || ' guests)';
begin
  v_wedding := app_private.lock_wedding_for_vendors(p_wedding);
  if p_guest_count is null or p_guest_count not between 1 and 100000
     or p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 128 then
    raise exception 'invalid comparison' using errcode = '22023';
  end if;
  select * into v_src from public.comparisons
    where id = p_comparison and wedding_id = p_wedding for share;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_src.archived_at is not null then
    raise exception 'comparison changed, reload' using errcode = '55000';
  end if;
  if v_src.count_event_id is null then
    raise exception 'invalid comparison' using errcode = '22023';
  end if;

  v_hash := md5(concat_ws('|', p_comparison::text, p_guest_count::text));
  v_prior := app_private.idem_claim(v_user, 'reprice_comparison:' || p_wedding::text, p_idempotency_key, v_hash);
  if v_prior is not null then
    return v_prior;
  end if;

  -- Every quote must still be open, as when a comparison is created.
  select count(*) into v_total from public.comparison_options where comparison_id = p_comparison;
  select count(*) into v_ok from (
    select 1 from public.proposals p
      where p.id in (select proposal_id from public.comparison_options where comparison_id = p_comparison)
        and p.wedding_id = p_wedding and p.archived_at is null
        and p.status = 'open' and p.currency = v_wedding.base_currency
      order by p.id for share
  ) q;
  if v_ok <> v_total or v_total < 2 then
    raise exception 'quotes not available' using errcode = '22023';
  end if;
  if (select count(*) from public.comparisons where wedding_id = p_wedding and archived_at is null) >= 50 then
    raise exception 'too many comparisons' using errcode = '54000';
  end if;

  insert into public.comparisons (wedding_id, title, scenario_guest_count, currency, criteria,
                                  accepts_unknowns, created_by, count_event_id)
    values (p_wedding, left(regexp_replace(v_src.title, ' \(for [0-9]+ guests\)$', ''), 160 - char_length(v_suffix)) || v_suffix, p_guest_count,
            v_wedding.base_currency, v_src.criteria, v_src.accepts_unknowns, v_user, v_src.count_event_id)
    returning id into v_id;
  insert into public.comparison_options (wedding_id, comparison_id, proposal_id, position, ratings)
    select wedding_id, v_id, proposal_id, position, ratings
      from public.comparison_options where comparison_id = p_comparison;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'comparison', v_id, 'comparison.repriced',
            jsonb_build_object('from', p_comparison, 'guestCount', p_guest_count, 'was', v_src.scenario_guest_count),
            v_wedding.revision);
  perform app_private.idem_done(v_user, 'reprice_comparison:' || p_wedding::text, p_idempotency_key, v_id);
  return v_id;
end;
$$;

revoke all on function
  public.create_comparison(uuid, text, integer, uuid[], jsonb, text, uuid),
  public.reprice_comparison(uuid, uuid, integer, text)
from public, anon;
grant execute on function
  public.create_comparison(uuid, text, integer, uuid[], jsonb, text, uuid),
  public.reprice_comparison(uuid, uuid, integer, text)
to authenticated;
