import { describe, expect, it } from "vitest";
import type { BudgetItem } from "@/domain/budget/summary";
import { cateringBookings, minimumNote, type CateringCommitment } from "./catering";

const E = "event-reception";
const OTHER = "event-ceremony";

function item(id: string, over: Partial<BudgetItem> = {}): BudgetItem {
  return {
    id,
    categoryId: "cat",
    name: `Cost ${id}`,
    costMode: "per_guest",
    amountMinor: 9_500,
    quantity: null,
    minQty: null,
    countSource: "event_yes",
    countEventId: E,
    ...over,
  };
}
const booking = (id: string, over: Partial<CateringCommitment> = {}): CateringCommitment => ({
  id,
  candidateId: null,
  status: "active",
  ...over,
});
const alloc = (commitmentId: string, budgetItemId: string, active = true) => ({
  commitmentId,
  budgetItemId,
  active,
});

describe("cateringBookings", () => {
  it("finds a booking covering a per-guest cost of this event, with its minimum", () => {
    const rows = cateringBookings({
      eventId: E,
      catererId: null,
      items: [item("dinner", { minQty: 80, name: "Dinner" })],
      commitments: [booking("b1")],
      allocations: [alloc("b1", "dinner")],
    });
    expect(rows).toEqual([
      { commitmentId: "b1", withCaterer: false, minimum: { count: 80, itemName: "Dinner" } },
    ]);
  });

  it("finds the chosen caterer's booking even when it covers no cost of this event", () => {
    const rows = cateringBookings({
      eventId: E,
      catererId: "cand-1",
      items: [
        item("venue", { costMode: "fixed", countSource: "guest_target", countEventId: null }),
      ],
      commitments: [booking("b1", { candidateId: "cand-1" })],
      allocations: [alloc("b1", "venue")],
    });
    expect(rows).toEqual([{ commitmentId: "b1", withCaterer: true, minimum: null }]);
  });

  it("leaves out other events' costs, fixed and typed costs, and the guest target", () => {
    const rows = cateringBookings({
      eventId: E,
      catererId: null,
      items: [
        item("other", { countEventId: OTHER, minQty: 50 }),
        item("fixed", { costMode: "fixed", minQty: 50 }),
        item("typed", { countSource: "typed", countEventId: null, minQty: 50 }),
        item("target", { countSource: "guest_target", countEventId: null, minQty: 50 }),
      ],
      commitments: [booking("b1"), booking("b2"), booking("b3"), booking("b4")],
      allocations: [
        alloc("b1", "other"),
        alloc("b2", "fixed"),
        alloc("b3", "typed"),
        alloc("b4", "target"),
      ],
    });
    expect(rows).toEqual([]);
  });

  it("ignores inactive allocations and bookings that are superseded or cancelled", () => {
    const rows = cateringBookings({
      eventId: E,
      catererId: "cand-1",
      items: [item("dinner")],
      commitments: [
        booking("old", { status: "superseded", candidateId: "cand-1" }),
        booking("gone", { status: "cancelled" }),
        booking("loose"),
      ],
      allocations: [
        alloc("old", "dinner"),
        alloc("gone", "dinner"),
        alloc("loose", "dinner", false),
      ],
    });
    expect(rows).toEqual([]);
  });

  it("takes the largest minimum, ignores zero, and puts the caterer's booking first", () => {
    const rows = cateringBookings({
      eventId: E,
      catererId: "cand-1",
      items: [
        item("dinner", { minQty: 80, name: "Dinner" }),
        item("bar", { minQty: 100, name: "Bar" }),
        item("cake", { minQty: 0 }),
      ],
      commitments: [booking("bar-co"), booking("caterer", { candidateId: "cand-1" })],
      allocations: [alloc("bar-co", "cake"), alloc("caterer", "dinner"), alloc("caterer", "bar")],
    });
    expect(rows).toEqual([
      { commitmentId: "caterer", withCaterer: true, minimum: { count: 100, itemName: "Bar" } },
      { commitmentId: "bar-co", withCaterer: false, minimum: null },
    ]);
  });

  it("with no caterer chosen, a booking with a vendor is not matched by vendor", () => {
    const rows = cateringBookings({
      eventId: E,
      catererId: null,
      items: [],
      commitments: [booking("b1", { candidateId: "cand-1" })],
      allocations: [],
    });
    expect(rows).toEqual([]);
  });
});

describe("minimumNote", () => {
  const min = { count: 80, itemName: "Dinner" };
  it("says nothing without a minimum", () => {
    expect(minimumNote(null, 10, 5)).toBeNull();
  });
  it("speaks about the locked count when one is locked", () => {
    expect(minimumNote(min, 76, 90)).toBe(
      "The locked count is 4 below the minimum of 80. The booking may still charge for 80.",
    );
    expect(minimumNote(min, 80, 10)).toBeNull();
  });
  it("speaks about attending when nothing is locked", () => {
    expect(minimumNote(min, null, 60)).toBe(
      "60 attending so far, below the minimum of 80. The booking may still charge for 80.",
    );
    expect(minimumNote(min, null, 80)).toBeNull();
  });
});
