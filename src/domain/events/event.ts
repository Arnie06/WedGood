/** Event input rules (docs/06 events). The database re-checks every limit. */
import { isDateOnly } from "@/domain/dates/date-only";

export const EVENT_KINDS = [
  "ceremony",
  "reception",
  "rehearsal",
  "welcome",
  "brunch",
  "other",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const EVENT_KIND_LABELS: Record<EventKind, string> = {
  ceremony: "Ceremony",
  reception: "Reception",
  rehearsal: "Rehearsal dinner",
  welcome: "Welcome gathering",
  brunch: "Brunch",
  other: "Other",
};

export type EventPayload = {
  name: string;
  kind: EventKind;
  localDate: string | null;
  targetAttendance: number | null;
  capacity: number | null;
};

export type EventErrors = Partial<Record<keyof EventPayload, string>>;

const clean = (v: string | undefined) => (v ?? "").replace(/\s+/g, " ").trim();

function wholeNumber(raw: string, min: number, max: number): number | "invalid" {
  if (!/^\d{1,4}$/.test(raw)) return "invalid";
  const n = Number(raw);
  return n >= min && n <= max ? n : "invalid";
}

/** Blank optional numbers stay unknown (null); they are never read as zero. */
export function validateEvent(
  values: Record<string, string | undefined>,
): { ok: true; event: EventPayload } | { ok: false; errors: EventErrors } {
  const errors: EventErrors = {};
  const name = clean(values.name);
  if (name === "") errors.name = "Give this event a name.";
  else if (name.length > 120) errors.name = "Use 120 characters or fewer.";

  const kindRaw = clean(values.kind) || "other";
  const kind = (EVENT_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as EventKind) : null;
  if (!kind) errors.kind = "Choose one of the listed kinds.";

  const dateRaw = clean(values.localDate);
  if (dateRaw !== "" && !isDateOnly(dateRaw)) errors.localDate = "Use a real date.";

  const optional = (raw: string | undefined, min: number, key: "targetAttendance" | "capacity") => {
    const text = clean(raw);
    if (text === "") return null;
    const n = wholeNumber(text, min, 5000);
    if (n === "invalid") {
      errors[key] =
        min === 0 ? "Use a whole number from 0 to 5,000." : "Use a whole number from 1 to 5,000.";
      return null;
    }
    return n;
  };
  const targetAttendance = optional(values.targetAttendance, 0, "targetAttendance");
  const capacity = optional(values.capacity, 1, "capacity");

  if (Object.keys(errors).length > 0 || !kind) return { ok: false, errors };
  return {
    ok: true,
    event: { name, kind, localDate: dateRaw === "" ? null : dateRaw, targetAttendance, capacity },
  };
}

/** Long date for a date-only value, or null when the event has no date. Time zone free. */
export function formatEventDate(localDate: string | null): string | null {
  if (!localDate || !isDateOnly(localDate)) return null;
  return new Date(`${localDate}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
