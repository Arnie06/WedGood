import "server-only";
import type {
  PlanAssignment,
  PlanGuest,
  PlanMeal,
  PlanMember,
  PlanTable,
} from "@/domain/seating/plan";
import { createUserClient } from "@/server/supabase/server";

export type SeatingLayoutRecord = {
  id: string;
  allowTentative: boolean;
  revision: number;
  finalizedRevision: number | null;
  finalizedAt: string | null;
  /** Counts frozen at finalization (never recomputed). */
  frozen: { accepted: number; confirmedSeated: number; tentativeSeated: number } | null;
  version: number;
};
export type SeatingTableRecord = PlanTable & { version: number };

export type SeatingData = {
  event: { id: string; name: string; localDate: string | null; capacity: number | null };
  layout: SeatingLayoutRecord | null;
  tables: SeatingTableRecord[];
  assignments: PlanAssignment[];
  members: PlanMember[];
  guests: PlanGuest[];
  meals: (PlanMeal & { active: boolean })[];
};

const statusOf = (v: string): PlanMember["status"] =>
  v === "accepted" || v === "declined" ? v : "pending";
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Returns null when the event is not in this workspace. RLS limits rows to owner and partner. */
export async function loadSeating(
  workspaceId: string,
  eventId: string,
): Promise<SeatingData | null> {
  const supabase = await createUserClient();
  const eventRes = await supabase
    .from("events")
    .select("id, name, local_date, capacity")
    .eq("wedding_id", workspaceId)
    .eq("id", eventId)
    .maybeSingle();
  if (eventRes.error) throw new Error("Could not load seating");
  if (!eventRes.data) return null;

  const [layoutRes, memberRes, mealRes] = await Promise.all([
    supabase
      .from("seating_layouts")
      .select("id, allow_tentative, revision, finalized_revision, finalized_at, snapshot, version")
      .eq("wedding_id", workspaceId)
      .eq("event_id", eventId)
      .maybeSingle(),
    supabase
      .from("invitation_members")
      .select("guest_id, rsvp_status, meal_option_id")
      .eq("wedding_id", workspaceId)
      .eq("event_id", eventId)
      .eq("active", true)
      .limit(5000),
    supabase
      .from("meal_options")
      .select("id, name, active")
      .eq("wedding_id", workspaceId)
      .eq("event_id", eventId)
      .order("created_at")
      .limit(100),
  ]);
  if (layoutRes.error || memberRes.error || mealRes.error)
    throw new Error("Could not load seating");

  const guestIds = memberRes.data.map((m) => m.guest_id);
  const guestRes =
    guestIds.length === 0
      ? { data: [], error: null }
      : await supabase
          .from("guests")
          .select("id, full_name")
          .eq("wedding_id", workspaceId)
          .is("archived_at", null)
          .limit(5000);
  if (guestRes.error) throw new Error("Could not load seating");
  const live = new Set(guestRes.data.map((g) => g.id));

  const layoutRow = layoutRes.data;
  let tables: SeatingTableRecord[] = [];
  let assignments: PlanAssignment[] = [];
  if (layoutRow) {
    const [tableRes, assignRes] = await Promise.all([
      supabase
        .from("seating_tables")
        .select("id, label, capacity, version")
        .eq("layout_id", layoutRow.id)
        .order("label")
        .limit(100),
      supabase
        .from("seat_assignments")
        .select("guest_id, table_id, tentative, seat_number")
        .eq("layout_id", layoutRow.id)
        .limit(5000),
    ]);
    if (tableRes.error || assignRes.error) throw new Error("Could not load seating");
    tables = tableRes.data.map((t) => ({
      id: t.id,
      label: t.label,
      capacity: t.capacity,
      version: t.version,
    }));
    assignments = assignRes.data.map((a) => ({
      guestId: a.guest_id,
      tableId: a.table_id,
      tentative: a.tentative,
      seatNumber: a.seat_number,
    }));
  }

  const snap =
    layoutRow?.snapshot &&
    typeof layoutRow.snapshot === "object" &&
    !Array.isArray(layoutRow.snapshot)
      ? (layoutRow.snapshot as Record<string, unknown>)
      : null;

  return {
    event: {
      id: eventRes.data.id,
      name: eventRes.data.name,
      localDate: eventRes.data.local_date,
      capacity: eventRes.data.capacity,
    },
    layout: layoutRow
      ? {
          id: layoutRow.id,
          allowTentative: layoutRow.allow_tentative,
          revision: layoutRow.revision,
          finalizedRevision: layoutRow.finalized_revision,
          finalizedAt: layoutRow.finalized_at,
          frozen: snap
            ? {
                accepted: num(snap.accepted),
                confirmedSeated: num(snap.confirmedSeated),
                tentativeSeated: num(snap.tentativeSeated),
              }
            : null,
          version: layoutRow.version,
        }
      : null,
    tables,
    assignments,
    members: memberRes.data
      .filter((m) => live.has(m.guest_id))
      .map((m) => ({
        guestId: m.guest_id,
        status: statusOf(m.rsvp_status),
        mealOptionId: m.meal_option_id,
      })),
    guests: guestRes.data
      .filter((g) => guestIds.includes(g.id))
      .map((g) => ({ id: g.id, name: g.full_name })),
    meals: mealRes.data.map((m) => ({ id: m.id, name: m.name, active: m.active })),
  };
}
