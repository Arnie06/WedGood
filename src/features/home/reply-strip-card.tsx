import Link from "next/link";
import { Card, CardTitle } from "@/components/ui/card";
import { ProgressBar } from "@/components/ui/progress-bar";
import { replyByLabel, waitingSummary, type ReplyStrip } from "@/domain/home/reply-strip";
import { ZonedDate } from "@/features/events/zoned-date";

const linkClass =
  "inline-flex min-h-11 items-center font-semibold text-action-emphasis underline underline-offset-4";

/**
 * Home "Replies" card (UX-13, W1): replies in, still waiting and the reply date per upcoming event.
 * Owners and partners get a link to that event's waiting guests; anyone else (only when guest
 * totals are shared) gets the event page, since the guest list is private.
 */
export function ReplyStripCard({
  strip,
  base,
  canManageGuests,
}: {
  strip: ReplyStrip;
  base: string;
  canManageGuests: boolean;
}) {
  return (
    <Card as="section" aria-labelledby="home-replies" data-testid="home-replies">
      <CardTitle>
        <span id="home-replies">Replies</span>
      </CardTitle>
      <ul className="mt-3 divide-y divide-border-hairline">
        {strip.rows.map((row) => {
          const dateLabel = replyByLabel(row);
          return (
            <li key={row.eventId} className="space-y-1 py-3 first:pt-0 last:pb-0">
              <ProgressBar
                label={row.name}
                value={row.replied}
                max={row.invited}
                valueText={`${row.replied} of ${row.invited} replied`}
              />
              <p className="text-body-sm text-ink-muted">
                {waitingSummary(row)}
                {dateLabel && row.nextReplyBy && (
                  <>
                    {` · ${dateLabel} `}
                    <ZonedDate iso={row.nextReplyBy} timeZone={row.timeZone} month="short" />
                  </>
                )}
              </p>
              {canManageGuests && row.waiting > 0 ? (
                <Link
                  href={`${base}/guests?event=${row.eventId}&reply=waiting`}
                  className={linkClass}
                >
                  See who&apos;s waiting<span className="sr-only"> for {row.name}</span>
                </Link>
              ) : (
                !canManageGuests && (
                  <Link href={`${base}/plan/events/${row.eventId}`} className={linkClass}>
                    Open the event page<span className="sr-only"> for {row.name}</span>
                  </Link>
                )
              )}
            </li>
          );
        })}
      </ul>
      {strip.more > 0 && (
        <p className="mt-2">
          <Link href={`${base}/plan/events`} className={linkClass}>
            {strip.more === 1 ? "1 more event" : `${strip.more} more events`}
          </Link>
        </p>
      )}
    </Card>
  );
}
