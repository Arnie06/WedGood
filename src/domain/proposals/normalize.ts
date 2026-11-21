/**
 * Compare-ready values for one proposal (docs/07-DOMAIN-RULES.md, cost modes).
 *
 * Pure and exact: integer minor units, BigInt for the one multiplication that can leave the
 * safe range. Unknown is never zero. The result keeps every line so a comparison can show
 * what is known, what is estimated and what is missing.
 */

export type CostMode = "fixed" | "per_guest" | "quantity" | "percent" | "included";
export type Certainty = "quoted" | "estimated";

export type ProposalLine = {
  id: string;
  description: string;
  costMode: CostMode;
  /** Fixed amount, or unit price for per_guest and quantity. Null = unknown. */
  amountMinor: number | null;
  quantity: number | null;
  minQty: number | null;
  maxQty: number | null;
  rateBp: number | null;
  percentBase: boolean;
  required: boolean;
  certainty: Certainty;
  includedInLineId: string | null;
};

export type UnknownReason = "no_amount" | "no_quantity" | "no_guest_count" | "no_base";
export type LineWarning = "minimum_applies" | "above_maximum" | "base_incomplete";

export type NormalizedLine = {
  id: string;
  description: string;
  costMode: CostMode;
  required: boolean;
  certainty: Certainty;
  /**
   * known: amountMinor is the full figure. included: no amount of its own, covered by
   * `includedInLineId`. partial: amountMinor is a lower bound. unknown: no figure.
   */
  state: "known" | "included" | "partial" | "unknown";
  amountMinor: number | null;
  unknownReason: UnknownReason | null;
  billedQuantity: number | null;
  includedInLineId: string | null;
  warnings: LineWarning[];
};

export type NormalizedProposal = {
  lines: NormalizedLine[];
  /** Sum of the known figures on required lines (a lower bound while incomplete). */
  requiredKnownMinor: number;
  /** Part of requiredKnownMinor that rests on couple-entered estimates, not quotes. */
  requiredEstimatedMinor: number;
  /** Known figures on optional add-ons, kept apart from the required subtotal. */
  optionalKnownMinor: number;
  unknownRequiredCount: number;
  unknownOptionalCount: number;
  /** True only when every required line has a full figure. */
  complete: boolean;
  guestCount: number | null;
};

const SCALE = 10_000n; // basis points

function mulToNumber(a: number, b: number): number {
  const value = BigInt(a) * BigInt(b);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Proposal amount is too large to add exactly");
  }
  return Number(value);
}

/** rate (basis points) × base, rounded half up to a whole minor unit. */
export function percentOf(baseMinor: number, rateBp: number): number {
  const value = (BigInt(baseMinor) * BigInt(rateBp) + SCALE / 2n) / SCALE;
  return Number(value);
}

/**
 * @param guestCount the scenario headcount per-guest lines are priced at; null when the
 *   couple hasn't set one, in which case per-guest lines are unknown rather than guessed.
 */
export function normalizeProposal(
  lines: readonly ProposalLine[],
  guestCount: number | null,
): NormalizedProposal {
  const out = new Map<string, NormalizedLine>();

  const base = (l: ProposalLine): NormalizedLine => ({
    id: l.id,
    description: l.description,
    costMode: l.costMode,
    required: l.required,
    certainty: l.certainty,
    state: "unknown",
    amountMinor: null,
    unknownReason: null,
    billedQuantity: null,
    includedInLineId: l.includedInLineId,
    warnings: [],
  });

  // Additive lines first; percentages need their bases.
  for (const l of lines) {
    if (l.costMode === "percent") continue;
    const n = base(l);
    if (l.costMode === "included") {
      n.state = "included";
    } else if (l.amountMinor === null) {
      n.unknownReason = "no_amount";
    } else if (l.costMode === "fixed") {
      n.state = "known";
      n.amountMinor = l.amountMinor;
    } else if (l.costMode === "quantity") {
      if (l.quantity === null) {
        n.unknownReason = "no_quantity";
      } else {
        n.state = "known";
        n.billedQuantity = l.quantity;
        n.amountMinor = mulToNumber(l.amountMinor, l.quantity);
      }
    } else if (guestCount === null) {
      n.unknownReason = "no_guest_count";
    } else {
      const billed = Math.max(guestCount, l.minQty ?? 0);
      if (l.minQty !== null && guestCount < l.minQty) n.warnings.push("minimum_applies");
      if (l.maxQty !== null && guestCount > l.maxQty) n.warnings.push("above_maximum");
      n.state = "known";
      n.billedQuantity = billed;
      n.amountMinor = mulToNumber(l.amountMinor, billed);
    }
    out.set(l.id, n);
  }

  // Percent lines apply to the required lines flagged as their base.
  const bases = lines.filter((l) => l.percentBase && l.required && l.costMode !== "percent");
  let baseKnown = 0;
  let baseIncomplete = false;
  for (const b of bases) {
    const n = out.get(b.id);
    if (n?.state === "known" && n.amountMinor !== null) baseKnown += n.amountMinor;
    else baseIncomplete = true;
  }
  for (const l of lines) {
    if (l.costMode !== "percent") continue;
    const n = base(l);
    if (bases.length === 0 || l.rateBp === null) {
      n.unknownReason = "no_base";
    } else {
      n.amountMinor = percentOf(baseKnown, l.rateBp);
      if (baseIncomplete) {
        n.state = "partial";
        n.warnings.push("base_incomplete");
      } else {
        n.state = "known";
      }
    }
    out.set(l.id, n);
  }

  const ordered = lines.map((l) => out.get(l.id) as NormalizedLine);
  let requiredKnownMinor = 0;
  let requiredEstimatedMinor = 0;
  let optionalKnownMinor = 0;
  let unknownRequiredCount = 0;
  let unknownOptionalCount = 0;
  for (const n of ordered) {
    const hasFigure = n.amountMinor !== null;
    if (hasFigure) {
      if (n.required) {
        requiredKnownMinor += n.amountMinor as number;
        if (n.certainty === "estimated") requiredEstimatedMinor += n.amountMinor as number;
      } else {
        optionalKnownMinor += n.amountMinor as number;
      }
    }
    if (n.state === "unknown" || n.state === "partial") {
      if (n.required) unknownRequiredCount += 1;
      else unknownOptionalCount += 1;
    }
  }
  return {
    lines: ordered,
    requiredKnownMinor,
    requiredEstimatedMinor,
    optionalKnownMinor,
    unknownRequiredCount,
    unknownOptionalCount,
    complete: unknownRequiredCount === 0,
    guestCount,
  };
}
