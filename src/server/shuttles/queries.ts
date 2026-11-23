import "server-only";
import {
  isShuttleDirection,
  type ShuttleAssignment,
  type ShuttleRun,
} from "@/domain/shuttles/shuttles";
import { createUserClient } from "@/server/supabase/server";

export type ShuttleGuest = { id: string; name: string; household: string | null };

export type ShuttleData = {
  runs: ShuttleRun[];
  assignments: ShuttleAssignment[];
  /** Guests whose active invitation for this event is accepted and who are not archived. */
  attending: ShuttleGuest[];
};

/**
 * Runs, riders and attending guests for one event. RLS limits every row to people who manage
 * guests, so a caller without that access gets empty lists, never someone else's data. Names and
 * household names only: no contact, dietary or access details.
 */
export async function loadShuttles(workspaceId: string, eventId: string): Promise<ShuttleData> {
  const supabase = await createUserClient();
  const [runRes, assignRes, memberRes] = await Promise.all([
    supabase
      .from("shuttle_runs")
      .select("id, direction, label, pickup, dropoff, departs_at, capacity, notes, version")
      .eq("wedding_id", workspaceId)
      .eq("event_id", eventId)
      .order("departs_at")
      .limit(100),
    supabase
      .from("shuttle_assignments")
      .select("run_id, guest_id, direction")
      .eq("wedding_id", workspaceId)
      .eq("event_id", eventId)
      .limit(5000),
    supabase
      .from("invitation_members")
      .select("guest_id")
      .eq("wedding_id", workspaceId)
      .eq("event_id", eventId)
      .eq("active", true)
      .eq("rsvp_status", "accepted")
      .limit(5000),
  ]);
  if (runRes.error || assignRes.error || memberRes.error)
    throw new Error("Could not load shuttles");

  const attendingIds = [...new Set(memberRes.data.map((m) => m.guest_id))];
  let attending: ShuttleGuest[] = [];
  if (attendingIds.length > 0) {
    const [guestRes, householdRes] = await Promise.all([
      supabase
        .from("guests")
        .select("id, full_name, household_id")
        .eq("wedding_id", workspaceId)
        .is("archived_at", null)
        .in("id", attendingIds)
        .limit(5000),
      supabase.from("households").select("id, name").eq("wedding_id", workspaceId).limit(5000),
    ]);
    if (guestRes.error || householdRes.error) throw new Error("Could not load shuttles");
    const households = new Map(householdRes.data.map((h) => [h.id, h.name]));
    attending = guestRes.data.map((g) => ({
      id: g.id,
      name: g.full_name,
      household: g.household_id ? (households.get(g.household_id) ?? null) : null,
    }));
  }

  return {
    runs: runRes.data.flatMap((r) =>
      isShuttleDirection(r.direction)
        ? [
            {
              id: r.id,
              direction: r.direction,
              label: r.label,
              pickup: r.pickup,
              dropoff: r.dropoff,
              departsAt: r.departs_at,
              capacity: r.capacity,
              notes: r.notes,
              version: r.version,
            },
          ]
        : [],
    ),
    assignments: assignRes.data.flatMap((a) =>
      isShuttleDirection(a.direction)
        ? [{ runId: a.run_id, guestId: a.guest_id, direction: a.direction }]
        : [],
    ),
    attending,
  };
}

/** Riders and seats per event, for the event page card. Empty when the caller can't read them. */
export async function loadShuttleTotals(
  workspaceId: string,
  eventId: string,
): Promise<{ runs: number; seats: number; rides: number }> {
  const supabase = await createUserClient();
  const [runRes, assignRes] = await Promise.all([
    supabase
      .from("shuttle_runs")
      .select("capacity")
      .eq("wedding_id", workspaceId)
      .eq("event_id", eventId)
      .limit(100),
    supabase
      .from("shuttle_assignments")
      .select("id", { count: "exact", head: true })
      .eq("wedding_id", workspaceId)
      .eq("event_id", eventId),
  ]);
  if (runRes.error || assignRes.error) throw new Error("Could not load shuttles");
  return {
    runs: runRes.data.length,
    seats: runRes.data.reduce((n, r) => n + r.capacity, 0),
    rides: assignRes.count ?? 0,
  };
}
