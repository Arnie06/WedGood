"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ATTENTION_KINDS, isDismissibleKind } from "@/domain/attention/attention";
import { ForbiddenError, requireCapability } from "@/server/auth/workspace-guard";
import { createUserClient } from "@/server/supabase/server";
import { friendlyAttentionError } from "./errors";

export type AttentionActionState =
  { status: "idle" } | { status: "ok"; message: string } | { status: "error"; message: string };

const uuid = z.uuid();

function fail(message: string): AttentionActionState {
  return { status: "error", message };
}

/** Owner and partner only. The database checks the same rule; this gives a clear message first. */
async function authorize(workspaceId: string): Promise<AttentionActionState | null> {
  try {
    await requireCapability(workspaceId, "guests.manage");
    return null;
  } catch (e) {
    if (e instanceof ForbiddenError) return fail(friendlyAttentionError({ code: "42501" }));
    throw e;
  }
}

function refresh(workspaceId: string) {
  revalidatePath(`/app/${workspaceId}`, "layout");
}

/**
 * Hides a computed item while it looks the way it does now. If it changes, it comes back.
 * Nothing in the wedding changes.
 */
export async function dismissAttention(
  _: AttentionActionState,
  form: FormData,
): Promise<AttentionActionState> {
  const parsed = z
    .object({
      workspaceId: uuid,
      kind: z.string().refine(isDismissibleKind),
      subjectId: uuid,
      fingerprint: z.string().min(1).max(80),
    })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      kind: form.get("kind"),
      subjectId: form.get("subjectId"),
      fingerprint: form.get("fingerprint"),
    });
  if (!parsed.success) return fail("Reload the page and try again.");
  const denied = await authorize(parsed.data.workspaceId);
  if (denied) return denied;
  const supabase = await createUserClient();
  const { error } = await supabase.rpc("dismiss_attention", {
    p_wedding: parsed.data.workspaceId,
    p_kind: parsed.data.kind,
    p_subject: parsed.data.subjectId,
    p_fingerprint: parsed.data.fingerprint,
  });
  if (error) return fail(friendlyAttentionError(error));
  refresh(parsed.data.workspaceId);
  return { status: "ok", message: "Hidden until it changes." };
}

/** Shows a dismissed item again. */
export async function restoreAttention(
  _: AttentionActionState,
  form: FormData,
): Promise<AttentionActionState> {
  const parsed = z
    .object({
      workspaceId: uuid,
      kind: z.enum(ATTENTION_KINDS),
      subjectId: uuid,
    })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      kind: form.get("kind"),
      subjectId: form.get("subjectId"),
    });
  if (!parsed.success) return fail("Reload the page and try again.");
  const denied = await authorize(parsed.data.workspaceId);
  if (denied) return denied;
  const supabase = await createUserClient();
  const { error } = await supabase.rpc("restore_attention", {
    p_wedding: parsed.data.workspaceId,
    p_kind: parsed.data.kind,
    p_subject: parsed.data.subjectId,
  });
  if (error) return fail(friendlyAttentionError(error));
  refresh(parsed.data.workspaceId);
  return { status: "ok", message: "Showing it again." };
}

/** Closes a stored item (for example seats released after finalizing). */
export async function handleAttentionItem(
  _: AttentionActionState,
  form: FormData,
): Promise<AttentionActionState> {
  const parsed = z.object({ workspaceId: uuid, itemId: uuid }).safeParse({
    workspaceId: form.get("workspaceId"),
    itemId: form.get("itemId"),
  });
  if (!parsed.success) return fail("Reload the page and try again.");
  const denied = await authorize(parsed.data.workspaceId);
  if (denied) return denied;
  const supabase = await createUserClient();
  const { error } = await supabase.rpc("handle_attention_item", {
    p_wedding: parsed.data.workspaceId,
    p_item: parsed.data.itemId,
  });
  if (error) return fail(friendlyAttentionError(error));
  refresh(parsed.data.workspaceId);
  return { status: "ok", message: "Marked as handled." };
}
