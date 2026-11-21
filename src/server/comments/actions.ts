"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { isCommentKind, parseCommentBody, subjectPath } from "@/domain/comments/comment";
import { requireWorkspace } from "@/server/auth/workspace-guard";
import { createUserClient } from "@/server/supabase/server";
import { friendlyCommentError } from "./errors";

export type CommentActionState =
  | { status: "idle" }
  | { status: "ok"; message: string }
  | { status: "error"; message: string; body: string };

const uuid = z.uuid();
const version = z.coerce.number().int().min(0);
const idemKey = z.string().min(8).max(128);
const RELOAD = "Reload the page and try again.";

const fail = (message: string, body = ""): CommentActionState => ({
  status: "error",
  message,
  body,
});
const text = (form: FormData, key: string) => {
  const v = form.get(key);
  return typeof v === "string" ? v : "";
};

// Every action re-verifies membership (any member may comment; roles only matter for moderation,
// which the database decides). The viewer role is allowed on purpose.

export async function addComment(
  _: CommentActionState,
  form: FormData,
): Promise<CommentActionState> {
  const body = text(form, "body");
  const ids = z
    .object({ workspaceId: uuid, kind: z.string(), subjectId: uuid, key: idemKey })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      kind: form.get("kind"),
      subjectId: form.get("subjectId"),
      key: form.get("idempotencyKey"),
    });
  if (!ids.success || !isCommentKind(ids.data.kind)) return fail(RELOAD, body);
  const parsed = parseCommentBody(body);
  if (!parsed.ok) return fail(parsed.error, body);
  const access = await requireWorkspace(ids.data.workspaceId);
  const supabase = await createUserClient();
  const { error } = await supabase.rpc("add_comment", {
    p_wedding: access.wedding.id,
    p_kind: ids.data.kind,
    p_subject: ids.data.subjectId,
    p_body: parsed.body,
    p_idempotency_key: ids.data.key,
  });
  if (error) return fail(friendlyCommentError(error), body);
  revalidatePath(subjectPath(access.wedding.id, ids.data.kind, ids.data.subjectId));
  revalidatePath(`/app/${access.wedding.id}/shared`);
  return { status: "ok", message: "Comment posted." };
}

export async function editComment(
  _: CommentActionState,
  form: FormData,
): Promise<CommentActionState> {
  const body = text(form, "body");
  const ids = z.object({ workspaceId: uuid, commentId: uuid, version }).safeParse({
    workspaceId: form.get("workspaceId"),
    commentId: form.get("commentId"),
    version: form.get("version"),
  });
  if (!ids.success) return fail(RELOAD, body);
  const parsed = parseCommentBody(body);
  if (!parsed.ok) return fail(parsed.error, body);
  const access = await requireWorkspace(ids.data.workspaceId);
  const supabase = await createUserClient();
  const { error } = await supabase.rpc("edit_comment", {
    p_wedding: access.wedding.id,
    p_comment: ids.data.commentId,
    p_expected_version: ids.data.version,
    p_body: parsed.body,
  });
  if (error) return fail(friendlyCommentError(error), body);
  revalidatePath(`/app/${access.wedding.id}`, "layout");
  return { status: "ok", message: "Saved." };
}

export async function deleteComment(
  _: CommentActionState,
  form: FormData,
): Promise<CommentActionState> {
  const ids = z.object({ workspaceId: uuid, commentId: uuid }).safeParse({
    workspaceId: form.get("workspaceId"),
    commentId: form.get("commentId"),
  });
  if (!ids.success) return fail(RELOAD);
  const access = await requireWorkspace(ids.data.workspaceId);
  const supabase = await createUserClient();
  const { error } = await supabase.rpc("delete_comment", {
    p_wedding: access.wedding.id,
    p_comment: ids.data.commentId,
  });
  if (error) return fail(friendlyCommentError(error));
  revalidatePath(`/app/${access.wedding.id}`, "layout");
  return { status: "ok", message: "Comment deleted." };
}
