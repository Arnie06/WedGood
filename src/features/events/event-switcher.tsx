import Link from "next/link";
import { cn } from "@/lib/cn";

/**
 * Jump between events without going back to the list. Plain links in a labelled nav: Tab and Enter
 * work, the current event is announced, and it wraps on a 320px screen instead of scrolling sideways.
 */
export function EventSwitcher({
  base,
  events,
  currentId,
  hrefFor,
}: {
  base: string;
  events: readonly { id: string; name: string }[];
  currentId: string;
  /** Where each event links; the event page by default. */
  hrefFor?: (eventId: string) => string;
}) {
  if (events.length < 2) return null;
  return (
    <nav aria-label="Events">
      <ul className="flex flex-wrap gap-2">
        {events.map((e) => {
          const current = e.id === currentId;
          return (
            <li key={e.id}>
              <Link
                href={hrefFor ? hrefFor(e.id) : `${base}/plan/events/${e.id}`}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-11 items-center rounded-control border px-4 text-label-lg font-semibold",
                  current
                    ? "border-action-emphasis bg-action-emphasis text-on-action-emphasis"
                    : "border-border-control text-ink hover:bg-surface-sunken",
                )}
              >
                {e.name}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
