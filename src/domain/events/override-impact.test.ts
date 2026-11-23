import { describe, expect, it } from "vitest";
import { overrideImpact, type OverrideImpactInput } from "./override-impact";

const base: OverrideImpactInput = {
  from: { status: "accepted", mealOptionId: "fish" },
  to: { status: "accepted", mealOptionId: "fish" },
  yes: 96,
  yesWithoutMeal: 3,
  meals: [
    { id: "fish", name: "Fish", active: true, count: 12 },
    { id: "beef", name: "Beef", active: true, count: 4 },
  ],
  seat: { tableLabel: "Table 6", seatNumber: 4, tentative: false },
  layout: { allowTentative: false, snapshot: "current" },
  lockedCount: 96,
};
const run = (patch: Partial<OverrideImpactInput>) => overrideImpact({ ...base, ...patch });
const ids = (r: ReturnType<typeof overrideImpact>) => r.items.map((i) => i.id);
const text = (r: ReturnType<typeof overrideImpact>, id: string) =>
  r.items.find((i) => i.id === id)?.text;

describe("overrideImpact", () => {
  it("reports nothing when the chosen answer is what is saved", () => {
    expect(run({})).toEqual({ changed: false, to: base.to, items: [] });
  });

  it("treats a meal on a non-attending answer as no meal, as the database does", () => {
    const r = run({
      from: { status: "declined", mealOptionId: null },
      to: { status: "declined", mealOptionId: "fish" },
    });
    expect(r.changed).toBe(false);
    expect(r.to).toEqual({ status: "declined", mealOptionId: null });
  });

  it("lists every effect of declining a seated guest on a finalized plan", () => {
    const r = run({ to: { status: "declined", mealOptionId: null } });
    expect(ids(r)).toEqual(["seat", "plan", "attention", "attending", "caterer", "meals"]);
    expect(text(r, "seat")).toBe("Releases seat 4 at Table 6.");
    expect(r.items.find((i) => i.id === "seat")?.tone).toBe("warning");
    expect(text(r, "attending")).toBe("Attending goes from 96 to 95.");
    expect(text(r, "caterer")).toBe(
      "The caterer count stays locked at 96. Attending would be 1 guest fewer than the caterer was told (now the same as the caterer was told).",
    );
    expect(r.items.find((i) => i.id === "caterer")?.tone).toBe("info");
    expect(text(r, "meals")).toBe("Meal counts: Fish 12 → 11.");
  });

  it("names a seat without a number by its table", () => {
    const r = run({
      to: { status: "declined", mealOptionId: null },
      seat: { tableLabel: "Table 2", seatNumber: null, tentative: false },
    });
    expect(text(r, "seat")).toBe("Releases their place at Table 2.");
  });

  it("releases on waiting when the plan does not hold seats, and keeps it held when it does", () => {
    const to = { status: "pending", mealOptionId: null } as const;
    expect(text(run({ to }), "seat")).toBe("Releases seat 4 at Table 6.");
    const held = run({ to, layout: { allowTentative: true, snapshot: "none" } });
    expect(text(held, "seat")).toBe("Keeps seat 4 at Table 6 for them, held until they answer.");
    expect(held.items.find((i) => i.id === "seat")?.tone).toBe("info");
    expect(ids(held)).not.toContain("attention");
  });

  it("confirms a held seat on attending, and says an unseated guest joins the queue", () => {
    const from = { status: "pending", mealOptionId: null } as const;
    const to = { status: "accepted", mealOptionId: "beef" } as const;
    const held = run({
      from,
      to,
      seat: { tableLabel: "Table 6", seatNumber: 4, tentative: true },
      layout: { allowTentative: true, snapshot: "stale" },
    });
    expect(text(held, "seat")).toBe("Confirms the seat held for them (seat 4 at Table 6).");
    expect(ids(held)).not.toContain("plan");
    const queued = run({ from, to, seat: null });
    expect(text(queued, "seat")).toBe(
      "Adds them to the guests still to seat. They are not given a seat.",
    );
  });

  it("warns when attending would pass the caterer's locked count", () => {
    const r = run({
      from: { status: "pending", mealOptionId: null },
      to: { status: "accepted", mealOptionId: "fish" },
      seat: null,
      layout: null,
    });
    expect(text(r, "caterer")).toBe(
      "The caterer count stays locked at 96. Attending would be 1 guest more than the caterer was told (now the same as the caterer was told).",
    );
    expect(r.items.find((i) => i.id === "caterer")?.tone).toBe("warning");
    expect(text(r, "meals")).toBe("Meal counts: Fish 12 → 13.");
  });

  it("shows a meal swap and the without-a-meal count without touching attendance", () => {
    const swap = run({ to: { status: "accepted", mealOptionId: "beef" } });
    expect(ids(swap)).toEqual(["plan", "meals"]);
    expect(text(swap, "meals")).toBe("Meal counts: Fish 12 → 11 · Beef 4 → 5.");
    const cleared = run({ to: { status: "accepted", mealOptionId: null }, layout: null });
    expect(ids(cleared)).toEqual(["meals", "without-meal"]);
    expect(text(cleared, "without-meal")).toBe("Attending without a meal goes from 3 to 4.");
    expect(cleared.items.find((i) => i.id === "without-meal")?.tone).toBe("warning");
  });

  it("leaves out caterer, plan and meal lines that do not apply", () => {
    const r = run({
      from: { status: "pending", mealOptionId: null },
      to: { status: "declined", mealOptionId: null },
      seat: null,
      layout: null,
      lockedCount: null,
      meals: [],
    });
    expect(r.changed).toBe(true);
    expect(r.items).toEqual([]);
  });
});
