import type { PriceBasis } from "@/domain/candidates/categories";
import { formatMinor } from "@/domain/money/money";
import { shortDate } from "@/features/plan/format";

/** "$8,500 for the whole event" or "$95 per guest"; null when no price is known. Never "$0". */
export function priceLabel(
  priceMinor: number | null,
  basis: PriceBasis | null,
  currency: string | null,
): string | null {
  if (priceMinor === null || basis === null || currency === null) return null;
  const amount = formatMinor(priceMinor, currency);
  return basis === "per_guest" ? `${amount} per guest` : `${amount} for the whole event`;
}

/** Truthful provenance: everything here was typed in by the couple. */
export function sourceLabel(sourceUrl: string | null, checkedOn: string | null): string {
  if (sourceUrl === null) return "Entered by you · no source link";
  return checkedOn
    ? `Entered by you · source last checked ${shortDate(checkedOn)}`
    : "Entered by you · source not checked yet";
}
