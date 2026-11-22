import type { PlanGuest, SeatingPlan, GuestInfo } from "./plan";

/**
 * Suggested seating (ADR-030, SEAT-5). A deterministic proposal for the guests who have no seat yet.
 * Pure: it reads a plan and returns a proposal, and never writes anything.
 *
 * Rules, in order:
 *  - Only guests who can be seated now are placed (attending, plus waiting guests when tentative
 *    seating is on, exactly as `plan.queue` and `plan.waitingQueue` define it). Anyone already seated
 *    stays where they are; the proposal only adds.
 *  - A group is an invitation: a household, or a guest and their plus-one (the same unit as "seat
 *    together"). A group goes to one table or is reported as not placed. It is never split.
 *  - If other people on the same invitation are already seated, the rest of the group goes to that
 *    table when it has room.
 *  - Otherwise the biggest groups go first, each to the table where it fits most tightly (fewest open
 *    seats left over, then plan order), so partly filled tables fill up before an empty one is used.
 *  - Nothing is invented: no seat numbers, captains, relationships or preferences. Couples adjust
 *    the result with the normal seating tools.
 */

export type SuggestedGuest = PlanGuest & { tentative: boolean };
export type SuggestedGroup = { key: string; label: string; guests: SuggestedGuest[] };

export type SuggestedTable = {
  tableId: string;
  tableLabel: string;
  capacity: number;
  /** Seats taken before the proposal, and after it. */
  usedBefore: number;
  usedAfter: number;
  groups: SuggestedGroup[];
};

export type UnplacedReason =
  /** No table has enough open seats left for the whole group together. */
  | "too-large"
  /** Every table is full. */
  | "no-room";

export type UnplacedGroup = SuggestedGroup & {
  reason: UnplacedReason;
  /** Seats the group needs together, and the most open seats at any single table at that point. */
  needed: number;
  largestOpen: number;
};

export type SeatingSuggestion = {
  tables: SuggestedTable[];
  unplaced: UnplacedGroup[];
  placedCount: number;
  unplacedCount: number;
  /** Placed guests who haven't answered yet (they get a tentative seat). */
  tentativeCount: number;
};

const byName = (a: PlanGuest, b: PlanGuest) =>
  a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id);

export function suggestSeating(input: {
  plan: SeatingPlan;
  info: readonly GuestInfo[];
}): SeatingSuggestion {
  const { plan } = input;
  const invitationOf = new Map(input.info.map((i) => [i.guestId, i]));

  // Open seats per table as the proposal fills them, in plan order (the tie-break).
  const open = plan.tables.map((t) => t.open);
  const added = plan.tables.map((): SuggestedGroup[] => []);

  // Who is already seated where, by invitation.
  const seatedAt = new Map<string, Map<number, number>>();
  plan.tables.forEach((t, index) => {
    for (const seat of t.seats) {
      const key = seat.info?.invitationId ?? invitationOf.get(seat.guest.id)?.invitationId;
      if (!key) continue;
      const perTable = seatedAt.get(key) ?? new Map<number, number>();
      perTable.set(index, (perTable.get(index) ?? 0) + 1);
      seatedAt.set(key, perTable);
    }
  });

  const tentativeIds = new Set(plan.waitingQueue.map((g) => g.id));
  const groups = new Map<string, SuggestedGroup>();
  for (const g of [...plan.queue, ...plan.waitingQueue]) {
    const detail = invitationOf.get(g.id);
    const key = detail?.invitationId ?? `guest:${g.id}`;
    const group = groups.get(key) ?? {
      key,
      label: detail?.invitationId ? (detail.invitationLabel ?? "Group") : g.name,
      guests: [],
    };
    group.guests.push({ ...g, tentative: tentativeIds.has(g.id) });
    groups.set(key, group);
  }
  const ordered = [...groups.values()]
    .map((g) => ({ ...g, guests: g.guests.sort(byName) }))
    .sort(
      (a, b) =>
        b.guests.length - a.guests.length ||
        a.label.localeCompare(b.label, "en") ||
        a.key.localeCompare(b.key),
    );

  const unplaced: UnplacedGroup[] = [];
  for (const group of ordered) {
    const need = group.guests.length;
    let chosen = -1;

    // Prefer the table that already holds the rest of this invitation, most of them first.
    const mates = seatedAt.get(group.key);
    if (mates) {
      let best = 0;
      for (const [index, n] of [...mates.entries()].sort((a, b) => a[0] - b[0])) {
        if (open[index]! >= need && n > best) {
          best = n;
          chosen = index;
        }
      }
    }
    if (chosen === -1) {
      let tightest = Infinity;
      open.forEach((room, index) => {
        if (room >= need && room - need < tightest) {
          tightest = room - need;
          chosen = index;
        }
      });
    }

    if (chosen === -1) {
      const largestOpen = open.reduce((m, n) => Math.max(m, n), 0);
      unplaced.push({
        ...group,
        reason: largestOpen === 0 ? "no-room" : "too-large",
        needed: need,
        largestOpen,
      });
      continue;
    }
    open[chosen] = open[chosen]! - need;
    added[chosen]!.push(group);
  }

  const tables: SuggestedTable[] = [];
  plan.tables.forEach((t, index) => {
    const groupsHere = added[index]!;
    if (groupsHere.length === 0) return;
    const count = groupsHere.reduce((n, g) => n + g.guests.length, 0);
    tables.push({
      tableId: t.id,
      tableLabel: t.label,
      capacity: t.capacity,
      usedBefore: t.used,
      usedAfter: t.used + count,
      groups: groupsHere,
    });
  });

  const placed = tables.flatMap((t) => t.groups.flatMap((g) => g.guests));
  return {
    tables,
    unplaced,
    placedCount: placed.length,
    unplacedCount: unplaced.reduce((n, g) => n + g.guests.length, 0),
    tentativeCount: placed.filter((g) => g.tentative).length,
  };
}

/** What the apply action sends: tables and the guests to put at each. Nothing else. */
export type SuggestionPlacement = { tableId: string; guestIds: string[] };

export function toPlacements(suggestion: SeatingSuggestion): SuggestionPlacement[] {
  return suggestion.tables.map((t) => ({
    tableId: t.tableId,
    guestIds: t.groups.flatMap((g) => g.guests.map((x) => x.id)),
  }));
}
