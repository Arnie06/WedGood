import Link from "next/link";
import { Card, CardTitle } from "@/components/ui/card";
import { formatDateOnly, parseDateOnly } from "@/domain/dates/date-only";
import { blockExposure, totalExposure } from "@/domain/lodging/attrition";
import { formatMinor } from "@/domain/money/money";
import type { PossibleCost } from "@/server/lodging/queries";

const link = "font-semibold text-action-emphasis underline underline-offset-4";
const short = (iso: string) => formatDateOnly(parseDateOnly(iso), "en-US", { dateStyle: "medium" });

/**
 * Hotel attrition charges that might be owed (UX-17 lodging). Shown beside the forecast and never
 * added to it (owner decision 2026-11-23): a room block is not a commitment or an estimate until the
 * hotel bills it. Unknown figures stay unknown.
 */
export function PossibleCostsCard({
  rows,
  categories,
  currency,
  lodgingHref,
}: {
  rows: PossibleCost[];
  categories: ReadonlyMap<string, string>;
  currency: string;
  /** Null when the viewer can't open the Lodging page. */
  lodgingHref: string | null;
}) {
  if (rows.length === 0) return null;
  const money = (n: number) => formatMinor(n, currency);
  const figures = rows.map((r) => ({ r, e: blockExposure(r) }));
  const expected = totalExposure(
    figures.map((f) => f.e),
    "expectedMinor",
  );
  const worst = totalExposure(
    figures.map((f) => f.e),
    "worstMinor",
  );
  return (
    <section aria-labelledby="possible-costs" className="space-y-3">
      <h2 id="possible-costs" className="font-serif text-headline-sm">
        Possible costs, not in your forecast
      </h2>
      <Card className="space-y-3" data-testid="possible-costs">
        <CardTitle as="h3">Hotel room blocks</CardTitle>
        <p className="text-body-md">
          If guests book fewer rooms than your contract allows, the hotel may charge for the rest.
          These amounts are not added to your forecast.
        </p>
        <p className="text-body-md">
          <span className="font-semibold">Now: </span>
          {expected.complete
            ? money(expected.totalMinor)
            : `at least ${money(expected.totalMinor)}, some unknown`}
          <span className="text-ink-muted"> · </span>
          <span className="font-semibold">If no one books: </span>
          {worst.complete
            ? money(worst.totalMinor)
            : `at least ${money(worst.totalMinor)}, some unknown`}
        </p>
        <ul className="divide-y divide-border-hairline">
          {figures.map(({ r, e }) => (
            <li key={r.blockId} className="space-y-1 py-2 compact:py-1">
              <p className="text-body-md font-semibold break-words">
                {r.hotelName}
                {r.label ? ` · ${r.label}` : ""}
                {r.hotelArchived ? " (archived)" : ""}
              </p>
              <p className="text-body-md">
                {e.expectedMinor === null ? "Now: unknown" : `Now: ${money(e.expectedMinor)}`}
                {r.pickedUpAsOf ? ` (hotel report, ${short(r.pickedUpAsOf)})` : ""}
                {" · "}
                {e.worstMinor === null
                  ? "If no one books: unknown"
                  : `If no one books: ${money(e.worstMinor)}`}
              </p>
              <p className="text-body-sm text-ink-muted">
                {[
                  r.budgetCategoryId && categories.get(r.budgetCategoryId),
                  r.cutoffDate && `book by ${short(r.cutoffDate)}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </li>
          ))}
        </ul>
        {lodgingHref && (
          <p>
            <Link href={lodgingHref} className={`${link} inline-flex min-h-11 items-center`}>
              Update pickup reports in Lodging
            </Link>
          </p>
        )}
      </Card>
    </section>
  );
}
