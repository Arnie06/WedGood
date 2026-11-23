import { instantToLocal } from "@/domain/timeline/zoned";

export type ZonedDay = {
  /** The calendar date of the instant in the event's zone, such as "May 1, 2027". */
  date: string;
  /** The event's zone, named only when the viewer's clock reads differently at that instant. */
  zone: string | null;
};

/** A readable name for a zone at an instant ("Pacific Time"), or the IANA id when Intl has none. */
export function zoneLabel(timeZone: string, at: Date): string {
  for (const timeZoneName of ["longGeneric", "long"] as const) {
    try {
      const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName })
        .formatToParts(at)
        .find((p) => p.type === "timeZoneName")?.value;
      if (name) return name;
    } catch {
      // Older engines lack "longGeneric"; try the next style.
    }
  }
  return timeZone;
}

/**
 * How a reply-by (or link end) instant reads in the event's zone (UX-04). The zone is named when
 * the viewer is somewhere else, so a guest abroad knows whose midnight it is. With no viewer
 * zone (server render) the zone is left out rather than guessed.
 */
export function zonedDay(
  iso: string,
  eventZone: string,
  viewerZone: string | null,
  month: "long" | "short" = "long",
): ZonedDay {
  const at = new Date(iso);
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: eventZone,
    year: "numeric",
    month,
    day: "numeric",
  }).format(at);
  if (viewerZone === null) return { date, zone: null };
  let sameClock: boolean;
  try {
    const a = instantToLocal(at, eventZone);
    const b = instantToLocal(at, viewerZone);
    sameClock = a.date === b.date && a.time === b.time;
  } catch {
    sameClock = false;
  }
  return { date, zone: sameClock ? null : zoneLabel(eventZone, at) };
}
