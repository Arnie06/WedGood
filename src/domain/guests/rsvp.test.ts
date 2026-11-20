import { describe, expect, it } from "vitest";
import { summarizeResponses, type EventResponse } from "./rsvp";

const r = (
  guestId: string,
  rsvpStatus: EventResponse["rsvpStatus"],
  mealOptionId: string | null = null,
  eligible = true,
): EventResponse => ({ guestId, rsvpStatus, mealOptionId, eligible });

describe("summarizeResponses", () => {
  it("counts per status and meals for accepted guests only", () => {
    const summary = summarizeResponses([
      r("a", "accepted", "chicken"),
      r("b", "accepted", "veg"),
      r("c", "accepted", "veg"),
      r("d", "accepted", "fish"),
      r("e", "pending"),
      r("f", "declined", "fish"),
    ]);
    expect(summary).toMatchObject({ invited: 6, accepted: 4, pending: 1, declined: 1 });
    expect(Object.fromEntries(summary.mealCounts)).toEqual({ chicken: 1, veg: 2, fish: 1 });
    expect(summary.acceptedWithoutMeal).toBe(0);
  });

  it("tracks accepted guests missing a meal choice", () => {
    expect(summarizeResponses([r("a", "accepted")]).acceptedWithoutMeal).toBe(1);
  });

  it("ignores ineligible members", () => {
    expect(summarizeResponses([r("a", "accepted", "veg", false)]).invited).toBe(0);
  });

  it("rejects duplicate responses for one guest", () => {
    expect(() => summarizeResponses([r("a", "accepted"), r("a", "declined")])).toThrow(
      /more than one/,
    );
  });
});
