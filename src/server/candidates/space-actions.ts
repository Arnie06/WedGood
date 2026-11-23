"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { validateSpace, type SpaceFormValues } from "@/domain/events/location";
import { ForbiddenError, requireCapability } from "@/server/auth/workspace-guard";
import { createUserClient } from "@/server/supabase/server";
import { friendlyCandidateError } from "./errors";

export type SpaceActionState =
  | { status: "idle" }
  | { status: "ok"; message: string }
  | {
      status: "error";
      message: string;
      fieldErrors: Record<string, string>;
      values: Partial<SpaceFormValues>;
    };

const uuid = z.uuid();
const version = z.coerce.number().int().min(1);
const idemKey = z.string().min(8).max(128);
const FIELDS = ["name", "seatedCapacity", "standingCapacity", "notes"] as const;

function fail(
  message: string,
  fieldErrors: Record<string, string> = {},
  values: Partial<SpaceFormValues> = {},
): SpaceActionState {
  return { status: "error", message, fieldErrors, values };
}

function readValues(form: FormData): SpaceFormValues {
  const out: SpaceFormValues = { name: "", seatedCapacity: "", standingCapacity: "", notes: "" };
  for (const f of FIELDS) {
    const v = form.get(f);
    out[f] = typeof v === "string" ? v : "";
  }
  return out;
}

async function authorize(workspaceId: string): Promise<SpaceActionState | null> {
  try {
    await requireCapability(workspaceId, "vendors.manage");
    return null;
  } catch (e) {
    if (e instanceof ForbiddenError) return fail(friendlyCandidateError({ code: "42501" }));
    throw e;
  }
}

function spaceError(error: { code?: string }, values: Partial<SpaceFormValues>): SpaceActionState {
  if (error.code === "23505")
    return fail(
      "Please check the highlighted details.",
      { name: "This venue already has a space with that name." },
      values,
    );
  if (error.code === "54000") return fail("A venue can have up to 30 spaces.", {}, values);
  return fail(friendlyCandidateError(error), {}, values);
}

/** Adds a space (a room or area) to a venue, or edits one when a spaceId and version are sent. */
export async function saveVenueSpace(
  _: SpaceActionState,
  form: FormData,
): Promise<SpaceActionState> {
  const values = readValues(form);
  const ids = z
    .object({
      workspaceId: uuid,
      venueId: uuid,
      spaceId: uuid.optional(),
      version: version.optional(),
      key: idemKey.optional(),
    })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      venueId: form.get("venueId"),
      spaceId: form.get("spaceId") || undefined,
      version: form.get("version") || undefined,
      key: form.get("idempotencyKey") || undefined,
    });
  if (!ids.success) return fail("Reload the page and try again.", {}, values);
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const checked = validateSpace(values);
  if (!checked.ok) return fail("Please check the highlighted details.", checked.errors, values);
  const s = checked.input;
  const supabase = await createUserClient();
  const fields = {
    p_name: s.name,
    ...(s.seatedCapacity !== null && { p_seated_capacity: s.seatedCapacity }),
    ...(s.standingCapacity !== null && { p_standing_capacity: s.standingCapacity }),
    ...(s.notes !== null && { p_notes: s.notes }),
  };
  if (ids.data.spaceId) {
    if (ids.data.version === undefined) return fail("Reload the page and try again.", {}, values);
    const { error } = await supabase.rpc("update_venue_space", {
      p_wedding: ids.data.workspaceId,
      p_space: ids.data.spaceId,
      p_expected_version: ids.data.version,
      ...fields,
    });
    if (error) return spaceError(error, values);
    revalidatePath(`/app/${ids.data.workspaceId}`, "layout");
    return { status: "ok", message: "Saved." };
  }
  const { error } = await supabase.rpc("create_venue_space", {
    p_wedding: ids.data.workspaceId,
    p_candidate: ids.data.venueId,
    ...fields,
    ...(ids.data.key && { p_idempotency_key: ids.data.key }),
  });
  if (error) return spaceError(error, values);
  revalidatePath(`/app/${ids.data.workspaceId}`, "layout");
  return { status: "ok", message: `Added ${s.name}.` };
}

export async function archiveVenueSpace(
  _: SpaceActionState,
  form: FormData,
): Promise<SpaceActionState> {
  const parsed = z.object({ workspaceId: uuid, spaceId: uuid, version }).safeParse({
    workspaceId: form.get("workspaceId"),
    spaceId: form.get("spaceId"),
    version: form.get("version"),
  });
  if (!parsed.success) return fail("Reload the page and try again.");
  const denied = await authorize(parsed.data.workspaceId);
  if (denied) return denied;
  const supabase = await createUserClient();
  const { error } = await supabase.rpc("archive_venue_space", {
    p_wedding: parsed.data.workspaceId,
    p_space: parsed.data.spaceId,
    p_expected_version: parsed.data.version,
  });
  if (error) return fail(friendlyCandidateError(error));
  revalidatePath(`/app/${parsed.data.workspaceId}`, "layout");
  return { status: "ok", message: "Space removed." };
}
