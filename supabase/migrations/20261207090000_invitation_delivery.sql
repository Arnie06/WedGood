-- R1-17: truthful invitation delivery status. The app sends nothing itself; this records only what
-- the owner says they did ("shared by me") and never claims delivery or a read.
alter table public.invitations
  add column delivery_status text not null default 'not_sent'
    check (delivery_status in ('not_sent', 'shared_manually')),
  add column delivery_marked_at timestamptz,
  add constraint invitations_delivery_consistent
    check ((delivery_status = 'not_sent') = (delivery_marked_at is null));

-- A new link replaces the old one, so whatever was shared before no longer works.
create function app_private.reset_delivery_on_new_link()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.token_hash is distinct from old.token_hash then
    new.delivery_status := 'not_sent';
    new.delivery_marked_at := null;
  end if;
  return new;
end;
$$;
create trigger invitations_reset_delivery before update on public.invitations
  for each row execute function app_private.reset_delivery_on_new_link();

create function public.set_invitation_delivery(
  p_wedding uuid, p_invitation_id uuid, p_expected_version integer, p_shared boolean
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wedding public.weddings%rowtype;
  v_inv public.invitations%rowtype;
begin
  v_wedding := app_private.lock_wedding_for_guests(p_wedding);
  select * into v_inv from public.invitations where id = p_invitation_id and wedding_id = p_wedding for update;
  if not found then raise exception 'not permitted' using errcode = '42501'; end if;
  if p_shared is null then raise exception 'invalid delivery' using errcode = '22023'; end if;
  if v_inv.version <> p_expected_version or v_inv.revoked_at is not null then
    raise exception 'version conflict' using errcode = '55000';
  end if;
  update public.invitations
    set delivery_status = case when p_shared then 'shared_manually' else 'not_sent' end,
        delivery_marked_at = case when p_shared then now() else null end,
        version = version + 1
    where id = p_invitation_id;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'invitation', p_invitation_id,
            case when p_shared then 'invitation.marked_shared' else 'invitation.marked_not_shared' end,
            '{}'::jsonb, v_wedding.revision);
end;
$$;
revoke all on function public.set_invitation_delivery(uuid, uuid, integer, boolean) from public, anon;
grant execute on function public.set_invitation_delivery(uuid, uuid, integer, boolean) to authenticated;

grant select (delivery_status, delivery_marked_at) on public.invitations to authenticated;
