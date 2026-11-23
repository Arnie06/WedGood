-- REL-07 vendors assigned to events (ADR-031 D4).
--   * event_vendors: which vendor works at which event. The link points at the vendor
--     (candidates row), not at a contract row, because amend_commitment creates a new commitment
--     row and a link on the contract would break. One row per (event, vendor).
--   * Only vendors (kind = 'vendor') can be linked; a venue is placed with event_locations.
--   * Composite foreign keys keep both ends in the same wedding.
--   * Adding a link needs a current vendor: not archived and not passed (declined or cancelled).
--     Removing is always allowed, so a stale link can be cleared. A link to a vendor that later
--     becomes archived or passed is kept and shown as such, never deleted behind the couple's back.
-- Writes are RPCs only (add and remove lists, so two people changing different links do not undo
-- each other). Both RPCs use the vendors lock and permission (owner and partner). Nothing is sent
-- to the vendor and no booking, quote or payment changes.

create table public.event_vendors (
  event_id uuid not null,
  candidate_id uuid not null,
  wedding_id uuid not null,
  kind text not null default 'vendor' check (kind = 'vendor'),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (event_id, candidate_id),
  foreign key (wedding_id, event_id) references public.events (wedding_id, id) on delete cascade,
  foreign key (wedding_id, candidate_id, kind)
    references public.candidates (wedding_id, id, kind) on delete cascade
);
create index event_vendors_candidate_idx on public.event_vendors (wedding_id, candidate_id);
create index event_vendors_wedding_idx on public.event_vendors (wedding_id, event_id);

alter table public.event_vendors enable row level security;
revoke all on public.event_vendors from anon, authenticated;
grant select on public.event_vendors to authenticated;
-- Who works at an event is visible to every member, like the vendor list and the agenda.
create policy event_vendors_select_member on public.event_vendors
  for select to authenticated using (app_private.is_member(wedding_id));

-- Shared by both entry points. Applies one add list and one remove list for a single vendor or a
-- single event (exactly one of p_candidate, p_event is set; the lists hold the other side).
-- Returns how many links were added and removed. Adding a link that exists and removing one that
-- does not are no-ops. Must be called with the vendors lock already taken.
create function app_private.apply_event_vendor_links(
  p_wedding uuid,
  p_candidate uuid,
  p_event uuid,
  p_add uuid[],
  p_remove uuid[]
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_add uuid[] := coalesce(
    (select array_agg(distinct x) from unnest(coalesce(p_add, '{}'::uuid[])) x where x is not null), '{}');
  v_remove uuid[] := coalesce(
    (select array_agg(distinct x) from unnest(coalesce(p_remove, '{}'::uuid[])) x where x is not null), '{}');
  v_id uuid;
  v_added integer := 0;
  v_removed integer := 0;
  v_n integer;
begin
  if (p_candidate is null) = (p_event is null) then
    raise exception 'invalid links' using errcode = '22023';
  end if;
  if coalesce(array_length(v_add, 1), 0) > 50 or coalesce(array_length(v_remove, 1), 0) > 50
     or v_add && v_remove then
    raise exception 'invalid links' using errcode = '22023';
  end if;

  if p_candidate is not null then
    -- The vendor is the fixed side. Removing links of an archived or passed vendor is fine, so
    -- only a missing or foreign vendor is refused here; a current one is required to add.
    perform 1 from public.candidates
      where id = p_candidate and wedding_id = p_wedding and kind = 'vendor' for share;
    if not found then
      raise exception 'not permitted' using errcode = '42501';
    end if;
    if coalesce(array_length(v_add, 1), 0) > 0 then
      perform 1 from public.candidates
        where id = p_candidate and archived_at is null and stage not in ('declined', 'cancelled');
      if not found then
        raise exception 'vendor not current' using errcode = '22023';
      end if;
    end if;
  else
    perform 1 from public.events where id = p_event and wedding_id = p_wedding for share;
    if not found then
      raise exception 'not permitted' using errcode = '42501';
    end if;
  end if;

  -- Adds: every named other side must exist in this wedding (and, for vendors, be current).
  foreach v_id in array v_add loop
    if p_candidate is not null then
      perform 1 from public.events where id = v_id and wedding_id = p_wedding for share;
      if not found then
        raise exception 'not permitted' using errcode = '42501';
      end if;
      insert into public.event_vendors (event_id, candidate_id, wedding_id, created_by)
        values (v_id, p_candidate, p_wedding, v_user)
        on conflict do nothing;
    else
      perform 1 from public.candidates
        where id = v_id and wedding_id = p_wedding and kind = 'vendor' for share;
      if not found then
        raise exception 'not permitted' using errcode = '42501';
      end if;
      perform 1 from public.candidates
        where id = v_id and archived_at is null and stage not in ('declined', 'cancelled');
      if not found then
        raise exception 'vendor not current' using errcode = '22023';
      end if;
      insert into public.event_vendors (event_id, candidate_id, wedding_id, created_by)
        values (p_event, v_id, p_wedding, v_user)
        on conflict do nothing;
    end if;
    get diagnostics v_n = row_count;
    v_added := v_added + v_n;
  end loop;

  -- Removes: only rows of this wedding, so a foreign id matches nothing.
  if p_candidate is not null then
    delete from public.event_vendors
      where wedding_id = p_wedding and candidate_id = p_candidate and event_id = any (v_remove);
  else
    delete from public.event_vendors
      where wedding_id = p_wedding and event_id = p_event and candidate_id = any (v_remove);
  end if;
  get diagnostics v_removed = row_count;

  if v_added + v_removed > 0 then
    -- Ids and counts only; no names, notes or amounts.
    insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
      select p_wedding, v_user,
             case when p_candidate is not null then 'candidate' else 'event' end,
             coalesce(p_candidate, p_event), 'event_vendors.changed',
             jsonb_build_object('added', v_added, 'removed', v_removed), w.revision
      from public.weddings w where w.id = p_wedding;
  end if;
  return jsonb_build_object('added', v_added, 'removed', v_removed);
end;
$$;
revoke all on function app_private.apply_event_vendor_links(uuid, uuid, uuid, uuid[], uuid[]) from public, anon, authenticated;

-- From a vendor: "works at" these events.
create function public.set_vendor_events(
  p_wedding uuid,
  p_candidate uuid,
  p_add uuid[] default '{}',
  p_remove uuid[] default '{}'
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wedding public.weddings%rowtype;
begin
  v_wedding := app_private.lock_wedding_for_vendors(p_wedding);
  return app_private.apply_event_vendor_links(p_wedding, p_candidate, null, p_add, p_remove);
end;
$$;
revoke all on function public.set_vendor_events(uuid, uuid, uuid[], uuid[]) from public, anon;
grant execute on function public.set_vendor_events(uuid, uuid, uuid[], uuid[]) to authenticated;

-- From an event: these vendors work here.
create function public.set_event_vendors(
  p_wedding uuid,
  p_event uuid,
  p_add uuid[] default '{}',
  p_remove uuid[] default '{}'
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wedding public.weddings%rowtype;
begin
  v_wedding := app_private.lock_wedding_for_vendors(p_wedding);
  return app_private.apply_event_vendor_links(p_wedding, null, p_event, p_add, p_remove);
end;
$$;
revoke all on function public.set_event_vendors(uuid, uuid, uuid[], uuid[]) from public, anon;
grant execute on function public.set_event_vendors(uuid, uuid, uuid[], uuid[]) to authenticated;
