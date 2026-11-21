import type { FitStatus, OptionEvaluation, RankBlocker } from "@/domain/comparison/evaluate";

export function fitLabel(fit: FitStatus, guests: number): string | null {
  switch (fit.status) {
    case "not_applicable":
      return null;
    case "unknown":
      return "Seating capacity not entered, so fit is unknown";
    case "fits":
      return `Seats ${fit.capacity} (you're planning for ${guests})`;
    case "short":
      return `Seats only ${fit.capacity}, which is ${fit.shortBy} short of your ${guests} guests`;
  }
}

const BLOCKER_TEXT: Record<RankBlocker, string> = {
  not_comparable: "Priced in a different currency, so it isn't compared.",
  incompatible: "Not ranked: it doesn't seat your guest count.",
  no_weights: "Not ranked: give at least one criterion a weight above 0.",
  no_ratings: "Not ranked yet: rate this option on a weighted criterion.",
  unknown_fees_not_accepted:
    "Not ranked: required costs are still unknown. Fill them in, or choose to rank anyway.",
};
export const blockerText = (b: RankBlocker) => BLOCKER_TEXT[b];

export function scoreLabel(o: OptionEvaluation): string {
  if (o.score.status === "unscored") {
    return o.score.reason === "no_weights" ? "No weights set" : "Not rated yet";
  }
  const pct = Math.round(o.score.coverage * 100);
  return `${o.score.score} out of 100, based on ${pct}% of your weights`;
}
