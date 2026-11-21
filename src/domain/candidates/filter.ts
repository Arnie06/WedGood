import type { CandidateKind, PriceBasis } from "./categories";

/** The fields filtering needs; the full record carries more. */
export type FilterableCandidate = {
  kind: CandidateKind;
  category: string;
  name: string;
  location: string | null;
  notes: string | null;
  pricingDisplay: string | null;
  priceMinor: number | null;
  priceBasis: PriceBasis | null;
  priceCurrency: string | null;
  seatedCapacity: number | null;
  isFavorite: boolean;
};

export type CandidateFilters = {
  q: string;
  /** "venue", "all", or a vendor category value. */
  category: string;
  minSeated: number | null;
  /** Upper bound in minor units of the workspace currency, "for the whole event" basis only. */
  maxPriceMinor: number | null;
  favoritesOnly: boolean;
  /** Also keep candidates whose price or capacity is unknown when a numeric filter applies. */
  includeUnknown: boolean;
};

export const NO_FILTERS: CandidateFilters = {
  q: "",
  category: "all",
  minSeated: null,
  maxPriceMinor: null,
  favoritesOnly: false,
  includeUnknown: false,
};

export type FilterResult<T> = {
  matches: T[];
  /** Candidates that pass every other filter but were held back because a value is unknown. */
  hiddenUnknown: number;
};

function normalize(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
}

/**
 * Unknown is never silently dropped: when a numeric filter (capacity or price) is active,
 * candidates with that value unknown are held out and counted, or kept when the person
 * opts in. A per-guest price can't be compared with a whole-event ceiling, so it counts as
 * unknown for the price filter, as does a price in another currency.
 */
export function filterCandidates<T extends FilterableCandidate>(
  items: readonly T[],
  filters: CandidateFilters,
  currency: string,
): FilterResult<T> {
  const q = normalize(filters.q.trim());
  const matches: T[] = [];
  let hiddenUnknown = 0;
  for (const c of items) {
    if (filters.category !== "all" && c.category !== filters.category) continue;
    if (filters.favoritesOnly && !c.isFavorite) continue;
    if (q !== "") {
      const hay = normalize(
        [c.name, c.location ?? "", c.notes ?? "", c.pricingDisplay ?? ""].join(" "),
      );
      if (!hay.includes(q)) continue;
    }
    let unknown = false;
    let fails = false;
    if (filters.minSeated !== null) {
      if (c.kind !== "venue") fails = true;
      else if (c.seatedCapacity === null) unknown = true;
      else if (c.seatedCapacity < filters.minSeated) fails = true;
    }
    if (filters.maxPriceMinor !== null) {
      const comparable =
        c.priceMinor !== null && c.priceBasis === "total" && c.priceCurrency === currency;
      if (!comparable) unknown = true;
      else if ((c.priceMinor as number) > filters.maxPriceMinor) fails = true;
    }
    if (fails) continue;
    if (unknown && !filters.includeUnknown) {
      hiddenUnknown += 1;
      continue;
    }
    matches.push(c);
  }
  return { matches, hiddenUnknown };
}

/** Reads filters from URL search params; anything malformed is ignored, not guessed. */
export function parseFilters(
  params: Record<string, string | string[] | undefined>,
  currency: string,
  parseMoney: (text: string, currency: string) => number | null | undefined,
): { filters: CandidateFilters; errors: { maxPrice?: string; minSeated?: string } } {
  const one = (k: string) => {
    const v = params[k];
    return (Array.isArray(v) ? v[0] : v) ?? "";
  };
  const errors: { maxPrice?: string; minSeated?: string } = {};
  const seatedText = one("seated").trim();
  let minSeated: number | null = null;
  if (seatedText !== "") {
    if (/^\d{1,6}$/.test(seatedText) && Number(seatedText) >= 1) minSeated = Number(seatedText);
    else errors.minSeated = "Enter a whole number of guests.";
  }
  let maxPriceMinor: number | null = null;
  const priceText = one("price").trim();
  if (priceText !== "") {
    const p = parseMoney(priceText, currency);
    if (p === undefined || p === null) errors.maxPrice = "Enter an amount like 10000.";
    else maxPriceMinor = p;
  }
  return {
    filters: {
      q: one("q").slice(0, 100),
      category: one("category").trim() || "all",
      minSeated,
      maxPriceMinor,
      favoritesOnly: one("favorites") === "1",
      includeUnknown: one("unknown") === "1",
    },
    errors,
  };
}
