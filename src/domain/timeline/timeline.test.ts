import { describe, expect, it } from "vitest";
import { findResourceConflicts, parseTimelineInput, sortAgenda, type AgendaItem } from "./timeline";
import { instantToLocal, localToInstant } from "./zoned";

const NY = "America/New_York";

describe("localToInstant", () => {
  it("resolves an ordinary local time using the zone's offset", () => {
    const r = localToInstant("2027-06-12", "16:30", NY);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.instant.toISOString()).toBe("2027-06-12T20:30:00.000Z");
  });
  it("uses standard offset in winter", () => {
    const r = localToInstant("2027-01-15", "16:30", NY);
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.instant.toISOString()).toBe("2027-01-15T21:30:00.000Z");
  });
  it("reports a nonexistent time in the spring-forward gap", () => {
    expect(localToInstant("2027-03-14", "02:30", NY).kind).toBe("nonexistent");
  });
  it("reports an ambiguous time in the fall-back repeat", () => {
    const r = localToInstant("2027-11-07", "01:30", NY);
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(r.later.getTime() - r.earlier.getTime()).toBe(3_600_000);
    }
  });
  it("accepts times either side of a transition", () => {
    expect(localToInstant("2027-03-14", "01:59", NY).kind).toBe("ok");
    expect(localToInstant("2027-03-14", "03:00", NY).kind).toBe("ok");
    expect(localToInstant("2027-11-07", "02:00", NY).kind).toBe("ok");
  });
  it("rejects impossible dates, times and zones", () => {
    expect(localToInstant("2027-02-30", "10:00", NY).kind).toBe("invalid");
    expect(localToInstant("2027-02-10", "24:00", NY).kind).toBe("invalid");
    expect(localToInstant("2027-02-10", "10:00", "Not/AZone").kind).toBe("invalid");
  });
  it("round-trips through instantToLocal", () => {
    const r = localToInstant("2027-09-04", "23:45", "Asia/Kolkata");
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(instantToLocal(r.instant, "Asia/Kolkata")).toEqual({
      date: "2027-09-04",
      time: "23:45",
    });
  });
});

describe("parseTimelineInput", () => {
  const base = { title: " Ceremony ", date: "2027-06-12", startTime: "16:00" };
  it("parses a minimal item with no end", () => {
    const r = parseTimelineInput(base, NY);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.title).toBe("Ceremony");
      expect(r.value.endsAt).toBeNull();
      expect(r.value.status).toBe("scheduled");
    }
  });
  it("supports cross-midnight with an explicit end date", () => {
    const r = parseTimelineInput(
      { ...base, startTime: "22:00", endDate: "2027-06-13", endTime: "01:00" },
      NY,
    );
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(Date.parse(r.value.endsAt!) - Date.parse(r.value.startsAt)).toBe(3 * 3_600_000);
  });
  it("rejects an end before the start and explains midnight", () => {
    const r = parseTimelineInput({ ...base, startTime: "22:00", endTime: "01:00" }, NY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fieldErrors.endTime).toContain("next day");
  });
  it("allows a zero-length item", () => {
    expect(parseTimelineInput({ ...base, endTime: "16:00" }, NY).ok).toBe(true);
  });
  it("requires title, date and start", () => {
    const r = parseTimelineInput({}, NY);
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(Object.keys(r.fieldErrors)).toEqual(
        expect.arrayContaining(["title", "date", "startTime"]),
      );
  });
  it("rejects nonexistent and ambiguous local times", () => {
    const gap = parseTimelineInput({ ...base, date: "2027-03-14", startTime: "02:30" }, NY);
    const dup = parseTimelineInput({ ...base, date: "2027-11-07", startTime: "01:30" }, NY);
    expect(!gap.ok && gap.fieldErrors.startTime).toContain("doesn't exist");
    expect(!dup.ok && dup.fieldErrors.startTime).toContain("twice");
  });
  it("rejects an end date without an end time and over-long text", () => {
    expect(parseTimelineInput({ ...base, endDate: "2027-06-13" }, NY).ok).toBe(false);
    expect(parseTimelineInput({ ...base, title: "x".repeat(161) }, NY).ok).toBe(false);
    expect(parseTimelineInput({ ...base, notes: "x".repeat(2001) }, NY).ok).toBe(false);
  });
  it("treats a missing or blank status as scheduled and rejects unknown ones", () => {
    const blank = parseTimelineInput({ ...base, status: "" }, NY);
    expect(blank.ok && blank.value.status).toBe("scheduled");
    expect(parseTimelineInput({ ...base, status: "live" }, NY).ok).toBe(false);
  });
  it("rejects malformed resource ids", () => {
    expect(parseTimelineInput({ ...base, vendor: "nope" }, NY).ok).toBe(false);
  });
});

const item = (
  id: string,
  s: string,
  e: string | null,
  extra: Partial<AgendaItem> = {},
): AgendaItem => ({
  id,
  title: id,
  startsAt: `2027-06-12T${s}:00Z`,
  endsAt: e ? `2027-06-12T${e}:00Z` : null,
  timezone: NY,
  status: "scheduled",
  assigneeUserId: null,
  vendorId: null,
  responsibleLabel: null,
  ...extra,
});

describe("sortAgenda", () => {
  it("orders by start, end, then id", () => {
    const sorted = sortAgenda([
      item("c", "12:00", null),
      item("b", "10:00", "11:00"),
      item("a", "10:00", "10:30"),
    ]);
    expect(sorted.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });
});

describe("findResourceConflicts", () => {
  it("does not warn when unrelated items overlap", () => {
    expect(
      findResourceConflicts([item("a", "10:00", "12:00"), item("b", "11:00", "13:00")]),
    ).toEqual([]);
  });
  it("warns when the same member is double booked", () => {
    const w = findResourceConflicts([
      item("a", "10:00", "12:00", { assigneeUserId: "u1" }),
      item("b", "11:00", "13:00", { assigneeUserId: "u1" }),
    ]);
    expect(w).toEqual([{ aId: "a", bId: "b", shared: "person" }]);
  });
  it("warns for the same vendor and for the same named person, ignoring case", () => {
    expect(
      findResourceConflicts([
        item("a", "10:00", "12:00", { vendorId: "v" }),
        item("b", "11:00", "13:00", { vendorId: "v" }),
      ])[0]?.shared,
    ).toBe("vendor");
    expect(
      findResourceConflicts([
        item("a", "10:00", "12:00", { responsibleLabel: "Maid of Honor" }),
        item("b", "11:00", "13:00", { responsibleLabel: "maid of honor" }),
      ])[0]?.shared,
    ).toBe("responsible");
  });
  it("treats back-to-back items as a handoff, not an overlap", () => {
    expect(
      findResourceConflicts([
        item("a", "10:00", "11:00", { vendorId: "v" }),
        item("b", "11:00", "12:00", { vendorId: "v" }),
      ]),
    ).toEqual([]);
  });
  it("flags a point-in-time item inside the same resource's range", () => {
    expect(
      findResourceConflicts([
        item("a", "10:00", "12:00", { vendorId: "v" }),
        item("b", "11:00", null, { vendorId: "v" }),
      ]),
    ).toHaveLength(1);
  });
  it("ignores cancelled items", () => {
    expect(
      findResourceConflicts([
        item("a", "10:00", "12:00", { vendorId: "v", status: "cancelled" }),
        item("b", "11:00", "13:00", { vendorId: "v" }),
      ]),
    ).toEqual([]);
  });
});
