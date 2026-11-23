import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { formatDateOnly, isDateOnly, todayInZone } from "@/domain/dates/date-only";
import { invoiceWarning } from "@/domain/ledger/invoices";
import { scheduleWarning } from "@/domain/ledger/schedule";
import { formatMinor } from "@/domain/money/money";
import {
  InvoiceForm,
  PaymentForm,
  VoidInvoiceForm,
  VoidPaymentForm,
} from "@/features/ledger/ledger-forms";
import { viewCommitment } from "@/features/ledger/view";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadBudget } from "@/server/budget/queries";
import { loadCandidate } from "@/server/candidates/queries";
import { loadDocuments } from "@/server/documents/queries";
import { loadEventVendorData } from "@/server/events/vendors";
import { loadEventLabels } from "@/server/timeline/queries";
import { WorksAt } from "@/features/events/works-at";
import { loadLedger } from "@/server/ledger/queries";
import { loadWeddingSettings } from "@/server/workspace/queries";

export const metadata: Metadata = { title: "Booking" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const link = "font-semibold text-action-emphasis underline underline-offset-4";
const dateText = (v: string) => (isDateOnly(v) ? formatDateOnly(v) : v);

const INVOICE_STATUS = {
  paid: { label: "Paid", tone: "confirmed" },
  overdue: { label: "Past due", tone: "pending" },
  partly_paid: { label: "Partly paid", tone: "neutral" },
  unpaid: { label: "Not paid yet", tone: "neutral" },
  void: { label: "Entered by mistake", tone: "neutral" },
} as const;

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
  // Which events this vendor works at. The link is on the vendor, so an amendment keeps it.
  const [eventLabels, eventVendors] =
    candidate?.kind === "vendor"
      ? await Promise.all([loadEventLabels(wid), loadEventVendorData(wid)])
      : [[], null];
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
  const invoiceWarn = invoiceWarning(v.ladder, money);
  const liveInvoices = v.invoices.filter((i) => i.status !== "void");
  const invoiceLabel = (i: (typeof v.invoices)[number]) =>
    `${i.number ? `No. ${i.number}` : "Invoice"} · ${money(i.amountMinor)}${
      i.dueOn ? ` · due ${dateText(i.dueOn)}` : ""
    }${i.unpaidMinor < i.amountMinor ? ` · ${money(i.unpaidMinor)} to pay` : ""}`;
  const invoiceOf = new Map(v.invoices.map((i) => [i.id, i]));

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
        <h2 className="sr-only">Contract, invoiced, paid and still to pay</h2>
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
          <Figure
            label="Contract"
            value={money(v.ladder.contractMinor)}
            note="What you committed to."
          />
          <Figure
            label="Invoiced"
            value={money(v.ladder.invoicedMinor)}
            note={
              liveInvoices.length === 0
                ? "No invoices recorded."
                : `${money(v.ladder.invoicedUnpaidMinor)} of it not paid yet.`
            }
          />
          <Figure
            label="Paid so far"
            value={money(v.netPaidMinor)}
            note="Payments minus refunds."
          />
          <Figure
            label="Still to pay"
            value={money(v.outstandingMinor)}
            note="Contract minus paid."
          />
        </dl>
        {v.overpaidMinor > 0 && (
          <p role="status" className="mt-4 text-body-md">
            <Badge tone="pending">Overpaid</Badge> You&apos;ve paid {money(v.overpaidMinor)} more
            than this booking. Check for a credit or a refund due.
          </p>
        )}
        {invoiceWarn && (
          <p role="status" className="mt-4 text-body-md">
            <Badge tone="pending">Check</Badge> {invoiceWarn}
          </p>
        )}
      </Card>

      {candidate?.kind === "vendor" && eventVendors && (
        <WorksAt
          workspaceId={wid}
          vendorId={candidate.id}
          vendorName={candidate.name}
          events={eventLabels}
          linkedEventIds={eventVendors.byVendor.get(candidate.id) ?? []}
          canManage={hasCapability(access, "vendors.manage")}
          headingId="works-at"
        />
      )}

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

      <section aria-labelledby="invoices" className="space-y-3">
        <h2 id="invoices" className="font-serif text-headline-sm">
          Invoices
        </h2>
        {v.invoices.length === 0 ? (
          <Card>
            <p className="text-body-md text-ink-muted">
              No invoices recorded. When the vendor sends one, record it here to see what is asked
              for and what is still unpaid.
            </p>
          </Card>
        ) : (
          <Card>
            <ul className="divide-y divide-border-hairline">
              {v.invoices.map((i) => {
                const st = INVOICE_STATUS[i.status];
                return (
                  <li key={i.id} className="space-y-2 py-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                      <span
                        className={
                          i.voided ? "text-body-lg text-ink-muted line-through" : "text-body-lg"
                        }
                      >
                        {i.number ? `Invoice ${i.number}` : "Invoice"}
                      </span>
                      <span className="font-semibold">{money(i.amountMinor)}</span>
                    </div>
                    <p className="flex flex-wrap items-center gap-2 text-body-sm text-ink-muted">
                      <Badge tone={st.tone}>{st.label}</Badge>
                      {i.issuedOn && <span>Issued {dateText(i.issuedOn)}</span>}
                      {i.dueOn && <span>Due {dateText(i.dueOn)}</span>}
                      {!i.voided && i.paidMinor > 0 && (
                        <span>
                          {money(i.paidMinor)} paid
                          {i.unpaidMinor > 0 && `, ${money(i.unpaidMinor)} to go`}
                        </span>
                      )}
                      {!i.voided && i.overpaidMinor > 0 && (
                        <span>{money(i.overpaidMinor)} more than the invoice</span>
                      )}
                    </p>
                    {i.note && <p className="text-body-sm text-ink-muted">{i.note}</p>}
                    {i.voided && <p className="text-body-sm">{i.voidReason}</p>}
                    {canEdit && isActive && !i.voided && (
                      <details>
                        <summary className="min-h-11 cursor-pointer py-2 text-label-lg font-semibold text-action-emphasis">
                          Entered by mistake?
                        </summary>
                        <div className="mt-3">
                          <VoidInvoiceForm workspaceId={wid} invoiceId={i.id} />
                        </div>
                      </details>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
        {v.ladder.paidWithoutInvoiceMinor > 0 && liveInvoices.length > 0 && (
          <p className="text-body-sm text-ink-muted">
            {money(v.ladder.paidWithoutInvoiceMinor)} of what you&apos;ve paid isn&apos;t linked to
            an invoice.
          </p>
        )}
        {canEdit && isActive && (
          <Card>
            <CardTitle>Add an invoice</CardTitle>
            <div className="mt-4">
              <InvoiceForm
                workspaceId={wid}
                commitmentId={commitment.id}
                currency={cur}
                idPrefix={`inv-${commitment.id}`}
              />
            </div>
          </Card>
        )}
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
                    {[
                      p.method,
                      p.externalRef && `Ref ${p.externalRef}`,
                      p.invoiceId && invoiceOf.get(p.invoiceId)
                        ? `For ${invoiceOf.get(p.invoiceId)?.number ? `invoice ${invoiceOf.get(p.invoiceId)?.number}` : "an invoice"}`
                        : null,
                      p.note,
                    ]
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
                invoices={liveInvoices
                  .filter((i) => i.status !== "paid")
                  .map((i) => ({ id: i.id, label: invoiceLabel(i) }))}
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
            recorded payments and invoices move to the new version.
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
