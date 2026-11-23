import { assertMinorUnits } from "@/domain/money/money";
import { invoiceRows, type InvoiceRecord } from "@/domain/ledger/invoices";
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
 * - A per-guest item counts what its `countSource` says (ADR-031 D1): an event's planning number,
 *   an event's attending count, the wedding's guest target, or a typed number. Reply-based counts
 *   are resolved by the database and passed in as `eventCounts`; they are never recomputed here.
 *   A missing count makes the item unknown. It is never read as zero.
 */

export type BudgetCostMode = "fixed" | "per_guest" | "quantity";

export const COUNT_SOURCES = ["event_plan", "event_yes", "guest_target", "typed"] as const;
export type CountSource = (typeof COUNT_SOURCES)[number];
export const isCountSource = (v: unknown): v is CountSource =>
  typeof v === "string" && (COUNT_SOURCES as readonly string[]).includes(v);
/** Sources that follow replies, so the number changes when guests answer. */
export const isReplyBased = (source: CountSource | undefined) =>
  source === "event_plan" || source === "event_yes";

export type BudgetCategory = {
  id: string;
  name: string;
  allocationMinor: number | null;
};

/**
 * What the database knows about a reply-based item's guests. `plan` is the event's planned attendance,
 * which replies never replace. `actual` comes from replies and is null for members who may not read
 * guest totals, and while nobody is invited. `count` is what the cost is priced by: the larger of plan
 * and actual until the event's invitations are complete, then the actual alone.
 */
export type ItemCounts = {
  count: number | null;
  plan: number | null;
  actual: number | null;
  final: boolean;
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
  /** What a `per_guest` item counts. Omitted = the wedding's guest target. */
  countSource?: CountSource;
  /** The event behind `event_plan` and `event_yes`. */
  countEventId?: string | null;
  /** The number behind `typed`. Null = not known yet. */
  countTyped?: number | null;
};

export type ItemAllocation = { commitmentId: string; budgetItemId: string; amountMinor: number };

/** A payment recorded against one commitment, or against one uncommitted item. Never both. */
export type BudgetPayment = {
  id: string;
  commitmentId: string | null;
  budgetItemId: string | null;
  kind: "charge" | "refund";
  amountMinor: number;
  /** The invoice a charge pays, when it names one (REL-09). */
  invoiceId?: string | null;
};

/** A vendor invoice on one booking. Not a commitment and not a payment (REL-09). */
export type BudgetInvoice = Pick<InvoiceRecord, "id" | "commitmentId" | "amountMinor" | "voided">;

export type BudgetInput = {
  targetMinor: number | null;
  /** Percent of the known subtotal, in basis points (1000 = 10%). Null = no reserve. */
  reserveBp: number | null;
  /** The wedding's guest target, for items counting `guest_target`. Null = unknown. */
  guestCount: number | null;
  /**
   * Resolved reply-based counts by item id (from `budget_item_counts`). Null or absent = no count
   * yet, so that item is unknown.
   */
  eventCounts?: ReadonlyMap<string, ItemCounts>;
  categories: readonly BudgetCategory[];
  items: readonly BudgetItem[];
  commitments?: readonly Commitment[];
  allocations?: readonly ItemAllocation[];
  payments?: readonly BudgetPayment[];
  /** Invoices on bookings. They never change the forecast; they only feed `invoicedUnpaidMinor`. */
  invoices?: readonly BudgetInvoice[];
};

export type ItemEstimate =
  | { state: "known"; amountMinor: number; billedQuantity: number | null }
  | { state: "unknown"; reason: "no_amount" | "no_guest_count" | "no_quantity" };

/** The number a per-guest item is priced by, or null when it is not known yet. */
export function resolveItemCount(
  item: BudgetItem,
  guestTarget: number | null,
  eventCounts?: ReadonlyMap<string, ItemCounts>,
): number | null {
  switch (item.countSource ?? "guest_target") {
    case "guest_target":
      return guestTarget;
    case "typed":
      return item.countTyped ?? null;
    case "event_plan":
    case "event_yes":
      return eventCounts?.get(item.id)?.count ?? null;
  }
}

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

/** One cost as the forecast sees it, so pages never recompute an estimate. */
export type ItemFigure = {
  itemId: string;
  /** The count a per-guest item was priced by; null for other modes or when not known. */
  count: number | null;
  estimate: ItemEstimate;
  /** The amount an active commitment covers, or null when the item is not booked. */
  committedMinor: number | null;
  /** The permanent plan behind a reply-based cost: planned guests and what they would cost. */
  planCount: number | null;
  planMinor: number | null;
  /** Where replies stand: guests so far and what they would cost. Null when the reader may not see counts. */
  actualCount: number | null;
  actualMinor: number | null;
  /** The event's invitations are complete, so the cost follows replies alone. */
  final: boolean;
};

const costFor = (item: BudgetItem, count: number | null): number | null => {
  if (count === null) return null;
  const e = estimateItem(item, count);
  return e.state === "known" ? e.amountMinor : null;
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
  /** What open invoices on active bookings still ask for, after the payments that name them. */
  invoicedUnpaidMinor: number;
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
  items: ItemFigure[];
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

  // Invoices are a request for money inside a contract, not more cost: they leave every other figure alone.
  const openInvoices = invoiceRows(
    (input.invoices ?? [])
      .filter((i) => activeCommitment.has(i.commitmentId))
      .map((i) => ({
        ...i,
        number: null,
        issuedOn: null,
        dueOn: null,
        note: null,
        voidReason: null,
      })),
    payments.map((p) => ({
      invoiceId: p.invoiceId ?? null,
      kind: p.kind,
      amountMinor: p.amountMinor,
      voided: false,
    })),
    "9999-12-31",
  );
  const invoicedUnpaid = openInvoices.reduce((n, r) => n + r.unpaidMinor, 0);

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
  const figures: ItemFigure[] = [];
  for (const item of input.items) {
    const row = rows.get(item.categoryId) as CategoryRow;
    const count =
      item.costMode === "per_guest"
        ? resolveItemCount(item, input.guestCount, input.eventCounts)
        : null;
    const estimate = estimateItem(item, count);
    const covered = coveredAllocation.get(item.id);
    const counts =
      item.costMode === "per_guest" && isReplyBased(item.countSource)
        ? input.eventCounts?.get(item.id)
        : undefined;
    figures.push({
      itemId: item.id,
      count,
      estimate,
      committedMinor: covered ?? null,
      planCount: counts?.plan ?? null,
      planMinor: costFor(item, counts?.plan ?? null),
      actualCount: counts?.actual ?? null,
      actualMinor: costFor(item, counts?.actual ?? null),
      final: counts?.final ?? false,
    });
    if (covered !== undefined) {
      row.committedMinor += covered;
      continue;
    }
    const paid = itemPaid.get(item.id) ?? 0;
    if (paid < 0) throw new RangeError(`Refunds exceed payments for item ${item.id}`);
    standalonePaid += paid;
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
    invoicedUnpaidMinor: invoicedUnpaid,
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
    items: figures,
  };
}
