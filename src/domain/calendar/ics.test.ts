import { describe, expect, it } from "vitest";
import { buildIcs, escapeIcsText, foldIcsLine, type IcsEntry } from "./ics";

const now = new Date("2026-11-20T10:00:00Z");
const opts = { calendarName: "Alex & Morgan", now };

describe("escapeIcsText", () => {
  it("escapes separators, backslashes and newlines and drops control characters", () => {
    expect(escapeIcsText("a;b,c\\d\ne\u0000f")).toBe("a\\;b\\,c\\\\d\\nef");
  });
  it("prevents a value from injecting a new property line", () => {
    const out = buildIcs(
      [
        {
          kind: "allDay",
          uid: "u1",
          title: "Hi\r\nATTENDEE:mailto:x@example.test",
          date: "2027-06-12",
          description: null,
          sequence: 0,
        },
      ],
      opts,
    );
    expect(out).not.toMatch(/\r\nATTENDEE:/);
    expect(out).toContain("SUMMARY:Hi\\nATTENDEE:mailto:x@example.test");
  });
});

describe("foldIcsLine", () => {
  it("leaves short lines alone", () => {
    expect(foldIcsLine("SUMMARY:Short")).toBe("SUMMARY:Short");
  });
  it("folds long lines to at most 75 octets and round-trips", () => {
    const line = `SUMMARY:${"é".repeat(120)}`;
    const folded = foldIcsLine(line);
    for (const part of folded.split("\r\n")) {
      expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
    }
    expect(folded.replace(/\r\n /g, "")).toBe(line);
  });
});

describe("buildIcs", () => {
  const timed: IcsEntry = {
    kind: "timed",
    uid: "t1@wedding.example",
    title: "First dance",
    startsAt: "2027-06-12T21:30:00.000Z",
    endsAt: "2027-06-12T21:45:00.000Z",
    location: "Main hall, Floor 1",
    description: null,
    sequence: 2,
  };
  const allDay: IcsEntry = {
    kind: "allDay",
    uid: "e1@wedding.example",
    title: "Ceremony",
    date: "2027-12-31",
    description: "All-day placeholder",
    sequence: 0,
  };

  it("writes a CRLF calendar with UTC times, escaped text and exclusive all-day end", () => {
    const out = buildIcs([timed, allDay], opts);
    expect(out.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(out.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(out).not.toMatch(/[^\r]\n/);
    expect(out).toContain("DTSTAMP:20261120T100000Z");
    expect(out).toContain("DTSTART:20270612T213000Z");
    expect(out).toContain("DTEND:20270612T214500Z");
    expect(out).toContain("LOCATION:Main hall\\, Floor 1");
    expect(out).toContain("DTSTART;VALUE=DATE:20271231");
    expect(out).toContain("DTEND;VALUE=DATE:20280101"); // crosses the year boundary
    expect(out).toContain("SEQUENCE:2");
    expect(out).toContain("X-WR-CALNAME:Alex & Morgan");
  });

  it("omits DTEND for a timed entry without an end instead of inventing one", () => {
    const out = buildIcs([{ ...timed, endsAt: null }], opts);
    expect(out).not.toContain("DTEND");
  });

  it("produces an empty but valid calendar for no entries", () => {
    const out = buildIcs([], opts);
    expect(out).not.toContain("BEGIN:VEVENT");
    expect(out).toContain("END:VCALENDAR");
  });

  it("rejects impossible dates and instants rather than writing a wrong day", () => {
    expect(() => buildIcs([{ ...allDay, kind: "allDay", date: "2027-02-30" }], opts)).toThrow();
    expect(() => buildIcs([{ ...timed, startsAt: "not a date" }], opts)).toThrow();
  });
});
