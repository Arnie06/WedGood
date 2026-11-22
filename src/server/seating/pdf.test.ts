import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { buildPrintModel, type PrintModel } from "@/domain/seating/print";
import { renderSeatingPdf, type SeatingPdfMeta } from "./pdf";

const meta: SeatingPdfMeta = {
  eventName: "Reception",
  weddingName: "Alex & Morgan (Example)",
  eventDate: "2027-06-12",
  revision: 7,
  generatedAt: "2026-11-21T12:00:00.000Z",
};

const people = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `g${i}`, name: `Guest${i} Family${i % 7}` }));

const model = (
  n: number,
  over: Partial<Parameters<typeof buildPrintModel>[0]> = {},
): PrintModel => {
  const guests = people(n);
  return buildPrintModel({
    guests,
    members: guests.map((g) => ({ guestId: g.id, status: "accepted", mealOptionId: "m1" })),
    tables: Array.from({ length: Math.ceil(n / 8) || 1 }, (_, i) => ({
      id: `t${i}`,
      label: `Table ${i + 1}`,
      capacity: 8,
    })),
    assignments: guests.map((g, i) => ({
      guestId: g.id,
      tableId: `t${Math.floor(i / 8)}`,
      tentative: false,
      seatNumber: (i % 8) + 1,
    })),
    meals: [{ id: "m1", name: "Salmon" }],
    allowTentative: false,
    includeMeals: true,
    ...over,
  });
};

describe("table list PDF", () => {
  it("is a real PDF with names, tables, seat numbers and meals as text", async () => {
    const r = await renderSeatingPdf("table-list", model(10), meta, "a4");
    expect(Buffer.from(r.bytes.slice(0, 5)).toString()).toBe("%PDF-");
    const doc = await PDFDocument.load(r.bytes);
    expect(doc.getTitle()).toBe("Reception · Table list");
    expect(doc.getPageCount()).toBe(r.pageCount);
    expect(r.lines).toContain("Table 1 · 8 of 8 seats");
    expect(r.lines).toContain("Guest0 Family0");
    expect(r.lines).toContain("Salmon");
    expect(r.lines.some((l) => l.includes("revision 7"))).toBe(true);
  });

  it("uses the requested paper size", async () => {
    for (const [paper, w, h] of [
      ["a4", 595.28, 841.89],
      ["letter", 612, 792],
    ] as const) {
      const doc = await PDFDocument.load(
        (await renderSeatingPdf("table-list", model(4), meta, paper)).bytes,
      );
      const size = doc.getPage(0).getSize();
      expect(size.width).toBeCloseTo(w, 1);
      expect(size.height).toBeCloseTo(h, 1);
    }
  });

  it("paginates a long list and repeats the page numbering", async () => {
    const r = await renderSeatingPdf("table-list", model(160), meta, "letter");
    expect(r.pageCount).toBeGreaterThan(2);
    expect(r.lines).toContain(`Page ${r.pageCount} of ${r.pageCount}`);
    expect(r.lines.filter((l) => l === "Guest159 Family5").length).toBe(1);
  });

  it("leaves the meal column out when meals are off", async () => {
    const r = await renderSeatingPdf("table-list", model(6, { includeMeals: false }), meta, "a4");
    expect(r.lines).not.toContain("Meal");
    expect(r.lines).not.toContain("Salmon");
  });

  it("marks tentative guests and says they may change", async () => {
    const guests = people(2);
    const m = buildPrintModel({
      guests,
      members: [
        { guestId: "g0", status: "accepted", mealOptionId: null },
        { guestId: "g1", status: "pending", mealOptionId: null },
      ],
      tables: [{ id: "t", label: "Table 1", capacity: 4 }],
      assignments: [
        { guestId: "g0", tableId: "t", tentative: false, seatNumber: 1 },
        { guestId: "g1", tableId: "t", tentative: true, seatNumber: 2 },
      ],
      meals: [],
      allowTentative: true,
      includeMeals: false,
    });
    const r = await renderSeatingPdf("table-list", m, meta, "a4");
    expect(r.lines).toContain("Guest1 Family1 (tentative)");
    expect(r.lines.some((l) => l.includes("may change"))).toBe(true);
  });

  it("renders an empty plan without failing", async () => {
    const m = model(0, { guests: [], members: [], tables: [], assignments: [] });
    const r = await renderSeatingPdf("table-list", m, meta, "a4");
    expect(r.lines).toContain("No tables yet.");
  });

  it("simplifies characters the built-in fonts cannot show, and says so", async () => {
    const m = model(1);
    m.tables[0]!.guests[0]!.name = "Zoë Čapek 王";
    const r = await renderSeatingPdf("table-list", m, meta, "a4");
    expect(r.replaced).toBeGreaterThan(0);
    expect(r.lines).toContain("Zoë Capek ?");
    expect(r.lines.some((l) => l.includes("were simplified"))).toBe(true);
  });

  it("is deterministic for equal input", async () => {
    const a = await renderSeatingPdf("table-list", model(12), meta, "a4");
    const b = await renderSeatingPdf("table-list", model(12), meta, "a4");
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });
});

describe("escort cards PDF", () => {
  it("puts ten cards on a sheet and starts a new sheet after that", async () => {
    expect((await renderSeatingPdf("cards", model(10), meta, "a4")).pageCount).toBe(1);
    expect((await renderSeatingPdf("cards", model(11), meta, "a4")).pageCount).toBe(2);
    expect((await renderSeatingPdf("cards", model(21), meta, "letter")).pageCount).toBe(3);
  });

  it("prints name, table and seat on each card, in surname order", async () => {
    const r = await renderSeatingPdf("cards", model(9), meta, "letter");
    expect(r.lines).toContain("Guest0 Family0");
    expect(r.lines).toContain("Table 2");
    expect(r.lines).toContain("Seat 1");
    const first = r.lines.indexOf("Guest0 Family0");
    const second = r.lines.indexOf("Guest7 Family0");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);
  });

  it("adds the meal only when asked", async () => {
    expect((await renderSeatingPdf("cards", model(3), meta, "a4")).lines).toContain("Salmon");
    expect(
      (await renderSeatingPdf("cards", model(3, { includeMeals: false }), meta, "a4")).lines,
    ).not.toContain("Salmon");
  });

  it("fits a very long name on two lines or fewer without leaving the card", async () => {
    const m = model(1);
    m.cards[0]!.name = "Maximilian Alexander Bartholomew Montgomery-Featherstonehaugh III";
    const r = await renderSeatingPdf("cards", m, meta, "a4");
    const nameLines = r.lines.filter((l) => /Maximilian|Bartholomew|Featherstonehaugh|III/.test(l));
    expect(nameLines.length).toBeGreaterThan(0);
    expect(nameLines.length).toBeLessThanOrEqual(3);
  });

  it("cuts a meal name that needs more than two lines instead of overflowing", async () => {
    const m = model(1);
    m.cards[0]!.meal =
      "Slow braised short rib with truffle potato puree and heirloom carrots ".repeat(4);
    const r = await renderSeatingPdf("cards", m, meta, "a4");
    expect(r.lines.some((l) => l.endsWith("..."))).toBe(true);
    expect(r.lines.filter((l) => /short rib|truffle|carrots/.test(l)).length).toBeLessThanOrEqual(
      2,
    );
  });

  it("renders one blank-safe sheet when nobody is seated", async () => {
    const m = model(0, { guests: [], members: [], tables: [], assignments: [] });
    const r = await renderSeatingPdf("cards", m, meta, "a4");
    expect(r.pageCount).toBe(1);
    expect(r.lines).toContain("No seated guests yet.");
  });

  it("never contains private note text, even if a table has notes", async () => {
    const m = model(4, {
      tables: [{ id: "t0", label: "Table 1", capacity: 8, notes: "Keep away from the DJ" }],
    });
    for (const kind of ["cards", "table-list"] as const) {
      const r = await renderSeatingPdf(kind, m, meta, "a4");
      expect(r.lines.join("\n")).not.toContain("DJ");
    }
  });
});
