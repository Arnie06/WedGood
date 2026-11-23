import "server-only";
import { categoryLabel } from "@/domain/candidates/categories";
import { groupForEvent, vendorLabel, vendorState, type VendorState } from "@/domain/events/vendors";
import { loadCandidates } from "@/server/candidates/queries";
import { loadEventLocations } from "@/server/events/location";
import { createUserClient } from "@/server/supabase/server";

export type EventVendor = {
  id: string;
  name: string;
  category: string;
  categoryLabel: string;
  stage: string;
  archived: boolean;
  state: VendorState;
};

export type EventVendorData = {
  /** Vendors a link can point at now, plus any vendor that is still linked (archived or passed). */
  vendors: EventVendor[];
  /** eventId to vendor ids, in the order the vendors were saved. */
  byEvent: Map<string, string[]>;
  /** vendorId to event ids. */
  byVendor: Map<string, string[]>;
};

type VendorRow = {
  id: string;
  name: string;
  category: string;
  stage: string;
  archived_at: string | null;
};

/**
 * Vendors (not venues) and which events each works at. RLS limits this to members; callers also
 * use requireWorkspace. Archived and passed vendors are included only while an event still links
 * to them, so a stale link can be shown and cleared.
 */
export async function loadEventVendorData(workspaceId: string): Promise<EventVendorData> {
  const supabase = await createUserClient();
  const [links, vendors] = await Promise.all([
    supabase
      .from("event_vendors")
      .select("event_id, candidate_id")
      .eq("wedding_id", workspaceId)
      .limit(2000),
    supabase
      .from("candidates")
      .select("id, name, category, stage, archived_at")
      .eq("wedding_id", workspaceId)
      .eq("kind", "vendor")
      .order("name", { ascending: true })
      .limit(1000),
  ]);
  if (links.error || vendors.error) throw new Error("Could not load vendors for events");

  const linkedIds = new Set(links.data.map((l) => l.candidate_id));
  const list: EventVendor[] = [];
  for (const r of vendors.data as VendorRow[]) {
    const archived = r.archived_at !== null;
    const state = vendorState({ archived, stage: r.stage });
    if (state !== "current" && !linkedIds.has(r.id)) continue;
    list.push({
      id: r.id,
      name: r.name,
      category: r.category,
      categoryLabel: categoryLabel(r.category),
      stage: r.stage,
      archived,
      state,
    });
  }
  const known = new Set(list.map((v) => v.id));
  const byEvent = new Map<string, string[]>();
  const byVendor = new Map<string, string[]>();
  for (const l of links.data) {
    if (!known.has(l.candidate_id)) continue;
    byEvent.set(l.event_id, [...(byEvent.get(l.event_id) ?? []), l.candidate_id]);
    byVendor.set(l.candidate_id, [...(byVendor.get(l.candidate_id) ?? []), l.event_id]);
  }
  return { vendors: list, byEvent, byVendor };
}

export type AgendaVendorOptions = {
  /** Names for display, archived or passed ones carry their state in words. */
  names: Map<string, string>;
  atEvent: { id: string; label: string }[];
  others: { id: string; label: string }[];
};

/**
 * What the agenda's "Venue or vendor" picker offers for one event: this event's vendors and its
 * venue first, then everyone else. An item that still names a vendor which was archived keeps it
 * in the list as "(archived)", so editing the item never silently clears it.
 */
export async function loadAgendaVendorOptions(
  workspaceId: string,
  eventId: string,
  referencedIds: readonly string[],
): Promise<AgendaVendorOptions> {
  const [candidates, links, locations] = await Promise.all([
    loadCandidates(workspaceId),
    loadEventVendorData(workspaceId),
    loadEventLocations(workspaceId),
  ]);
  const names = new Map<string, string>();
  const all: { id: string; label: string }[] = [];
  for (const c of candidates) {
    const label = vendorLabel({ name: c.name, archived: false, stage: c.stage });
    names.set(c.id, label);
    all.push({ id: c.id, label });
  }
  // Referenced by an agenda item but no longer in the active list: archived.
  const missing = [...new Set(referencedIds)].filter((id) => !names.has(id));
  if (missing.length > 0) {
    const supabase = await createUserClient();
    const { data, error } = await supabase
      .from("candidates")
      .select("id, name, stage")
      .eq("wedding_id", workspaceId)
      .in("id", missing);
    if (error) throw new Error("Could not load vendors for the agenda");
    for (const r of data) {
      const label = vendorLabel({ name: r.name, archived: true, stage: r.stage });
      names.set(r.id, label);
      all.push({ id: r.id, label });
    }
  }
  const here = new Set(links.byEvent.get(eventId) ?? []);
  const venue = locations.get(eventId)?.venue;
  if (venue && !venue.archived) here.add(venue.id);
  const g = groupForEvent(all, here);
  return { names, atEvent: g.atEvent, others: g.others };
}
