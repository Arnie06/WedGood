/**
 * Comparison of 2–4 quotes for one scenario (docs/07-DOMAIN-RULES.md, "Discovery / comparison").
 *
 * Pure and deterministic. Cost and preference are kept apart on purpose:
 *  - cost is the known required subtotal from `normalizeProposal`, never a guess, with the
 *    unknown fees listed alongside it;
 *  - preference is a weighted average of the couple's own 0–100 ratings over the criteria they
 *    rated, shown with the share of total weight that was actually rated (coverage);
 *  - hard requirements (venue seating below the guest count) flag an option as incompatible
 *    and are never folded into the score.
 */
import {
  normalizeProposal,
  type NormalizedProposal,
  type ProposalLine,
} from "@/domain/proposals/normalize";

export const MAX_CRITERIA = 8;
export const MAX_WEIGHT = 10;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
/** Below this share of rated weight a score is shown but never called definitive. */
export const LOW_COVERAGE_BELOW = 0.6;

export type Criterion = { id: string; label: string; weight: number };

export type OptionInput = {
  /** Comparison option id. */
  id: string;
  proposalId: string;
  label: string;
  kind: "venue" | "vendor";
  seatedCapacity: number | null;
  currency: string;
  lines: readonly ProposalLine[];
  /** Criterion id to rating 0–100. Missing = not rated (unknown), never zero. */
  ratings: Readonly<Record<string, number>>;
};

export type FitStatus =
  | { status: "not_applicable" }
  | { status: "unknown" }
  | { status: "fits"; capacity: number }
  | { status: "short"; capacity: number; shortBy: number };

export type ScoreBlock =
  | {
      status: "scored";
      score: number;
      ratedWeight: number;
      totalWeight: number;
      coverage: number;
      lowCoverage: boolean;
    }
  | {
      status: "unscored";
      reason: "no_weights" | "no_ratings";
      ratedWeight: number;
      totalWeight: number;
      coverage: number;
    };

export type OptionEvaluation = {
  id: string;
  proposalId: string;
  label: string;
  comparable: boolean;
  /** Why the option is left out of totals and ranking, when `comparable` is false. */
  notComparableReason: "currency" | null;
  normalized: NormalizedProposal | null;
  fit: FitStatus;
  incompatible: boolean;
  score: ScoreBlock;
  /** Required fees still unknown or only partly known. Never zero-filled. */
  unknownRequiredCount: number;
  /** 1 = best. Null when the option can't be ranked yet; see `rankBlockers`. */
  rank: number | null;
  rankBlockers: RankBlocker[];
};

export type RankBlocker =
  "not_comparable" | "incompatible" | "no_weights" | "no_ratings" | "unknown_fees_not_accepted";

export type ComparisonEvaluation = {
  guestCount: number;
  currency: string;
  options: OptionEvaluation[];
  /** Ids of the options with the lowest known required subtotal, only when that is safe to say. */
  lowestKnownCostIds: string[];
  /** True when every comparable option has every required fee known. */
  costsFullyKnown: boolean;
};

function roundHalfUp(value: number, places: number): number {
  const f = 10 ** places;
  return Math.round((value + Number.EPSILON) * f) / f;
}

export function fitFor(
  kind: "venue" | "vendor",
  seatedCapacity: number | null,
  guestCount: number,
): FitStatus {
  if (kind !== "venue") return { status: "not_applicable" };
  if (seatedCapacity === null) return { status: "unknown" };
  if (seatedCapacity < guestCount) {
    return { status: "short", capacity: seatedCapacity, shortBy: guestCount - seatedCapacity };
  }
  return { status: "fits", capacity: seatedCapacity };
}

export function scoreFor(
  criteria: readonly Criterion[],
  ratings: Readonly<Record<string, number>>,
): ScoreBlock {
  const weighted = criteria.filter((c) => c.weight > 0);
  const totalWeight = weighted.reduce((s, c) => s + c.weight, 0);
  if (totalWeight === 0) {
    return {
      status: "unscored",
      reason: "no_weights",
      ratedWeight: 0,
      totalWeight: 0,
      coverage: 0,
    };
  }
  let ratedWeight = 0;
  let sum = 0;
  for (const c of weighted) {
    const r = ratings[c.id];
    if (r === undefined) continue;
    ratedWeight += c.weight;
    sum += c.weight * r;
  }
  const coverage = ratedWeight / totalWeight;
  if (ratedWeight === 0) {
    return { status: "unscored", reason: "no_ratings", ratedWeight, totalWeight, coverage };
  }
  return {
    status: "scored",
    score: roundHalfUp(sum / ratedWeight, 1),
    ratedWeight,
    totalWeight,
    coverage,
    lowCoverage: coverage < LOW_COVERAGE_BELOW,
  };
}

export function evaluateComparison(input: {
  guestCount: number;
  currency: string;
  criteria: readonly Criterion[];
  options: readonly OptionInput[];
  /** The couple explicitly accepted ranking while some required fees are unknown. */
  acceptsUnknowns: boolean;
}): ComparisonEvaluation {
  const { guestCount, currency, criteria, acceptsUnknowns } = input;

  const evaluated: OptionEvaluation[] = input.options.map((o) => {
    const comparable = o.currency === currency;
    const normalized = comparable ? normalizeProposal(o.lines, guestCount) : null;
    const fit = fitFor(o.kind, o.seatedCapacity, guestCount);
    const score = scoreFor(criteria, o.ratings);
    const unknownRequiredCount = normalized?.unknownRequiredCount ?? 0;
    const rankBlockers: RankBlocker[] = [];
    if (!comparable) rankBlockers.push("not_comparable");
    if (fit.status === "short") rankBlockers.push("incompatible");
    if (score.status === "unscored") rankBlockers.push(score.reason);
    if (normalized && !normalized.complete && !acceptsUnknowns) {
      rankBlockers.push("unknown_fees_not_accepted");
    }
    return {
      id: o.id,
      proposalId: o.proposalId,
      label: o.label,
      comparable,
      notComparableReason: comparable ? null : "currency",
      normalized,
      fit,
      incompatible: fit.status === "short",
      score,
      unknownRequiredCount,
      rank: null,
      rankBlockers,
    };
  });

  // Rank only options with no blockers; ties share nothing: input order breaks them, so the
  // caller's sort (name or the couple's own order) decides and the result stays stable.
  const rankable = evaluated
    .map((e, index) => ({ e, index }))
    .filter(({ e }) => e.rankBlockers.length === 0 && e.score.status === "scored");
  rankable.sort((a, b) => {
    const sa = a.e.score.status === "scored" ? a.e.score.score : 0;
    const sb = b.e.score.status === "scored" ? b.e.score.score : 0;
    return sb - sa || a.index - b.index;
  });
  rankable.forEach(({ e }, i) => {
    e.rank = i + 1;
  });

  const comparableOptions = evaluated.filter((e) => e.normalized !== null);
  const costsFullyKnown =
    comparableOptions.length > 0 && comparableOptions.every((e) => e.normalized?.complete === true);
  // "Lowest" is only a safe claim when no option is hiding an unknown required fee that could
  // still change the order.
  let lowestKnownCostIds: string[] = [];
  if (costsFullyKnown) {
    const min = Math.min(...comparableOptions.map((e) => e.normalized?.requiredKnownMinor ?? 0));
    lowestKnownCostIds = comparableOptions
      .filter((e) => e.normalized?.requiredKnownMinor === min)
      .map((e) => e.id);
  }
  return { guestCount, currency, options: evaluated, lowestKnownCostIds, costsFullyKnown };
}
