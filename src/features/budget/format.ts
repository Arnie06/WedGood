import { formatMinor } from "@/domain/money/money";
import { estimateItem, type BudgetItem } from "@/domain/budget/summary";

/** The estimate for one cost as words. Unknown is never shown as zero. */
export function itemAmountLabel(item: BudgetItem, guestCount: number | null, currency: string) {
  const e = estimateItem(item, guestCount);
  if (e.state === "known") return formatMinor(e.amountMinor, currency);
  switch (e.reason) {
    case "no_amount":
      return "Not known yet";
    case "no_guest_count":
      return "Needs a guest count";
    case "no_quantity":
      return "Needs a quantity";
  }
}

/** How the estimate was reached. */
export function itemBasisLabel(item: BudgetItem, guestCount: number | null, currency: string) {
  if (item.amountMinor === null) return "No amount entered";
  const unit = formatMinor(item.amountMinor, currency);
  switch (item.costMode) {
    case "fixed":
      return "One amount";
    case "per_guest": {
      if (guestCount === null) {
        return `${unit} per guest; set a guest count in event settings to price this`;
      }
      const billed = Math.max(guestCount, item.minQty ?? 0);
      const min =
        item.minQty !== null && item.minQty > guestCount ? ` (minimum ${item.minQty} applies)` : "";
      return `${unit} × ${billed} guests${min}`;
    }
    case "quantity":
      return item.quantity === null
        ? `${unit} each; quantity not known yet`
        : `${unit} × ${item.quantity}`;
  }
}
