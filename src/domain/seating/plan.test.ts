import { describe, expect, it } from "vitest";
import { buildSeatingPlan, snapshotState, type PlanMember } from "./plan";

const guests = ["Ada", "Bo", "Cy", "Di", "Ed"].map((n) => ({
  id: n.toLowerCase(),
  name: `${n} Example`,
}));
const meals = [
  { id: "m1", name: "Chicken" },
  { id: "m2", name: "Veg" },
];
const member = (
  guestId: string,
  status: PlanMember["status"],
  meal: string | null = null,
): PlanMember => ({
  guestId,
  status,
  mealOptionId: meal,
});
const tables = [
  { id: "t1", label: "Table 1", capacity: 2 },
  { id: "t2", label: "Table 2", capacity: 4 },
];

describe("buildSeatingPlan", () => {
  it("queues accepted guests and counts confirmed and tentative separately", () => {
    const plan = buildSeatingPlan({
      guests,
      members: [
        member("ada", "accepted", "m1"),
        member("bo", "accepted", "m2"),
        member("cy", "accepted"),
        member("di", "pending"),
        member("ed", "declined"),
      ],
      tables,
      assignments: [
        { guestId: "ada", tableId: "t1", tentative: false, seatNumber: null },
        { guestId: "di", tableId: "t1", tentative: true, seatNumber: null },
      ],
      meals,
      allowTentative: true,
    });
    expect(plan.issues).toEqual([]);
    expect(plan.totals).toMatchObject({
      accepted: 3,
      confirmedSeated: 1,
      tentativeSeated: 1,
      unassignedAccepted: 2,
      capacity: 6,
      openSeats: 4,
      acceptedWithoutMeal: 1,
    });
    expect(plan.queue.map((g) => g.id)).toEqual(["bo", "cy"]);
    expect(plan.tables[0]).toMatchObject({ used: 2, open: 0 });
    expect(plan.tables[0]?.tentative.map((g) => g.id)).toEqual(["di"]);
  });

  it("totals each accepted guest once in event meals, seated or not, and never counts declines", () => {
    const plan = buildSeatingPlan({
      guests,
      members: [
        member("ada", "accepted", "m1"),
        member("bo", "accepted", "m1"),
        member("cy", "accepted", "m2"),
        member("ed", "declined"),
      ],
      tables,
      assignments: [{ guestId: "ada", tableId: "t2", tentative: false, seatNumber: null }],
      meals,
      allowTentative: false,
    });
    const line = (id: string | null) => plan.meals.find((l) => l.mealOptionId === id)?.confirmed;
    expect(line("m1")).toBe(2);
    expect(line("m2")).toBe(1);
    expect(plan.meals.reduce((n, l) => n + l.confirmed, 0)).toBe(plan.totals.accepted);
    expect(plan.tables[1]?.meals.find((l) => l.mealOptionId === "m1")?.confirmed).toBe(1);
  });

  it("is deterministic regardless of input order", () => {
    const base = {
      guests,
      members: guests.map((g) => member(g.id, "accepted")),
      tables,
      assignments: [],
      meals,
      allowTentative: false,
    };
    const a = buildSeatingPlan(base);
    const b = buildSeatingPlan({
      ...base,
      guests: [...guests].reverse(),
      members: [...base.members].reverse(),
    });
    expect(b.queue).toEqual(a.queue);
  });

  it("reports impossible states instead of hiding them", () => {
    const plan = buildSeatingPlan({
      guests,
      members: [
        member("ada", "declined"),
        member("bo", "accepted"),
        member("cy", "accepted"),
        member("di", "accepted"),
      ],
      tables: [{ id: "t1", label: "Table 1", capacity: 1 }],
      assignments: [
        { guestId: "ada", tableId: "t1", tentative: false, seatNumber: null },
        { guestId: "bo", tableId: "t1", tentative: false, seatNumber: null },
        { guestId: "bo", tableId: "t1", tentative: false, seatNumber: null },
        { guestId: "cy", tableId: "gone", tentative: false, seatNumber: null },
      ],
      meals,
      allowTentative: false,
    });
    expect(plan.issues.length).toBeGreaterThanOrEqual(3);
  });

  it("hides the waiting queue unless tentative seating is on", () => {
    const input = {
      guests,
      members: [member("di", "pending")],
      tables,
      assignments: [],
      meals,
      allowTentative: false,
    };
    expect(buildSeatingPlan(input).waitingQueue).toEqual([]);
    expect(buildSeatingPlan({ ...input, allowTentative: true }).waitingQueue).toHaveLength(1);
  });
});

describe("snapshotState", () => {
  it("is none, current, then stale as the plan revision moves", () => {
    expect(snapshotState({ revision: 3, finalizedRevision: null })).toBe("none");
    expect(snapshotState({ revision: 3, finalizedRevision: 3 })).toBe("current");
    expect(snapshotState({ revision: 4, finalizedRevision: 3 })).toBe("stale");
  });
});
