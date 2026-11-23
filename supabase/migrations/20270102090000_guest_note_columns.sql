-- Review fix (finding 1, owner decision 2026-11-23): a guest's dietary or accessibility note no
-- longer replaces the couple's own text.
--
-- Until now app_private.rsvp_save_details wrote the guest's typed note into
-- guest_private_details.dietary / .accessibility, the same fields the couple edits, and nothing kept
-- the earlier value (notes never go into audit or history). Anyone holding a forwarded link could
-- replace, say, a caterer-confirmed allergy note without trace.
--
-- Now the guest's words live in their own columns, guest_dietary and guest_accessibility. The couple's
-- columns are written only by the couple. Both are shown side by side to people who can read private
-- details; guest-facing views still never return either text (UX-07 decision Q2).
--
-- Existing rows: the old layout cannot tell which field the guest wrote and which the couple did, so
-- rows the guest answered are COPIED into the new columns and the couple's columns are left as they
-- are. Nothing is lost; the same words may appear in both places until the couple tidies them.

alter table public.guest_private_details
  add column guest_dietary text
    check (guest_dietary is null or char_length(guest_dietary) between 1 and 500),
  add column guest_accessibility text
    check (guest_accessibility is null or char_length(guest_accessibility) between 1 and 500);

update public.guest_private_details
   set guest_dietary = dietary, guest_accessibility = accessibility
 where guest_answered_at is not null;

-- A row may now hold only the guest's words (the couple has written nothing yet).
alter table public.guest_private_details drop constraint guest_private_details_check;
alter table public.guest_private_details add constraint guest_private_details_check
  check (num_nonnulls(dietary, accessibility, notes, guest_dietary, guest_accessibility) >= 1);

-- ---------------------------------------------------------------- the public write touches only guest columns
create or replace function app_private.rsvp_save_details(p_member uuid, p_src jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_guest uuid;
  v_wedding uuid;
  v_diet text;
  v_access text;
  v_old public.guest_private_details%rowtype;
begin
  if jsonb_typeof(p_src) is distinct from 'object' then
    return false;
  end if;
  if coalesce(jsonb_typeof(p_src -> 'dietary'), 'null') not in ('null', 'string')
     or coalesce(jsonb_typeof(p_src -> 'accessibility'), 'null') not in ('null', 'string') then
    raise exception 'invalid response' using errcode = '22023';
  end if;
  v_diet := nullif(btrim(p_src ->> 'dietary'), '');
  v_access := nullif(btrim(p_src ->> 'accessibility'), '');
  if char_length(v_diet) > 500 or char_length(v_access) > 500 then
    raise exception 'invalid response' using errcode = '22023';
  end if;
  if v_diet is null and v_access is null then
    return false;
  end if;

  select im.guest_id, im.wedding_id into v_guest, v_wedding
    from public.invitation_members im where im.id = p_member and im.active;
  if v_guest is null then
    raise exception 'invalid response' using errcode = '22023';
  end if;

  select * into v_old from public.guest_private_details where guest_id = v_guest;
  if found and v_old.guest_answered_at is not null
     and (v_diet is null or v_old.guest_dietary is not distinct from v_diet)
     and (v_access is null or v_old.guest_accessibility is not distinct from v_access) then
    return false; -- a retry that says what is already saved writes nothing
  end if;

  -- The couple's dietary, accessibility and notes columns are never written here.
  insert into public.guest_private_details (guest_id, wedding_id, guest_dietary, guest_accessibility,
                                            guest_answered_at)
    values (v_guest, v_wedding, v_diet, v_access, now())
    on conflict (guest_id) do update
      set guest_dietary = coalesce(excluded.guest_dietary, public.guest_private_details.guest_dietary),
          guest_accessibility = coalesce(excluded.guest_accessibility,
                                         public.guest_private_details.guest_accessibility),
          guest_answered_at = now(),
          updated_at = now();
  -- Bumps the guest's version (touch trigger), so an owner edit form opened before this answer
  -- arrived is refused as stale.
  update public.guests set updated_at = now() where id = v_guest and wedding_id = v_wedding;
  return true;
end;
$$;
revoke all on function app_private.rsvp_save_details(uuid, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------- "saved" on the guest link reads the guest columns
-- Swapped in the live definition (same technique as REL-11), asserted to match exactly once, so no
-- other line of the projection can drift.
do $$
declare
  v_oid oid := 'app_private.rsvp_projection(uuid)'::regprocedure;
  v_def text := pg_get_functiondef('app_private.rsvp_projection(uuid)'::regprocedure);
  v_old constant text := '(d.dietary is not null or d.accessibility is not null)';
  v_new constant text := '(d.guest_dietary is not null or d.guest_accessibility is not null)';
begin
  if (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) then
    raise exception 'app_private.rsvp_projection does not contain the detailsSaved test exactly once (oid %)', v_oid;
  end if;
  execute replace(v_def, v_old, v_new);
end;
$$;

-- ---------------------------------------------------------------- the couple clearing their notes keeps the guest's
-- update_guest deleted the row when the couple's three fields were all blank. That would now erase
-- the guest's words too, so the row is deleted only when the guest columns are empty as well;
-- otherwise only the couple's fields are cleared.
do $$
declare
  v_def text := pg_get_functiondef('public.update_guest'::regproc);
  v_old constant text := $o$    if num_nonnulls(v_diet, v_access, v_notes) = 0 then
      delete from public.guest_private_details where guest_id = p_guest_id;$o$;
  v_new constant text := $n$    if num_nonnulls(v_diet, v_access, v_notes) = 0 then
      if num_nonnulls(v_old_d.guest_dietary, v_old_d.guest_accessibility) > 0 then
        -- An update, not the upsert: a check runs on an insert row before ON CONFLICT is resolved.
        update public.guest_private_details
           set dietary = null, accessibility = null, notes = null, updated_at = now()
         where guest_id = p_guest_id;
      else
      delete from public.guest_private_details where guest_id = p_guest_id;
      end if;$n$;
begin
  if (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) then
    raise exception 'public.update_guest does not contain the private-details delete exactly once';
  end if;
  execute replace(v_def, v_old, v_new);
end;
$$;
