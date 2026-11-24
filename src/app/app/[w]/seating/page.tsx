import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardTitle } from "@/components/ui/card";
import { formatDateOnly, parseDateOnly } from "@/domain/dates/date-only";
import { EVENT_KIND_LABELS } from "@/domain/events/event";
import { EventForm } from "@/features/events/event-forms";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadEventData } from "@/server/events/queries";
import { listTimeZones } from "@/domain/wedding/settings";

export const metadata: Metadata = { title: "Seating" };

const link = "font-semibold text-action-emphasis underline underline-offset-4";

export default async function SeatingIndexPage({ params }: { params: Promise<{ w: string }> }) {
  const { w } = await params;
  const access = await requireWorkspace(w);
  const wid = access.wedding.id;
  const base = `/app/${wid}`;
  const heading = <h1 className="font-serif text-headline-mobile md:text-headline-lg">Seating</h1>;

  if (!hasCapability(access, "seating.manage")) {
    return (
      <div className="max-w-3xl space-y-4">
        {heading}
        <Card>
          <p className="text-body-md">
            Seating shows guest names and answers, so it is limited to the workspace owner and
            partner, and to planners they have given seating access.
          </p>
        </Card>
      </div>
    );
  }

  const data = await loadEventData(wid);
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        {heading}
        <p className="text-body-lg text-ink-muted">
          Choose an event to seat. Only guests who are attending that event can be seated.
        </p>
      </header>
      {data.events.length === 0 && (
        <Card className="space-y-4">
          <div className="space-y-1">
            <CardTitle>Create your first event</CardTitle>
            <p className="text-body-md text-ink-muted">
              Seating is planned one event at a time, such as your reception. You can add the date
              and capacity later.
            </p>
          </div>
          <EventForm
            workspaceId={wid}
            initial={{
              name: "Reception",
              kind: "reception",
              localDate: "",
              targetAttendance: "",
              capacity: "",
            }}
            submitLabel="Create event"
            weddingZone={access.wedding.timezone}
            timeZones={listTimeZones()}
          />
          <Link
            href={`${base}/guests/invitations`}
            className={`${link} inline-flex min-h-11 items-center`}
          >
            Or manage events and invitations
          </Link>
        </Card>
      )}
      {data.events.length > 0 && (
        <ul className="record-list">
          {data.events.map((event) => {
            const members = data.members.filter((m) => m.eventId === event.id && m.active);
            const attending = members.filter((m) => m.status === "accepted").length;
            return (
              <li
                key={event.id}
                className="flex min-w-0 flex-wrap items-center justify-between gap-x-5 px-4 py-3"
              >
                <div className="min-w-0">
                  <h2 className="text-body-md font-semibold wrap-anywhere">{event.name}</h2>
                  <p className="text-body-sm text-ink-muted">
                    {[
                      // Don't repeat the kind when the event is simply named after it.
                      EVENT_KIND_LABELS[event.kind].toLowerCase() === event.name.toLowerCase()
                        ? null
                        : EVENT_KIND_LABELS[event.kind],
                      event.localDate
                        ? formatDateOnly(parseDateOnly(event.localDate))
                        : "Date not set",
                      `${attending} attending`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <p className="flex flex-wrap gap-x-6">
                  <Link
                    href={`${base}/seating/${event.id}`}
                    className={`${link} inline-flex min-h-11 items-center`}
                  >
                    Open the seating plan<span className="sr-only"> for {event.name}</span>
                  </Link>
                  <Link
                    href={`${base}/plan/events/${event.id}`}
                    className={`${link} inline-flex min-h-11 items-center`}
                  >
                    Event page<span className="sr-only"> for {event.name}</span>
                  </Link>
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
