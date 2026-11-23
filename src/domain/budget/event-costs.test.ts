import { describe, expect, it } from "vitest";
import { eventCostItems } from "./event-costs";
import type { BudgetItem } from "./summary";

const item = (over: Partial<BudgetItem> & Pick<BudgetItem, "id">): BudgetItem => ({
  categoryId: "c",
  name: over.id,
  costMode: "per_guest",
  amountMinor: 9_500,
  quantity: null,
  minQty: null,
  ...over,
});

describe("eventCostItems", () => {
  const items = [
    item({ id: "plan", countSource: "event_plan", countEventId: "rec" }),
    item({ id: "yes", countSource: "event_yes", countEventId: "rec" }),
    item({ id: "other-event", countSource: "event_plan", countEventId: "brunch" }),
    item({ id: "target", countSource: "guest_target" }),
    item({ id: "default-target" }),
    item({ id: "typed", countSource: "typed", countTyped: 80 }),
    item({ id: "fixed", costMode: "fixed", countSource: "event_plan", countEventId: "rec" }),
    item({ id: "no-event", countSource: "event_plan", countEventId: null }),
  ];

  it("keeps per-guest costs counted from this event, in order", () => {
    expect(eventCostItems(items, "rec").map((i) => i.id)).toEqual(["plan", "yes"]);
  });

  it("lists nothing for an event no cost counts", () => {
    expect(eventCostItems(items, "ceremony")).toEqual([]);
    expect(eventCostItems([], "rec")).toEqual([]);
  });

  it("never lists a cost counted from the guest target, a typed number or no event", () => {
    const ids = eventCostItems(items, "rec").map((i) => i.id);
    for (const not of ["target", "default-target", "typed", "fixed", "no-event", "other-event"]) {
      expect(ids).not.toContain(not);
    }
  });
});
