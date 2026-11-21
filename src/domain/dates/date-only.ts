/**
 * Calendar dates without a time or zone (SQL DATE semantics). Arithmetic is
 * done on UTC epoch days so results never shift with the host time zone.
 */
export type DateOnly = string & { readonly __brand: "DateOnly" };

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

export function isDateOnly(value: string): value is DateOnly {
  const match = DATE_ONLY.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function parseDateOnly(value: string): DateOnly {
  if (!isDateOnly(value)) throw new RangeError(`Invalid date-only value "${value}"`);
  return value;
}

function epochDay(value: DateOnly): number {
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, day) / MS_PER_DAY;
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: DateOnly, to: DateOnly): number {
  return epochDay(to) - epochDay(from);
}

/** The calendar date `days` after `value` (negative for before). */
export function addDays(value: DateOnly, days: number): DateOnly {
  if (!Number.isInteger(days)) throw new RangeError("days must be an integer");
  const d = new Date((epochDay(value) + days) * MS_PER_DAY);
  const iso = d.toISOString().slice(0, 10);
  return parseDateOnly(iso);
}

export function formatDateOnly(
  value: DateOnly,
  locale = "en-US",
  options: Intl.DateTimeFormatOptions = { dateStyle: "long" },
): string {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(
    new Date(epochDay(value) * MS_PER_DAY),
  );
}

/** Today's calendar date in an IANA zone (the wedding's, not the server's). */
export function todayInZone(timeZone: string, now: Date = new Date()): DateOnly {
  // en-CA formats as YYYY-MM-DD.
  const text = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return parseDateOnly(text);
}
