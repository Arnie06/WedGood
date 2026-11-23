/**
 * The guest's own "Add to calendar" file (UX-16). Pure, and safe to run in the browser: it takes
 * only what the RSVP page already shows the guest (event name and date) and includes only the
 * events someone on the reply is attending. Events have no stored time, so each is an all-day
 * entry. No token, name, meal, address or note ever reaches the file, so a calendar app that syncs
 * it to the cloud learns nothing the guest's own invitation didn't say.
 */
import { buildIcs, type IcsEntry } from "./ics";

export type GuestCalendarEvent = {
  name: string;
  /** Date-only (YYYY-MM-DD) in the event's own zone, or null while the couple hasn't set one. */
  localDate: string | null;
  attending: boolean;
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function slug(value: string): string {
  const s = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "event";
}

/**
 * Entries for the events being attended that have a date, in date order. The UID is built from
 * the date and name so that downloading again after another reply updates the same entry in most
 * calendar apps; it carries nothing a guest couldn't read on the invitation.
 */
export function guestCalendarEntries(events: readonly GuestCalendarEvent[]): IcsEntry[] {
  const seen = new Set<string>();
  const out: IcsEntry[] = [];
  const dated = events
    .filter((e): e is GuestCalendarEvent & { localDate: string } =>
      Boolean(e.attending && e.localDate && DATE_ONLY.test(e.localDate)),
    )
    .sort((a, b) => a.localDate.localeCompare(b.localDate) || a.name.localeCompare(b.name));
  for (const e of dated) {
    const uid = `guest-${e.localDate}-${slug(e.name)}@wedding-workspace`;
    if (seen.has(uid)) continue;
    seen.add(uid);
    out.push({
      kind: "allDay",
      uid,
      title: e.name,
      date: e.localDate,
      description: "Times and details are in your invitation.",
      sequence: 0,
    });
  }
  return out;
}

/** The whole file, or null when there is nothing to add (no attended event has a date). */
export function guestCalendarFile(
  weddingName: string,
  events: readonly GuestCalendarEvent[],
  now: Date,
): string | null {
  const entries = guestCalendarEntries(events);
  if (entries.length === 0) return null;
  return buildIcs(entries, {
    calendarName: weddingName,
    productId: "-//Wedding Workspace//Guest calendar//EN",
    now,
  });
}
