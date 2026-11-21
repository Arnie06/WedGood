-- R1-12: the wedding-day agenda is readable by every member, but `events` rows (target attendance,
-- capacity) are limited to guest managers. This returns only what an agenda needs to label an
-- event: id, name, kind and date. Members only; others get no rows.
create function public.list_event_labels(p_wedding uuid)
returns table (id uuid, name text, kind text, local_date date)
language sql
stable
security definer
set search_path = ''
as $$
  select e.id, e.name, e.kind, e.local_date
    from public.events e
   where e.wedding_id = p_wedding and app_private.is_member(p_wedding)
   order by e.local_date nulls last, e.name
   limit 50
$$;
revoke all on function public.list_event_labels(uuid) from public, anon;
grant execute on function public.list_event_labels(uuid) to authenticated;
