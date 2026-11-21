import { MAX_CRITERIA, MAX_OPTIONS, MAX_WEIGHT, MIN_OPTIONS, type Criterion } from "./evaluate";

export const DEFAULT_CRITERIA: readonly { label: string; weight: number }[] = [
  { label: "Style and feel", weight: 5 },
  { label: "Service and communication", weight: 5 },
  { label: "Flexibility", weight: 5 },
];

export type ComparisonField = "title" | "guestCount" | "proposals" | "criteria" | "ratings";

export type Parsed<T> =
  { ok: true; value: T } | { ok: false; errors: Partial<Record<ComparisonField, string>> };

const INT = /^\d{1,6}$/;

export function parseGuestCount(raw: string): number | null {
  const t = raw.trim();
  if (!INT.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 100_000 ? n : null;
}

export function parseSetup(raw: {
  title: string;
  guestCount: string;
  proposalIds: readonly string[];
}): Parsed<{ title: string; guestCount: number; proposalIds: string[] }> {
  const errors: Partial<Record<ComparisonField, string>> = {};
  const title = raw.title.trim();
  if (title.length < 1 || title.length > 160)
    errors.title = "Give this comparison a name (up to 160 characters).";
  const guestCount = parseGuestCount(raw.guestCount);
  if (guestCount === null) errors.guestCount = "Enter a whole number of guests, 1 or more.";
  const ids = [...new Set(raw.proposalIds)];
  if (ids.length < MIN_OPTIONS || ids.length > MAX_OPTIONS) {
    errors.proposals = `Choose ${MIN_OPTIONS} to ${MAX_OPTIONS} quotes to compare.`;
  }
  if (Object.keys(errors).length > 0 || guestCount === null) return { ok: false, errors };
  return { ok: true, value: { title, guestCount, proposalIds: ids } };
}

/** Parses weights typed into the criteria form: labels and 0–10 weights, blank rows ignored. */
export function parseCriteria(
  rows: readonly { id: string; label: string; weight: string }[],
): Parsed<Criterion[]> {
  const out: Criterion[] = [];
  for (const r of rows) {
    const label = r.label.trim();
    if (label === "" && r.weight.trim() === "") continue;
    if (label.length < 1 || label.length > 60) {
      return {
        ok: false,
        errors: { criteria: "Each criterion needs a name of up to 60 characters." },
      };
    }
    if (!/^\d{1,2}$/.test(r.weight.trim()) || Number(r.weight) > MAX_WEIGHT) {
      return {
        ok: false,
        errors: { criteria: `Weights are whole numbers from 0 to ${MAX_WEIGHT}.` },
      };
    }
    out.push({ id: r.id, label, weight: Number(r.weight) });
  }
  if (out.length > MAX_CRITERIA) {
    return { ok: false, errors: { criteria: `Use at most ${MAX_CRITERIA} criteria.` } };
  }
  if (new Set(out.map((c) => c.label.toLowerCase())).size !== out.length) {
    return { ok: false, errors: { criteria: "Each criterion needs a different name." } };
  }
  return { ok: true, value: out };
}

/** A blank rating means "not rated yet". It is never read as 0. */
export function parseRating(raw: string): number | null | "invalid" {
  const t = raw.trim();
  if (t === "") return null;
  if (!/^\d{1,3}$/.test(t)) return "invalid";
  const n = Number(t);
  return n <= 100 ? n : "invalid";
}
