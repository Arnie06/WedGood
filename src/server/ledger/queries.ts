import "server-only";
import { isDateOnly, type DateOnly } from "@/domain/dates/date-only";
import { createUserClient } from "@/server/supabase/server";

export type CommitmentRecord = {
  id: string;
  candidateId: string | null;
  proposalId: string | null;
  title: string;
  amountMinor: number;
  currency: string;
  status: "active" | "superseded" | "cancelled";
  signedOn: string | null;
  supersedesId: string | null;
  version: number;
  createdAt: string;
};
export type AllocationRecord = {
  commitmentId: string;
  budgetItemId: string;
  amountMinor: number;
  active: boolean;
};
export type InstallmentRecord = {
  id: string;
  commitmentId: string;
  dueOn: DateOnly;
  amountMinor: number;
  label: string | null;
};
export type PaymentRow = {
  id: string;
  commitmentId: string | null;
  budgetItemId: string | null;
  kind: "charge" | "refund";
  amountMinor: number;
  paidOn: string;
  method: string | null;
  note: string | null;
  externalRef: string | null;
  voided: boolean;
  voidReason: string | null;
  createdAt: string;
};
export type LedgerData = {
  commitments: CommitmentRecord[];
  allocations: AllocationRecord[];
  installments: InstallmentRecord[];
  payments: PaymentRow[];
};

/** RLS limits every read to workspaces the caller belongs to; pages also call requireWorkspace. */
export async function loadLedger(workspaceId: string): Promise<LedgerData> {
  const supabase = await createUserClient();
  const [commitments, allocations, installments, payments] = await Promise.all([
    supabase
      .from("commitments")
      .select(
        "id, candidate_id, proposal_id, title, amount_minor, currency, status, signed_on, supersedes_id, version, created_at",
      )
      .eq("wedding_id", workspaceId)
      .order("created_at")
      .limit(500),
    supabase
      .from("commitment_allocations")
      .select("commitment_id, budget_item_id, amount_minor, active")
      .eq("wedding_id", workspaceId)
      .limit(2000),
    supabase
      .from("payment_installments")
      .select("id, commitment_id, due_on, amount_minor, label")
      .eq("wedding_id", workspaceId)
      .order("due_on")
      .limit(2000),
    supabase
      .from("payments")
      .select(
        "id, commitment_id, budget_item_id, kind, amount_minor, paid_on, method_label, note, external_ref, voided_at, void_reason, created_at",
      )
      .eq("wedding_id", workspaceId)
      .order("paid_on")
      .order("created_at")
      .limit(5000),
  ]);
  if (commitments.error || allocations.error || installments.error || payments.error) {
    throw new Error("Could not load bookings and payments");
  }
  return {
    commitments: commitments.data.map((c) => ({
      id: c.id,
      candidateId: c.candidate_id,
      proposalId: c.proposal_id,
      title: c.title,
      amountMinor: c.amount_minor,
      currency: c.currency,
      status:
        c.status === "superseded"
          ? "superseded"
          : c.status === "cancelled"
            ? "cancelled"
            : "active",
      signedOn: c.signed_on,
      supersedesId: c.supersedes_id,
      version: c.version,
      createdAt: c.created_at,
    })),
    allocations: allocations.data.map((a) => ({
      commitmentId: a.commitment_id,
      budgetItemId: a.budget_item_id,
      amountMinor: a.amount_minor,
      active: a.active,
    })),
    installments: installments.data
      .filter((i) => isDateOnly(i.due_on))
      .map((i) => ({
        id: i.id,
        commitmentId: i.commitment_id,
        dueOn: i.due_on as DateOnly,
        amountMinor: i.amount_minor,
        label: i.label,
      })),
    payments: payments.data.map((p) => ({
      id: p.id,
      commitmentId: p.commitment_id,
      budgetItemId: p.budget_item_id,
      kind: p.kind === "refund" ? "refund" : "charge",
      amountMinor: p.amount_minor,
      paidOn: p.paid_on,
      method: p.method_label,
      note: p.note,
      externalRef: p.external_ref,
      voided: p.voided_at !== null,
      voidReason: p.void_reason,
      createdAt: p.created_at,
    })),
  };
}
