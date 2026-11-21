-- R0-04 membership administration: collaborator invites, role changes, removal,
-- last-owner protection. All writes go through SECURITY DEFINER RPCs that
-- re-check the actor; authenticated users keep SELECT only (RLS-scoped).
-- See docs/10-SECURITY.md (role matrix) and docs/06-DATA-MODEL.md.

-- ---------------------------------------------------------------- authorization helper
-- 'owner' = full member administration; 'delegate' = partner explicitly granted
-- permissions.manage_members (may administer editors/viewers only); null = none.
create function app_private.admin_level(p_wedding uuid) returns text
language sql stable security definer
set search_path = ''
as $$
  select case
    when m.role = 'owner' then 'owner'
    when m.role = 'partner' and m.permissions ->> 'manage_members' = 'true' then 'delegate'
  end
  from public.memberships m
  where m.wedding_id = p_wedding and m.user_id = (select auth.uid()) and m.status = 'active';
$$;
revoke all on function app_private.admin_level(uuid) from public, anon;
grant execute on function app_private.admin_level(uuid) to authenticated;

-- ---------------------------------------------------------------- collaborator invites
create table public.collaborator_invites (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  email text not null check (email = lower(email) and char_length(email) <= 254),
  role public.membership_role not null check (role <> 'owner'),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  invited_by uuid references auth.users (id) on delete set null,
  expires_at timestamptz not null,
  redeemed_at timestamptz,
  redeemed_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (redeemed_at is null or revoked_at is null)
);
create index collaborator_invites_wedding_idx on public.collaborator_invites (wedding_id, created_at desc);

alter table public.collaborator_invites enable row level security;
revoke all on public.collaborator_invites from anon, authenticated;
-- token_hash is deliberately not selectable by any client role.
grant select (id, wedding_id, email, role, invited_by, expires_at, redeemed_at, redeemed_by, revoked_at, created_at)
  on public.collaborator_invites to authenticated;
create policy collaborator_invites_select_admin on public.collaborator_invites
  for select to authenticated
  using (app_private.admin_level(wedding_id) is not null);

-- ---------------------------------------------------------------- shared guard
-- Locks the wedding row (serializes membership changes) and returns the actor's
-- admin level. Non-members and unknown weddings get the same error: no existence leak.
create function app_private.lock_wedding_for_admin(p_wedding uuid, out v_actor uuid, out v_level text, out v_revision integer)
language plpgsql
security definer
set search_path = ''
as $$
begin
  v_actor := (select auth.uid());
  if v_actor is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select w.revision into v_revision from public.weddings w where w.id = p_wedding for update;
  v_level := app_private.admin_level(p_wedding);
  if v_revision is null or v_level is null then
    raise exception 'not permitted' using errcode = '42501';
  end if;
end;
$$;
revoke all on function app_private.lock_wedding_for_admin(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- create invite
-- The app generates the random token and passes only its SHA-256 hex digest;
-- the raw token never reaches the database or the audit log.
create function public.create_collaborator_invite(
  p_wedding uuid,
  p_email text,
  p_role public.membership_role,
  p_token_hash text,
  p_valid_for interval default interval '7 days'
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_level text;
  v_revision integer;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_id uuid;
begin
  select * into v_actor, v_level, v_revision from app_private.lock_wedding_for_admin(p_wedding);

  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 254 then
    raise exception 'a valid email address is required' using errcode = '22023';
  end if;
  if p_role not in ('partner', 'editor', 'viewer') then
    raise exception 'role cannot be granted by invitation' using errcode = '22023';
  end if;
  if v_level = 'delegate' and p_role not in ('editor', 'viewer') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid token digest' using errcode = '22023';
  end if;
  if p_valid_for is null or p_valid_for <= interval '0' or p_valid_for > interval '30 days' then
    raise exception 'invitation validity must be between 0 and 30 days' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.memberships m
    join auth.users u on u.id = m.user_id
    where m.wedding_id = p_wedding and m.status = 'active' and lower(u.email) = v_email
  ) then
    raise exception 'that person is already a member' using errcode = '23505';
  end if;
  if exists (
    select 1 from public.collaborator_invites i
    where i.wedding_id = p_wedding and i.email = v_email
      and i.redeemed_at is null and i.revoked_at is null and i.expires_at > now()
  ) then
    raise exception 'an invitation for that email is already pending' using errcode = '23505';
  end if;

  insert into public.collaborator_invites (wedding_id, email, role, token_hash, invited_by, expires_at)
    values (p_wedding, v_email, p_role, p_token_hash, v_actor, now() + p_valid_for)
    returning id into v_id;

  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_actor, 'collaborator_invite', v_id, 'invite.created',
            jsonb_build_object('role', p_role), v_revision);
  return v_id;
end;
$$;

-- ---------------------------------------------------------------- revoke invite
create function public.revoke_collaborator_invite(p_invite uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wedding uuid;
  v_role public.membership_role;
  v_actor uuid;
  v_level text;
  v_revision integer;
  v_done uuid;
begin
  select i.wedding_id, i.role into v_wedding, v_role
    from public.collaborator_invites i where i.id = p_invite;
  if v_wedding is null then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  select * into v_actor, v_level, v_revision from app_private.lock_wedding_for_admin(v_wedding);
  if v_level = 'delegate' and v_role not in ('editor', 'viewer') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  update public.collaborator_invites set revoked_at = now()
    where id = p_invite and redeemed_at is null and revoked_at is null
    returning id into v_done;
  if v_done is null then
    raise exception 'invitation is no longer pending' using errcode = '55000';
  end if;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (v_wedding, v_actor, 'collaborator_invite', p_invite, 'invite.revoked', '{}'::jsonb, v_revision);
end;
$$;

-- ---------------------------------------------------------------- redeem invite
-- One-time, email-matched, expiring. Every failure mode returns the same message
-- so a token holder cannot probe invite state.
create function public.redeem_collaborator_invite(p_token_hash text) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_email text;
  v_invite public.collaborator_invites%rowtype;
  v_revision integer;
  v_membership uuid;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid or expired invitation' using errcode = 'P0002';
  end if;

  select lower(u.email) into v_email from auth.users u
    where u.id = v_user and u.email_confirmed_at is not null;

  select * into v_invite from public.collaborator_invites
    where token_hash = p_token_hash for update;
  if not found
     or v_email is null
     or v_invite.email <> v_email
     or v_invite.redeemed_at is not null
     or v_invite.revoked_at is not null
     or v_invite.expires_at <= now() then
    raise exception 'invalid or expired invitation' using errcode = 'P0002';
  end if;

  select w.revision into v_revision from public.weddings w where w.id = v_invite.wedding_id for update;

  if exists (
    select 1 from public.memberships m
    where m.wedding_id = v_invite.wedding_id and m.user_id = v_user and m.status = 'active'
  ) then
    raise exception 'invalid or expired invitation' using errcode = 'P0002';
  end if;

  insert into public.memberships (wedding_id, user_id, role)
    values (v_invite.wedding_id, v_user, v_invite.role)
    on conflict (wedding_id, user_id)
    do update set status = 'active', role = excluded.role, permissions = '{}'::jsonb
    returning id into v_membership;

  update public.collaborator_invites set redeemed_at = now(), redeemed_by = v_user
    where id = v_invite.id;

  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (v_invite.wedding_id, v_user, 'membership', v_membership, 'member.joined',
            jsonb_build_object('role', v_invite.role, 'invite_id', v_invite.id), v_revision);
  return v_invite.wedding_id;
end;
$$;

-- ---------------------------------------------------------------- change role
create function public.change_member_role(
  p_membership uuid,
  p_role public.membership_role,
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
begin
  select * into v_target from public.memberships where id = p_membership;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  select * into v_actor, v_level, v_revision from app_private.lock_wedding_for_admin(v_target.wedding_id);

  -- re-read under the wedding lock
  select * into v_target from public.memberships where id = p_membership;
  if v_target.status <> 'active' then
    raise exception 'member is not active' using errcode = '55000';
  end if;
  if v_target.version <> p_expected_version then
    raise exception 'membership changed; reload and retry' using errcode = '55000';
  end if;
  if v_level = 'delegate'
     and (v_target.role not in ('editor', 'viewer') or p_role not in ('editor', 'viewer')) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_target.role = p_role then
    return;
  end if;
  if v_target.role = 'owner' and not exists (
    select 1 from public.memberships m
    where m.wedding_id = v_target.wedding_id and m.status = 'active'
      and m.role = 'owner' and m.id <> v_target.id
  ) then
    raise exception 'a wedding must keep at least one owner' using errcode = '23514';
  end if;

  update public.memberships
    set role = p_role,
        permissions = case when p_role = 'partner' then permissions else '{}'::jsonb end
    where id = v_target.id;

  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (v_target.wedding_id, v_actor, 'membership', v_target.id, 'member.role_changed',
            jsonb_build_object('from', v_target.role, 'to', p_role), v_revision);
end;
$$;

-- ---------------------------------------------------------------- partner grants
-- Owner-only. Only whitelisted keys; the owner sees the grant set before and after.
create function public.set_partner_permissions(
  p_membership uuid,
  p_manage_members boolean,
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
begin
  select * into v_target from public.memberships where id = p_membership;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  select * into v_actor, v_level, v_revision from app_private.lock_wedding_for_admin(v_target.wedding_id);
  if v_level <> 'owner' then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  select * into v_target from public.memberships where id = p_membership;
  if v_target.status <> 'active' or v_target.role <> 'partner' then
    raise exception 'permissions apply to active partners only' using errcode = '55000';
  end if;
  if v_target.version <> p_expected_version then
    raise exception 'membership changed; reload and retry' using errcode = '55000';
  end if;

  update public.memberships
    set permissions = jsonb_build_object('manage_members', coalesce(p_manage_members, false))
    where id = v_target.id;

  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (v_target.wedding_id, v_actor, 'membership', v_target.id, 'member.permissions_changed',
            jsonb_build_object('manage_members', coalesce(p_manage_members, false)), v_revision);
end;
$$;

-- ---------------------------------------------------------------- remove / leave
create function public.remove_member(p_membership uuid, p_expected_version integer) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target public.memberships%rowtype;
  v_actor uuid := (select auth.uid());
  v_wedding_actor uuid;
  v_level text;
  v_revision integer;
begin
  select * into v_target from public.memberships where id = p_membership;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  -- Lock the wedding first (also serializes with other membership changes).
  if v_actor is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select w.revision into v_revision from public.weddings w where w.id = v_target.wedding_id for update;
  select * into v_target from public.memberships where id = p_membership;
  v_level := app_private.admin_level(v_target.wedding_id);

  -- Anyone may leave; removing someone else needs administration rights.
  if v_target.user_id <> v_actor then
    if v_level is null or (v_level = 'delegate' and v_target.role not in ('editor', 'viewer')) then
      raise exception 'not permitted' using errcode = '42501';
    end if;
  elsif not app_private.is_member(v_target.wedding_id) then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  if v_target.status <> 'active' then
    raise exception 'member is not active' using errcode = '55000';
  end if;
  if v_target.version <> p_expected_version then
    raise exception 'membership changed; reload and retry' using errcode = '55000';
  end if;
  if v_target.role = 'owner' and not exists (
    select 1 from public.memberships m
    where m.wedding_id = v_target.wedding_id and m.status = 'active'
      and m.role = 'owner' and m.id <> v_target.id
  ) then
    raise exception 'a wedding must keep at least one owner' using errcode = '23514';
  end if;

  update public.memberships set status = 'removed', permissions = '{}'::jsonb where id = v_target.id;

  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (v_target.wedding_id, v_actor, 'membership', v_target.id,
            case when v_target.user_id = v_actor then 'member.left' else 'member.removed' end,
            jsonb_build_object('role', v_target.role), v_revision);
end;
$$;

-- ---------------------------------------------------------------- list members
-- Display names come from profiles (not otherwise readable across users). Email
-- is returned only to member administrators.
create function public.list_members(p_wedding uuid)
returns table (
  membership_id uuid,
  user_id uuid,
  display_name text,
  email text,
  role public.membership_role,
  permissions jsonb,
  version integer,
  joined_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin boolean;
begin
  if (select auth.uid()) is null or not app_private.is_member(p_wedding) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  v_admin := app_private.admin_level(p_wedding) is not null;
  return query
    select m.id, m.user_id, p.display_name,
           case when v_admin then u.email::text end,
           m.role, m.permissions, m.version, m.created_at
    from public.memberships m
    left join public.profiles p on p.user_id = m.user_id
    left join auth.users u on u.id = m.user_id
    where m.wedding_id = p_wedding and m.status = 'active'
    order by m.created_at, m.id;
end;
$$;

-- ---------------------------------------------------------------- grants
revoke all on function public.create_collaborator_invite(uuid, text, public.membership_role, text, interval) from public, anon;
revoke all on function public.revoke_collaborator_invite(uuid) from public, anon;
revoke all on function public.redeem_collaborator_invite(text) from public, anon;
revoke all on function public.change_member_role(uuid, public.membership_role, integer) from public, anon;
revoke all on function public.set_partner_permissions(uuid, boolean, integer) from public, anon;
revoke all on function public.remove_member(uuid, integer) from public, anon;
revoke all on function public.list_members(uuid) from public, anon;
grant execute on function public.create_collaborator_invite(uuid, text, public.membership_role, text, interval) to authenticated;
grant execute on function public.revoke_collaborator_invite(uuid) to authenticated;
grant execute on function public.redeem_collaborator_invite(text) to authenticated;
grant execute on function public.change_member_role(uuid, public.membership_role, integer) to authenticated;
grant execute on function public.set_partner_permissions(uuid, boolean, integer) to authenticated;
grant execute on function public.remove_member(uuid, integer) to authenticated;
grant execute on function public.list_members(uuid) to authenticated;
