"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ForbiddenError, requireCapability } from "@/server/auth/workspace-guard";
import { createUserClient } from "@/server/supabase/server";
import { friendlyEventError, friendlyGuaranteeError } from "./errors";

export type GuaranteeActionState =
  | { status: "idle" }
  | { status: "ok"; message: string; kind: "locked" | "revised" | "unchanged" }
  | { status: "error"; message: string };

const uuid = z.uuid();

const previewSchema = z.object({
  yes: z.number().int().min(0).max(99999),
  withoutMeal: z.number().int().min(0).max(99999),
  meals: z.array(z.object({ id: uuid, count: z.number().int().min(0).max(99999) })).max(40),
});

const fields = {
  workspaceId: uuid,
  count: z.coerce.number().int().min(1).max(5000),
  preview: z.string().max(4000),
  candidateId: uuid.optional(),
  dueOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  idempotencyKey: z.string().min(8).max(80),
};

function fail(message: string): GuaranteeActionState {
  return { status: "error", message };
}

function parsePreview(raw: string) {
  try {
    return previewSchema.safeParse(JSON.parse(raw));
  } catch {
    return { success: false as const };
  }
}

async function authorize(workspaceId: string): Promise<GuaranteeActionState | null> {
  try {
    await requireCapability(workspaceId, "guests.manage");
    return null;
  } catch (e) {
    if (e instanceof ForbiddenError) return fail(friendlyEventError({ code: "42501" }));
    throw e;
  }
}

/**
 * Locks the caterer count for an event. Only owner and partner. The form sends the replies it
 * showed; the database refuses if they have changed. Nothing is sent to the caterer.
 */
export async function lockGuarantee(
  _: GuaranteeActionState,
  form: FormData,
): Promise<GuaranteeActionState> {
  const parsed = z.object({ ...fields, eventId: uuid }).safeParse({
    workspaceId: form.get("workspaceId"),
    eventId: form.get("eventId"),
    count: form.get("count"),
    preview: form.get("preview"),
    candidateId: form.get("candidateId") || undefined,
    dueOn: form.get("dueOn") || undefined,
    idempotencyKey: form.get("idempotencyKey"),
  });
  if (!parsed.success) return fail("Enter a whole number of guests from 1 to 5,000.");
  const preview = parsePreview(parsed.data.preview);
  if (!preview.success) return fail("Reload the page and try again.");
  const denied = await authorize(parsed.data.workspaceId);
  if (denied) return denied;

  const supabase = await createUserClient();
  const { error } = await supabase.rpc("lock_guarantee", {
    p_wedding: parsed.data.workspaceId,
    p_event: parsed.data.eventId,
    p_count: parsed.data.count,
    p_seen: preview.data,
    ...(parsed.data.candidateId && { p_candidate: parsed.data.candidateId }),
    ...(parsed.data.dueOn && { p_due: parsed.data.dueOn }),
    p_idempotency_key: parsed.data.idempotencyKey,
  });
  if (error) return fail(friendlyGuaranteeError(error));
  revalidatePath(`/app/${parsed.data.workspaceId}`, "layout");
  return { status: "ok", kind: "locked", message: "Caterer count locked." };
}

/**
 * Revises a locked count. The reason is required and the old count stays in the history. Nothing is
 * sent to the caterer.
 */
export async function reviseGuarantee(
  _: GuaranteeActionState,
  form: FormData,
): Promise<GuaranteeActionState> {
  const parsed = z
    .object({
      ...fields,
      guaranteeId: uuid,
      reason: z.string().trim().min(1).max(500),
    })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      guaranteeId: form.get("guaranteeId"),
      count: form.get("count"),
      preview: form.get("preview"),
      reason: form.get("reason"),
      candidateId: form.get("candidateId") || undefined,
      dueOn: form.get("dueOn") || undefined,
      idempotencyKey: form.get("idempotencyKey"),
    });
  if (!parsed.success) {
    const reasonMissing = parsed.error.issues.some((i) => i.path[0] === "reason");
    return fail(
      reasonMissing
        ? "Say why the count is changing (up to 500 characters)."
        : "Enter a whole number of guests from 1 to 5,000.",
    );
  }
  const preview = parsePreview(parsed.data.preview);
  if (!preview.success) return fail("Reload the page and try again.");
  const denied = await authorize(parsed.data.workspaceId);
  if (denied) return denied;

  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc("revise_guarantee", {
    p_wedding: parsed.data.workspaceId,
    p_guarantee: parsed.data.guaranteeId,
    p_count: parsed.data.count,
    p_seen: preview.data,
    p_reason: parsed.data.reason,
    ...(parsed.data.candidateId && { p_candidate: parsed.data.candidateId }),
    ...(parsed.data.dueOn && { p_due: parsed.data.dueOn }),
    p_idempotency_key: parsed.data.idempotencyKey,
  });
  if (error) return fail(friendlyGuaranteeError(error));
  revalidatePath(`/app/${parsed.data.workspaceId}`, "layout");
  // A revision that changes nothing returns the same row.
  if (data === parsed.data.guaranteeId) {
    return { status: "ok", kind: "unchanged", message: "Nothing changed." };
  }
  return { status: "ok", kind: "revised", message: "Caterer count revised." };
}
