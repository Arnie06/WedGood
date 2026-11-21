-- R1-14 guest website (docs/06 website_versions, docs/01 P11, docs/10 "Public website intentionally
-- allowlisted, explicit publish").
--
-- Rules:
--  * One site per wedding. The owner and partner (plan.edit) edit the DRAFT and publish; every other
--    member has no access to the site row. Clients have SELECT only; every write is an RPC with a
--    version check and a field-name-only audit event.
--  * The draft is a JSON document made only of allowlisted keys, validated here so a direct RPC call
--    cannot store anything the editor would not. It is text only: no HTML, no images (guest-website
--    images need a separate publication and rights step, ADR-020/024) and links must be https.
--  * Publishing copies the draft into an immutable `published` snapshot built from explicit keys plus
--    the names/dates of the events the owner chose to show. Nothing outside that snapshot (guests,
--    households, budget, vendors, documents, private notes) is reachable from the public routes.
--    Unpublishing deletes the snapshot, so nothing public remains.
--  * Public reads are service_role-only RPCs. The anonymous page by slug returns only 'public'
--    events. The invitation route additionally returns the one event the invitation is for, even if
--    it is 'invited'-only, and never reveals why a token failed (throttled like RSVP lookups).
--  * Slugs are unique across all sites (lower-case, claimed when publishing) and stay reserved to
--    their wedding after an unpublish.

create table public.wedding_sites (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null unique references public.weddings (id) on delete cascade,
  draft jsonb not null,
  -- Bumped by every draft save, publish and unpublish: the optimistic-concurrency token.
  version integer not null default 1,
  slug text check (slug is null or (char_length(slug) between 3 and 40
    and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')),
  published jsonb,
  published_at timestamptz,
  -- The draft state (draft_rev) the snapshot was built from; differs from the current one when the
  -- draft has unpublished changes.
  published_draft_rev integer,
  draft_rev integer not null default 1,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((published is null) = (published_at is null)),
  check (published is null or slug is not null),
  check (jsonb_typeof(draft) = 'object' and pg_column_size(draft) <= 40000)
);
create unique index wedding_sites_slug_uq on public.wedding_sites (slug) where slug is not null;
create trigger wedding_sites_touch before update on public.wedding_sites
  for each row execute function app_private.touch_updated_at();

alter table public.wedding_sites enable row level security;
revoke all on public.wedding_sites from anon, authenticated;
-- The published snapshot is not selectable by clients: editors read the draft; the public reads RPCs.
grant select (id, wedding_id, draft, version, slug, published_at, published_draft_rev, draft_rev,
  created_at, updated_at) on public.wedding_sites to authenticated;
create policy wedding_sites_select_editors on public.wedding_sites
  for select to authenticated using (app_private.can_edit_plan(wedding_id));

-- ---------------------------------------------------------------- validation
-- Optional text field: absent, or a non-empty string within the limit and free of control characters
-- (newlines and tabs are allowed).
create function app_private.site_text(j jsonb, k text, p_max integer) returns boolean
language sql immutable
set search_path = ''
as $$
  select not (j ? k)
    or (jsonb_typeof(j -> k) = 'string'
        and char_length(btrim(j ->> k)) between 1 and p_max
        and char_length(j ->> k) <= p_max
        and (j ->> k) !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]');
$$;

create function app_private.site_keys_ok(j jsonb, p_allowed text[]) returns boolean
language sql immutable
set search_path = ''
as $$
  select jsonb_typeof(j) = 'object'
    and not exists (select 1 from jsonb_object_keys(j) k where k <> all (p_allowed));
$$;

create function app_private.site_valid_date(p text) returns boolean
language plpgsql immutable
set search_path = ''
as $$
begin
  return p ~ '^\d{4}-\d{2}-\d{2}$' and to_char(p::date, 'YYYY-MM-DD') = p;
exception when others then
  return false;
end;
$$;

create function app_private.site_draft_ok(j jsonb, p_wedding uuid) returns boolean
language plpgsql stable
set search_path = ''
as $$
declare
  e jsonb;
  ids text[] := '{}';
begin
  if not app_private.site_keys_ok(j, array['template', 'title', 'tagline', 'date', 'location',
       'story', 'travel', 'faq', 'registry', 'events']) then
    return false;
  end if;
  if j ->> 'template' is null or j ->> 'template' not in ('classic', 'garden', 'modern') then
    return false;
  end if;
  if not (j ? 'title') or not app_private.site_text(j, 'title', 120)
     or not app_private.site_text(j, 'tagline', 200)
     or not app_private.site_text(j, 'location', 200)
     or not app_private.site_text(j, 'story', 3000)
     or not app_private.site_text(j, 'travel', 3000) then
    return false;
  end if;
  if j ? 'date' and not (jsonb_typeof(j -> 'date') = 'string' and app_private.site_valid_date(j ->> 'date')) then
    return false;
  end if;

  if j ? 'faq' then
    if jsonb_typeof(j -> 'faq') <> 'array' or jsonb_array_length(j -> 'faq') > 10 then return false; end if;
    for e in select * from jsonb_array_elements(j -> 'faq') loop
      if not app_private.site_keys_ok(e, array['q', 'a'])
         or not (e ? 'q' and e ? 'a')
         or not app_private.site_text(e, 'q', 200) or not app_private.site_text(e, 'a', 1000) then
        return false;
      end if;
    end loop;
  end if;

  if j ? 'registry' then
    if jsonb_typeof(j -> 'registry') <> 'array' or jsonb_array_length(j -> 'registry') > 6 then return false; end if;
    for e in select * from jsonb_array_elements(j -> 'registry') loop
      if not app_private.site_keys_ok(e, array['label', 'url'])
         or not (e ? 'label' and e ? 'url')
         or not app_private.site_text(e, 'label', 80)
         or jsonb_typeof(e -> 'url') <> 'string'
         or char_length(e ->> 'url') > 2048
         or (e ->> 'url') !~ '^https://[^[:space:][:cntrl:]@]+$' then
        return false;
      end if;
    end loop;
  end if;

  if j ? 'events' then
    if jsonb_typeof(j -> 'events') <> 'array' or jsonb_array_length(j -> 'events') > 12 then return false; end if;
    for e in select * from jsonb_array_elements(j -> 'events') loop
      if not app_private.site_keys_ok(e, array['eventId', 'visibility', 'when', 'where', 'notes'])
         or not (e ? 'eventId' and e ? 'visibility')
         or jsonb_typeof(e -> 'eventId') <> 'string'
         or not app_private.is_uuid(e ->> 'eventId')
         or (e ->> 'visibility') not in ('public', 'invited')
         or not app_private.site_text(e, 'when', 120)
         or not app_private.site_text(e, 'where', 200)
         or not app_private.site_text(e, 'notes', 500) then
        return false;
      end if;
      if (e ->> 'eventId') = any (ids) then return false; end if;
      ids := ids || (e ->> 'eventId');
      if not exists (select 1 from public.events ev
                      where ev.id = (e ->> 'eventId')::uuid and ev.wedding_id = p_wedding) then
        return false;
      end if;
    end loop;
  end if;
  return true;
end;
$$;

create function app_private.site_slug_ok(p text) returns boolean
language sql immutable
set search_path = ''
as $$
  select p is not null
    and char_length(p) between 3 and 40
    and p ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    and p <> all (array['app', 'api', 'www', 'admin', 'rsvp', 'invite', 'sign-in', 'sign-up',
                        'preview', 'design-system', 'static', 'assets']);
$$;

-- The public snapshot: explicit keys only, plus the owner-selected events with their current name,
-- kind and date. Free-text values are copied from the validated draft.
create function app_private.site_snapshot(p_wedding uuid, p_draft jsonb) returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'template', p_draft ->> 'template',
    'title', p_draft ->> 'title',
    'tagline', p_draft ->> 'tagline',
    'date', p_draft ->> 'date',
    'location', p_draft ->> 'location',
    'story', p_draft ->> 'story',
    'travel', p_draft ->> 'travel',
    'faq', coalesce((select jsonb_agg(jsonb_build_object('q', f ->> 'q', 'a', f ->> 'a'))
                       from jsonb_array_elements(coalesce(p_draft -> 'faq', '[]'::jsonb)) f), '[]'::jsonb),
    'registry', coalesce((select jsonb_agg(jsonb_build_object('label', r ->> 'label', 'url', r ->> 'url'))
                            from jsonb_array_elements(coalesce(p_draft -> 'registry', '[]'::jsonb)) r), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                  'eventId', ev.id,
                  'name', ev.name,
                  'kind', ev.kind,
                  'localDate', ev.local_date,
                  'visibility', d ->> 'visibility',
                  'when', d ->> 'when',
                  'where', d ->> 'where',
                  'notes', d ->> 'notes'))
                  order by ev.local_date nulls last, ev.created_at, ev.id)
                from jsonb_array_elements(coalesce(p_draft -> 'events', '[]'::jsonb)) d
                join public.events ev on ev.id = (d ->> 'eventId')::uuid and ev.wedding_id = p_wedding),
                '[]'::jsonb)));
$$;
revoke all on function app_private.site_snapshot(uuid, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------- RPCs (editors)
-- Creates the site (p_expected_version = 0) or saves the draft. Returns the new version.
create function public.save_site_draft(p_wedding uuid, p_expected_version integer, p_draft jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.wedding_sites%rowtype;
  v_version integer;
begin
  v_wedding := app_private.lock_wedding_for_plan(p_wedding);
  if p_draft is null or not app_private.site_draft_ok(p_draft, p_wedding) then
    raise exception 'invalid site' using errcode = '22023';
  end if;
  select * into v_old from public.wedding_sites where wedding_id = p_wedding for update;
  if not found then
    if p_expected_version <> 0 then
      raise exception 'site changed, reload' using errcode = '55000';
    end if;
    insert into public.wedding_sites (wedding_id, draft, created_by)
      values (p_wedding, p_draft, v_user) returning version into v_version;
    insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
      select p_wedding, v_user, 'wedding_site', s.id, 'wedding_site.created', '{}'::jsonb, v_wedding.revision
        from public.wedding_sites s where s.wedding_id = p_wedding;
    return v_version;
  end if;
  if v_old.version <> p_expected_version then
    raise exception 'site changed, reload' using errcode = '55000';
  end if;
  if v_old.draft = p_draft then
    return v_old.version;
  end if;
  update public.wedding_sites
    set draft = p_draft, version = version + 1, draft_rev = draft_rev + 1
    where id = v_old.id returning version into v_version;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'wedding_site', v_old.id, 'wedding_site.draft_saved',
            jsonb_build_object('fields', to_jsonb(array(
              select k from jsonb_object_keys(p_draft || v_old.draft) k
               where p_draft -> k is distinct from v_old.draft -> k order by k))),
            v_wedding.revision);
  return v_version;
end;
$$;

-- Explicit publication of exactly the draft version the editor previewed.
create function public.publish_site(p_wedding uuid, p_expected_version integer, p_slug text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.wedding_sites%rowtype;
  v_slug text := lower(btrim(coalesce(p_slug, '')));
  v_version integer;
begin
  v_wedding := app_private.lock_wedding_for_plan(p_wedding);
  select * into v_old from public.wedding_sites where wedding_id = p_wedding for update;
  if not found or v_old.version <> p_expected_version then
    raise exception 'site changed, reload' using errcode = '55000';
  end if;
  if not app_private.site_slug_ok(v_slug) or not app_private.site_draft_ok(v_old.draft, p_wedding) then
    raise exception 'invalid site' using errcode = '22023';
  end if;
  update public.wedding_sites
    set slug = v_slug,
        published = app_private.site_snapshot(p_wedding, v_old.draft),
        published_at = now(),
        published_draft_rev = v_old.draft_rev,
        version = version + 1
    where id = v_old.id returning version into v_version;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'wedding_site', v_old.id, 'wedding_site.published',
            jsonb_build_object('slugChanged', v_old.slug is distinct from v_slug), v_wedding.revision);
  return v_version;
end;
$$;

create function public.unpublish_site(p_wedding uuid, p_expected_version integer) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.wedding_sites%rowtype;
  v_version integer;
begin
  v_wedding := app_private.lock_wedding_for_plan(p_wedding);
  select * into v_old from public.wedding_sites where wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_old.published is null then
    return v_old.version;
  end if;
  if v_old.version <> p_expected_version then
    raise exception 'site changed, reload' using errcode = '55000';
  end if;
  update public.wedding_sites
    set published = null, published_at = null, published_draft_rev = null, version = version + 1
    where id = v_old.id returning version into v_version;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'wedding_site', v_old.id, 'wedding_site.unpublished', '{}'::jsonb, v_wedding.revision);
  return v_version;
end;
$$;

grant execute on function public.save_site_draft(uuid, integer, jsonb) to authenticated;
grant execute on function public.publish_site(uuid, integer, text) to authenticated;
grant execute on function public.unpublish_site(uuid, integer) to authenticated;
revoke execute on function public.save_site_draft(uuid, integer, jsonb) from public, anon;
revoke execute on function public.publish_site(uuid, integer, text) from public, anon;
revoke execute on function public.unpublish_site(uuid, integer) from public, anon;

-- ---------------------------------------------------------------- public reads (service role only)
-- Builds what a visitor may see. p_event is the invitation's event, or null for anonymous visitors.
create function app_private.site_public_view(p_snapshot jsonb, p_event uuid) returns jsonb
language sql stable
set search_path = ''
as $$
  select (p_snapshot - 'events') || jsonb_build_object('events', coalesce((
    select jsonb_agg(e - 'eventId')
      from jsonb_array_elements(coalesce(p_snapshot -> 'events', '[]'::jsonb)) e
     where e ->> 'visibility' = 'public'
        or (p_event is not null and e ->> 'eventId' = p_event::text)), '[]'::jsonb));
$$;
revoke all on function app_private.site_public_view(jsonb, uuid) from public, anon, authenticated;

create function public.public_site_view(p_slug text) returns jsonb
language sql stable
security definer
set search_path = ''
as $$
  select app_private.site_public_view(s.published, null)
    from public.wedding_sites s
   where s.slug = lower(coalesce(p_slug, '')) and s.published is not null;
$$;

create function public.public_site_invite_view(p_slug text, p_token_hash text, p_client text) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_site public.wedding_sites%rowtype;
  v_inv public.invitations%rowtype;
begin
  perform app_private.rsvp_throttle(p_client, false);
  select * into v_site from public.wedding_sites
    where slug = lower(coalesce(p_slug, '')) and published is not null;
  if found then
    select * into v_inv from public.invitations
      where token_hash = p_token_hash and wedding_id = v_site.wedding_id
        and revoked_at is null and expires_at > now();
  end if;
  if v_inv.id is null then
    perform app_private.rsvp_throttle(p_client, true);
    return null;
  end if;
  return app_private.site_public_view(v_site.published, v_inv.event_id)
         || jsonb_build_object('invitation', jsonb_build_object('label', v_inv.label));
end;
$$;

revoke all on function public.public_site_view(text) from public, anon, authenticated;
revoke all on function public.public_site_invite_view(text, text, text) from public, anon, authenticated;
grant execute on function public.public_site_view(text) to service_role;
grant execute on function public.public_site_invite_view(text, text, text) to service_role;
