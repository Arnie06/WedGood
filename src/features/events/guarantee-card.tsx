import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { Card, CardTitle } from "@/components/ui/card";
import { by, type Actor } from "@/domain/attention/history";
import { TrayButton } from "@/components/ui/tray";
import { daysBetween, formatDateOnly, parseDateOnly, todayInZone } from "@/domain/dates/date-only";
import type { EventDemand } from "@/domain/events/demand";
import { minimumNote, type CateringMinimum } from "@/domain/events/catering";
import { formatMinor } from "@/domain/money/money";
import {
  dueInfo,
  dueSentence,
  previewOf,
  revisionSentence,
  type GuaranteeVersion,
} from "@/domain/events/guarantee";
import { GuaranteeForm } from "@/features/events/guarantee-form";
import { DriftNote } from "@/features/events/drift-note";
import { ZonedDate } from "@/features/events/zoned-date";
import type { EventGuarantees } from "@/server/events/guarantee";

export type CatererChoice = { id: string; label: string };

/** A booking that belongs to this event's catering, with its money read from the ledger. */
export type CateringBookingRow = {
  id: string;
  title: string;
  href: string;
  currency: string;
  contractMinor: number;
  invoicedMinor: number;
  paidMinor: number;
  invoiceCount: number;
  withCaterer: boolean;
  minimum: CateringMinimum | null;
};

/** The soonest reply date still ahead for this event's waiting guests. */
export type CardReplyBy = { iso: string; several: boolean; timeZone: string };

const link = "font-semibold text-action-emphasis underline underline-offset-4";

function Row({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div
      className="grid gap-x-4 gap-y-0.5 py-2 first:pt-0 sm:grid-cols-[11rem_1fr]"
      data-testid={testId}
    >
      <dt className="text-label-lg text-ink-muted">{label}</dt>
      <dd className="text-body-md break-words">{children}</dd>
    </div>
  );
}

function whenLabel(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone }).format(new Date(iso));
}

/**
 * The Event page's "Caterer count" card (REL-08, breakdown UX-14 / W8). One place for the catering
 * numbers: attending now, the locked count (when and by whom), each catering booking's guest minimum,
 * contract, invoiced and paid, and how far replies have moved from the locked count. Every number is
 * read from where it lives; the card never changes one. Locking and revising are owner and partner
 * only; the tray shows today's replies first.
 */
export function GuaranteeCard({
  workspaceId,
  eventId,
  eventName,
  demand,
  guarantees,
  caterers,
  canManage,
  timezone,
  base,
  lockedBy = null,
  replyBy = null,
  bookings = [],
}: {
  workspaceId: string;
  eventId: string;
  eventName: string;
  /** Null when this member may not read guest totals; the card then renders nothing. */
  demand: EventDemand | null;
  guarantees: EventGuarantees | undefined;
  /** Vendors assigned to this event, plus the one already chosen even if it was passed on since. */
  caterers: CatererChoice[];
  canManage: boolean;
  timezone: string;
  base: string;
  /** Who locked the current count, as "you" or a role. */
  lockedBy?: Actor | null;
  /** Null when there is no reply date ahead, or the member may not read invitations. */
  replyBy?: CardReplyBy | null;
  /** Bookings that belong to this event's catering, the chosen caterer's first. */
  bookings?: readonly CateringBookingRow[];
}) {
  // Whoever may not read guest totals sees nothing here (the Who's coming card already says so),
  // like the Meals and Seating cards.
  if (demand === null) return null;
  const current = guarantees?.current ?? null;
  const history = guarantees?.history ?? [];
  const packageHref = `${base}/plan/packages/new?preset=caterer`;
  const today = todayInZone(timezone);
  const due = current?.dueOn
    ? dueInfo(current.dueOn, daysBetween(today, parseDateOnly(current.dueOn)))
    : dueInfo(null, null);
  const caterer = current?.candidateId
    ? caterers.find((c) => c.id === current.candidateId)
    : undefined;

  const all: GuaranteeVersion[] = [...(current ? [current] : []), ...history].map((g) => ({
    id: g.id,
    count: g.count,
    status: g.status,
    lockedAt: g.lockedAt,
    reason: g.reason,
    supersedesId: g.supersedesId,
  }));
  const byId = new Map(all.map((v) => [v.id, v]));

  const form = (revisingId: string | null) =>
    demand ? (
      <GuaranteeForm
        workspaceId={workspaceId}
        eventId={eventId}
        eventName={eventName}
        guaranteeId={revisingId}
        preview={previewOf(demand)}
        meals={demand.meals}
        yes={demand.yes}
        waiting={demand.waiting}
        planningNumber={demand.planningNumber}
        startCount={current?.count ?? demand.planningNumber}
        caterers={caterers}
        startCaterer={current?.candidateId ?? ""}
        startDue={current?.dueOn ?? ""}
        packageHref={packageHref}
      />
    ) : null;

  return (
    <Card as="section" aria-labelledby="caterer-heading" className="space-y-3">
      <CardTitle>
        <span id="caterer-heading">Caterer count</span>
      </CardTitle>
      <dl className="divide-y divide-border-hairline" data-testid="catering-breakdown">
        <Row label="Attending now" testId="catering-attending">
          <span className="font-semibold">{demand.yes}</span>
          {demand.waiting > 0 && (
            <span className="text-ink-muted">
              {" "}
              (+ {demand.waiting} waiting
              {replyBy && (
                <>
                  , {replyBy.several ? "next reply date" : "reply by"}{" "}
                  <ZonedDate iso={replyBy.iso} timeZone={replyBy.timeZone} month="short" />
                </>
              )}
              )
            </span>
          )}
        </Row>
        <Row label="Locked count" testId="catering-locked">
          {current === null ? (
            <span className="text-ink-muted" data-testid="guarantee-empty">
              No count locked yet. Once you lock one, it stays exactly as you set it when guests
              reply later.
            </span>
          ) : (
            <span data-testid="guarantee-summary">
              <span className="font-serif text-headline-sm">{current.count}</span>{" "}
              {current.count === 1 ? "guest" : "guests"}
              <span className="text-ink-muted">
                {" · locked "}
                {whenLabel(current.lockedAt, timezone)}
                {by(lockedBy)}
                {caterer ? ` · ${caterer.label}` : ""}
              </span>
              <span className="block text-body-sm text-ink-muted">
                {dueSentence(
                  due,
                  current.dueOn ? formatDateOnly(parseDateOnly(current.dueOn)) : "",
                )}
              </span>
            </span>
          )}
        </Row>
        {bookings.length === 0 ? (
          <Row label="Booking" testId="catering-no-booking">
            <span className="text-ink-muted">
              No catering booking yet.
              {current?.candidateId
                ? " When you book the chosen caterer, or book a per-guest cost counted by this event, its minimum, invoices and payments show here."
                : " Book a per-guest cost counted by this event, or choose the caterer when you lock the count, and its invoices and payments show here."}
            </span>
          </Row>
        ) : (
          bookings.map((b) => {
            const money = (n: number) => formatMinor(n, b.currency);
            return (
              <Fragment key={b.id}>
                <Row label="Booking" testId="catering-booking">
                  <Link href={b.href} className={link}>
                    {b.title}
                  </Link>
                  <span className="text-ink-muted">
                    {" · contract "}
                    {money(b.contractMinor)}
                    {b.withCaterer ? " · the chosen caterer" : ""}
                  </span>
                </Row>
                <Row label="Guest minimum" testId="catering-minimum">
                  {b.minimum ? (
                    <>
                      <span className="font-semibold">{b.minimum.count}</span>
                      <span className="text-ink-muted">
                        {" · from the cost “"}
                        {b.minimum.itemName}
                        {"”"}
                      </span>
                    </>
                  ) : (
                    <span className="text-ink-muted">None entered on its costs</span>
                  )}
                </Row>
                <Row label="Invoiced and paid" testId="catering-money">
                  {b.invoiceCount === 0 ? (
                    <span className="text-ink-muted">No invoices yet</span>
                  ) : (
                    <>Invoiced {money(b.invoicedMinor)}</>
                  )}
                  {" · "}
                  Paid {money(b.paidMinor)}
                </Row>
              </Fragment>
            );
          })
        )}
      </dl>
      {current !== null && (
        <DriftNote
          locked={current.count}
          yes={demand.yes}
          waiting={demand.waiting}
          {...(canManage && { href: `${base}/plan/events/${eventId}#caterer-heading` })}
        />
      )}
      {bookings.map((b) => {
        const note = minimumNote(b.minimum, current?.count ?? null, demand.yes);
        return note ? (
          <p key={b.id} className="text-body-md" data-testid="catering-minimum-note">
            {bookings.length > 1 && <span className="font-semibold">{b.title}: </span>}
            {note}
          </p>
        ) : null;
      })}
      {canManage && demand.invited === 0 && current === null && (
        <p className="text-body-sm text-ink-muted">
          Invite guests to this event first, so there are replies to base the count on.
        </p>
      )}
      <p className="text-body-sm text-ink-muted">
        Nothing here is sent to the caterer, and no booking or payment changes from this card.
      </p>
      {/* One tray for both states, always in this slot: after a lock the card flips to its locked
          view, and the tray must stay mounted so its success panel is not torn down. */}
      {canManage && (current !== null || demand.invited > 0) && (
        <TrayButton
          label={current ? "Revise count" : "Lock the count"}
          variant={current ? "outline" : "emphasis"}
          size="sm"
          title={`Caterer count for ${eventName}`}
          description={
            current
              ? "The old count stays in the history. Nothing is sent from here."
              : "Tell the caterer a firm number. Nothing is sent from here."
          }
        >
          {form(current?.id ?? null)}
        </TrayButton>
      )}
      {history.length > 0 && (
        <details className="text-body-md" data-testid="guarantee-history">
          <summary className="inline-flex min-h-11 cursor-pointer items-center font-semibold text-action-emphasis underline underline-offset-4">
            Count history ({history.length + 1})
          </summary>
          <ul className="mt-2 space-y-2">
            {[...(current ? [current] : []), ...history].map((g) => {
              const v = byId.get(g.id);
              const sentence = v ? revisionSentence(v, byId) : null;
              return (
                <li key={g.id} className="break-words">
                  <span className="font-semibold">{g.count}</span>
                  <span className="text-ink-muted">
                    {" · "}
                    {whenLabel(g.lockedAt, timezone)}
                    {g.status === "locked" ? " · current" : " · replaced"}
                  </span>
                  {sentence && (
                    <span className="block text-body-sm text-ink-muted">{sentence}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </Card>
  );
}
