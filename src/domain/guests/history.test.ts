import { describe, expect, it } from "vitest";
import {
  describeReplyChange,
  describeReplySource,
  groupReplyChanges,
  type ReplyChange,
} from "./history";

const change = (over: Partial<ReplyChange> = {}): ReplyChange => ({
  id: "c1",
  eventId: "e1",
  fromStatus: "pending",
  toStatus: "accepted",
  fromMeal: null,
  toMeal: null,
  source: "guest",
  reason: null,
  occurredAt: "2027-01-01T10:00:00Z",
  ...over,
});

describe("describeReplyChange", () => {
  it("names the answer before and after", () => {
    expect(describeReplyChange(change())).toBe("No answer → Attending");
    expect(describeReplyChange(change({ fromStatus: "accepted", toStatus: "declined" }))).toBe(
      "Attending → Not attending",
    );
  });
  it("adds the meal when someone accepts with one", () => {
    expect(describeReplyChange(change({ toMeal: "Fish" }))).toBe("No answer → Attending (Fish)");
  });
  it("shows a meal-only change", () => {
    expect(
      describeReplyChange(
        change({ fromStatus: "accepted", toStatus: "accepted", fromMeal: "Fish", toMeal: "Beef" }),
      ),
    ).toBe("Meal: Fish → Beef");
    expect(
      describeReplyChange(change({ fromStatus: "accepted", toStatus: "accepted", toMeal: "Beef" })),
    ).toBe("Meal: none → Beef");
  });
});

describe("describeReplySource", () => {
  it("says where the change came from, with the reason for an override", () => {
    expect(describeReplySource({ source: "guest", reason: null })).toBe(
      "From the guest's own link",
    );
    expect(describeReplySource({ source: "couple", reason: null })).toBe(
      "Entered by you or your partner",
    );
    expect(describeReplySource({ source: "couple", reason: "Phoned us" })).toBe(
      "Entered by you or your partner: Phoned us",
    );
  });
});

describe("groupReplyChanges", () => {
  it("is newest first, grouped by event, and does not mutate its input", () => {
    const input = [
      change({ id: "a", eventId: "e1", occurredAt: "2027-01-01T10:00:00Z" }),
      change({ id: "b", eventId: "e2", occurredAt: "2027-01-03T10:00:00Z" }),
      change({ id: "c", eventId: "e1", occurredAt: "2027-01-02T10:00:00Z" }),
    ];
    const groups = groupReplyChanges(input);
    expect(groups.map((g) => g.eventId)).toEqual(["e2", "e1"]);
    expect(groups[1]!.changes.map((c) => c.id)).toEqual(["c", "a"]);
    expect(input.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });
  it("returns nothing for no changes", () => {
    expect(groupReplyChanges([])).toEqual([]);
  });
});
