import { assertMinorUnits } from "@/domain/money/money";
import { summarizeCommitments, type Commitment, type PaymentRecord } from "./commitments";

/**
 * Budget model per docs/07-DOMAIN-RULES.md "Money definitions". Pure: all figures are integer
 * minor units in the wedding's base currency. Nothing here moves money; payments are records.
 *
 * - Target is a ceiling the couple set; null means unset and every target-based figure is null.
 * - Allocated is the sum of category targets. It may differ from the target (a warning, not a gate).
 * - A budget item covered by an active commitment is counted once, as the commitment. It never
 *   adds a second forecast line.
 * - An uncommitted item counts its estimate, but never less than what was already paid for it.
 * - An unknown estimate adds nothing to the figures and sets `incomplete`. It is never read as zero.
 * - The reserve is a planned percentage of the known subtotal. It is not a payment or obligation.
 */

export type BudgetCostMode = "fixed" | "per_guest" | "quantity";

export type BudgetCategory = {
  id: string;
  name: string;
  allocationMinor: number | null;
};

export type BudgetItem = {
  id: string;
  categoryId: string;
  name: string;
  costMode: BudgetCostMode;
  /** The whole amount (fixed) or the price per guest / per unit. Null = not known yet. */
  amountMinor: number | null;
  /** Units for `quantity`. */
  quantity: number | null;
  /** Contractual minimum guests for `per_guest`. */
  minQty: number | null;
};

export type ItemAllocation = { commitmentId: string; budgetItemId: string; amountMinor: number };

/** A payment recorded against one commitment, or against one uncommitted item. Never both. */
export type BudgetPayment = {
  id: string;
  commitmentId: string | null;
  budgetItemId: string | null;
  kind: "charge" | "refund";
  amountMinor: number;
};

export type BudgetInput = {
  targetMinor: number | null;
  /** Percent of the known subtotal, in basis points (1000 = 10%). Null = no reserve. */
  reserveBp: number | null;
  /** The scenario's guest count. Null = unknown, so per-guest items are unknown. */
  guestCount: number | null;
  categories: readonly BudgetCategory[];
  items: readonly BudgetItem[];
  commitments?: readonly Commitment[];
  allocations?: readonly ItemAllocation[];
  payments?: readonly BudgetPayment[];
};

export type ItemEstimate =
  | { state: "known"; amountMinor: number; billedQuantity: number | null }
  | { state: "unknown"; reason: "no_amount" | "no_guest_count" | "no_quantity" };

export function estimateItem(item: BudgetItem, guestCount: number | null): ItemEstimate {
  if (item.amountMinor !== null) assertMinorUnits(item.amountMinor);
  if (item.amountMinor === null) return { state: "unknown", reason: "no_amount" };
  switch (item.costMode) {
    case "fixed":
      return { state: "known", amountMinor: item.amountMinor, billedQuantity: null };
    case "per_guest": {
      if (guestCount === null) return { state: "unknown", reason: "no_guest_count" };
      const billed = Math.max(guestCount, item.minQty ?? 0);
      return { state: "known", amountMinor: item.amountMinor * billed, billedQuantity: billed };
    }
    case "quantity":
      if (item.quantity === null) return { state: "unknown", reason: "no_quantity" };
      return {
        state: "known",
        amountMinor: item.amountMinor * item.quantity,
        billedQuantity: item.quantity,
      };
  }
}

/** Percent in basis points of an amount, rounded half up to a whole minor unit, without floats. */
export function percentOfBp(amountMinor: number, rateBp: number): number {
  assertMinorUnits(amountMinor);
  if (!Number.isInteger(rateBp) || rateBp < 0 || rateBp > 10_000) {
    throw new RangeError(`Rate must be 0 to 10000 basis points, received ${rateBp}`);
  }
  const product = BigInt(amountMinor) * BigInt(rateBp);
  return Number((product + 5_000n) / 10_000n);
}

export type CategoryRow = {
  id: string;
  name: string;
  allocationMinor: number | null;
  committedMinor: number;
  /** Known estimates of uncommitted items, raised to anything already paid. */
  expectedMinor: number;
  /** committed + expected: the known part only when `unknownItemCount` > 0. */
  forecastMinor: number;
  unknownItemCount: number;
  /** How far the known forecast is over the category target; 0 when under or no target. */
  overAllocationMinor: number;
};

export type BudgetSummary = {
  targetMinor: number | null;
  allocatedMinor: number;
  /** target - allocated; null without a target. Negative means more is allocated than the target. */
  unallocatedMinor: number | null;
  allocationExceedsTarget: boolean;
  committedMinor: number;
  netPaidMinor: number;
  outstandingMinor: number;
  overpaidMinor: number;
  /** Uncommitted items' expected costs (known part). */
  uncommittedMinor: number;
  /** committed + uncommitted, before the reserve. */
  subtotalMinor: number;
  reserveBp: number | null;
  reserveMinor: number;
  /** subtotal + reserve. A lower bound when `incomplete`. */
  forecastMinor: number;
  incomplete: boolean;
  unknownItemCount: number;
  /** target - committed - net paid on costs without a commitment. Null without a target. */
  remainingUncommittedMinor: number | null;
  /** target - forecast. Null without a target. Negative means the forecast is over the target. */
  headroomMinor: number | null;
  categories: CategoryRow[];
};

export function summarizeBudget(input: BudgetInput): BudgetSummary {
  const commitments = input.commitments ?? [];
  const allocations = input.allocations ?? [];
  const payments = input.payments ?? [];
  if (input.targetMinor !== null) assertMinorUnits(input.targetMinor);

  const categoryIds = new Set(input.categories.map((c) => c.id));
  const itemsById = new Map(input.items.map((i) => [i.id, i]));
  for (const item of input.items) {
    if (!categoryIds.has(item.categoryId)) {
      throw new RangeError(`Item ${item.id} refers to an unknown category`);
    }
  }

  const activeCommitment = new Set(
    commitments.filter((c) => c.status === "active").map((c) => c.id),
  );
  const commitmentPayments = payments.filter((p) => p.commitmentId !== null);
  const money = summarizeCommitments(
    commitments,
    commitmentPayments.map((p) => {
      if (p.budgetItemId !== null) {
        throw new RangeError(`Payment ${p.id} must target a commitment or an item, not both`);
      }
      return {
        id: p.id,
        commitmentId: p.commitmentId as string,
        kind: p.kind,
        amountMinor: p.amountMinor,
      } satisfies PaymentRecord;
    }),
  );

  // Items that an active commitment covers are counted as the commitment, once.
  const coveredAllocation = new Map<string, number>();
  for (const a of allocations) {
    assertMinorUnits(a.amountMinor);
    if (!activeCommitment.has(a.commitmentId)) continue;
    if (!itemsById.has(a.budgetItemId)) {
      throw new RangeError(`Allocation refers to an unknown item ${a.budgetItemId}`);
    }
    coveredAllocation.set(
      a.budgetItemId,
      (coveredAllocation.get(a.budgetItemId) ?? 0) + a.amountMinor,
    );
  }

  const itemPaid = new Map<string, number>();
  for (const p of payments) {
    if (p.budgetItemId === null) continue;
    if (p.commitmentId !== null) {
      throw new RangeError(`Payment ${p.id} must target a commitment or an item, not both`);
    }
    assertMinorUnits(p.amountMinor);
    if (p.amountMinor <= 0) throw new RangeError(`Payment ${p.id} must have a positive amount`);
    if (!itemsById.has(p.budgetItemId)) {
      throw new RangeError(`Payment ${p.id} refers to an unknown item`);
    }
    if (coveredAllocation.has(p.budgetItemId)) {
      throw new RangeError(`Payment ${p.id} is on an item that a commitment already covers`);
    }
    itemPaid.set(
      p.budgetItemId,
      (itemPaid.get(p.budgetItemId) ?? 0) + (p.kind === "charge" ? p.amountMinor : -p.amountMinor),
    );
  }

  const rows = new Map<string, CategoryRow>(
    input.categories.map((c) => [
      c.id,
      {
        id: c.id,
        name: c.name,
        allocationMinor: c.allocationMinor,
        committedMinor: 0,
        expectedMinor: 0,
        forecastMinor: 0,
        unknownItemCount: 0,
        overAllocationMinor: 0,
      },
    ]),
  );

  let uncommitted = 0;
  let standalonePaid = 0;
  let unknownItemCount = 0;
  for (const item of input.items) {
    const row = rows.get(item.categoryId) as CategoryRow;
    const covered = coveredAllocation.get(item.id);
    if (covered !== undefined) {
      row.committedMinor += covered;
      continue;
    }
    const paid = itemPaid.get(item.id) ?? 0;
    if (paid < 0) throw new RangeError(`Refunds exceed payments for item ${item.id}`);
    standalonePaid += paid;
    const estimate = estimateItem(item, input.guestCount);
    if (estimate.state === "unknown") {
      unknownItemCount += 1;
      row.unknownItemCount += 1;
    }
    const expected = Math.max(estimate.state === "known" ? estimate.amountMinor : 0, paid);
    row.expectedMinor += expected;
    uncommitted += expected;
  }

  let allocated = 0;
  for (const row of rows.values()) {
    row.forecastMinor = row.committedMinor + row.expectedMinor;
    if (row.allocationMinor !== null) {
      allocated += row.allocationMinor;
      row.overAllocationMinor = Math.max(row.forecastMinor - row.allocationMinor, 0);
    }
  }

  const subtotal = money.committedMinor + uncommitted;
  const reserve = input.reserveBp === null ? 0 : percentOfBp(subtotal, input.reserveBp);
  const forecast = subtotal + reserve;
  const target = input.targetMinor;

  return {
    targetMinor: target,
    allocatedMinor: allocated,
    unallocatedMinor: target === null ? null : target - allocated,
    allocationExceedsTarget: target !== null && allocated > target,
    committedMinor: money.committedMinor,
    netPaidMinor: money.netPaidMinor + standalonePaid,
    outstandingMinor: money.outstandingMinor,
    overpaidMinor: money.overpaidMinor,
    uncommittedMinor: uncommitted,
    subtotalMinor: subtotal,
    reserveBp: input.reserveBp,
    reserveMinor: reserve,
    forecastMinor: forecast,
    incomplete: unknownItemCount > 0,
    unknownItemCount,
    remainingUncommittedMinor:
      target === null ? null : target - money.committedMinor - standalonePaid,
    headroomMinor: target === null ? null : target - forecast,
    categories: input.categories.map((c) => rows.get(c.id) as CategoryRow),
  };
}
