import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { formatMinor } from "@/domain/money/money";
import { normalizeProposal } from "@/domain/proposals/normalize";
import type { ProposalRecord } from "@/server/proposals/queries";
import { completenessLabel, formatReceived } from "./format";

/** One card per quote with the known subtotal and an honest completeness line. */
export function QuoteList({
  quotes,
  base,
  candidateId,
  guestCount,
}: {
  quotes: readonly ProposalRecord[];
  base: string;
  candidateId: string;
  guestCount: number | null;
}) {
  return (
    <ul className="space-y-3">
      {quotes.map((q) => {
        const n = normalizeProposal(q.lines, guestCount);
        const meta = formatReceived(q.validUntil, q.receivedOn);
        return (
          <Card as="li" key={q.id} className="space-y-1 p-4 sm:p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-serif text-headline-sm break-words">
                <Link
                  href={`${base}/discover/${candidateId}/quotes/${q.id}`}
                  className="underline-offset-4 hover:underline"
                >
                  {q.title}
                </Link>
              </h3>
              {q.status === "declined" && <Badge tone="neutral">Passed</Badge>}
            </div>
            {meta.length > 0 && <p className="text-body-sm text-ink-muted">{meta.join(" · ")}</p>}
            <p className="text-body-md">
              {q.lines.length === 0
                ? "No costs entered yet"
                : `Known so far: ${formatMinor(n.requiredKnownMinor, q.currency)}`}
            </p>
            {q.lines.length > 0 && (
              <p className="text-body-sm text-ink-muted">{completenessLabel(n)}</p>
            )}
          </Card>
        );
      })}
    </ul>
  );
}
