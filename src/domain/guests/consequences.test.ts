import { describe, expect, it } from "vitest";
import { buildDemand, type EventDemand } from "@/domain/events/demand";
import {
  guestConsequences,
  matchFrozenSeat,
  waitingCounts,
  type ConsequenceInput,
} from "./consequences";

const FISH = "fish";
const BEEF = "beef";

function demand(over: Partial<Parameters<typeof buildDemand>[0]> = {}): EventDemand {
  return buildDemand(
    {
      eventId: "e",
      invited: 100,
      yes: 86,
      waitingOpen: 4,
      waitingClosed: 0,
      no: 10,
      openPlusOnes: 0,
      seatedConfirmed: 80,
      seatedTentative: 0,
      yesWithoutMeal: 2,
      meals: [
        { id: FISH, name: "Fish", active: true, count: 40 },
        { id: BEEF, name: "Beef", active: true, count: 44 },
      ],
      ...over,
    },
    { basis: "auto", includeOpenPlusOnes: false },
  );
}

/** The brief's late cancellation: attending with fish, seated, plan finalized, count locked. */
function lateDecline(over: Partial<ConsequenceInput> = {}): ConsequenceInput {
  return {
    change: {
      fromStatus: "accepted",
      toStatus: "declined",
      fromMealId: FISH,
      toMealId: null,
      occurredAt: "2027-05-03T10:00:00Z",
    },
    current: { status: "declined", mealOptionId: null },
    demand: demand(),
    waitingCounts: true,
    seat: null,
    frozenSeat: { tableLabel: "Table 6", seatNumber: 5 },
    layout: {
      snapshot: "stale",
      finalizedRevision: 3,
      finalizedAt: "2027-05-01T09:00:00Z",
      releasedOpen: true,
    },
    guarantee: { count: 87, lockedOn: "1 May 2027" },
    budgetItems: [{ name: "Catering", source: "event_yes" }],
    ...over,
  };
}

const texts = (lines: { text: string }[]) => lines.map((l) => l.text);

describe("guestConsequences", () => {
  it("lists every consequence of a late decline", () => {
    const c = guestConsequences(lateDecline());
    expect(texts(c.updated)).toEqual([
      "Attending: 1 fewer, 86 now.",
      "Planning number: 1 fewer, 90 now.",
      "Fish: 1 fewer, 40 now.",
      "Per-guest estimates that count this event follow the new number: Catering.",
      "Seat 5 at Table 6 in the finalized plan is free again in the live plan.",
    ]);
    expect(c.review.map((l) => [l.id, l.link])).toEqual([
      ["plan", "seating"],
      ["attention", "attention"],
      ["caterer", "event"],
    ]);
    expect(c.review[0]!.text).toContain("version 3) is out of date");
    expect(c.review[2]!.text).toBe(
      "The caterer was told 87; 86 are attending now, 1 fewer. Check whether the count can still go down.",
    );
    expect(texts(c.unchanged)).toEqual([
      "The caterer count stays at 87, locked 1 May 2027.",
      "Finalized seating version 3 is kept as it was.",
      "Signed bookings, contracts, invoices and payments. A reply never changes these.",
    ]);
  });

  it("does not claim a seat or a stale plan when the plan was finalized after the change", () => {
    const c = guestConsequences(
      lateDecline({
        layout: {
          snapshot: "stale",
          finalizedRevision: 4,
          finalizedAt: "2027-05-04T09:00:00Z",
          releasedOpen: true,
        },
      }),
    );
    expect(c.updated.find((l) => l.id === "seat")).toBeUndefined();
    expect(c.review.map((l) => l.id)).toEqual(["caterer"]);
    expect(c.unchanged.map((l) => l.id)).not.toContain("snapshot");
  });

  it("names no seat when the finalized copy could not be matched", () => {
    const c = guestConsequences(lateDecline({ frozenSeat: null }));
    expect(c.updated.find((l) => l.id === "seat")).toBeUndefined();
  });

  it("a waiting answer outside the reply window leaves the planning number alone", () => {
    const c = guestConsequences(
      lateDecline({
        change: { ...lateDecline().change, fromStatus: "pending", fromMealId: null },
        waitingCounts: false,
        layout: null,
        guarantee: null,
        budgetItems: [{ name: "Favours", source: "event_plan" }],
      }),
    );
    expect(c.updated).toEqual([]);
    expect(c.review).toEqual([]);
    expect(texts(c.unchanged)).toEqual([
      "Signed bookings, contracts, invoices and payments. A reply never changes these.",
    ]);
  });

  it("accepting without a meal asks for a seat, a meal and a caterer revision", () => {
    const c = guestConsequences(
      lateDecline({
        change: {
          fromStatus: "pending",
          toStatus: "accepted",
          fromMealId: null,
          toMealId: null,
          occurredAt: "2027-05-03T10:00:00Z",
        },
        current: { status: "accepted", mealOptionId: null },
        demand: demand({ yes: 88, yesWithoutMeal: 3 }),
        waitingCounts: true,
        frozenSeat: null,
        budgetItems: [
          { name: "Catering", source: "event_yes" },
          { name: "Favours", source: "event_plan" },
        ],
      }),
    );
    // Waiting already counted, so the planning number did not move and Favours is not listed.
    expect(texts(c.updated)).toEqual([
      "Attending: 1 more, 88 now.",
      "Attending without a meal: 1 more, 3 now.",
      "Per-guest estimates that count this event follow the new number: Catering.",
    ]);
    expect(c.review.map((l) => l.id)).toEqual(["plan", "unseated", "meal", "caterer"]);
    expect(c.review.find((l) => l.id === "caterer")!.text).toBe(
      "1 guest more attending than the caterer was told (87). Consider revising the count.",
    );
  });

  it("a meal swap moves both tallies and nothing else", () => {
    const c = guestConsequences(
      lateDecline({
        change: {
          fromStatus: "accepted",
          toStatus: "accepted",
          fromMealId: FISH,
          toMealId: BEEF,
          occurredAt: "2027-05-03T10:00:00Z",
        },
        current: { status: "accepted", mealOptionId: BEEF },
        seat: { tableLabel: "Table 6", seatNumber: 5, tentative: false },
        guarantee: { count: 86, lockedOn: "1 May 2027" },
      }),
    );
    expect(texts(c.updated)).toEqual(["Fish: 1 fewer, 40 now.", "Beef: 1 more, 44 now."]);
    expect(c.review.map((l) => l.id)).toEqual(["plan"]);
  });

  it("a held seat for a guest back to waiting is reported as held", () => {
    const c = guestConsequences(
      lateDecline({
        change: { ...lateDecline().change, toStatus: "pending" },
        current: { status: "pending", mealOptionId: null },
        seat: { tableLabel: "Table 6", seatNumber: 5, tentative: true },
      }),
    );
    expect(c.updated.find((l) => l.id === "seat")!.text).toBe(
      "Seat 5 at Table 6 is held for them until they answer.",
    );
    // Waiting counts today, so the planning number did not move.
    expect(c.updated.find((l) => l.id === "planning")).toBeUndefined();
  });

  it("shows no totals when the caller cannot read them", () => {
    const c = guestConsequences(lateDecline({ demand: null }));
    expect(c.updated.map((l) => l.id)).toEqual(["seat"]);
    expect(c.review.map((l) => l.id)).toEqual(["plan", "attention"]);
  });

  it("an uninvited guest gets one review line", () => {
    const c = guestConsequences(lateDecline({ current: null }));
    expect(c.updated).toEqual([]);
    expect(c.review.map((l) => l.id)).toEqual(["uninvited"]);
    expect(c.unchanged.map((l) => l.id)).toEqual(["commitments"]);
  });
});

describe("waitingCounts", () => {
  it("follows the planning basis", () => {
    expect(waitingCounts("yes", true)).toBe(false);
    expect(waitingCounts("yes_waiting", false)).toBe(true);
    expect(waitingCounts("auto", true)).toBe(true);
    expect(waitingCounts("auto", false)).toBe(false);
  });
});

describe("matchFrozenSeat", () => {
  const tables = [
    { label: "Table 1", guests: [{ name: "Ada Example", seat: 2 }] },
    {
      label: "Table 6",
      guests: [
        { name: "Bo Example", seat: 5 },
        { name: "Cy Example", seat: null },
      ],
    },
  ];
  it("matches a unique name once", () => {
    expect(matchFrozenSeat("Bo Example", 1, tables)).toEqual({
      tableLabel: "Table 6",
      seatNumber: 5,
    });
    expect(matchFrozenSeat("Cy Example", 1, tables)).toEqual({
      tableLabel: "Table 6",
      seatNumber: null,
    });
  });
  it("refuses shared names, missing names and repeats", () => {
    expect(matchFrozenSeat("Bo Example", 2, tables)).toBeNull();
    expect(matchFrozenSeat("Di Example", 1, tables)).toBeNull();
    const twice = [...tables, { label: "Table 9", guests: [{ name: "Ada Example", seat: 1 }] }];
    expect(matchFrozenSeat("Ada Example", 1, twice)).toBeNull();
  });
});
