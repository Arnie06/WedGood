import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardTitle } from "@/components/ui/card";
import { attentionSummary } from "@/domain/attention/attention";
import { AttentionList } from "@/features/attention/attention-list";
import { requireWorkspace } from "@/server/auth/workspace-guard";
import { loadAttention, loadAttentionHistory } from "@/server/attention/queries";

export const metadata: Metadata = { title: "Needs attention" };

const link = "font-semibold text-action-emphasis underline underline-offset-4";

export default async function AttentionPage({ params }: { params: Promise<{ w: string }> }) {
  const access = await requireWorkspace((await params).w);
  const wid = access.wedding.id;
  const base = `/app/${wid}`;
  const { visible, dismissed, canAct } = await loadAttention(access, access.wedding.timezone);
  const history = await loadAttentionHistory(
    access,
    [...visible, ...dismissed],
    access.wedding.timezone,
  );

  return (
    <div className="max-w-3xl space-y-6" data-testid="attention-page">
      <header className="space-y-2">
        <p className="text-body-md">
          <Link href={base} className={`${link} inline-flex min-h-11 items-center`}>
            Home
          </Link>
        </p>
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">Needs attention</h1>
        <p className="text-body-lg text-ink-muted">
          {attentionSummary(visible.length)} Each item links to where you can sort it out, and
          Details shows what it affects and what has happened so far. Nothing here changes your
          wedding by itself.
        </p>
      </header>

      <Card as="section" aria-labelledby="attention-open">
        <CardTitle>
          <span id="attention-open">To look at</span>
        </CardTitle>
        <div className="mt-3">
          <AttentionList
            items={visible}
            base={base}
            workspaceId={wid}
            canAct={canAct}
            history={history}
          />
        </div>
      </Card>

      {canAct && (
        <Card as="section" aria-labelledby="attention-hidden" className="space-y-2">
          <CardTitle>
            <span id="attention-hidden">Hidden</span>
          </CardTitle>
          <p className="text-body-md text-ink-muted">
            You dismissed these. An item comes back by itself if it changes, for example when the
            number of guests moves.
          </p>
          <AttentionList
            items={dismissed}
            base={base}
            workspaceId={wid}
            canAct={canAct}
            mode="dismissed"
            empty="Nothing is hidden."
            testId="attention-hidden-list"
            history={history}
          />
        </Card>
      )}

      <Card as="section" aria-labelledby="attention-how" className="space-y-2">
        <CardTitle>
          <span id="attention-how">What we watch</span>
        </CardTitle>
        <ul className="list-disc space-y-1 pl-5 text-body-md text-ink-muted">
          <li>More guests than the room holds.</li>
          <li>More guests attending than the caterer was told.</li>
          <li>Attending guests without a meal after the reply date.</li>
          <li>Attending guests without a seat on a seating plan you finalized.</li>
          <li>Seats released after you finalized the seating plan.</li>
          <li>A booked venue no event uses, or a booked vendor who works at no event.</li>
          <li>An invoice past due or due within a week.</li>
        </ul>
        {!canAct && (
          <p className="text-body-sm text-ink-muted">
            Items built from guest replies are shown to the owner and partners only.
          </p>
        )}
      </Card>
    </div>
  );
}
