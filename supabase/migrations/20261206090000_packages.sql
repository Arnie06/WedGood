-- R1-16 PDF/CSV package builder (docs/11-EXPORTS-AND-OPERATIONS.md).
--
-- Rules:
--  * A package is an immutable snapshot: the redacted document the recipient reads, a SHA-256
--    digest of it, the plan revision it was taken at and the template version. Rows can be
--    inserted once and never updated; they disappear only with the wedding.
--  * Only owner and partner can create or read packages and their files. Clients have SELECT only;
--    creation is the `create_package` RPC (membership re-check under a wedding lock, revision
--    check, idempotency keyed on the package id, rate limits, audit without content).
--  * Files live in a private bucket with no policies at all, so nobody reads them directly. The
--    server authorizes the user, then reads the object with the service role and checks the
--    stored checksum. Storage keys are derived here from ids, never taken from the caller.
--  * Staleness is decided by the application by re-deriving the document and comparing digests,
--    because most modules do not bump weddings.revision. The revision is stored as evidence.

create function app_private.can_manage_packages(p_wedding uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select app_private.has_role(p_wedding, array['owner', 'partner']::public.membership_role[]);
$$;
revoke all on function app_private.can_manage_packages(uuid) from public, anon;
grant execute on function app_private.can_manage_packages(uuid) to authenticated;

create table public.packages (
  id uuid primary key,
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120 and title = btrim(title)),
  preset text not null check (preset in ('master', 'financial', 'venue_comparison', 'caterer', 'coordinator', 'custom')),
  recipient text not null check (char_length(recipient) <= 80),
  sections text[] not null check (
    cardinality(sections) between 1 and 11
    and sections <@ array['overview', 'events', 'timeline', 'vendors', 'budget', 'payments',
                          'rsvp', 'seating', 'design', 'documents', 'decisions']
  ),
  options jsonb not null check (jsonb_typeof(options) = 'object'),
  formats text[] not null check (cardinality(formats) between 1 and 2 and formats <@ array['pdf', 'csv']),
  paper text not null check (paper in ('a4', 'letter')),
  orientation text not null check (orientation in ('portrait', 'landscape')),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  snapshot_digest text not null check (snapshot_digest ~ '^[0-9a-f]{64}$'),
  source_revision integer not null,
  template_version integer not null check (template_version >= 1),
  generated_at timestamptz not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (wedding_id, id)
);
create index packages_wedding_idx on public.packages (wedding_id, created_at desc, id);

create table public.package_artifacts (
  id uuid primary key default gen_random_uuid(),
  package_id uuid not null,
  wedding_id uuid not null,
  format text not null check (format in ('pdf', 'csv')),
  storage_key text not null unique,
  checksum_sha256 text not null check (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  bytes integer not null check (bytes between 1 and 5242880),
  created_at timestamptz not null default now(),
  unique (package_id, format),
  check (storage_key = wedding_id::text || '/' || package_id::text || '.' || format),
  foreign key (wedding_id, package_id) references public.packages (wedding_id, id) on delete cascade
);
create index package_artifacts_wedding_idx on public.package_artifacts (wedding_id, package_id);

create function app_private.packages_immutable() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'packages are immutable snapshots' using errcode = '55000';
end;
$$;
create trigger packages_no_update before update on public.packages
  for each row execute function app_private.packages_immutable();
create trigger package_artifacts_no_update before update on public.package_artifacts
  for each row execute function app_private.packages_immutable();

alter table public.packages enable row level security;
alter table public.package_artifacts enable row level security;
revoke all on public.packages from anon, authenticated;
revoke all on public.package_artifacts from anon, authenticated;
grant select on public.packages to authenticated;
grant select on public.package_artifacts to authenticated;
create policy packages_select_managers on public.packages
  for select to authenticated using (app_private.can_manage_packages(wedding_id));
create policy package_artifacts_select_managers on public.package_artifacts
  for select to authenticated using (app_private.can_manage_packages(wedding_id));

-- Private bucket, intentionally with no storage.objects policy: only the service role reads or
-- writes it, after the application has authorized the signed-in user.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('wedding-packages', 'wedding-packages', false, 5242880,
          array['application/pdf', 'text/csv'])
  on conflict (id) do update
    set public = false, file_size_limit = 5242880,
        allowed_mime_types = array['application/pdf', 'text/csv'];

create function app_private.lock_wedding_for_packages(p_wedding uuid)
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
  select * into v_wedding from public.weddings where id = p_wedding for share;
  if not found or not app_private.can_manage_packages(p_wedding) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return v_wedding;
end;
$$;
revoke all on function app_private.lock_wedding_for_packages(uuid) from public, anon;
grant execute on function app_private.lock_wedding_for_packages(uuid) to authenticated;

-- p_artifacts: [{format, checksum, bytes}]. Keys are derived here. The ids are the caller's choice
-- so a retried submit finds the same package instead of creating a second one.
create function public.create_package(
  p_wedding uuid,
  p_id uuid,
  p_title text,
  p_preset text,
  p_recipient text,
  p_sections text[],
  p_options jsonb,
  p_formats text[],
  p_paper text,
  p_orientation text,
  p_snapshot jsonb,
  p_digest text,
  p_expected_revision integer,
  p_template_version integer,
  p_generated_at timestamptz,
  p_artifacts jsonb
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_title text := btrim(coalesce(p_title, ''));
  v_hash text;
  v_prior uuid;
  a jsonb;
  v_formats text[];
begin
  v_wedding := app_private.lock_wedding_for_packages(p_wedding);
  if p_id is null or char_length(v_title) not between 1 and 120
     or p_sections is null or p_formats is null or p_snapshot is null or p_artifacts is null
     or p_digest is null or p_digest !~ '^[0-9a-f]{64}$'
     or p_generated_at is null
     or abs(extract(epoch from (now() - p_generated_at))) > 7200
     or octet_length(p_snapshot::text) > 1000000
     or jsonb_typeof(p_artifacts) <> 'array' then
    raise exception 'invalid package' using errcode = '22023';
  end if;

  v_hash := md5(concat_ws('|', p_digest, v_title, p_preset, coalesce(p_recipient, ''),
                          array_to_string(p_sections, ','), array_to_string(p_formats, ','),
                          p_paper, p_orientation, p_options::text));
  v_prior := app_private.idem_claim(v_user, 'create_package:' || p_wedding::text, p_id::text, v_hash);
  if v_prior is not null then
    return v_prior;
  end if;

  if p_expected_revision is distinct from v_wedding.revision then
    raise exception 'plan revision changed' using errcode = '55000';
  end if;
  if exists (select 1 from public.packages where id = p_id) then
    raise exception 'package id already used' using errcode = '23505';
  end if;
  if (select count(*) from public.packages
        where wedding_id = p_wedding and created_by = v_user
          and created_at > now() - interval '1 hour') >= 20
     or (select count(*) from public.packages where wedding_id = p_wedding) >= 200 then
    raise exception 'too many packages' using errcode = '54000';
  end if;

  select array_agg(distinct x order by x) into v_formats from unnest(p_formats) x;
  if (select array_agg(distinct e ->> 'format' order by e ->> 'format')
        from jsonb_array_elements(p_artifacts) e) is distinct from v_formats then
    raise exception 'files do not match the chosen formats' using errcode = '22023';
  end if;

  insert into public.packages (id, wedding_id, title, preset, recipient, sections, options, formats,
                               paper, orientation, snapshot, snapshot_digest, source_revision,
                               template_version, generated_at, created_by)
    values (p_id, p_wedding, v_title, p_preset, btrim(coalesce(p_recipient, '')), p_sections,
            p_options, v_formats, p_paper, p_orientation, p_snapshot, p_digest,
            v_wedding.revision, p_template_version, p_generated_at, v_user);

  for a in select * from jsonb_array_elements(p_artifacts) loop
    insert into public.package_artifacts (package_id, wedding_id, format, storage_key, checksum_sha256, bytes)
      values (p_id, p_wedding, a ->> 'format',
              p_wedding::text || '/' || p_id::text || '.' || (a ->> 'format'),
              a ->> 'checksum', (a ->> 'bytes')::integer);
  end loop;

  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'package', p_id, 'package.created',
            jsonb_build_object('preset', p_preset, 'sections', cardinality(p_sections),
                               'formats', to_jsonb(v_formats)),
            v_wedding.revision);
  perform app_private.idem_done(v_user, 'create_package:' || p_wedding::text, p_id::text, p_id);
  return p_id;
end;
$$;
revoke all on function public.create_package(uuid, uuid, text, text, text, text[], jsonb, text[], text, text, jsonb, text, integer, integer, timestamptz, jsonb) from public, anon;
grant execute on function public.create_package(uuid, uuid, text, text, text, text[], jsonb, text[], text, text, jsonb, text, integer, integer, timestamptz, jsonb) to authenticated;
