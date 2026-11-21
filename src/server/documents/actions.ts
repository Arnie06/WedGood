"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  defaultTitleFromName,
  MAX_DOCUMENT_BYTES,
  parseDocumentMeta,
  parseLinkTarget,
  sanitizeDisplayName,
  validateFileBytes,
} from "@/domain/documents/validate";
import { ForbiddenError, requireCapability } from "@/server/auth/workspace-guard";
import { createAdminClient } from "@/server/supabase/admin";
import { createUserClient } from "@/server/supabase/server";
import { friendlyDocumentError } from "./errors";

export type DocumentActionState =
  | { status: "idle" }
  | { status: "ok"; message: string }
  | {
      status: "error";
      message: string;
      fieldErrors: Record<string, string>;
      values: Record<string, string>;
    };

const uuid = z.uuid();
const version = z.coerce.number().int().min(0);
const idemKey = z.string().min(8).max(128);
const BUCKET = "wedding-documents";

function fail(
  message: string,
  fieldErrors: Record<string, string> = {},
  values: Record<string, string> = {},
): DocumentActionState {
  return { status: "error", message, fieldErrors, values };
}

async function authorize(workspaceId: string): Promise<DocumentActionState | null> {
  try {
    await requireCapability(workspaceId, "budget.manage");
    return null;
  } catch (e) {
    if (e instanceof ForbiddenError) return fail(friendlyDocumentError({ code: "42501" }));
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

const UPLOAD_FIELDS = ["title", "kind", "link"] as const;

/**
 * Upload pipeline: authorize as the user, validate the bytes here (type from the signature, size,
 * active content), record an intent as the user, then store and complete with the service role.
 * The browser never writes to storage and never marks a file as validated.
 */
export async function uploadDocument(
  _: DocumentActionState,
  form: FormData,
): Promise<DocumentActionState> {
  const values = readValues(form, UPLOAD_FIELDS);
  const ids = z
    .object({ workspaceId: uuid, key: idemKey })
    .safeParse({ workspaceId: form.get("workspaceId"), key: form.get("idempotencyKey") });
  if (!ids.success) return fail("Reload the page and try again.", {}, values);
  const workspaceId = ids.data.workspaceId;
  const denied = await authorize(workspaceId);
  if (denied) return denied;

  const admin = createAdminClient();
  if (!admin) {
    return fail(
      "Uploads aren't set up on this server yet, so nothing was saved. The owner needs to configure private storage.",
      {},
      values,
    );
  }

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return fail(
      "Please check the highlighted details.",
      { file: "Choose a file to upload." },
      values,
    );
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    return fail(
      "Please check the highlighted details.",
      { file: "The file is larger than 10 MB." },
      values,
    );
  }
  const displayName = sanitizeDisplayName(file.name);
  const meta = parseDocumentMeta({
    title: values.title?.trim() ? (values.title ?? "") : defaultTitleFromName(file.name),
    kind: values.kind ?? "",
  });
  const linkValue = (values.link ?? "").trim();
  const target = linkValue === "" ? null : parseLinkTarget(linkValue);
  if (!meta.ok || (linkValue !== "" && target === null)) {
    return fail(
      "Please check the highlighted details.",
      {
        ...(meta.ok ? {} : meta.errors),
        ...(linkValue !== "" && target === null ? { link: "Choose where to attach it." } : {}),
      },
      values,
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const checked = validateFileBytes(bytes, file.type);
  if (!checked.ok) {
    return fail("This file can't be accepted.", { file: checked.reason }, values);
  }

  const supabase = await createUserClient();
  const intent = await supabase.rpc("create_document_intent", {
    p_wedding: workspaceId,
    p_kind: meta.value.kind,
    p_title: meta.value.title,
    p_mime: checked.mime,
    p_bytes: bytes.byteLength,
    p_idempotency_key: ids.data.key,
    ...(displayName !== null && { p_original_name: displayName }),
  });
  if (intent.error || typeof intent.data !== "string") {
    return fail(friendlyDocumentError(intent.error ?? {}), {}, values);
  }
  const documentId = intent.data;

  // A replayed submit finds the document already completed and must not upload twice.
  const current = await supabase
    .from("documents")
    .select("scan_status, storage_key")
    .eq("id", documentId)
    .single();
  if (current.error) return fail(friendlyDocumentError({}), {}, values);
  if (current.data.scan_status !== "pending") {
    refresh(workspaceId);
    return { status: "ok", message: "Document uploaded." };
  }
  const storageKey = current.data.storage_key;

  const stored = await admin.storage.from(BUCKET).upload(storageKey, bytes, {
    contentType: checked.mime,
    upsert: false,
    cacheControl: "0",
  });
  if (stored.error) {
    await admin.rpc("reject_document", {
      p_document: documentId,
      p_reason: "Storage upload failed",
    });
    return fail("We couldn't store the file. Nothing was saved. Try again.", {}, values);
  }
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const done = await admin.rpc("complete_document", {
    p_document: documentId,
    p_checksum: checksum,
    p_bytes: bytes.byteLength,
  });
  if (done.error) {
    await admin.storage.from(BUCKET).remove([storageKey]);
    await admin.rpc("reject_document", {
      p_document: documentId,
      p_reason: "Could not confirm the stored file",
    });
    return fail("We couldn't confirm the stored file. Nothing was saved. Try again.", {}, values);
  }

  let message = "Document uploaded. It has not been virus-scanned.";
  if (target) {
    const linked = await supabase.rpc("link_document", {
      p_wedding: workspaceId,
      p_document: documentId,
      p_target_type: target.type,
      p_target: target.id,
    });
    if (linked.error)
      message = "Document uploaded, but it couldn't be attached. Attach it from the list below.";
  }
  refresh(workspaceId);
  return { status: "ok", message };
}

export async function updateDocument(
  _: DocumentActionState,
  form: FormData,
): Promise<DocumentActionState> {
  const values = readValues(form, ["title", "kind"]);
  const ids = z.object({ workspaceId: uuid, documentId: uuid, version }).safeParse({
    workspaceId: form.get("workspaceId"),
    documentId: form.get("documentId"),
    version: form.get("version"),
  });
  if (!ids.success) return fail("Reload the page and try again.", {}, values);
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const meta = parseDocumentMeta({ title: values.title ?? "", kind: values.kind ?? "" });
  if (!meta.ok) return fail("Please check the highlighted details.", meta.errors, values);
  const supabase = await createUserClient();
  const { error } = await supabase.rpc("update_document", {
    p_wedding: ids.data.workspaceId,
    p_document: ids.data.documentId,
    p_expected_version: ids.data.version,
    p_title: meta.value.title,
    p_kind: meta.value.kind,
  });
  if (error) return fail(friendlyDocumentError(error), {}, values);
  refresh(ids.data.workspaceId);
  return { status: "ok", message: "Saved." };
}

export async function archiveDocument(
  _: DocumentActionState,
  form: FormData,
): Promise<DocumentActionState> {
  const ids = z.object({ workspaceId: uuid, documentId: uuid, version }).safeParse({
    workspaceId: form.get("workspaceId"),
    documentId: form.get("documentId"),
    version: form.get("version"),
  });
  if (!ids.success) return fail("Reload the page and try again.");
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const supabase = await createUserClient();
  const { error } = await supabase.rpc("archive_document", {
    p_wedding: ids.data.workspaceId,
    p_document: ids.data.documentId,
    p_expected_version: ids.data.version,
  });
  if (error) return fail(friendlyDocumentError(error));
  refresh(ids.data.workspaceId);
  return { status: "ok", message: "Archived. It can no longer be downloaded." };
}

export async function linkDocument(
  _: DocumentActionState,
  form: FormData,
): Promise<DocumentActionState> {
  const values = readValues(form, ["link"]);
  const ids = z
    .object({ workspaceId: uuid, documentId: uuid })
    .safeParse({ workspaceId: form.get("workspaceId"), documentId: form.get("documentId") });
  if (!ids.success) return fail("Reload the page and try again.", {}, values);
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const target = parseLinkTarget(values.link ?? "");
  if (!target) {
    return fail(
      "Please check the highlighted details.",
      { link: "Choose where to attach it." },
      values,
    );
  }
  const supabase = await createUserClient();
  const { error } = await supabase.rpc("link_document", {
    p_wedding: ids.data.workspaceId,
    p_document: ids.data.documentId,
    p_target_type: target.type,
    p_target: target.id,
  });
  if (error) {
    return fail(
      error.code === "22023"
        ? "That item isn't available any more. Reload and choose again."
        : friendlyDocumentError(error),
      {},
      values,
    );
  }
  refresh(ids.data.workspaceId);
  return { status: "ok", message: "Attached." };
}

export async function unlinkDocument(
  _: DocumentActionState,
  form: FormData,
): Promise<DocumentActionState> {
  const ids = z
    .object({ workspaceId: uuid, documentId: uuid })
    .safeParse({ workspaceId: form.get("workspaceId"), documentId: form.get("documentId") });
  const target = parseLinkTarget(String(form.get("link") ?? ""));
  if (!ids.success || !target) return fail("Reload the page and try again.");
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const supabase = await createUserClient();
  const { error } = await supabase.rpc("unlink_document", {
    p_wedding: ids.data.workspaceId,
    p_document: ids.data.documentId,
    p_target_type: target.type,
    p_target: target.id,
  });
  if (error) return fail(friendlyDocumentError(error));
  refresh(ids.data.workspaceId);
  return { status: "ok", message: "Detached." };
}
