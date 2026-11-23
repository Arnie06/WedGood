import { CircleAlert, CircleCheck, RefreshCw } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Card, CardTitle } from "@/components/ui/card";
import type { ConsequenceLine, ConsequenceLink } from "@/domain/guests/consequences";
import { describeReplyChange, describeReplySource } from "@/domain/guests/history";
import type { EventConsequences } from "@/server/guests/consequences-read";

const link = "font-semibold text-action-emphasis underline underline-offset-4";

const LINK_LABEL: Record<ConsequenceLink, string> = {
  seating: "Open seating",
  event: "Open the event",
  attention: "Open Needs attention",
  invitations: "Open invitations",
};

function List({
  title,
  icon,
  lines,
  empty,
  href,
  testId,
}: {
  title: string;
  icon: ReactNode;
  lines: ConsequenceLine[];
  empty: string;
  href: (l: ConsequenceLink) => string;
  testId: string;
}) {
  return (
    <div className="space-y-2" data-testid={testId}>
      <h4 className="text-label-lg font-semibold">{title}</h4>
      {lines.length === 0 ? (
        <p className="text-body-md text-ink-muted">{empty}</p>
      ) : (
        <ul className="space-y-2">
          {lines.map((l) => (
            <li key={l.id} className="flex items-start gap-2 text-body-md">
              {icon}
              <span className="min-w-0 break-words">
                {l.text}
                {l.link && (
                  <>
                    {" "}
                    <Link
                      href={href(l.link)}
                      className={`${link} flex min-h-11 w-fit items-center`}
                    >
                      {LINK_LABEL[l.link]}
                    </Link>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * W4 "Consequences" block (UX-05): for each event, the latest answer change and what it set in
 * motion. Read-only; every line is derived on the server from stored data.
 */
export function ConsequencesPanel({
  base,
  items,
  when,
}: {
  base: string;
  items: EventConsequences[];
  when: (iso: string) => string;
}) {
  return (
    <>
      {items.map(({ eventId, eventName, change, consequences: c }) => {
        const href = (l: ConsequenceLink) =>
          l === "seating"
            ? `${base}/seating/${eventId}`
            : l === "event"
              ? `${base}/plan/events/${eventId}`
              : l === "attention"
                ? `${base}/plan/attention`
                : `${base}/guests/invitations`;
        return (
          <Card key={eventId} className="space-y-4" data-testid={`consequences-${eventId}`}>
            <div className="space-y-1">
              <CardTitle as="h3">{eventName}</CardTitle>
              <p className="text-body-md font-semibold">
                Latest change: {describeReplyChange(change)}
              </p>
              <p className="text-body-sm text-ink-muted">
                {when(change.occurredAt)}. {describeReplySource(change)}.
              </p>
            </div>
            <List
              title="Updated automatically"
              testId="consequences-updated"
              icon={
                <RefreshCw aria-hidden="true" className="mt-1 size-4 shrink-0 text-ink-muted" />
              }
              lines={c.updated}
              empty="No totals moved."
              href={href}
            />
            <List
              title="Needs your review"
              testId="consequences-review"
              icon={<CircleAlert aria-hidden="true" className="mt-1 size-4 shrink-0 text-danger" />}
              lines={c.review}
              empty="Nothing needs your review."
              href={href}
            />
            <List
              title="Not changed"
              testId="consequences-unchanged"
              icon={
                <CircleCheck
                  aria-hidden="true"
                  className="mt-1 size-4 shrink-0 text-status-confirmed-fg"
                />
              }
              lines={c.unchanged}
              empty=""
              href={href}
            />
          </Card>
        );
      })}
    </>
  );
}
