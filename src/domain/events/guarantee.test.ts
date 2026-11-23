import { describe, expect, it } from "vitest";
import {
  driftSentence,
  dueInfo,
  dueSentence,
  guaranteeDrift,
  lockSentence,
  previewMatches,
  previewOf,
  revisionSentence,
  type GuaranteeVersion,
} from "./guarantee";

describe("previewOf and previewMatches", () => {
  const demand = {
    yes: 96,
    yesWithoutMeal: 4,
    meals: [
      { id: "m1", name: "Fish", active: true, count: 50 },
      { id: "m2", name: "Veg", active: true, count: 42 },
    ],
  };

  it("keeps only ids and counts", () => {
    expect(previewOf(demand)).toEqual({
      yes: 96,
      withoutMeal: 4,
      meals: [
        { id: "m1", count: 50 },
        { id: "m2", count: 42 },
      ],
    });
  });
  it("matches the same counts in any order", () => {
    const a = previewOf(demand);
    const b = { ...a, meals: [...a.meals].reverse() };
    expect(previewMatches(a, b)).toBe(true);
  });
  it("does not match when one meal count, the total or the without-meal figure moved", () => {
    const a = previewOf(demand);
    expect(
      previewMatches(a, {
        ...a,
        meals: [
          { id: "m1", count: 51 },
          { id: "m2", count: 42 },
        ],
      }),
    ).toBe(false);
    expect(previewMatches(a, { ...a, yes: 95 })).toBe(false);
    expect(previewMatches(a, { ...a, withoutMeal: 3 })).toBe(false);
  });
  it("does not match when a meal option appeared or a different id took its place", () => {
    const a = previewOf(demand);
    expect(previewMatches(a, { ...a, meals: [...a.meals, { id: "m3", count: 0 }] })).toBe(false);
    expect(
      previewMatches(a, {
        ...a,
        meals: [
          { id: "m1", count: 50 },
          { id: "m9", count: 42 },
        ],
      }),
    ).toBe(false);
  });
  it("does not let a repeated id hide a difference", () => {
    const a = { yes: 2, withoutMeal: 0, meals: [{ id: "m1", count: 2 }] };
    const b = {
      yes: 2,
      withoutMeal: 0,
      meals: [
        { id: "m1", count: 2 },
        { id: "m1", count: 2 },
      ],
    };
    expect(previewMatches(a, b)).toBe(false);
  });
});

describe("guaranteeDrift", () => {
  it("is a match when the numbers agree", () => {
    expect(guaranteeDrift(100, 100)).toEqual({ state: "match", gap: 0, advise: false });
  });
  it("is over, without advice, when fewer are attending than were told", () => {
    expect(guaranteeDrift(118, 96)).toEqual({ state: "over", gap: 22, advise: false });
  });
  it("is under, with advice, when more are attending than were told", () => {
    expect(guaranteeDrift(100, 112)).toEqual({ state: "under", gap: 12, advise: true });
  });
});

describe("sentences", () => {
  it("states the example from the plan", () => {
    expect(driftSentence(118, 96, 0)).toBe(
      "Locked 118 · now 96 attending · 22 more than are attending.",
    );
  });
  it("mentions who is still waiting", () => {
    expect(driftSentence(100, 100, 3)).toBe("Locked 100 · now 100 attending (3 still waiting).");
    expect(driftSentence(100, 105, 2)).toBe(
      "Locked 100 · now 105 attending (2 still waiting) · 5 more attending than the caterer was told.",
    );
  });
  it("says what a lock tells the caterer", () => {
    expect(lockSentence(118)).toBe("You're telling the caterer 118 guests.");
    expect(lockSentence(1)).toBe("You're telling the caterer 1 guest.");
  });
  it("describes the due date in each state", () => {
    expect(dueSentence(dueInfo(null, null), "")).toBe("No date set for sending it.");
    expect(dueSentence(dueInfo("2027-05-12", 10), "12 May 2027")).toBe(
      "The caterer needs it by 12 May 2027 (10 days away).",
    );
    expect(dueSentence(dueInfo("2027-05-12", 1), "12 May 2027")).toContain("(1 day away)");
    expect(dueSentence(dueInfo("2027-05-12", 0), "12 May 2027")).toBe(
      "The caterer needs it today (12 May 2027).",
    );
    expect(dueSentence(dueInfo("2027-05-12", -3), "12 May 2027")).toBe(
      "The caterer's date was 12 May 2027.",
    );
  });
});

describe("revisionSentence", () => {
  const v = (over: Partial<GuaranteeVersion>): GuaranteeVersion => ({
    id: "x",
    count: 100,
    status: "locked",
    lockedAt: "2027-01-01T00:00:00Z",
    reason: null,
    supersedesId: null,
    ...over,
  });
  it("is empty for a first lock", () => {
    expect(revisionSentence(v({}), new Map())).toBeNull();
  });
  it("names the old and new count and the reason", () => {
    const first = v({ id: "a", count: 118, status: "superseded" });
    const second = v({ id: "b", count: 112, supersedesId: "a", reason: "Venue lost a table" });
    expect(revisionSentence(second, new Map([["a", first]]))).toBe(
      "Revised from 118 to 112: Venue lost a table",
    );
  });
});
