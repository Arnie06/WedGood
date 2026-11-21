import { EVENT_KIND_LABELS, type EventKind } from "@/domain/events/event";
import { instantToLocal } from "@/domain/timeline/zoned";

export function timeLabel(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(
    new Date(iso),
  );
}

export function dayLabel(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "full" }).format(new Date(iso));
}

/** "4:00 PM – 4:30 PM", or the end with its weekday when it falls on another local day. */
export function rangeLabel(startsAt: string, endsAt: string | null, timeZone: string): string {
  const start = timeLabel(startsAt, timeZone);
  if (!endsAt) return start;
  const sameDay =
    instantToLocal(new Date(startsAt), timeZone).date ===
    instantToLocal(new Date(endsAt), timeZone).date;
  const end = sameDay
    ? timeLabel(endsAt, timeZone)
    : `${new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(new Date(endsAt))} ${timeLabel(endsAt, timeZone)}`;
  return `${start} – ${end}`;
}

export function zoneName(timeZone: string, at: Date = new Date()): string {
  return (
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value ?? timeZone
  );
}

export function kindLabel(kind: string): string {
  return EVENT_KIND_LABELS[kind as EventKind] ?? "Event";
}
