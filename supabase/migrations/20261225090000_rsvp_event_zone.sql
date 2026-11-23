-- UX-04: the guest RSVP projection names the event's effective zone (its own, else the wedding's)
-- instead of always the wedding's, so the reply-by date is shown on the clock it was set against.
-- Only the 'timezone' expression changes; no rows are rewritten, and invitations made before
-- UX-04 (stored as 23:59:59 UTC) keep their instants.
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
                  'status', im.rsvp_status, 'mealOptionId', im.meal_option_id)
                  order by im.is_plus_one, g.full_name, im.id)
                from public.invitation_members im
                join public.guests g on g.id = im.guest_id and g.wedding_id = im.wedding_id
                where im.invitation_id = i.id and im.active), '[]'::jsonb))
  from public.invitations i
  join public.events e on e.id = i.event_id and e.wedding_id = i.wedding_id
  join public.weddings w on w.id = i.wedding_id
  where i.id = p_invitation;
$$;
revoke all on function app_private.rsvp_projection(uuid) from public, anon, authenticated;
