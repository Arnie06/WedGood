import type { Metadata } from "next";
import Link from "next/link";
import { WorkspacePageHeading } from "@/components/shell/workspace-page-heading";
import { Card } from "@/components/ui/card";
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
    <div className="space-y-6">
      <WorkspacePageHeading
        title="Events"
        description="Guest counts, seating and agendas for each event."
        actions={
          canManage && (
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
          )
        }
      />

      {events.length === 0 && (
        <Card>
          <p className="text-body-md text-ink-muted">
            {canManage
              ? "No events yet. Add your first event, such as the ceremony or reception, to start inviting guests."
              : "No events yet. The owner or a partner can add them."}
          </p>
        </Card>
      )}

      {events.length > 0 && (
        <ul className="record-list">
          {events.map((event) => {
            const counts = demand.byEvent.get(event.id);
            return (
              <li
                key={event.id}
                className="grid min-w-0 gap-x-5 gap-y-1 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center"
              >
                <div className="min-w-0">
                  <h2 className="text-body-md font-semibold wrap-anywhere">{event.name}</h2>
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
                </div>
                <div>
                  {counts && (
                    <p className="text-body-sm text-ink-muted">
                      {counts.yes} attending · {counts.waiting} waiting · planning for{" "}
                      {counts.planningNumber}
                    </p>
                  )}
                </div>
                <Link
                  href={`${base}/plan/events/${event.id}`}
                  className={`${link} inline-flex min-h-11 items-center`}
                >
                  Open the event page<span className="sr-only"> for {event.name}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
