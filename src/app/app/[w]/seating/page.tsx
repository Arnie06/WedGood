import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardTitle } from "@/components/ui/card";
import { EVENT_KIND_LABELS } from "@/domain/events/event";
import { EventForm } from "@/features/events/event-forms";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadEventData } from "@/server/events/queries";

export const metadata: Metadata = { title: "Seating" };

const link = "font-semibold text-action-emphasis underline underline-offset-4";

export default async function SeatingIndexPage({ params }: { params: Promise<{ w: string }> }) {
  const { w } = await params;
  const access = await requireWorkspace(w);
  const wid = access.wedding.id;
  const base = `/app/${wid}`;
  const heading = <h1 className="font-serif text-headline-mobile md:text-headline-lg">Seating</h1>;

  if (!hasCapability(access, "guests.manage")) {
    return (
      <div className="max-w-3xl space-y-4">
        {heading}
        <Card>
          <p className="text-body-md">
            Seating shows guest names and answers, so it is limited to the workspace owner and
            partner.
          </p>
        </Card>
      </div>
    );
  }

  const data = await loadEventData(wid);
  return (
    <div className="max-w-3xl space-y-6">
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
          />
          <Link
            href={`${base}/guests/invitations`}
            className={`${link} inline-flex min-h-11 items-center`}
          >
            Or manage events and invitations
          </Link>
        </Card>
      )}
      <ul className="space-y-3">
        {data.events.map((event) => {
          const members = data.members.filter((m) => m.eventId === event.id && m.active);
          const attending = members.filter((m) => m.status === "accepted").length;
          return (
            <li key={event.id}>
              <Card className="space-y-2">
                <CardTitle>{event.name}</CardTitle>
                <p className="text-body-md text-ink-muted">
                  {EVENT_KIND_LABELS[event.kind]}
                  {event.localDate ? ` · ${event.localDate}` : ""} · {attending} attending
                </p>
                <Link
                  href={`${base}/seating/${event.id}`}
                  className={`${link} inline-flex min-h-11 items-center`}
                >
                  Open the seating plan<span className="sr-only"> for {event.name}</span>
                </Link>
              </Card>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
