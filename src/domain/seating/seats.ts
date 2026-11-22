/**
 * Pure numbered-seat helpers (ADR-030, SEAT-3). Seat numbers are stored (unique per table, inside the
 * table's capacity); a guest can also be at a table with no number yet. This module turns a table's
 * seats into the slots the tray shows and the chips drawn around the table on the floor plan. It makes
 * no claim about real chair positions: chips are a sketch, spread evenly round or along the long sides.
 */
import type { Size } from "./floor";
import type { TablePlan, TableSeat, TableShape } from "./plan";

export type SeatSlot = {
  /** 1-based seat number. */
  seat: number;
  occupant: TableSeat | null;
};

export type TableSeats = {
  /** One slot per seat number, 1 to capacity. */
  slots: SeatSlot[];
  /** Guests at the table who have no seat number yet, in name order. */
  unnumbered: TableSeat[];
};

const byName = (a: TableSeat, b: TableSeat) =>
  a.guest.name.localeCompare(b.guest.name, "en") || a.guest.id.localeCompare(b.guest.id);

/** Numbered guests sit in their own seat; anyone without a number is listed separately. */
export function tableSeats(table: Pick<TablePlan, "capacity" | "seats">): TableSeats {
  const bySeat = new Map<number, TableSeat>();
  const unnumbered: TableSeat[] = [];
  for (const s of table.seats) {
    if (s.seatNumber !== null && s.seatNumber >= 1 && s.seatNumber <= table.capacity) {
      if (!bySeat.has(s.seatNumber)) {
        bySeat.set(s.seatNumber, s);
        continue;
      }
    }
    unnumbered.push(s);
  }
  return {
    slots: Array.from({ length: table.capacity }, (_, i) => ({
      seat: i + 1,
      occupant: bySeat.get(i + 1) ?? null,
    })),
    unnumbered: unnumbered.sort(byName),
  };
}

/** Up to two capital letters: the first and last word that start with a letter or digit ("(child)" is skipped). */
export function initials(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((w) => /^[\p{L}\p{N}]/u.test(w));
  if (words.length === 0) return "?";
  const first = [...words[0]!][0]!;
  const last = words.length > 1 ? [...words[words.length - 1]!][0]! : "";
  return (first + last).toLocaleUpperCase("en");
}

export type ChipState = "empty" | "seated" | "waiting";
export type Chip = { initials: string | null; state: ChipState };

/**
 * What to draw round the table: one chip per seat. Numbered guests take their own seat; guests with
 * no number fill the lowest empty seats so the filled count always matches who is at the table.
 */
export function canvasChips(table: Pick<TablePlan, "capacity" | "seats">): Chip[] {
  const { slots, unnumbered } = tableSeats(table);
  const queue = [...unnumbered];
  return slots.map((slot) => {
    const who = slot.occupant ?? queue.shift() ?? null;
    if (!who) return { initials: null, state: "empty" };
    return { initials: initials(who.guest.name), state: who.tentative ? "waiting" : "seated" };
  });
}

export type ChipSpot = { dx: number; dy: number };
export type ChipLayout = {
  /** Diameter of one chip, in grid units. */
  diameter: number;
  /** Offset of each chip's centre from the table centre, seat 1 first. */
  spots: ChipSpot[];
};

const CHIP_MAX = 2.8;
const CHIP_GAP = 1.5;
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Where the chips sit. Round tables: evenly round the rim, seat 1 at the top, clockwise. Rectangles:
 * the top side left to right, then the bottom side right to left. The chip shrinks when a big table
 * would otherwise make neighbours overlap.
 */
export function chipLayout(shape: TableShape, capacity: number, size: Size): ChipLayout {
  const n = Math.max(0, capacity);
  if (n === 0) return { diameter: CHIP_MAX, spots: [] };
  if (shape === "round") {
    const radius = size.w / 2 + CHIP_GAP;
    const diameter = Math.min(CHIP_MAX, (2 * Math.PI * radius * 0.9) / n);
    return {
      diameter: round2(diameter),
      spots: Array.from({ length: n }, (_, i) => {
        const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
        return { dx: round2(radius * Math.cos(angle)), dy: round2(radius * Math.sin(angle)) };
      }),
    };
  }
  const top = Math.ceil(n / 2);
  const bottom = n - top;
  const widest = Math.max(top, bottom, 1);
  const diameter = Math.min(CHIP_MAX, (size.w * 0.95) / widest);
  const offset = size.h / 2 + CHIP_GAP;
  const along = (index: number, count: number) =>
    round2(-size.w / 2 + ((index + 0.5) * size.w) / count);
  const spots: ChipSpot[] = [];
  for (let i = 0; i < top; i++) spots.push({ dx: along(i, top), dy: -offset });
  for (let i = 0; i < bottom; i++) spots.push({ dx: along(bottom - 1 - i, bottom), dy: offset });
  return { diameter: round2(diameter), spots };
}
