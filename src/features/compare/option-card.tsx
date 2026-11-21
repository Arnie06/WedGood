import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type { OptionEvaluation } from "@/domain/comparison/evaluate";
import { formatMinor } from "@/domain/money/money";
import { completenessLabel } from "@/features/quotes/format";
import { blockerText, fitLabel, scoreLabel } from "./format";

/** One option's figures. Known and unknown are kept visibly apart; nothing is zero-filled. */
export function OptionCard({
  evaluation: o,
  href,
  currency,
  guests,
  chosen,
  lowest,
}: {
  evaluation: OptionEvaluation;
  href: string;
  currency: string;
  guests: number;
  chosen: boolean;
  lowest: boolean;
}) {
  const n = o.normalized;
  const fit = fitLabel(o.fit, guests);
  const unknownLines =
    n?.lines.filter((l) => l.required && (l.state === "unknown" || l.state === "partial")) ?? [];
  return (
    <Card as="li" className="space-y-3 p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-serif text-headline-sm break-words">
          <Link href={href} className="underline-offset-4 hover:underline">
            {o.label}
          </Link>
        </h3>
        {chosen && <Badge tone="confirmed">Your choice</Badge>}
        {o.rank !== null && <Badge tone="pending">Ranked #{o.rank}</Badge>}
        {o.incompatible && <Badge tone="neutral">Doesn&apos;t fit</Badge>}
        {lowest && <Badge tone="neutral">Lowest known cost</Badge>}
      </div>

      {n ? (
        <div className="space-y-1">
          <p className="text-body-md">
            <span className="font-semibold">{formatMinor(n.requiredKnownMinor, currency)}</span> in
            required costs we know
          </p>
          <p className="text-body-sm text-ink-muted">{completenessLabel(n)}</p>
          {unknownLines.length > 0 && (
            <ul className="list-disc pl-5 text-body-sm text-ink-muted">
              {unknownLines.map((l) => (
                <li key={l.id}>
                  {l.description}: {l.state === "partial" ? "partly known" : "not known yet"}
                </li>
              ))}
            </ul>
          )}
          {n.requiredEstimatedMinor > 0 && (
            <p className="text-body-sm text-ink-muted">
              {formatMinor(n.requiredEstimatedMinor, currency)} of that is your own estimate, not a
              quoted price.
            </p>
          )}
          {n.optionalKnownMinor > 0 && (
            <p className="text-body-sm text-ink-muted">
              Optional extras, not included above: {formatMinor(n.optionalKnownMinor, currency)}
            </p>
          )}
        </div>
      ) : (
        <p className="text-body-md text-ink-muted">{blockerText("not_comparable")}</p>
      )}

      {fit && (
        <p className={o.incompatible ? "text-body-md font-semibold text-danger" : "text-body-md"}>
          {fit}
        </p>
      )}
      <p className="text-body-md">
        <span className="font-semibold">Your preference:</span> {scoreLabel(o)}
        {o.score.status === "scored" && o.score.lowCoverage && (
          <span className="text-ink-muted">
            . Few criteria rated, so don&apos;t read much into it.
          </span>
        )}
      </p>
      {o.rank === null && o.rankBlockers.length > 0 && (
        <ul className="space-y-1 text-body-sm text-ink-muted">
          {o.rankBlockers.map((b) => (
            <li key={b}>{blockerText(b)}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}
