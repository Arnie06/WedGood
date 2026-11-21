import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { evaluateComparison } from "@/domain/comparison/evaluate";
import { decisionWarnings } from "@/domain/comparison/figures";
import { STALE_REASON_TEXT, staleReasons } from "@/domain/comparison/staleness";
import {
  ArchiveForm,
  DecideForm,
  RatingsForm,
  SettingsForm,
} from "@/features/compare/compare-forms";
import { isRemoved, optionLabel, toOptionInputs } from "@/features/compare/mappers";
import { OptionCard } from "@/features/compare/option-card";
import { shortDate } from "@/features/plan/format";
import { CommentsSection } from "@/features/comments/comments-section";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadComparison } from "@/server/comparisons/queries";

export const metadata: Metadata = { title: "Comparison" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const link = "font-semibold text-action-emphasis underline underline-offset-4";
const GONE = "a quote that is no longer available";

export default async function ComparisonPage({
  params,
}: {
  params: Promise<{ w: string; comparisonId: string }>;
}) {
  const { w, comparisonId } = await params;
  const access = await requireWorkspace(w);
  if (!UUID.test(comparisonId)) notFound();
  const cmp = await loadComparison(access.wedding.id, comparisonId);
  if (!cmp) notFound();
  const base = `/app/${access.wedding.id}`;
  const canManage = hasCapability(access, "vendors.manage");

  const evaluation = evaluateComparison({
    guestCount: cmp.guestCount,
    currency: cmp.currency,
    criteria: cmp.criteria,
    options: toOptionInputs(cmp),
    acceptsUnknowns: cmp.acceptsUnknowns,
  });
  const live = cmp.options.filter((o) => !isRemoved(o));
  const removed = cmp.options.length - live.length;
  const hidden = { workspaceId: access.wedding.id, comparisonId: cmp.id, version: cmp.version };
  const nameOf = (proposalId: string) => {
    const o = cmp.options.find((x) => x.proposal?.id === proposalId);
    return o ? optionLabel(o) : GONE;
  };

  const decision = cmp.decision;
  const stale = decision ? staleReasons(decision.sourceState, cmp.currentState) : [];

  return (
    <div className="max-w-3xl space-y-8">
      <header className="space-y-2">
        <h1 className="font-serif text-headline-mobile break-words md:text-headline-lg">
          {cmp.title}
        </h1>
        <p className="text-body-md text-ink-muted">
          Every option is priced for {cmp.guestCount} guests in {cmp.currency}.
        </p>
      </header>

      {decision && (
        <Card as="section" aria-labelledby="decision-heading" className="space-y-2">
          <h2 id="decision-heading" className="font-serif text-headline-sm">
            Your decision
          </h2>
          <p className="text-body-md">
            You chose <span className="font-semibold">{nameOf(decision.chosenProposalId)}</span> on{" "}
            {shortDate(decision.decidedAt.slice(0, 10))}. Nothing has been booked.
          </p>
          {decision.note && (
            <p className="whitespace-pre-wrap text-body-md text-ink-muted">{decision.note}</p>
          )}
          {stale.length > 0 && (
            <p role="status" className="text-body-md font-semibold text-danger">
              This decision may be out of date: {stale.map((r) => STALE_REASON_TEXT[r]).join("; ")}{" "}
              since you made it. It hasn&apos;t been changed. Look again, then choose again if you
              want to.
            </p>
          )}
        </Card>
      )}

      {removed > 0 && (
        <p role="status" className="text-body-md text-ink-muted">
          {removed === 1 ? "One quote was" : `${removed} quotes were`} removed after this comparison
          was made, so {removed === 1 ? "it isn't" : "they aren't"} shown.
        </p>
      )}

      <section aria-labelledby="options-heading" className="space-y-3">
        <h2 id="options-heading" className="font-serif text-headline-sm">
          Side by side
        </h2>
        {!evaluation.costsFullyKnown && (
          <p className="text-body-sm text-ink-muted">
            Some required costs are unknown, so we can&apos;t say which option is cheapest. Totals
            show only what&apos;s known.
          </p>
        )}
        <ul className="grid gap-4 md:grid-cols-2">
          {evaluation.options.map((o) => {
            const src = cmp.options.find((x) => x.proposal?.id === o.proposalId);
            return (
              <OptionCard
                key={o.id}
                evaluation={o}
                href={
                  src?.candidate
                    ? `${base}/discover/${src.candidate.id}/quotes/${o.proposalId}`
                    : base
                }
                currency={cmp.currency}
                guests={cmp.guestCount}
                chosen={decision?.chosenProposalId === o.proposalId}
                lowest={evaluation.lowestKnownCostIds.includes(o.id)}
              />
            );
          })}
        </ul>
        <p className="text-body-sm text-ink-muted">
          Preference scores come only from the ratings and weights you enter. Prices and
          availability are as you recorded them; nothing here is confirmed with the vendor.
        </p>
      </section>

      {canManage ? (
        <>
          <section aria-labelledby="ratings-heading" className="space-y-3">
            <h2 id="ratings-heading" className="font-serif text-headline-sm">
              Your ratings
            </h2>
            {cmp.criteria.length === 0 ? (
              <p className="text-body-md text-ink-muted">Add a criterion below to start rating.</p>
            ) : (
              <RatingsForm
                hidden={hidden}
                criteria={cmp.criteria}
                options={live.map((o) => ({
                  id: o.id,
                  label: optionLabel(o),
                  ratings: o.ratings,
                }))}
              />
            )}
          </section>

          <section aria-labelledby="settings-heading" className="space-y-3">
            <h2 id="settings-heading" className="font-serif text-headline-sm">
              Settings and weights
            </h2>
            <SettingsForm
              hidden={hidden}
              title={cmp.title}
              guestCount={cmp.guestCount}
              criteria={cmp.criteria}
              acceptsUnknowns={cmp.acceptsUnknowns}
            />
          </section>

          <section aria-labelledby="decide-heading" className="space-y-4">
            <h2 id="decide-heading" className="font-serif text-headline-sm">
              Choose one
            </h2>
            {evaluation.options.length === 0 ? (
              <p className="text-body-md text-ink-muted">
                There are no quotes left to choose from.
              </p>
            ) : (
              evaluation.options.map((o) => {
                const warnings = decisionWarnings(evaluation, o.proposalId).map((x) =>
                  x === "capacity_short"
                    ? "this venue seats fewer than your guest count"
                    : "some required costs are still unknown",
                );
                return (
                  <Card key={o.id} className="space-y-3 p-4 sm:p-5">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-serif text-headline-sm break-words">{o.label}</h3>
                      {decision?.chosenProposalId === o.proposalId && (
                        <Badge tone="confirmed">Your choice</Badge>
                      )}
                    </div>
                    {o.comparable ? (
                      <DecideForm
                        hidden={hidden}
                        proposalId={o.proposalId}
                        label={o.label}
                        idempotencyKey={randomUUID()}
                        warnings={warnings}
                      />
                    ) : (
                      <p className="text-body-md text-ink-muted">
                        This quote can&apos;t be chosen here.
                      </p>
                    )}
                  </Card>
                );
              })
            )}
          </section>

          <div className="space-y-2 border-t border-border-hairline pt-6">
            <ArchiveForm hidden={hidden} />
          </div>
        </>
      ) : (
        <p className="text-body-md text-ink-muted">
          You can view this. Ask the workspace owner to change it.
        </p>
      )}

      {cmp.history.length > 0 && (
        <section aria-labelledby="history-heading" className="space-y-2">
          <h2 id="history-heading" className="font-serif text-headline-sm">
            Earlier decisions
          </h2>
          <ul className="list-disc pl-5 text-body-md text-ink-muted">
            {cmp.history.map((h) => (
              <li key={h.id}>
                {shortDate(h.decidedAt.slice(0, 10))}: {nameOf(h.chosenProposalId)}
              </li>
            ))}
          </ul>
        </section>
      )}

      <CommentsSection
        workspaceId={access.wedding.id}
        role={access.membership.role}
        kind="comparison"
        subjectId={cmp.id}
      />
      <p>
        <Link href={`${base}/discover/compare`} className={link}>
          Back to comparisons
        </Link>
      </p>
    </div>
  );
}
