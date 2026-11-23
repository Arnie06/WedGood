import { describe, expect, it } from "vitest";
import {
  estimateItem,
  type ItemCounts,
  percentOfBp,
  summarizeBudget,
  type BudgetCategory,
  type BudgetInput,
  type BudgetItem,
} from "./summary";

const cat = (id: string, allocationMinor: number | null = null): BudgetCategory => ({
  id,
  name: id,
  allocationMinor,
});
const item = (over: Partial<BudgetItem> & Pick<BudgetItem, "id">): BudgetItem => ({
  categoryId: "c",
  name: over.id,
  costMode: "fixed",
  amountMinor: null,
  quantity: null,
  minQty: null,
  ...over,
});

// docs/07 demo: catering $95/guest (minimum 120), bar $30/guest, fixed venue $10k and other $10k.
const demo = (guestCount: number | null): BudgetInput => ({
  targetMinor: 5_000_000,
  reserveBp: 1000,
  guestCount,
  categories: [cat("c")],
  items: [
    item({ id: "catering", costMode: "per_guest", amountMinor: 9_500, minQty: 120 }),
    item({ id: "bar", costMode: "per_guest", amountMinor: 3_000 }),
    item({ id: "venue", amountMinor: 1_000_000 }),
    item({ id: "other", amountMinor: 1_000_000 }),
  ],
});

describe("T01 per-guest, fixed and reserve", () => {
  it("120 guests: $35,000 plus 10% reserve is $38,500", () => {
    const s = summarizeBudget(demo(120));
    expect(s.subtotalMinor).toBe(3_500_000);
    expect(s.reserveMinor).toBe(350_000);
    expect(s.forecastMinor).toBe(3_850_000);
    expect(s.incomplete).toBe(false);
  });

  it("140 guests: only the estimates move, $37,500 plus $3,750 is $41,250", () => {
    const s = summarizeBudget(demo(140));
    expect(s.subtotalMinor).toBe(3_750_000);
    expect(s.reserveMinor).toBe(375_000);
    expect(s.forecastMinor).toBe(4_125_000);
  });
});

describe("T02 minimum applies below the minimum", () => {
  it("100 guests: catering stays at the 120 minimum, $34,400 before reserve", () => {
    const s = summarizeBudget({ ...demo(100), reserveBp: null });
    expect(s.subtotalMinor).toBe(3_440_000);
    expect(s.reserveMinor).toBe(0);
    expect(s.forecastMinor).toBe(3_440_000);
  });
});

describe("T03 a quote is not a commitment", () => {
  it("has no commitment, payment or outstanding balance without a booking", () => {
    const s = summarizeBudget(demo(120));
    expect(s.committedMinor).toBe(0);
    expect(s.netPaidMinor).toBe(0);
    expect(s.outstandingMinor).toBe(0);
  });
});

describe("T04 commitment and payments are not double counted", () => {
  const input: BudgetInput = {
    targetMinor: 5_000_000,
    reserveBp: null,
    guestCount: 100,
    categories: [cat("c")],
    items: [
      item({ id: "venue", amountMinor: 900_000 }),
      item({ id: "flowers", amountMinor: 200_000 }),
    ],
    commitments: [{ id: "k1", amountMinor: 1_000_000, status: "active" }],
    allocations: [{ commitmentId: "k1", budgetItemId: "venue", amountMinor: 1_000_000 }],
    payments: [
      { id: "p1", commitmentId: "k1", budgetItemId: null, kind: "charge", amountMinor: 250_000 },
      { id: "p2", commitmentId: "k1", budgetItemId: null, kind: "refund", amountMinor: 50_000 },
    ],
  };

  it("$10k booked, $2.5k paid, $500 refunded: net paid $2k, owed $8k", () => {
    const s = summarizeBudget(input);
    expect(s.committedMinor).toBe(1_000_000);
    expect(s.netPaidMinor).toBe(200_000);
    expect(s.outstandingMinor).toBe(800_000);
  });

  it("counts the covered item once, as the commitment, not as its $9k estimate too", () => {
    const s = summarizeBudget(input);
    expect(s.uncommittedMinor).toBe(200_000);
    expect(s.subtotalMinor).toBe(1_200_000);
    expect(s.forecastMinor).toBe(1_200_000);
    expect(s.categories[0]?.committedMinor).toBe(1_000_000);
  });

  it("ignores a superseded commitment", () => {
    const s = summarizeBudget({
      ...input,
      commitments: [{ id: "k1", amountMinor: 1_000_000, status: "superseded" }],
      payments: [],
    });
    expect(s.committedMinor).toBe(0);
    expect(s.uncommittedMinor).toBe(1_100_000);
  });

  it("flags an overpayment instead of hiding it", () => {
    const s = summarizeBudget({
      ...input,
      payments: [
        {
          id: "p1",
          commitmentId: "k1",
          budgetItemId: null,
          kind: "charge",
          amountMinor: 1_100_000,
        },
      ],
    });
    expect(s.overpaidMinor).toBe(100_000);
    expect(s.outstandingMinor).toBe(0);
  });

  it("raises an uncommitted item to what was already paid for it", () => {
    const s = summarizeBudget({
      ...input,
      commitments: [],
      allocations: [],
      payments: [
        {
          id: "p1",
          commitmentId: null,
          budgetItemId: "flowers",
          kind: "charge",
          amountMinor: 250_000,
        },
      ],
    });
    expect(s.netPaidMinor).toBe(250_000);
    expect(s.categories[0]?.expectedMinor).toBe(900_000 + 250_000);
  });

  it("rejects a payment on an item a commitment covers, and refunds beyond payments", () => {
    expect(() =>
      summarizeBudget({
        ...input,
        payments: [
          { id: "p9", commitmentId: null, budgetItemId: "venue", kind: "charge", amountMinor: 1 },
        ],
      }),
    ).toThrow(RangeError);
    expect(() =>
      summarizeBudget({
        ...input,
        commitments: [],
        allocations: [],
        payments: [
          { id: "p9", commitmentId: null, budgetItemId: "flowers", kind: "refund", amountMinor: 1 },
        ],
      }),
    ).toThrow(RangeError);
  });
});

describe("T05 unknown amounts", () => {
  const input: BudgetInput = {
    targetMinor: null,
    reserveBp: 1000,
    guestCount: 100,
    categories: [cat("c")],
    items: [item({ id: "known", amountMinor: 800_000 }), item({ id: "mystery" })],
  };

  it("keeps the known $8k subtotal, flags incomplete, and does not substitute zero silently", () => {
    const s = summarizeBudget(input);
    expect(s.subtotalMinor).toBe(800_000);
    expect(s.incomplete).toBe(true);
    expect(s.unknownItemCount).toBe(1);
    expect(s.categories[0]?.unknownItemCount).toBe(1);
  });

  it("treats per-guest with no guest count as unknown, not zero", () => {
    const e = estimateItem(item({ id: "x", costMode: "per_guest", amountMinor: 9_500 }), null);
    expect(e).toEqual({ state: "unknown", reason: "no_guest_count" });
    const q = estimateItem(item({ id: "y", costMode: "quantity", amountMinor: 5_000 }), 10);
    expect(q).toEqual({ state: "unknown", reason: "no_quantity" });
  });
});

describe("target, allocation and remaining", () => {
  it("null target gives null target-based figures but still sums the plan", () => {
    const s = summarizeBudget({ ...demo(120), targetMinor: null });
    expect(s.headroomMinor).toBeNull();
    expect(s.remainingUncommittedMinor).toBeNull();
    expect(s.unallocatedMinor).toBeNull();
    expect(s.allocationExceedsTarget).toBe(false);
    expect(s.forecastMinor).toBe(3_850_000);
  });

  it("an explicit zero target is a real target, not unset", () => {
    const s = summarizeBudget({ ...demo(120), targetMinor: 0 });
    expect(s.headroomMinor).toBe(-3_850_000);
  });

  it("headroom is target minus forecast; remaining ignores estimates and reserve", () => {
    const s = summarizeBudget({
      targetMinor: 5_000_000,
      reserveBp: 1000,
      guestCount: null,
      categories: [cat("c")],
      items: [item({ id: "a", amountMinor: 1_000_000 }), item({ id: "b", amountMinor: 500_000 })],
      commitments: [{ id: "k", amountMinor: 700_000, status: "active" }],
      allocations: [{ commitmentId: "k", budgetItemId: "a", amountMinor: 700_000 }],
    });
    expect(s.forecastMinor).toBe(1_320_000); // (700k + 500k) + 10% reserve
    expect(s.headroomMinor).toBe(3_680_000);
    expect(s.remainingUncommittedMinor).toBe(4_300_000);
  });

  it("warns when category targets exceed the target, without blocking", () => {
    const s = summarizeBudget({
      ...demo(120),
      targetMinor: 1_000_000,
      categories: [cat("c", 800_000), cat("d", 400_000)],
    });
    expect(s.allocatedMinor).toBe(1_200_000);
    expect(s.unallocatedMinor).toBe(-200_000);
    expect(s.allocationExceedsTarget).toBe(true);
  });

  it("reports a category over its own target by the known forecast", () => {
    const s = summarizeBudget({ ...demo(120), categories: [cat("c", 3_000_000)] });
    expect(s.categories[0]?.overAllocationMinor).toBe(500_000);
  });

  it("rejects an item in an unknown category", () => {
    expect(() =>
      summarizeBudget({
        ...demo(120),
        items: [item({ id: "z", categoryId: "gone", amountMinor: 1 })],
      }),
    ).toThrow(RangeError);
  });
});

describe("percentOfBp", () => {
  it("rounds half up exactly and survives large values", () => {
    expect(percentOfBp(5, 1000)).toBe(1); // 0.5 -> 1
    expect(percentOfBp(4, 1000)).toBe(0); // 0.4 -> 0
    expect(percentOfBp(3_000_000_000_000_000, 10_000)).toBe(3_000_000_000_000_000);
    expect(() => percentOfBp(1, 10_001)).toThrow(RangeError);
    expect(() => percentOfBp(1, 0.5)).toThrow(RangeError);
  });
});

/** Replies only, no plan: what REL-03 first shipped. */
const replies = (n: number | null): ItemCounts => ({
  count: n,
  plan: null,
  actual: n,
  final: false,
});

describe("REL-03 count sources (ADR-031 D1)", () => {
  const perGuest = (over: Partial<BudgetItem> & Pick<BudgetItem, "id">) =>
    item({ costMode: "per_guest", amountMinor: 9_500, ...over });
  const run = (items: BudgetItem[], eventCounts: Map<string, ItemCounts>, guestCount = 100) =>
    summarizeBudget({
      targetMinor: null,
      reserveBp: null,
      guestCount,
      eventCounts,
      categories: [cat("c")],
      items,
    });

  it("an item without a source counts the guest target, as every item did before", () => {
    const s = run([perGuest({ id: "a" })], new Map());
    expect(s.forecastMinor).toBe(950_000);
    expect(s.items[0]).toMatchObject({ count: 100, committedMinor: null });
  });

  it("an event source prices by the resolved count, not the guest target", () => {
    const s = run(
      [perGuest({ id: "a", countSource: "event_plan", countEventId: "e" })],
      new Map([["a", replies(132)]]),
    );
    expect(s.forecastMinor).toBe(9_500 * 132);
    expect(s.items[0]).toMatchObject({ count: 132 });
  });

  it("a typed source prices by the typed number and ignores the target", () => {
    const s = run([perGuest({ id: "a", countSource: "typed", countTyped: 80 })], new Map());
    expect(s.forecastMinor).toBe(9_500 * 80);
  });

  it("a missing count is unknown, never zero, for every source", () => {
    const s = run(
      [
        perGuest({ id: "plan", countSource: "event_plan", countEventId: "e" }),
        perGuest({ id: "yes", countSource: "event_yes", countEventId: "e" }),
        perGuest({ id: "typed", countSource: "typed", countTyped: null }),
      ],
      new Map([
        ["plan", replies(null)],
        // "yes" is absent from the map entirely
      ]),
    );
    expect(s.unknownItemCount).toBe(3);
    expect(s.incomplete).toBe(true);
    expect(s.forecastMinor).toBe(0);
    expect(s.items.every((f) => f.estimate.state === "unknown")).toBe(true);
  });

  it("a contractual minimum still applies to a reply-based count", () => {
    const s = run(
      [perGuest({ id: "a", minQty: 120, countSource: "event_plan", countEventId: "e" })],
      new Map([["a", replies(90)]]),
    );
    expect(s.forecastMinor).toBe(9_500 * 120);
    expect(s.items[0]?.estimate).toMatchObject({ state: "known", billedQuantity: 120 });
  });

  it("a known zero is a known zero (everyone declined), not unknown", () => {
    const s = run(
      [perGuest({ id: "a", countSource: "event_yes", countEventId: "e" })],
      new Map([["a", replies(0)]]),
    );
    expect(s.incomplete).toBe(false);
    expect(s.forecastMinor).toBe(0);
  });

  it("only per-guest items read a count; fixed items ignore any source", () => {
    const s = run(
      [item({ id: "f", amountMinor: 5_000, countSource: "event_plan", countEventId: "e" })],
      new Map([["f", replies(999)]]),
    );
    expect(s.forecastMinor).toBe(5_000);
    expect(s.items[0]?.count).toBeNull();
  });

  it("a booked item keeps its commitment when replies move, and reports it as committed", () => {
    const base = {
      targetMinor: null,
      reserveBp: null,
      guestCount: 100,
      categories: [cat("c")],
      items: [perGuest({ id: "a", countSource: "event_plan", countEventId: "e" })],
      commitments: [{ id: "k", amountMinor: 1_100_000, status: "active" as const }],
      allocations: [{ commitmentId: "k", budgetItemId: "a", amountMinor: 1_100_000 }],
    };
    const before = summarizeBudget({ ...base, eventCounts: new Map([["a", replies(116)]]) });
    const after = summarizeBudget({ ...base, eventCounts: new Map([["a", replies(150)]]) });
    expect(after.forecastMinor).toBe(before.forecastMinor);
    expect(after.forecastMinor).toBe(1_100_000);
    expect(after.items[0]).toMatchObject({ committedMinor: 1_100_000, count: 150 });
    expect(after.items[0]?.estimate).toMatchObject({ amountMinor: 9_500 * 150 });
  });
});
