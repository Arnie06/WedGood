/**
 * Pure seating arithmetic (docs/07-DOMAIN-RULES.md "Seating"). The database enforces capacity and
 * eligibility; this module derives what the page and reports show from the same rows so totals are
 * deterministic and never double count.
 *
 * Definitions:
 *  - accepted: active, non-archived guests whose answer for this event is "accepted".
 *  - confirmed seated: assignments with tentative = false. Tentative seats (pending guests, only when
 *    the layout allows it) occupy capacity but are never counted as confirmed.
 *  - unassigned accepted = accepted - confirmed seated.
 */

export type PlanGuest = { id: string; name: string };
export type PlanMember = {
  guestId: string;
  status: "pending" | "accepted" | "declined";
  mealOptionId: string | null;
};
export type PlanTable = { id: string; label: string; capacity: number };
export type PlanAssignment = {
  guestId: string;
  tableId: string;
  tentative: boolean;
  seatNumber: number | null;
};
export type PlanMeal = { id: string; name: string };

export type MealLine = {
  mealOptionId: string | null;
  name: string;
  confirmed: number;
  tentative: number;
};

export type TablePlan = {
  id: string;
  label: string;
  capacity: number;
  confirmed: PlanGuest[];
  tentative: PlanGuest[];
  used: number;
  open: number;
  meals: MealLine[];
};

export type SeatingPlan = {
  tables: TablePlan[];
  /** Accepted guests with no seat, by name. */
  queue: PlanGuest[];
  /** Waiting guests with no seat; only meaningful when tentative seating is on. */
  waitingQueue: PlanGuest[];
  totals: {
    accepted: number;
    confirmedSeated: number;
    tentativeSeated: number;
    unassignedAccepted: number;
    capacity: number;
    openSeats: number;
    acceptedWithoutMeal: number;
  };
  /** Accepted guests (seated or not) by meal choice, in meal-list order. */
  meals: MealLine[];
  /** Problems that should never exist if the database rules hold; shown rather than hidden. */
  issues: string[];
};

const byName = (a: PlanGuest, b: PlanGuest) =>
  a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id);

export function buildSeatingPlan(input: {
  guests: readonly PlanGuest[];
  members: readonly PlanMember[];
  tables: readonly PlanTable[];
  assignments: readonly PlanAssignment[];
  meals: readonly PlanMeal[];
  allowTentative: boolean;
}): SeatingPlan {
  const issues: string[] = [];
  const guestById = new Map(input.guests.map((g) => [g.id, g]));
  const memberByGuest = new Map<string, PlanMember>();
  for (const m of input.members) {
    if (memberByGuest.has(m.guestId))
      issues.push("A guest has more than one answer for this event.");
    memberByGuest.set(m.guestId, m);
  }
  const mealName = new Map(input.meals.map((m) => [m.id, m.name]));
  const mealKeys: (string | null)[] = [...input.meals.map((m) => m.id), null];
  const lineName = (id: string | null) =>
    id === null ? "No choice yet" : (mealName.get(id) ?? "Unknown");
  const emptyLines = (): Map<string | null, MealLine> =>
    new Map(
      mealKeys.map((k) => [k, { mealOptionId: k, name: lineName(k), confirmed: 0, tentative: 0 }]),
    );
  const mealOf = (guestId: string): string | null => {
    const id = memberByGuest.get(guestId)?.mealOptionId ?? null;
    return id !== null && mealName.has(id) ? id : null;
  };
  const finishLines = (m: Map<string | null, MealLine>): MealLine[] =>
    [...m.values()].filter((l) => l.confirmed + l.tentative > 0 || l.mealOptionId !== null);

  const seatedIds = new Set<string>();
  const tableIds = new Set(input.tables.map((t) => t.id));
  const perTable = new Map<string, PlanAssignment[]>();
  for (const a of input.assignments) {
    if (!tableIds.has(a.tableId)) {
      issues.push("A seat points to a table that is not in this layout.");
      continue;
    }
    if (seatedIds.has(a.guestId)) {
      issues.push("A guest is seated more than once.");
      continue;
    }
    seatedIds.add(a.guestId);
    perTable.set(a.tableId, [...(perTable.get(a.tableId) ?? []), a]);
  }

  const eventMeals = emptyLines();
  let acceptedWithoutMeal = 0;
  const accepted: PlanGuest[] = [];
  for (const m of input.members) {
    const guest = guestById.get(m.guestId);
    if (!guest || m.status !== "accepted") continue;
    accepted.push(guest);
    const key = mealOf(m.guestId);
    if (key === null) acceptedWithoutMeal += 1;
    // Event-level meal totals count every accepted guest once, seated or not.
    eventMeals.get(key)!.confirmed += 1;
  }

  const tables: TablePlan[] = input.tables.map((t) => {
    const rows = perTable.get(t.id) ?? [];
    const lines = emptyLines();
    const confirmed: PlanGuest[] = [];
    const tentative: PlanGuest[] = [];
    for (const a of rows) {
      const guest = guestById.get(a.guestId);
      const status = memberByGuest.get(a.guestId)?.status;
      if (!guest || (a.tentative ? status !== "pending" : status !== "accepted")) {
        issues.push(`A seated guest at ${t.label} no longer has a matching answer.`);
        continue;
      }
      const line = lines.get(mealOf(a.guestId))!;
      if (a.tentative) {
        tentative.push(guest);
        line.tentative += 1;
      } else {
        confirmed.push(guest);
        line.confirmed += 1;
      }
    }
    confirmed.sort(byName);
    tentative.sort(byName);
    const used = confirmed.length + tentative.length;
    if (used > t.capacity) issues.push(`${t.label} has more guests than seats.`);
    return {
      id: t.id,
      label: t.label,
      capacity: t.capacity,
      confirmed,
      tentative,
      used,
      open: Math.max(0, t.capacity - used),
      meals: finishLines(lines),
    };
  });

  const queue = accepted.filter((g) => !seatedIds.has(g.id)).sort(byName);
  const waitingQueue = input.allowTentative
    ? input.members
        .filter((m) => m.status === "pending" && !seatedIds.has(m.guestId))
        .map((m) => guestById.get(m.guestId))
        .filter((g): g is PlanGuest => g !== undefined)
        .sort(byName)
    : [];

  const confirmedSeated = tables.reduce((n, t) => n + t.confirmed.length, 0);
  const tentativeSeated = tables.reduce((n, t) => n + t.tentative.length, 0);
  const capacity = tables.reduce((n, t) => n + t.capacity, 0);

  return {
    tables,
    queue,
    waitingQueue,
    totals: {
      accepted: accepted.length,
      confirmedSeated,
      tentativeSeated,
      unassignedAccepted: queue.length,
      capacity,
      openSeats: tables.reduce((n, t) => n + t.open, 0),
      acceptedWithoutMeal,
    },
    meals: finishLines(eventMeals).map((l) => ({ ...l, tentative: 0 })),
    issues,
  };
}

/** A finalized snapshot is stale as soon as the plan's revision differs from the frozen one. */
export type SnapshotState = "none" | "current" | "stale";
export function snapshotState(layout: {
  revision: number;
  finalizedRevision: number | null;
}): SnapshotState {
  if (layout.finalizedRevision === null) return "none";
  return layout.finalizedRevision === layout.revision ? "current" : "stale";
}
