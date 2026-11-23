import Link from "next/link";
import { Card, CardTitle } from "@/components/ui/card";
import type { BudgetItem, ItemFigure } from "@/domain/budget/summary";
import {
  itemAmountLabel,
  itemBasisLabel,
  itemDriftNote,
  itemTrackingNote,
  type CountContext,
} from "./format";

const link = "font-semibold text-action-emphasis underline underline-offset-4";
const linkRow = `${link} inline-flex min-h-11 items-center`;

export type EventCost = {
  item: BudgetItem;
  figure: ItemFigure;
  categoryName: string;
  booked: boolean;
};

/**
 * The costs this event's guests set the price of, read from the budget (UX-10). Wording and numbers
 * come from the same helpers as the budget page, so the two never disagree, and the reply counts
 * follow the same sharing rule (ADR-031 D2). Read-only: costs are edited on the budget page.
 */
export function EventCostsCard({
  eventName,
  costs,
  ctx,
  budgetHref,
  canEdit,
}: {
  eventName: string;
  costs: readonly EventCost[];
  ctx: CountContext;
  budgetHref: string;
  canEdit: boolean;
}) {
  return (
    <Card
      as="section"
      aria-labelledby="event-budget-heading"
      className="space-y-3"
      data-testid="event-budget"
    >
      <CardTitle>
        <span id="event-budget-heading">Budget</span>
      </CardTitle>
      {costs.length === 0 ? (
        <p className="text-body-md text-ink-muted" data-testid="event-budget-empty">
          No cost is priced by this event&apos;s guests yet.
          {canEdit ? " Add a per-guest cost on the budget page and count this event's guests." : ""}
        </p>
      ) : (
        <ul className="divide-y divide-border-hairline" data-testid="event-budget-list">
          {costs.map(({ item, figure, categoryName, booked }) => {
            const tracking = itemTrackingNote(item, figure, ctx);
            const drift = itemDriftNote(item, figure, ctx);
            return (
              <li key={item.id} className="space-y-1 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                  <p className="text-body-lg break-words">{item.name}</p>
                  <p className="text-body-lg font-semibold">
                    {booked ? "Booked" : itemAmountLabel(item, figure, ctx.currency)}
                  </p>
                </div>
                <p className="text-body-sm text-ink-muted">{categoryName}</p>
                <p className="text-body-sm text-ink-muted">{itemBasisLabel(item, figure, ctx)}</p>
                {tracking && <p className="text-body-sm text-ink-muted">{tracking}</p>}
                {drift && <p className="text-body-sm text-ink-muted">{drift}</p>}
              </li>
            );
          })}
        </ul>
      )}
      <p>
        <Link href={budgetHref} className={linkRow}>
          Open the budget<span className="sr-only"> for {eventName}</span>
        </Link>
      </p>
    </Card>
  );
}
