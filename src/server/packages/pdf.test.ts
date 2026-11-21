import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import type { PackageRequest } from "@/domain/packages/catalog";
import { digestInput } from "@/domain/packages/document";
import { buildDocument, type ProjectionInput } from "@/domain/packages/sections";
import { renderPdf } from "./pdf";

const meta = { generatedAt: "2026-11-20T12:00:00.000Z", revision: 4, digest: "ab".repeat(32) };

const request = (over: Partial<PackageRequest> = {}): PackageRequest => ({
  title: "Alex & Morgan · Wedding book",
  preset: "master",
  recipient: "The couple",
  sections: ["overview", "events", "timeline", "rsvp"],
  options: { includeContacts: true, includeNotes: true },
  formats: ["pdf"],
  paper: "a4",
  orientation: "portrait",
  ...over,
});

const base = (over: Partial<ProjectionInput> = {}): ProjectionInput => ({
  name: "Alex & Morgan (Example)",
  date: "2027-06-12",
  timezone: "America/New_York",
  location: "Hudson Valley",
  currency: "USD",
  targetGuestCount: 80,
  events: [
    {
      id: "e1",
      name: "Ceremony",
      kind: "ceremony",
      localDate: "2027-06-12",
      targetAttendance: 80,
      capacity: null,
    },
  ],
  timeline: [],
  vendors: [],
  budget: null,
  payments: null,
  rsvp: [],
  seating: [],
  boards: [],
  documents: [],
  decisions: [],
  ...over,
});

const manyItems = (n: number): ProjectionInput["timeline"] =>
  Array.from({ length: n }, (_, i) => ({
    eventId: "e1",
    title: `Item ${i + 1} ${"with a rather long description ".repeat(3)}`,
    startsAt: new Date(Date.UTC(2027, 5, 12, 14, 0) + i * 600_000).toISOString(),
    endsAt: null,
    timezone: "America/New_York",
    cancelled: false,
    location: "Garden terrace by the old oak",
    responsible: "Coordinator",
    contact: "contact@example.test",
    notes: "Remember the extension cord",
  }));

describe("renderPdf", () => {
  it("makes a valid PDF with the cover, section headings and a footer on every page", async () => {
    const doc = buildDocument(request(), base({ timeline: manyItems(3) }));
    const out = await renderPdf(doc, meta, "a4", "portrait");
    expect(Buffer.from(out.bytes.slice(0, 5)).toString()).toBe("%PDF-");
    const loaded = await PDFDocument.load(out.bytes);
    expect(loaded.getPageCount()).toBe(out.pageCount);
    expect(out.lines).toContain("Alex & Morgan · Wedding book");
    expect(out.lines).toContain("Contents");
    expect(out.lines).toContain("Overview");
    expect(out.lines).toContain(`Page 1 of ${out.pageCount}`);
    expect(out.lines.filter((l) => l.startsWith("Snapshot of plan revision 4 ·"))).toHaveLength(
      out.pageCount,
    );
  });

  it("paginates a long table, repeating its header and losing no row", async () => {
    const doc = buildDocument(
      request({ sections: ["timeline"] }),
      base({ timeline: manyItems(120) }),
    );
    const out = await renderPdf(doc, meta, "letter", "portrait");
    expect(out.pageCount).toBeGreaterThan(3);
    const items = out.lines.filter((l) => /^Item \d+ /.test(l));
    const seen = new Set(items.map((l) => l.match(/^Item (\d+) /)![1]));
    expect(seen.size).toBe(120);
    const headers = out.lines.filter((l) => l === "Time").length;
    expect(headers).toBeGreaterThanOrEqual(out.pageCount - 1);
  });

  it("breaks one very long unbreakable word across lines instead of overflowing", async () => {
    const doc = buildDocument(
      request({ sections: ["events"] }),
      base({
        events: [
          {
            id: "x",
            name: "Supercalifragilisticexpialidocious".repeat(8),
            kind: "other",
            localDate: null,
            targetAttendance: null,
            capacity: null,
          },
        ],
      }),
    );
    const out = await renderPdf(doc, meta, "a4", "portrait");
    const pieces = out.lines.filter((l) => l.includes("Supercalifragilistic"));
    expect(pieces.length).toBeGreaterThan(1);
    expect(out.lines.join("")).toContain("Supercalifragilisticexpialidocious".repeat(8));
  });

  it("is deterministic for equal input", async () => {
    const doc = buildDocument(request(), base({ timeline: manyItems(5) }));
    const a = await renderPdf(doc, meta, "a4", "portrait");
    const b = await renderPdf(doc, meta, "a4", "portrait");
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    expect(digestInput(doc).length).toBeGreaterThan(10);
  });

  it("honours paper size and orientation", async () => {
    const doc = buildDocument(request({ sections: ["overview"] }), base());
    const land = await PDFDocument.load((await renderPdf(doc, meta, "letter", "landscape")).bytes);
    const { width, height } = land.getPage(0).getSize();
    expect([width, height]).toEqual([792, 612]);
    const a4 = await PDFDocument.load((await renderPdf(doc, meta, "a4", "portrait")).bytes);
    expect(a4.getPage(0).getSize().width).toBeCloseTo(595.28, 1);
  });

  it("replaces characters the built-in fonts cannot show instead of failing", async () => {
    const doc = buildDocument(request({ title: "李 Wedding · Nguyễn" }), base());
    const out = await renderPdf(doc, meta, "a4", "portrait");
    expect(out.lines).toContain("? Wedding · Nguyen");
  });

  it("shows an empty section honestly", async () => {
    const doc = buildDocument(request({ sections: ["rsvp"] }), base());
    const out = await renderPdf(doc, meta, "a4", "portrait");
    expect(out.lines.join(" ")).toContain("No guests have been invited to an event yet.");
  });
});
