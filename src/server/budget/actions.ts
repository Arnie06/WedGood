"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  parseCategoryInput,
  parseItemInput,
  parseReservePercent,
  SUGGESTED_CATEGORIES,
  type CategoryField,
  type ItemField,
} from "@/domain/budget/input";
import { ForbiddenError, requireCapability } from "@/server/auth/workspace-guard";
import { createUserClient } from "@/server/supabase/server";
import { loadWeddingSettings } from "@/server/workspace/queries";
import { friendlyBudgetError } from "./errors";

export type BudgetActionState =
  | { status: "idle" }
  | { status: "ok"; message: string }
  | {
      status: "error";
      message: string;
      fieldErrors: Partial<Record<CategoryField | ItemField | "reserve", string>>;
      values: Record<string, string>;
    };

const uuid = z.uuid();
const version = z.coerce.number().int().min(0);
const idemKey = z.string().min(8).max(128);

function fail(
  message: string,
  fieldErrors: Partial<Record<CategoryField | ItemField | "reserve", string>> = {},
  values: Record<string, string> = {},
): BudgetActionState {
  return { status: "error", message, fieldErrors, values };
}

async function authorize(workspaceId: string): Promise<BudgetActionState | null> {
  try {
    await requireCapability(workspaceId, "budget.manage");
    return null;
  } catch (e) {
    if (e instanceof ForbiddenError) return fail(friendlyBudgetError({ code: "42501" }));
    throw e;
  }
}

const refresh = (workspaceId: string) => revalidatePath(`/app/${workspaceId}`, "layout");

function readValues(form: FormData, fields: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = form.get(f);
    out[f] = typeof v === "string" ? v : "";
  }
  return out;
}

const CATEGORY_FIELDS = ["name", "allocation"] as const;
const ITEM_FIELDS = [
  "name",
  "category",
  "costMode",
  "amount",
  "quantity",
  "minQty",
  "notes",
] as const;

/** Optional arguments are only sent when set, so unknown stays null in the database. */
function itemArgs(v: {
  name: string;
  costMode: string;
  amountMinor: number | null;
  quantity: number | null;
  minQty: number | null;
  notes: string | null;
}) {
  return {
    p_name: v.name,
    p_cost_mode: v.costMode,
    ...(v.amountMinor !== null && { p_amount_minor: v.amountMinor }),
    ...(v.quantity !== null && { p_quantity: v.quantity }),
    ...(v.minQty !== null && { p_min_qty: v.minQty }),
    ...(v.notes !== null && { p_notes: v.notes }),
  };
}

// ---------------------------------------------------------------- categories

export async function createCategory(
  _: BudgetActionState,
  form: FormData,
): Promise<BudgetActionState> {
  const values = readValues(form, CATEGORY_FIELDS);
  const ids = z.object({ workspaceId: uuid, key: idemKey }).safeParse({
    workspaceId: form.get("workspaceId"),
    key: form.get("idempotencyKey"),
  });
  if (!ids.success) return fail("Reload the page and try again.", {}, values);
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;

  const settings = await loadWeddingSettings(ids.data.workspaceId);
  const parsed = parseCategoryInput(values, settings.baseCurrency);
  if (!parsed.ok) return fail("Please check the highlighted details.", parsed.errors, values);

  const supabase = await createUserClient();
  const { error } = await supabase.rpc("create_budget_category", {
    p_wedding: ids.data.workspaceId,
    p_name: parsed.value.name,
    p_idempotency_key: ids.data.key,
    ...(parsed.value.allocationMinor !== null && {
      p_allocation_minor: parsed.value.allocationMinor,
    }),
  });
  if (error) return fail(friendlyBudgetError(error), {}, values);
  refresh(ids.data.workspaceId);
  return { status: "ok", message: "Category added." };
}

export async function addSuggestedCategories(
  _: BudgetActionState,
  form: FormData,
): Promise<BudgetActionState> {
  const ws = uuid.safeParse(form.get("workspaceId"));
  if (!ws.success) return fail("Reload the page and try again.");
  const denied = await authorize(ws.data);
  if (denied) return denied;
  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc("add_suggested_budget_categories", {
    p_wedding: ws.data,
    p_names: [...SUGGESTED_CATEGORIES],
  });
  if (error || typeof data !== "number") return fail(friendlyBudgetError(error ?? {}));
  refresh(ws.data);
  return {
    status: "ok",
    message: data === 0 ? "You already have all of these." : `Added ${data} categories.`,
  };
}

export async function updateCategory(
  _: BudgetActionState,
  form: FormData,
): Promise<BudgetActionState> {
  const values = readValues(form, CATEGORY_FIELDS);
  const ids = z.object({ workspaceId: uuid, categoryId: uuid, version }).safeParse({
    workspaceId: form.get("workspaceId"),
    categoryId: form.get("categoryId"),
    version: form.get("version"),
  });
  if (!ids.success) return fail("Reload the page and try again.", {}, values);
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;

  const settings = await loadWeddingSettings(ids.data.workspaceId);
  const parsed = parseCategoryInput(values, settings.baseCurrency);
  if (!parsed.ok) return fail("Please check the highlighted details.", parsed.errors, values);

  const supabase = await createUserClient();
  const { error } = await supabase.rpc("update_budget_category", {
    p_wedding: ids.data.workspaceId,
    p_category: ids.data.categoryId,
    p_expected_version: ids.data.version,
    p_name: parsed.value.name,
    ...(parsed.value.allocationMinor !== null && {
      p_allocation_minor: parsed.value.allocationMinor,
    }),
  });
  if (error) return fail(friendlyBudgetError(error), {}, values);
  refresh(ids.data.workspaceId);
  return { status: "ok", message: "Saved." };
}

export async function archiveCategory(
  _: BudgetActionState,
  form: FormData,
): Promise<BudgetActionState> {
  const ids = z.object({ workspaceId: uuid, categoryId: uuid, version }).safeParse({
    workspaceId: form.get("workspaceId"),
    categoryId: form.get("categoryId"),
    version: form.get("version"),
  });
  if (!ids.success) return fail("Reload the page and try again.");
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const supabase = await createUserClient();
  const { error } = await supabase.rpc("archive_budget_category", {
    p_wedding: ids.data.workspaceId,
    p_category: ids.data.categoryId,
    p_expected_version: ids.data.version,
  });
  if (error) return fail(friendlyBudgetError(error));
  refresh(ids.data.workspaceId);
  return { status: "ok", message: "Category removed." };
}

// ---------------------------------------------------------------- items

export async function createItem(_: BudgetActionState, form: FormData): Promise<BudgetActionState> {
  const values = readValues(form, ITEM_FIELDS);
  const ids = z.object({ workspaceId: uuid, key: idemKey }).safeParse({
    workspaceId: form.get("workspaceId"),
    key: form.get("idempotencyKey"),
  });
  if (!ids.success) return fail("Reload the page and try again.", {}, values);
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;

  const settings = await loadWeddingSettings(ids.data.workspaceId);
  const parsed = parseItemInput(values, settings.baseCurrency);
  if (!parsed.ok) return fail("Please check the highlighted details.", parsed.errors, values);
  const category = uuid.safeParse(parsed.value.categoryId);
  if (!category.success)
    return fail(
      "Please check the highlighted details.",
      { category: "Choose a category." },
      values,
    );

  const supabase = await createUserClient();
  const { error } = await supabase.rpc("create_budget_item", {
    p_wedding: ids.data.workspaceId,
    p_category: category.data,
    p_idempotency_key: ids.data.key,
    ...itemArgs(parsed.value),
  });
  if (error) return fail(friendlyBudgetError(error), {}, values);
  refresh(ids.data.workspaceId);
  return { status: "ok", message: "Cost added." };
}

export async function updateItem(_: BudgetActionState, form: FormData): Promise<BudgetActionState> {
  const values = readValues(form, ITEM_FIELDS);
  const ids = z.object({ workspaceId: uuid, itemId: uuid, version }).safeParse({
    workspaceId: form.get("workspaceId"),
    itemId: form.get("itemId"),
    version: form.get("version"),
  });
  if (!ids.success) return fail("Reload the page and try again.", {}, values);
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;

  const settings = await loadWeddingSettings(ids.data.workspaceId);
  const parsed = parseItemInput(values, settings.baseCurrency);
  if (!parsed.ok) return fail("Please check the highlighted details.", parsed.errors, values);
  const category = uuid.safeParse(parsed.value.categoryId);
  if (!category.success)
    return fail(
      "Please check the highlighted details.",
      { category: "Choose a category." },
      values,
    );

  const supabase = await createUserClient();
  const { error } = await supabase.rpc("update_budget_item", {
    p_wedding: ids.data.workspaceId,
    p_item: ids.data.itemId,
    p_expected_version: ids.data.version,
    p_category: category.data,
    ...itemArgs(parsed.value),
  });
  if (error) return fail(friendlyBudgetError(error), {}, values);
  refresh(ids.data.workspaceId);
  return { status: "ok", message: "Saved." };
}

export async function archiveItem(
  _: BudgetActionState,
  form: FormData,
): Promise<BudgetActionState> {
  const ids = z.object({ workspaceId: uuid, itemId: uuid, version }).safeParse({
    workspaceId: form.get("workspaceId"),
    itemId: form.get("itemId"),
    version: form.get("version"),
  });
  if (!ids.success) return fail("Reload the page and try again.");
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const supabase = await createUserClient();
  const { error } = await supabase.rpc("archive_budget_item", {
    p_wedding: ids.data.workspaceId,
    p_item: ids.data.itemId,
    p_expected_version: ids.data.version,
  });
  if (error) return fail(friendlyBudgetError(error));
  refresh(ids.data.workspaceId);
  return { status: "ok", message: "Cost removed." };
}

// ---------------------------------------------------------------- reserve

export async function setReserve(_: BudgetActionState, form: FormData): Promise<BudgetActionState> {
  const values = readValues(form, ["reserve"]);
  const ids = z.object({ workspaceId: uuid, version }).safeParse({
    workspaceId: form.get("workspaceId"),
    version: form.get("version"),
  });
  if (!ids.success) return fail("Reload the page and try again.", {}, values);
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const bp = parseReservePercent(values.reserve ?? "");
  if (bp === undefined) {
    return fail(
      "Please check the highlighted details.",
      { reserve: "Enter a percentage from 0 to 100, like 10, or leave it blank for none." },
      values,
    );
  }
  const supabase = await createUserClient();
  const { error } = await supabase.rpc("set_budget_reserve", {
    p_wedding: ids.data.workspaceId,
    p_expected_version: ids.data.version,
    ...(bp !== null && { p_reserve_bp: bp }),
  });
  if (error) return fail(friendlyBudgetError(error), {}, values);
  refresh(ids.data.workspaceId);
  return { status: "ok", message: "Saved." };
}
