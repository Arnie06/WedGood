/**
 * The caterer count card's source-of-truth breakdown (UX-14, wireframe W8). Pure.
 *
 * Finds the bookings that belong to one event's catering, so the card can set the locked count beside
 * what was signed, invoiced and paid. Nothing here changes a count, a booking or a payment.
 *
 * A booking belongs to the event's catering when it is active and either
 *   - is with the caterer chosen on the locked count, or
 *   - covers a per-guest cost whose count follows this event's guests (the UX-10 event costs).
 * The guest minimum is the largest minimum entered on a per-guest cost of this event that the booking
 * covers. It is what the couple typed on the budget, so the card names that cost as its source.
 */
import { eventCostItems } from "@/domain/budget/event-costs";
import type { BudgetItem } from "@/domain/budget/summary";

export type CateringCommitment = {
  id: string;
  candidateId: string | null;
  status: "active" | "superseded" | "cancelled";
};

export type CateringAllocation = { commitmentId: string; budgetItemId: string; active: boolean };

export type CateringMinimum = { count: number; itemName: string };

export type CateringBooking = {
  commitmentId: string;
  /** True when this is a booking with the caterer chosen on the locked count. */
  withCaterer: boolean;
  /** The largest guest minimum among this event's per-guest costs it covers, or null. */
  minimum: CateringMinimum | null;
};

export function cateringBookings(input: {
  eventId: string;
  /** The caterer chosen on the locked count, or null. */
  catererId: string | null;
  items: readonly BudgetItem[];
  commitments: readonly CateringCommitment[];
  allocations: readonly CateringAllocation[];
}): CateringBooking[] {
  const eventItems = new Map(eventCostItems(input.items, input.eventId).map((i) => [i.id, i]));
  const coveredBy = new Map<string, BudgetItem[]>();
  for (const a of input.allocations) {
    const item = a.active ? eventItems.get(a.budgetItemId) : undefined;
    if (!item) continue;
    const list = coveredBy.get(a.commitmentId);
    if (list) list.push(item);
    else coveredBy.set(a.commitmentId, [item]);
  }
  const rows: CateringBooking[] = [];
  for (const c of input.commitments) {
    if (c.status !== "active") continue;
    const withCaterer = input.catererId !== null && c.candidateId === input.catererId;
    const covered = coveredBy.get(c.id) ?? [];
    if (!withCaterer && covered.length === 0) continue;
    let minimum: CateringMinimum | null = null;
    for (const item of covered) {
      if (item.minQty === null || item.minQty <= 0) continue;
      if (minimum === null || item.minQty > minimum.count) {
        minimum = { count: item.minQty, itemName: item.name };
      }
    }
    rows.push({ commitmentId: c.id, withCaterer, minimum });
  }
  // The chosen caterer's bookings first; otherwise the order given.
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => Number(b.r.withCaterer) - Number(a.r.withCaterer) || a.i - b.i)
    .map(({ r }) => r);
}

/**
 * Calm sentences when a guest minimum matters: the locked count, or (with none locked) today's
 * attending count, is below what a booking says it will charge for at least. Null when nothing to say.
 */
export function minimumNote(
  minimum: CateringMinimum | null,
  locked: number | null,
  yes: number,
): string | null {
  if (minimum === null) return null;
  const m = minimum.count;
  if (locked !== null) {
    return locked < m
      ? `The locked count is ${m - locked} below the minimum of ${m}. The booking may still charge for ${m}.`
      : null;
  }
  return yes < m
    ? `${yes} attending so far, below the minimum of ${m}. The booking may still charge for ${m}.`
    : null;
}
