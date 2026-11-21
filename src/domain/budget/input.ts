import { parseMajorToMinor } from "@/domain/wedding/settings";
import type { BudgetCostMode } from "./summary";

export const MAX_CATEGORY_NAME = 80;
export const MAX_ITEM_NAME = 160;
export const MAX_ITEM_NOTES = 1000;
/** Per amount, so sums of up to MAX_ITEMS items stay exact in JS numbers. */
export const MAX_ITEM_MINOR = 100_000_000;
export const MAX_ITEM_QTY = 100_000;
export const MAX_ITEMS = 300;
export const MAX_CATEGORIES = 40;
export const MAX_ALLOCATION_MINOR = 10_000_000_000;

export const BUDGET_COST_MODES: readonly { value: BudgetCostMode; label: string; hint: string }[] =
  [
    { value: "fixed", label: "One amount", hint: "A single price for the whole item" },
    {
      value: "per_guest",
      label: "Per guest",
      hint: "A price for each guest, maybe with a minimum",
    },
    { value: "quantity", label: "Price × quantity", hint: "For example 4 hours at a set rate" },
  ];

export const SUGGESTED_CATEGORIES = [
  "Venue",
  "Catering and bar",
  "Photography and video",
  "Attire and beauty",
  "Flowers and decor",
  "Music and entertainment",
  "Stationery",
  "Transport and lodging",
  "Rings and gifts",
  "Other",
] as const;

const t = (v: string | null | undefined) => (v ?? "").trim();
const isMode = (v: string): v is BudgetCostMode => BUDGET_COST_MODES.some((m) => m.value === v);

// ---------------------------------------------------------------- category

export type CategoryField = "name" | "allocation";
export type CategoryInput = { name: string; allocationMinor: number | null };
export type CategoryParseResult =
  | { ok: true; value: CategoryInput }
  | { ok: false; errors: Partial<Record<CategoryField, string>> };

export function parseCategoryInput(
  raw: Partial<Record<CategoryField, string | null | undefined>>,
  currency: string,
): CategoryParseResult {
  const errors: Partial<Record<CategoryField, string>> = {};
  const name = t(raw.name).replace(/\s+/g, " ");
  if (name === "") errors.name = "Give this category a name, like “Flowers”.";
  else if (name.length > MAX_CATEGORY_NAME)
    errors.name = `Keep the name under ${MAX_CATEGORY_NAME} characters.`;

  let allocationMinor: number | null = null;
  const parsed = parseMajorToMinor(t(raw.allocation), currency);
  if (parsed === undefined || (parsed !== null && parsed > MAX_ALLOCATION_MINOR)) {
    errors.allocation = "Enter an amount like 4000 or 4,000.50, or leave it blank.";
  } else allocationMinor = parsed;

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { name, allocationMinor } };
}

// ---------------------------------------------------------------- item

export type ItemField =
  "name" | "category" | "costMode" | "amount" | "quantity" | "minQty" | "notes";
export type RawItemInput = Partial<Record<ItemField, string | null | undefined>>;
export type ItemInput = {
  name: string;
  categoryId: string;
  costMode: BudgetCostMode;
  amountMinor: number | null;
  quantity: number | null;
  minQty: number | null;
  notes: string | null;
};
export type ItemParseResult =
  { ok: true; value: ItemInput } | { ok: false; errors: Partial<Record<ItemField, string>> };

function whole(text: string, max: number, min: number): number | null | undefined {
  if (text === "") return null;
  if (!/^\d{1,7}$/.test(text)) return undefined;
  const n = Number(text);
  return n >= min && n <= max ? n : undefined;
}

export function parseItemInput(raw: RawItemInput, currency: string): ItemParseResult {
  const errors: Partial<Record<ItemField, string>> = {};
  const name = t(raw.name).replace(/\s+/g, " ");
  if (name === "") errors.name = "Give this cost a short name, like “Florist deposit”.";
  else if (name.length > MAX_ITEM_NAME)
    errors.name = `Keep the name under ${MAX_ITEM_NAME} characters.`;

  const categoryId = t(raw.category);
  if (categoryId === "") errors.category = "Choose a category.";

  const modeText = t(raw.costMode) || "fixed";
  const costMode: BudgetCostMode = isMode(modeText) ? modeText : "fixed";
  if (!isMode(modeText)) errors.costMode = "Choose how this cost is calculated.";

  let amountMinor: number | null = null;
  const amount = parseMajorToMinor(t(raw.amount), currency);
  if (amount === undefined || (amount !== null && amount > MAX_ITEM_MINOR)) {
    errors.amount = "Enter an amount like 950 or 950.50, or leave it blank if you don't know yet.";
  } else amountMinor = amount;

  let quantity: number | null = null;
  let minQty: number | null = null;
  if (costMode === "quantity") {
    const q = whole(t(raw.quantity), MAX_ITEM_QTY, 1);
    if (q === undefined) errors.quantity = "Enter a whole number of at least 1, or leave it blank.";
    else quantity = q;
  }
  if (costMode === "per_guest") {
    const m = whole(t(raw.minQty), MAX_ITEM_QTY, 1);
    if (m === undefined) errors.minQty = "Enter a whole number of at least 1, or leave it blank.";
    else minQty = m;
  }

  const notes = t(raw.notes);
  if (notes.length > MAX_ITEM_NOTES)
    errors.notes = `Keep notes under ${MAX_ITEM_NOTES} characters.`;

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name,
      categoryId,
      costMode,
      amountMinor,
      quantity,
      minQty,
      notes: notes === "" ? null : notes,
    },
  };
}

// ---------------------------------------------------------------- reserve

/** "10" or "7.5" percent to basis points; blank = no reserve. Undefined = invalid. */
export function parseReservePercent(input: string): number | null | undefined {
  const text = t(input).replace(/%$/, "").trim();
  if (text === "") return null;
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return undefined;
  const bp = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0") || 0);
  return bp <= 10_000 ? bp : undefined;
}

export function reservePercentText(bp: number | null): string {
  if (bp === null) return "";
  const whole = Math.floor(bp / 100);
  const frac = bp % 100;
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}`;
}
