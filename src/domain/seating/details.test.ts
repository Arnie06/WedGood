import { describe, expect, it } from "vitest";
import { buildSeatingPlan, type GuestInfo, type PlanMember } from "./plan";
import { buildGuestViews } from "./views";

const guests = ["Ada", "Bo", "Cy", "Di", "Ed"].map((n) => ({
  id: n.toLowerCase(),
  name: `${n} Example`,
}));
const meals = [{ id: "m1", name: "Chicken" }];
const member = (guestId: string, status: PlanMember["status"], meal: string | null = null) => ({
  guestId,
  status,
  mealOptionId: meal,
});
const info = (guestId: string, over: Partial<GuestInfo> = {}): GuestInfo => ({
  guestId,
  householdName: null,
  invitationId: null,
  invitationLabel: null,
  isPlusOne: false,
  hostNames: [],
  tags: [],
  ageGroup: null,
  dietary: null,
  accessibility: null,
  ...over,
});
const tables = [
  { id: "t1", label: "Table 1", capacity: 4, shape: "rectangle" as const, notes: "Near the door" },
  { id: "t2", label: "Table 2", capacity: 2 },
];

describe("table details", () => {
  const members = [
    member("ada", "accepted", "m1"),
    member("bo", "accepted"),
    member("cy", "pending"),
    member("di", "accepted"),
    member("ed", "declined"),
  ];
  const details = [
    info("ada", { dietary: "Vegetarian", invitationId: "i1", invitationLabel: "The Examples" }),
    info("bo", {
      isPlusOne: true,
      accessibility: "Step-free",
      invitationId: "i1",
      invitationLabel: "The Examples",
    }),
    info("cy", { ageGroup: "child" }),
    info("di", { dietary: "Nut allergy" }),
  ];
  const plan = buildSeatingPlan({
    guests,
    members,
    tables,
    assignments: [
      { guestId: "ada", tableId: "t1", tentative: false, seatNumber: 2, isCaptain: true },
      { guestId: "bo", tableId: "t1", tentative: false, seatNumber: null },
      { guestId: "cy", tableId: "t1", tentative: true, seatNumber: 1 },
    ],
    meals,
    allowTentative: true,
    info: details,
  });

  it("summarises who has answered, plus-ones, children and notes per table", () => {
    expect(plan.issues).toEqual([]);
    const t1 = plan.tables[0]!;
    expect(t1.stats).toEqual({
      accepted: 2,
      waiting: 1,
      plusOnes: 1,
      children: 1,
      dietary: 1,
      accessibility: 1,
    });
    expect(t1.shape).toBe("rectangle");
    expect(t1.notes).toBe("Near the door");
    expect(t1.captainId).toBe("ada");
    expect(plan.tables[1]).toMatchObject({ shape: "round", notes: null, captainId: null });
  });

  it("orders seats by seat number, then name, with unnumbered guests last", () => {
    expect(plan.tables[0]!.seats.map((s) => s.guest.id)).toEqual(["cy", "ada", "bo"]);
    expect(plan.tables[0]!.seats.find((s) => s.guest.id === "cy")?.tentative).toBe(true);
  });

  it("counts attending guests with dietary or access notes once, seated or not", () => {
    expect(plan.totals.dietary).toBe(2); // ada and di (cy is waiting; ed declined)
    expect(plan.totals.accessibility).toBe(1);
  });

  it("flags a table with two captains instead of hiding it", () => {
    const bad = buildSeatingPlan({
      guests,
      members,
      tables,
      assignments: [
        { guestId: "ada", tableId: "t1", tentative: false, seatNumber: null, isCaptain: true },
        { guestId: "bo", tableId: "t1", tentative: false, seatNumber: null, isCaptain: true },
      ],
      meals,
      allowTentative: false,
      info: details,
    });
    expect(bad.issues).toContain("Table 1 has more than one captain.");
  });
});

describe("queue groups", () => {
  const members = [
    member("ada", "accepted"),
    member("bo", "accepted"),
    member("cy", "accepted"),
    member("di", "pending"),
  ];
  const details = [
    info("ada", { invitationId: "i1", invitationLabel: "The Examples" }),
    info("bo", { invitationId: "i1", invitationLabel: "The Examples", isPlusOne: true }),
    info("cy", { invitationId: "i2", invitationLabel: "Solo" }),
    info("di", { invitationId: "i1", invitationLabel: "The Examples" }),
  ];
  const base = { guests, members, tables, meals, info: details };

  it("groups unseated guests by invitation and ignores single guests", () => {
    const plan = buildSeatingPlan({ ...base, assignments: [], allowTentative: false });
    expect(plan.queueGroups).toHaveLength(1);
    expect(plan.queueGroups[0]).toMatchObject({ key: "i1", label: "The Examples" });
    expect(plan.queueGroups[0]!.guests.map((g) => g.id)).toEqual(["ada", "bo"]);
  });

  it("includes waiting guests only when tentative seating is on, and drops seated ones", () => {
    const withTentative = buildSeatingPlan({ ...base, assignments: [], allowTentative: true });
    expect(withTentative.queueGroups[0]!.guests.map((g) => g.id)).toEqual(["ada", "bo", "di"]);
    const oneSeated = buildSeatingPlan({
      ...base,
      assignments: [{ guestId: "ada", tableId: "t1", tentative: false, seatNumber: null }],
      allowTentative: false,
    });
    expect(oneSeated.queueGroups).toEqual([]);
  });
});

describe("guest views", () => {
  const members = [
    member("ada", "accepted", "m1"),
    member("bo", "accepted"),
    member("di", "declined"),
  ];
  const details = [
    info("ada", { invitationId: "i1", dietary: "Vegetarian" }),
    info("bo", { invitationId: "i1", isPlusOne: true, hostNames: ["Ada Example"] }),
    info("di", { invitationId: "i1" }),
  ];
  const plan = buildSeatingPlan({
    guests,
    members,
    tables,
    assignments: [
      { guestId: "ada", tableId: "t1", tentative: false, seatNumber: 3, isCaptain: true },
    ],
    meals,
    allowTentative: false,
    info: details,
  });
  const views = buildGuestViews({ plan, guests, members, info: details, meals });

  it("shows seat, captain, meal and where companions sit", () => {
    const ada = views.get("ada")!;
    expect(ada).toMatchObject({
      status: "accepted",
      meal: "Chicken",
      table: { id: "t1", label: "Table 1", captain: true, seatNumber: 3, tentative: false },
    });
    expect(ada.companions).toEqual([
      { id: "bo", name: "Bo Example", status: "accepted", isPlusOne: true, tableLabel: null },
      { id: "di", name: "Di Example", status: "declined", isPlusOne: false, tableLabel: null },
    ]);
    expect(views.get("bo")!.table).toBeNull();
    expect(views.get("bo")!.companions.map((c) => c.tableLabel)).toEqual(["Table 1", null]);
  });

  it("has no view for guests without an answer row", () => {
    expect(views.has("cy")).toBe(false);
  });
});
