-- UX-07: guests can tell the couple about dietary needs and accessibility through their RSVP link.
--
-- Answers are written to public.guest_private_details (the same row the couple edits, readable only
-- with the guest-private capability). They never reach audit_events, rsvp_changes or any guest-facing
-- projection: after saving, the link only says "saved". That is decision Q2 (owner, 2026-11-22): on a
-- shared party link the content is hidden from whoever opens the link next, including the people who
-- typed it.

-- ---------------------------------------------------------------- marker
-- Set when the guest (not the couple) has answered. The projections use it to say "saved" without
-- ever returning the text.
alter table public.guest_private_details add column guest_answered_at timestamptz;

-- ---------------------------------------------------------------- storing one person's answers
-- p_src is the member's response object (or the plus-one object). Keys 'dietary' and 'accessibility'
-- may be absent, null or text; anything else, or text over 500 characters after trimming, is refused
-- (22023). Blank text is the same as absent. Absent fields keep what is stored, so a guest who only
-- mentions an allergy does not erase the couple's accessibility note. Returns true when something was
-- written. The caller holds the guests advisory lock (the same one owner guest writes take), so this
-- does not race with an owner edit.
create function app_private.rsvp_save_details(p_member uuid, p_src jsonb) returns boolean
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
     and (v_diet is null or v_old.dietary is not distinct from v_diet)
     and (v_access is null or v_old.accessibility is not distinct from v_access) then
    return false; -- a retry that says what is already saved writes nothing
  end if;

  insert into public.guest_private_details (guest_id, wedding_id, dietary, accessibility, guest_answered_at)
    values (v_guest, v_wedding, v_diet, v_access, now())
    on conflict (guest_id) do update
      set dietary = coalesce(excluded.dietary, public.guest_private_details.dietary),
          accessibility = coalesce(excluded.accessibility, public.guest_private_details.accessibility),
          guest_answered_at = now(),
          updated_at = now();
  -- Bumps the guest's version (touch trigger), so an owner edit form opened before this answer
  -- arrived is refused as stale instead of silently overwriting it.
  update public.guests set updated_at = now() where id = v_guest and wedding_id = v_wedding;
  return true;
end;
$$;
revoke all on function app_private.rsvp_save_details(uuid, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------- guest projection
-- Adds, per person: 'detailsSaved' (the guest has answered and something is still stored) and
-- 'personKey' (an opaque, stable key for the same guest across events, so a party link asks each
-- person once). Neither contains the text or a real id. Everything else is unchanged from UX-04.
create or replace function app_private.rsvp_projection(p_invitation uuid) returns jsonb
language sql stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'workspaceId', i.wedding_id,
    'weddingName', w.name,
    'label', i.label,
    'version', i.version,
    'deadline', i.deadline,
    'closed', (i.deadline is not null and now() > i.deadline),
    'plusOneRemaining', greatest(i.plus_one_quota - i.plus_ones_used, 0),
    'event', jsonb_build_object('name', e.name, 'kind', e.kind, 'localDate', e.local_date,
                                'timezone', coalesce(e.time_zone, w.timezone)),
    'mealOptions', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name) order by m.created_at, m.id)
                               from public.meal_options m where m.event_id = e.id and m.active), '[]'::jsonb),
    'members', coalesce((select jsonb_agg(jsonb_build_object(
                  'id', im.id, 'name', g.full_name, 'isPlusOne', im.is_plus_one,
                  'status', im.rsvp_status, 'mealOptionId', im.meal_option_id,
                  'detailsSaved', coalesce(d.guest_answered_at is not null
                                           and (d.dietary is not null or d.accessibility is not null), false),
                  'personKey', md5(i.wedding_id::text || ':' || g.id::text))
                  order by im.is_plus_one, g.full_name, im.id)
                from public.invitation_members im
                join public.guests g on g.id = im.guest_id and g.wedding_id = im.wedding_id
                left join public.guest_private_details d on d.guest_id = g.id
                where im.invitation_id = i.id and im.active), '[]'::jsonb))
  from public.invitations i
  join public.events e on e.id = i.event_id and e.wedding_id = i.wedding_id
  join public.weddings w on w.id = i.wedding_id
  where i.id = p_invitation;
$$;
revoke all on function app_private.rsvp_projection(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- shared answer helper
-- Same as UX-06, plus optional 'dietary' and 'accessibility' on each response and on the plus-one.
-- Details are stored only for someone who is attending in this send (a decline carries none), and a
-- details-only change counts as a change, so the invitation version moves and a stale second tab is
-- refused. The returned counts never include the text. Returns
-- { changed, accepted, declined, plusOneAdded, details }.
create or replace function app_private.rsvp_apply_invitation(
  p_invitation uuid, p_responses jsonb, p_plus_one jsonb, p_party uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv public.invitations%rowtype;
  v_r jsonb;
  v_seen uuid[] := '{}';
  v_member uuid;
  v_meal uuid;
  v_changed boolean := false;
  v_name text;
  v_guest uuid;
  v_plus boolean := false;
  v_accepted integer := 0;
  v_declined integer := 0;
  v_details integer := 0;
begin
  select * into v_inv from public.invitations where id = p_invitation;
  if not found then
    raise exception 'invalid response' using errcode = '22023';
  end if;
  if p_responses is null or jsonb_typeof(p_responses) <> 'array' or jsonb_array_length(p_responses) > 13
     or coalesce(jsonb_typeof(p_plus_one), 'null') not in ('null', 'object')
     or (jsonb_array_length(p_responses) = 0 and coalesce(jsonb_typeof(p_plus_one), 'null') = 'null') then
    raise exception 'invalid response' using errcode = '22023';
  end if;

  for v_r in select * from jsonb_array_elements(p_responses) loop
    if jsonb_typeof(v_r) <> 'object'
       or coalesce(jsonb_typeof(v_r -> 'memberId'), '') <> 'string'
       or not app_private.is_uuid(v_r ->> 'memberId')
       or coalesce(jsonb_typeof(v_r -> 'status'), '') <> 'string'
       or coalesce(jsonb_typeof(v_r -> 'mealOptionId'), 'null') not in ('null', 'string')
       or (jsonb_typeof(v_r -> 'mealOptionId') = 'string' and not app_private.is_uuid(v_r ->> 'mealOptionId')) then
      raise exception 'invalid response' using errcode = '22023';
    end if;
    v_member := (v_r ->> 'memberId')::uuid;
    v_meal := nullif(v_r ->> 'mealOptionId', '')::uuid;
    if v_member = any (v_seen) then
      raise exception 'invalid response' using errcode = '22023';
    end if;
    v_seen := v_seen || v_member;
    -- Only this invitation's own active members may be answered; anything else is a forged id.
    if not exists (select 1 from public.invitation_members
                    where id = v_member and invitation_id = v_inv.id and active) then
      raise exception 'invalid response' using errcode = '22023';
    end if;
    if app_private.apply_member_response(v_member, v_r ->> 'status', v_meal, false) then
      v_changed := true;
      if v_r ->> 'status' = 'accepted' then v_accepted := v_accepted + 1; else v_declined := v_declined + 1; end if;
    end if;
    if v_r ->> 'status' = 'accepted' and app_private.rsvp_save_details(v_member, v_r) then
      v_changed := true;
      v_details := v_details + 1;
    end if;
  end loop;

  if jsonb_typeof(p_plus_one) = 'object' then
    if coalesce(jsonb_typeof(p_plus_one -> 'name'), '') <> 'string'
       or coalesce(jsonb_typeof(p_plus_one -> 'mealOptionId'), 'null') not in ('null', 'string')
       or (jsonb_typeof(p_plus_one -> 'mealOptionId') = 'string'
           and not app_private.is_uuid(p_plus_one ->> 'mealOptionId')) then
      raise exception 'invalid response' using errcode = '22023';
    end if;
    v_name := regexp_replace(btrim(p_plus_one ->> 'name'), '\s+', ' ', 'g');
    if char_length(v_name) not between 1 and 120 then
      raise exception 'invalid response' using errcode = '22023';
    end if;
    v_meal := nullif(p_plus_one ->> 'mealOptionId', '')::uuid;
    -- A repeat of the same plus-one request finds the guest it already created.
    select im.id into v_member from public.invitation_members im
      join public.guests g on g.id = im.guest_id
      where im.invitation_id = v_inv.id and im.is_plus_one and im.active and lower(g.full_name) = lower(v_name);
    if v_member is null then
      if v_inv.plus_ones_used >= v_inv.plus_one_quota then
        raise exception 'plus-one quota used' using errcode = 'RS422';
      end if;
      v_guest := null;
      if p_party is not null then
        -- The same person named for another event of this party (still an active plus-one there).
        select im.guest_id into v_guest from public.invitation_members im
          join public.invitations i2 on i2.id = im.invitation_id
          join public.guests g on g.id = im.guest_id and g.wedding_id = im.wedding_id
          where i2.party_id = p_party and i2.id <> v_inv.id and i2.revoked_at is null
            and im.is_plus_one and im.active and g.archived_at is null
            and lower(g.full_name) = lower(v_name)
            and not exists (select 1 from public.invitation_members x
                             where x.event_id = v_inv.event_id and x.guest_id = im.guest_id and x.active)
          order by im.created_at, im.id
          limit 1;
      end if;
      if v_guest is null then
        if (select count(*) from public.guests where wedding_id = v_inv.wedding_id and archived_at is null) + 1 > 2000 then
          raise exception 'too many guests' using errcode = '54000';
        end if;
        insert into public.guests (wedding_id, household_id, full_name, tags)
          values (v_inv.wedding_id, v_inv.household_id, v_name, array['plus-one'])
          returning id into v_guest;
      end if;
      insert into public.invitation_members (wedding_id, invitation_id, event_id, guest_id, is_plus_one)
        values (v_inv.wedding_id, v_inv.id, v_inv.event_id, v_guest, true)
        returning id into v_member;
      update public.invitations set plus_ones_used = plus_ones_used + 1 where id = v_inv.id;
      v_plus := true;
      v_changed := true;
    end if;
    if app_private.apply_member_response(v_member, 'accepted', v_meal, false) then
      v_changed := true;
      v_accepted := v_accepted + 1;
    end if;
    if app_private.rsvp_save_details(v_member, p_plus_one) then
      v_changed := true;
      v_details := v_details + 1;
    end if;
  end if;

  if v_changed then
    update public.invitations set version = version + 1, last_responded_at = now() where id = v_inv.id;
  end if;
  return jsonb_build_object('changed', v_changed, 'accepted', v_accepted, 'declined', v_declined,
                            'plusOneAdded', v_plus, 'details', v_details);
end;
$$;
revoke all on function app_private.rsvp_apply_invitation(uuid, jsonb, jsonb, uuid)
  from public, anon, authenticated;
