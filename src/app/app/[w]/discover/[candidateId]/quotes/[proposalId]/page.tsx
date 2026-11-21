import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { displayHost } from "@/domain/candidates/input";
import { formatMinor } from "@/domain/money/money";
import { normalizeProposal } from "@/domain/proposals/normalize";
import { minorToMajorInput } from "@/domain/wedding/settings";
import { LineForm, type LineFormDefaults } from "@/features/quotes/line-form";
import { ProposalForm } from "@/features/quotes/proposal-form";
import {
  ArchiveProposalForm,
  ProposalStatusForm,
  RemoveLineForm,
} from "@/features/quotes/quote-actions";
import {
  completenessLabel,
  formatReceived,
  lineAmountLabel,
  lineBasisLabel,
  modeLabel,
  warningLabels,
} from "@/features/quotes/format";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadCandidate } from "@/server/candidates/queries";
import { addProposalLine, updateProposal, updateProposalLine } from "@/server/proposals/actions";
import { loadProposal } from "@/server/proposals/queries";
import { loadWeddingSettings } from "@/server/workspace/queries";

export const metadata: Metadata = { title: "Quote" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const link = "font-semibold text-action-emphasis underline underline-offset-4";

export default async function QuotePage({
  params,
}: {
  params: Promise<{ w: string; candidateId: string; proposalId: string }>;
}) {
  const { w, candidateId, proposalId } = await params;
  const access = await requireWorkspace(w);
  if (!UUID.test(candidateId) || !UUID.test(proposalId)) notFound();
  const wid = access.wedding.id;
  const base = `/app/${wid}`;
  const canManage = hasCapability(access, "vendors.manage");
  const [candidate, quote, settings] = await Promise.all([
    loadCandidate(wid, candidateId),
    loadProposal(wid, candidateId, proposalId),
    loadWeddingSettings(wid),
  ]);
  if (!candidate || !quote) notFound();

  const currency = quote.currency;
  const guestCount = settings.targetGuestCount;
  const norm = normalizeProposal(quote.lines, guestCount);
  const byId = new Map(quote.lines.map((l) => [l.id, l]));
  const meta = formatReceived(quote.validUntil, quote.receivedOn);
  const parents = quote.lines
    .filter(
      (l) => l.costMode === "fixed" || l.costMode === "per_guest" || l.costMode === "quantity",
    )
    .map((l) => ({ id: l.id, description: l.description }));
  const lineDefaults = (l: (typeof quote.lines)[number]): LineFormDefaults => ({
    description: l.description,
    costMode: l.costMode,
    amount: minorToMajorInput(l.amountMinor, currency),
    quantity: l.quantity?.toString() ?? "",
    minQty: l.minQty?.toString() ?? "",
    maxQty: l.maxQty?.toString() ?? "",
    ratePercent: l.rateBp === null ? "" : String(l.rateBp / 100),
    percentBase: l.percentBase ? "yes" : "no",
    requirement: l.required ? "required" : "optional",
    certainty: l.certainty,
    includedIn: l.includedInLineId ?? "",
    evidence: l.evidence ?? "",
  });
  const hiddenLine = { workspaceId: wid, version: String(quote.version) };

  return (
    <div className="max-w-2xl space-y-8">
      <header className="space-y-2">
        <h1 className="font-serif text-headline-mobile break-words md:text-headline-lg">
          {quote.title}
        </h1>
        <p className="flex flex-wrap items-center gap-2 text-body-md text-ink-muted">
          <span>from {candidate.name}</span>
          {quote.status === "declined" && <Badge tone="neutral">Passed</Badge>}
        </p>
        {meta.length > 0 && <p className="text-body-sm text-ink-muted">{meta.join(" · ")}</p>}
        {quote.sourceUrl && (
          <p className="text-body-sm">
            <a
              href={quote.sourceUrl}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className={link}
            >
              Open the quote ({displayHost(quote.sourceUrl)})
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </p>
        )}
        {quote.notes && (
          <p className="whitespace-pre-wrap text-body-md text-ink-muted">{quote.notes}</p>
        )}
      </header>

      <section aria-labelledby="summary-heading">
        <Card className="space-y-2">
          <h2 id="summary-heading" className="font-serif text-headline-sm">
            What&apos;s known
          </h2>
          <p className="text-headline-sm font-serif" data-testid="known-total">
            {formatMinor(norm.requiredKnownMinor, currency)}
            {!norm.complete && <span className="text-body-md text-ink-muted"> so far</span>}
          </p>
          <p className="text-body-md" data-testid="completeness">
            {completenessLabel(norm)}
          </p>
          {norm.requiredEstimatedMinor > 0 && (
            <p className="text-body-md text-ink-muted">
              {formatMinor(norm.requiredEstimatedMinor, currency)} of that is your own estimate, not
              a quoted price.
            </p>
          )}
          {norm.optionalKnownMinor > 0 && (
            <p className="text-body-md text-ink-muted">
              Optional add-ons would add {formatMinor(norm.optionalKnownMinor, currency)}.
            </p>
          )}
          <p className="text-body-sm text-ink-muted">
            {guestCount === null
              ? "Per-guest costs need a guest count. Set one in event settings."
              : `Per-guest costs use your guest target of ${guestCount}.`}{" "}
            This is a record of what you were told, not a booking or an amount you owe.
          </p>
        </Card>
      </section>

      <section aria-labelledby="costs-heading" className="space-y-3">
        <h2 id="costs-heading" className="font-serif text-headline-sm">
          Costs
        </h2>
        {quote.lines.length === 0 ? (
          <Card>
            <p className="text-body-md text-ink-muted">
              No costs yet. Add each line from the quote. Anything you don&apos;t know yet can stay
              blank and will show as unknown.
            </p>
          </Card>
        ) : (
          <ul className="space-y-3">
            {norm.lines.map((n) => {
              const l = byId.get(n.id);
              if (!l) return null;
              const parent = l.includedInLineId ? byId.get(l.includedInLineId) : undefined;
              const warnings = warningLabels(n, l);
              return (
                <Card as="li" key={l.id} className="space-y-2 p-4 sm:p-4" data-testid="quote-line">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <h3 className="min-w-0 break-words text-label-lg font-semibold">
                      {l.description}
                    </h3>
                    <p className="font-semibold" data-testid="line-amount">
                      {lineAmountLabel(n, currency)}
                    </p>
                  </div>
                  <p className="text-body-sm text-ink-muted">
                    {modeLabel(l.costMode)} ·{" "}
                    {lineBasisLabel(l, n, currency, parent?.description ?? null)}
                  </p>
                  <p className="flex flex-wrap gap-2">
                    {!l.required && <Badge tone="neutral">Optional</Badge>}
                    {l.certainty === "estimated" && <Badge tone="pending">Your estimate</Badge>}
                    {n.state === "unknown" && <Badge tone="pending">Unknown</Badge>}
                    {n.state === "partial" && <Badge tone="pending">Incomplete</Badge>}
                  </p>
                  {warnings.map((m) => (
                    <p key={m} className="text-body-sm text-ink-muted">
                      {m}
                    </p>
                  ))}
                  {l.evidence && (
                    <p className="text-body-sm text-ink-muted">Source: {l.evidence}</p>
                  )}
                  {canManage && (
                    <details className="pt-1">
                      <summary className="min-h-11 cursor-pointer py-2 text-label-lg font-semibold text-action-emphasis">
                        Edit <span className="sr-only">{l.description}</span>
                      </summary>
                      <div className="mt-3 space-y-4">
                        <LineForm
                          action={updateProposalLine}
                          currency={currency}
                          defaults={lineDefaults(l)}
                          hidden={{ ...hiddenLine, lineId: l.id }}
                          parents={parents.filter((p) => p.id !== l.id)}
                          submitLabel="Save changes"
                          pendingLabel="Saving…"
                        />
                        <RemoveLineForm
                          workspaceId={wid}
                          lineId={l.id}
                          version={quote.version}
                          name={l.description}
                        />
                      </div>
                    </details>
                  )}
                </Card>
              );
            })}
          </ul>
        )}
      </section>

      {canManage && (
        <>
          <section aria-labelledby="add-heading" className="space-y-3">
            <h2 id="add-heading" className="font-serif text-headline-sm">
              Add a cost
            </h2>
            <LineForm
              action={addProposalLine}
              currency={currency}
              defaults={{
                description: "",
                costMode: "fixed",
                amount: "",
                quantity: "",
                minQty: "",
                maxQty: "",
                ratePercent: "",
                percentBase: "no",
                requirement: "required",
                certainty: "quoted",
                includedIn: "",
                evidence: "",
              }}
              hidden={{ ...hiddenLine, proposalId: quote.id, idempotencyKey: randomUUID() }}
              parents={parents}
              submitLabel="Add this cost"
              pendingLabel="Adding…"
              rotateKey
            />
          </section>

          <section
            aria-labelledby="details-heading"
            className="space-y-3 border-t border-border-hairline pt-6"
          >
            <h2 id="details-heading" className="font-serif text-headline-sm">
              Quote details
            </h2>
            <ProposalForm
              action={updateProposal}
              submitLabel="Save details"
              pendingLabel="Saving…"
              defaults={{
                title: quote.title,
                receivedOn: quote.receivedOn ?? "",
                validUntil: quote.validUntil ?? "",
                sourceUrl: quote.sourceUrl ?? "",
                notes: quote.notes ?? "",
              }}
              hidden={{ workspaceId: wid, proposalId: quote.id, version: String(quote.version) }}
            />
            <div className="flex flex-col gap-3 sm:flex-row">
              <ProposalStatusForm
                workspaceId={wid}
                proposalId={quote.id}
                version={quote.version}
                status={quote.status}
              />
              <ArchiveProposalForm
                workspaceId={wid}
                candidateId={candidateId}
                proposalId={quote.id}
                version={quote.version}
              />
            </div>
          </section>
          {quote.status === "open" &&
            hasCapability(access, "budget.manage") &&
            !["booked", "declined", "cancelled"].includes(candidate.stage) && (
              <section aria-labelledby="book-heading" className="space-y-2">
                <h2 id="book-heading" className="font-serif text-headline-sm">
                  Ready to book?
                </h2>
                <p className="text-body-md text-ink-muted">
                  Choosing this quote doesn&apos;t book anything. When you&apos;ve signed, record
                  the booking so it counts as a commitment.
                </p>
                <ButtonLink
                  href={`${base}/discover/${candidateId}/book?proposal=${quote.id}`}
                  variant="secondary"
                  size="sm"
                >
                  Record a booking from this quote
                </ButtonLink>
              </section>
            )}
        </>
      )}
      <p>
        <Link href={`${base}/discover/${candidateId}`} className={link}>
          Back to {candidate.name}
        </Link>
      </p>
    </div>
  );
}
