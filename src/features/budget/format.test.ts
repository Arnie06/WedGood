import { describe, expect, it } from "vitest";
import { summarizeBudget, type BudgetItem, type ItemCounts } from "@/domain/budget/summary";
import {
  itemAmountLabel,
  itemBasisLabel,
  itemDriftNote,
  itemTrackingNote,
  type CountContext,
} from "./format";

const item = (over: Partial<BudgetItem> = {}): BudgetItem => ({
  id: "a",
  categoryId: "c",
  name: "Dinner",
  costMode: "per_guest",
  amountMinor: 9_500,
  quantity: null,
  minQty: null,
  countSource: "event_plan",
  countEventId: "e",
  ...over,
});
const figureOf = (
  i: BudgetItem,
  count: number | null,
  commitment?: number,
): ReturnType<typeof summarizeBudget>["items"][number] => {
  const s = summarizeBudget({
    targetMinor: null,
    reserveBp: null,
    guestCount: 100,
    eventCounts: new Map([[i.id, { count, plan: null, actual: count, final: false }]]),
    categories: [{ id: "c", name: "c", allocationMinor: null }],
    items: [i],
    ...(commitment !== undefined && {
      commitments: [{ id: "k", amountMinor: commitment, status: "active" as const }],
      allocations: [{ commitmentId: "k", budgetItemId: i.id, amountMinor: commitment }],
    }),
  });
  return s.items[0]!;
};
const ctx = (showCounts: boolean): CountContext => ({
  guestTarget: 100,
  currency: "USD",
  eventNames: new Map([["e", "Reception"]]),
  showCounts,
});

describe("budget labels for reply-based costs (ADR-031 D2)", () => {
  it("spell out the arithmetic for those who may see counts", () => {
    const i = item();
    expect(itemBasisLabel(i, figureOf(i, 132), ctx(true))).toBe(
      "$95.00 × 132 guests · Reception planning number",
    );
  });

  it("show no count, no minimum and no arithmetic to those who may not", () => {
    const i = item({ minQty: 150 });
    const label = itemBasisLabel(i, figureOf(i, 132), ctx(false));
    expect(label).toBe("$95.00 per guest, based on replies to Reception");
    expect(label).not.toMatch(/132|150|×|minimum/);
  });

  it("an event with nobody invited says so instead of showing zero", () => {
    const i = item();
    const f = figureOf(i, null);
    expect(itemAmountLabel(i, f, "USD")).toBe("No one invited yet");
    expect(itemBasisLabel(i, f, ctx(true))).toContain("nobody is invited to Reception yet");
  });

  it("guest-target and typed items keep their wording for everyone", () => {
    const t = item({ countSource: "guest_target", countEventId: null });
    expect(itemBasisLabel(t, figureOf(t, null), ctx(false))).toBe("$95.00 × 100 guests");
    const y = item({ countSource: "typed", countEventId: null, countTyped: 80 });
    expect(itemBasisLabel(y, figureOf(y, null), ctx(false))).toBe("$95.00 × 80 guests · typed");
  });
});

describe("drift note on a booked reply-based cost", () => {
  it("tells owner and partner how far replies have moved, and that the booking stays", () => {
    const i = item();
    const note = itemDriftNote(i, figureOf(i, 150, 1_100_000), ctx(true));
    expect(note).toBe(
      "Booked for $11,000.00, which stays as booked. At today's Reception replies of 150 guests it would be $14,250.00.",
    );
  });

  it("says nothing when the booking still matches replies", () => {
    const i = item();
    expect(itemDriftNote(i, figureOf(i, 100, 950_000), ctx(true))).toBeNull();
  });

  it("gives everyone else a note that reveals no number", () => {
    const i = item();
    const note = itemDriftNote(i, figureOf(i, 150, 1_100_000), ctx(false));
    expect(note).toBe("Booked amount is fixed; later replies don't change it.");
  });

  it("is absent for unbooked and non-reply items", () => {
    const i = item();
    expect(itemDriftNote(i, figureOf(i, 150), ctx(true))).toBeNull();
    const g = item({ countSource: "guest_target", countEventId: null });
    expect(itemDriftNote(g, figureOf(g, null, 1_100_000), ctx(true))).toBeNull();
  });
});

describe("plan and replies on a reply-based cost", () => {
  const figureWith = (i: BudgetItem, counts: ItemCounts) =>
    summarizeBudget({
      targetMinor: null,
      reserveBp: null,
      guestCount: null,
      eventCounts: new Map([[i.id, counts]]),
      categories: [{ id: "c", name: "c", allocationMinor: null }],
      items: [i],
    }).items[0]!;
  const i = item();

  it("prices at the plan while replies are below it, and shows the gap to owner and partner", () => {
    const f = figureWith(i, { count: 120, plan: 120, actual: 45, final: false });
    expect(f).toMatchObject({ count: 120, planCount: 120, actualCount: 45 });
    expect(itemBasisLabel(i, f, ctx(true))).toBe("$95.00 × 120 guests · Reception plan");
    expect(itemTrackingNote(i, f, ctx(true))).toBe(
      "Plan: 120 guests, $11,400.00. So far: 45 guests, 75 below plan (−$7,125.00).",
    );
  });

  it("follows replies above the plan", () => {
    const f = figureWith(i, { count: 132, plan: 120, actual: 132, final: false });
    expect(itemBasisLabel(i, f, ctx(true))).toBe("$95.00 × 132 guests · Reception planning number");
    expect(itemTrackingNote(i, f, ctx(true))).toBe(
      "Plan: 120 guests, $11,400.00. So far: 132 guests, 12 above plan (+$1,140.00).",
    );
  });

  it("once invitations are complete, replies below the plan lower the cost and the plan stays", () => {
    const f = figureWith(i, { count: 90, plan: 120, actual: 90, final: true });
    expect(f).toMatchObject({ count: 90, planCount: 120, planMinor: 1_140_000 });
    expect(itemTrackingNote(i, f, ctx(true))).toBe(
      "Plan: 120 guests, $11,400.00. Replies: 90 guests, 30 below plan (−$2,850.00).",
    );
  });

  it("says on plan when they match, and that nobody is invited yet", () => {
    expect(
      itemTrackingNote(
        i,
        figureWith(i, { count: 120, plan: 120, actual: 120, final: false }),
        ctx(true),
      ),
    ).toBe("Plan: 120 guests, $11,400.00. So far: right on plan.");
    expect(
      itemTrackingNote(
        i,
        figureWith(i, { count: 120, plan: 120, actual: null, final: false }),
        ctx(true),
      ),
    ).toBe("Plan: 120 guests, $11,400.00. No one invited yet.");
  });

  it("shows members without totals access the plan, never the replies", () => {
    const f = figureWith(i, { count: 132, plan: 120, actual: null, final: false });
    const note = itemTrackingNote(i, f, ctx(false));
    expect(note).toBe("Plan: 120 guests, $11,400.00.");
    expect(itemBasisLabel(i, f, ctx(false))).toBe(
      "$95.00 per guest, planned for 120 guests and tracked against replies to Reception",
    );
    expect(itemBasisLabel(i, f, ctx(false))).not.toMatch(/132/);
  });

  it("asks for a plan when there is none, and is absent for other cost kinds", () => {
    const f = figureWith(i, { count: 40, plan: null, actual: 40, final: false });
    expect(itemTrackingNote(i, f, ctx(true))).toMatch(
      /^No plan yet\. Set planned attendance on Reception/,
    );
    const g = item({ countSource: "guest_target", countEventId: null });
    expect(itemTrackingNote(g, figureOf(g, null), ctx(true))).toBeNull();
  });
});
