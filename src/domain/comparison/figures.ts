import type { ComparisonEvaluation } from "./evaluate";

/**
 * What the couple saw when they decided, flattened to plain JSON for the decision snapshot.
 * Built on the server from the same evaluation the page shows, never taken from the browser.
 */
export function buildFigures(e: ComparisonEvaluation) {
  return {
    guestCount: e.guestCount,
    currency: e.currency,
    costsFullyKnown: e.costsFullyKnown,
    lowestKnownCostIds: e.lowestKnownCostIds,
    options: e.options.map((o) => ({
      proposalId: o.proposalId,
      label: o.label,
      comparable: o.comparable,
      requiredKnownMinor: o.normalized?.requiredKnownMinor ?? null,
      optionalKnownMinor: o.normalized?.optionalKnownMinor ?? null,
      estimatedMinor: o.normalized?.requiredEstimatedMinor ?? null,
      unknownRequiredCount: o.unknownRequiredCount,
      complete: o.normalized?.complete ?? null,
      fit: o.fit,
      score: o.score.status === "scored" ? o.score.score : null,
      coverage: o.score.coverage,
      rank: o.rank,
      rankBlockers: o.rankBlockers,
    })),
  };
}

/**
 * Warnings the couple must acknowledge before choosing this option. Capacity is also enforced
 * by the database; unknown fees are enforced here.
 */
export function decisionWarnings(
  e: ComparisonEvaluation,
  proposalId: string,
): ("capacity_short" | "unknown_fees")[] {
  const o = e.options.find((x) => x.proposalId === proposalId);
  if (!o) return [];
  const out: ("capacity_short" | "unknown_fees")[] = [];
  if (o.fit.status === "short") out.push("capacity_short");
  if (o.unknownRequiredCount > 0) out.push("unknown_fees");
  return out;
}
