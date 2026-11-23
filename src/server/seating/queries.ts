import "server-only";
import { parseFrozenPlan, type FrozenPlan } from "@/domain/seating/versions";
import { combineNote } from "@/domain/guests/notes";
import { isElementKind, type FloorElement } from "@/domain/seating/floor";
import type {
  GuestInfo,
  PlanAssignment,
  PlanGuest,
  PlanMeal,
  PlanMember,
  PlanTable,
  TableShape,
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
export type SeatingTableRecord = PlanTable & {
  version: number;
  /** Saved floor-plan position (centre, grid units); null until the table is first moved. */
  x: number | null;
  y: number | null;
};
export type SeatingElementRecord = FloorElement & { version: number };

export type SeatingData = {
  event: {
    id: string;
    name: string;
    kind: string;
    localDate: string | null;
    capacity: number | null;
  };
  layout: SeatingLayoutRecord | null;
  tables: SeatingTableRecord[];
  elements: SeatingElementRecord[];
  assignments: PlanAssignment[];
  members: PlanMember[];
  guests: PlanGuest[];
  /** Household, plus-one, tags and private notes per guest; empty when details weren't requested. */
  info: GuestInfo[];
  meals: (PlanMeal & { active: boolean })[];
};

const statusOf = (v: string): PlanMember["status"] =>
  v === "accepted" || v === "declined" ? v : "pending";
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Returns null when the event is not in this workspace. RLS limits rows to owner and partner.
 * Dietary and access notes are read only when `details` is true; exports pass false so private
 * notes never reach them.
 */
export async function loadSeating(
  workspaceId: string,
  eventId: string,
  options: { details?: boolean } = {},
): Promise<SeatingData | null> {
  const withDetails = options.details ?? true;
  const supabase = await createUserClient();
  const eventRes = await supabase
    .from("events")
    .select("id, name, kind, local_date, capacity")
    .eq("wedding_id", workspaceId)
    .eq("id", eventId)
    .maybeSingle();
  if (eventRes.error) throw new Error("Could not load seating");
  if (!eventRes.data) return null;

  const [layoutRes, memberRes, mealRes, inviteRes] = await Promise.all([
    supabase
      .from("seating_layouts")
      .select("id, allow_tentative, revision, finalized_revision, finalized_at, snapshot, version")
      .eq("wedding_id", workspaceId)
      .eq("event_id", eventId)
      .maybeSingle(),
    supabase
      .from("invitation_members")
      .select("guest_id, invitation_id, is_plus_one, rsvp_status, meal_option_id")
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
    supabase
      .from("invitations")
      .select("id, label, household_id")
      .eq("wedding_id", workspaceId)
      .eq("event_id", eventId)
      .limit(5000),
  ]);
  if (layoutRes.error || memberRes.error || mealRes.error || inviteRes.error)
    throw new Error("Could not load seating");

  const guestIds = memberRes.data.map((m) => m.guest_id);
  const guestRes =
    guestIds.length === 0
      ? { data: [], error: null }
      : await supabase
          .from("guests")
          .select("id, full_name, household_id, tags, age_group")
          .eq("wedding_id", workspaceId)
          .is("archived_at", null)
          .limit(5000);
  if (guestRes.error) throw new Error("Could not load seating");
  const [householdRes, detailRes] = await Promise.all([
    guestIds.length === 0
      ? { data: [], error: null }
      : supabase.from("households").select("id, name").eq("wedding_id", workspaceId).limit(5000),
    guestIds.length === 0 || !withDetails
      ? { data: [], error: null }
      : supabase
          .from("guest_private_details")
          .select("guest_id, dietary, accessibility, guest_dietary, guest_accessibility")
          .eq("wedding_id", workspaceId)
          .limit(5000),
  ]);
  if (householdRes.error || detailRes.error) throw new Error("Could not load seating");
  const live = new Set(guestRes.data.map((g) => g.id));

  const layoutRow = layoutRes.data;
  let tables: SeatingTableRecord[] = [];
  let elements: SeatingElementRecord[] = [];
  let assignments: PlanAssignment[] = [];
  if (layoutRow) {
    const [tableRes, assignRes, elementRes] = await Promise.all([
      supabase
        .from("seating_tables")
        .select("id, label, capacity, shape, notes, version, pos_x, pos_y")
        .eq("layout_id", layoutRow.id)
        .order("label")
        .limit(100),
      supabase
        .from("seat_assignments")
        .select("guest_id, table_id, tentative, seat_number, is_captain")
        .eq("layout_id", layoutRow.id)
        .limit(5000),
      supabase
        .from("seating_elements")
        .select("id, kind, label, x, y, w, h, version")
        .eq("layout_id", layoutRow.id)
        .order("created_at")
        .limit(40),
    ]);
    if (tableRes.error || assignRes.error || elementRes.error)
      throw new Error("Could not load seating");
    tables = tableRes.data.map((t) => ({
      id: t.id,
      label: t.label,
      capacity: t.capacity,
      shape: t.shape === "rectangle" ? ("rectangle" as TableShape) : ("round" as TableShape),
      notes: t.notes,
      version: t.version,
      x: t.pos_x,
      y: t.pos_y,
    }));
    elements = elementRes.data.map((e) => ({
      id: e.id,
      kind: isElementKind(e.kind) ? e.kind : "other",
      label: e.label,
      x: e.x,
      y: e.y,
      w: e.w,
      h: e.h,
      version: e.version,
    }));
    assignments = assignRes.data.map((a) => ({
      guestId: a.guest_id,
      tableId: a.table_id,
      tentative: a.tentative,
      seatNumber: a.seat_number,
      isCaptain: a.is_captain,
    }));
  }

  const guestNames = new Map(guestRes.data.map((g) => [g.id, g.full_name]));
  const householdName = new Map(householdRes.data.map((h) => [h.id, h.name]));
  const invitationLabel = new Map(inviteRes.data.map((i) => [i.id, i.label]));
  const detailOf = new Map(detailRes.data.map((d) => [d.guest_id, d]));
  const invitedNames = new Map<string, string[]>();
  for (const m of memberRes.data) {
    if (m.is_plus_one || !live.has(m.guest_id)) continue;
    const name = guestNames.get(m.guest_id);
    if (name)
      invitedNames.set(m.invitation_id, [...(invitedNames.get(m.invitation_id) ?? []), name]);
  }
  const memberOfGuest = new Map(memberRes.data.map((m) => [m.guest_id, m]));
  const info: GuestInfo[] = guestRes.data
    .filter((g) => memberOfGuest.has(g.id))
    .map((g) => {
      const m = memberOfGuest.get(g.id)!;
      const detail = detailOf.get(g.id);
      return {
        guestId: g.id,
        householdName: g.household_id ? (householdName.get(g.household_id) ?? null) : null,
        invitationId: m.invitation_id,
        invitationLabel: invitationLabel.get(m.invitation_id) ?? null,
        isPlusOne: m.is_plus_one,
        hostNames: m.is_plus_one ? (invitedNames.get(m.invitation_id) ?? []) : [],
        tags: g.tags,
        ageGroup: g.age_group === "child" ? "child" : g.age_group === "adult" ? "adult" : null,
        dietary: combineNote({
          couple: detail?.dietary ?? null,
          guest: detail?.guest_dietary ?? null,
        }),
        accessibility: combineNote({
          couple: detail?.accessibility ?? null,
          guest: detail?.guest_accessibility ?? null,
        }),
      };
    });

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
      kind: eventRes.data.kind,
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
    elements,
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
    info,
    meals: mealRes.data.map((m) => ({ id: m.id, name: m.name, active: m.active })),
  };
}

export type SeatingVersionSummary = {
  id: string;
  revision: number;
  finalizedAt: string;
  accepted: number;
  confirmedSeated: number;
  tentativeSeated: number;
};

/**
 * Every finalized copy of an event's plan, newest first. RLS limits these rows to owner and
 * partner. Only the counts are read here; the full copy is loaded one at a time.
 */
export async function loadSeatingVersions(
  workspaceId: string,
  eventId: string,
): Promise<SeatingVersionSummary[]> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from("seating_snapshots")
    .select("id, revision, finalized_at, snapshot")
    .eq("wedding_id", workspaceId)
    .eq("event_id", eventId)
    .order("finalized_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(100);
  if (error) throw new Error("Could not load finalized versions");
  return data.map((row) => {
    const plan = parseFrozenPlan(row.snapshot);
    return {
      id: row.id,
      revision: row.revision,
      finalizedAt: row.finalized_at,
      accepted: plan?.accepted ?? 0,
      confirmedSeated: plan?.confirmedSeated ?? 0,
      tentativeSeated: plan?.tentativeSeated ?? 0,
    };
  });
}

export type SeatingVersion = {
  id: string;
  eventName: string;
  revision: number;
  finalizedAt: string;
  plan: FrozenPlan;
  /** True when this is the copy the layout currently holds (not an older one). */
  isLatest: boolean;
  /** True when the live plan has changed since this copy was frozen. */
  outOfDate: boolean;
};

/** Null when the copy is not in this workspace and event (or the caller may not read it). */
export async function loadSeatingVersion(
  workspaceId: string,
  eventId: string,
  snapshotId: string,
): Promise<SeatingVersion | null> {
  const supabase = await createUserClient();
  const [snapRes, eventRes, layoutRes, latestRes] = await Promise.all([
    supabase
      .from("seating_snapshots")
      .select("id, revision, finalized_at, snapshot")
      .eq("wedding_id", workspaceId)
      .eq("event_id", eventId)
      .eq("id", snapshotId)
      .maybeSingle(),
    supabase
      .from("events")
      .select("name")
      .eq("wedding_id", workspaceId)
      .eq("id", eventId)
      .maybeSingle(),
    supabase
      .from("seating_layouts")
      .select("revision")
      .eq("wedding_id", workspaceId)
      .eq("event_id", eventId)
      .maybeSingle(),
    supabase
      .from("seating_snapshots")
      .select("id")
      .eq("wedding_id", workspaceId)
      .eq("event_id", eventId)
      .order("finalized_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (snapRes.error || eventRes.error || layoutRes.error || latestRes.error)
    throw new Error("Could not load the finalized version");
  if (!snapRes.data || !eventRes.data) return null;
  const plan = parseFrozenPlan(snapRes.data.snapshot);
  if (!plan) return null;
  const isLatest = latestRes.data?.id === snapRes.data.id;
  return {
    id: snapRes.data.id,
    eventName: eventRes.data.name,
    revision: snapRes.data.revision,
    finalizedAt: snapRes.data.finalized_at,
    plan,
    isLatest,
    outOfDate:
      !isLatest || (layoutRes.data?.revision ?? snapRes.data.revision) !== snapRes.data.revision,
  };
}

/**
 * Seat total of each event's tables (event id to seats). Events with no plan or no tables are
 * absent. RLS limits seating rows to owner and partner, so anyone else gets an empty map.
 */
export async function loadTableSeatTotals(workspaceId: string): Promise<Map<string, number>> {
  const supabase = await createUserClient();
  const [layouts, tables] = await Promise.all([
    supabase.from("seating_layouts").select("id, event_id").eq("wedding_id", workspaceId),
    supabase.from("seating_tables").select("layout_id, capacity").eq("wedding_id", workspaceId),
  ]);
  if (layouts.error || tables.error) throw new Error("Could not load seating totals");
  const eventOf = new Map(layouts.data.map((l) => [l.id, l.event_id]));
  const totals = new Map<string, number>();
  for (const t of tables.data) {
    const event = eventOf.get(t.layout_id);
    if (event) totals.set(event, (totals.get(event) ?? 0) + t.capacity);
  }
  return totals;
}
