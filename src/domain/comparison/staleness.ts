/**
 * Detects that a recorded decision was made on inputs that have since changed
 * (docs/07-DOMAIN-RULES.md: later proposal changes mark the comparison stale, never silently
 * change the decision). The state object is built by the database (`comparison_source_state`),
 * so the decision's stored state and the current one come from the same code.
 */
export type SourceState = {
  guestCount: number;
  currency: string;
  inputsHash: string;
  options: {
    proposalId: string;
    proposalVersion: number;
    proposalArchived: boolean;
    candidateId: string;
    candidateVersion: number;
  }[];
};

export type StaleReason =
  | "guest_count"
  | "currency"
  | "ratings_or_weights"
  | "options_changed"
  | "quote_changed"
  | "quote_removed"
  | "vendor_changed";

export function staleReasons(recorded: SourceState, current: SourceState): StaleReason[] {
  const reasons = new Set<StaleReason>();
  if (recorded.guestCount !== current.guestCount) reasons.add("guest_count");
  if (recorded.currency !== current.currency) reasons.add("currency");
  if (recorded.inputsHash !== current.inputsHash) reasons.add("ratings_or_weights");
  const now = new Map(current.options.map((o) => [o.proposalId, o]));
  if (recorded.options.length !== current.options.length) reasons.add("options_changed");
  for (const before of recorded.options) {
    const after = now.get(before.proposalId);
    if (!after) {
      reasons.add("options_changed");
      continue;
    }
    if (after.proposalArchived && !before.proposalArchived) reasons.add("quote_removed");
    else if (after.proposalVersion !== before.proposalVersion) reasons.add("quote_changed");
    if (after.candidateVersion !== before.candidateVersion) reasons.add("vendor_changed");
  }
  return [...reasons];
}

export const STALE_REASON_TEXT: Record<StaleReason, string> = {
  guest_count: "the guest count for this comparison changed",
  currency: "the wedding currency changed",
  ratings_or_weights: "ratings or weights changed",
  options_changed: "the quotes being compared changed",
  quote_changed: "a quote was edited",
  quote_removed: "a quote was removed",
  vendor_changed: "a venue or vendor record changed",
};
