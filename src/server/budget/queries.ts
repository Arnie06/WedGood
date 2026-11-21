import "server-only";
import type { BudgetCategory, BudgetCostMode, BudgetItem } from "@/domain/budget/summary";
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
        "id, category_id, name, cost_mode, amount_minor, quantity, min_qty, notes, version, created_at",
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
      version: i.version,
    })),
    reserveBp: settings.data?.reserve_bp ?? null,
    settingsVersion: settings.data?.version ?? 0,
  };
}
