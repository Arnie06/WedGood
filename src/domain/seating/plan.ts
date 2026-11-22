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
export type TableShape = "round" | "rectangle";
export type PlanTable = {
  id: string;
  label: string;
  capacity: number;
  shape?: TableShape;
  notes?: string | null;
};
export type PlanAssignment = {
  guestId: string;
  tableId: string;
  tentative: boolean;
  seatNumber: number | null;
  isCaptain?: boolean;
};
/** What the couple wants to see about a guest while seating. Dietary and access text is private. */
export type GuestInfo = {
  guestId: string;
  householdName: string | null;
  invitationId: string | null;
  invitationLabel: string | null;
  isPlusOne: boolean;
  /** For a plus-one: the names of the invited guests on the same invitation. */
  hostNames: string[];
  tags: string[];
  ageGroup: "adult" | "child" | null;
  dietary: string | null;
  accessibility: string | null;
};
export type PlanMeal = { id: string; name: string };

export type MealLine = {
  mealOptionId: string | null;
  name: string;
  confirmed: number;
  tentative: number;
};

export type TableSeat = {
  guest: PlanGuest;
  /** True while the guest hasn't answered (only possible when tentative seating is on). */
  tentative: boolean;
  seatNumber: number | null;
  captain: boolean;
  info: GuestInfo | null;
};

export type TableStats = {
  /** Guests at the table who have said yes. */
  accepted: number;
  /** Guests at the table still waiting to answer. */
  waiting: number;
  plusOnes: number;
  children: number;
  dietary: number;
  accessibility: number;
};

export type TablePlan = {
  id: string;
  label: string;
  capacity: number;
  shape: TableShape;
  notes: string | null;
  captainId: string | null;
  confirmed: PlanGuest[];
  tentative: PlanGuest[];
  /** Everyone at the table with their details, in seat-number then name order. */
  seats: TableSeat[];
  stats: TableStats;
  used: number;
  open: number;
  meals: MealLine[];
};

/** Unseated guests who belong together (same invitation, so a household or a guest and plus-one). */
export type QueueGroup = { key: string; label: string; guests: PlanGuest[] };

export type SeatingPlan = {
  tables: TablePlan[];
  /** Accepted guests with no seat, by name. */
  queue: PlanGuest[];
  /** Waiting guests with no seat; only meaningful when tentative seating is on. */
  waitingQueue: PlanGuest[];
  /** Unseated guests who can be seated now, grouped by invitation; only groups of two or more. */
  queueGroups: QueueGroup[];
  totals: {
    accepted: number;
    confirmedSeated: number;
    tentativeSeated: number;
    unassignedAccepted: number;
    capacity: number;
    openSeats: number;
    acceptedWithoutMeal: number;
    /** Attending guests with a dietary note / an access note. */
    dietary: number;
    accessibility: number;
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
  info?: readonly GuestInfo[];
}): SeatingPlan {
  const issues: string[] = [];
  const infoByGuest = new Map((input.info ?? []).map((i) => [i.guestId, i]));
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
  let dietaryTotal = 0;
  let accessibilityTotal = 0;
  const accepted: PlanGuest[] = [];
  for (const m of input.members) {
    const guest = guestById.get(m.guestId);
    if (!guest || m.status !== "accepted") continue;
    accepted.push(guest);
    const detail = infoByGuest.get(m.guestId);
    if (detail?.dietary) dietaryTotal += 1;
    if (detail?.accessibility) accessibilityTotal += 1;
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
    const seats: TableSeat[] = [];
    const stats: TableStats = {
      accepted: 0,
      waiting: 0,
      plusOnes: 0,
      children: 0,
      dietary: 0,
      accessibility: 0,
    };
    let captainId: string | null = null;
    for (const a of rows) {
      const guest = guestById.get(a.guestId);
      const status = memberByGuest.get(a.guestId)?.status;
      if (!guest || (a.tentative ? status !== "pending" : status !== "accepted")) {
        issues.push(`A seated guest at ${t.label} no longer has a matching answer.`);
        continue;
      }
      const line = lines.get(mealOf(a.guestId))!;
      const detail = infoByGuest.get(a.guestId) ?? null;
      if (a.tentative) {
        tentative.push(guest);
        line.tentative += 1;
        stats.waiting += 1;
      } else {
        confirmed.push(guest);
        line.confirmed += 1;
        stats.accepted += 1;
      }
      if (detail?.isPlusOne) stats.plusOnes += 1;
      if (detail?.ageGroup === "child") stats.children += 1;
      if (detail?.dietary) stats.dietary += 1;
      if (detail?.accessibility) stats.accessibility += 1;
      if (a.isCaptain) {
        if (captainId !== null) issues.push(`${t.label} has more than one captain.`);
        else captainId = guest.id;
      }
      seats.push({
        guest,
        tentative: a.tentative,
        seatNumber: a.seatNumber,
        captain: a.isCaptain === true,
        info: detail,
      });
    }
    confirmed.sort(byName);
    tentative.sort(byName);
    seats.sort((a, b) => (a.seatNumber ?? 999) - (b.seatNumber ?? 999) || byName(a.guest, b.guest));
    const used = confirmed.length + tentative.length;
    if (used > t.capacity) issues.push(`${t.label} has more guests than seats.`);
    return {
      id: t.id,
      label: t.label,
      capacity: t.capacity,
      shape: t.shape ?? "round",
      notes: t.notes ?? null,
      captainId,
      confirmed,
      tentative,
      seats,
      stats,
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

  const seatable = [...queue, ...waitingQueue];
  const groupMap = new Map<string, QueueGroup>();
  for (const g of seatable) {
    const detail = infoByGuest.get(g.id);
    if (!detail?.invitationId) continue;
    const group = groupMap.get(detail.invitationId) ?? {
      key: detail.invitationId,
      label: detail.invitationLabel ?? "Group",
      guests: [],
    };
    group.guests.push(g);
    groupMap.set(detail.invitationId, group);
  }
  const queueGroups = [...groupMap.values()]
    .filter((group) => group.guests.length >= 2)
    .map((group) => ({ ...group, guests: group.guests.sort(byName) }))
    .sort((a, b) => a.label.localeCompare(b.label, "en") || a.key.localeCompare(b.key));

  const confirmedSeated = tables.reduce((n, t) => n + t.confirmed.length, 0);
  const tentativeSeated = tables.reduce((n, t) => n + t.tentative.length, 0);
  const capacity = tables.reduce((n, t) => n + t.capacity, 0);

  return {
    tables,
    queue,
    waitingQueue,
    queueGroups,
    totals: {
      accepted: accepted.length,
      confirmedSeated,
      tentativeSeated,
      unassignedAccepted: queue.length,
      capacity,
      openSeats: tables.reduce((n, t) => n + t.open, 0),
      acceptedWithoutMeal,
      dietary: dietaryTotal,
      accessibility: accessibilityTotal,
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
