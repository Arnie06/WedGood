"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { parseCsv } from "@/domain/guests/csv";
import {
  buildPreview,
  cleanBlock,
  guessMapping,
  IMPORT_FIELDS,
  rowsToCommit,
  toGuestPayload,
  validateGuest,
  validateMapping,
  type ColumnMapping,
  type GuestErrors,
  type ImportField,
  type RowStatus,
} from "@/domain/guests/import";
import { ForbiddenError, requireCapability } from "@/server/auth/workspace-guard";
import { createUserClient } from "@/server/supabase/server";
import { friendlyGuestError } from "./errors";

export type GuestActionState =
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

function fail(
  message: string,
  fieldErrors: Record<string, string> = {},
  values: Record<string, string> = {},
): GuestActionState {
  return { status: "error", message, fieldErrors, values };
}

async function authorize(workspaceId: string): Promise<GuestActionState | null> {
  try {
    await requireCapability(workspaceId, "guests.manage");
    return null;
  } catch (e) {
    if (e instanceof ForbiddenError) return fail(friendlyGuestError({ code: "42501" }));
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

const GUEST_FIELDS = [
  "fullName",
  "email",
  "phone",
  "household",
  "tags",
  "ageGroup",
  "dietary",
  "accessibility",
  "notes",
] as const;

/** Creates a guest, or updates one when `guestId` and `version` are present. */
export async function saveGuest(_: GuestActionState, form: FormData): Promise<GuestActionState> {
  const values = readValues(form, GUEST_FIELDS);
  const ids = z
    .object({
      workspaceId: uuid,
      guestId: uuid.optional(),
      version: version.optional(),
      key: idemKey.optional(),
    })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      guestId: form.get("guestId") || undefined,
      version: form.get("version") || undefined,
      key: form.get("idempotencyKey") || undefined,
    });
  if (!ids.success) return fail("Reload the page and try again.", {}, values);
  const { workspaceId, guestId } = ids.data;
  const denied = await authorize(workspaceId);
  if (denied) return denied;

  const checked = validateGuest(values);
  const notes = cleanBlock(values.notes ?? "");
  const errors: Record<string, string> = checked.ok ? {} : { ...checked.errors };
  if (notes.length > 500) errors.notes = "Use 500 characters or fewer.";
  if (!checked.ok || Object.keys(errors).length > 0) {
    return fail("Please check the highlighted details.", errors, values);
  }
  const payload = toGuestPayload(checked.guest, notes === "" ? null : notes);
  const supabase = await createUserClient();

  if (guestId) {
    if (ids.data.version === undefined) return fail("Reload the page and try again.", {}, values);
    const { error } = await supabase.rpc("update_guest", {
      p_wedding: workspaceId,
      p_guest_id: guestId,
      p_expected_version: ids.data.version,
      p_guest: payload,
    });
    if (error) return fail(friendlyGuestError(error), {}, values);
    refresh(workspaceId);
    return { status: "ok", message: "Saved.", id: guestId };
  }
  const { data, error } = await supabase.rpc("create_guest", {
    p_wedding: workspaceId,
    p_guest: payload,
    ...(ids.data.key && { p_idempotency_key: ids.data.key }),
  });
  if (error) return fail(friendlyGuestError(error), {}, values);
  refresh(workspaceId);
  return { status: "ok", message: `Added ${checked.guest.fullName}.`, id: data };
}

export async function setGuestArchived(
  _: GuestActionState,
  form: FormData,
): Promise<GuestActionState> {
  const ids = z
    .object({ workspaceId: uuid, guestId: uuid, version, archived: z.enum(["true", "false"]) })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      guestId: form.get("guestId"),
      version: form.get("version"),
      archived: form.get("archived"),
    });
  if (!ids.success) return fail("Reload the page and try again.");
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const archived = ids.data.archived === "true";
  const supabase = await createUserClient();
  const { error } = await supabase.rpc("set_guest_archived", {
    p_wedding: ids.data.workspaceId,
    p_guest_id: ids.data.guestId,
    p_expected_version: ids.data.version,
    p_archived: archived,
  });
  if (error) return fail(friendlyGuestError(error));
  refresh(ids.data.workspaceId);
  return {
    status: "ok",
    message: archived ? "Archived. They no longer count in your guest list." : "Restored.",
  };
}

export async function saveHousehold(
  _: GuestActionState,
  form: FormData,
): Promise<GuestActionState> {
  const values = readValues(form, ["name", "address", "notes"]);
  const ids = z.object({ workspaceId: uuid, householdId: uuid, version }).safeParse({
    workspaceId: form.get("workspaceId"),
    householdId: form.get("householdId"),
    version: form.get("version"),
  });
  if (!ids.success) return fail("Reload the page and try again.", {}, values);
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const name = (values.name ?? "").replace(/\s+/g, " ").trim();
  const address = cleanBlock(values.address ?? "");
  const notes = cleanBlock(values.notes ?? "");
  const errors: Record<string, string> = {};
  if (name === "") errors.name = "Add a household name.";
  else if (name.length > 120) errors.name = "Use 120 characters or fewer.";
  if (address.length > 300) errors.address = "Use 300 characters or fewer.";
  if (notes.length > 500) errors.notes = "Use 500 characters or fewer.";
  if (Object.keys(errors).length > 0) {
    return fail("Please check the highlighted details.", errors, values);
  }
  const supabase = await createUserClient();
  const { error } = await supabase.rpc("update_household", {
    p_wedding: ids.data.workspaceId,
    p_household_id: ids.data.householdId,
    p_expected_version: ids.data.version,
    p_name: name,
    p_address: address,
    p_notes: notes,
  });
  if (error) {
    return error.code === "23505"
      ? fail(
          "Please check the highlighted details.",
          { name: "You already have a household with that name." },
          values,
        )
      : fail(friendlyGuestError(error), {}, values);
  }
  refresh(ids.data.workspaceId);
  return { status: "ok", message: "Saved." };
}

// ---------------------------------------------------------------- CSV import

export type PreviewRowView = {
  line: number;
  status: RowStatus;
  name: string;
  email: string | null;
  household: string | null;
  hasPrivateDetails: boolean;
  errors: GuestErrors;
  duplicateOf: string | null;
};
export type ImportPreviewResult =
  | {
      ok: true;
      headers: string[];
      mapping: ColumnMapping;
      /** Set when the chosen columns can't be used yet; rows is then empty. */
      mappingError?: string;
      rows: PreviewRowView[];
      counts: { ready: number; duplicate: number; invalid: number };
    }
  | { ok: false; error: string };

const mappingSchema = z.partialRecord(z.enum(IMPORT_FIELDS), z.number().int().min(0).max(39));
const importInput = z.object({
  workspaceId: uuid,
  csv: z.string().max(400_000),
  mapping: mappingSchema.optional(),
});

/**
 * Parses and validates server-side; nothing is stored. When no mapping is sent the headers are
 * used to suggest one. The client never supplies rows, only the raw text and column choices, so
 * the preview and the later commit cannot disagree.
 */
export async function previewGuestImport(input: {
  workspaceId: string;
  csv: string;
  mapping?: Partial<Record<ImportField, number>>;
}): Promise<ImportPreviewResult> {
  const parsed = importInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Reload the page and try again." };
  const denied = await authorize(parsed.data.workspaceId);
  if (denied) return { ok: false, error: friendlyGuestError({ code: "42501" }) };

  const csv = parseCsv(parsed.data.csv);
  if (!csv.ok) return { ok: false, error: csv.error };
  const mapping = parsed.data.mapping ?? guessMapping(csv.headers);
  const mapped = validateMapping(mapping, csv.headers.length);
  if (!mapped.ok) {
    return {
      ok: true,
      headers: csv.headers,
      mapping,
      mappingError: mapped.error,
      rows: [],
      counts: { ready: 0, duplicate: 0, invalid: 0 },
    };
  }
  const existing = await loadExisting(parsed.data.workspaceId);
  if (!existing) return { ok: false, error: friendlyGuestError({}) };
  const preview = buildPreview(csv.rows, mapping, existing);
  return {
    ok: true,
    headers: csv.headers,
    mapping,
    counts: preview.counts,
    rows: preview.rows.map((r) => ({
      line: r.line,
      status: r.status,
      name: r.guest?.fullName ?? "",
      email: r.guest?.email ?? null,
      household: r.guest?.household ?? null,
      hasPrivateDetails: Boolean(r.guest?.dietary || r.guest?.accessibility),
      errors: r.errors,
      duplicateOf: r.duplicateOf,
    })),
  };
}
async function loadExisting(workspaceId: string) {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from("guests")
    .select("full_name, email")
    .eq("wedding_id", workspaceId)
    .is("archived_at", null)
    .limit(2500);
  if (error) return null;
  return data.map((g) => ({ fullName: g.full_name, email: g.email }));
}

export type ImportCommitResult =
  | { ok: true; imported: number; skipped: { duplicates: number; invalid: number } }
  | { ok: false; error: string };

/**
 * Re-parses and re-validates the same text and mapping, then commits the ready rows (plus
 * possible duplicates only if the user chose to include them) in one atomic, idempotent RPC.
 */
export async function commitGuestImport(input: {
  workspaceId: string;
  csv: string;
  mapping: Partial<Record<ImportField, number>>;
  includeDuplicates: boolean;
  acknowledged: boolean;
  idempotencyKey: string;
}): Promise<ImportCommitResult> {
  const parsed = importInput
    .extend({
      mapping: mappingSchema,
      includeDuplicates: z.boolean(),
      acknowledged: z.boolean(),
      idempotencyKey: idemKey,
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: "Reload the page and try again." };
  const { workspaceId, includeDuplicates } = parsed.data;
  const denied = await authorize(workspaceId);
  if (denied) return { ok: false, error: friendlyGuestError({ code: "42501" }) };
  if (!parsed.data.acknowledged) {
    return { ok: false, error: "Please confirm the note about guest details before importing." };
  }
  const csv = parseCsv(parsed.data.csv);
  if (!csv.ok) return { ok: false, error: csv.error };
  const mapped = validateMapping(parsed.data.mapping, csv.headers.length);
  if (!mapped.ok) return { ok: false, error: mapped.error };
  const existing = await loadExisting(workspaceId);
  if (!existing) return { ok: false, error: friendlyGuestError({}) };
  const preview = buildPreview(csv.rows, parsed.data.mapping, existing);
  const toStore = rowsToCommit(preview, includeDuplicates);
  if (toStore.length === 0) return { ok: false, error: "There are no rows to import." };

  const supabase = await createUserClient();
  const { error } = await supabase.rpc("commit_guest_import", {
    p_wedding: workspaceId,
    p_rows: toStore.map((g) => toGuestPayload(g)),
    p_idempotency_key: parsed.data.idempotencyKey,
  });
  if (error) return { ok: false, error: friendlyGuestError(error) };
  refresh(workspaceId);
  return {
    ok: true,
    imported: toStore.length,
    skipped: {
      duplicates: includeDuplicates ? 0 : preview.counts.duplicate,
      invalid: preview.counts.invalid,
    },
  };
}
