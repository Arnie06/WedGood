import { describe, expect, it } from "vitest";
import { endOfLocalDay } from "@/domain/timeline/zoned";
import { zonedDay } from "./reply-by";

describe("zonedDay", () => {
  const laEnd = endOfLocalDay("2027-05-01", "America/Los_Angeles")!.toISOString();

  it("shows the date picked in the event's zone, whatever UTC says", () => {
    // 1 May 23:59:59 Pacific is already 2 May in UTC.
    expect(zonedDay(laEnd, "America/Los_Angeles", null)).toEqual({
      date: "May 1, 2027",
      zone: null,
    });
    const tokyoEnd = endOfLocalDay("2027-05-01", "Asia/Tokyo")!.toISOString();
    expect(zonedDay(tokyoEnd, "Asia/Tokyo", null).date).toBe("May 1, 2027");
  });

  it("names the zone only when the viewer's clock differs", () => {
    expect(zonedDay(laEnd, "America/Los_Angeles", "America/Los_Angeles").zone).toBeNull();
    // An alias on the same clock is not a different zone.
    expect(zonedDay(laEnd, "America/Los_Angeles", "US/Pacific").zone).toBeNull();
    expect(zonedDay(laEnd, "America/Los_Angeles", "Europe/London")).toEqual({
      date: "May 1, 2027",
      zone: "Pacific Time",
    });
  });

  it("supports a short month", () => {
    expect(zonedDay(laEnd, "America/Los_Angeles", null, "short").date).toBe("May 1, 2027");
    const jan = endOfLocalDay("2027-01-15", "Europe/Paris")!.toISOString();
    expect(zonedDay(jan, "Europe/Paris", null, "short").date).toBe("Jan 15, 2027");
  });

  it("shows a link made before UX-04 (23:59:59 UTC) on its true local date", () => {
    // Existing rows are not rewritten; in Tokyo that instant is already the next morning.
    expect(zonedDay("2027-05-01T23:59:59Z", "Asia/Tokyo", null).date).toBe("May 2, 2027");
    expect(zonedDay("2027-05-01T23:59:59Z", "America/New_York", null).date).toBe("May 1, 2027");
  });
});
