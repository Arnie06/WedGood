import "server-only";
import { summarizeBudget, type BudgetSummary, type ItemCounts } from "@/domain/budget/summary";
import { loadBudget, loadItemCounts, type BudgetData } from "@/server/budget/queries";
import { loadLedger, type LedgerData } from "@/server/ledger/queries";

export type BudgetInputs = {
  budget: BudgetData;
  ledger: LedgerData;
  eventCounts: ReadonlyMap<string, ItemCounts>;
};

/** What the forecast is built from. RLS limits every read to members; callers still guard the page. */
export async function loadBudgetInputs(workspaceId: string): Promise<BudgetInputs> {
  const [budget, ledger] = await Promise.all([loadBudget(workspaceId), loadLedger(workspaceId)]);
  const eventCounts = await loadItemCounts(workspaceId, budget.items);
  return { budget, ledger, eventCounts };
}

/**
 * The one place the budget page and the event page turn stored rows into a forecast, so a cost reads
 * the same on both. Active bookings only; voided payments are dropped.
 */
export function summarizeBudgetInputs(
  inputs: BudgetInputs,
  settings: { targetBudgetMinor: number | null; targetGuestCount: number | null },
): BudgetSummary {
  const { budget, ledger, eventCounts } = inputs;
  return summarizeBudget({
    targetMinor: settings.targetBudgetMinor,
    reserveBp: budget.reserveBp,
    guestCount: settings.targetGuestCount,
    eventCounts,
    categories: budget.categories,
    items: budget.items,
    commitments: ledger.commitments
      .filter((c) => c.status === "active")
      .map((c) => ({ id: c.id, amountMinor: c.amountMinor, status: c.status })),
    allocations: ledger.allocations
      .filter((a) => a.active)
      .map((a) => ({
        commitmentId: a.commitmentId,
        budgetItemId: a.budgetItemId,
        amountMinor: a.amountMinor,
      })),
    payments: ledger.payments
      .filter((p) => !p.voided)
      .map((p) => ({
        id: p.id,
        commitmentId: p.commitmentId,
        budgetItemId: p.budgetItemId,
        kind: p.kind,
        amountMinor: p.amountMinor,
        invoiceId: p.invoiceId,
      })),
    invoices: ledger.invoices.map((i) => ({
      id: i.id,
      commitmentId: i.commitmentId,
      amountMinor: i.amountMinor,
      voided: i.voided,
    })),
  });
}
