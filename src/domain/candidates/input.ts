import { isDateOnly } from "@/domain/dates/date-only";
import { parseMajorToMinor } from "@/domain/wedding/settings";
import {
  isVendorCategory,
  type CandidateCategory,
  type CandidateKind,
  type PriceBasis,
} from "./categories";

export const MAX_NAME = 160;
export const MAX_NOTES = 2000;
export const MAX_URL = 2000;
export const MAX_CAPACITY = 100000;

export type CandidateField =
  | "name"
  | "category"
  | "sourceUrl"
  | "sourceCheckedOn"
  | "location"
  | "pricingDisplay"
  | "price"
  | "priceBasis"
  | "notes"
  | "seatedCapacity"
  | "ceremonyCapacity";

export type RawCandidateInput = Partial<Record<CandidateField, string | null | undefined>>;

export type CandidateInput = {
  name: string;
  category: CandidateCategory;
  sourceUrl: string | null;
  sourceCheckedOn: string | null;
  location: string | null;
  pricingDisplay: string | null;
  priceMinor: number | null;
  priceBasis: PriceBasis | null;
  notes: string | null;
  seatedCapacity: number | null;
  ceremonyCapacity: number | null;
};

export type CandidateParseResult =
  | { ok: true; value: CandidateInput }
  | { ok: false; errors: Partial<Record<CandidateField, string>> };

/**
 * A source link is only ever stored and shown as a link the person clicks; the app never
 * fetches it. Accepts http(s) with a host and no embedded credentials. Returns the
 * normalized URL, or null when it isn't acceptable.
 */
export function parseSourceUrl(raw: string): string | null {
  const text = raw.trim();
  if (text.length === 0 || text.length > MAX_URL || /\s/.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.hostname === "" || url.username !== "" || url.password !== "") return null;
  return url.href;
}

/** Host without "www." for compact display; falls back to the raw text. */
export function displayHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function parseCapacity(raw: string): number | null | undefined {
  const t = raw.trim().replace(/,/g, "");
  if (t === "") return null;
  if (!/^\d{1,6}$/.test(t)) return undefined;
  const n = Number(t);
  return n >= 1 && n <= MAX_CAPACITY ? n : undefined;
}

/**
 * Validates raw form strings. Blank optional fields become null (unknown), never zero or
 * a default. Price is read in the workspace currency and needs a basis when present.
 */
export function parseCandidateInput(
  kind: CandidateKind,
  currency: string,
  raw: RawCandidateInput,
): CandidateParseResult {
  const errors: Partial<Record<CandidateField, string>> = {};
  const text = (v: string | null | undefined) => (v ?? "").trim();

  const name = text(raw.name).replace(/\s+/g, " ");
  if (name === "") errors.name = "Give it a name.";
  else if (name.length > MAX_NAME) errors.name = `Keep the name under ${MAX_NAME} characters.`;

  let category: CandidateCategory = "venue";
  if (kind === "vendor") {
    const c = text(raw.category);
    if (isVendorCategory(c)) category = c;
    else errors.category = "Choose what kind of vendor this is.";
  }

  let sourceUrl: string | null = null;
  if (text(raw.sourceUrl) !== "") {
    sourceUrl = parseSourceUrl(raw.sourceUrl ?? "");
    if (sourceUrl === null) errors.sourceUrl = "Enter a full web address starting with https://.";
  }

  let sourceCheckedOn: string | null = null;
  if (text(raw.sourceCheckedOn) !== "") {
    if (isDateOnly(text(raw.sourceCheckedOn))) sourceCheckedOn = text(raw.sourceCheckedOn);
    else errors.sourceCheckedOn = "Enter a valid date.";
  }

  const location = text(raw.location).replace(/\s+/g, " ");
  if (location.length > 200) errors.location = "Use 200 characters or fewer.";

  const pricingDisplay = text(raw.pricingDisplay).replace(/\s+/g, " ");
  if (pricingDisplay.length > 200) errors.pricingDisplay = "Use 200 characters or fewer.";

  let priceMinor: number | null = null;
  const price = parseMajorToMinor(text(raw.price), currency);
  if (price === undefined)
    errors.price = "Enter an amount like 8500 or 8,500.50, or leave it blank.";
  else priceMinor = price;

  let priceBasis: PriceBasis | null = null;
  if (priceMinor !== null) {
    const b = text(raw.priceBasis);
    if (b === "total" || b === "per_guest") priceBasis = b;
    else errors.priceBasis = "Say whether this is for the whole event or per guest.";
  }

  const notes = text(raw.notes);
  if (notes.length > MAX_NOTES) errors.notes = `Keep notes under ${MAX_NOTES} characters.`;

  let seatedCapacity: number | null = null;
  let ceremonyCapacity: number | null = null;
  if (kind === "venue") {
    const seated = parseCapacity(raw.seatedCapacity ?? "");
    if (seated === undefined) errors.seatedCapacity = "Enter a whole number, or leave it blank.";
    else seatedCapacity = seated;
    const ceremony = parseCapacity(raw.ceremonyCapacity ?? "");
    if (ceremony === undefined)
      errors.ceremonyCapacity = "Enter a whole number, or leave it blank.";
    else ceremonyCapacity = ceremony;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name,
      category,
      sourceUrl,
      sourceCheckedOn,
      location: location === "" ? null : location,
      pricingDisplay: pricingDisplay === "" ? null : pricingDisplay,
      priceMinor,
      priceBasis,
      notes: notes === "" ? null : notes,
      seatedCapacity,
      ceremonyCapacity,
    },
  };
}
