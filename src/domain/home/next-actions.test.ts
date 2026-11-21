import { describe, expect, it } from "vitest";
import { isSetupStage, nextActions, type HomeFacts } from "./next-actions";

const all = { settings: true, plan: true, guests: true, vendors: true };
const empty: HomeFacts = {
  hasDate: false,
  hasBudgetTarget: false,
  hasGuestTarget: false,
  checklistTotal: 0,
  overdueCount: 0,
  venueCount: 0,
  guestCount: 0,
  can: all,
};
const ids = (f: HomeFacts) => nextActions(f).map((a) => a.id);

describe("nextActions", () => {
  it("guides setup for an empty workspace, capped at three", () => {
    expect(ids(empty)).toEqual(["set-date", "start-checklist", "set-budget"]);
  });

  it("keeps overdue work visible during setup, after the first step", () => {
    expect(ids({ ...empty, checklistTotal: 20, overdueCount: 2 })).toEqual([
      "set-date",
      "overdue",
      "set-budget",
    ]);
  });

  it("puts overdue first once the basics exist", () => {
    const set: HomeFacts = {
      ...empty,
      hasDate: true,
      hasBudgetTarget: true,
      hasGuestTarget: true,
      checklistTotal: 20,
      overdueCount: 1,
      venueCount: 0,
    };
    expect(isSetupStage(set)).toBe(false);
    expect(ids(set)).toEqual(["overdue", "add-venue", "add-guests"]);
  });

  it("returns nothing when everything is in place", () => {
    expect(
      nextActions({
        ...empty,
        hasDate: true,
        hasBudgetTarget: true,
        hasGuestTarget: true,
        checklistTotal: 5,
        venueCount: 1,
        guestCount: 10,
      }),
    ).toEqual([]);
  });

  it("only offers what the member may do", () => {
    const viewer = { settings: false, plan: false, guests: false, vendors: false };
    expect(ids({ ...empty, can: viewer })).toEqual([]);
    expect(ids({ ...empty, checklistTotal: 3, overdueCount: 1, can: viewer })).toEqual(["overdue"]);
  });

  it("does not ask for a guest target once guests exist", () => {
    expect(ids({ ...empty, hasDate: true, hasBudgetTarget: true, guestCount: 4 })).not.toContain(
      "set-guest-target",
    );
  });

  it("marks budget and guest target as inline quick actions", () => {
    const a = nextActions({ ...empty, hasDate: true, checklistTotal: 3 });
    expect(a.map((x) => x.inline)).toEqual(["budget", "guests", undefined]);
  });

  it("pluralises the overdue title", () => {
    expect(nextActions({ ...empty, checklistTotal: 3, overdueCount: 1 })[1]?.title).toBe(
      "1 checklist item is overdue",
    );
    expect(nextActions({ ...empty, checklistTotal: 3, overdueCount: 4 })[1]?.title).toBe(
      "4 checklist items are overdue",
    );
  });
});
