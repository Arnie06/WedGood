import { describe, expect, it } from "vitest";
import { tableSize } from "./floor";
import type { TableSeat } from "./plan";
import { canvasChips, chipLayout, initials, tableSeats } from "./seats";

const seat = (id: string, name: string, n: number | null, tentative = false): TableSeat => ({
  guest: { id, name },
  tentative,
  seatNumber: n,
  captain: false,
  info: null,
});

describe("initials", () => {
  it("uses the first and last word, in capitals", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("ada")).toBe("A");
    expect(initials("  Mary Jane Watson ")).toBe("MW");
    expect(initials("élodie roux")).toBe("ÉR");
    expect(initials("Pat Quinn (child)")).toBe("PQ");
    expect(initials("(child)")).toBe("?");
  });
  it("never returns an empty string", () => {
    expect(initials("   ")).toBe("?");
  });
});

describe("tableSeats", () => {
  it("puts numbered guests in their seat and lists the rest by name", () => {
    const r = tableSeats({
      capacity: 4,
      seats: [seat("b", "Bea", 3), seat("z", "Zed", null), seat("a", "Al", null)],
    });
    expect(r.slots.map((s) => s.occupant?.guest.name ?? null)).toEqual([null, null, "Bea", null]);
    expect(r.unnumbered.map((s) => s.guest.name)).toEqual(["Al", "Zed"]);
  });
  it("treats a number outside the table, or repeated, as unnumbered rather than hiding the guest", () => {
    const r = tableSeats({
      capacity: 2,
      seats: [seat("a", "Al", 5), seat("b", "Bea", 1), seat("c", "Cy", 1)],
    });
    expect(r.slots.map((s) => s.occupant?.guest.name ?? null)).toEqual(["Bea", null]);
    expect(r.unnumbered.map((s) => s.guest.name)).toEqual(["Al", "Cy"]);
  });
  it("has no slots for a table of no seats", () => {
    expect(tableSeats({ capacity: 0, seats: [] }).slots).toEqual([]);
  });
});

describe("canvasChips", () => {
  it("draws one chip per seat and fills empty seats with unnumbered guests so the count matches", () => {
    const chips = canvasChips({
      capacity: 4,
      seats: [
        seat("a", "Al Zed", 2),
        seat("b", "Bea Cole", null),
        seat("c", "Cy Dunn", null, true),
      ],
    });
    expect(chips).toHaveLength(4);
    expect(chips.map((c) => c.state)).toEqual(["seated", "seated", "waiting", "empty"]);
    expect(chips.map((c) => c.initials)).toEqual(["BC", "AZ", "CD", null]);
  });
});

describe("chipLayout", () => {
  it("returns one spot per seat, clockwise from the top for a round table", () => {
    const size = tableSize("round", 8);
    const { spots } = chipLayout("round", 8, size);
    expect(spots).toHaveLength(8);
    expect(spots[0]!.dx).toBeCloseTo(0);
    expect(spots[0]!.dy).toBeLessThan(0);
    expect(spots[2]!.dx).toBeGreaterThan(0); // quarter turn: right-hand side
    expect(spots[2]!.dy).toBeCloseTo(0);
    expect(spots[4]!.dy).toBeGreaterThan(0); // half turn: bottom
  });
  it("seats a rectangle on its long sides, top left to right then bottom right to left", () => {
    const size = tableSize("rectangle", 8);
    const { spots } = chipLayout("rectangle", 8, size);
    expect(spots).toHaveLength(8);
    expect(spots.slice(0, 4).every((s) => s.dy < 0)).toBe(true);
    expect(spots.slice(4).every((s) => s.dy > 0)).toBe(true);
    expect(spots[0]!.dx).toBeLessThan(spots[3]!.dx);
    expect(spots[4]!.dx).toBeGreaterThan(spots[7]!.dx);
  });
  it("handles an odd count and a single seat", () => {
    expect(chipLayout("rectangle", 5, tableSize("rectangle", 5)).spots).toHaveLength(5);
    expect(chipLayout("round", 1, tableSize("round", 1)).spots).toHaveLength(1);
    expect(chipLayout("round", 0, tableSize("round", 1)).spots).toEqual([]);
  });
  it("shrinks chips on a big table so they stay inside their share of the rim", () => {
    const small = chipLayout("round", 8, tableSize("round", 8)).diameter;
    const big = chipLayout("round", 50, tableSize("round", 50)).diameter;
    expect(small).toBe(2.8);
    expect(big).toBeLessThan(small);
    expect(big).toBeGreaterThan(0);
  });
});
