import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card } from "@/components/ui/card";
import { formatMinor } from "@/domain/money/money";
import { normalizeProposal } from "@/domain/proposals/normalize";
import { SetupForm } from "@/features/compare/setup-form";
import { completenessLabel } from "@/features/quotes/format";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadCandidates } from "@/server/candidates/queries";
import { loadLiveCounts } from "@/server/comparisons/live-count";
import { loadComparableProposals } from "@/server/proposals/queries";
import { loadWeddingSettings } from "@/server/workspace/queries";

export const metadata: Metadata = { title: "New comparison" };

const link = "font-semibold text-action-emphasis underline underline-offset-4";

export default async function NewComparisonPage({ params }: { params: Promise<{ w: string }> }) {
  const access = await requireWorkspace((await params).w);
  if (!hasCapability(access, "vendors.manage")) notFound();
  const base = `/app/${access.wedding.id}`;
  const [settings, proposals, candidates, live] = await Promise.all([
    loadWeddingSettings(access.wedding.id),
    loadComparableProposals(access.wedding.id),
    loadCandidates(access.wedding.id),
    loadLiveCounts(access),
  ]);
  const names = new Map(candidates.map((c) => [c.id, c.name]));
  const choices = proposals
    .filter((p) => names.has(p.candidateId) && p.currency === settings.baseCurrency)
    .map((p) => {
      const n = normalizeProposal(p.lines, settings.targetGuestCount);
      return {
        id: p.id,
        candidateName: names.get(p.candidateId) ?? "",
        title: p.title,
        summary:
          p.lines.length === 0
            ? "No costs entered yet"
            : `${formatMinor(n.requiredKnownMinor, p.currency)} known. ${completenessLabel(n)}`,
      };
    });
  return (
    <div className="max-w-xl space-y-6">
      <h1 className="font-serif text-headline-mobile md:text-headline-lg">New comparison</h1>
      {choices.length < 2 ? (
        <Card>
          <p className="text-body-md text-ink-muted">
            You need at least two open quotes to compare. Add a quote on a venue or vendor page, or
            reopen one you passed on.{" "}
            <Link href={`${base}/discover`} className={link}>
              Go to venues &amp; vendors
            </Link>
          </p>
        </Card>
      ) : (
        <SetupForm
          workspaceId={access.wedding.id}
          idempotencyKey={randomUUID()}
          defaultGuests={settings.targetGuestCount}
          countChoices={live.events}
          choices={choices}
        />
      )}
      <p>
        <Link href={`${base}/discover/compare`} className={link}>
          Back to comparisons
        </Link>
      </p>
    </div>
  );
}
