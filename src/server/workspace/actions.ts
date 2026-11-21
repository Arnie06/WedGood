"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { previewReschedule } from "@/domain/tasks/schedule";
import { toScheduled } from "@/features/plan/mappers";
import { loadTasks } from "@/server/plan/queries";
import { parseSettingsInput, type SettingsField } from "@/domain/wedding/settings";
import { requireSessionUser } from "@/server/auth/session";
import { ForbiddenError, requireCapability } from "@/server/auth/workspace-guard";
import { createUserClient } from "@/server/supabase/server";
import { friendlyWorkspaceError } from "./errors";

export type SettingsFormState =
  | { status: "idle" }
  | { status: "ok"; message: string; version: number; reviewMoves?: number }
  | {
      status: "error";
      message: string;
      fieldErrors: Partial<Record<SettingsField, string>>;
      values: Partial<Record<SettingsField, string>>;
    };

const FIELDS: SettingsField[] = [
  "name",
  "date",
  "timezone",
  "baseCurrency",
  "targetBudget",
  "targetGuestCount",
  "location",
];

function readFields(form: FormData): Partial<Record<SettingsField, string>> {
  const out: Partial<Record<SettingsField, string>> = {};
  for (const f of FIELDS) {
    const v = form.get(f);
    out[f] = typeof v === "string" ? v : "";
  }
  return out;
}

const key = z.string().min(8).max(128);
const uuid = z.uuid();

/** Optional values are omitted (SQL default null), never sent as 0. */
function rpcArgs(s: Extract<ReturnType<typeof parseSettingsInput>, { ok: true }>["value"]) {
  return {
    p_name: s.name,
    p_timezone: s.timezone,
    p_base_currency: s.baseCurrency,
    ...(s.date !== null && { p_date: s.date }),
    ...(s.targetBudgetMinor !== null && { p_target_budget_minor: s.targetBudgetMinor }),
    ...(s.targetGuestCount !== null && { p_target_guest_count: s.targetGuestCount }),
    ...(s.location !== null && { p_location: s.location }),
  };
}

export async function createWorkspace(
  _: SettingsFormState,
  form: FormData,
): Promise<SettingsFormState> {
  await requireSessionUser("/app/onboarding");
  const values = readFields(form);
  const parsed = parseSettingsInput(values);
  if (!parsed.ok) {
    return {
      status: "error",
      message: "Please check the highlighted details.",
      fieldErrors: parsed.errors,
      values,
    };
  }
  const idem = key.safeParse(form.get("idempotencyKey"));
  if (!idem.success) {
    return { status: "error", message: "Reload the page and try again.", fieldErrors: {}, values };
  }

  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc("create_wedding", {
    ...rpcArgs(parsed.value),
    p_idempotency_key: idem.data,
  });
  if (error || !data) {
    return {
      status: "error",
      message: friendlyWorkspaceError(error ?? {}),
      fieldErrors: {},
      values,
    };
  }
  redirect(`/app/${data}`);
}

export async function updateWorkspaceSettings(
  _: SettingsFormState,
  form: FormData,
): Promise<SettingsFormState> {
  const values = readFields(form);
  const ids = z
    .object({ workspaceId: uuid, version: z.coerce.number().int().min(1) })
    .safeParse({ workspaceId: form.get("workspaceId"), version: form.get("version") });
  if (!ids.success) {
    return { status: "error", message: "Reload the page and try again.", fieldErrors: {}, values };
  }
  const parsed = parseSettingsInput(values);
  if (!parsed.ok) {
    return {
      status: "error",
      message: "Please check the highlighted details.",
      fieldErrors: parsed.errors,
      values,
    };
  }

  try {
    await requireCapability(ids.data.workspaceId, "settings.edit");
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return {
        status: "error",
        message: friendlyWorkspaceError({ code: "42501" }),
        fieldErrors: {},
        values,
      };
    }
    throw e;
  }

  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc("update_wedding_settings", {
    p_wedding: ids.data.workspaceId,
    p_expected_version: ids.data.version,
    ...rpcArgs(parsed.value),
  });
  if (error || typeof data !== "number") {
    return {
      status: "error",
      message: friendlyWorkspaceError(error ?? {}),
      fieldErrors: {},
      values,
    };
  }
  revalidatePath(`/app/${ids.data.workspaceId}`, "layout");

  // A new date never moves tasks by itself. If flexible tasks no longer match it,
  // point the person at the reviewed preview (docs/07-DOMAIN-RULES.md).
  const tasks = await loadTasks(ids.data.workspaceId);
  const moves = previewReschedule(parsed.value.date, tasks.map(toScheduled)).moves.length;
  return {
    status: "ok",
    message: "Saved.",
    version: data,
    ...(moves > 0 && { reviewMoves: moves }),
  };
}
