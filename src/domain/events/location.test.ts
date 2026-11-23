import { describe, expect, it } from "vitest";
import {
  agendaNamingVenue,
  capacityFit,
  effectiveCapacity,
  fitSentence,
  locationImpact,
  rewritePlace,
  validateSpace,
  type LocationChoice,
} from "./location";

const venue = { seatedCapacity: 140, ceremonyCapacity: 90, archived: false };
const space = { seatedCapacity: 110, archived: false };

describe("effectiveCapacity", () => {
  it("prefers the event's own number over the space and the venue", () => {
    expect(effectiveCapacity({ eventCapacity: 100, eventKind: "reception", venue, space })).toEqual(
      { value: 100, source: "event" },
    );
  });
  it("uses the space, then the venue", () => {
    expect(
      effectiveCapacity({ eventCapacity: null, eventKind: "reception", venue, space }),
    ).toEqual({ value: 110, source: "space" });
    expect(
      effectiveCapacity({
        eventCapacity: null,
        eventKind: "reception",
        venue,
        space: { seatedCapacity: null, archived: false },
      }),
    ).toEqual({ value: 140, source: "venue" });
    expect(
      effectiveCapacity({ eventCapacity: null, eventKind: "reception", venue, space: null }),
    ).toEqual({ value: 140, source: "venue" });
  });
  it("ceremonies prefer the venue's ceremony capacity, falling back to seated", () => {
    expect(
      effectiveCapacity({ eventCapacity: null, eventKind: "ceremony", venue, space: null }),
    ).toEqual({ value: 90, source: "venue" });
    expect(
      effectiveCapacity({
        eventCapacity: null,
        eventKind: "ceremony",
        venue: { ...venue, ceremonyCapacity: null },
        space: null,
      }),
    ).toEqual({ value: 140, source: "venue" });
  });
  it("is unknown, not zero, when nothing is entered", () => {
    expect(
      effectiveCapacity({
        eventCapacity: null,
        eventKind: "reception",
        venue: { seatedCapacity: null, ceremonyCapacity: null, archived: false },
        space: null,
      }),
    ).toBeNull();
    expect(
      effectiveCapacity({ eventCapacity: null, eventKind: "reception", venue: null, space: null }),
    ).toBeNull();
  });
  it("gives nothing from an archived venue or space (a stale choice), but the event's own number stands", () => {
    expect(
      effectiveCapacity({
        eventCapacity: null,
        eventKind: "reception",
        venue: { ...venue, archived: true },
        space: null,
      }),
    ).toBeNull();
    expect(
      effectiveCapacity({
        eventCapacity: null,
        eventKind: "reception",
        venue,
        space: { seatedCapacity: 110, archived: true },
      }),
    ).toBeNull();
    expect(
      effectiveCapacity({
        eventCapacity: 80,
        eventKind: "reception",
        venue: { ...venue, archived: true },
        space: null,
      }),
    ).toEqual({ value: 80, source: "event" });
  });
});

describe("capacityFit", () => {
  const cap = { value: 110, source: "space" as const };
  it("fits with room, exactly at capacity, and short by one", () => {
    expect(capacityFit(100, cap)).toEqual({
      state: "fits",
      capacity: 110,
      planning: 100,
      spare: 10,
    });
    expect(capacityFit(110, cap)).toEqual({
      state: "fits",
      capacity: 110,
      planning: 110,
      spare: 0,
    });
    expect(capacityFit(111, cap)).toEqual({
      state: "short",
      capacity: 110,
      planning: 111,
      shortBy: 1,
    });
  });
  it("is unknown without a capacity or a count, and zero guests fits", () => {
    expect(capacityFit(100, null)).toEqual({ state: "unknown", reason: "no_capacity" });
    expect(capacityFit(null, cap)).toEqual({ state: "unknown", reason: "no_count" });
    expect(capacityFit(0, cap).state).toBe("fits");
  });
  it("says it in words", () => {
    expect(fitSentence(capacityFit(110, { value: 140, source: "venue" }))).toBe("Fits 110 of 140");
    expect(fitSentence(capacityFit(152, { value: 140, source: "venue" }))).toBe(
      "Short by 12: planning for 152, room for 140",
    );
  });
});

describe("rewritePlace", () => {
  it("replaces the first occurrence, ignoring case, keeping the rest", () => {
    expect(rewritePlace("Garden terrace at old barn", "Old Barn", "Rose Hall")).toBe(
      "Garden terrace at Rose Hall",
    );
    expect(rewritePlace("Old Barn, Old Barn lawn", "old barn", "X")).toBe("X, Old Barn lawn");
  });
  it("returns null when the place does not name the venue or the result is too long", () => {
    expect(rewritePlace("The lawn", "Old Barn", "Rose Hall")).toBeNull();
    expect(rewritePlace(null, "Old Barn", "Rose Hall")).toBeNull();
    expect(rewritePlace("Old Barn", "  ", "X")).toBeNull();
    expect(
      rewritePlace(`Old Barn ${"x".repeat(190)}`, "Old Barn", "A much longer venue name"),
    ).toBeNull();
  });
});

describe("locationImpact", () => {
  const choice = (
    venueId: string | null,
    spaceId: string | null,
    capacity: number | null,
    names: [string | null, string | null] = [venueId ? `Venue ${venueId}` : null, null],
  ): LocationChoice => ({
    venueId,
    venueName: names[0],
    spaceId,
    spaceName: names[1],
    capacity: capacity === null ? null : { value: capacity, source: "venue" },
  });
  const agenda = [
    { id: "a", title: "Dinner", location: "Venue A terrace" },
    { id: "b", title: "Toast", location: "Lawn" },
    { id: "c", title: "Cake", location: null },
  ];

  it("lists nothing when nothing changes", () => {
    expect(
      locationImpact({
        from: choice("A", null, 120),
        to: choice("A", null, 120),
        tableSeats: 130,
        planning: 140,
        agenda,
        oldVenueBooked: true,
      }),
    ).toEqual([]);
  });

  it("warns about tables over the new capacity, a short planning number, agenda places and a booking", () => {
    const lines = locationImpact({
      from: choice("A", null, 140),
      to: choice("B", null, 100),
      tableSeats: 120,
      planning: 110,
      agenda,
      oldVenueBooked: true,
    });
    expect(lines.map((l) => l.id)).toEqual(["tables", "planning", "agenda", "booking"]);
    expect(lines[0]?.text).toContain("120");
    expect(lines[0]?.text).toContain("20 more");
    expect(lines[1]?.text).toContain("short by 10");
    expect(lines[2]?.text).toBe("1 agenda place names Venue A.");
    expect(lines[3]?.tone).toBe("warning");
  });

  it("tables exactly at the new capacity are not a problem; planning that fits is reported calmly", () => {
    const lines = locationImpact({
      from: choice("A", null, 140),
      to: choice("B", null, 120),
      tableSeats: 120,
      planning: 100,
      agenda: [],
      oldVenueBooked: false,
    });
    expect(lines.map((l) => l.id)).toEqual(["planning"]);
    expect(lines[0]?.tone).toBe("info");
  });

  it("says so when the new place has no capacity, and does not guess", () => {
    const lines = locationImpact({
      from: choice("A", null, 140),
      to: choice("B", null, null),
      tableSeats: 500,
      planning: 500,
      agenda: [],
      oldVenueBooked: false,
    });
    expect(lines.map((l) => l.id)).toEqual(["capacity-unknown"]);
  });

  it("a space change within a venue never offers agenda rewrites or booking reminders", () => {
    const lines = locationImpact({
      from: choice("A", "s1", 140, ["Venue A", "Hall"]),
      to: choice("A", "s2", 80, ["Venue A", "Terrace"]),
      tableSeats: 100,
      planning: 90,
      agenda,
      oldVenueBooked: true,
    });
    expect(lines.map((l) => l.id)).toEqual(["space", "tables", "planning"]);
    expect(lines[0]?.text).toBe("Moves from Hall to Terrace.");
  });

  it("clearing the place reminds about the booking but invents no capacity", () => {
    const lines = locationImpact({
      from: choice("A", null, 140),
      to: choice(null, null, null),
      tableSeats: 100,
      planning: 90,
      agenda,
      oldVenueBooked: true,
    });
    expect(lines.map((l) => l.id)).toEqual(["cleared", "booking"]);
  });

  it("agendaNamingVenue skips cancelled-looking nulls and unrelated places", () => {
    expect(agendaNamingVenue(agenda, "Venue A", "Venue B").map((i) => i.id)).toEqual(["a"]);
  });
});

describe("validateSpace", () => {
  it("accepts a name alone, trims, and keeps unknown capacity null", () => {
    expect(
      validateSpace({
        name: "  Garden  terrace ",
        seatedCapacity: "",
        standingCapacity: "",
        notes: "",
      }),
    ).toEqual({
      ok: true,
      input: { name: "Garden terrace", seatedCapacity: null, standingCapacity: null, notes: null },
    });
  });
  it("rejects a missing name, zero, decimals, negatives, too large and long notes", () => {
    const r = validateSpace({
      name: " ",
      seatedCapacity: "0",
      standingCapacity: "1.5",
      notes: "x".repeat(501),
    });
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(Object.keys(r.errors).sort()).toEqual([
        "name",
        "notes",
        "seatedCapacity",
        "standingCapacity",
      ]);
    const big = validateSpace({
      name: "A",
      seatedCapacity: "100001",
      standingCapacity: "-3",
      notes: "",
    });
    expect(big.ok).toBe(false);
  });
  it("accepts the boundaries 1 and 100000", () => {
    expect(
      validateSpace({ name: "A", seatedCapacity: "1", standingCapacity: "100000", notes: "" }).ok,
    ).toBe(true);
  });
});
