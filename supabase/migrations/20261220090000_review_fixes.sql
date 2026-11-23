-- Independent review of REL-01 to REL-08: fixes (2026-11-22). Earlier migrations are untouched.
--
--  1. budget_item_counts: a cost that counts "attending" (event_yes) is priced by the attending count
--     alone. The plan-or-replies rule (the larger of the two until invitations are complete) belongs
--     to the "planning number" source only. Nobody invited yet is unknown, as for the planning number.
--  2. set_event_location: the version a person saw can no longer be matched by a later, different
--     row. Clearing a place deleted the row, so setting a place again restarted its version at 1 and a
--     stale save could overwrite it. A counter on the event now only goes up.
--  3. reprice_comparison: the idempotency key is claimed before the source is inspected, so a retry
--     after success returns the copy even if the source was archived in between.
--  4. Foreign keys that would stop an event from ever being deleted: reply history goes with its
--     event (like locations, vendor links and caterer counts already do), and a comparison only loses
--     its "count came from this event" pointer. A budget cost that counts an event still blocks
--     deleting it, on purpose: deleting would silently change the forecast.
--  5. Pure helper functions are no longer callable by clients (they are only used inside the
--     security-definer functions, which run as their owner).

-- ---------------------------------------------------------------- 1. attending is attending
create or replace function public.budget_item_counts(p_wedding uuid)
returns table (
  item_id uuid,
  event_id uuid,
  item_count integer,
  plan_count integer,
  actual_count integer,
  invitations_final boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_share boolean;
  v_see boolean;
begin
  if (select auth.uid()) is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app_private.is_member(p_wedding) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  select w.share_guest_totals into v_share from public.weddings w where w.id = p_wedding;
  v_see := app_private.can_manage_guests(p_wedding) or coalesce(v_share, false);

  return query
  with base as (
    select bi.id as item, e.id as event, bi.created_at, bi.count_source as source,
      e.target_attendance as plan, e.invitations_final as final,
      -- actual: null until somebody is invited. Mirrors src/domain/events/demand.ts (planningNumber);
      -- the integration test compares the two.
      case
        when d.event_id is null or d.invited = 0 then null
        when bi.count_source = 'event_yes' then d.yes
        else d.yes
          + case d.planning_basis
              when 'auto' then d.waiting_open
              when 'yes_waiting' then d.waiting_open + d.waiting_closed
              else 0 end
          + case when d.plan_open_plus_ones then d.open_plus_ones else 0 end
      end as actual
    from public.budget_items bi
    join public.events e on e.id = bi.count_event_id and e.wedding_id = bi.wedding_id
    left join app_private.event_demand_rows(p_wedding) d on d.event_id = e.id
    where bi.wedding_id = p_wedding and bi.archived_at is null
      and bi.count_source in ('event_plan', 'event_yes')
  )
  select b.item, b.event,
    case
      when b.source = 'event_yes' then b.actual
      when b.final then b.actual
      else greatest(b.plan, b.actual)
    end,
    b.plan,
    case when v_see then b.actual else null end,
    b.final
  from base b
  order by b.created_at, b.item;
end;
$$;

-- ---------------------------------------------------------------- 2. place version only goes up
alter table public.events add column location_seq integer not null default 0;

create or replace function public.set_event_location(
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

  -- Every real change takes the next number from the event, so a version is never used twice, even
  -- after the place was cleared and set again.
  update public.events set location_seq = location_seq + 1
    where id = p_event returning location_seq into v_version;

  if p_candidate is null then
    delete from public.event_locations where event_id = p_event;
    v_version := 0;
  elsif v_old.event_id is null then
    insert into public.event_locations (event_id, wedding_id, candidate_id, space_id, set_by, version)
      values (p_event, p_wedding, p_candidate, p_space, v_user, v_version);
  else
    update public.event_locations
      set candidate_id = p_candidate, space_id = p_space, set_by = v_user, version = v_version
      where event_id = p_event;
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

-- ---------------------------------------------------------------- 3. retry returns the copy
create or replace function public.reprice_comparison(
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

  -- First, so a retry of a call that already succeeded gets its copy back even if the source has been
  -- archived since. A refusal below rolls this claim back with the rest.
  v_hash := md5(concat_ws('|', p_comparison::text, p_guest_count::text));
  v_prior := app_private.idem_claim(v_user, 'reprice_comparison:' || p_wedding::text, p_idempotency_key, v_hash);
  if v_prior is not null then
    return v_prior;
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

-- ---------------------------------------------------------------- 4. events can be deleted
alter table public.rsvp_changes
  drop constraint rsvp_changes_wedding_id_event_id_fkey,
  add constraint rsvp_changes_wedding_id_event_id_fkey
    foreign key (wedding_id, event_id) references public.events (wedding_id, id) on delete cascade;

-- The column list keeps wedding_id: only the pointer is cleared.
alter table public.comparisons
  drop constraint comparisons_count_event_fk,
  add constraint comparisons_count_event_fk
    foreign key (wedding_id, count_event_id) references public.events (wedding_id, id)
    on delete set null (count_event_id);

-- ---------------------------------------------------------------- 5. helpers are internal
revoke execute on function app_private.assert_budget_item_count(text, text, uuid, integer) from authenticated;
revoke execute on function app_private.assert_space_fields(text, integer, integer, text) from authenticated;
revoke execute on function app_private.rewrite_place(text, text, text) from authenticated;
