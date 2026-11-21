-- R1-15 sharing and comments (docs/01 P16).
--
-- Rules:
--  * Collaboration happens inside the workspace through existing memberships; no new link or
--    anonymous access. Any active member, including a viewer, can read and write comments on the
--    three shared subjects (vendor candidate, comparison, design board), all of which every member
--    can already read. Comments never widen what a role can see: a comment holds only text the
--    author typed, and the subject must belong to the same wedding.
--  * Authors edit and delete their own comments. Owner and partner may also delete any comment
--    (moderation). Nobody can edit someone else's words.
--  * Clients have SELECT only; every write is an RPC with a membership re-check, wedding lock,
--    idempotency (create) or version check (edit), and an audit event that records the subject
--    kind but never the comment text.
--  * Deleting is a hard delete: the text is gone, the audit event stays.

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  subject_kind text not null check (subject_kind in ('candidate', 'comparison', 'design_board')),
  subject_id uuid not null,
  body text not null check (char_length(body) between 1 and 2000 and body = btrim(body)),
  author_id uuid references auth.users (id) on delete set null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  unique (wedding_id, id)
);
create index comments_subject_idx on public.comments (wedding_id, subject_kind, subject_id, created_at, id);
create index comments_recent_idx on public.comments (wedding_id, created_at desc, id);

alter table public.comments enable row level security;
revoke all on public.comments from anon, authenticated;
grant select on public.comments to authenticated;
create policy comments_select_member on public.comments
  for select to authenticated using (app_private.is_member(wedding_id));

-- The subject must exist in this wedding and still be active. Existence is not revealed to
-- non-members because every caller checks membership first.
create function app_private.comment_subject_active(p_wedding uuid, p_kind text, p_subject uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select case p_kind
    when 'candidate' then exists (
      select 1 from public.candidates where id = p_subject and wedding_id = p_wedding and archived_at is null)
    when 'comparison' then exists (
      select 1 from public.comparisons where id = p_subject and wedding_id = p_wedding and archived_at is null)
    when 'design_board' then exists (
      select 1 from public.design_boards where id = p_subject and wedding_id = p_wedding and archived_at is null)
    else false
  end;
$$;
revoke all on function app_private.comment_subject_active(uuid, text, uuid) from public, anon, authenticated;

-- Shared guard: any active member, wedding row locked in share mode so a removal serializes first.
create function app_private.lock_wedding_for_member(p_wedding uuid)
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
  if not found or not app_private.is_member(p_wedding) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return v_wedding;
end;
$$;
revoke all on function app_private.lock_wedding_for_member(uuid) from public, anon;
grant execute on function app_private.lock_wedding_for_member(uuid) to authenticated;

create function public.add_comment(
  p_wedding uuid,
  p_kind text,
  p_subject uuid,
  p_body text,
  p_idempotency_key text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_body text := btrim(coalesce(p_body, ''));
  v_hash text;
  v_prior uuid;
  v_id uuid;
begin
  v_wedding := app_private.lock_wedding_for_member(p_wedding);
  if p_kind is null or p_kind not in ('candidate', 'comparison', 'design_board')
     or char_length(v_body) not between 1 and 2000 then
    raise exception 'invalid comment' using errcode = '22023';
  end if;
  if p_idempotency_key is not null then
    v_hash := md5(concat_ws('|', p_kind, p_subject::text, v_body));
    v_prior := app_private.idem_claim(v_user, 'add_comment:' || p_wedding::text, p_idempotency_key, v_hash);
    if v_prior is not null then
      return v_prior;
    end if;
  end if;
  if not app_private.comment_subject_active(p_wedding, p_kind, p_subject) then
    raise exception 'subject unavailable' using errcode = '55000';
  end if;
  if (select count(*) from public.comments
        where wedding_id = p_wedding and author_id = v_user
          and created_at > now() - interval '1 minute') >= 20
     or (select count(*) from public.comments
           where wedding_id = p_wedding and subject_kind = p_kind and subject_id = p_subject) >= 500 then
    raise exception 'too many comments' using errcode = '54000';
  end if;
  insert into public.comments (wedding_id, subject_kind, subject_id, body, author_id)
    values (p_wedding, p_kind, p_subject, v_body, v_user)
    returning id into v_id;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'comment', v_id, 'comment.created',
            jsonb_build_object('subject_kind', p_kind), v_wedding.revision);
  if p_idempotency_key is not null then
    perform app_private.idem_done(v_user, 'add_comment:' || p_wedding::text, p_idempotency_key, v_id);
  end if;
  return v_id;
end;
$$;

create function public.edit_comment(
  p_wedding uuid,
  p_comment uuid,
  p_expected_version integer,
  p_body text
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_body text := btrim(coalesce(p_body, ''));
  v_old public.comments%rowtype;
  v_version integer;
begin
  v_wedding := app_private.lock_wedding_for_member(p_wedding);
  select * into v_old from public.comments where id = p_comment and wedding_id = p_wedding for update;
  -- Not found and not yours look the same: no probing of other people's comment ids.
  if not found or v_old.author_id is distinct from v_user then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_old.version <> p_expected_version then
    raise exception 'comment changed, reload' using errcode = '55000';
  end if;
  if char_length(v_body) not between 1 and 2000 then
    raise exception 'invalid comment' using errcode = '22023';
  end if;
  if v_body = v_old.body then
    return v_old.version;
  end if;
  update public.comments
    set body = v_body, version = version + 1, edited_at = now()
    where id = p_comment returning version into v_version;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'comment', p_comment, 'comment.edited',
            jsonb_build_object('subject_kind', v_old.subject_kind), v_wedding.revision);
  return v_version;
end;
$$;

create function public.delete_comment(p_wedding uuid, p_comment uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.comments%rowtype;
  v_moderator boolean;
begin
  v_wedding := app_private.lock_wedding_for_member(p_wedding);
  select * into v_old from public.comments where id = p_comment and wedding_id = p_wedding for update;
  v_moderator := app_private.has_role(p_wedding, array['owner', 'partner']::public.membership_role[]);
  if not found or (v_old.author_id is distinct from v_user and not v_moderator) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  delete from public.comments where id = p_comment;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'comment', p_comment, 'comment.deleted',
            jsonb_build_object('subject_kind', v_old.subject_kind,
                               'moderated', v_old.author_id is distinct from v_user),
            v_wedding.revision);
end;
$$;

-- Reads go through RPCs so author names (profiles are private to their owner) can be joined
-- without exposing profile rows. Members only; non-members get the same error as anyone else.
create function public.list_comments(p_wedding uuid, p_kind text, p_subject uuid)
returns table (
  id uuid,
  body text,
  author_name text,
  is_mine boolean,
  version integer,
  created_at timestamptz,
  edited_at timestamptz
)
language plpgsql stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app_private.is_member(p_wedding) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return query
    select c.id, c.body, p.display_name, c.author_id is not distinct from (select auth.uid()),
           c.version, c.created_at, c.edited_at
    from public.comments c
    left join public.profiles p on p.user_id = c.author_id
    where c.wedding_id = p_wedding and c.subject_kind = p_kind and c.subject_id = p_subject
    order by c.created_at, c.id
    limit 500;
end;
$$;

create function public.recent_comments(p_wedding uuid, p_limit integer default 20)
returns table (
  id uuid,
  subject_kind text,
  subject_id uuid,
  subject_title text,
  body text,
  author_name text,
  created_at timestamptz
)
language plpgsql stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app_private.is_member(p_wedding) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return query
    select c.id, c.subject_kind, c.subject_id,
           coalesce(ca.name, cm.title, db.title) as subject_title,
           c.body, p.display_name, c.created_at
    from public.comments c
    left join public.profiles p on p.user_id = c.author_id
    left join public.candidates ca on c.subject_kind = 'candidate' and ca.id = c.subject_id
    left join public.comparisons cm on c.subject_kind = 'comparison' and cm.id = c.subject_id
    left join public.design_boards db on c.subject_kind = 'design_board' and db.id = c.subject_id
    where c.wedding_id = p_wedding
    order by c.created_at desc, c.id desc
    limit least(greatest(coalesce(p_limit, 20), 1), 50);
end;
$$;

revoke all on function public.add_comment(uuid, text, uuid, text, text) from public, anon;
revoke all on function public.edit_comment(uuid, uuid, integer, text) from public, anon;
revoke all on function public.delete_comment(uuid, uuid) from public, anon;
revoke all on function public.list_comments(uuid, text, uuid) from public, anon;
revoke all on function public.recent_comments(uuid, integer) from public, anon;
grant execute on function public.add_comment(uuid, text, uuid, text, text) to authenticated;
grant execute on function public.edit_comment(uuid, uuid, integer, text) to authenticated;
grant execute on function public.delete_comment(uuid, uuid) to authenticated;
grant execute on function public.list_comments(uuid, text, uuid) to authenticated;
grant execute on function public.recent_comments(uuid, integer) to authenticated;
