import { isDateOnly } from "@/domain/dates/date-only";
import { parseSourceUrl } from "@/domain/candidates/input";
import { parseMajorToMinor } from "@/domain/wedding/settings";
import type { Certainty, CostMode } from "./normalize";

export const MAX_TITLE = 160;
export const MAX_NOTES = 2000;
export const MAX_DESCRIPTION = 200;
export const MAX_EVIDENCE = 500;
export const MAX_LINE_MINOR = 100_000_000;
export const MAX_QTY = 100_000;
export const MAX_RATE_BP = 10_000;
export const MAX_LINES = 60;
export const MAX_PROPOSALS_PER_CANDIDATE = 20;

export const COST_MODES: readonly { value: CostMode; label: string; hint: string }[] = [
  { value: "fixed", label: "One amount", hint: "A single price for the whole item" },
  { value: "per_guest", label: "Per guest", hint: "A price for each guest, maybe with a minimum" },
  { value: "quantity", label: "Price × quantity", hint: "For example 4 hours at a set rate" },
  { value: "percent", label: "Percentage", hint: "Service charge, gratuity or tax" },
  { value: "included", label: "Included in another item", hint: "Already covered, no extra cost" },
];

// ---------------------------------------------------------------- proposal

export type ProposalField = "title" | "receivedOn" | "validUntil" | "sourceUrl" | "notes";
export type RawProposalInput = Partial<Record<ProposalField, string | null | undefined>>;
export type ProposalInput = {
  title: string;
  receivedOn: string | null;
  validUntil: string | null;
  sourceUrl: string | null;
  notes: string | null;
};
export type ProposalParseResult =
  | { ok: true; value: ProposalInput }
  | { ok: false; errors: Partial<Record<ProposalField, string>> };

const t = (v: string | null | undefined) => (v ?? "").trim();

export function parseProposalInput(raw: RawProposalInput): ProposalParseResult {
  const errors: Partial<Record<ProposalField, string>> = {};
  const title = t(raw.title).replace(/\s+/g, " ");
  if (title === "") errors.title = "Give this quote a short name.";
  else if (title.length > MAX_TITLE) errors.title = `Keep the name under ${MAX_TITLE} characters.`;

  const date = (v: string | null | undefined, field: "receivedOn" | "validUntil") => {
    if (t(v) === "") return null;
    if (isDateOnly(t(v))) return t(v);
    errors[field] = "Enter a valid date.";
    return null;
  };
  const receivedOn = date(raw.receivedOn, "receivedOn");
  const validUntil = date(raw.validUntil, "validUntil");

  let sourceUrl: string | null = null;
  if (t(raw.sourceUrl) !== "") {
    sourceUrl = parseSourceUrl(raw.sourceUrl ?? "");
    if (sourceUrl === null) errors.sourceUrl = "Enter a full web address starting with https://.";
  }
  const notes = t(raw.notes);
  if (notes.length > MAX_NOTES) errors.notes = `Keep notes under ${MAX_NOTES} characters.`;

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { title, receivedOn, validUntil, sourceUrl, notes: notes === "" ? null : notes },
  };
}

// ---------------------------------------------------------------- lines

export type LineField =
  | "description"
  | "costMode"
  | "amount"
  | "quantity"
  | "minQty"
  | "maxQty"
  | "ratePercent"
  | "percentBase"
  | "requirement"
  | "certainty"
  | "includedIn"
  | "evidence";
export type RawLineInput = Partial<Record<LineField, string | null | undefined>>;
export type LineInput = {
  description: string;
  costMode: CostMode;
  amountMinor: number | null;
  quantity: number | null;
  minQty: number | null;
  maxQty: number | null;
  rateBp: number | null;
  percentBase: boolean;
  required: boolean;
  certainty: Certainty;
  includedInLineId: string | null;
  evidence: string | null;
};
export type LineParseResult =
  { ok: true; value: LineInput } | { ok: false; errors: Partial<Record<LineField, string>> };

function parseCount(raw: string): number | null | undefined {
  const text = raw.trim().replace(/,/g, "");
  if (text === "") return null;
  if (!/^\d{1,6}$/.test(text)) return undefined;
  const n = Number(text);
  return n >= 1 && n <= MAX_QTY ? n : undefined;
}

/** "22" or "8.25" to basis points with exact string arithmetic; blank is null. */
export function parsePercentToBp(raw: string): number | null | undefined {
  const text = raw.trim().replace(/%$/, "").trim();
  if (text === "") return null;
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) return undefined;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
  return bp >= 1 && bp <= MAX_RATE_BP ? bp : undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates one proposal line from form strings. A blank amount stays null (unknown);
 * it is never zero. Fields that don't belong to the chosen mode are dropped.
 */
export function parseLineInput(currency: string, raw: RawLineInput): LineParseResult {
  const errors: Partial<Record<LineField, string>> = {};

  const description = t(raw.description).replace(/\s+/g, " ");
  if (description === "") errors.description = "Say what this cost is for.";
  else if (description.length > MAX_DESCRIPTION)
    errors.description = `Keep this under ${MAX_DESCRIPTION} characters.`;

  const modeText = t(raw.costMode);
  const costMode = COST_MODES.find((m) => m.value === modeText)?.value;
  if (!costMode) errors.costMode = "Choose how this cost is priced.";

  let amountMinor: number | null = null;
  let quantity: number | null = null;
  let minQty: number | null = null;
  let maxQty: number | null = null;
  let rateBp: number | null = null;
  let includedInLineId: string | null = null;
  let percentBase = false;

  if (costMode === "fixed" || costMode === "per_guest" || costMode === "quantity") {
    const amount = parseMajorToMinor(t(raw.amount), currency);
    if (amount === undefined || (amount !== null && amount > MAX_LINE_MINOR))
      errors.amount = "Enter an amount like 2500 or 95.50, or leave it blank if you don't know.";
    else amountMinor = amount;
    percentBase = t(raw.percentBase) === "yes";
  }
  if (costMode === "quantity") {
    const q = parseCount(raw.quantity ?? "");
    if (q === undefined) errors.quantity = "Enter a whole number, or leave it blank.";
    else quantity = q;
  }
  if (costMode === "per_guest") {
    const lo = parseCount(raw.minQty ?? "");
    const hi = parseCount(raw.maxQty ?? "");
    if (lo === undefined) errors.minQty = "Enter a whole number, or leave it blank.";
    else minQty = lo;
    if (hi === undefined) errors.maxQty = "Enter a whole number, or leave it blank.";
    else maxQty = hi;
    if (minQty !== null && maxQty !== null && minQty > maxQty)
      errors.maxQty = "The maximum can't be below the minimum.";
  }
  if (costMode === "percent") {
    const rate = parsePercentToBp(raw.ratePercent ?? "");
    if (rate === null || rate === undefined)
      errors.ratePercent = "Enter a percentage between 0.01 and 100.";
    else rateBp = rate;
  }
  if (costMode === "included") {
    const id = t(raw.includedIn);
    if (UUID.test(id)) includedInLineId = id.toLowerCase();
    else errors.includedIn = "Choose which item already covers this.";
  }

  const requirementText = t(raw.requirement) || "required";
  if (requirementText !== "required" && requirementText !== "optional")
    errors.requirement = "Choose required or optional.";
  const certaintyText = t(raw.certainty) || "quoted";
  if (certaintyText !== "quoted" && certaintyText !== "estimated")
    errors.certainty = "Choose quoted or estimated.";

  const evidence = t(raw.evidence);
  if (evidence.length > MAX_EVIDENCE)
    errors.evidence = `Keep this under ${MAX_EVIDENCE} characters.`;

  if (Object.keys(errors).length > 0 || !costMode) return { ok: false, errors };
  return {
    ok: true,
    value: {
      description,
      costMode,
      amountMinor,
      quantity,
      minQty,
      maxQty,
      rateBp,
      percentBase,
      required: requirementText === "required",
      certainty: certaintyText as Certainty,
      includedInLineId,
      evidence: evidence === "" ? null : evidence,
    },
  };
}
