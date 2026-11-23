import "server-only";
import {
  isCountSource,
  isReplyBased,
  type BudgetCategory,
  type BudgetCostMode,
  type BudgetItem,
  type ItemCounts,
} from "@/domain/budget/summary";
import { createUserClient } from "@/server/supabase/server";

export type BudgetCategoryRecord = BudgetCategory & { version: number };
export type BudgetItemRecord = BudgetItem & { notes: string | null; version: number };
export type BudgetData = {
  categories: BudgetCategoryRecord[];
  items: BudgetItemRecord[];
  reserveBp: number | null;
  /** 0 when no settings row exists yet. */
  settingsVersion: number;
};

const MODES: readonly BudgetCostMode[] = ["fixed", "per_guest", "quantity"];

/** RLS limits every read to workspaces the caller belongs to; pages also call requireWorkspace. */
export async function loadBudget(workspaceId: string): Promise<BudgetData> {
  const supabase = await createUserClient();
  const [categories, items, settings] = await Promise.all([
    supabase
      .from("budget_categories")
      .select("id, name, allocation_minor, sort_order, version, created_at")
      .eq("wedding_id", workspaceId)
      .is("archived_at", null)
      .order("sort_order")
      .order("created_at"),
    supabase
      .from("budget_items")
      .select(
        "id, category_id, name, cost_mode, amount_minor, quantity, min_qty, notes, count_source, count_event_id, count_typed, version, created_at",
      )
      .eq("wedding_id", workspaceId)
      .is("archived_at", null)
      .order("created_at"),
    supabase
      .from("budget_settings")
      .select("reserve_bp, version")
      .eq("wedding_id", workspaceId)
      .maybeSingle(),
  ]);
  if (categories.error || items.error || settings.error)
    throw new Error("Could not load the budget");
  return {
    categories: categories.data.map((c) => ({
      id: c.id,
      name: c.name,
      allocationMinor: c.allocation_minor,
      version: c.version,
    })),
    items: items.data.map((i) => ({
      id: i.id,
      categoryId: i.category_id,
      name: i.name,
      costMode: MODES.find((m) => m === i.cost_mode) ?? "fixed",
      amountMinor: i.amount_minor,
      quantity: i.quantity,
      minQty: i.min_qty,
      notes: i.notes,
      countSource: isCountSource(i.count_source) ? i.count_source : "guest_target",
      countEventId: i.count_event_id,
      countTyped: i.count_typed,
      version: i.version,
    })),
    reserveBp: settings.data?.reserve_bp ?? null,
    settingsVersion: settings.data?.version ?? 0,
  };
}

/**
 * Plan, actual and priced count for each reply-based item, by item id. Any member may call this. The
 * plan (the event's planned attendance) is the couple's own expectation and every member gets it. The
 * actual count comes from replies, so the database returns it only to owner and partner, or to everyone
 * once guest totals are shared; the priced count is returned to all (ADR-031 D2). Null counts mean
 * nobody is invited and there is no plan, so the item is unknown rather than zero.
 */
export async function loadItemCounts(
  workspaceId: string,
  items: readonly BudgetItem[],
): Promise<ReadonlyMap<string, ItemCounts>> {
  if (!items.some((i) => isReplyBased(i.countSource))) return new Map();
  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc("budget_item_counts", { p_wedding: workspaceId });
  if (error) throw new Error("Could not load guest counts for the budget");
  // The generated types say number; the database returns null for "not known".
  return new Map(
    data.map((r) => [
      r.item_id,
      {
        count: (r.item_count as number | null) ?? null,
        plan: (r.plan_count as number | null) ?? null,
        actual: (r.actual_count as number | null) ?? null,
        final: r.invitations_final,
      },
    ]),
  );
}
