import { describe, expect, it } from "vitest";
import {
  buildDemand,
  describePlanningNumber,
  isPlanningBasis,
  planningNumber,
  type EventCounts,
} from "./demand";

const counts = (over: Partial<EventCounts> = {}): EventCounts => ({
  eventId: "e1",
  invited: 20,
  yes: 10,
  waitingOpen: 4,
  waitingClosed: 2,
  no: 4,
  openPlusOnes: 3,
  seatedConfirmed: 7,
  seatedTentative: 0,
  yesWithoutMeal: 1,
  meals: [],
  ...over,
});

describe("planningNumber", () => {
  it("auto: attending plus waiting guests whose reply window is open", () => {
    const n = planningNumber(counts(), { basis: "auto", includeOpenPlusOnes: false });
    expect(n).toEqual({ total: 14, waitingCounted: 4, openPlusOnesCounted: 0 });
  });

  it("auto: once every reply date has passed only attending guests count", () => {
    const n = planningNumber(counts({ waitingOpen: 0, waitingClosed: 6 }), {
      basis: "auto",
      includeOpenPlusOnes: false,
    });
    expect(n.total).toBe(10);
  });

  it("yes: ignores everyone still waiting", () => {
    expect(planningNumber(counts(), { basis: "yes", includeOpenPlusOnes: false }).total).toBe(10);
  });

  it("yes_waiting: counts every waiting guest even after the reply date", () => {
    expect(
      planningNumber(counts(), { basis: "yes_waiting", includeOpenPlusOnes: false }).total,
    ).toBe(16);
  });

  it("adds unnamed plus-ones only when the event opts in", () => {
    expect(planningNumber(counts(), { basis: "auto", includeOpenPlusOnes: false }).total).toBe(14);
    expect(planningNumber(counts(), { basis: "auto", includeOpenPlusOnes: true }).total).toBe(17);
  });

  it("is zero for an event with no replies, never unknown", () => {
    const empty = counts({
      invited: 0,
      yes: 0,
      waitingOpen: 0,
      waitingClosed: 0,
      no: 0,
      openPlusOnes: 0,
    });
    expect(planningNumber(empty, { basis: "auto", includeOpenPlusOnes: true }).total).toBe(0);
  });
});

describe("buildDemand", () => {
  it("totals waiting and works out guests still needing a seat", () => {
    const d = buildDemand(counts(), { basis: "auto", includeOpenPlusOnes: false });
    expect(d.waiting).toBe(6);
    expect(d.needSeat).toBe(3);
    expect(d.planningNumber).toBe(14);
  });

  it("never reports a negative number needing a seat", () => {
    const d = buildDemand(counts({ yes: 2, seatedConfirmed: 5 }), {
      basis: "yes",
      includeOpenPlusOnes: false,
    });
    expect(d.needSeat).toBe(0);
  });
});

describe("describePlanningNumber", () => {
  it("spells out the sum and what was left out", () => {
    const d = buildDemand(counts(), { basis: "auto", includeOpenPlusOnes: false });
    expect(describePlanningNumber(d)).toBe(
      "Planning for 14 people: 10 attending + 4 still waiting, not counting 2 who did not answer by the reply date or 3 plus-one places not named yet.",
    );
  });

  it("uses the singular and omits the tail when nothing is left out", () => {
    const d = buildDemand(counts({ yes: 1, waitingOpen: 0, waitingClosed: 0, openPlusOnes: 0 }), {
      basis: "auto",
      includeOpenPlusOnes: false,
    });
    expect(describePlanningNumber(d)).toBe("Planning for 1 person: 1 attending.");
  });

  it("uses the singular for a single plus-one place", () => {
    const d = buildDemand(counts({ waitingOpen: 0, waitingClosed: 0, openPlusOnes: 1 }), {
      basis: "yes",
      includeOpenPlusOnes: false,
    });
    expect(describePlanningNumber(d)).toBe(
      "Planning for 10 people: 10 attending, not counting 1 plus-one place not named yet.",
    );
  });

  it("names plus-one places that were opted in", () => {
    const d = buildDemand(counts({ waitingOpen: 0, waitingClosed: 0 }), {
      basis: "yes",
      includeOpenPlusOnes: true,
    });
    expect(describePlanningNumber(d)).toBe(
      "Planning for 13 people: 10 attending + 3 plus-one places not named yet.",
    );
  });
});

describe("isPlanningBasis", () => {
  it("accepts only the three bases", () => {
    expect(["auto", "yes", "yes_waiting"].every(isPlanningBasis)).toBe(true);
    expect(isPlanningBasis("all")).toBe(false);
    expect(isPlanningBasis(null)).toBe(false);
  });
});
