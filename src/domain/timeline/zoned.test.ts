import { describe, expect, it } from "vitest";
import { endOfLocalDay, instantToLocal } from "./zoned";

const iso = (d: Date | null) => d?.toISOString() ?? null;

describe("endOfLocalDay", () => {
  it("closes at the end of the day west of UTC", () => {
    expect(iso(endOfLocalDay("2027-05-01", "America/Los_Angeles"))).toBe(
      "2027-05-02T06:59:59.000Z",
    );
    expect(iso(endOfLocalDay("2027-05-01", "Pacific/Honolulu"))).toBe("2027-05-02T09:59:59.000Z");
  });

  it("closes at the end of the day east of UTC", () => {
    expect(iso(endOfLocalDay("2027-05-01", "Asia/Tokyo"))).toBe("2027-05-01T14:59:59.000Z");
    expect(iso(endOfLocalDay("2027-05-01", "Asia/Kolkata"))).toBe("2027-05-01T18:29:59.000Z");
    expect(iso(endOfLocalDay("2027-05-01", "Pacific/Kiritimati"))).toBe("2027-05-01T09:59:59.000Z");
  });

  it("is 23:59:59 in UTC itself", () => {
    expect(iso(endOfLocalDay("2027-05-01", "UTC"))).toBe("2027-05-01T23:59:59.000Z");
  });

  it("uses the offset in force at the end of a DST-change day", () => {
    // Spring forward on 14 March 2027: the day ends on daylight time.
    expect(iso(endOfLocalDay("2027-03-14", "America/Los_Angeles"))).toBe(
      "2027-03-15T06:59:59.000Z",
    );
    // Fall back on 7 November 2027: the day ends on standard time.
    expect(iso(endOfLocalDay("2027-11-07", "America/Los_Angeles"))).toBe(
      "2027-11-08T07:59:59.000Z",
    );
    // London's last day before summer time, and the day it starts.
    expect(iso(endOfLocalDay("2027-03-27", "Europe/London"))).toBe("2027-03-27T23:59:59.000Z");
    expect(iso(endOfLocalDay("2027-03-28", "Europe/London"))).toBe("2027-03-28T22:59:59.000Z");
  });

  it("handles a zone whose clocks jump at midnight", () => {
    // Beirut skips from 00:00 to 01:00 on 28 March 2027, so 27 March ends at 23:59:59 EET.
    const end = endOfLocalDay("2027-03-27", "Asia/Beirut");
    expect(iso(end)).toBe("2027-03-27T21:59:59.000Z");
    expect(instantToLocal(end!, "Asia/Beirut").date).toBe("2027-03-27");
    expect(instantToLocal(new Date(end!.getTime() + 1000), "Asia/Beirut").date).toBe("2027-03-28");
  });

  it("always lands on the chosen local date, one second before the next", () => {
    for (const zone of ["America/New_York", "Europe/Paris", "Australia/Sydney", "Asia/Kathmandu"]) {
      for (const date of ["2027-01-01", "2027-04-04", "2027-10-03", "2027-12-31"]) {
        const end = endOfLocalDay(date, zone)!;
        expect(instantToLocal(end, zone)).toEqual({ date, time: "23:59" });
        expect(instantToLocal(new Date(end.getTime() + 1000), zone).date).not.toBe(date);
      }
    }
  });

  it("rejects dates and zones that are not real", () => {
    expect(endOfLocalDay("2027-02-30", "UTC")).toBeNull();
    expect(endOfLocalDay("1 May", "UTC")).toBeNull();
    expect(endOfLocalDay("2027-05-01", "Mars/Olympus")).toBeNull();
  });
});
