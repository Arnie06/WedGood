/**
 * Wall-clock time in an IANA zone <-> absolute instants (docs/07 "Tasks, dates and timeline").
 * Pure; uses Intl only. Nonexistent (spring-forward gap) and ambiguous (fall-back repeat) local
 * times are reported, never guessed.
 */

const MS_PER_MINUTE = 60_000;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

export type LocalParts = { date: string; time: string };

/** Local date (YYYY-MM-DD) and time (HH:MM) of an instant in a zone. */
export function instantToLocal(instant: Date, timeZone: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of formatterFor(timeZone).formatToParts(instant)) parts[p.type] = p.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

/** Offset of the zone from UTC at an instant, in minutes (local = utc + offset). */
function offsetMinutes(instant: Date, timeZone: string): number {
  const parts: Record<string, string> = {};
  for (const p of formatterFor(timeZone).formatToParts(instant)) parts[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const truncated = Math.floor(instant.getTime() / 1000) * 1000;
  return Math.round((asUtc - truncated) / MS_PER_MINUTE);
}

export type LocalToInstant =
  | { kind: "ok"; instant: Date }
  | { kind: "nonexistent" }
  | { kind: "ambiguous"; earlier: Date; later: Date }
  | { kind: "invalid" };

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Resolves a wall-clock date and time in a zone to an instant. */
export function localToInstant(date: string, time: string, timeZone: string): LocalToInstant {
  const d = DATE.exec(date);
  const t = TIME.exec(time);
  if (!d || !t || !isValidTimeZone(timeZone)) return { kind: "invalid" };
  const [y, mo, da] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const probe = new Date(Date.UTC(y, mo - 1, da));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== da) {
    return { kind: "invalid" };
  }
  const asUtc = Date.UTC(y, mo - 1, da, Number(t[1]), Number(t[2]));
  // The zone's offset can differ on either side of a transition, so try both neighbours.
  const offsets = new Set([
    offsetMinutes(new Date(asUtc - 24 * 60 * MS_PER_MINUTE), timeZone),
    offsetMinutes(new Date(asUtc + 24 * 60 * MS_PER_MINUTE), timeZone),
  ]);
  const matches: Date[] = [];
  for (const offset of offsets) {
    const candidate = new Date(asUtc - offset * MS_PER_MINUTE);
    if (offsetMinutes(candidate, timeZone) === offset) matches.push(candidate);
  }
  matches.sort((a, b) => a.getTime() - b.getTime());
  const [first, second] = matches;
  if (!first) return { kind: "nonexistent" };
  if (second) return { kind: "ambiguous", earlier: first, later: second };
  return { kind: "ok", instant: first };
}

/** The calendar day after a valid YYYY-MM-DD date. */
function nextDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/**
 * The last second of a local calendar day in a zone: one second before the next day begins there.
 * "Reply by 1 May" in Los Angeles closes at 1 May 23:59:59 Pacific time. Handles 23- and 25-hour
 * days, and zones where the next day starts after midnight because the clocks jump at 00:00.
 * Null when the date or zone is not real.
 */
export function endOfLocalDay(date: string, timeZone: string): Date | null {
  if (localToInstant(date, "00:00", timeZone).kind === "invalid") return null;
  const next = nextDate(date);
  // A jump at midnight skips 00:00 (and at most a few hours after it); the day starts at the
  // first local hour that exists.
  for (let hour = 0; hour < 4; hour += 1) {
    const start = localToInstant(next, `${String(hour).padStart(2, "0")}:00`, timeZone);
    if (start.kind === "ok") return new Date(start.instant.getTime() - 1000);
    if (start.kind === "ambiguous") return new Date(start.earlier.getTime() - 1000);
  }
  return null;
}
