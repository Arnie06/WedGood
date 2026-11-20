import { describe, expect, it } from "vitest";
import { buildHomeSummary } from "./home-summary";
import { sampleWorkspace } from "./sample-workspace";

describe("buildHomeSummary (sample workspace)", () => {
  const summary = buildHomeSummary(sampleWorkspace);

  it("is explicitly synthetic", () => {
    expect(sampleWorkspace.synthetic).toBe(true);
    expect(sampleWorkspace.guests.every((guest) => guest.name.endsWith("Example"))).toBe(true);
  });

  it("matches the documented demo scenario", () => {
    expect(summary.daysToGo).toBe(184);
    expect(summary.budget).toMatchObject({
      committedMinor: 1_000_000,
      netPaidMinor: 250_000,
      outstandingMinor: 750_000,
      targetMinor: 4_000_000,
    });
    expect(summary.primaryEvent.responses).toMatchObject({ accepted: 4, pending: 1, declined: 1 });
    expect(summary.primaryEvent.meals).toEqual([
      { name: "Chicken", count: 1 },
      { name: "Vegetarian", count: 2 },
      { name: "Fish", count: 1 },
    ]);
  });

  it("orders next steps by due date with undated tasks last", () => {
    expect(summary.tasks.next.map((task) => task.id)).toEqual(["t-guests", "t-photo", "t-save"]);
    expect(summary.tasks).toMatchObject({ done: 2, total: 7 });
  });

  it("keeps each guest's events independent", () => {
    const rehearsal = sampleWorkspace.events[1];
    expect(rehearsal?.responses.find((r) => r.guestId === "g-jordan")?.rsvpStatus).toBe("pending");
  });
});
