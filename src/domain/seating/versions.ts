/**
 * Reads a finalized seating copy (REL-05). The copy is stored as jsonb written by the database at
 * finalization; older copies have fewer fields (no shape, notes or captain). Parsing is tolerant of
 * missing fields and strict about types, so a page never renders something it did not expect.
 */

export type FrozenGuest = {
  name: string;
  tentative: boolean;
  seat: number | null;
  captain: boolean;
  meal: string | null;
};
export type FrozenTable = {
  label: string;
  capacity: number;
  shape: "round" | "rectangle";
  notes: string | null;
  guests: FrozenGuest[];
};
export type FrozenPlan = {
  revision: number;
  accepted: number;
  confirmedSeated: number;
  tentativeSeated: number;
  tables: FrozenTable[];
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export function parseFrozenPlan(raw: unknown): FrozenPlan | null {
  if (!isObject(raw)) return null;
  const tables = Array.isArray(raw.tables) ? raw.tables : [];
  return {
    revision: num(raw.revision),
    accepted: num(raw.accepted),
    confirmedSeated: num(raw.confirmedSeated),
    tentativeSeated: num(raw.tentativeSeated),
    tables: tables.filter(isObject).map((t) => ({
      label: str(t.label) ?? "Table",
      capacity: num(t.capacity),
      shape: t.shape === "rectangle" ? "rectangle" : "round",
      notes: str(t.notes),
      guests: (Array.isArray(t.guests) ? t.guests : []).filter(isObject).map((g) => ({
        name: str(g.name) ?? "Guest",
        tentative: g.tentative === true,
        seat: typeof g.seat === "number" ? g.seat : null,
        captain: g.captain === true,
        meal: str(g.meal),
      })),
    })),
  };
}
