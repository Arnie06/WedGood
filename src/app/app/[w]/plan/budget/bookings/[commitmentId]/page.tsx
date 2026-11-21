import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { formatDateOnly, isDateOnly, todayInZone } from "@/domain/dates/date-only";
import { scheduleWarning } from "@/domain/ledger/schedule";
import { formatMinor } from "@/domain/money/money";
import { PaymentForm, VoidPaymentForm } from "@/features/ledger/ledger-forms";
import { viewCommitment } from "@/features/ledger/view";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadBudget } from "@/server/budget/queries";
import { loadCandidate } from "@/server/candidates/queries";
import { loadDocuments } from "@/server/documents/queries";
import { loadLedger } from "@/server/ledger/queries";
import { loadWeddingSettings } from "@/server/workspace/queries";

export const metadata: Metadata = { title: "Booking" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const link = "font-semibold text-action-emphasis underline underline-offset-4";
const dateText = (v: string) => (isDateOnly(v) ? formatDateOnly(v) : v);

const STATUS_LABEL = {
  overdue: "Past due",
  covered: "Covered",
  partly_covered: "Partly covered",
  upcoming: "Upcoming",
} as const;

export default async function BookingPage({
  params,
}: {
  params: Promise<{ w: string; commitmentId: string }>;
}) {
  const { w, commitmentId } = await params;
  const access = await requireWorkspace(w);
  if (!UUID.test(commitmentId)) notFound();
  const wid = access.wedding.id;
  const base = `/app/${wid}`;
  const canEdit = hasCapability(access, "budget.manage");
  const [settings, budget, ledger] = await Promise.all([
    loadWeddingSettings(wid),
    loadBudget(wid),
    loadLedger(wid),
  ]);
  const commitment = ledger.commitments.find((c) => c.id === commitmentId);
  if (!commitment) notFound();
  const cur = settings.baseCurrency;
  const money = (n: number) => formatMinor(n, cur);
  const today = todayInZone(settings.timezone);
  const v = viewCommitment(ledger, commitment, today);
  // Documents attached to this booking or to its payments (owners and partners only, via RLS).
  const paymentIds = new Set(
    ledger.payments.filter((p) => p.commitmentId === commitment.id).map((p) => p.id),
  );
  const docData = canEdit ? await loadDocuments(wid) : { documents: [], links: [] };
  const attachedDocs = docData.documents.filter(
    (d) =>
      !d.archived &&
      docData.links.some(
        (l) =>
          l.documentId === d.id &&
          ((l.targetType === "commitment" && l.targetId === commitment.id) ||
            (l.targetType === "payment" && paymentIds.has(l.targetId))),
      ),
  );
  const candidate = commitment.candidateId
    ? await loadCandidate(wid, commitment.candidateId)
    : null;
  const itemName = (id: string) => budget.items.find((i) => i.id === id)?.name ?? "A removed cost";
  const isActive = commitment.status === "active";

  // History: this booking's earlier versions, newest first, and what replaced it (if anything).
  const byId = new Map(ledger.commitments.map((c) => [c.id, c]));
  const earlier: typeof ledger.commitments = [];
  for (let c = byId.get(commitment.supersedesId ?? ""); c; c = byId.get(c.supersedesId ?? "")) {
    earlier.push(c);
    if (earlier.length > 50) break;
  }
  const replacedBy = ledger.commitments.find((c) => c.supersedesId === commitment.id);
  const warn = scheduleWarning(v.schedule.state, v.schedule.unscheduledMinor, money);

  return (
    <div className="max-w-3xl space-y-8">
      <header className="space-y-2">
        <h1 className="font-serif text-headline-mobile break-words md:text-headline-lg">
          {commitment.title}
        </h1>
        <p className="flex flex-wrap items-center gap-2 text-body-md text-ink-muted">
          {isActive ? (
            <Badge tone="confirmed">Active</Badge>
          ) : (
            <Badge tone="neutral">Replaced by an amendment</Badge>
          )}
          {candidate && (
            <Link href={`${base}/discover/${candidate.id}`} className={link}>
              {candidate.name}
            </Link>
          )}
          {commitment.signedOn && <span>Signed {dateText(commitment.signedOn)}</span>}
        </p>
        <p>
          <Link href={`${base}/plan/budget/bookings`} className={link}>
            All bookings and payments
          </Link>
        </p>
      </header>

      {!isActive && (
        <Card>
          <p className="text-body-md">
            This is an earlier version. It no longer counts toward your budget.{" "}
            {replacedBy && (
              <Link href={`${base}/plan/budget/bookings/${replacedBy.id}`} className={link}>
                See the current booking
              </Link>
            )}
          </p>
        </Card>
      )}

      <Card>
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-3">
          <Figure label="Committed" value={money(commitment.amountMinor)} />
          <Figure
            label="Paid so far"
            value={money(v.netPaidMinor)}
            note="Payments minus refunds."
          />
          <Figure label="Still owed" value={money(v.outstandingMinor)} />
        </dl>
        {v.overpaidMinor > 0 && (
          <p role="status" className="mt-4 text-body-md">
            <Badge tone="pending">Overpaid</Badge> You&apos;ve paid {money(v.overpaidMinor)} more
            than this booking. Check for a credit or a refund due.
          </p>
        )}
      </Card>

      <section aria-labelledby="covers" className="space-y-3">
        <h2 id="covers" className="font-serif text-headline-sm">
          What it covers
        </h2>
        <Card>
          <ul className="divide-y divide-border-hairline">
            {v.allocations.map((a) => (
              <li
                key={a.budgetItemId}
                className="flex flex-wrap items-baseline justify-between gap-x-4 py-2"
              >
                <span>{itemName(a.budgetItemId)}</span>
                <span className="font-semibold">{money(a.amountMinor)}</span>
              </li>
            ))}
          </ul>
        </Card>
        <p className="text-body-sm text-ink-muted">
          These costs count once, as this booking, in your budget forecast.
        </p>
      </section>

      <section aria-labelledby="schedule" className="space-y-3">
        <h2 id="schedule" className="font-serif text-headline-sm">
          Payment schedule
        </h2>
        {warn && (
          <p role="status" className="text-body-md">
            <Badge tone="pending">Check</Badge> {warn}
          </p>
        )}
        {v.schedule.rows.length > 0 && (
          <Card>
            <ul className="divide-y divide-border-hairline">
              {v.schedule.rows.map((r) => (
                <li key={r.id} className="space-y-1 py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                    <span className="text-body-lg">
                      {r.label ? `${r.label} · ` : ""}
                      {dateText(r.dueOn)}
                    </span>
                    <span className="font-semibold">{money(r.amountMinor)}</span>
                  </div>
                  <p className="flex flex-wrap items-center gap-2 text-body-sm text-ink-muted">
                    <Badge
                      tone={
                        r.status === "covered"
                          ? "confirmed"
                          : r.status === "overdue"
                            ? "pending"
                            : "neutral"
                      }
                    >
                      {STATUS_LABEL[r.status]}
                    </Badge>
                    {r.coveredMinor > 0 &&
                      r.status !== "covered" &&
                      `${money(r.coveredMinor)} covered so far`}
                  </p>
                </li>
              ))}
            </ul>
          </Card>
        )}
        <p className="text-body-sm text-ink-muted">
          A schedule is a plan. Payments you record are matched to it oldest due date first.
        </p>
      </section>

      <section aria-labelledby="payments" className="space-y-3">
        <h2 id="payments" className="font-serif text-headline-sm">
          Payments and refunds
        </h2>
        {v.payments.length === 0 ? (
          <Card>
            <p className="text-body-md text-ink-muted">Nothing recorded yet.</p>
          </Card>
        ) : (
          <Card>
            <ul className="divide-y divide-border-hairline">
              {v.payments.map((p) => (
                <li key={p.id} className="space-y-2 py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                    <span
                      className={
                        p.voided ? "text-body-lg text-ink-muted line-through" : "text-body-lg"
                      }
                    >
                      {dateText(p.paidOn)} · {p.kind === "refund" ? "Refund" : "Payment"}
                    </span>
                    <span className="font-semibold">
                      {p.kind === "refund" ? "−" : ""}
                      {money(p.amountMinor)}
                    </span>
                  </div>
                  <p className="text-body-sm text-ink-muted">
                    {[p.method, p.externalRef && `Ref ${p.externalRef}`, p.note]
                      .filter(Boolean)
                      .join(" · ") || "No details"}
                  </p>
                  {p.voided && (
                    <p className="text-body-sm">
                      <Badge tone="neutral">Entered by mistake</Badge> {p.voidReason}
                    </p>
                  )}
                  {canEdit && isActive && !p.voided && (
                    <details>
                      <summary className="min-h-11 cursor-pointer py-2 text-label-lg font-semibold text-action-emphasis">
                        Entered by mistake?
                      </summary>
                      <div className="mt-3">
                        <VoidPaymentForm workspaceId={wid} paymentId={p.id} />
                      </div>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        )}
        {canEdit && isActive && (
          <Card>
            <CardTitle>Record a payment or refund</CardTitle>
            <div className="mt-4">
              <PaymentForm
                workspaceId={wid}
                commitmentId={commitment.id}
                currency={cur}
                today={today}
                idPrefix={`pay-${commitment.id}`}
              />
            </div>
          </Card>
        )}
      </section>

      {canEdit && isActive && (
        <section aria-labelledby="amend" className="space-y-3">
          <h2 id="amend" className="font-serif text-headline-sm">
            Changed the contract?
          </h2>
          <p className="text-body-md text-ink-muted">
            An amendment keeps this version in the history and replaces it with a new one. Your
            recorded payments move to the new version.
          </p>
          <ButtonLink
            href={`${base}/plan/budget/bookings/${commitment.id}/amend`}
            variant="outline"
            size="sm"
          >
            Amend this booking
          </ButtonLink>
        </section>
      )}

      {earlier.length > 0 && (
        <section aria-labelledby="history" className="space-y-3">
          <h2 id="history" className="font-serif text-headline-sm">
            Earlier versions
          </h2>
          <Card>
            <ul className="divide-y divide-border-hairline">
              {earlier.map((c) => (
                <li
                  key={c.id}
                  className="flex flex-wrap items-baseline justify-between gap-x-4 py-2"
                >
                  <Link href={`${base}/plan/budget/bookings/${c.id}`} className={link}>
                    {c.title}
                  </Link>
                  <span className="text-ink-muted">{money(c.amountMinor)}</span>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      {canEdit && (
        <section aria-labelledby="documents" className="space-y-3">
          <h2 id="documents" className="font-serif text-headline-sm">
            Documents
          </h2>
          <Card>
            {attachedDocs.length === 0 ? (
              <p className="text-body-md text-ink-muted">No contract or receipts attached yet.</p>
            ) : (
              <ul className="divide-y divide-border-hairline">
                {attachedDocs.map((d) => (
                  <li key={d.id} className="py-2">
                    <Link href={`${base}/plan/documents`} className={link}>
                      {d.title}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <p>
            <Link href={`${base}/plan/documents?link=commitment:${commitment.id}`} className={link}>
              Add a document to this booking
            </Link>
          </p>
        </section>
      )}
    </div>
  );
}

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="space-y-1">
      <dt className="text-label-lg text-ink-muted">{label}</dt>
      <dd className="font-serif text-headline-sm">{value}</dd>
      {note && <dd className="text-body-sm text-ink-muted">{note}</dd>}
    </div>
  );
}
