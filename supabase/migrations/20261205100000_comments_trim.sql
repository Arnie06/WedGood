-- R1-15 follow-up: btrim() trims spaces only, so a body of newlines or tabs passed as non-empty.
-- Trim all whitespace characters the app trims, and make the table constraint agree.

alter table public.comments drop constraint comments_body_check;
alter table public.comments add constraint comments_body_check
  check (char_length(body) between 1 and 2000 and body = btrim(body, E' \t\r\n'));

create or replace function public.add_comment(
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
  v_body text := btrim(coalesce(p_body, ''), E' \t\r\n');
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

create or replace function public.edit_comment(
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
  v_body text := btrim(coalesce(p_body, ''), E' \t\r\n');
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
