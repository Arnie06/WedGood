import { buildIcs, type IcsEntry } from "@/domain/calendar/ics";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadCalendarItems, loadEventLabels } from "@/server/timeline/queries";

/**
 * Calendar download for the wedding events and scheduled agenda items. It is a snapshot taken now:
 * later changes do not update a calendar that already imported it. Contacts, notes and guest data
 * are never included.
 */
export async function GET(_: Request, { params }: { params: Promise<{ w: string }> }) {
  const access = await requireWorkspace((await params).w);
  if (!hasCapability(access, "exports.create")) {
    return new Response("Not found", { status: 404 });
  }
  const wid = access.wedding.id;
  const [events, items] = await Promise.all([loadEventLabels(wid), loadCalendarItems(wid)]);
  const eventName = new Map(events.map((e) => [e.id, e.name]));
  const entries: IcsEntry[] = [
    ...events
      .filter((e) => e.localDate !== null)
      .map((e): IcsEntry => ({
        kind: "allDay",
        uid: `event-${e.id}@wedding-workspace`,
        title: e.name,
        date: e.localDate as string,
        description: "Date only. Add times in the wedding-day agenda.",
        sequence: 0,
      })),
    ...items.map((i): IcsEntry => ({
      kind: "timed",
      uid: `agenda-${i.id}@wedding-workspace`,
      title: i.title,
      startsAt: i.startsAt,
      endsAt: i.endsAt,
      location: i.location,
      description: [
        eventName.get(i.eventId),
        i.responsibleLabel && `In charge: ${i.responsibleLabel}`,
      ]
        .filter(Boolean)
        .join(" · "),
      sequence: Math.max(0, i.version - 1),
    })),
  ];
  const body = buildIcs(entries, { calendarName: access.wedding.name, now: new Date() });
  return new Response(body, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": 'attachment; filename="wedding-calendar.ics"',
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
