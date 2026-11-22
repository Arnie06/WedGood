/**
 * Pure floor-plan geometry (ADR-030, SEAT-2). The room is an abstract grid, 120 x 80 units, in the
 * same units the database bounds-checks. It is a sketch to plan with: no real-world scale, and no
 * clearance, aisle-width or fire-code claim is made anywhere (docs/07).
 *
 * A table's position is its centre; an element's position is its top-left corner. Sizes of tables
 * follow from their seat count and shape and are not stored.
 */
import type { TableShape } from "./plan";

export const FLOOR_WIDTH = 120;
export const FLOOR_HEIGHT = 80;

export type ElementKind =
  | "dance_floor"
  | "stage"
  | "head_table"
  | "bar"
  | "buffet"
  | "entrance"
  | "dj"
  | "cake"
  | "photo"
  | "other";

export const ELEMENT_KINDS: readonly {
  kind: ElementKind;
  name: string;
  w: number;
  h: number;
}[] = [
  { kind: "dance_floor", name: "Dance floor", w: 22, h: 22 },
  { kind: "stage", name: "Stage", w: 24, h: 10 },
  { kind: "head_table", name: "Head table", w: 28, h: 7 },
  { kind: "bar", name: "Bar", w: 16, h: 6 },
  { kind: "buffet", name: "Buffet", w: 20, h: 6 },
  { kind: "entrance", name: "Entrance", w: 12, h: 4 },
  { kind: "dj", name: "DJ or band", w: 12, h: 8 },
  { kind: "cake", name: "Cake", w: 6, h: 6 },
  { kind: "photo", name: "Photo area", w: 14, h: 10 },
  { kind: "other", name: "Other", w: 14, h: 8 },
];

export const isElementKind = (v: string): v is ElementKind =>
  ELEMENT_KINDS.some((k) => k.kind === v);
export const elementKindName = (kind: ElementKind): string =>
  ELEMENT_KINDS.find((k) => k.kind === kind)?.name ?? "Other";

export type Size = { w: number; h: number };
export type Rect = { x: number; y: number; w: number; h: number };

/** On-canvas size of a table, in grid units, from its shape and seat count. */
export function tableSize(shape: TableShape, capacity: number): Size {
  const seats = Math.min(50, Math.max(1, capacity));
  if (shape === "rectangle") return { w: round1(10 + seats * 0.7), h: 8 };
  const d = round1(8 + seats * 0.4);
  return { w: d, h: d };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Nearest whole-unit centre that keeps a table of this size inside the room. */
export function clampCentre(size: Size, x: number, y: number): { x: number; y: number } {
  return {
    x: Math.round(clamp(x, Math.ceil(size.w / 2), Math.floor(FLOOR_WIDTH - size.w / 2))),
    y: Math.round(clamp(y, Math.ceil(size.h / 2), Math.floor(FLOOR_HEIGHT - size.h / 2))),
  };
}

/** Nearest whole-unit top-left corner that keeps an element of this size inside the room. */
export function clampCorner(size: Size, x: number, y: number): { x: number; y: number } {
  return {
    x: Math.round(clamp(x, 0, FLOOR_WIDTH - size.w)),
    y: Math.round(clamp(y, 0, FLOOR_HEIGHT - size.h)),
  };
}

export const centreRect = (size: Size, x: number, y: number): Rect => ({
  x: x - size.w / 2,
  y: y - size.h / 2,
  w: size.w,
  h: size.h,
});

/** True when the two rectangles share any area (touching edges is not overlap). */
export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export type FloorTable = {
  id: string;
  label: string;
  capacity: number;
  shape: TableShape;
  x: number | null;
  y: number | null;
};
export type FloorElement = {
  id: string;
  kind: ElementKind;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
};
export type PlacedTable = FloorTable & { x: number; y: number; size: Size; placed: boolean };

/**
 * Gives every table a position. Tables with a saved position keep it (clamped into the room in case
 * their seat count changed). The rest are laid out left to right, top to bottom, in the first
 * free gaps, so a brand new or imported plan opens tidy. These positions are only shown; nothing is
 * saved until someone moves a table.
 */
export function placeTables(
  tables: readonly FloorTable[],
  elements: readonly FloorElement[],
): PlacedTable[] {
  const blocked: Rect[] = elements.map((e) => ({ x: e.x, y: e.y, w: e.w, h: e.h }));
  const out = new Map<string, PlacedTable>();
  for (const t of tables) {
    if (t.x === null || t.y === null) continue;
    const size = tableSize(t.shape, t.capacity);
    const c = clampCentre(size, t.x, t.y);
    out.set(t.id, { ...t, ...c, size, placed: true });
    blocked.push(centreRect(size, c.x, c.y));
  }
  const gap = 3;
  for (const t of tables) {
    if (out.has(t.id)) continue;
    const size = tableSize(t.shape, t.capacity);
    let spot: { x: number; y: number } | null = null;
    for (let y = Math.ceil(size.h / 2) + gap; y <= FLOOR_HEIGHT - size.h / 2 && !spot; y += 2) {
      for (let x = Math.ceil(size.w / 2) + gap; x <= FLOOR_WIDTH - size.w / 2; x += 2) {
        const r = padded(centreRect(size, x, y), gap / 2);
        if (!blocked.some((b) => overlaps(r, b))) {
          spot = { x, y };
          break;
        }
      }
    }
    // A full room still shows the table (overlapping) rather than hiding it.
    const c = spot ?? clampCentre(size, size.w / 2 + gap, size.h / 2 + gap);
    out.set(t.id, { ...t, ...c, size, placed: false });
    blocked.push(centreRect(size, c.x, c.y));
  }
  return tables.map((t) => out.get(t.id)!);
}

const padded = (r: Rect, by: number): Rect => ({
  x: r.x - by,
  y: r.y - by,
  w: r.w + by * 2,
  h: r.h + by * 2,
});

/** A free top-left corner for a new element of this size, or the top-left corner when the room is full. */
export function freeCorner(
  size: Size,
  tables: readonly PlacedTable[],
  elements: readonly FloorElement[],
): { x: number; y: number } {
  const blocked: Rect[] = [
    ...tables.map((t) => centreRect(t.size, t.x, t.y)),
    ...elements.map((e) => ({ x: e.x, y: e.y, w: e.w, h: e.h })),
  ];
  for (let y = 0; y <= FLOOR_HEIGHT - size.h; y += 2) {
    for (let x = 0; x <= FLOOR_WIDTH - size.w; x += 2) {
      const r = { x, y, w: size.w, h: size.h };
      if (!blocked.some((b) => overlaps(r, b))) return { x, y };
    }
  }
  return { x: 0, y: 0 };
}

/**
 * Things the couple probably does not want: two tables on top of each other, or a table on top of a
 * venue element. Elements overlapping each other is allowed (a head table on a stage is normal).
 * Advisory only; it is a sketch, not a clearance check.
 */
export function overlapNotes(
  tables: readonly PlacedTable[],
  elements: readonly FloorElement[],
): string[] {
  const notes: string[] = [];
  const sorted = [...tables].sort(
    (a, b) => a.label.localeCompare(b.label, "en") || a.id.localeCompare(b.id),
  );
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!;
    const ra = centreRect(a.size, a.x, a.y);
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j]!;
      if (overlaps(ra, centreRect(b.size, b.x, b.y))) {
        notes.push(`${a.label} and ${b.label} overlap on the floor plan.`);
      }
    }
    for (const e of elements) {
      if (overlaps(ra, { x: e.x, y: e.y, w: e.w, h: e.h })) {
        notes.push(`${a.label} overlaps ${e.label}.`);
      }
    }
  }
  return notes;
}
