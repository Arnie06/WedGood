import { daysBetween, type DateOnly } from "@/domain/dates/date-only";
import { assertMinorUnits } from "@/domain/money/money";

/**
 * Installment schedule reconciliation (docs/07-DOMAIN-RULES.md). A schedule is a plan for when
 * money is due; it is never proof of payment. Recorded payments are matched to it by running total
 * (oldest due date first), because payments are not tied to a single installment.
 */

export type Installment = {
  id: string;
  dueOn: DateOnly;
  amountMinor: number;
  label: string | null;
};

export type InstallmentStatus = "covered" | "partly_covered" | "overdue" | "upcoming";

export type InstallmentRow = Installment & {
  status: InstallmentStatus;
  /** Part of this installment that net paid covers so far. */
  coveredMinor: number;
  /** Days until due; negative when past due. */
  daysUntilDue: number;
};

export type ScheduleSummary = {
  rows: InstallmentRow[];
  scheduledMinor: number;
  /** amount - scheduled. Positive: part of the amount has no due date yet. */
  unscheduledMinor: number;
  state: "none" | "matches" | "under" | "over";
  /** Sum of installments that are past due and not fully covered, counting only the uncovered part. */
  overdueMinor: number;
};

export function reconcileSchedule(
  amountMinor: number,
  installments: readonly Installment[],
  netPaidMinor: number,
  today: DateOnly,
): ScheduleSummary {
  assertMinorUnits(amountMinor);
  assertMinorUnits(netPaidMinor);
  const sorted = [...installments].sort(
    (a, b) => a.dueOn.localeCompare(b.dueOn) || a.id.localeCompare(b.id),
  );
  let remaining = Math.max(netPaidMinor, 0);
  let scheduled = 0;
  let overdue = 0;
  const rows = sorted.map((i): InstallmentRow => {
    assertMinorUnits(i.amountMinor);
    if (i.amountMinor <= 0) throw new RangeError(`Installment ${i.id} must be positive`);
    scheduled += i.amountMinor;
    const covered = Math.min(remaining, i.amountMinor);
    remaining -= covered;
    const daysUntilDue = daysBetween(today, i.dueOn);
    const status: InstallmentStatus =
      covered >= i.amountMinor
        ? "covered"
        : daysUntilDue < 0
          ? "overdue"
          : covered > 0
            ? "partly_covered"
            : "upcoming";
    if (status === "overdue") overdue += i.amountMinor - covered;
    return { ...i, status, coveredMinor: covered, daysUntilDue };
  });
  const state =
    rows.length === 0
      ? "none"
      : scheduled === amountMinor
        ? "matches"
        : scheduled < amountMinor
          ? "under"
          : "over";
  return {
    rows,
    scheduledMinor: scheduled,
    unscheduledMinor: amountMinor - scheduled,
    state,
    overdueMinor: overdue,
  };
}

/** Plain-language flag for a schedule that doesn't add up; null when it's fine. */
export function scheduleWarning(
  state: ScheduleSummary["state"],
  differenceMinor: number,
  money: (n: number) => string,
): string | null {
  switch (state) {
    case "none":
      return "No payment schedule yet. Add due dates so nothing is missed.";
    case "under":
      return `The schedule covers ${money(differenceMinor)} less than the amount. Part of it has no due date.`;
    case "over":
      return `The schedule adds up to ${money(-differenceMinor)} more than the amount.`;
    case "matches":
      return null;
  }
}
