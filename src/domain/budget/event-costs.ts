import { isReplyBased, type BudgetItem } from "./summary";

/**
 * The costs an event's guests set the price of (UX-10): per-guest items whose count follows this
 * event's replies or planning number. A fixed cost, a typed number or the wedding's guest target
 * belongs to no one event, so it is not listed here. Pure; order is the order given.
 */
export function eventCostItems(items: readonly BudgetItem[], eventId: string): BudgetItem[] {
  return items.filter(
    (i) => i.costMode === "per_guest" && isReplyBased(i.countSource) && i.countEventId === eventId,
  );
}
