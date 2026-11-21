"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { parseTaskInput, type TaskField } from "@/domain/tasks/input";
import { CHECKLIST_TEMPLATE } from "@/domain/tasks/templates";
import { ForbiddenError, requireCapability } from "@/server/auth/workspace-guard";
import { createUserClient } from "@/server/supabase/server";
import { friendlyPlanError } from "./errors";

export type PlanActionState =
  | { status: "idle" }
  | { status: "ok"; message: string }
  | {
      status: "error";
      message: string;
      fieldErrors: Partial<Record<TaskField, string>>;
      values: Partial<Record<TaskField | "assignee", string>>;
    };

const uuid = z.uuid();
const version = z.coerce.number().int().min(1);
const idemKey = z.string().min(8).max(128);

function fail(
  message: string,
  fieldErrors: Partial<Record<TaskField, string>> = {},
  values: Partial<Record<TaskField | "assignee", string>> = {},
): PlanActionState {
  return { status: "error", message, fieldErrors, values };
}

async function authorize(workspaceId: string): Promise<PlanActionState | null> {
  try {
    await requireCapability(workspaceId, "plan.edit");
    return null;
  } catch (e) {
    if (e instanceof ForbiddenError) return fail(friendlyPlanError({ code: "42501" }));
    throw e;
  }
}

function refresh(workspaceId: string) {
  revalidatePath(`/app/${workspaceId}`, "layout");
}

function readTaskValues(form: FormData) {
  const get = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : "";
  };
  return {
    title: get("title"),
    notes: get("notes"),
    dueDate: get("dueDate"),
    assignee: get("assignee"),
  };
}

/** Assignee select value: "" means unassigned (null), otherwise a user id (validated by the database). */
function assigneeArg(raw: string): { ok: true; value: string | null } | { ok: false } {
  if (raw === "") return { ok: true, value: null };
  const parsed = uuid.safeParse(raw);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

export async function generateChecklist(
  _: PlanActionState,
  form: FormData,
): Promise<PlanActionState> {
  const ws = uuid.safeParse(form.get("workspaceId"));
  if (!ws.success) return fail("Reload the page and try again.");
  const denied = await authorize(ws.data);
  if (denied) return denied;

  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc("generate_checklist", {
    p_wedding: ws.data,
    p_items: CHECKLIST_TEMPLATE.map((t) => ({
      key: t.key,
      title: t.title,
      notes: t.notes ?? null,
      phase: t.phase,
      offsetDays: t.offsetDays,
    })),
  });
  if (error || typeof data !== "number") return fail(friendlyPlanError(error ?? {}));
  refresh(ws.data);
  return {
    status: "ok",
    message:
      data === 0 ? "Your checklist is already up to date." : `Added ${data} suggested tasks.`,
  };
}

export async function createTask(_: PlanActionState, form: FormData): Promise<PlanActionState> {
  const values = readTaskValues(form);
  const ws = uuid.safeParse(form.get("workspaceId"));
  const key = idemKey.safeParse(form.get("idempotencyKey"));
  if (!ws.success || !key.success) return fail("Reload the page and try again.", {}, values);
  const parsed = parseTaskInput(values);
  if (!parsed.ok) return fail("Please check the highlighted details.", parsed.errors, values);
  const assignee = assigneeArg(values.assignee);
  if (!assignee.ok) return fail(friendlyPlanError({ code: "22023" }), {}, values);
  const denied = await authorize(ws.data);
  if (denied) return denied;

  const supabase = await createUserClient();
  const { error } = await supabase.rpc("create_task", {
    p_wedding: ws.data,
    p_title: parsed.value.title,
    p_idempotency_key: key.data,
    ...(parsed.value.notes !== null && { p_notes: parsed.value.notes }),
    ...(parsed.value.dueDate !== null && { p_due_date: parsed.value.dueDate }),
    ...(assignee.value !== null && { p_assignee: assignee.value }),
  });
  if (error) return fail(friendlyPlanError(error), {}, values);
  refresh(ws.data);
  return { status: "ok", message: "Task added." };
}

export async function updateTask(_: PlanActionState, form: FormData): Promise<PlanActionState> {
  const values = readTaskValues(form);
  const ids = z.object({ workspaceId: uuid, taskId: uuid, version }).safeParse({
    workspaceId: form.get("workspaceId"),
    taskId: form.get("taskId"),
    version: form.get("version"),
  });
  if (!ids.success) return fail("Reload the page and try again.", {}, values);
  const parsed = parseTaskInput(values);
  if (!parsed.ok) return fail("Please check the highlighted details.", parsed.errors, values);
  const assignee = assigneeArg(values.assignee);
  if (!assignee.ok) return fail(friendlyPlanError({ code: "22023" }), {}, values);
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;

  const supabase = await createUserClient();
  const { error } = await supabase.rpc("update_task", {
    p_wedding: ids.data.workspaceId,
    p_task: ids.data.taskId,
    p_expected_version: ids.data.version,
    p_title: parsed.value.title,
    ...(parsed.value.notes !== null && { p_notes: parsed.value.notes }),
    ...(parsed.value.dueDate !== null && { p_due_date: parsed.value.dueDate }),
    ...(assignee.value !== null && { p_assignee: assignee.value }),
  });
  if (error) return fail(friendlyPlanError(error), {}, values);
  refresh(ids.data.workspaceId);
  redirect(`/app/${ids.data.workspaceId}/plan`);
}

export async function setTaskStatus(_: PlanActionState, form: FormData): Promise<PlanActionState> {
  const parsed = z
    .object({ workspaceId: uuid, taskId: uuid, version, done: z.enum(["true", "false"]) })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      taskId: form.get("taskId"),
      version: form.get("version"),
      done: form.get("done"),
    });
  if (!parsed.success) return fail("Reload the page and try again.");
  const denied = await authorize(parsed.data.workspaceId);
  if (denied) return denied;

  const supabase = await createUserClient();
  const { error } = await supabase.rpc("set_task_status", {
    p_wedding: parsed.data.workspaceId,
    p_task: parsed.data.taskId,
    p_expected_version: parsed.data.version,
    p_done: parsed.data.done === "true",
  });
  if (error) return fail(friendlyPlanError(error));
  refresh(parsed.data.workspaceId);
  return { status: "ok", message: parsed.data.done === "true" ? "Marked done." : "Reopened." };
}

export async function archiveTask(_: PlanActionState, form: FormData): Promise<PlanActionState> {
  const parsed = z.object({ workspaceId: uuid, taskId: uuid, version }).safeParse({
    workspaceId: form.get("workspaceId"),
    taskId: form.get("taskId"),
    version: form.get("version"),
  });
  if (!parsed.success) return fail("Reload the page and try again.");
  const denied = await authorize(parsed.data.workspaceId);
  if (denied) return denied;

  const supabase = await createUserClient();
  const { error } = await supabase.rpc("archive_task", {
    p_wedding: parsed.data.workspaceId,
    p_task: parsed.data.taskId,
    p_expected_version: parsed.data.version,
  });
  if (error) return fail(friendlyPlanError(error));
  refresh(parsed.data.workspaceId);
  redirect(`/app/${parsed.data.workspaceId}/plan`);
}

/** Applies exactly the reviewed moves; the database recomputes every date itself. */
export async function applyReschedule(
  _: PlanActionState,
  form: FormData,
): Promise<PlanActionState> {
  const ws = uuid.safeParse(form.get("workspaceId"));
  if (!ws.success) return fail("Reload the page and try again.");
  const items = z
    .array(z.object({ id: uuid, version: z.number().int().min(1) }))
    .max(200)
    .safeParse(
      form
        .getAll("move")
        .map((v) => (typeof v === "string" ? v.split(":") : []))
        .map(([id, v]) => ({ id, version: Number(v) })),
    );
  if (!items.success) return fail("Reload the page and try again.");
  const denied = await authorize(ws.data);
  if (denied) return denied;

  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc("reschedule_relative_tasks", {
    p_wedding: ws.data,
    p_approved: items.data,
  });
  if (error || typeof data !== "number") return fail(friendlyPlanError(error ?? {}));
  refresh(ws.data);
  redirect(`/app/${ws.data}/plan`);
}
