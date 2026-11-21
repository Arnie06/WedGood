import { describe, expect, it } from "vitest";
import type { ProposalLine } from "@/domain/proposals/normalize";
import { evaluateComparison, fitFor, scoreFor, type Criterion, type OptionInput } from "./evaluate";
import { parseCriteria, parseRating, parseSetup } from "./input";
import { staleReasons, type SourceState } from "./staleness";

const line = (over: Partial<ProposalLine>): ProposalLine => ({
  id: "l1",
  description: "Venue hire",
  costMode: "fixed",
  amountMinor: 1_000_00,
  quantity: null,
  minQty: null,
  maxQty: null,
  rateBp: null,
  percentBase: false,
  required: true,
  certainty: "quoted",
  includedInLineId: null,
  ...over,
});
const crit: Criterion[] = [
  { id: "a", label: "Style", weight: 6 },
  { id: "b", label: "Service", weight: 4 },
];
const opt = (id: string, over: Partial<OptionInput> = {}): OptionInput => ({
  id,
  proposalId: `p-${id}`,
  label: id,
  kind: "vendor",
  seatedCapacity: null,
  currency: "USD",
  lines: [line({})],
  ratings: { a: 80, b: 60 },
  ...over,
});
const run = (
  options: OptionInput[],
  extra: Partial<Parameters<typeof evaluateComparison>[0]> = {},
) =>
  evaluateComparison({
    guestCount: 100,
    currency: "USD",
    criteria: crit,
    options,
    acceptsUnknowns: false,
    ...extra,
  });

describe("scoreFor", () => {
  it("is the weighted average of rated criteria over rated weight", () => {
    const s = scoreFor(crit, { a: 80, b: 60 });
    expect(s).toMatchObject({ status: "scored", score: 72, coverage: 1, lowCoverage: false });
  });
  it("leaves unrated criteria out and reports coverage instead of treating them as zero", () => {
    const s = scoreFor(crit, { a: 80 });
    expect(s).toMatchObject({
      status: "scored",
      score: 80,
      ratedWeight: 6,
      totalWeight: 10,
      coverage: 0.6,
    });
    expect(s.status === "scored" && s.lowCoverage).toBe(false);
  });
  it("flags low coverage", () => {
    const s = scoreFor(crit, { b: 90 });
    expect(s.status === "scored" && s.lowCoverage).toBe(true);
  });
  it("is unscored with no positive weights, even with ratings", () => {
    expect(scoreFor([{ id: "a", label: "x", weight: 0 }], { a: 90 })).toMatchObject({
      status: "unscored",
      reason: "no_weights",
    });
    expect(scoreFor([], {})).toMatchObject({ status: "unscored", reason: "no_weights" });
  });
  it("is unscored with no ratings on weighted criteria", () => {
    expect(scoreFor(crit, {})).toMatchObject({ status: "unscored", reason: "no_ratings" });
  });
  it("ignores ratings on zero-weight criteria", () => {
    const c: Criterion[] = [...crit, { id: "z", label: "Z", weight: 0 }];
    expect(scoreFor(c, { a: 80, b: 60, z: 0 })).toMatchObject({ score: 72, coverage: 1 });
  });
  it("rounds half up to one decimal", () => {
    const c: Criterion[] = [
      { id: "a", label: "A", weight: 3 },
      { id: "b", label: "B", weight: 4 },
    ];
    expect(scoreFor(c, { a: 50, b: 51 })).toMatchObject({ score: 50.6 });
  });
});

describe("fitFor", () => {
  it("applies to venues only and keeps unknown capacity unknown", () => {
    expect(fitFor("vendor", null, 100)).toEqual({ status: "not_applicable" });
    expect(fitFor("venue", null, 100)).toEqual({ status: "unknown" });
  });
  it("is short only when verified capacity is below the guest count; equal fits", () => {
    expect(fitFor("venue", 99, 100)).toEqual({ status: "short", capacity: 99, shortBy: 1 });
    expect(fitFor("venue", 100, 100)).toEqual({ status: "fits", capacity: 100 });
  });
});

describe("evaluateComparison", () => {
  it("ranks by score, ties broken by input order", () => {
    const r = run([
      opt("x", { ratings: { a: 70, b: 70 } }),
      opt("y", { ratings: { a: 90, b: 90 } }),
      opt("z", { ratings: { a: 70, b: 70 } }),
    ]);
    expect(r.options.map((o) => [o.id, o.rank])).toEqual([
      ["x", 2],
      ["y", 1],
      ["z", 3],
    ]);
  });
  it("never ranks an incompatible venue, and says why", () => {
    const r = run([
      opt("small", { kind: "venue", seatedCapacity: 80, ratings: { a: 100, b: 100 } }),
      opt("ok"),
    ]);
    const small = r.options[0]!;
    expect(small.incompatible).toBe(true);
    expect(small.rank).toBeNull();
    expect(small.rankBlockers).toContain("incompatible");
    expect(r.options[1]!.rank).toBe(1);
  });
  it("shows unknown capacity as unknown, not as a pass or a fail", () => {
    const r = run([opt("v", { kind: "venue", seatedCapacity: null }), opt("w")]);
    expect(r.options[0]!.fit).toEqual({ status: "unknown" });
    expect(r.options[0]!.incompatible).toBe(false);
  });
  it("blocks ranking while required fees are unknown unless accepted", () => {
    const unknownFee = [
      line({}),
      line({ id: "l2", description: "Service charge", amountMinor: null }),
    ];
    const blocked = run([opt("u", { lines: unknownFee }), opt("k")]);
    expect(blocked.options[0]!.rank).toBeNull();
    expect(blocked.options[0]!.rankBlockers).toContain("unknown_fees_not_accepted");
    expect(blocked.options[0]!.unknownRequiredCount).toBe(1);
    const accepted = run([opt("u", { lines: unknownFee }), opt("k")], { acceptsUnknowns: true });
    expect(accepted.options[0]!.rank).not.toBeNull();
  });
  it("keeps unknown fees out of the known subtotal (never zero) and does not claim the lowest cost", () => {
    const unknownFee = [
      line({ amountMinor: 500_00 }),
      line({ id: "l2", description: "Service", amountMinor: null }),
    ];
    const r = run([
      opt("u", { lines: unknownFee }),
      opt("k", { lines: [line({ amountMinor: 900_00 })] }),
    ]);
    expect(r.options[0]!.normalized?.requiredKnownMinor).toBe(500_00);
    expect(r.costsFullyKnown).toBe(false);
    expect(r.lowestKnownCostIds).toEqual([]);
  });
  it("names the lowest cost only when every required fee is known, including ties", () => {
    const r = run([
      opt("a", { lines: [line({ amountMinor: 900_00 })] }),
      opt("b", { lines: [line({ amountMinor: 800_00 })] }),
      opt("c", { lines: [line({ amountMinor: 800_00 })] }),
    ]);
    expect(r.lowestKnownCostIds).toEqual(["b", "c"]);
  });
  it("prices per-guest lines at the comparison's guest count, same for every option", () => {
    const perGuest = [line({ costMode: "per_guest", amountMinor: 50_00 })];
    const r = run([opt("a", { lines: perGuest }), opt("b", { lines: perGuest })], {
      guestCount: 120,
    });
    expect(r.options.map((o) => o.normalized?.requiredKnownMinor)).toEqual([6000_00, 6000_00]);
  });
  it("does not compare a quote in another currency", () => {
    const r = run([opt("eur", { currency: "EUR" }), opt("usd")]);
    expect(r.options[0]).toMatchObject({
      comparable: false,
      notComparableReason: "currency",
      normalized: null,
      rank: null,
    });
    expect(r.costsFullyKnown).toBe(true);
  });
  it("does not rank anything with no weights", () => {
    const r = run([opt("a"), opt("b")], { criteria: [{ id: "a", label: "Style", weight: 0 }] });
    expect(r.options.every((o) => o.rank === null && o.rankBlockers.includes("no_weights"))).toBe(
      true,
    );
  });
  it("counts an included row as no extra cost and not unknown", () => {
    const lines = [
      line({}),
      line({
        id: "l2",
        description: "Tables",
        costMode: "included",
        amountMinor: null,
        includedInLineId: "l1",
      }),
    ];
    const r = run([opt("a", { lines }), opt("b")]);
    expect(r.options[0]!.normalized?.requiredKnownMinor).toBe(1_000_00);
    expect(r.options[0]!.unknownRequiredCount).toBe(0);
  });
});

const state = (over: Partial<SourceState> = {}): SourceState => ({
  guestCount: 100,
  currency: "USD",
  inputsHash: "h1",
  options: [
    {
      proposalId: "p1",
      proposalVersion: 3,
      proposalArchived: false,
      candidateId: "c1",
      candidateVersion: 2,
    },
    {
      proposalId: "p2",
      proposalVersion: 1,
      proposalArchived: false,
      candidateId: "c2",
      candidateVersion: 1,
    },
  ],
  ...over,
});

describe("staleReasons", () => {
  it("is empty when nothing changed", () => expect(staleReasons(state(), state())).toEqual([]));
  it("reports each kind of change", () => {
    expect(staleReasons(state(), state({ guestCount: 120 }))).toEqual(["guest_count"]);
    expect(staleReasons(state(), state({ inputsHash: "h2" }))).toEqual(["ratings_or_weights"]);
    expect(staleReasons(state(), state({ currency: "EUR" }))).toEqual(["currency"]);
    const edited = state();
    edited.options[0] = { ...edited.options[0]!, proposalVersion: 4 };
    expect(staleReasons(state(), edited)).toEqual(["quote_changed"]);
    const archived = state();
    archived.options[1] = { ...archived.options[1]!, proposalArchived: true, proposalVersion: 2 };
    expect(staleReasons(state(), archived)).toEqual(["quote_removed"]);
    const vendor = state();
    vendor.options[0] = { ...vendor.options[0]!, candidateVersion: 3 };
    expect(staleReasons(state(), vendor)).toEqual(["vendor_changed"]);
  });
  it("reports a different set of options", () => {
    const fewer = state();
    fewer.options.pop();
    expect(staleReasons(state(), fewer)).toContain("options_changed");
  });
});

describe("input parsing", () => {
  it("requires 2 to 4 distinct quotes, a name and a positive whole guest count", () => {
    expect(
      parseSetup({ title: "Venues", guestCount: "100", proposalIds: ["a", "b"] }),
    ).toMatchObject({ ok: true });
    expect(
      parseSetup({ title: "Venues", guestCount: "100", proposalIds: ["a", "a"] }),
    ).toMatchObject({ ok: false });
    expect(
      parseSetup({ title: "Venues", guestCount: "100", proposalIds: ["a", "b", "c", "d", "e"] }),
    ).toMatchObject({ ok: false });
    expect(parseSetup({ title: " ", guestCount: "0", proposalIds: ["a", "b"] })).toMatchObject({
      ok: false,
      errors: { title: expect.any(String), guestCount: expect.any(String) },
    });
    expect(parseSetup({ title: "x", guestCount: "1.5", proposalIds: ["a", "b"] })).toMatchObject({
      ok: false,
    });
  });
  it("parses criteria, dropping blank rows and rejecting bad weights and duplicates", () => {
    expect(
      parseCriteria([
        { id: "a", label: "Style", weight: "7" },
        { id: "b", label: "", weight: "" },
      ]),
    ).toEqual({ ok: true, value: [{ id: "a", label: "Style", weight: 7 }] });
    expect(parseCriteria([{ id: "a", label: "Style", weight: "11" }]).ok).toBe(false);
    expect(parseCriteria([{ id: "a", label: "Style", weight: "-1" }]).ok).toBe(false);
    expect(parseCriteria([{ id: "a", label: "Style", weight: "" }]).ok).toBe(false);
    expect(
      parseCriteria([
        { id: "a", label: "Style", weight: "1" },
        { id: "b", label: "style", weight: "2" },
      ]).ok,
    ).toBe(false);
  });
  it("treats a blank rating as not rated, never zero", () => {
    expect(parseRating("")).toBeNull();
    expect(parseRating("0")).toBe(0);
    expect(parseRating("100")).toBe(100);
    expect(parseRating("101")).toBe("invalid");
    expect(parseRating("-5")).toBe("invalid");
    expect(parseRating("abc")).toBe("invalid");
  });
});
