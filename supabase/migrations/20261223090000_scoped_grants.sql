-- REL-11 planner/editor scoped grants (ADR-031 D7).
--
-- Until now every write helper meant "owner or partner" (can_manage_guests, can_manage_budget,
-- can_manage_vendors, can_edit_plan). Editors could only read. This migration lets an owner open
-- single areas to a planner/editor, and nothing else:
--
--   area          what it opens
--   guests        guests, households, events, replies, invitation links, caterer count; also lets
--                 the editor read (never change) the seating plan
--   guest_private dietary, access and private notes (needs guests)
--   seating       tables, seats, captains, suggestions, finalizing (needs guests)
--   budget        budget, bookings, payments, invoices, documents
--   vendors       venues, vendors, quotes, comparisons, spaces, event-vendor links
--   plan          checklist, agenda, design boards, website draft (not publishing)
--
-- Owner and partner hold every area by default. A viewer can never hold one. The grant lives in
-- memberships.permissions as flat booleans ({"guests": true, "seating": true}); only an owner can
-- change it (set_editor_grants), and a role change clears it. Authorization stays in the same
-- helpers every RPC and RLS policy already calls, so every existing write path is covered by
-- replacing those helpers, not by editing 100 functions.
--
-- Not grantable, on purpose: member administration, settings, packages and exports, comments
-- moderation, guest totals sharing, publishing the guest website. They stay with owner/partner.

-- ---------------------------------------------------------------- one lookup for every area
create function app_private.has_area(p_wedding uuid, p_area text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_area = any (array['guests', 'guest_private', 'seating', 'budget', 'vendors', 'plan'])
    and exists (
      select 1 from public.memberships m
      where m.wedding_id = p_wedding and m.user_id = (select auth.uid()) and m.status = 'active'
        and (
          m.role in ('owner', 'partner')
          or (
            m.role = 'editor'
            and m.permissions ->> p_area = 'true'
            -- seating and private details are meaningless without the guest list
            and (p_area not in ('guest_private', 'seating') or m.permissions ->> 'guests' = 'true')
          )
        )
    );
$$;
revoke all on function app_private.has_area(uuid, text) from public, anon;
grant execute on function app_private.has_area(uuid, text) to authenticated;

-- ---------------------------------------------------------------- existing helpers, now grant-aware
-- create or replace keeps every policy and function that already calls them.
create or replace function app_private.can_manage_guests(p_wedding uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$ select app_private.has_area(p_wedding, 'guests'); $$;

create or replace function app_private.can_manage_budget(p_wedding uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$ select app_private.has_area(p_wedding, 'budget'); $$;

create or replace function app_private.can_manage_vendors(p_wedding uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$ select app_private.has_area(p_wedding, 'vendors'); $$;

create or replace function app_private.can_edit_plan(p_wedding uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$ select app_private.has_area(p_wedding, 'plan'); $$;

create function app_private.can_manage_seating(p_wedding uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$ select app_private.has_area(p_wedding, 'seating'); $$;

create function app_private.can_read_guest_private(p_wedding uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$ select app_private.has_area(p_wedding, 'guest_private'); $$;

-- Publishing puts private information on the internet, so it is not part of the plan grant.
create function app_private.can_publish_site(p_wedding uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$ select app_private.has_role(p_wedding, array['owner', 'partner']::public.membership_role[]); $$;

revoke all on function app_private.can_manage_seating(uuid), app_private.can_read_guest_private(uuid),
  app_private.can_publish_site(uuid) from public, anon;
grant execute on function app_private.can_manage_seating(uuid), app_private.can_read_guest_private(uuid),
  app_private.can_publish_site(uuid) to authenticated;

-- ---------------------------------------------------------------- locks
-- Same advisory lock key as the guests lock (ADR-023 lock order), so seating and guest writers
-- still serialize against each other; only the permission differs.
create function app_private.lock_wedding_for_seating(p_wedding uuid)
returns public.weddings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wedding public.weddings%rowtype;
begin
  if (select auth.uid()) is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app_private.can_manage_seating(p_wedding) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('guests:' || p_wedding::text, 0));
  select * into v_wedding from public.weddings where id = p_wedding for share;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return v_wedding;
end;
$$;
revoke all on function app_private.lock_wedding_for_seating(uuid) from public, anon;
grant execute on function app_private.lock_wedding_for_seating(uuid) to authenticated;

create function app_private.lock_wedding_for_publish(p_wedding uuid)
returns public.weddings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wedding public.weddings%rowtype;
begin
  if (select auth.uid()) is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app_private.can_publish_site(p_wedding) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  select * into v_wedding from public.weddings where id = p_wedding for share;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return v_wedding;
end;
$$;
revoke all on function app_private.lock_wedding_for_publish(uuid) from public, anon;
grant execute on function app_private.lock_wedding_for_publish(uuid) to authenticated;

-- ---------------------------------------------------------------- re-point the seating and publish RPCs
-- These functions are rewritten from their live definitions with one call swapped, instead of being
-- copied into this file, so no other line of any of them can drift. Each swap is asserted: the
-- function must exist, must contain the old call, and must contain the new one afterwards.
do $$
declare
  v_seating text[] := array[
    'add_seating_element', 'add_seating_table', 'apply_seating_suggestion', 'assign_guest_seat',
    'assign_household_seats', 'ensure_seating_layout', 'finalize_seating_layout',
    'move_seating_element', 'move_seating_table', 'number_table_seats', 'remove_seating_element',
    'remove_seating_table', 'set_seating_tentative', 'set_table_captain', 'swap_guest_seats',
    'unassign_guest_seat', 'update_seating_element', 'update_seating_table'];
  v_name text;
  v_oid oid;
  v_def text;
  v_new text;
begin
  foreach v_name in array v_seating loop
    select p.oid into v_oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_name and p.prokind = 'f';
    if v_oid is null then
      raise exception 'expected function public.% not found', v_name;
    end if;
    v_def := pg_get_functiondef(v_oid);
    v_new := replace(v_def, 'app_private.lock_wedding_for_guests(', 'app_private.lock_wedding_for_seating(');
    if v_new = v_def or v_new like '%lock_wedding_for_guests(%' then
      raise exception 'public.% did not take the guests lock exactly as expected', v_name;
    end if;
    execute v_new;
  end loop;

  -- Publishing the guest website: owner and partner only.
  select p.oid into v_oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'publish_site' and p.prokind = 'f';
  if v_oid is null then
    raise exception 'expected function public.publish_site not found';
  end if;
  v_def := pg_get_functiondef(v_oid);
  v_new := replace(v_def, 'app_private.lock_wedding_for_plan(', 'app_private.lock_wedding_for_publish(');
  if v_new = v_def then
    raise exception 'public.publish_site did not take the plan lock exactly as expected';
  end if;
  execute v_new;

  -- A role change clears grants whatever the new role is (grants differ by role).
  select p.oid into v_oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'change_member_role' and p.prokind = 'f';
  if v_oid is null then
    raise exception 'expected function public.change_member_role not found';
  end if;
  v_def := pg_get_functiondef(v_oid);
  v_new := replace(v_def,
    $old$permissions = case when p_role = 'partner' then permissions else '{}'::jsonb end$old$,
    $new$permissions = '{}'::jsonb$new$);
  if v_new = v_def then
    raise exception 'public.change_member_role did not clear permissions exactly as expected';
  end if;
  execute v_new;
end;
$$;

-- ---------------------------------------------------------------- private guest details
drop policy guest_private_select_managers on public.guest_private_details;
create policy guest_private_select_managers on public.guest_private_details
  for select to authenticated using (app_private.can_read_guest_private(wedding_id));

-- A caller who cannot read private details cannot write them either: supplying any is refused, not
-- dropped, so nothing is lost without a word.
create or replace function app_private.insert_guest(p_wedding uuid, p_j jsonb, p_household uuid, p_import uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := gen_random_uuid();
  v_diet text := app_private.jtext(p_j, 'dietary');
  v_access text := app_private.jtext(p_j, 'accessibility');
  v_notes text := app_private.jtext(p_j, 'notes');
begin
  if num_nonnulls(v_diet, v_access, v_notes) > 0 and not app_private.can_read_guest_private(p_wedding) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  insert into public.guests (id, wedding_id, household_id, import_id, full_name, email, phone, age_group, tags)
    values (v_id, p_wedding, p_household, p_import, app_private.jtext(p_j, 'name'),
            lower(app_private.jtext(p_j, 'email')), app_private.jtext(p_j, 'phone'),
            app_private.jtext(p_j, 'age_group'), app_private.json_tags(p_j));
  if num_nonnulls(v_diet, v_access, v_notes) > 0 then
    insert into public.guest_private_details (guest_id, wedding_id, dietary, accessibility, notes)
      values (v_id, p_wedding, v_diet, v_access, v_notes);
  end if;
  return v_id;
end;
$$;
revoke all on function app_private.insert_guest(uuid, jsonb, uuid, uuid) from public, anon, authenticated;

-- update_guest posts every field. For a caller without private access the stored private details are
-- kept as they are; supplying a value is refused.
do $$
declare
  v_oid oid;
  v_def text;
  v_new text;
  v_anchor constant text :=
    $a$  select * into v_old_d from public.guest_private_details where guest_id = p_guest_id;$a$;
begin
  select p.oid into v_oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_guest' and p.prokind = 'f';
  if v_oid is null then
    raise exception 'expected function public.update_guest not found';
  end if;
  v_def := pg_get_functiondef(v_oid);
  if (length(v_def) - length(replace(v_def, v_anchor, ''))) <> length(v_anchor) then
    raise exception 'public.update_guest does not contain the expected private-details read exactly once';
  end if;
  v_new := replace(v_def, v_anchor, v_anchor || $b$

  if not app_private.can_read_guest_private(p_wedding) then
    if num_nonnulls(v_diet, v_access, v_notes) > 0 then
      raise exception 'not permitted' using errcode = '42501';
    end if;
    v_diet := v_old_d.dietary;
    v_access := v_old_d.accessibility;
    v_notes := v_old_d.notes;
  end if;$b$);
  execute v_new;
end;
$$;

-- ---------------------------------------------------------------- owner grants an editor areas
create function public.set_editor_grants(
  p_membership uuid,
  p_areas text[],
  p_expected_version integer
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target public.memberships%rowtype;
  v_actor uuid;
  v_level text;
  v_revision integer;
  v_known constant text[] := array['guests', 'guest_private', 'seating', 'budget', 'vendors', 'plan'];
  v_areas text[];
  v_new jsonb;
  v_old text[];
begin
  if p_areas is null or cardinality(p_areas) > 6 or exists (
    select 1 from unnest(p_areas) a where a is null or not (a = any (v_known))
  ) then
    raise exception 'invalid grants' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct a order by a), '{}') into v_areas from unnest(p_areas) a;
  if (('guest_private' = any (v_areas) or 'seating' = any (v_areas)) and not ('guests' = any (v_areas))) then
    raise exception 'invalid grants' using errcode = '22023';
  end if;

  select * into v_target from public.memberships where id = p_membership;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  select * into v_actor, v_level, v_revision from app_private.lock_wedding_for_admin(v_target.wedding_id);
  if v_level <> 'owner' then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  select * into v_target from public.memberships where id = p_membership;
  if v_target.status <> 'active' or v_target.role <> 'editor' then
    raise exception 'grants apply to active editors only' using errcode = '55000';
  end if;
  if v_target.version <> p_expected_version then
    raise exception 'membership changed; reload and retry' using errcode = '55000';
  end if;

  select coalesce(array_agg(k order by k), '{}') into v_old
    from jsonb_each(v_target.permissions) e(k, v) where v = 'true'::jsonb and k = any (v_known);
  v_new := coalesce((select jsonb_object_agg(a, true) from unnest(v_areas) a), '{}'::jsonb);
  if v_old = v_areas then
    return;
  end if;

  update public.memberships set permissions = v_new where id = v_target.id;

  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (v_target.wedding_id, v_actor, 'membership', v_target.id, 'member.grants_changed',
            jsonb_build_object(
              'added', to_jsonb(array(select a from unnest(v_areas) a where not (a = any (v_old)))),
              'removed', to_jsonb(array(select a from unnest(v_old) a where not (a = any (v_areas))))),
            v_revision);
end;
$$;
revoke all on function public.set_editor_grants(uuid, text[], integer) from public, anon;
grant execute on function public.set_editor_grants(uuid, text[], integer) to authenticated;
