import { describe, expect, it } from "vitest";
import {
  FLOOR_HEIGHT,
  FLOOR_WIDTH,
  centreRect,
  clampCentre,
  clampCorner,
  freeCorner,
  overlapNotes,
  overlaps,
  placeTables,
  tableSize,
  type FloorElement,
  type FloorTable,
} from "./floor";

const table = (id: string, over: Partial<FloorTable> = {}): FloorTable => ({
  id,
  label: `Table ${id}`,
  capacity: 8,
  shape: "round",
  x: null,
  y: null,
  ...over,
});
const element = (over: Partial<FloorElement> = {}): FloorElement => ({
  id: "e1",
  kind: "dance_floor",
  label: "Dance floor",
  x: 40,
  y: 20,
  w: 20,
  h: 20,
  ...over,
});

describe("tableSize", () => {
  it("grows with seats and is square for round tables", () => {
    const small = tableSize("round", 4);
    const large = tableSize("round", 12);
    expect(small.w).toBe(small.h);
    expect(large.w).toBeGreaterThan(small.w);
  });
  it("is longer than tall for rectangles and clamps seats to 1..50", () => {
    const rect = tableSize("rectangle", 10);
    expect(rect.w).toBeGreaterThan(rect.h);
    expect(tableSize("round", 0)).toEqual(tableSize("round", 1));
    expect(tableSize("round", 500)).toEqual(tableSize("round", 50));
  });
  it("keeps the smallest table big enough to tap on a phone at the base zoom", () => {
    // 720px across 120 units is 6px per unit; 44px needs about 7.3 units.
    expect(tableSize("round", 1).w).toBeGreaterThanOrEqual(7.5);
  });
});

describe("clamping", () => {
  it("keeps a whole table inside the room", () => {
    const size = tableSize("round", 10);
    const lo = clampCentre(size, -50, -50);
    expect(lo.x - size.w / 2).toBeGreaterThanOrEqual(0);
    expect(lo.y - size.h / 2).toBeGreaterThanOrEqual(0);
    const hi = clampCentre(size, 999, 999);
    expect(hi.x + size.w / 2).toBeLessThanOrEqual(FLOOR_WIDTH);
    expect(hi.y + size.h / 2).toBeLessThanOrEqual(FLOOR_HEIGHT);
    expect(Number.isInteger(lo.x) && Number.isInteger(hi.y)).toBe(true);
  });
  it("keeps an element's corner so it fits", () => {
    expect(clampCorner({ w: 20, h: 10 }, 500, 500)).toEqual({ x: 100, y: 70 });
    expect(clampCorner({ w: 20, h: 10 }, -3, -3)).toEqual({ x: 0, y: 0 });
  });
});

describe("overlaps", () => {
  it("treats touching edges as not overlapping", () => {
    expect(overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBe(false);
    expect(overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 9, y: 9, w: 10, h: 10 })).toBe(true);
  });
});

describe("placeTables", () => {
  it("keeps saved positions and lays out the rest without overlap", () => {
    const tables = [
      table("a", { x: 30, y: 30 }),
      table("b"),
      table("c"),
      table("d"),
      table("e", { shape: "rectangle", capacity: 10 }),
    ];
    const placed = placeTables(tables, [element()]);
    expect(placed[0]).toMatchObject({ id: "a", x: 30, y: 30, placed: true });
    expect(placed.slice(1).every((t) => !t.placed)).toBe(true);
    expect(overlapNotes(placed, [element()])).toEqual([]);
    for (const t of placed) {
      const r = centreRect(t.size, t.x, t.y);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(FLOOR_WIDTH);
      expect(r.y + r.h).toBeLessThanOrEqual(FLOOR_HEIGHT);
    }
  });
  it("is deterministic and preserves the input order", () => {
    const tables = [table("b"), table("a"), table("c")];
    const one = placeTables(tables, []);
    const two = placeTables(tables, []);
    expect(one).toEqual(two);
    expect(one.map((t) => t.id)).toEqual(["b", "a", "c"]);
  });
  it("pulls a saved position back inside the room when the table has grown", () => {
    const [t] = placeTables([table("a", { x: 119, y: 79, capacity: 50 })], []);
    const r = centreRect(t!.size, t!.x, t!.y);
    expect(r.x + r.w).toBeLessThanOrEqual(FLOOR_WIDTH);
    expect(r.y + r.h).toBeLessThanOrEqual(FLOOR_HEIGHT);
  });
  it("still shows every table when the room is full rather than dropping any", () => {
    const many = Array.from({ length: 100 }, (_, i) => table(String(i), { capacity: 20 }));
    const placed = placeTables(many, []);
    expect(placed).toHaveLength(100);
  });
});

describe("freeCorner", () => {
  it("finds room beside what is already there", () => {
    const tables = placeTables([table("a", { x: 10, y: 10 })], []);
    const spot = freeCorner({ w: 20, h: 10 }, tables, []);
    expect(overlaps({ ...spot, w: 20, h: 10 }, centreRect(tables[0]!.size, 10, 10))).toBe(false);
  });
  it("falls back to the corner when nothing is free", () => {
    const full = element({ x: 0, y: 0, w: 120, h: 80 });
    expect(freeCorner({ w: 10, h: 10 }, [], [full])).toEqual({ x: 0, y: 0 });
  });
});

describe("overlapNotes", () => {
  it("reports table on table and table on element, but not element on element", () => {
    const tables = placeTables(
      [table("a", { x: 50, y: 30 }), table("b", { x: 52, y: 30 }), table("c", { x: 100, y: 60 })],
      [],
    );
    const stage = element({ id: "s", label: "Stage", x: 45, y: 25, w: 20, h: 10 });
    const notes = overlapNotes(tables, [stage, element({ id: "x", x: 45, y: 25 })]);
    expect(notes).toContain("Table a and Table b overlap on the floor plan.");
    expect(notes).toContain("Table a overlaps Stage.");
    expect(notes.some((n) => n.includes("Table c"))).toBe(false);
    expect(notes.some((n) => n.includes("Dance floor") && n.includes("Stage"))).toBe(false);
  });
});
