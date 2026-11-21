import { describe, expect, it } from "vitest";
import { parseDateOnly } from "@/domain/dates/date-only";
import { summarizeBudget } from "@/domain/budget/summary";
import { parseBookingInput, parsePaymentInput, refundableMinor } from "./input";
import { reconcileSchedule, scheduleWarning } from "./schedule";

const d = parseDateOnly;
const items = new Set(["item-a", "item-b"]);
const booking = (over: Record<string, string> = {}) => ({
  title: "Venue contract",
  amount: "10,000",
  confirm: "yes",
  allocItem0: "item-a",
  allocAmount0: "10000",
  ...over,
});

describe("parseBookingInput", () => {
  it("parses a balanced booking with a schedule into minor units", () => {
    const r = parseBookingInput(
      booking({
        dueOn0: "2027-01-15",
        instAmount0: "2,500",
        dueOn1: "2027-05-08",
        instAmount1: "7500",
        instLabel1: " Final ",
      }),
      "USD",
      items,
    );
    expect(r).toEqual({
      ok: true,
      value: {
        title: "Venue contract",
        amountMinor: 1_000_000,
        signedOn: null,
        allocations: [{ itemId: "item-a", amountMinor: 1_000_000 }],
        installments: [
          { dueOn: "2027-01-15", amountMinor: 250_000, label: null },
          { dueOn: "2027-05-08", amountMinor: 750_000, label: "Final" },
        ],
        confirmed: true,
      },
    });
  });

  it("requires explicit confirmation", () => {
    const r = parseBookingInput(booking({ confirm: "" }), "USD", items);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.confirm).toBeDefined();
  });

  it("refuses allocations that do not add up, instead of guessing", () => {
    const r = parseBookingInput(booking({ allocAmount0: "9000" }), "USD", items);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.allocAmount0).toMatch(/add up/);
  });

  it("accepts a split across two costs and rejects duplicates and unknown costs", () => {
    const split = parseBookingInput(
      booking({ allocAmount0: "6000", allocItem1: "item-b", allocAmount1: "4000" }),
      "USD",
      items,
    );
    expect(split.ok).toBe(true);
    const dup = parseBookingInput(
      booking({ allocAmount0: "6000", allocItem1: "item-a", allocAmount1: "4000" }),
      "USD",
      items,
    );
    expect(dup.ok).toBe(false);
    const foreign = parseBookingInput(booking({ allocItem0: "other" }), "USD", items);
    expect(foreign.ok).toBe(false);
  });

  it("rejects missing or non-positive amounts, bad dates and incomplete schedule rows", () => {
    for (const over of [
      { amount: "" },
      { amount: "0" },
      { amount: "12.345" },
      { signedOn: "2027-02-30" },
      { dueOn0: "2027-01-15" },
      { instAmount0: "100" },
      { dueOn0: "nope", instAmount0: "100" },
      { title: "  " },
    ]) {
      expect(parseBookingInput(booking(over), "USD", items).ok, JSON.stringify(over)).toBe(false);
    }
  });
});

describe("parsePaymentInput", () => {
  const today = "2027-03-01";
  it("parses a payment and defaults to a charge", () => {
    expect(parsePaymentInput({ amount: "2,500", paidOn: "2027-03-01" }, "USD", today)).toEqual({
      ok: true,
      value: {
        kind: "charge",
        amountMinor: 250_000,
        paidOn: "2027-03-01",
        method: null,
        note: null,
        externalRef: null,
      },
    });
  });
  it("rejects future dates, zero and bad kinds", () => {
    expect(parsePaymentInput({ amount: "10", paidOn: "2027-03-02" }, "USD", today).ok).toBe(false);
    expect(parsePaymentInput({ amount: "0", paidOn: today }, "USD", today).ok).toBe(false);
    expect(parsePaymentInput({ amount: "10", paidOn: today, kind: "gift" }, "USD", today).ok).toBe(
      false,
    );
    expect(parsePaymentInput({ amount: "10", paidOn: "2027-02-30" }, "USD", today).ok).toBe(false);
  });
  it("never lets refundable go negative", () => {
    expect(refundableMinor(-5)).toBe(0);
    expect(refundableMinor(200_000)).toBe(200_000);
  });
});

describe("reconcileSchedule", () => {
  const inst = (id: string, dueOn: string, amountMinor: number) => ({
    id,
    dueOn: d(dueOn),
    amountMinor,
    label: null,
  });
  it("matches payments to the oldest installment first by running total", () => {
    const s = reconcileSchedule(
      1_000_000,
      [inst("b", "2027-05-08", 750_000), inst("a", "2027-01-15", 250_000)],
      200_000,
      d("2027-01-01"),
    );
    expect(s.state).toBe("matches");
    expect(s.rows.map((r) => [r.id, r.status, r.coveredMinor])).toEqual([
      ["a", "partly_covered", 200_000],
      ["b", "upcoming", 0],
    ]);
  });
  it("flags overdue for the uncovered part only", () => {
    const s = reconcileSchedule(
      1_000_000,
      [inst("a", "2027-01-15", 250_000), inst("b", "2027-02-01", 750_000)],
      200_000,
      d("2027-03-01"),
    );
    expect(s.rows.map((r) => r.status)).toEqual(["overdue", "overdue"]);
    expect(s.overdueMinor).toBe(800_000);
  });
  it("marks covered rows and flags a schedule that is under, over or missing", () => {
    const covered = reconcileSchedule(
      500_000,
      [inst("a", "2027-01-15", 500_000)],
      500_000,
      d("2027-03-01"),
    );
    expect(covered.rows[0]?.status).toBe("covered");
    expect(covered.overdueMinor).toBe(0);
    const under = reconcileSchedule(
      1_000_000,
      [inst("a", "2027-01-15", 250_000)],
      0,
      d("2027-01-01"),
    );
    expect(under.state).toBe("under");
    expect(under.unscheduledMinor).toBe(750_000);
    const over = reconcileSchedule(100_000, [inst("a", "2027-01-15", 150_000)], 0, d("2027-01-01"));
    expect(over.state).toBe("over");
    const none = reconcileSchedule(100_000, [], 0, d("2027-01-01"));
    expect(none.state).toBe("none");
    expect(scheduleWarning(none.state, none.unscheduledMinor, String)).toMatch(
      /No payment schedule/,
    );
    expect(scheduleWarning("matches", 0, String)).toBeNull();
  });
  it("does not count a scheduled installment as paid", () => {
    const s = reconcileSchedule(100_000, [inst("a", "2027-01-15", 100_000)], 0, d("2027-03-01"));
    expect(s.rows[0]?.coveredMinor).toBe(0);
    expect(s.rows[0]?.status).toBe("overdue");
  });
});

describe("T03/T04 through the budget summary", () => {
  const base = {
    targetMinor: 2_000_000,
    reserveBp: null,
    guestCount: 100,
    categories: [{ id: "c", name: "Venue", allocationMinor: null }],
    items: [
      {
        id: "item-a",
        categoryId: "c",
        name: "Venue",
        costMode: "fixed" as const,
        amountMinor: 900_000,
        quantity: null,
        minQty: null,
      },
    ],
  };
  it("T03: a selected quote alone commits nothing", () => {
    const s = summarizeBudget(base);
    expect(s.committedMinor).toBe(0);
    expect(s.forecastMinor).toBe(900_000);
  });
  it("T04: book $10k, pay $2.5k, refund $500: net $2k, owed $8k, counted once", () => {
    const s = summarizeBudget({
      ...base,
      commitments: [{ id: "k", amountMinor: 1_000_000, status: "active" }],
      allocations: [{ commitmentId: "k", budgetItemId: "item-a", amountMinor: 1_000_000 }],
      payments: [
        { id: "p1", commitmentId: "k", budgetItemId: null, kind: "charge", amountMinor: 250_000 },
        { id: "p2", commitmentId: "k", budgetItemId: null, kind: "refund", amountMinor: 50_000 },
      ],
    });
    expect(s.committedMinor).toBe(1_000_000);
    expect(s.netPaidMinor).toBe(200_000);
    expect(s.outstandingMinor).toBe(800_000);
    expect(s.forecastMinor).toBe(1_000_000);
  });
  it("an amendment replaces the old amount instead of adding to it", () => {
    const s = summarizeBudget({
      ...base,
      commitments: [
        { id: "k2", amountMinor: 1_200_000, status: "active" },
        { id: "k", amountMinor: 1_000_000, status: "superseded" },
      ],
      allocations: [
        { commitmentId: "k2", budgetItemId: "item-a", amountMinor: 1_200_000 },
        { commitmentId: "k", budgetItemId: "item-a", amountMinor: 1_000_000 },
      ],
      payments: [
        { id: "p1", commitmentId: "k2", budgetItemId: null, kind: "charge", amountMinor: 250_000 },
      ],
    });
    expect(s.committedMinor).toBe(1_200_000);
    expect(s.forecastMinor).toBe(1_200_000);
    expect(s.outstandingMinor).toBe(950_000);
  });
});

describe("single allocation shortcut", () => {
  it("covers the whole booking when only one cost is chosen and its amount is blank", () => {
    const r = parseBookingInput(booking({ allocAmount0: "" }), "USD", items);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.allocations).toEqual([{ itemId: "item-a", amountMinor: 1_000_000 }]);
  });
  it("still needs explicit amounts when two costs are chosen", () => {
    const r = parseBookingInput(
      booking({ allocAmount0: "", allocItem1: "item-b", allocAmount1: "4000" }),
      "USD",
      items,
    );
    expect(r.ok).toBe(false);
  });
});
