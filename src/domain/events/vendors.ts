// REL-07: which vendors work at which event (ADR-031 D4). The link points at the vendor, so a
// contract amendment never changes it. Pure rules only; the database enforces the same limits.

/** A link to a vendor is current, or kept but flagged: archived, or passed (declined or cancelled). */
export type VendorState = "current" | "archived" | "passed";

export type VendorFacts = { name: string; archived: boolean; stage: string };

export function vendorState(v: Pick<VendorFacts, "archived" | "stage">): VendorState {
  if (v.archived) return "archived";
  return v.stage === "declined" || v.stage === "cancelled" ? "passed" : "current";
}

/** Whether a vendor can be newly linked to an event. Same rule as the database. */
export function canLinkVendor(v: Pick<VendorFacts, "archived" | "stage">): boolean {
  return vendorState(v) === "current";
}

/** "Lens Co", "Lens Co (archived)" or "Lens Co (passed)". The word is text, not colour alone. */
export function vendorLabel(v: VendorFacts): string {
  const state = vendorState(v);
  return state === "current" ? v.name : `${v.name} (${state})`;
}

/**
 * What changed between the links shown and the links chosen, as add and remove lists. Sending a
 * difference (not the whole set) means two people changing different links do not undo each other.
 */
export function diffLinks(
  initial: readonly string[],
  selected: readonly string[],
): { add: string[]; remove: string[] } {
  const before = new Set(initial);
  const after = new Set(selected);
  return {
    add: [...after].filter((id) => !before.has(id)).sort(),
    remove: [...before].filter((id) => !after.has(id)).sort(),
  };
}

/** Vendors that work at this event first, then everyone else. Order inside each group is kept. */
export function groupForEvent<T extends { id: string }>(
  vendors: readonly T[],
  atEvent: ReadonlySet<string>,
): { atEvent: T[]; others: T[] } {
  return {
    atEvent: vendors.filter((v) => atEvent.has(v.id)),
    others: vendors.filter((v) => !atEvent.has(v.id)),
  };
}

/**
 * Agenda items per vendor, for the day-of lists. Items without a vendor are ignored. Order inside
 * each list is the order given (already by start time).
 */
export function agendaByVendor<T extends { vendorId: string | null }>(
  items: readonly T[],
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    if (!item.vendorId) continue;
    const list = out.get(item.vendorId);
    if (list) list.push(item);
    else out.set(item.vendorId, [item]);
  }
  return out;
}
