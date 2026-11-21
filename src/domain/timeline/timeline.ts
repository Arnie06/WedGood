import { instantToLocal, localToInstant } from "./zoned";

/** Wedding agenda rules (docs/07 "Tasks, dates and timeline", docs/11 "Wedding day mode"). */

export const TIMELINE_STATUSES = ["scheduled", "cancelled"] as const;
export type TimelineStatus = (typeof TIMELINE_STATUSES)[number];

export type TimelineField =
  | "title"
  | "date"
  | "startTime"
  | "endDate"
  | "endTime"
  | "location"
  | "responsibleLabel"
  | "contact"
  | "notes";

export type TimelineFormValues = Record<TimelineField | "assignee" | "vendor" | "status", string>;

export type TimelineInput = {
  title: string;
  startsAt: string; // ISO instant
  endsAt: string | null;
  location: string | null;
  responsibleLabel: string | null;
  contact: string | null;
  notes: string | null;
  assignee: string | null;
  vendor: string | null;
  status: TimelineStatus;
};

export type TimelineParse =
  | { ok: true; value: TimelineInput }
  | { ok: false; fieldErrors: Partial<Record<TimelineField, string>> };

const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_YEAR = 1970;
const MAX_YEAR = 2200;

const trimmed = (s: string | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();
const multiline = (s: string | undefined): string => (s ?? "").replace(/\r\n/g, "\n").trim();

function resolve(
  date: string,
  time: string,
  timeZone: string,
  errors: Partial<Record<TimelineField, string>>,
  dateKey: TimelineField,
  timeKey: TimelineField,
): Date | null {
  const result = localToInstant(date, time, timeZone);
  switch (result.kind) {
    case "ok": {
      const year = result.instant.getUTCFullYear();
      if (year < MIN_YEAR || year > MAX_YEAR) {
        errors[dateKey] = "Choose a date between 1970 and 2200.";
        return null;
      }
      return result.instant;
    }
    case "nonexistent":
      errors[timeKey] =
        "That time doesn't exist on this date because clocks move forward. Choose a time outside the skipped hour.";
      return null;
    case "ambiguous":
      errors[timeKey] =
        "That time happens twice on this date because clocks move back. Choose a time outside the repeated hour.";
      return null;
    case "invalid":
      errors[dateKey] = "Enter a valid date and time.";
      return null;
  }
}

/** Validates one agenda item. Times are wall-clock in the item's IANA zone. */
export function parseTimelineInput(
  raw: Partial<Record<TimelineField | "assignee" | "vendor" | "status", string>>,
  timeZone: string,
): TimelineParse {
  const errors: Partial<Record<TimelineField, string>> = {};
  const title = trimmed(raw.title);
  if (title.length === 0) errors.title = "Give this a name.";
  else if (title.length > 160) errors.title = "Keep it to 160 characters or fewer.";

  const location = trimmed(raw.location);
  if (location.length > 200) errors.location = "Keep it to 200 characters or fewer.";
  const responsibleLabel = trimmed(raw.responsibleLabel);
  if (responsibleLabel.length > 120)
    errors.responsibleLabel = "Keep it to 120 characters or fewer.";
  const contact = trimmed(raw.contact);
  if (contact.length > 200) errors.contact = "Keep it to 200 characters or fewer.";
  const notes = multiline(raw.notes);
  if (notes.length > 2000) errors.notes = "Keep notes to 2,000 characters or fewer.";

  const date = (raw.date ?? "").trim();
  const startTime = (raw.startTime ?? "").trim();
  if (!date) errors.date = "Choose a date.";
  if (!startTime) errors.startTime = "Choose a start time.";
  const endTime = (raw.endTime ?? "").trim();
  const endDateRaw = (raw.endDate ?? "").trim();
  if (!endTime && endDateRaw) errors.endTime = "Add an end time, or clear the end date.";

  let startsAt: Date | null = null;
  if (date && startTime) {
    startsAt = resolve(date, startTime, timeZone, errors, "date", "startTime");
  }
  let endsAt: Date | null = null;
  if (endTime) {
    endsAt = resolve(endDateRaw || date, endTime, timeZone, errors, "endDate", "endTime");
    if (startsAt && endsAt && endsAt.getTime() < startsAt.getTime()) {
      errors.endTime =
        "The end can't be before the start. If it finishes after midnight, set the end date to the next day.";
    }
  }

  const status = ((raw.status ?? "").trim() || "scheduled") as TimelineStatus;
  const assignee = (raw.assignee ?? "").trim();
  const vendor = (raw.vendor ?? "").trim();
  if ((assignee && !uuidShape.test(assignee)) || (vendor && !uuidShape.test(vendor))) {
    errors.responsibleLabel = "Choose from the list.";
  }
  if (!TIMELINE_STATUSES.includes(status)) errors.title = "Choose a valid status.";

  if (Object.keys(errors).length > 0 || !startsAt) return { ok: false, fieldErrors: errors };
  return {
    ok: true,
    value: {
      title,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt ? endsAt.toISOString() : null,
      location: location || null,
      responsibleLabel: responsibleLabel || null,
      contact: contact || null,
      notes: notes || null,
      assignee: assignee || null,
      vendor: vendor || null,
      status,
    },
  };
}

export type AgendaItem = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  timezone: string;
  status: TimelineStatus;
  assigneeUserId: string | null;
  vendorId: string | null;
  responsibleLabel: string | null;
  createdAt?: string;
};

/** Chronological order: start, then end, then creation, then id (stable and deterministic). */
export function sortAgenda<T extends AgendaItem>(items: readonly T[]): T[] {
  return [...items].sort(
    (a, b) =>
      Date.parse(a.startsAt) - Date.parse(b.startsAt) ||
      Date.parse(a.endsAt ?? a.startsAt) - Date.parse(b.endsAt ?? b.startsAt) ||
      (a.createdAt ?? "").localeCompare(b.createdAt ?? "") ||
      a.id.localeCompare(b.id),
  );
}

export type SharedResource = "person" | "vendor" | "responsible";
export type OverlapWarning = { aId: string; bId: string; shared: SharedResource };

/**
 * Overlap is allowed (vendors act at the same time). A warning is raised only when two scheduled
 * items need the same assigned resource: the same member, the same vendor, or the same named
 * responsible person. Touching items (one ends as the next starts) are a handoff, not an overlap.
 */
export function findResourceConflicts(items: readonly AgendaItem[]): OverlapWarning[] {
  const active = sortAgenda(items.filter((i) => i.status === "scheduled"));
  const out: OverlapWarning[] = [];
  const end = (i: AgendaItem) => Date.parse(i.endsAt ?? i.startsAt);
  for (let x = 0; x < active.length; x++) {
    const a = active[x]!;
    for (let y = x + 1; y < active.length; y++) {
      const b = active[y]!;
      if (Date.parse(b.startsAt) > end(a)) break;
      const aStart = Date.parse(a.startsAt);
      const bStart = Date.parse(b.startsAt);
      const overlaps =
        (aStart < end(b) && bStart < end(a)) ||
        (aStart === bStart && end(a) === aStart && end(b) === bStart);
      if (!overlaps) continue;
      const shared: SharedResource | null =
        a.assigneeUserId && a.assigneeUserId === b.assigneeUserId
          ? "person"
          : a.vendorId && a.vendorId === b.vendorId
            ? "vendor"
            : a.responsibleLabel &&
                b.responsibleLabel &&
                a.responsibleLabel.toLowerCase() === b.responsibleLabel.toLowerCase()
              ? "responsible"
              : null;
      if (shared) out.push({ aId: a.id, bId: b.id, shared });
    }
  }
  return out;
}

/** Form values for editing an existing item, converted back to its zone's wall clock. */
export function itemToFormValues(
  item: AgendaItem & {
    location: string | null;
    contact: string | null;
    notes: string | null;
  },
): TimelineFormValues {
  const start = instantToLocal(new Date(item.startsAt), item.timezone);
  const end = item.endsAt ? instantToLocal(new Date(item.endsAt), item.timezone) : null;
  return {
    title: item.title,
    date: start.date,
    startTime: start.time,
    endDate: end && end.date !== start.date ? end.date : "",
    endTime: end ? end.time : "",
    location: item.location ?? "",
    responsibleLabel: item.responsibleLabel ?? "",
    contact: item.contact ?? "",
    notes: item.notes ?? "",
    assignee: item.assigneeUserId ?? "",
    vendor: item.vendorId ?? "",
    status: item.status,
  };
}
