import { assertMinorUnits } from "@/domain/money/money";

/**
 * Commitment balances per docs/07-DOMAIN-RULES.md "Money definitions".
 * Scope: payments recorded against commitments. Forecasts, estimates and
 * standalone expenses belong to the budget model (R1-06).
 */

export type CommitmentStatus = "active" | "superseded" | "cancelled";

export type Commitment = {
  id: string;
  amountMinor: number;
  status: CommitmentStatus;
};

export type PaymentRecord = {
  id: string;
  commitmentId: string;
  kind: "charge" | "refund";
  amountMinor: number;
};

export type CommitmentSummary = {
  committedMinor: number;
  netPaidMinor: number;
  outstandingMinor: number;
  overpaidMinor: number;
};

export function summarizeCommitments(
  commitments: readonly Commitment[],
  payments: readonly PaymentRecord[],
): CommitmentSummary {
  const netPaidByCommitment = new Map<string, number>();
  for (const payment of payments) {
    assertMinorUnits(payment.amountMinor);
    if (payment.amountMinor <= 0) {
      throw new RangeError(`Payment ${payment.id} must have a positive amount`);
    }
    const signed = payment.kind === "charge" ? payment.amountMinor : -payment.amountMinor;
    netPaidByCommitment.set(
      payment.commitmentId,
      (netPaidByCommitment.get(payment.commitmentId) ?? 0) + signed,
    );
  }

  const summary: CommitmentSummary = {
    committedMinor: 0,
    netPaidMinor: 0,
    outstandingMinor: 0,
    overpaidMinor: 0,
  };

  for (const commitment of commitments) {
    assertMinorUnits(commitment.amountMinor);
    const netPaid = netPaidByCommitment.get(commitment.id) ?? 0;
    if (netPaid < 0) {
      throw new RangeError(`Refunds exceed payments for commitment ${commitment.id}`);
    }
    if (commitment.status !== "active") continue;
    summary.committedMinor += commitment.amountMinor;
    summary.netPaidMinor += netPaid;
    summary.outstandingMinor += Math.max(commitment.amountMinor - netPaid, 0);
    summary.overpaidMinor += Math.max(netPaid - commitment.amountMinor, 0);
  }

  return summary;
}
