import { describe, expect, it } from "vitest";
import { parseLineInput, parsePercentToBp, parseProposalInput } from "./input";
import { normalizeProposal, percentOf, type ProposalLine } from "./normalize";
import { canMoveStage, isActiveStage, MOVABLE_STAGES } from "./stages";

let n = 0;
function line(over: Partial<ProposalLine>): ProposalLine {
  n += 1;
  return {
    id: `line-${n}`,
    description: "Item",
    costMode: "fixed",
    amountMinor: null,
    quantity: null,
    minQty: null,
    maxQty: null,
    rateBp: null,
    percentBase: false,
    required: true,
    certainty: "quoted",
    includedInLineId: null,
    ...over,
  };
}

describe("stages", () => {
  it("lets open stages move among themselves and to passed, and reopen", () => {
    expect(canMoveStage("saved", "contacted")).toBe(true);
    expect(canMoveStage("considering", "saved")).toBe(true);
    expect(canMoveStage("contacted", "declined")).toBe(true);
    expect(canMoveStage("declined", "considering")).toBe(true);
  });
  it("never moves to or from booked and cancelled here", () => {
    expect(canMoveStage("saved", "booked")).toBe(false);
    expect(canMoveStage("considering", "cancelled")).toBe(false);
    expect(canMoveStage("booked", "saved")).toBe(false);
    expect(canMoveStage("cancelled", "contacted")).toBe(false);
    expect(MOVABLE_STAGES).not.toContain("booked");
  });
  it("treats passed and cancelled as inactive", () => {
    expect(isActiveStage("considering")).toBe(true);
    expect(isActiveStage("declined")).toBe(false);
    expect(isActiveStage("cancelled")).toBe(false);
  });
});

describe("normalizeProposal", () => {
  it("matches the documented demo: $95 per guest, 120 minimum", () => {
    const lines = [
      line({ costMode: "per_guest", amountMinor: 9500, minQty: 120 }),
      line({ costMode: "per_guest", amountMinor: 3000 }),
      line({ costMode: "fixed", amountMinor: 1_000_000 }),
    ];
    expect(normalizeProposal(lines, 120).requiredKnownMinor).toBe(1_140_000 + 360_000 + 1_000_000);
    // At 100 guests the catering minimum still bills 120.
    const at100 = normalizeProposal(lines, 100);
    expect(at100.lines[0]).toMatchObject({
      amountMinor: 1_140_000,
      billedQuantity: 120,
      warnings: ["minimum_applies"],
    });
    expect(at100.lines[1]?.amountMinor).toBe(300_000);
    // At 140 everything scales above the minimum.
    expect(normalizeProposal(lines, 140).lines[0]?.amountMinor).toBe(1_330_000);
  });

  it("never treats an unknown amount as zero and reports incomplete", () => {
    const r = normalizeProposal(
      [line({ amountMinor: 500_000 }), line({ amountMinor: null, description: "Bar" })],
      null,
    );
    expect(r.requiredKnownMinor).toBe(500_000);
    expect(r.unknownRequiredCount).toBe(1);
    expect(r.complete).toBe(false);
    expect(r.lines[1]).toMatchObject({
      state: "unknown",
      amountMinor: null,
      unknownReason: "no_amount",
    });
  });

  it("keeps optional unknowns and add-ons out of completeness and the required subtotal", () => {
    const r = normalizeProposal(
      [
        line({ amountMinor: 100_000 }),
        line({ amountMinor: 25_000, required: false }),
        line({ amountMinor: null, required: false }),
      ],
      null,
    );
    expect(r).toMatchObject({
      requiredKnownMinor: 100_000,
      optionalKnownMinor: 25_000,
      unknownRequiredCount: 0,
      unknownOptionalCount: 1,
      complete: true,
    });
  });

  it("needs a guest count for per-guest lines instead of guessing", () => {
    const r = normalizeProposal([line({ costMode: "per_guest", amountMinor: 9500 })], null);
    expect(r.lines[0]).toMatchObject({ state: "unknown", unknownReason: "no_guest_count" });
    expect(r.complete).toBe(false);
  });

  it("flags a guest count above the vendor's stated maximum but still prices it", () => {
    const r = normalizeProposal(
      [line({ costMode: "per_guest", amountMinor: 1000, maxQty: 100 })],
      120,
    );
    expect(r.lines[0]).toMatchObject({ amountMinor: 120_000, warnings: ["above_maximum"] });
  });

  it("prices quantity lines and treats a missing quantity as unknown", () => {
    const r = normalizeProposal(
      [
        line({ costMode: "quantity", amountMinor: 30_000, quantity: 4 }),
        line({ costMode: "quantity", amountMinor: 30_000, quantity: null }),
      ],
      null,
    );
    expect(r.lines[0]?.amountMinor).toBe(120_000);
    expect(r.lines[1]).toMatchObject({ state: "unknown", unknownReason: "no_quantity" });
  });

  it("adds nothing for an included line", () => {
    const parent = line({ amountMinor: 200_000 });
    const r = normalizeProposal(
      [parent, line({ costMode: "included", includedInLineId: parent.id, description: "Chairs" })],
      null,
    );
    expect(r.requiredKnownMinor).toBe(200_000);
    expect(r.lines[1]).toMatchObject({
      state: "included",
      amountMinor: null,
      includedInLineId: parent.id,
    });
    expect(r.complete).toBe(true);
  });

  it("applies a percentage only to flagged required lines and rounds half up", () => {
    const r = normalizeProposal(
      [
        line({ amountMinor: 100_001, percentBase: true }),
        line({ amountMinor: 50_000 }),
        line({ costMode: "percent", rateBp: 2200 }),
      ],
      null,
    );
    // 22% of 1,000.01 = 220.0022 -> 220.00
    expect(r.lines[2]).toMatchObject({ state: "known", amountMinor: 22_000 });
    expect(r.requiredKnownMinor).toBe(100_001 + 50_000 + 22_000);
    expect(percentOf(1, 5000)).toBe(1); // 0.5 rounds up
    expect(percentOf(1, 4999)).toBe(0);
  });

  it("makes a percentage partial, not complete, when a base line is unknown", () => {
    const r = normalizeProposal(
      [
        line({ amountMinor: 100_000, percentBase: true }),
        line({ amountMinor: null, percentBase: true }),
        line({ costMode: "percent", rateBp: 1000 }),
      ],
      null,
    );
    expect(r.lines[2]).toMatchObject({
      state: "partial",
      amountMinor: 10_000,
      warnings: ["base_incomplete"],
    });
    expect(r.complete).toBe(false);
    expect(r.unknownRequiredCount).toBe(2);
  });

  it("calls a percentage with no base unknown, not zero", () => {
    const r = normalizeProposal([line({ costMode: "percent", rateBp: 1000 })], null);
    expect(r.lines[0]).toMatchObject({ state: "unknown", unknownReason: "no_base" });
  });

  it("tracks how much of the known total rests on estimates", () => {
    const r = normalizeProposal(
      [line({ amountMinor: 100_000 }), line({ amountMinor: 40_000, certainty: "estimated" })],
      null,
    );
    expect(r).toMatchObject({ requiredKnownMinor: 140_000, requiredEstimatedMinor: 40_000 });
  });

  it("handles an empty proposal as complete with a zero known subtotal", () => {
    expect(normalizeProposal([], 100)).toMatchObject({ requiredKnownMinor: 0, complete: true });
  });

  it("stays exact at the largest allowed unit price and quantity", () => {
    const r = normalizeProposal(
      [line({ costMode: "per_guest", amountMinor: 100_000_000 })],
      100_000,
    );
    expect(r.requiredKnownMinor).toBe(10_000_000_000_000);
  });
});

describe("parseProposalInput", () => {
  it("needs a title only; blanks stay null", () => {
    expect(parseProposalInput({ title: "  Spring   quote " })).toEqual({
      ok: true,
      value: {
        title: "Spring quote",
        receivedOn: null,
        validUntil: null,
        sourceUrl: null,
        notes: null,
      },
    });
    expect(parseProposalInput({ title: " " })).toMatchObject({ ok: false });
  });
  it("rejects unsafe links and impossible dates", () => {
    const r = parseProposalInput({
      title: "x",
      sourceUrl: "javascript:alert(1)",
      validUntil: "2027-02-30",
    });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["sourceUrl", "validUntil"]);
  });
});

describe("parsePercentToBp", () => {
  it.each([
    ["22", 2200],
    ["8.25", 825],
    ["8.5%", 850],
    ["100", 10_000],
    ["0.01", 1],
  ])("reads %s", (text, bp) => expect(parsePercentToBp(text)).toBe(bp));
  it.each(["", "101", "0", "abc", "1.234", "-5"])("rejects %j", (text) => {
    const r = parsePercentToBp(text);
    expect(r === null || r === undefined).toBe(true);
  });
});

describe("parseLineInput", () => {
  it("keeps a blank amount unknown, never zero", () => {
    expect(parseLineInput("USD", { description: "Catering", costMode: "fixed" })).toMatchObject({
      ok: true,
      value: { amountMinor: null, required: true, certainty: "quoted" },
    });
  });
  it("reads per-guest bounds and rejects a maximum below the minimum", () => {
    expect(
      parseLineInput("USD", {
        description: "Dinner",
        costMode: "per_guest",
        amount: "95",
        minQty: "120",
      }),
    ).toMatchObject({ ok: true, value: { amountMinor: 9500, minQty: 120, maxQty: null } });
    expect(
      parseLineInput("USD", {
        description: "x",
        costMode: "per_guest",
        minQty: "50",
        maxQty: "40",
      }),
    ).toMatchObject({ ok: false });
  });
  it("drops fields that don't belong to the mode", () => {
    const r = parseLineInput("USD", {
      description: "Tax",
      costMode: "percent",
      ratePercent: "8.25",
      amount: "999",
      minQty: "5",
      percentBase: "yes",
    });
    expect(r).toMatchObject({
      ok: true,
      value: { rateBp: 825, amountMinor: null, minQty: null, percentBase: false },
    });
  });
  it("needs a rate for percentages and a parent for inclusions", () => {
    expect(parseLineInput("USD", { description: "x", costMode: "percent" })).toMatchObject({
      ok: false,
    });
    expect(
      parseLineInput("USD", { description: "x", costMode: "included", includedIn: "nope" }),
    ).toMatchObject({ ok: false });
  });
  it("rejects over-limit amounts, bad modes and long evidence", () => {
    expect(
      parseLineInput("USD", { description: "x", costMode: "fixed", amount: "1000001" }),
    ).toMatchObject({ ok: false });
    expect(parseLineInput("USD", { description: "x", costMode: "magic" })).toMatchObject({
      ok: false,
    });
    expect(
      parseLineInput("USD", { description: "x", costMode: "fixed", evidence: "e".repeat(501) }),
    ).toMatchObject({ ok: false });
  });
});
