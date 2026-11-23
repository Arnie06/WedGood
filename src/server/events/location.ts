import "server-only";
import { createUserClient } from "@/server/supabase/server";

export type VenueSpaceRecord = {
  id: string;
  candidateId: string;
  name: string;
  seatedCapacity: number | null;
  standingCapacity: number | null;
  notes: string | null;
  archived: boolean;
  version: number;
};

export type VenueOption = {
  id: string;
  name: string;
  location: string | null;
  seatedCapacity: number | null;
  ceremonyCapacity: number | null;
  spaces: VenueSpaceRecord[];
};

export type EventLocationRecord = {
  eventId: string;
  /** 0 never appears here; an event with no location has no record. */
  version: number;
  venue: {
    id: string;
    name: string;
    archived: boolean;
    seatedCapacity: number | null;
    ceremonyCapacity: number | null;
  };
  space: {
    id: string;
    name: string;
    archived: boolean;
    seatedCapacity: number | null;
    standingCapacity: number | null;
  } | null;
};

type SpaceRow = {
  id: string;
  candidate_id: string;
  name: string;
  seated_capacity: number | null;
  standing_capacity: number | null;
  notes: string | null;
  archived_at: string | null;
  version: number;
};
const SPACE_COLUMNS =
  "id, candidate_id, name, seated_capacity, standing_capacity, notes, archived_at, version";

function mapSpace(r: SpaceRow): VenueSpaceRecord {
  return {
    id: r.id,
    candidateId: r.candidate_id,
    name: r.name,
    seatedCapacity: r.seated_capacity,
    standingCapacity: r.standing_capacity,
    notes: r.notes,
    archived: r.archived_at !== null,
    version: r.version,
  };
}

/** Active spaces of one venue, oldest first. */
export async function loadSpacesForVenue(
  workspaceId: string,
  candidateId: string,
): Promise<VenueSpaceRecord[]> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from("venue_spaces")
    .select(SPACE_COLUMNS)
    .eq("wedding_id", workspaceId)
    .eq("candidate_id", candidateId)
    .is("archived_at", null)
    .order("created_at", { ascending: true })
    .limit(60);
  if (error) throw new Error("Could not load the spaces");
  return data.map(mapSpace);
}

type VenueRow = {
  id: string;
  name: string;
  location: string | null;
  archived_at: string | null;
  venues:
    | { seated_capacity: number | null; ceremony_capacity: number | null }
    | { seated_capacity: number | null; ceremony_capacity: number | null }[]
    | null;
};

function venueFacts(r: VenueRow) {
  const v = Array.isArray(r.venues) ? r.venues[0] : r.venues;
  return { seated: v?.seated_capacity ?? null, ceremony: v?.ceremony_capacity ?? null };
}

/** Active venues, each with its active spaces: what the "where" picker offers. */
export async function loadVenueOptions(workspaceId: string): Promise<VenueOption[]> {
  const supabase = await createUserClient();
  const [venues, spaces] = await Promise.all([
    supabase
      .from("candidates")
      .select("id, name, location, archived_at, venues(seated_capacity, ceremony_capacity)")
      .eq("wedding_id", workspaceId)
      .eq("kind", "venue")
      .is("archived_at", null)
      .order("name", { ascending: true })
      .limit(200),
    supabase
      .from("venue_spaces")
      .select(SPACE_COLUMNS)
      .eq("wedding_id", workspaceId)
      .is("archived_at", null)
      .order("created_at", { ascending: true })
      .limit(2000),
  ]);
  if (venues.error || spaces.error) throw new Error("Could not load venues");
  const byVenue = new Map<string, VenueSpaceRecord[]>();
  for (const s of spaces.data.map(mapSpace)) {
    byVenue.set(s.candidateId, [...(byVenue.get(s.candidateId) ?? []), s]);
  }
  return (venues.data as unknown as VenueRow[]).map((r) => {
    const f = venueFacts(r);
    return {
      id: r.id,
      name: r.name,
      location: r.location,
      seatedCapacity: f.seated,
      ceremonyCapacity: f.ceremony,
      spaces: byVenue.get(r.id) ?? [],
    };
  });
}

/** Where each event is held, archived venues and spaces included so stale choices can be shown. */
export async function loadEventLocations(
  workspaceId: string,
): Promise<Map<string, EventLocationRecord>> {
  const supabase = await createUserClient();
  const { data: rows, error } = await supabase
    .from("event_locations")
    .select("event_id, candidate_id, space_id, version")
    .eq("wedding_id", workspaceId)
    .limit(200);
  if (error) throw new Error("Could not load event places");
  const out = new Map<string, EventLocationRecord>();
  if (rows.length === 0) return out;
  const venueIds = [...new Set(rows.map((r) => r.candidate_id))];
  const spaceIds = [...new Set(rows.flatMap((r) => (r.space_id ? [r.space_id] : [])))];
  const [venues, spaces] = await Promise.all([
    supabase
      .from("candidates")
      .select("id, name, location, archived_at, venues(seated_capacity, ceremony_capacity)")
      .eq("wedding_id", workspaceId)
      .in("id", venueIds),
    spaceIds.length === 0
      ? Promise.resolve({ data: [] as SpaceRow[], error: null })
      : supabase
          .from("venue_spaces")
          .select(SPACE_COLUMNS)
          .eq("wedding_id", workspaceId)
          .in("id", spaceIds),
  ]);
  if (venues.error || spaces.error) throw new Error("Could not load event places");
  const venueById = new Map((venues.data as unknown as VenueRow[]).map((v) => [v.id, v]));
  const spaceById = new Map(spaces.data.map((s) => [s.id, s]));
  for (const r of rows) {
    const v = venueById.get(r.candidate_id);
    if (!v) continue;
    const f = venueFacts(v);
    const s = r.space_id ? spaceById.get(r.space_id) : undefined;
    out.set(r.event_id, {
      eventId: r.event_id,
      version: r.version,
      venue: {
        id: v.id,
        name: v.name,
        archived: v.archived_at !== null,
        seatedCapacity: f.seated,
        ceremonyCapacity: f.ceremony,
      },
      space: s
        ? {
            id: s.id,
            name: s.name,
            archived: s.archived_at !== null,
            seatedCapacity: s.seated_capacity,
            standingCapacity: s.standing_capacity,
          }
        : null,
    });
  }
  return out;
}

/** Venues that have an active booking (a recorded agreement, not money moved). */
export async function loadBookedVenueIds(workspaceId: string): Promise<Set<string>> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from("commitments")
    .select("candidate_id")
    .eq("wedding_id", workspaceId)
    .eq("status", "active")
    .not("candidate_id", "is", null)
    .limit(500);
  if (error) throw new Error("Could not load bookings");
  return new Set(data.flatMap((r) => (r.candidate_id ? [r.candidate_id] : [])));
}
