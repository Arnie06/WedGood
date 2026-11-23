import { describe, expect, it } from "vitest";
import { summarizeBudget } from "@/domain/budget/summary";
import { capabilitiesFor } from "@/domain/permissions";
import { PRESETS, SECTIONS, parsePackageRequest, type PackageRequest } from "./catalog";
import { documentToCsv } from "./csv";
import {
  canonicalJson,
  countPdfReplacements,
  digestInput,
  parseStoredDocument,
  toPdfText,
  type Block,
  type PackageDocument,
} from "./document";
import { buildDocument, type ProjectionInput } from "./sections";

const owner = capabilitiesFor("owner");
const viewer = capabilitiesFor("viewer");

const request = (over: Partial<PackageRequest> = {}): PackageRequest => ({
  title: "Example book",
  preset: "master",
  recipient: "The couple",
  sections: ["overview", "events", "timeline", "budget", "rsvp"],
  options: { includeContacts: false, includeNotes: false },
  formats: ["pdf", "csv"],
  paper: "a4",
  orientation: "portrait",
  ...over,
});

const input = (over: Partial<ProjectionInput> = {}): ProjectionInput => ({
  name: "Alex & Morgan (Example)",
  date: "2027-06-12",
  timezone: "America/New_York",
  location: "Hudson Valley",
  currency: "USD",
  targetGuestCount: 80,
  events: [
    {
      id: "e2",
      name: "Reception",
      kind: "reception",
      localDate: "2027-06-12",
      targetAttendance: 80,
      capacity: 120,
    },
    {
      id: "e1",
      name: "Ceremony",
      kind: "ceremony",
      localDate: "2027-06-12",
      targetAttendance: 80,
      capacity: null,
    },
  ],
  timeline: [
    {
      eventId: "e1",
      title: "Guests arrive",
      startsAt: "2027-06-12T20:00:00Z",
      endsAt: "2027-06-12T20:30:00Z",
      timezone: "America/New_York",
      cancelled: false,
      location: "Garden",
      responsible: "Coordinator",
      contact: "555-0100",
      notes: "Private door code 1234",
    },
  ],
  vendors: [],
  budget: null,
  payments: null,
  rsvp: [
    {
      eventId: "e1",
      invited: 10,
      accepted: 6,
      pending: 3,
      declined: 1,
      acceptedWithoutMeal: 1,
      meals: [{ name: "Chicken", accepted: 5 }],
    },
  ],
  guarantees: [],
  seating: [],
  boards: [],
  documents: [],
  decisions: [],
  ...over,
});

const texts = (blocks: Block[]) =>
  blocks.flatMap((b) =>
    b.type === "text"
      ? [b.text]
      : b.type === "facts"
        ? b.items.flatMap((i) => [i.label, i.value])
        : [b.caption, ...b.columns, ...b.rows.flat()],
  );
const all = (doc: PackageDocument) => doc.sections.flatMap((s) => texts(s.blocks)).join("\n");

describe("parsePackageRequest", () => {
  it("uses the preset's sections and title when nothing is chosen", () => {
    const r = parsePackageRequest({ preset: "financial" }, owner, "Alex & Morgan");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.sections).toEqual(["overview", "budget", "payments"]);
      expect(r.value.title).toBe("Alex & Morgan · Financial report");
      expect(r.value.options).toEqual({ includeContacts: false, includeNotes: false });
    }
  });

  it("keeps sections in catalog order whatever order they were clicked", () => {
    const r = parsePackageRequest(
      { preset: "custom", sections: ["budget", "overview", "events"] },
      owner,
      "X",
    );
    expect(r.ok && r.value.sections).toEqual(["overview", "events", "budget"]);
  });

  it("drops sections the actor lacks the capability for and reports them", () => {
    const r = parsePackageRequest(
      { preset: "custom", sections: ["overview", "budget"] },
      viewer,
      "X",
    );
    expect(r.ok).toBe(false);
    expect(r.dropped).toEqual(["overview", "budget"]);
  });

  it("ignores unknown section ids instead of trusting them", () => {
    const r = parsePackageRequest(
      { preset: "custom", sections: ["overview", "secrets"] },
      owner,
      "X",
    );
    expect(r.ok && r.value.sections).toEqual(["overview"]);
  });

  it("rejects an empty format list and an over-long title", () => {
    const a = parsePackageRequest({ formats: [] }, owner, "X");
    expect(!a.ok && a.errors.formats).toBeTruthy();
    const b = parsePackageRequest({ title: "x".repeat(121) }, owner, "X");
    expect(!b.ok && b.errors.title).toBeTruthy();
  });

  it("turns redactions on only when explicitly asked", () => {
    const r = parsePackageRequest({ includeContacts: "on" }, owner, "X");
    expect(r.ok && r.value.options).toEqual({ includeContacts: true, includeNotes: false });
  });

  it("defines every preset with sections that exist", () => {
    const ids = new Set(SECTIONS.map((s) => s.id));
    for (const p of PRESETS) for (const s of p.sections) expect(ids.has(s)).toBe(true);
  });

  it("never includes guest names, dietary details or files in the section descriptions", () => {
    const shares = SECTIONS.map((s) => s.shares.toLowerCase()).join(" ");
    expect(shares).toContain("no guest names");
  });
});

describe("buildDocument", () => {
  it("is deterministic and orders events by date then name", () => {
    const a = buildDocument(request(), input());
    const b = buildDocument(request(), input({ events: [...input().events].reverse() }));
    expect(digestInput(a)).toBe(digestInput(b));
    const events = a.sections.find((s) => s.id === "events")!.blocks[0];
    expect(events?.type === "table" && events.rows.map((r) => r[0])).toEqual([
      "Ceremony",
      "Reception",
    ]);
  });

  it("leaves contacts and notes out unless asked", () => {
    const plain = all(buildDocument(request(), input()));
    expect(plain).not.toContain("555-0100");
    expect(plain).not.toContain("door code");
    const full = all(
      buildDocument(request({ options: { includeContacts: true, includeNotes: true } }), input()),
    );
    expect(full).toContain("555-0100");
    expect(full).toContain("door code");
  });

  it("shows agenda times in the item's zone", () => {
    const text = all(buildDocument(request(), input()));
    expect(text).toContain("4:00 PM");
    expect(text).toContain("4:30 PM");
  });

  it("counts meals for accepted guests only and names the missing choices", () => {
    const text = all(buildDocument(request(), input()));
    expect(text).toContain("Chicken");
    expect(text).toContain("No choice yet");
    expect(text).toContain("Pending guests may still change the count");
  });

  it("includes the locked caterer count with its dates and does not let replies change it", () => {
    const doc = buildDocument(
      request({ preset: "caterer", sections: ["overview", "events", "rsvp"] }),
      input({
        guarantees: [
          { eventId: "e1", count: 118, lockedOn: "2027-05-01", dueOn: "2027-05-20", revisions: 1 },
        ],
      }),
    );
    const text = all(doc);
    expect(text).toContain("Count for the caterer");
    expect(text).toContain("118");
    expect(text).toContain("May 1, 2027");
    expect(text).toContain("May 20, 2027");
    // The replies table still shows today's 6 accepted; the locked count is a separate row.
    expect(text).toContain("Responses by event");
    expect(text).toContain("not changed by later replies");
  });

  it("shows no caterer count section when none is locked", () => {
    const text = all(buildDocument(request({ sections: ["rsvp"] }), input()));
    expect(text).not.toContain("Count for the caterer");
    expect(text).toContain("Pending guests may still change the count");
  });

  it("never contains guest names or any field the section does not list", () => {
    const text = all(buildDocument(request({ sections: ["rsvp", "seating"] }), input()));
    expect(text).not.toMatch(/@|https?:/);
  });

  it("states that a forecast with unknown items is a lower bound", () => {
    const budget = summarizeBudget({
      targetMinor: 2_000_000,
      reserveBp: 1000,
      guestCount: 80,
      categories: [{ id: "c", name: "Venue", allocationMinor: 900_000 }],
      items: [
        {
          id: "i1",
          categoryId: "c",
          name: "Hall",
          costMode: "fixed",
          amountMinor: 500_000,
          quantity: null,
          minQty: null,
        },
        {
          id: "i2",
          categoryId: "c",
          name: "Chairs",
          costMode: "fixed",
          amountMinor: null,
          quantity: null,
          minQty: null,
        },
      ],
    });
    const doc = buildDocument(request({ sections: ["budget"] }), input({ budget }));
    const text = all(doc);
    expect(text).toContain("lower bound");
    expect(text).toContain("At least");
    expect(text).toContain("$5,000.00");
    expect(text).toContain("do not confirm that money moved");
  });

  it("shows Not set for a missing target rather than zero", () => {
    const budget = summarizeBudget({
      targetMinor: null,
      reserveBp: null,
      guestCount: null,
      categories: [],
      items: [],
    });
    const text = all(buildDocument(request({ sections: ["budget"] }), input({ budget })));
    expect(text).toContain("Not set");
    expect(text).not.toContain("$0.00 target");
  });

  it("lists only active bookings and computes balances from recorded payments", () => {
    const doc = buildDocument(
      request({ sections: ["payments"] }),
      input({
        payments: {
          commitments: [
            {
              id: "a",
              title: "Hall",
              amountMinor: 1_000_000,
              status: "active",
              signedOn: "2027-01-05",
            },
            { id: "b", title: "Old DJ", amountMinor: 300_000, status: "cancelled", signedOn: null },
          ],
          payments: [
            { commitmentId: "a", kind: "charge", amountMinor: 400_000 },
            { commitmentId: "a", kind: "refund", amountMinor: 50_000 },
          ],
          installments: [
            {
              commitmentId: "a",
              dueOn: "2027-03-01",
              amountMinor: 300_000,
              label: "Second deposit",
            },
          ],
        },
      }),
    );
    const text = all(doc);
    expect(text).toContain("$3,500.00");
    expect(text).toContain("$6,500.00");
    expect(text).not.toContain("Old DJ");
    expect(text).toContain("1 replaced or cancelled booking is not listed");
    expect(text).toContain("Second deposit");
  });

  it("omits passed vendors but says how many", () => {
    const doc = buildDocument(
      request({ sections: ["vendors"] }),
      input({
        vendors: [
          {
            name: "Garden Hall",
            kind: "venue",
            category: "venue",
            stage: "booked",
            location: "Hudson",
          },
          {
            name: "Skipped",
            kind: "vendor",
            category: "photographer",
            stage: "declined",
            location: null,
          },
        ],
      }),
    );
    const text = all(doc);
    expect(text).toContain("Garden Hall");
    expect(text).not.toContain("Skipped");
    expect(text).toContain("1 passed or cancelled option is not listed");
  });

  it("changes the digest when content changes and not otherwise", () => {
    const base = digestInput(buildDocument(request(), input()));
    expect(digestInput(buildDocument(request(), input()))).toBe(base);
    expect(digestInput(buildDocument(request(), input({ location: "Elsewhere" })))).not.toBe(base);
  });

  it("clips very long cells so a row cannot outgrow a page", () => {
    const long = "word ".repeat(400);
    const doc = buildDocument(
      request({ sections: ["events"] }),
      input({
        events: [
          {
            id: "x",
            name: long,
            kind: "other",
            localDate: null,
            targetAttendance: null,
            capacity: null,
          },
        ],
      }),
    );
    const t = doc.sections[0]!.blocks[0];
    expect(t?.type === "table" && t.rows[0]![0]!.length).toBeLessThanOrEqual(400);
  });
});

describe("document helpers", () => {
  it("canonicalJson ignores key order and undefined", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: undefined }] })).toBe('{"a":[2,{"d":1}],"b":1}');
  });

  it("toPdfText keeps Latin text, drops unsupported accents and counts changes", () => {
    expect(toPdfText("José Müller")).toEqual({ text: "José Müller", replaced: 0 });
    expect(toPdfText("Nguyễn")).toEqual({ text: "Nguyen", replaced: 1 });
    expect(toPdfText("Li 李")).toEqual({ text: "Li ?", replaced: 1 });
    expect(toPdfText("a\tb\nc").text).toBe("a b c");
  });

  it("counts replacements across a document", () => {
    const doc = buildDocument(request({ title: "李 wedding" }), input());
    expect(countPdfReplacements(doc)).toBe(1);
  });

  it("parseStoredDocument accepts a built document and rejects malformed ones", () => {
    const doc = buildDocument(request(), input());
    expect(parseStoredDocument(JSON.parse(JSON.stringify(doc)))).not.toBeNull();
    expect(parseStoredDocument({ title: 1 })).toBeNull();
    const bad = JSON.parse(JSON.stringify(doc));
    bad.sections[1].blocks[0] = {
      type: "table",
      columns: ["a"],
      align: ["left"],
      rows: [["x", "y"]],
      caption: "c",
    };
    expect(parseStoredDocument(bad)).toBeNull();
  });
});

describe("documentToCsv", () => {
  const meta = { generatedAt: "2026-11-20T12:00:00Z", revision: 3, digest: "a".repeat(64) };

  it("writes a header, a BOM, the metadata and one row per value", () => {
    const csv = documentToCsv(buildDocument(request({ sections: ["events"] }), input()), meta);
    expect(csv.startsWith("﻿Section,Table,Row,Column,Value\r\n")).toBe(true);
    expect(csv).toContain("Package,Details,5,Generated (UTC),2026-11-20T12:00:00Z");
    expect(csv).toContain("Events,Events,1,Event,Ceremony");
    expect(csv).toContain("Events,Events,2,Target guests,80");
  });

  it("neutralizes spreadsheet formulas in any cell", () => {
    const doc = buildDocument(
      request({ sections: ["events"] }),
      input({
        events: [
          {
            id: "x",
            name: '=HYPERLINK("http://evil")',
            kind: "other",
            localDate: null,
            targetAttendance: null,
            capacity: null,
          },
        ],
      }),
    );
    const csv = documentToCsv(doc, meta);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).not.toMatch(/,=HYPERLINK/);
  });

  it("keeps non-Latin text unchanged", () => {
    const doc = buildDocument(request({ title: "李 Wedding" }), input());
    expect(documentToCsv(doc, meta)).toContain("李 Wedding");
  });
});
