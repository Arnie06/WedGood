import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import { formatDateOnly, todayInZone } from "@/domain/dates/date-only";
import { formatMinor } from "@/domain/money/money";
import { PaymentForm } from "@/features/ledger/ledger-forms";
import { netPaid, payableCosts, viewCommitment } from "@/features/ledger/view";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadBudget } from "@/server/budget/queries";
import { loadCandidatesByIds } from "@/server/candidates/queries";
import { loadLedger } from "@/server/ledger/queries";
import { loadWeddingSettings } from "@/server/workspace/queries";

export const metadata: Metadata = { title: "Bookings and payments" };

const link = "font-semibold text-action-emphasis underline underline-offset-4";

export default async function BookingsPage({ params }: { params: Promise<{ w: string }> }) {
  const access = await requireWorkspace((await params).w);
  const wid = access.wedding.id;
  const base = `/app/${wid}`;
  const canEdit = hasCapability(access, "budget.manage");
  const [settings, budget, ledger] = await Promise.all([
    loadWeddingSettings(wid),
    loadBudget(wid),
    loadLedger(wid),
  ]);
  const cur = settings.baseCurrency;
  const money = (n: number) => formatMinor(n, cur);
  const today = todayInZone(settings.timezone);
  const active = ledger.commitments.filter((c) => c.status === "active");
  const views = active.map((c) => viewCommitment(ledger, c, today));
  const candidates = await loadCandidatesByIds(
    wid,
    active.flatMap((c) => (c.candidateId ? [c.candidateId] : [])),
  );
  const nameOf = (id: string | null) => candidates.find((c) => c.id === id)?.name ?? null;
  const direct = ledger.payments.filter((p) => p.budgetItemId !== null);
  const itemName = (id: string | null) => budget.items.find((i) => i.id === id)?.name ?? "A cost";
  const directNet = netPaid(direct);
  const costs = payableCosts(budget.items, budget.categories, ledger);

  const committed = views.reduce((s, v) => s + v.commitment.amountMinor, 0);
  const paid = views.reduce((s, v) => s + v.netPaidMinor, 0);
  const owed = views.reduce((s, v) => s + v.outstandingMinor, 0);
  const overdue = views.reduce((s, v) => s + v.schedule.overdueMinor, 0);

  return (
    <div className="max-w-3xl space-y-8">
      <header className="space-y-2">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">
          Bookings and payments
        </h1>
        <p className="text-body-lg text-ink-muted">
          What you&apos;ve signed, what you&apos;ve paid, and what&apos;s still owed. Payments here
          are records you enter; the app never moves money. Amounts are in {cur}.
        </p>
        <p>
          <Link href={`${base}/plan/budget`} className={link}>
            Back to your budget
          </Link>
        </p>
      </header>

      <Card>
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
          <Figure label="Committed" value={money(committed)} note="Active signed bookings only." />
          <Figure
            label="Paid so far"
            value={money(paid + directNet)}
            note="Payments minus refunds."
          />
          <Figure
            label="Still owed on bookings"
            value={money(owed)}
            note="Per booking, never below zero."
          />
          <Figure
            label="Past due on schedules"
            value={money(overdue)}
            note="The part of past due dates not yet covered by payments."
          />
        </dl>
      </Card>

      <section aria-labelledby="bookings" className="space-y-4">
        <h2 id="bookings" className="font-serif text-headline-sm">
          Your bookings
        </h2>
        {views.length === 0 ? (
          <Card>
            <p className="text-body-md text-ink-muted">
              Nothing booked yet. Open a venue or vendor from{" "}
              <Link href={`${base}/discover`} className={link}>
                Discover
              </Link>{" "}
              and choose “Record a booking” once you&apos;ve signed.
            </p>
          </Card>
        ) : (
          <ul className="space-y-4">
            {views.map((v) => {
              const next = v.schedule.rows.find((r) => r.status !== "covered");
              return (
                <Card as="li" key={v.commitment.id} className="space-y-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <h3 className="font-serif text-headline-sm break-words">
                      <Link
                        href={`${base}/plan/budget/bookings/${v.commitment.id}`}
                        className={link}
                      >
                        {v.commitment.title}
                      </Link>
                    </h3>
                    <p className="text-body-lg font-semibold">{money(v.commitment.amountMinor)}</p>
                  </div>
                  <p className="text-body-md text-ink-muted">
                    {nameOf(v.commitment.candidateId) ?? "No vendor linked"} · Paid{" "}
                    {money(v.netPaidMinor)} · Owed {money(v.outstandingMinor)}
                  </p>
                  <p className="flex flex-wrap items-center gap-2 text-body-sm text-ink-muted">
                    {v.overpaidMinor > 0 && (
                      <Badge tone="pending">Overpaid by {money(v.overpaidMinor)}</Badge>
                    )}
                    {v.schedule.rows.some((r) => r.status === "overdue") && (
                      <Badge tone="pending">Past due</Badge>
                    )}
                    {next
                      ? `Next: ${money(next.amountMinor - next.coveredMinor)} due ${formatDateOnly(next.dueOn)}`
                      : v.schedule.state === "none"
                        ? "No payment schedule yet"
                        : "Schedule fully covered"}
                  </p>
                </Card>
              );
            })}
          </ul>
        )}
      </section>

      {(direct.length > 0 || (canEdit && costs.length > 0)) && (
        <section aria-labelledby="direct" className="space-y-4">
          <h2 id="direct" className="font-serif text-headline-sm">
            Payments on costs with no booking
          </h2>
          <p className="text-body-md text-ink-muted">
            For things you paid for without a contract, like a dress. A cost you later book
            can&apos;t have payments of its own, so void them first and record them on the booking.
          </p>
          {direct.length > 0 && (
            <Card>
              <ul className="divide-y divide-border-hairline">
                {direct.map((p) => (
                  <li
                    key={p.id}
                    className="flex flex-wrap items-baseline justify-between gap-x-4 py-2"
                  >
                    <span className={p.voided ? "text-ink-muted line-through" : undefined}>
                      {itemName(p.budgetItemId)} · {formatDateOnly(p.paidOn as never)}
                      {p.kind === "refund" ? " · refund" : ""}
                      {p.voided && " · entered by mistake"}
                    </span>
                    <span className="font-semibold">
                      {p.kind === "refund" ? "−" : ""}
                      {money(p.amountMinor)}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {canEdit && costs.length > 0 && (
            <Card>
              <CardTitle>Record a payment on a cost</CardTitle>
              <div className="mt-4">
                <PaymentForm
                  workspaceId={wid}
                  costs={costs}
                  currency={cur}
                  today={today}
                  idPrefix="direct"
                />
              </div>
            </Card>
          )}
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
