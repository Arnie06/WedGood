export const VENDOR_CATEGORIES = [
  { value: "photographer", label: "Photographer" },
  { value: "videographer", label: "Videographer" },
  { value: "caterer", label: "Caterer" },
  { value: "florist", label: "Florist" },
  { value: "music", label: "Music (DJ or band)" },
  { value: "planner", label: "Planner or coordinator" },
  { value: "bakery", label: "Cake or bakery" },
  { value: "attire", label: "Attire" },
  { value: "beauty", label: "Hair and makeup" },
  { value: "rentals", label: "Rentals" },
  { value: "officiant", label: "Officiant" },
  { value: "transportation", label: "Transportation" },
  { value: "stationery", label: "Stationery" },
  { value: "other", label: "Something else" },
] as const;

export type CandidateKind = "venue" | "vendor";
export type VendorCategory = (typeof VENDOR_CATEGORIES)[number]["value"];
export type CandidateCategory = "venue" | VendorCategory;

export function isVendorCategory(value: string): value is VendorCategory {
  return VENDOR_CATEGORIES.some((c) => c.value === value);
}

export function categoryLabel(category: string): string {
  if (category === "venue") return "Venue";
  return VENDOR_CATEGORIES.find((c) => c.value === category)?.label ?? "Something else";
}

export const PRICE_BASES = [
  { value: "total", label: "For the whole event" },
  { value: "per_guest", label: "Per guest" },
] as const;
export type PriceBasis = (typeof PRICE_BASES)[number]["value"];
