/**
 * Wedding event settings: the nullable, user-editable facts every other module
 * reads (date, budget target, guest target). Pure and framework-free. Unknown
 * values stay `null`; they are never coerced to zero (AGENTS.md money rules).
 */
import { isDateOnly } from "@/domain/dates/date-only";

export const SUPPORTED_CURRENCIES = [
  "USD",
  "CAD",
  "EUR",
  "GBP",
  "AUD",
  "NZD",
  "MXN",
  "CHF",
  "JPY",
  "INR",
] as const;

export const MAX_GUEST_TARGET = 100_000;
export const MAX_BUDGET_MAJOR = 100_000_000;

export type WeddingSettings = {
  name: string;
  /** ISO date-only, or null when still deciding. */
  date: string | null;
  timezone: string;
  baseCurrency: string;
  /** Integer minor units, or null when no target is set. */
  targetBudgetMinor: number | null;
  targetGuestCount: number | null;
  location: string | null;
};

export type SettingsField =
  "name" | "date" | "timezone" | "baseCurrency" | "targetBudget" | "targetGuestCount" | "location";

export type SettingsParseResult =
  | { ok: true; value: WeddingSettings }
  | { ok: false; errors: Partial<Record<SettingsField, string>> };

export type RawSettingsInput = Partial<Record<SettingsField, string | null | undefined>>;

export function isValidTimeZone(zone: string): boolean {
  if (zone.length === 0 || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** IANA zones offered in forms, from the runtime's tz database. */
export function listTimeZones(): string[] {
  const zones = Intl.supportedValuesOf("timeZone");
  return zones.includes("UTC") ? zones : [...zones, "UTC"];
}

export function isSupportedCurrency(code: string): boolean {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(code);
}

export function currencyExponent(currency: string): number {
  return (
    new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  );
}

/**
 * Converts a typed amount such as "40,000" or "12 500.50" to integer minor
 * units using exact string arithmetic (no floats). Returns null for blank,
 * `undefined` when the text is not a valid amount for the currency.
 */
export function parseMajorToMinor(input: string, currency: string): number | null | undefined {
  const cleaned = input.trim().replace(/^[$€£¥₹]/, "");
  if (cleaned === "") return null;
  const digits = currencyExponent(currency);
  const match = /^(\d{1,3}(?:[, ]\d{3})+|\d+)(?:\.(\d+))?$/.exec(cleaned);
  if (!match) return undefined;
  const whole = (match[1] ?? "").replace(/[, ]/g, "");
  const fraction = match[2] ?? "";
  if (fraction.length > digits) return undefined;
  if (Number(whole) > MAX_BUDGET_MAJOR) return undefined;
  const minor = Number(whole + fraction.padEnd(digits, "0"));
  return Number.isSafeInteger(minor) ? minor : undefined;
}

const clean = (value: string | null | undefined) => (value ?? "").trim();

export function parseSettingsInput(raw: RawSettingsInput): SettingsParseResult {
  const errors: Partial<Record<SettingsField, string>> = {};

  const name = clean(raw.name).replace(/\s+/g, " ");
  if (name.length === 0) errors.name = "Give your wedding a name, like “Alex & Morgan”.";
  else if (name.length > 160) errors.name = "Use 160 characters or fewer.";

  const dateText = clean(raw.date);
  let date: string | null = null;
  if (dateText !== "") {
    if (isDateOnly(dateText)) date = dateText;
    else errors.date = "Enter a real date, or leave it blank while you decide.";
  }

  const timezone = clean(raw.timezone);
  if (!isValidTimeZone(timezone)) errors.timezone = "Choose a time zone from the list.";

  const baseCurrency = clean(raw.baseCurrency).toUpperCase();
  if (!isSupportedCurrency(baseCurrency)) errors.baseCurrency = "Choose a currency from the list.";

  let targetBudgetMinor: number | null = null;
  if (!errors.baseCurrency) {
    const parsed = parseMajorToMinor(clean(raw.targetBudget), baseCurrency);
    if (parsed === undefined) {
      errors.targetBudget = "Enter an amount like 40000 or 40,000.50, or leave it blank for now.";
    } else targetBudgetMinor = parsed;
  }

  const guestText = clean(raw.targetGuestCount);
  let targetGuestCount: number | null = null;
  if (guestText !== "") {
    if (/^\d{1,6}$/.test(guestText) && Number(guestText) <= MAX_GUEST_TARGET) {
      targetGuestCount = Number(guestText);
    } else errors.targetGuestCount = "Enter a whole number, or leave it blank for now.";
  }

  const locationText = clean(raw.location).replace(/\s+/g, " ");
  if (locationText.length > 200) errors.location = "Use 200 characters or fewer.";

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name,
      date,
      timezone,
      baseCurrency,
      targetBudgetMinor,
      targetGuestCount,
      location: locationText === "" ? null : locationText,
    },
  };
}

/** Inverse of parseMajorToMinor for prefilling an edit form (exact, no floats). */
export function minorToMajorInput(minor: number | null, currency: string): string {
  if (minor === null) return "";
  const digits = currencyExponent(currency);
  if (digits === 0) return String(minor);
  const padded = String(minor).padStart(digits + 1, "0");
  const whole = padded.slice(0, -digits);
  const fraction = padded.slice(-digits);
  return /^0+$/.test(fraction) ? whole : `${whole}.${fraction}`;
}

/** Names of settings that differ; used for audit records (values are not logged). */
export function changedSettingKeys(a: WeddingSettings, b: WeddingSettings): string[] {
  const keys = Object.keys(a) as (keyof WeddingSettings)[];
  return keys.filter((k) => a[k] !== b[k]);
}
