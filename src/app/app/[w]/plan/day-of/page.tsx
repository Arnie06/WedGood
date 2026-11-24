import type { Metadata } from "next";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { formatEventDate } from "@/domain/events/event";
import { kindLabel } from "@/features/timeline/format";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadEventLabels, loadTimelineCounts } from "@/server/timeline/queries";

export const metadata: Metadata = { title: "Wedding day" };

const link = "font-semibold text-action-emphasis underline underline-offset-4";

export default async function DayOfIndexPage({ params }: { params: Promise<{ w: string }> }) {
  const access = await requireWorkspace((await params).w);
  const base = `/app/${access.wedding.id}`;
  const [events, counts] = await Promise.all([
    loadEventLabels(access.wedding.id),
    loadTimelineCounts(access.wedding.id),
  ]);
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">Wedding day</h1>
        <p className="text-body-lg text-ink-muted">
          An ordered agenda for each event, with who is in charge and how to reach them. Choose an
          event to build or print it.
        </p>
        {hasCapability(access, "exports.create") && (
          <p className="text-body-md text-ink-muted">
            <a
              href={`${base}/plan/calendar.ics`}
              download
              className={`${link} inline-flex min-h-11 items-center`}
            >
              Download calendar (.ics)
            </a>{" "}
            A snapshot of your event dates and scheduled agenda items. Contacts and notes are left
            out, and it will not update a calendar that already imported it.
          </p>
        )}
      </header>
      {events.length === 0 && (
        <Card className="space-y-3">
          <p className="text-body-md text-ink-muted">
            Add an event first, such as your ceremony or reception, then build its agenda.
          </p>
          <Link
            href={`${base}/guests/invitations`}
            className={`${link} inline-flex min-h-11 items-center`}
          >
            Events and invitations
          </Link>
        </Card>
      )}
      {events.length > 0 && (
        <ul className="record-list">
          {events.map((event) => {
            const n = counts.get(event.id) ?? 0;
            return (
              <li
                key={event.id}
                className="flex min-w-0 flex-wrap items-center justify-between gap-x-5 px-4 py-3"
              >
                <div className="min-w-0">
                  <h2 className="text-body-md font-semibold wrap-anywhere">{event.name}</h2>
                  <p className="text-body-sm text-ink-muted">
                    {[
                      kindLabel(event.kind).toLowerCase() === event.name.toLowerCase()
                        ? null
                        : kindLabel(event.kind),
                      formatEventDate(event.localDate),
                      n === 0 ? "No agenda yet" : `${n} ${n === 1 ? "item" : "items"}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <Link
                  href={`${base}/plan/day-of/${event.id}`}
                  className={`${link} inline-flex min-h-11 items-center`}
                >
                  Open the agenda<span className="sr-only"> for {event.name}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
