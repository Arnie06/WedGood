import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardTitle } from "@/components/ui/card";
import { TrayButton } from "@/components/ui/tray";
import { formatEventDate } from "@/domain/events/event";
import { EventForm } from "@/features/events/event-forms";
import { kindLabel } from "@/features/timeline/format";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadEventDemand } from "@/server/events/demand";
import { loadEventLabels } from "@/server/timeline/queries";
import { listTimeZones } from "@/domain/wedding/settings";

export const metadata: Metadata = { title: "Events" };

const link = "font-semibold text-action-emphasis underline underline-offset-4";

export default async function EventsPage({ params }: { params: Promise<{ w: string }> }) {
  const access = await requireWorkspace((await params).w);
  const wid = access.wedding.id;
  const base = `/app/${wid}`;
  const canManage = hasCapability(access, "guests.manage");
  const [events, demand] = await Promise.all([
    loadEventLabels(wid),
    loadEventDemand(wid, {
      canManageGuests: canManage,
      shareGuestTotals: access.wedding.shareGuestTotals,
    }),
  ]);

  return (
    <div className="max-w-3xl space-y-6">
      <header className="space-y-2">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">Events</h1>
        <p className="text-body-lg text-ink-muted">
          Each event, such as the ceremony or reception, has its own guests, meals, seating and
          agenda. Open one to see how it is coming together.
        </p>
        {canManage && (
          <div className="pt-1">
            <TrayButton
              label="Add an event"
              title="Add an event"
              description="Such as your ceremony or reception. Guests are invited to each event separately."
            >
              <EventForm
                workspaceId={wid}
                submitLabel="Add event"
                weddingZone={access.wedding.timezone}
                timeZones={listTimeZones()}
              />
            </TrayButton>
          </div>
        )}
      </header>

      {events.length === 0 && (
        <Card>
          <p className="text-body-md text-ink-muted">
            {canManage
              ? "No events yet. Add your first event, such as the ceremony or reception, to start inviting guests."
              : "No events yet. The owner or a partner can add them."}
          </p>
        </Card>
      )}

      <ul className="space-y-3">
        {events.map((event) => {
          const counts = demand.byEvent.get(event.id);
          return (
            <li key={event.id}>
              <Card className="space-y-2">
                <CardTitle>{event.name}</CardTitle>
                <p className="text-body-md text-ink-muted">
                  {[
                    kindLabel(event.kind).toLowerCase() === event.name.toLowerCase()
                      ? null
                      : kindLabel(event.kind),
                    formatEventDate(event.localDate) ?? "Date not set",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                {counts && (
                  <p className="text-body-md">
                    {counts.yes} attending · {counts.waiting} waiting · planning for{" "}
                    {counts.planningNumber}
                  </p>
                )}
                <Link
                  href={`${base}/plan/events/${event.id}`}
                  className={`${link} inline-flex min-h-11 items-center`}
                >
                  Open the event page<span className="sr-only"> for {event.name}</span>
                </Link>
              </Card>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
