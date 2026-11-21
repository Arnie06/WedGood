import { formatMinor } from "@/domain/money/money";
import { shortDate } from "@/features/plan/format";
import type {
  NormalizedLine,
  NormalizedProposal,
  ProposalLine,
} from "@/domain/proposals/normalize";

const MODE_LABEL: Record<ProposalLine["costMode"], string> = {
  fixed: "One amount",
  per_guest: "Per guest",
  quantity: "Price × quantity",
  percent: "Percentage",
  included: "Included",
};
export const modeLabel = (mode: ProposalLine["costMode"]) => MODE_LABEL[mode];

/** The figure for one line. Unknown and partial are never shown as a plain amount. */
export function lineAmountLabel(n: NormalizedLine, currency: string): string {
  switch (n.state) {
    case "known":
      return formatMinor(n.amountMinor ?? 0, currency);
    case "partial":
      return `At least ${formatMinor(n.amountMinor ?? 0, currency)}`;
    case "included":
      return "Included";
    case "unknown":
      return "Not known yet";
  }
}

/** How the figure was reached, in words, for the line's source row. */
export function lineBasisLabel(
  l: ProposalLine,
  n: NormalizedLine,
  currency: string,
  parentName: string | null,
): string {
  const unit = l.amountMinor !== null ? formatMinor(l.amountMinor, currency) : null;
  switch (l.costMode) {
    case "fixed":
      return n.state === "known" ? "One amount" : "No amount entered";
    case "per_guest": {
      if (unit === null) return "No per-guest price entered";
      if (n.unknownReason === "no_guest_count")
        return `${unit} per guest; set a guest count in event settings to price this`;
      const min = n.warnings.includes("minimum_applies") ? ` (minimum ${l.minQty} applies)` : "";
      return `${unit} × ${n.billedQuantity} guests${min}`;
    }
    case "quantity":
      if (unit === null) return "No price entered";
      if (l.quantity === null) return `${unit} each; quantity not known yet`;
      return `${unit} × ${l.quantity}`;
    case "percent": {
      const rate = (l.rateBp ?? 0) / 100;
      if (n.unknownReason === "no_base")
        return `${rate}%, but no costs are marked as part of this percentage`;
      return `${rate}% of the costs marked for it`;
    }
    case "included":
      return parentName ? `Already covered by “${parentName}”` : "Already covered by another cost";
  }
}

export function warningLabels(n: NormalizedLine, l: ProposalLine): string[] {
  const out: string[] = [];
  if (n.warnings.includes("above_maximum"))
    out.push(`Above the vendor's stated maximum of ${l.maxQty} guests; the price may differ.`);
  if (n.warnings.includes("base_incomplete"))
    out.push("Some costs this applies to are unknown, so the real amount is higher.");
  return out;
}

/** Plain-language completeness statement for the summary. Never implies a full price when it isn't. */
export function completenessLabel(p: NormalizedProposal): string {
  if (p.lines.length === 0) return "No costs entered yet.";
  if (p.complete) return "Every required cost has an amount.";
  const n = p.unknownRequiredCount;
  return `${n} required ${n === 1 ? "cost is" : "costs are"} still unknown, so this is not the full price.`;
}

export function formatReceived(valid: string | null, received: string | null): string[] {
  return [
    received ? `Received ${shortDate(received)}` : "",
    valid ? `Valid until ${shortDate(valid)}` : "",
  ].filter(Boolean);
}
