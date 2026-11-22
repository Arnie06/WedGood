import { describe, expect, it } from "vitest";
import { seatCards, seatLabel, tableCard } from "./cards";
import { buildSeatingPlan, type GuestInfo, type PlanMember } from "./plan";
import { buildGuestViews } from "./views";

const guests = ["Ada", "Bo", "Cy", "Di"].map((n) => ({
  id: n.toLowerCase(),
  name: `${n} Example`,
}));
const meals = [
  { id: "m1", name: "Chicken" },
  { id: "m2", name: "Fish" },
];
const member = (
  guestId: string,
  status: PlanMember["status"],
  meal: string | null = null,
): PlanMember => ({ guestId, status, mealOptionId: meal });
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

const members = [
  member("ada", "accepted", "m1"),
  member("bo", "accepted", "m2"),
  member("cy", "pending"),
  member("di", "accepted"),
];
const details = [
  info("ada", { dietary: "Vegetarian", householdName: "The Examples" }),
  info("bo", { isPlusOne: true, hostNames: ["Ada Example"], accessibility: "Step-free" }),
  info("cy", { ageGroup: "child" }),
];
const input = {
  guests,
  members,
  tables: [
    { id: "t1", label: "Garden", capacity: 4, shape: "rectangle" as const, notes: "Near the door" },
    { id: "t2", label: "Orchard", capacity: 2 },
  ],
  assignments: [
    { guestId: "ada", tableId: "t1", tentative: false, seatNumber: 2, isCaptain: true },
    { guestId: "bo", tableId: "t1", tentative: false, seatNumber: null },
    { guestId: "cy", tableId: "t1", tentative: true, seatNumber: 4 },
  ],
  meals,
  allowTentative: true,
  info: details,
};
const plan = buildSeatingPlan(input);
const views = buildGuestViews({ plan, guests, members, info: details, meals });

describe("tableCard", () => {
  it("summarises seats, answers, who is included, meals, captain and notes", () => {
    const card = tableCard(plan.tables[0]!);
    expect(card).toMatchObject({
      label: "Garden",
      shape: "rectangle",
      capacity: 4,
      used: 3,
      open: 1,
      full: false,
      attending: 2,
      waiting: 1,
      plusOnes: 1,
      children: 1,
      dietary: 1,
      accessibility: 1,
      captain: "Ada Example",
      notes: "Near the door",
    });
    // Unknown stays visible as "No choice yet" rather than being dropped or counted as a meal.
    expect(card.meals).toEqual(["Chicken 1", "Fish 1", "No choice yet 1"]);
  });

  it("says an empty table is empty and a full one is full, never full at zero seats", () => {
    const empty = tableCard(plan.tables[1]!);
    expect(empty).toMatchObject({ used: 0, open: 2, full: false, captain: null, meals: [] });
    const full = tableCard({ ...plan.tables[1]!, used: 2, open: 0 });
    expect(full.full).toBe(true);
    expect(tableCard({ ...plan.tables[1]!, capacity: 0, open: 0 }).full).toBe(false);
  });
});

describe("seatCards", () => {
  const cards = seatCards(plan.tables[0]!, views);

  it("returns one card per seat in seat order with the right occupant", () => {
    expect(cards.map((c) => c.seat)).toEqual([1, 2, 3, 4]);
    expect(cards.map((c) => c.guest?.name ?? null)).toEqual([
      "Bo Example", // no saved number: drawn in the lowest free seat
      "Ada Example",
      null,
      "Cy Example",
    ]);
    expect(cards.map((c) => c.state)).toEqual(["seated", "seated", "empty", "waiting"]);
    expect(cards.map((c) => c.numbered)).toEqual([false, true, false, true]);
  });

  it("carries the facts a person wants when tapping a seat", () => {
    expect(cards[1]!.guest).toMatchObject({
      captain: true,
      meal: "Chicken",
      household: "The Examples",
      dietary: "Vegetarian",
      held: false,
      initials: "AE",
    });
    expect(cards[0]!.guest).toMatchObject({
      plusOne: true,
      plusOneOf: ["Ada Example"],
      meal: "Fish",
      accessibility: "Step-free",
    });
    expect(cards[3]!.guest).toMatchObject({ held: true, child: true, meal: null });
  });

  it("describes an empty seat without inventing a guest", () => {
    expect(cards[2]).toMatchObject({ state: "empty", guest: null, tableLabel: "Garden" });
  });

  it("builds a card for every seat of an empty table", () => {
    const empty = seatCards(plan.tables[1]!, views);
    expect(empty).toHaveLength(2);
    expect(empty.every((c) => c.guest === null && c.state === "empty")).toBe(true);
  });
});

describe("seatLabel", () => {
  const cards = seatCards(plan.tables[0]!, views);
  it("names the table, the seat and who is there, with status in words", () => {
    expect(seatLabel(cards[1]!)).toBe("Garden, seat 2, Ada Example, captain");
    expect(seatLabel(cards[3]!)).toBe("Garden, seat 4, Cy Example, waiting to answer");
    expect(seatLabel(cards[2]!)).toBe("Garden, seat 3, empty");
  });
});
