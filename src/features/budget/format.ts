import { formatMinor } from "@/domain/money/money";
import {
  isReplyBased,
  type BudgetItem,
  type CountSource,
  type ItemFigure,
} from "@/domain/budget/summary";

/** What the reader may be told about a reply-based count (ADR-031 D2). */
export type CountContext = {
  guestTarget: number | null;
  currency: string;
  /** Event names by id, for "Reception". */
  eventNames: ReadonlyMap<string, string>;
  /** False for collaborators while the owner has not shared guest totals. */
  showCounts: boolean;
};

const guests = (n: number) => `${n} ${n === 1 ? "guest" : "guests"}`;

function eventName(item: BudgetItem, ctx: CountContext): string {
  return (item.countEventId && ctx.eventNames.get(item.countEventId)) || "the event";
}

/** The estimate for one cost as words. Unknown is never shown as zero. */
export function itemAmountLabel(item: BudgetItem, figure: ItemFigure, currency: string) {
  const e = figure.estimate;
  if (e.state === "known") return formatMinor(e.amountMinor, currency);
  switch (e.reason) {
    case "no_amount":
      return "Not known yet";
    case "no_guest_count":
      return isReplyBased(item.countSource) ? "No one invited yet" : "Needs a guest count";
    case "no_quantity":
      return "Needs a quantity";
  }
}

const SOURCE_NOTE: Record<CountSource, string> = {
  event_plan: "planning number",
  event_yes: "attending",
  guest_target: "guest target",
  typed: "typed",
};

/** How the estimate was reached. Reply-based arithmetic is only spelled out for those who may see counts. */
export function itemBasisLabel(item: BudgetItem, figure: ItemFigure, ctx: CountContext) {
  if (item.amountMinor === null) return "No amount entered";
  const unit = formatMinor(item.amountMinor, ctx.currency);
  switch (item.costMode) {
    case "fixed":
      return "One amount";
    case "per_guest": {
      const source = item.countSource ?? "guest_target";
      if (isReplyBased(source) && !ctx.showCounts) {
        return figure.planCount === null
          ? `${unit} per guest, based on replies to ${eventName(item, ctx)}`
          : `${unit} per guest, planned for ${guests(figure.planCount)} and tracked against replies to ${eventName(item, ctx)}`;
      }
      const count = figure.count;
      if (count === null) {
        switch (source) {
          case "guest_target":
            return `${unit} per guest; set a guest count in event settings to price this`;
          case "typed":
            return `${unit} per guest; type how many guests to price this`;
          default:
            return `${unit} per guest; nobody is invited to ${eventName(item, ctx)} yet`;
        }
      }
      const billed = Math.max(count, item.minQty ?? 0);
      const min =
        item.minQty !== null && item.minQty > count ? ` (minimum ${item.minQty} applies)` : "";
      // While invitations are still going out the cost may be priced by the plan, not by replies.
      const onPlan =
        source === "event_plan" &&
        figure.planCount !== null &&
        !figure.final &&
        count === figure.planCount;
      const from = isReplyBased(source)
        ? ` · ${eventName(item, ctx)} ${onPlan ? "plan" : SOURCE_NOTE[source]}`
        : source === "typed"
          ? " · typed"
          : "";
      return `${unit} × ${guests(billed)}${min}${from}`;
    }
    case "quantity":
      return item.quantity === null
        ? `${unit} each; quantity not known yet`
        : `${unit} × ${item.quantity}`;
  }
}

const signed = (n: number, currency: string) =>
  `${n > 0 ? "+" : n < 0 ? "−" : ""}${formatMinor(Math.abs(n), currency)}`;

/**
 * The permanent plan next to where replies stand, for a reply-based cost. The plan is the event's
 * planned attendance and never goes away. The replies side is only for those who may see counts.
 */
export function itemTrackingNote(item: BudgetItem, figure: ItemFigure, ctx: CountContext) {
  if (item.costMode !== "per_guest" || !isReplyBased(item.countSource)) return null;
  const name = eventName(item, ctx);
  if (figure.planCount === null) {
    return `No plan yet. Set planned attendance on ${name} to plan this before anyone is invited.`;
  }
  const plan =
    `Plan: ${guests(figure.planCount)}` +
    (figure.planMinor === null ? "" : `, ${formatMinor(figure.planMinor, ctx.currency)}`);
  if (!ctx.showCounts) return `${plan}.`;
  if (figure.actualCount === null) return `${plan}. No one invited yet.`;
  const diff = figure.actualCount - figure.planCount;
  const where = figure.final ? "Replies" : "So far";
  if (diff === 0) return `${plan}. ${where}: right on plan.`;
  const money =
    figure.actualMinor !== null && figure.planMinor !== null
      ? ` (${signed(figure.actualMinor - figure.planMinor, ctx.currency)})`
      : "";
  return `${plan}. ${where}: ${guests(figure.actualCount)}, ${Math.abs(diff)} ${diff > 0 ? "above" : "below"} plan${money}.`;
}

/**
 * A booked reply-based cost keeps its booked amount. When replies have moved since, owner and partner
 * are told by how much; everyone else only learns that the booking is fixed.
 */
export function itemDriftNote(item: BudgetItem, figure: ItemFigure, ctx: CountContext) {
  if (figure.committedMinor === null || item.costMode !== "per_guest") return null;
  if (!isReplyBased(item.countSource)) return null;
  if (!ctx.showCounts) return "Booked amount is fixed; later replies don't change it.";
  if (
    figure.actualCount === null ||
    figure.actualMinor === null ||
    figure.actualMinor === figure.committedMinor
  ) {
    return null;
  }
  return (
    `Booked for ${formatMinor(figure.committedMinor, ctx.currency)}, which stays as booked. ` +
    `At today's ${eventName(item, ctx)} replies of ${guests(figure.actualCount)} ` +
    `it would be ${formatMinor(figure.actualMinor, ctx.currency)}.`
  );
}
