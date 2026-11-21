-- R1-02 checklist: tasks, suggested-checklist generation, manual tasks, status,
-- archive and reviewed rescheduling of date-relative tasks.
--
-- Rules (docs/07-DOMAIN-RULES.md): template tasks carry a stable key, so
-- regenerating never duplicates and never overwrites edits or resurrects tasks
-- a person archived. "relative" tasks follow the wedding date through a signed
-- day offset; "fixed" tasks never move unless a person edits them. Editing the
-- date of a relative task makes it fixed. All writes go through these RPCs;
-- clients only get SELECT through RLS. plan.edit = owner and partner.

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 160),
  notes text check (notes is null or char_length(notes) <= 2000),
  status text not null default 'open' check (status in ('open', 'done')),
  due_date date check (due_date is null or due_date between date '1970-01-01' and date '2200-12-31'),
  date_kind text not null default 'fixed' check (date_kind in ('fixed', 'relative')),
  offset_days integer check (offset_days is null or offset_days between -1500 and 1500),
  template_key text check (template_key is null or template_key ~ '^[a-z0-9-]{1,64}$'),
  phase text check (phase is null or char_length(phase) <= 32),
  sort_order integer not null default 1000,
  assignee_user_id uuid references auth.users (id) on delete set null,
  completed_at timestamptz,
  completed_by uuid references auth.users (id) on delete set null,
  created_by uuid references auth.users (id) on delete set null,
  archived_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (wedding_id, id),
  -- One instance of each suggested task per wedding, archived or not.
  unique (wedding_id, template_key),
  check (date_kind = 'fixed' or (offset_days is not null and template_key is not null)),
  check ((status = 'done') = (completed_at is not null))
);
create index tasks_wedding_idx on public.tasks (wedding_id, sort_order, due_date) where archived_at is null;
create trigger tasks_touch before update on public.tasks
  for each row execute function app_private.touch_updated_at();

alter table public.tasks enable row level security;
revoke all on public.tasks from anon, authenticated;
grant select on public.tasks to authenticated;
create policy tasks_select_member on public.tasks
  for select to authenticated using (app_private.is_member(wedding_id));

-- plan.edit: owner and partner (mirrors src/domain/permissions).
create function app_private.can_edit_plan(p_wedding uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select app_private.has_role(p_wedding, array['owner', 'partner']::public.membership_role[]);
$$;
revoke all on function app_private.can_edit_plan(uuid) from public, anon;
grant execute on function app_private.can_edit_plan(uuid) to authenticated;

-- Shared guard: locks the wedding row in share mode (serializes against the
-- settings update, which takes it for update), then authorizes. Non-members
-- and unknown ids get the same error.
create function app_private.lock_wedding_for_plan(p_wedding uuid)
returns public.weddings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select * into v_wedding from public.weddings where id = p_wedding for share;
  if not found or not app_private.can_edit_plan(p_wedding) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return v_wedding;
end;
$$;
revoke all on function app_private.lock_wedding_for_plan(uuid) from public, anon;
grant execute on function app_private.lock_wedding_for_plan(uuid) to authenticated;

create function app_private.assert_assignable(p_wedding uuid, p_assignee uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_assignee is not null and not exists (
    select 1 from public.memberships m
    where m.wedding_id = p_wedding and m.user_id = p_assignee and m.status = 'active'
  ) then
    raise exception 'assignee must be an active member' using errcode = '22023';
  end if;
end;
$$;
revoke all on function app_private.assert_assignable(uuid, uuid) from public, anon;
grant execute on function app_private.assert_assignable(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------- generate
-- p_items: [{key, title, notes?, phase, offsetDays}]. Idempotent by (wedding, key).
create function public.generate_checklist(p_wedding uuid, p_items jsonb) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_item jsonb;
  v_inserted integer;
begin
  v_wedding := app_private.lock_wedding_for_plan(p_wedding);

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 100 then
    raise exception 'invalid checklist' using errcode = '22023';
  end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) <> 'object'
       or jsonb_typeof(v_item -> 'key') is distinct from 'string'
       or (v_item ->> 'key') !~ '^[a-z0-9-]{1,64}$'
       or jsonb_typeof(v_item -> 'title') is distinct from 'string'
       or char_length(btrim(v_item ->> 'title')) not between 1 and 160
       or jsonb_typeof(v_item -> 'offsetDays') is distinct from 'number'
       or (v_item ->> 'offsetDays') !~ '^-?[0-9]{1,4}$'
       or abs((v_item ->> 'offsetDays')::integer) > 1500
       or (v_item ? 'notes' and jsonb_typeof(v_item -> 'notes') not in ('string', 'null'))
       or char_length(coalesce(v_item ->> 'notes', '')) > 2000
       or char_length(coalesce(v_item ->> 'phase', '')) > 32 then
      raise exception 'invalid checklist item' using errcode = '22023';
    end if;
  end loop;

  insert into public.tasks (wedding_id, title, notes, phase, sort_order, date_kind, offset_days,
                            template_key, due_date, created_by)
    select p_wedding, btrim(e.item ->> 'title'), nullif(btrim(coalesce(e.item ->> 'notes', '')), ''),
           nullif(e.item ->> 'phase', ''), e.ord::integer, 'relative',
           (e.item ->> 'offsetDays')::integer, e.item ->> 'key',
           case when v_wedding.date is null then null
                else v_wedding.date + (e.item ->> 'offsetDays')::integer end,
           v_user
      from jsonb_array_elements(p_items) with ordinality as e(item, ord)
    on conflict (wedding_id, template_key) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted > 0 then
    insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
      values (p_wedding, v_user, 'wedding', p_wedding, 'tasks.checklist_generated',
              jsonb_build_object('added', v_inserted), v_wedding.revision);
  end if;
  return v_inserted;
end;
$$;

-- ---------------------------------------------------------------- create
create function public.create_task(
  p_wedding uuid,
  p_title text,
  p_notes text default null,
  p_due_date date default null,
  p_assignee uuid default null,
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
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_hash text;
  v_existing public.idempotency_keys%rowtype;
  v_task uuid;
begin
  v_wedding := app_private.lock_wedding_for_plan(p_wedding);
  if char_length(v_title) not between 1 and 160 then
    raise exception 'invalid title' using errcode = '22023';
  end if;
  if v_notes is not null and char_length(v_notes) > 2000 then
    raise exception 'notes are too long' using errcode = '22023';
  end if;
  if p_due_date is not null and p_due_date not between date '1970-01-01' and date '2200-12-31' then
    raise exception 'invalid date' using errcode = '22023';
  end if;
  perform app_private.assert_assignable(p_wedding, p_assignee);

  if p_idempotency_key is not null then
    v_hash := md5(concat_ws('|', v_title, coalesce(v_notes, ''), coalesce(p_due_date::text, ''),
                            coalesce(p_assignee::text, '')));
    insert into public.idempotency_keys (actor_scope, operation, key, request_hash)
      values (v_user::text, 'create_task:' || p_wedding::text, p_idempotency_key, v_hash)
      on conflict do nothing;
    select * into v_existing from public.idempotency_keys
      where actor_scope = v_user::text and operation = 'create_task:' || p_wedding::text
        and key = p_idempotency_key
      for update;
    if v_existing.request_hash <> v_hash then
      raise exception 'idempotency key reused with different request' using errcode = '23505';
    end if;
    if v_existing.response_ref is not null then
      return v_existing.response_ref;
    end if;
  end if;

  insert into public.tasks (wedding_id, title, notes, due_date, date_kind, assignee_user_id, created_by)
    values (p_wedding, v_title, v_notes, p_due_date, 'fixed', p_assignee, v_user)
    returning id into v_task;

  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'task', v_task, 'task.created', '{}'::jsonb, v_wedding.revision);

  if p_idempotency_key is not null then
    update public.idempotency_keys set response_ref = v_task
      where actor_scope = v_user::text and operation = 'create_task:' || p_wedding::text
        and key = p_idempotency_key;
  end if;
  return v_task;
end;
$$;

-- ---------------------------------------------------------------- update
-- Full replacement of the editable fields, guarded by the caller's version.
-- Changing the due date of a relative task makes it fixed (a customization).
create function public.update_task(
  p_wedding uuid,
  p_task uuid,
  p_expected_version integer,
  p_title text,
  p_notes text default null,
  p_due_date date default null,
  p_assignee uuid default null
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.tasks%rowtype;
  v_title text := btrim(coalesce(p_title, ''));
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_changed text[] := '{}';
  v_kind text;
  v_version integer;
begin
  v_wedding := app_private.lock_wedding_for_plan(p_wedding);
  select * into v_old from public.tasks where id = p_task and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_old.archived_at is not null or v_old.version <> p_expected_version then
    raise exception 'task changed, reload' using errcode = '55000';
  end if;
  if char_length(v_title) not between 1 and 160 then
    raise exception 'invalid title' using errcode = '22023';
  end if;
  if v_notes is not null and char_length(v_notes) > 2000 then
    raise exception 'notes are too long' using errcode = '22023';
  end if;
  if p_due_date is not null and p_due_date not between date '1970-01-01' and date '2200-12-31' then
    raise exception 'invalid date' using errcode = '22023';
  end if;
  perform app_private.assert_assignable(p_wedding, p_assignee);

  if v_title is distinct from v_old.title then v_changed := array_append(v_changed, 'title'); end if;
  if v_notes is distinct from v_old.notes then v_changed := array_append(v_changed, 'notes'); end if;
  if p_due_date is distinct from v_old.due_date then v_changed := array_append(v_changed, 'dueDate'); end if;
  if p_assignee is distinct from v_old.assignee_user_id then v_changed := array_append(v_changed, 'assignee'); end if;
  if coalesce(array_length(v_changed, 1), 0) = 0 then
    return v_old.version;
  end if;

  v_kind := case when 'dueDate' = any (v_changed) then 'fixed' else v_old.date_kind end;
  update public.tasks set title = v_title, notes = v_notes, due_date = p_due_date,
      assignee_user_id = p_assignee, date_kind = v_kind, version = version + 1
    where id = p_task
    returning version into v_version;

  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'task', p_task, 'task.updated',
            jsonb_build_object('changed', to_jsonb(v_changed)), v_wedding.revision);
  return v_version;
end;
$$;

-- ---------------------------------------------------------------- status
-- Idempotent: asking for the status a task already has is a successful no-op.
create function public.set_task_status(
  p_wedding uuid,
  p_task uuid,
  p_expected_version integer,
  p_done boolean
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.tasks%rowtype;
  v_version integer;
begin
  v_wedding := app_private.lock_wedding_for_plan(p_wedding);
  if p_done is null then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  select * into v_old from public.tasks where id = p_task and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_old.archived_at is not null then
    raise exception 'task changed, reload' using errcode = '55000';
  end if;
  if (v_old.status = 'done') = p_done then
    return v_old.version;
  end if;
  if v_old.version <> p_expected_version then
    raise exception 'task changed, reload' using errcode = '55000';
  end if;

  update public.tasks set
      status = case when p_done then 'done' else 'open' end,
      completed_at = case when p_done then now() else null end,
      completed_by = case when p_done then v_user else null end,
      version = version + 1
    where id = p_task
    returning version into v_version;

  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'task', p_task,
            case when p_done then 'task.completed' else 'task.reopened' end,
            '{}'::jsonb, v_wedding.revision);
  return v_version;
end;
$$;

-- ---------------------------------------------------------------- archive
-- Soft delete; keeps the template key so regeneration never brings it back.
create function public.archive_task(p_wedding uuid, p_task uuid, p_expected_version integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_old public.tasks%rowtype;
begin
  v_wedding := app_private.lock_wedding_for_plan(p_wedding);
  select * into v_old from public.tasks where id = p_task and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_old.archived_at is not null then
    return;
  end if;
  if v_old.version <> p_expected_version then
    raise exception 'task changed, reload' using errcode = '55000';
  end if;
  update public.tasks set archived_at = now(), version = version + 1 where id = p_task;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'task', p_task, 'task.archived', '{}'::jsonb, v_wedding.revision);
end;
$$;

-- ---------------------------------------------------------------- reviewed reschedule
-- p_approved: [{id, version}] chosen from a preview the person reviewed. New
-- dates are recomputed here from the stored offset and the wedding's current
-- date, never taken from the client. Only open relative tasks qualify; fixed
-- dates are never touched. Any task that changed since the preview aborts the
-- whole batch so the person re-reviews.
create function public.reschedule_relative_tasks(p_wedding uuid, p_approved jsonb) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_item record;
  v_task public.tasks%rowtype;
  v_target date;
  v_count integer := 0;
begin
  v_wedding := app_private.lock_wedding_for_plan(p_wedding);
  if p_approved is null or jsonb_typeof(p_approved) <> 'array' or jsonb_array_length(p_approved) > 200 then
    raise exception 'invalid selection' using errcode = '22023';
  end if;

  for v_item in
    select (e ->> 'id')::uuid as id, (e ->> 'version')::integer as version
      from jsonb_array_elements(p_approved) e
      order by (e ->> 'id')::uuid
  loop
    select * into v_task from public.tasks
      where id = v_item.id and wedding_id = p_wedding for update;
    if not found
       or v_task.archived_at is not null
       or v_task.date_kind <> 'relative'
       or v_task.status <> 'open'
       or v_task.version <> v_item.version then
      raise exception 'tasks changed, review again' using errcode = '55000';
    end if;
    v_target := case when v_wedding.date is null then null else v_wedding.date + v_task.offset_days end;
    if v_target is distinct from v_task.due_date then
      update public.tasks set due_date = v_target, version = version + 1 where id = v_task.id;
      v_count := v_count + 1;
    end if;
  end loop;

  if v_count > 0 then
    insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
      values (p_wedding, v_user, 'wedding', p_wedding, 'tasks.rescheduled',
              jsonb_build_object('moved', v_count), v_wedding.revision);
  end if;
  return v_count;
end;
$$;

revoke all on function public.generate_checklist(uuid, jsonb) from public, anon;
revoke all on function public.create_task(uuid, text, text, date, uuid, text) from public, anon;
revoke all on function public.update_task(uuid, uuid, integer, text, text, date, uuid) from public, anon;
revoke all on function public.set_task_status(uuid, uuid, integer, boolean) from public, anon;
revoke all on function public.archive_task(uuid, uuid, integer) from public, anon;
revoke all on function public.reschedule_relative_tasks(uuid, jsonb) from public, anon;
grant execute on function public.generate_checklist(uuid, jsonb) to authenticated;
grant execute on function public.create_task(uuid, text, text, date, uuid, text) to authenticated;
grant execute on function public.update_task(uuid, uuid, integer, text, text, date, uuid) to authenticated;
grant execute on function public.set_task_status(uuid, uuid, integer, boolean) to authenticated;
grant execute on function public.archive_task(uuid, uuid, integer) to authenticated;
grant execute on function public.reschedule_relative_tasks(uuid, jsonb) to authenticated;
