-- Fixes a deadlock found by the R1-11 concurrent seating test (T10). The guests lock used to take
-- FOR SHARE on the wedding row and then the per-wedding advisory lock. Two writers could both hold
-- the share lock; the one that won the advisory lock then blocked on its own
-- "update weddings set revision" waiting for the other's share lock, while the other waited for the
-- advisory lock (SQLSTATE 40P01).
--
-- New order: authorize (no lock held), take the advisory lock, then lock the wedding row. Writers
-- are serialized before they ever hold the share lock, so the revision update cannot wait on a peer.
-- Unauthorized callers never reach the advisory lock, so they cannot stall a tenant.
create or replace function app_private.lock_wedding_for_guests(p_wedding uuid)
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
  if not app_private.can_manage_guests(p_wedding) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('guests:' || p_wedding::text, 0));
  select * into v_wedding from public.weddings where id = p_wedding for share;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return v_wedding;
end;
$$;
