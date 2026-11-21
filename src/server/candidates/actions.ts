"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import {
  parseCandidateInput,
  type CandidateField,
  type CandidateInput,
  type RawCandidateInput,
} from "@/domain/candidates/input";
import { ForbiddenError, requireCapability } from "@/server/auth/workspace-guard";
import { createUserClient } from "@/server/supabase/server";
import { loadWeddingSettings } from "@/server/workspace/queries";
import { friendlyCandidateError } from "./errors";

export type CandidateActionState =
  | { status: "idle" }
  | { status: "ok"; message: string }
  | {
      status: "error";
      message: string;
      fieldErrors: Partial<Record<CandidateField, string>>;
      values: RawCandidateInput;
    };

const uuid = z.uuid();
const version = z.coerce.number().int().min(1);
const idemKey = z.string().min(8).max(128);
const kindSchema = z.enum(["venue", "vendor"]);

function fail(
  message: string,
  fieldErrors: Partial<Record<CandidateField, string>> = {},
  values: RawCandidateInput = {},
): CandidateActionState {
  return { status: "error", message, fieldErrors, values };
}

async function authorize(workspaceId: string): Promise<CandidateActionState | null> {
  try {
    await requireCapability(workspaceId, "vendors.manage");
    return null;
  } catch (e) {
    if (e instanceof ForbiddenError) return fail(friendlyCandidateError({ code: "42501" }));
    throw e;
  }
}

function refresh(workspaceId: string) {
  revalidatePath(`/app/${workspaceId}`, "layout");
}

const FIELDS: CandidateField[] = [
  "name",
  "category",
  "sourceUrl",
  "sourceCheckedOn",
  "location",
  "pricingDisplay",
  "price",
  "priceBasis",
  "notes",
  "seatedCapacity",
  "ceremonyCapacity",
];

function readValues(form: FormData): RawCandidateInput {
  const out: RawCandidateInput = {};
  for (const f of FIELDS) {
    const v = form.get(f);
    out[f] = typeof v === "string" ? v : "";
  }
  return out;
}

/** Only sends arguments that carry a value, so unknown stays null in the database. */
function rpcFields(v: CandidateInput) {
  return {
    p_name: v.name,
    p_category: v.category,
    ...(v.sourceUrl !== null && { p_source_url: v.sourceUrl }),
    ...(v.sourceCheckedOn !== null && { p_source_checked_on: v.sourceCheckedOn }),
    ...(v.location !== null && { p_location: v.location }),
    ...(v.pricingDisplay !== null && { p_pricing_display: v.pricingDisplay }),
    ...(v.priceMinor !== null && { p_price_minor: v.priceMinor }),
    ...(v.priceBasis !== null && { p_price_basis: v.priceBasis }),
    ...(v.notes !== null && { p_notes: v.notes }),
    ...(v.seatedCapacity !== null && { p_seated_capacity: v.seatedCapacity }),
    ...(v.ceremonyCapacity !== null && { p_ceremony_capacity: v.ceremonyCapacity }),
  };
}

export async function createCandidate(
  _: CandidateActionState,
  form: FormData,
): Promise<CandidateActionState> {
  const values = readValues(form);
  const ids = z.object({ workspaceId: uuid, kind: kindSchema, key: idemKey }).safeParse({
    workspaceId: form.get("workspaceId"),
    kind: form.get("kind"),
    key: form.get("idempotencyKey"),
  });
  if (!ids.success) return fail("Reload the page and try again.", {}, values);
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;

  const settings = await loadWeddingSettings(ids.data.workspaceId);
  const parsed = parseCandidateInput(ids.data.kind, settings.baseCurrency, values);
  if (!parsed.ok) return fail("Please check the highlighted details.", parsed.errors, values);

  const supabase = await createUserClient();
  const { error } = await supabase.rpc("create_candidate", {
    p_wedding: ids.data.workspaceId,
    p_kind: ids.data.kind,
    p_idempotency_key: ids.data.key,
    ...rpcFields(parsed.value),
  });
  if (error) return fail(friendlyCandidateError(error), {}, values);
  refresh(ids.data.workspaceId);
  return { status: "ok", message: "Saved to your list." };
}

export async function updateCandidate(
  _: CandidateActionState,
  form: FormData,
): Promise<CandidateActionState> {
  const values = readValues(form);
  const ids = z
    .object({ workspaceId: uuid, candidateId: uuid, kind: kindSchema, version })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      candidateId: form.get("candidateId"),
      kind: form.get("kind"),
      version: form.get("version"),
    });
  if (!ids.success) return fail("Reload the page and try again.", {}, values);
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;

  const settings = await loadWeddingSettings(ids.data.workspaceId);
  const parsed = parseCandidateInput(ids.data.kind, settings.baseCurrency, values);
  if (!parsed.ok) return fail("Please check the highlighted details.", parsed.errors, values);

  const supabase = await createUserClient();
  const { error } = await supabase.rpc("update_candidate", {
    p_wedding: ids.data.workspaceId,
    p_candidate: ids.data.candidateId,
    p_expected_version: ids.data.version,
    ...rpcFields(parsed.value),
  });
  if (error) return fail(friendlyCandidateError(error), {}, values);
  refresh(ids.data.workspaceId);
  return { status: "ok", message: "Changes saved." };
}

export async function setCandidateFavorite(
  _: CandidateActionState,
  form: FormData,
): Promise<CandidateActionState> {
  const parsed = z
    .object({ workspaceId: uuid, candidateId: uuid, favorite: z.enum(["true", "false"]) })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      candidateId: form.get("candidateId"),
      favorite: form.get("favorite"),
    });
  if (!parsed.success) return fail("Reload the page and try again.");
  const denied = await authorize(parsed.data.workspaceId);
  if (denied) return denied;

  const supabase = await createUserClient();
  const { error } = await supabase.rpc("set_candidate_favorite", {
    p_wedding: parsed.data.workspaceId,
    p_candidate: parsed.data.candidateId,
    p_favorite: parsed.data.favorite === "true",
  });
  if (error) return fail(friendlyCandidateError(error));
  refresh(parsed.data.workspaceId);
  return {
    status: "ok",
    message: parsed.data.favorite === "true" ? "Added to favorites." : "Removed from favorites.",
  };
}

export async function archiveCandidate(
  _: CandidateActionState,
  form: FormData,
): Promise<CandidateActionState> {
  const parsed = z.object({ workspaceId: uuid, candidateId: uuid, version }).safeParse({
    workspaceId: form.get("workspaceId"),
    candidateId: form.get("candidateId"),
    version: form.get("version"),
  });
  if (!parsed.success) return fail("Reload the page and try again.");
  const denied = await authorize(parsed.data.workspaceId);
  if (denied) return denied;

  const supabase = await createUserClient();
  const { error } = await supabase.rpc("archive_candidate", {
    p_wedding: parsed.data.workspaceId,
    p_candidate: parsed.data.candidateId,
    p_expected_version: parsed.data.version,
  });
  if (error) return fail(friendlyCandidateError(error));
  refresh(parsed.data.workspaceId);
  redirect(`/app/${parsed.data.workspaceId}/discover`);
}
