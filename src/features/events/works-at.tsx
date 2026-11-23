import Link from "next/link";
import { TrayButton } from "@/components/ui/tray";
import { formatEventDate } from "@/domain/events/event";
import { VendorEventsForm } from "@/features/events/vendor-links-form";

const link = "font-semibold text-action-emphasis underline underline-offset-4";

type EventLabel = { id: string; name: string; localDate: string | null };

/**
 * "Works at": the events one vendor serves. The link is on the vendor, so it stays the same when
 * the booking is amended. Shown on the vendor page and on the booking page.
 */
export function WorksAt({
  workspaceId,
  vendorId,
  vendorName,
  events,
  linkedEventIds,
  canManage,
  headingId,
}: {
  workspaceId: string;
  vendorId: string;
  vendorName: string;
  events: readonly EventLabel[];
  linkedEventIds: readonly string[];
  canManage: boolean;
  headingId: string;
}) {
  const base = `/app/${workspaceId}`;
  const linked = new Set(linkedEventIds);
  const shown = events.filter((e) => linked.has(e.id));
  return (
    <section aria-labelledby={headingId} className="space-y-3" data-testid="works-at">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={headingId} className="font-serif text-headline-sm">
          Works at
        </h2>
        {canManage && events.length > 0 && (
          <TrayButton
            label="Choose events"
            variant="outline"
            size="sm"
            title={`Where does ${vendorName} work?`}
            description="Tick the events this vendor serves. Nothing is sent to them and the booking doesn't change."
          >
            <VendorEventsForm
              workspaceId={workspaceId}
              subjectId={vendorId}
              legend="Events"
              help="Changing this never changes the booking, its amount or its payments."
              options={events.map((e) => ({
                id: e.id,
                label: e.name,
                hint: formatEventDate(e.localDate) ?? undefined,
              }))}
              initial={linkedEventIds.filter((id) => events.some((e) => e.id === id))}
              empty="Add an event first."
            />
          </TrayButton>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="text-body-md text-ink-muted" data-testid="works-at-empty">
          {events.length === 0
            ? "No events yet. Add your events, then say which ones this vendor works at."
            : "Not assigned to an event yet."}
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2" data-testid="works-at-events">
          {shown.map((e) => (
            <li key={e.id}>
              <Link
                href={`${base}/plan/events/${e.id}`}
                className={`${link} inline-flex min-h-11 items-center rounded-full border border-border-hairline px-4`}
              >
                {e.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
