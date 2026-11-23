import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadSeatingVersion } from "@/server/seating/queries";

export const metadata: Metadata = { title: "Finalized seating version" };

const link = "font-semibold text-action-emphasis underline underline-offset-4";
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }) + " UTC";

/** A finalized copy of a seating plan, exactly as it was frozen. View only; nothing here edits it. */
export default async function SeatingVersionPage({
  params,
}: {
  params: Promise<{ w: string; eventId: string; snapshotId: string }>;
}) {
  const { w, eventId, snapshotId } = await params;
  const access = await requireWorkspace(w);
  const wid = access.wedding.id;
  const base = `/app/${wid}`;
  if (!z.uuid().safeParse(eventId).success || !z.uuid().safeParse(snapshotId).success) notFound();
  // The copy holds guest names and meals, so it is limited to owner and partner like the plan.
  if (!hasCapability(access, "seating.manage")) notFound();

  const version = await loadSeatingVersion(wid, eventId, snapshotId);
  if (!version) notFound();
  const { plan } = version;

  return (
    <div className="max-w-3xl space-y-6">
      <header className="space-y-2">
        <p className="text-body-md">
          <Link
            href={`${base}/seating/${eventId}#versions`}
            className={`${link} inline-flex min-h-11 items-center`}
          >
            Back to the seating plan
          </Link>
        </p>
        <h1 className="font-serif text-headline-mobile break-words md:text-headline-lg">
          {version.eventName}: finalized {when(version.finalizedAt)}
        </h1>
        <p className="text-body-md">
          {version.isLatest && !version.outOfDate && (
            <>
              <Badge tone="confirmed">Latest</Badge> The plan hasn&apos;t changed since.
            </>
          )}
          {version.isLatest && version.outOfDate && (
            <>
              <Badge tone="pending">Latest, out of date</Badge> Seating, an answer or a meal has
              changed since.
            </>
          )}
          {!version.isLatest && (
            <>
              <Badge tone="neutral">Older version</Badge> Replaced by a later finalization.
            </>
          )}
        </p>
        <p className="text-body-sm text-ink-muted">
          This is a view-only copy as it was when you finalized. Changing the plan never changes it.
        </p>
      </header>

      <section aria-labelledby="counts">
        <h2 id="counts" className="sr-only">
          Counts when finalized
        </h2>
        <Card>
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
            {[
              ["Attending", plan.accepted],
              ["Seated", plan.confirmedSeated],
              ["Held for guests yet to answer", plan.tentativeSeated],
            ].map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-label-lg text-ink-muted">{label}</dt>
                <dd className="font-serif text-headline-sm">{value}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </section>

      <section aria-labelledby="tables" className="space-y-3">
        <h2 id="tables" className="font-serif text-headline-sm">
          Tables ({plan.tables.length})
        </h2>
        {plan.tables.length === 0 && (
          <p className="text-body-md text-ink-muted">There were no tables in this copy.</p>
        )}
        <ul className="space-y-3">
          {plan.tables.map((t) => (
            <li key={t.label}>
              <Card className="space-y-2">
                <CardTitle as="h3">
                  {t.label}{" "}
                  <span className="text-body-md font-normal text-ink-muted">
                    ({t.guests.length} of {t.capacity})
                  </span>
                </CardTitle>
                {t.notes && <p className="text-body-sm text-ink-muted">{t.notes}</p>}
                {t.guests.length === 0 ? (
                  <p className="text-body-md text-ink-muted">Empty.</p>
                ) : (
                  <ul className="divide-y divide-border-hairline">
                    {t.guests.map((g, i) => (
                      <li
                        key={`${g.name}-${i}`}
                        className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 text-body-md"
                      >
                        <span className="min-w-0 break-words">
                          {g.seat !== null && <span className="text-ink-muted">{g.seat}. </span>}
                          {g.name}
                          {g.captain && <span className="text-ink-muted"> (table captain)</span>}
                          {g.tentative && <span className="text-ink-muted"> (seat held)</span>}
                        </span>
                        <span className="text-ink-muted">{g.meal ?? "No meal chosen"}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
