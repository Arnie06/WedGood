import type { DateOnly } from "@/domain/dates/date-only";
import { bookingLadder, invoiceRows, type InvoiceRow, type Ladder } from "@/domain/ledger/invoices";
import { reconcileSchedule, type ScheduleSummary } from "@/domain/ledger/schedule";
import type {
  AllocationRecord,
  CommitmentRecord,
  InstallmentRecord,
  LedgerData,
  PaymentRow,
} from "@/server/ledger/queries";

export type CommitmentView = {
  commitment: CommitmentRecord;
  allocations: AllocationRecord[];
  payments: PaymentRow[];
  netPaidMinor: number;
  outstandingMinor: number;
  overpaidMinor: number;
  schedule: ScheduleSummary;
  installments: InstallmentRecord[];
  /** This booking's invoices, oldest first, with what each has been paid. Voided ones included. */
  invoices: InvoiceRow[];
  ladder: Ladder;
};

/** Net paid counts recorded charges minus refunds, ignoring payments marked as mistakes. */
export function netPaid(payments: readonly PaymentRow[]): number {
  return payments
    .filter((p) => !p.voided)
    .reduce((sum, p) => sum + (p.kind === "charge" ? p.amountMinor : -p.amountMinor), 0);
}

export function viewCommitment(
  ledger: LedgerData,
  commitment: CommitmentRecord,
  today: DateOnly,
): CommitmentView {
  const payments = ledger.payments.filter((p) => p.commitmentId === commitment.id);
  const installments = ledger.installments.filter((i) => i.commitmentId === commitment.id);
  const net = netPaid(payments);
  const invoices = invoiceRows(
    ledger.invoices.filter((i) => i.commitmentId === commitment.id),
    payments,
    today,
  );
  return {
    commitment,
    allocations: ledger.allocations.filter((a) => a.commitmentId === commitment.id),
    payments,
    netPaidMinor: net,
    outstandingMinor: Math.max(commitment.amountMinor - net, 0),
    overpaidMinor: Math.max(net - commitment.amountMinor, 0),
    schedule: reconcileSchedule(commitment.amountMinor, installments, net, today),
    installments,
    invoices,
    ladder: bookingLadder(commitment.amountMinor, net, invoices),
  };
}

/** Planned costs a booking could cover: not covered by another booking, no payments of their own. */
export function freeCosts(
  items: readonly { id: string; name: string; categoryId: string }[],
  categories: readonly { id: string; name: string }[],
  ledger: LedgerData,
  ignoreCommitment?: string,
): { id: string; label: string }[] {
  const covered = new Set(
    ledger.allocations
      .filter((a) => a.active && a.commitmentId !== ignoreCommitment)
      .map((a) => a.budgetItemId),
  );
  const paid = new Set(
    ledger.payments.filter((p) => !p.voided && p.budgetItemId !== null).map((p) => p.budgetItemId),
  );
  const cat = new Map(categories.map((c) => [c.id, c.name]));
  return items
    .filter((i) => !covered.has(i.id) && !paid.has(i.id))
    .map((i) => ({ id: i.id, label: `${cat.get(i.categoryId) ?? "Other"} · ${i.name}` }));
}

/** Unbooked costs a standalone payment could be recorded against (no booking covers them). */
export function payableCosts(
  items: readonly { id: string; name: string; categoryId: string }[],
  categories: readonly { id: string; name: string }[],
  ledger: LedgerData,
): { id: string; label: string }[] {
  const covered = new Set(ledger.allocations.filter((a) => a.active).map((a) => a.budgetItemId));
  const cat = new Map(categories.map((c) => [c.id, c.name]));
  return items
    .filter((i) => !covered.has(i.id))
    .map((i) => ({ id: i.id, label: `${cat.get(i.categoryId) ?? "Other"} · ${i.name}` }));
}
