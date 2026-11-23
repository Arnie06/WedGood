import { describe, expect, it } from "vitest";
import { guestCalendarEntries, guestCalendarFile } from "./guest";

const now = new Date("2026-11-23T10:00:00Z");

describe("guestCalendarEntries", () => {
  it("keeps only attended events that have a date, in date order", () => {
    const entries = guestCalendarEntries([
      { name: "Reception", localDate: "2027-06-12", attending: true },
      { name: "Welcome drinks", localDate: "2027-06-11", attending: true },
      { name: "Brunch", localDate: "2027-06-13", attending: false },
      { name: "Ceremony", localDate: null, attending: true },
    ]);
    expect(entries.map((e) => e.title)).toEqual(["Welcome drinks", "Reception"]);
    expect(entries.every((e) => e.kind === "allDay")).toBe(true);
  });

  it("builds a stable UID from the date and name only", () => {
    const [a] = guestCalendarEntries([
      { name: "Reception & Dinner!", localDate: "2027-06-12", attending: true },
    ]);
    expect(a?.uid).toBe("guest-2027-06-12-reception-dinner@wedding-workspace");
  });

  it("ignores malformed dates instead of throwing", () => {
    expect(guestCalendarEntries([{ name: "X", localDate: "12/06/2027", attending: true }])).toEqual(
      [],
    );
  });

  it("drops exact duplicates", () => {
    const e = { name: "Reception", localDate: "2027-06-12", attending: true };
    expect(guestCalendarEntries([e, e])).toHaveLength(1);
  });
});

describe("guestCalendarFile", () => {
  it("returns null when nothing is attended", () => {
    expect(
      guestCalendarFile("A & B", [{ name: "R", localDate: "2027-06-12", attending: false }], now),
    ).toBeNull();
  });

  it("writes an all-day event and nothing about the guest", () => {
    const out = guestCalendarFile(
      "Alex & Morgan",
      [{ name: "Reception", localDate: "2027-06-12", attending: true }],
      now,
    );
    expect(out).toContain("DTSTART;VALUE=DATE:20270612");
    expect(out).toContain("DTEND;VALUE=DATE:20270613");
    expect(out).toContain("X-WR-CALNAME:Alex & Morgan");
    expect(out).not.toMatch(/ATTENDEE|ORGANIZER|rsvp/i);
  });
});
