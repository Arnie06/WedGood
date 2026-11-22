import { describe, expect, it } from "vitest";
import { buildPrintModel, surnameKey } from "./print";

const guests = [
  { id: "g1", name: "Zoe Adams" },
  { id: "g2", name: "Ben Zimmer" },
  { id: "g3", name: "Cy Baker (child)" },
  { id: "g4", name: "Dee Wait" },
  { id: "g5", name: "Eli Loose" },
];
const accepted = (guestId: string, mealOptionId: string | null) => ({
  guestId,
  status: "accepted" as const,
  mealOptionId,
});
const base = {
  guests,
  members: [
    accepted("g1", "m1"),
    accepted("g2", null),
    accepted("g3", "m2"),
    { guestId: "g4", status: "pending" as const, mealOptionId: null },
    accepted("g5", "m1"),
  ],
  tables: [
    { id: "t2", label: "Table 2", capacity: 4 },
    { id: "t1", label: "Table 1", capacity: 2, shape: "round" as const, notes: "Near the bar" },
  ],
  assignments: [
    { guestId: "g1", tableId: "t1", tentative: false, seatNumber: 2 },
    { guestId: "g2", tableId: "t1", tentative: false, seatNumber: 1 },
    { guestId: "g3", tableId: "t2", tentative: false, seatNumber: null },
    { guestId: "g4", tableId: "t2", tentative: true, seatNumber: 3 },
  ],
  meals: [
    { id: "m1", name: "Salmon" },
    { id: "m2", name: "Risotto" },
  ],
  allowTentative: true,
  includeMeals: true,
};

describe("surnameKey", () => {
  it("uses the last word and ignores a trailing note", () => {
    expect(surnameKey("Ada Lovelace")).toBe("lovelace");
    expect(surnameKey("Cy Baker (child)")).toBe("baker");
    expect(surnameKey("Cher")).toBe("cher");
    expect(surnameKey("Max Montgomery III")).toBe("montgomery");
    expect(surnameKey("Sam Lee, Jr.")).toBe("lee");
    expect(surnameKey("V")).toBe("v");
    expect(surnameKey("  ")).toBe("  ");
  });
});

describe("buildPrintModel", () => {
  const m = buildPrintModel(base);

  it("lists tables in plan order with guests by seat number, then name", () => {
    expect(m.tables.map((t) => t.label)).toEqual(["Table 2", "Table 1"]);
    expect(m.tables[1]?.guests.map((g) => [g.name, g.seat])).toEqual([
      ["Ben Zimmer", 1],
      ["Zoe Adams", 2],
    ]);
  });

  it("marks tentative guests in the table list and leaves them off the cards", () => {
    const t2 = m.tables[0]!;
    expect(t2.guests.find((g) => g.name === "Dee Wait")?.tentative).toBe(true);
    expect(m.cards.map((c) => c.name)).not.toContain("Dee Wait");
    expect(m.tentativeCount).toBe(1);
  });

  it("orders cards by surname and carries table, seat and meal", () => {
    expect(m.cards.map((c) => c.name)).toEqual(["Zoe Adams", "Cy Baker (child)", "Ben Zimmer"]);
    expect(m.cards[0]).toEqual({ name: "Zoe Adams", table: "Table 1", seat: 2, meal: "Salmon" });
    expect(m.cards[1]?.seat).toBeNull();
  });

  it("reports accepted guests with no seat, and gives them no card", () => {
    expect(m.unseated).toEqual(["Eli Loose"]);
    expect(m.cards.map((c) => c.name)).not.toContain("Eli Loose");
  });

  it("shows no meal when the guest has none or meals are off", () => {
    expect(m.cards.find((c) => c.name === "Ben Zimmer")?.meal).toBeNull();
    const off = buildPrintModel({ ...base, includeMeals: false });
    expect(off.includeMeals).toBe(false);
    expect(off.cards.every((c) => c.meal === null)).toBe(true);
    expect(off.tables.flatMap((t) => t.guests).every((g) => g.meal === null)).toBe(true);
  });

  it("has no field that can carry a private note or a position", () => {
    const json = JSON.stringify(m);
    expect(json).not.toContain("Near the bar");
    for (const key of ["notes", "dietary", "accessibility", "x", "y", "email", "phone"]) {
      expect(json).not.toContain(`"${key}"`);
    }
  });

  it("is deterministic and never mutates its input", () => {
    const copy = structuredClone(base);
    expect(buildPrintModel(base)).toEqual(m);
    expect(base).toEqual(copy);
  });

  it("handles an event with no tables or guests", () => {
    const empty = buildPrintModel({ ...base, tables: [], assignments: [] });
    expect(empty.tables).toEqual([]);
    expect(empty.cards).toEqual([]);
  });
});
