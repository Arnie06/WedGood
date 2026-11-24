-- UX-17 lodging, L2: the guest's "Where are you staying?" answer on the RSVP link (ADR-031 UX-17
-- lodging addendum). A new public write path: it is reached only through rsvp_submit and
-- rsvp_party_submit, which stay service-role only and keep their signatures.
--
-- Rules:
--   * Each attending person's response, and the plus-one being added, may carry
--       "stay": {"kind": "hotel", "hotelId": "<uuid>"} | {"kind": "elsewhere"} | {"kind": "not_staying"}
--     The app asks once for the group and sends the same answer for each attending person.
--   * A hotel must belong to the invitation's wedding, be marked for guests and not archived;
--     anything else refuses the whole send (22023). A decline carries no stay (ignored).
--   * Only the guest columns of lodging_stays are written (guest_kind, guest_hotel_id,
--     guest_answered_at). The planner's choice is never touched (review fix 1 rule). A retry that says
--     what is already stored writes nothing; a stay-only change moves the invitation version like
--     answers do, so a stale second tab is refused.
--   * The guest view lists the hotels marked for guests (id, name, earliest book-by date) and each
--     person's own saved stay (kind, hotel id). Rooms, rates and pickup are never in it. Stays are not
--     sensitive like notes, so a guest sees their saved choice and can change it.
--   * Audit rows and the submission fingerprint are unchanged (no stay text or ids are added).

-- ---------------------------------------------------------------- storing one person's stay
create function app_private.rsvp_save_stay(p_member uuid, p_src jsonb) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stay jsonb;
  v_kind text;
  v_hotel uuid;
  v_guest uuid;
  v_wedding uuid;
  v_old public.lodging_stays%rowtype;
begin
  if jsonb_typeof(p_src) is distinct from 'object' or coalesce(jsonb_typeof(p_src -> 'stay'), 'null') = 'null' then
    return false;
  end if;
  v_stay := p_src -> 'stay';
  if jsonb_typeof(v_stay) <> 'object'
     or not app_private.site_keys_ok(v_stay, array['kind', 'hotelId'])
     or coalesce(jsonb_typeof(v_stay -> 'kind'), '') <> 'string'
     or (v_stay ->> 'kind') not in ('hotel', 'elsewhere', 'not_staying')
     or coalesce(jsonb_typeof(v_stay -> 'hotelId'), 'null') not in ('null', 'string')
     or ((v_stay ->> 'kind') = 'hotel') <> (coalesce(jsonb_typeof(v_stay -> 'hotelId'), 'null') = 'string')
     or (jsonb_typeof(v_stay -> 'hotelId') = 'string' and not app_private.is_uuid(v_stay ->> 'hotelId')) then
    raise exception 'invalid response' using errcode = '22023';
  end if;
  v_kind := v_stay ->> 'kind';
  v_hotel := case when v_kind = 'hotel' then (v_stay ->> 'hotelId')::uuid end;

  select im.guest_id, im.wedding_id into v_guest, v_wedding
    from public.invitation_members im where im.id = p_member and im.active;
  if v_guest is null then
    raise exception 'invalid response' using errcode = '22023';
  end if;
  if v_hotel is not null and not exists (
    select 1 from public.lodging_hotels h
     where h.id = v_hotel and h.wedding_id = v_wedding and h.show_to_guests and h.archived_at is null) then
    raise exception 'invalid response' using errcode = '22023';
  end if;

  select * into v_old from public.lodging_stays where guest_id = v_guest;
  if found and v_old.guest_kind is not distinct from v_kind
     and v_old.guest_hotel_id is not distinct from v_hotel then
    return false; -- a retry that says what is already saved writes nothing
  end if;

  -- The planner's columns are never written here.
  insert into public.lodging_stays (wedding_id, guest_id, guest_kind, guest_hotel_id, guest_answered_at)
    values (v_wedding, v_guest, v_kind, v_hotel, now())
    on conflict (guest_id) do update
      set guest_kind = excluded.guest_kind,
          guest_hotel_id = excluded.guest_hotel_id,
          guest_answered_at = excluded.guest_answered_at;
  return true;
end;
$$;
revoke all on function app_private.rsvp_save_stay(uuid, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------- one invitation, with the form and stays
-- Same as UX-11, plus the stay of each attending person and of the new plus-one. A change to answers
-- or stays alone still counts as a change.
create or replace function app_private.rsvp_apply_with_form(
  p_invitation uuid, p_responses jsonb, p_plus_one jsonb, p_party uuid, p_form uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv public.invitations%rowtype;
  v_published uuid;
  v_res jsonb;
  v_r jsonb;
  v_people integer := 0;
  v_stays integer := 0;
  v_name text;
  v_member uuid;
begin
  select * into v_inv from public.invitations where id = p_invitation;
  select f.published_version_id into v_published from public.rsvp_forms f
    where f.event_id = v_inv.event_id and f.wedding_id = v_inv.wedding_id;
  -- The guest answered a form the couple has since replaced: show them the new one.
  if p_form is not null and p_form is distinct from v_published then
    raise exception 'form changed' using errcode = '55000';
  end if;

  v_res := app_private.rsvp_apply_invitation(p_invitation, p_responses, p_plus_one, p_party);

  for v_r in select * from jsonb_array_elements(p_responses) loop
    if v_r ->> 'status' = 'accepted' then
      if app_private.rsvp_save_answers((v_r ->> 'memberId')::uuid, v_r, p_form) > 0 then
        v_people := v_people + 1;
      end if;
      -- The apply helper has already checked the member belongs to this invitation.
      if app_private.rsvp_save_stay((v_r ->> 'memberId')::uuid, v_r) then
        v_stays := v_stays + 1;
      end if;
    end if;
  end loop;
  if jsonb_typeof(p_plus_one) = 'object' then
    v_name := regexp_replace(btrim(p_plus_one ->> 'name'), '\s+', ' ', 'g');
    select im.id into v_member from public.invitation_members im
      join public.guests g on g.id = im.guest_id
      where im.invitation_id = v_inv.id and im.is_plus_one and im.active
        and lower(g.full_name) = lower(v_name);
    if app_private.rsvp_save_answers(v_member, p_plus_one, p_form) > 0 then
      v_people := v_people + 1;
    end if;
    if v_member is not null and app_private.rsvp_save_stay(v_member, p_plus_one) then
      v_stays := v_stays + 1;
    end if;
  end if;

  if (v_people > 0 or v_stays > 0) and not (v_res ->> 'changed')::boolean then
    update public.invitations set version = version + 1, last_responded_at = now() where id = v_inv.id;
  end if;
  return v_res || jsonb_build_object('changed', (v_res ->> 'changed')::boolean or v_people > 0 or v_stays > 0,
                                     'answers', v_people, 'stays', v_stays);
end;
$$;
revoke all on function app_private.rsvp_apply_with_form(uuid, jsonb, jsonb, uuid, uuid)
  from public, anon, authenticated;

-- ---------------------------------------------------------------- the guest view
-- Swapped into the live definition (asserted, exactly once each), so no other line can drift.
do $$
declare
  v_def text := pg_get_functiondef('app_private.rsvp_projection(uuid)'::regprocedure);
  v_members constant text := $a$    'members', coalesce((select jsonb_agg(jsonb_build_object($a$;
  v_person constant text := $a$                  'personKey', md5(i.wedding_id::text || ':' || g.id::text),$a$;
begin
  if (length(v_def) - length(replace(v_def, v_members, ''))) <> length(v_members)
     or (length(v_def) - length(replace(v_def, v_person, ''))) <> length(v_person) then
    raise exception 'app_private.rsvp_projection does not contain the expected anchors exactly once';
  end if;
  v_def := replace(v_def, v_members, $b$    'hotels', coalesce((select jsonb_agg(jsonb_build_object(
                  'id', h.id, 'name', h.name,
                  'bookBy', (select min(b.cutoff_date) from public.lodging_blocks b where b.hotel_id = h.id))
                  order by h.created_at, h.id)
                from public.lodging_hotels h
               where h.wedding_id = i.wedding_id and h.show_to_guests and h.archived_at is null), '[]'::jsonb),
$b$ || v_members);
  v_def := replace(v_def, v_person, v_person || $b$
                  'stay', (select jsonb_build_object('kind', s.guest_kind, 'hotelId', s.guest_hotel_id)
                             from public.lodging_stays s
                            where s.guest_id = g.id and s.guest_kind is not null),$b$);
  execute v_def;
end;
$$;
