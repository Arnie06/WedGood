-- REL-10 needs attention (ADR-031 D6).
--
-- Conditions (capacity, caterer count drift, missing meals, unseated guests on a finalized plan, an
-- unused booked venue, a booked vendor at no event, an invoice falling due) are COMPUTED each time
-- the page is read, from the same rows every other page reads. Nothing about them is stored except
-- a dismissal. Two small tables exist:
--
--   * attention_items: one-off events that cannot be recomputed later. Today there is one kind,
--     'seats_released': a seated guest lost their seat (declined, was removed, or was unlinked)
--     after the seating plan was finalized. One open row per event and kind; a second release while
--     it is open adds to `occurrences`; a retried reply changes nothing, so it adds nothing.
--     Finalizing the plan again closes it. Owner and partner mark it handled.
--   * attention_dismissals: "I have seen this" for a computed condition. The row records what the
--     condition looked like (a short fingerprint, for example "142|130"). If the condition changes,
--     the fingerprint no longer matches and the item shows again; if it is unchanged it stays hidden.
--
-- Rows hold ids, a kind and a fingerprint. No guest names, no money, no free text.
-- Reply-derived kinds are readable by owner and partner only (the events table already is).

-- ---------------------------------------------------------------- stored one-offs
create table public.attention_items (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  event_id uuid not null,
  kind text not null check (kind in ('seats_released')),
  status text not null default 'open' check (status in ('open', 'handled', 'refinalized')),
  -- How many seats were released while this item was open.
  occurrences integer not null default 1 check (occurrences between 1 and 100000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users (id) on delete set null,
  unique (wedding_id, id),
  foreign key (wedding_id, event_id) references public.events (wedding_id, id) on delete cascade,
  check ((status = 'open') = (resolved_at is null))
);
-- The dedupe rule: at most one open item per event and kind.
create unique index attention_items_one_open on public.attention_items (event_id, kind)
  where status = 'open';
create index attention_items_wedding_idx on public.attention_items (wedding_id, status, created_at desc);

alter table public.attention_items enable row level security;
revoke all on public.attention_items from anon, authenticated;
grant select on public.attention_items to authenticated;
create policy attention_items_select_managers on public.attention_items
  for select to authenticated using (app_private.can_manage_guests(wedding_id));

-- ---------------------------------------------------------------- dismissals of computed items
create table public.attention_dismissals (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  kind text not null check (kind in (
    'over_capacity', 'caterer_count', 'meals_missing', 'seats_missing',
    'venue_unused', 'vendor_unassigned', 'invoice_due'
  )),
  -- The event, venue, vendor or invoice the condition is about. Checked on write, not a foreign key
  -- (it points at four tables); a row for something later deleted is simply never matched.
  subject_id uuid not null,
  fingerprint text not null check (char_length(fingerprint) between 1 and 80),
  -- Reply-derived kinds are visible to owner and partner only.
  guest_data boolean generated always as (
    kind in ('over_capacity', 'caterer_count', 'meals_missing', 'seats_missing')
  ) stored,
  dismissed_by uuid references auth.users (id) on delete set null,
  dismissed_at timestamptz not null default now(),
  unique (wedding_id, kind, subject_id)
);

alter table public.attention_dismissals enable row level security;
revoke all on public.attention_dismissals from anon, authenticated;
grant select on public.attention_dismissals to authenticated;
create policy attention_dismissals_select on public.attention_dismissals
  for select to authenticated using (
    app_private.is_member(wedding_id)
    and (not guest_data or app_private.can_manage_guests(wedding_id))
  );

-- ---------------------------------------------------------------- a release after finalizing
-- Same behaviour as before (docs/07: an RSVP, archive or revocation change acts on seating and never
-- places a guest), plus: if seats were released and the plan had been finalized, note it once.
create or replace function app_private.seating_on_member_change(p_event uuid, p_guest uuid, p_new text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_layout public.seating_layouts%rowtype;
  v_removed integer := 0;
begin
  select * into v_layout from public.seating_layouts where event_id = p_event;
  if not found then return; end if;
  if p_new = 'accepted' then
    update public.seat_assignments set tentative = false
      where layout_id = v_layout.id and guest_id = p_guest and tentative;
  elsif p_new = 'pending' and v_layout.allow_tentative then
    update public.seat_assignments set tentative = true
      where layout_id = v_layout.id and guest_id = p_guest and not tentative;
  else
    delete from public.seat_assignments where layout_id = v_layout.id and guest_id = p_guest;
    get diagnostics v_removed = row_count;
  end if;
  perform app_private.seating_touch(v_layout.id);
  if v_removed > 0 then
    insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
      values (v_layout.wedding_id, (select auth.uid()), 'seating_layout', v_layout.id,
              'seating.guest_released', '{}'::jsonb,
              (select revision from public.weddings where id = v_layout.wedding_id));
    if v_layout.finalized_revision is not null then
      insert into public.attention_items (wedding_id, event_id, kind, occurrences)
        values (v_layout.wedding_id, v_layout.event_id, 'seats_released', v_removed)
        on conflict (event_id, kind) where status = 'open'
        do update set occurrences = public.attention_items.occurrences + excluded.occurrences,
                      updated_at = now();
    end if;
  end if;
end;
$$;
revoke all on function app_private.seating_on_member_change(uuid, uuid, text)
  from public, anon, authenticated;

-- Finalizing the plan again deals with the situation, so an open item closes by itself.
create function app_private.attention_on_finalize() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.finalized_revision is not null
     and new.finalized_revision is distinct from old.finalized_revision then
    update public.attention_items
      set status = 'refinalized', resolved_at = now(), resolved_by = (select auth.uid())
      where event_id = new.event_id and kind = 'seats_released' and status = 'open';
  end if;
  return new;
end;
$$;
revoke all on function app_private.attention_on_finalize() from public, anon, authenticated;
create trigger seating_layouts_attention_on_finalize
  after update of finalized_revision on public.seating_layouts
  for each row execute function app_private.attention_on_finalize();

-- ---------------------------------------------------------------- mark an item handled
create function public.handle_attention_item(p_wedding uuid, p_item uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_item public.attention_items%rowtype;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app_private.can_manage_guests(p_wedding) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  select * into v_item from public.attention_items
    where id = p_item and wedding_id = p_wedding for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_item.status <> 'open' then
    return;
  end if;
  update public.attention_items
    set status = 'handled', resolved_at = now(), resolved_by = v_user
    where id = p_item;
  insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
    values (p_wedding, v_user, 'attention_item', p_item, 'attention.handled',
            jsonb_build_object('kind', v_item.kind),
            (select revision from public.weddings where id = p_wedding));
end;
$$;
revoke all on function public.handle_attention_item(uuid, uuid) from public, anon;
grant execute on function public.handle_attention_item(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------- dismiss and show again
-- The database cannot recompute a condition, so it records only that an owner or partner chose to
-- hide it as it looked then. It checks the subject belongs to this wedding, so one wedding can never
-- write a row about another's event, vendor or invoice.
create function public.dismiss_attention(
  p_wedding uuid, p_kind text, p_subject uuid, p_fingerprint text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_fp text := btrim(coalesce(p_fingerprint, ''));
  v_ok boolean;
  v_id uuid;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app_private.can_manage_guests(p_wedding) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if char_length(v_fp) not between 1 and 80 then
    raise exception 'invalid fingerprint' using errcode = '22023';
  end if;
  if p_kind in ('over_capacity', 'caterer_count', 'meals_missing', 'seats_missing') then
    select exists (select 1 from public.events where id = p_subject and wedding_id = p_wedding) into v_ok;
  elsif p_kind = 'venue_unused' then
    select exists (select 1 from public.candidates
      where id = p_subject and wedding_id = p_wedding and kind = 'venue') into v_ok;
  elsif p_kind = 'vendor_unassigned' then
    select exists (select 1 from public.candidates
      where id = p_subject and wedding_id = p_wedding and kind = 'vendor') into v_ok;
  elsif p_kind = 'invoice_due' then
    select exists (select 1 from public.invoices where id = p_subject and wedding_id = p_wedding) into v_ok;
  else
    raise exception 'invalid kind' using errcode = '22023';
  end if;
  if not v_ok then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  -- A wedding keeps a bounded number of dismissals, so the table cannot grow without limit.
  if (select count(*) from public.attention_dismissals where wedding_id = p_wedding) >= 500
     and not exists (select 1 from public.attention_dismissals
                     where wedding_id = p_wedding and kind = p_kind and subject_id = p_subject) then
    raise exception 'too many dismissals' using errcode = '22023';
  end if;
  -- Same fingerprint again changes nothing and writes nothing.
  insert into public.attention_dismissals (wedding_id, kind, subject_id, fingerprint, dismissed_by)
    values (p_wedding, p_kind, p_subject, v_fp, v_user)
    on conflict (wedding_id, kind, subject_id) do update
      set fingerprint = excluded.fingerprint, dismissed_by = excluded.dismissed_by, dismissed_at = now()
      where public.attention_dismissals.fingerprint is distinct from excluded.fingerprint
    returning id into v_id;
  if v_id is not null then
    insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
      values (p_wedding, v_user, 'attention', p_subject, 'attention.dismissed',
              jsonb_build_object('kind', p_kind),
              (select revision from public.weddings where id = p_wedding));
  end if;
end;
$$;
revoke all on function public.dismiss_attention(uuid, text, uuid, text) from public, anon;
grant execute on function public.dismiss_attention(uuid, text, uuid, text) to authenticated;

create function public.restore_attention(p_wedding uuid, p_kind text, p_subject uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_id uuid;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app_private.can_manage_guests(p_wedding) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  delete from public.attention_dismissals
    where wedding_id = p_wedding and kind = p_kind and subject_id = p_subject
    returning id into v_id;
  if v_id is not null then
    insert into public.audit_events (wedding_id, actor_id, entity_type, entity_id, action, safe_changes, revision)
      values (p_wedding, v_user, 'attention', p_subject, 'attention.restored',
              jsonb_build_object('kind', p_kind),
              (select revision from public.weddings where id = p_wedding));
  end if;
end;
$$;
revoke all on function public.restore_attention(uuid, text, uuid) from public, anon;
grant execute on function public.restore_attention(uuid, text, uuid) to authenticated;
