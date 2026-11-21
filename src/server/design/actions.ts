"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  defaultTitleFromName,
  isRights,
  MAX_IMAGE_BYTES,
  parseBoardInput,
  parseItemInput,
  sanitizeDisplayName,
  validateImageBytes,
} from "@/domain/design/board";
import { ForbiddenError, requireCapability } from "@/server/auth/workspace-guard";
import { createAdminClient } from "@/server/supabase/admin";
import { createUserClient } from "@/server/supabase/server";
import { friendlyDesignError } from "./errors";

export type DesignActionState =
  | { status: "idle" }
  | { status: "ok"; message: string; id?: string }
  | {
      status: "error";
      message: string;
      fieldErrors: Record<string, string>;
      values: Record<string, string>;
    };

const uuid = z.uuid();
const version = z.coerce.number().int().min(0);
const idemKey = z.string().min(8).max(128);
const BUCKET = "wedding-design";

function fail(
  message: string,
  fieldErrors: Record<string, string> = {},
  values: Record<string, string> = {},
): DesignActionState {
  return { status: "error", message, fieldErrors, values };
}

async function authorize(workspaceId: string): Promise<DesignActionState | null> {
  try {
    await requireCapability(workspaceId, "plan.edit");
    return null;
  } catch (e) {
    if (e instanceof ForbiddenError) return fail(friendlyDesignError({ code: "42501" }));
    throw e;
  }
}

const refresh = (workspaceId: string) => revalidatePath(`/app/${workspaceId}/design`, "layout");

function readValues(form: FormData, fields: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = form.get(f);
    out[f] = typeof v === "string" ? v : "";
  }
  return out;
}

const CHECK = "Please check the highlighted details.";
const RELOAD = "Reload the page and try again.";

export async function createBoard(
  _: DesignActionState,
  form: FormData,
): Promise<DesignActionState> {
  const values = readValues(form, ["title", "description", "palette"]);
  const ids = z
    .object({ workspaceId: uuid, key: idemKey })
    .safeParse({ workspaceId: form.get("workspaceId"), key: form.get("idempotencyKey") });
  if (!ids.success) return fail(RELOAD, {}, values);
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const parsed = parseBoardInput({
    title: values.title ?? "",
    description: values.description ?? "",
    palette: values.palette ?? "",
  });
  if (!parsed.ok) return fail(CHECK, parsed.errors, values);
  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc("create_design_board", {
    p_wedding: ids.data.workspaceId,
    p_title: parsed.value.title,
    p_palette: parsed.value.palette,
    p_idempotency_key: ids.data.key,
    ...(parsed.value.description !== null && { p_description: parsed.value.description }),
  });
  if (error) return fail(friendlyDesignError(error), {}, values);
  refresh(ids.data.workspaceId);
  return { status: "ok", message: "Board created.", id: String(data) };
}

export async function updateBoard(
  _: DesignActionState,
  form: FormData,
): Promise<DesignActionState> {
  const values = readValues(form, ["title", "description", "palette"]);
  const ids = z.object({ workspaceId: uuid, boardId: uuid, version }).safeParse({
    workspaceId: form.get("workspaceId"),
    boardId: form.get("boardId"),
    version: form.get("version"),
  });
  if (!ids.success) return fail(RELOAD, {}, values);
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const parsed = parseBoardInput({
    title: values.title ?? "",
    description: values.description ?? "",
    palette: values.palette ?? "",
  });
  if (!parsed.ok) return fail(CHECK, parsed.errors, values);
  const supabase = await createUserClient();
  const { error } = await supabase.rpc("update_design_board", {
    p_wedding: ids.data.workspaceId,
    p_board: ids.data.boardId,
    p_expected_version: ids.data.version,
    p_title: parsed.value.title,
    p_palette: parsed.value.palette,
    ...(parsed.value.description !== null && { p_description: parsed.value.description }),
  });
  if (error) return fail(friendlyDesignError(error), {}, values);
  refresh(ids.data.workspaceId);
  return { status: "ok", message: "Saved." };
}

export async function archiveBoard(
  _: DesignActionState,
  form: FormData,
): Promise<DesignActionState> {
  const ids = z.object({ workspaceId: uuid, boardId: uuid, version }).safeParse({
    workspaceId: form.get("workspaceId"),
    boardId: form.get("boardId"),
    version: form.get("version"),
  });
  if (!ids.success) return fail(RELOAD);
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const supabase = await createUserClient();
  const { error } = await supabase.rpc("archive_design_board", {
    p_wedding: ids.data.workspaceId,
    p_board: ids.data.boardId,
    p_expected_version: ids.data.version,
  });
  if (error) return fail(friendlyDesignError(error));
  refresh(ids.data.workspaceId);
  return { status: "ok", message: "Board archived." };
}

const ITEM_FIELDS = ["title", "note", "url", "candidate"] as const;

/** A saved link or a note. The URL is checked and stored; the server never requests it. */
export async function addItem(_: DesignActionState, form: FormData): Promise<DesignActionState> {
  const values = readValues(form, [...ITEM_FIELDS, "kind"]);
  const ids = z
    .object({ workspaceId: uuid, boardId: uuid, key: idemKey, kind: z.enum(["link", "note"]) })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      boardId: form.get("boardId"),
      key: form.get("idempotencyKey"),
      kind: form.get("kind"),
    });
  if (!ids.success) return fail(RELOAD, {}, values);
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const parsed = parseItemInput(
    {
      title: values.title ?? "",
      note: values.note ?? "",
      url: values.url ?? "",
      candidate: values.candidate ?? "",
    },
    ids.data.kind === "link",
  );
  if (!parsed.ok) return fail(CHECK, parsed.errors, values);
  const supabase = await createUserClient();
  const { error } = await supabase.rpc("add_design_item", {
    p_wedding: ids.data.workspaceId,
    p_board: ids.data.boardId,
    p_kind: ids.data.kind,
    p_title: parsed.value.title,
    p_idempotency_key: ids.data.key,
    ...(parsed.value.note !== null && { p_note: parsed.value.note }),
    ...(parsed.value.url !== null && { p_url: parsed.value.url }),
    ...(parsed.value.candidateId !== null && { p_candidate: parsed.value.candidateId }),
  });
  if (error) return fail(friendlyDesignError(error), {}, values);
  refresh(ids.data.workspaceId);
  return { status: "ok", message: ids.data.kind === "link" ? "Link saved." : "Note added." };
}

/**
 * Same pipeline as private documents: authorize as the user, validate the bytes here, record an
 * intent as the user, then store and complete with the service role. The browser never writes to
 * storage and never marks an image ready.
 */
export async function uploadImage(
  _: DesignActionState,
  form: FormData,
): Promise<DesignActionState> {
  const values = readValues(form, ["title", "note", "candidate", "rights"]);
  const ids = z.object({ workspaceId: uuid, boardId: uuid, key: idemKey }).safeParse({
    workspaceId: form.get("workspaceId"),
    boardId: form.get("boardId"),
    key: form.get("idempotencyKey"),
  });
  if (!ids.success) return fail(RELOAD, {}, values);
  const { workspaceId, boardId } = ids.data;
  const denied = await authorize(workspaceId);
  if (denied) return denied;

  const admin = createAdminClient();
  if (!admin) {
    return fail(
      "Image uploads aren't set up on this server yet, so nothing was saved. The owner needs to configure private storage.",
      {},
      values,
    );
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return fail(CHECK, { file: "Choose an image to upload." }, values);
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return fail(CHECK, { file: "The image is larger than 5 MB." }, values);
  }
  const rights = values.rights ?? "";
  const parsed = parseItemInput(
    {
      title: values.title?.trim() ? (values.title ?? "") : defaultTitleFromName(file.name),
      note: values.note ?? "",
      url: "",
      candidate: values.candidate ?? "",
    },
    false,
  );
  const errors: Record<string, string> = parsed.ok ? {} : { ...parsed.errors };
  if (!isRights(rights)) errors.rights = "Tell us whether you can use this image.";
  if (!parsed.ok || !isRights(rights)) return fail(CHECK, errors, values);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const checked = validateImageBytes(bytes, file.type);
  if (!checked.ok) return fail("This file can't be accepted.", { file: checked.reason }, values);

  const displayName = sanitizeDisplayName(file.name);
  const supabase = await createUserClient();
  const intent = await supabase.rpc("create_design_image_intent", {
    p_wedding: workspaceId,
    p_board: boardId,
    p_title: parsed.value.title,
    p_rights: rights,
    p_mime: checked.mime,
    p_bytes: bytes.byteLength,
    p_idempotency_key: ids.data.key,
    ...(parsed.value.note !== null && { p_note: parsed.value.note }),
    ...(displayName !== null && { p_original_name: displayName }),
    ...(parsed.value.candidateId !== null && { p_candidate: parsed.value.candidateId }),
  });
  if (intent.error || typeof intent.data !== "string") {
    return fail(friendlyDesignError(intent.error ?? {}), {}, values);
  }
  const itemId = intent.data;

  // A replayed submit finds the item already completed and must not upload twice. The user can
  // only read ready items, so a pending one is read with the intent's own key instead.
  const ready = await supabase.from("design_items").select("id").eq("id", itemId).maybeSingle();
  if (ready.data) {
    refresh(workspaceId);
    return { status: "ok", message: "Image added." };
  }
  const storageKey = `${workspaceId}/${itemId}`;
  const stored = await admin.storage.from(BUCKET).upload(storageKey, bytes, {
    contentType: checked.mime,
    upsert: false,
    cacheControl: "0",
  });
  if (stored.error) {
    await admin.rpc("reject_design_image", { p_item: itemId, p_reason: "Storage upload failed" });
    return fail("We couldn't store the image. Nothing was saved. Try again.", {}, values);
  }
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const done = await admin.rpc("complete_design_image", {
    p_item: itemId,
    p_checksum: checksum,
    p_bytes: bytes.byteLength,
  });
  if (done.error) {
    await admin.storage.from(BUCKET).remove([storageKey]);
    await admin.rpc("reject_design_image", {
      p_item: itemId,
      p_reason: "Could not confirm the stored image",
    });
    return fail("We couldn't confirm the stored image. Nothing was saved. Try again.", {}, values);
  }
  refresh(workspaceId);
  return { status: "ok", message: "Image added. It has not been virus-scanned." };
}

export async function updateItem(_: DesignActionState, form: FormData): Promise<DesignActionState> {
  const values = readValues(form, [...ITEM_FIELDS, "rights", "kind"]);
  const ids = z.object({ workspaceId: uuid, itemId: uuid, version }).safeParse({
    workspaceId: form.get("workspaceId"),
    itemId: form.get("itemId"),
    version: form.get("version"),
  });
  if (!ids.success) return fail(RELOAD, {}, values);
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const kind = values.kind;
  const rights = values.rights ?? "";
  const parsed = parseItemInput(
    {
      title: values.title ?? "",
      note: values.note ?? "",
      url: values.url ?? "",
      candidate: values.candidate ?? "",
    },
    kind === "link",
  );
  const errors: Record<string, string> = parsed.ok ? {} : { ...parsed.errors };
  if (kind === "image" && !isRights(rights))
    errors.rights = "Tell us whether you can use this image.";
  if (!parsed.ok || Object.keys(errors).length > 0) return fail(CHECK, errors, values);
  const supabase = await createUserClient();
  const { error } = await supabase.rpc("update_design_item", {
    p_wedding: ids.data.workspaceId,
    p_item: ids.data.itemId,
    p_expected_version: ids.data.version,
    p_title: parsed.value.title,
    ...(parsed.value.note !== null && { p_note: parsed.value.note }),
    ...(parsed.value.url !== null && { p_url: parsed.value.url }),
    ...(parsed.value.candidateId !== null && { p_candidate: parsed.value.candidateId }),
    ...(kind === "image" && isRights(rights) && { p_rights: rights }),
  });
  if (error) return fail(friendlyDesignError(error), {}, values);
  refresh(ids.data.workspaceId);
  return { status: "ok", message: "Saved." };
}

export async function setFavorite(
  _: DesignActionState,
  form: FormData,
): Promise<DesignActionState> {
  const ids = z
    .object({ workspaceId: uuid, itemId: uuid, version, favorite: z.enum(["true", "false"]) })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      itemId: form.get("itemId"),
      version: form.get("version"),
      favorite: form.get("favorite"),
    });
  if (!ids.success) return fail(RELOAD);
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const supabase = await createUserClient();
  const { error } = await supabase.rpc("set_design_favorite", {
    p_wedding: ids.data.workspaceId,
    p_item: ids.data.itemId,
    p_expected_version: ids.data.version,
    p_favorite: ids.data.favorite === "true",
  });
  if (error) return fail(friendlyDesignError(error));
  refresh(ids.data.workspaceId);
  return {
    status: "ok",
    message: ids.data.favorite === "true" ? "Marked as a favourite." : "Removed from favourites.",
  };
}

export async function moveItem(_: DesignActionState, form: FormData): Promise<DesignActionState> {
  const ids = z
    .object({ workspaceId: uuid, itemId: uuid, direction: z.enum(["earlier", "later"]) })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      itemId: form.get("itemId"),
      direction: form.get("direction"),
    });
  if (!ids.success) return fail(RELOAD);
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const supabase = await createUserClient();
  const { error } = await supabase.rpc("move_design_item", {
    p_wedding: ids.data.workspaceId,
    p_item: ids.data.itemId,
    p_direction: ids.data.direction,
  });
  if (error) return fail(friendlyDesignError(error));
  refresh(ids.data.workspaceId);
  return { status: "ok", message: "Moved." };
}

export async function removeItem(_: DesignActionState, form: FormData): Promise<DesignActionState> {
  const ids = z.object({ workspaceId: uuid, itemId: uuid, version }).safeParse({
    workspaceId: form.get("workspaceId"),
    itemId: form.get("itemId"),
    version: form.get("version"),
  });
  if (!ids.success) return fail(RELOAD);
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc("remove_design_item", {
    p_wedding: ids.data.workspaceId,
    p_item: ids.data.itemId,
    p_expected_version: ids.data.version,
  });
  if (error) return fail(friendlyDesignError(error));
  // The row is gone, so the image is already unreadable. Removing the object is best effort.
  if (typeof data === "string") {
    await createAdminClient()?.storage.from(BUCKET).remove([data]);
  }
  refresh(ids.data.workspaceId);
  return { status: "ok", message: "Removed." };
}
