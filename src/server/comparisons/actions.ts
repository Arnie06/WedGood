"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { evaluateComparison } from "@/domain/comparison/evaluate";
import { buildFigures, decisionWarnings } from "@/domain/comparison/figures";
import {
  DEFAULT_CRITERIA,
  parseCriteria,
  parseGuestCount,
  parseRating,
  parseSetup,
  type ComparisonField,
} from "@/domain/comparison/input";
import { toOptionInputs } from "@/features/compare/mappers";
import { ForbiddenError, requireCapability } from "@/server/auth/workspace-guard";
import { createUserClient } from "@/server/supabase/server";
import { friendlyComparisonError } from "./errors";
import { loadComparison } from "./queries";

export type ComparisonActionState =
  | { status: "idle" }
  | { status: "ok"; message: string }
  | {
      status: "error";
      message: string;
      fieldErrors: Partial<Record<ComparisonField, string>>;
      values: Record<string, string | string[]>;
    };

const uuid = z.uuid();
const version = z.coerce.number().int().min(1);
const idemKey = z.string().min(8).max(128);

function fail(
  message: string,
  fieldErrors: Partial<Record<ComparisonField, string>> = {},
  values: Record<string, string | string[]> = {},
): ComparisonActionState {
  return { status: "error", message, fieldErrors, values };
}

async function authorize(workspaceId: string): Promise<ComparisonActionState | null> {
  try {
    await requireCapability(workspaceId, "vendors.manage");
    return null;
  } catch (e) {
    if (e instanceof ForbiddenError) return fail(friendlyComparisonError({ code: "42501" }));
    throw e;
  }
}

function refresh(workspaceId: string) {
  revalidatePath(`/app/${workspaceId}`, "layout");
}

function str(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
}
function strs(form: FormData, name: string): string[] {
  return form.getAll(name).filter((v): v is string => typeof v === "string");
}

export async function createComparison(
  _: ComparisonActionState,
  form: FormData,
): Promise<ComparisonActionState> {
  const values = {
    title: str(form, "title"),
    guestCount: str(form, "guestCount"),
    proposalIds: strs(form, "proposalIds"),
  };
  const ids = z.object({ workspaceId: uuid, key: idemKey }).safeParse({
    workspaceId: form.get("workspaceId"),
    key: form.get("idempotencyKey"),
  });
  if (!ids.success) return fail("Reload the page and try again.", {}, values);
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;

  const parsed = parseSetup(values);
  if (!parsed.ok) return fail("Please check the highlighted details.", parsed.errors, values);

  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc("create_comparison", {
    p_wedding: ids.data.workspaceId,
    p_title: parsed.value.title,
    p_guest_count: parsed.value.guestCount,
    p_proposals: parsed.value.proposalIds,
    p_criteria: DEFAULT_CRITERIA.map((c) => ({ id: randomUUID(), ...c })),
    p_idempotency_key: ids.data.key,
  });
  if (error || !data) return fail(friendlyComparisonError(error ?? {}), {}, values);
  refresh(ids.data.workspaceId);
  redirect(`/app/${ids.data.workspaceId}/discover/compare/${data}`);
}

export async function updateComparison(
  _: ComparisonActionState,
  form: FormData,
): Promise<ComparisonActionState> {
  const criterionId = strs(form, "criterionId");
  const criterionLabel = strs(form, "criterionLabel");
  const criterionWeight = strs(form, "criterionWeight");
  const values = {
    title: str(form, "title"),
    guestCount: str(form, "guestCount"),
    criterionId,
    criterionLabel,
    criterionWeight,
    acceptsUnknowns: str(form, "acceptsUnknowns"),
  };
  const ids = z.object({ workspaceId: uuid, comparisonId: uuid, version }).safeParse({
    workspaceId: form.get("workspaceId"),
    comparisonId: form.get("comparisonId"),
    version: form.get("version"),
  });
  if (!ids.success) return fail("Reload the page and try again.", {}, values);
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;

  const errors: Partial<Record<ComparisonField, string>> = {};
  const title = values.title.trim();
  if (title.length < 1 || title.length > 160) errors.title = "Give this comparison a name.";
  const guestCount = parseGuestCount(values.guestCount);
  if (guestCount === null) errors.guestCount = "Enter a whole number of guests, 1 or more.";
  const rows = criterionLabel.map((label, i) => ({
    id: /^[A-Za-z0-9-]{1,40}$/.test(criterionId[i] ?? "")
      ? (criterionId[i] as string)
      : randomUUID(),
    label,
    weight: criterionWeight[i] ?? "",
  }));
  const criteria = parseCriteria(rows);
  if (!criteria.ok) Object.assign(errors, criteria.errors);
  if (Object.keys(errors).length > 0 || !criteria.ok || guestCount === null) {
    return fail("Please check the highlighted details.", errors, values);
  }

  const supabase = await createUserClient();
  const { error } = await supabase.rpc("update_comparison", {
    p_wedding: ids.data.workspaceId,
    p_comparison: ids.data.comparisonId,
    p_expected_version: ids.data.version,
    p_title: title,
    p_guest_count: guestCount,
    p_criteria: criteria.value,
    p_accepts_unknowns: values.acceptsUnknowns === "on",
  });
  if (error) return fail(friendlyComparisonError(error), {}, values);
  refresh(ids.data.workspaceId);
  return { status: "ok", message: "Saved." };
}

const RATING_KEY = /^rating:([0-9a-f-]{36}):([A-Za-z0-9-]{1,40})$/;

export async function saveRatings(
  _: ComparisonActionState,
  form: FormData,
): Promise<ComparisonActionState> {
  const ids = z.object({ workspaceId: uuid, comparisonId: uuid, version }).safeParse({
    workspaceId: form.get("workspaceId"),
    comparisonId: form.get("comparisonId"),
    version: form.get("version"),
  });
  const values: Record<string, string> = {};
  if (!ids.success) return fail("Reload the page and try again.");
  const ratings: Record<string, Record<string, number>> = {};
  let invalid = false;
  for (const [key, raw] of form.entries()) {
    const m = RATING_KEY.exec(key);
    if (!m || typeof raw !== "string") continue;
    values[key] = raw;
    const r = parseRating(raw);
    if (r === "invalid") invalid = true;
    else if (r !== null) (ratings[m[1] as string] ??= {})[m[2] as string] = r;
  }
  if (invalid) {
    return fail(
      "Ratings are whole numbers from 0 to 100, or leave a box empty.",
      { ratings: "Ratings are whole numbers from 0 to 100." },
      values,
    );
  }
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;

  const supabase = await createUserClient();
  const { error } = await supabase.rpc("set_comparison_ratings", {
    p_wedding: ids.data.workspaceId,
    p_comparison: ids.data.comparisonId,
    p_expected_version: ids.data.version,
    p_ratings: ratings,
  });
  if (error) return fail(friendlyComparisonError(error), {}, values);
  refresh(ids.data.workspaceId);
  return { status: "ok", message: "Ratings saved." };
}

export async function decideComparison(
  _: ComparisonActionState,
  form: FormData,
): Promise<ComparisonActionState> {
  const note = str(form, "note");
  const ids = z
    .object({ workspaceId: uuid, comparisonId: uuid, proposalId: uuid, version, key: idemKey })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      comparisonId: form.get("comparisonId"),
      proposalId: form.get("proposalId"),
      version: form.get("version"),
      key: form.get("idempotencyKey"),
    });
  if (!ids.success) return fail("Choose one of the quotes, then try again.", {}, { note });
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  if (note.length > 1000) return fail("Keep the note under 1,000 characters.", {}, { note });

  const cmp = await loadComparison(ids.data.workspaceId, ids.data.comparisonId);
  if (!cmp || cmp.version !== ids.data.version) {
    return fail(friendlyComparisonError({ code: "55000" }), {}, { note });
  }
  const evaluation = evaluateComparison({
    guestCount: cmp.guestCount,
    currency: cmp.currency,
    criteria: cmp.criteria,
    options: toOptionInputs(cmp),
    acceptsUnknowns: cmp.acceptsUnknowns,
  });
  const chosen = evaluation.options.find((o) => o.proposalId === ids.data.proposalId);
  if (!chosen || !chosen.comparable) {
    return fail("That quote can't be chosen from this comparison.", {}, { note });
  }
  const acknowledged = str(form, "acknowledged") === "on";
  if (decisionWarnings(evaluation, ids.data.proposalId).length > 0 && !acknowledged) {
    return fail("Please confirm you've read the warnings on this option first.", {}, { note });
  }

  const supabase = await createUserClient();
  const { error } = await supabase.rpc("decide_comparison", {
    p_wedding: ids.data.workspaceId,
    p_comparison: ids.data.comparisonId,
    p_expected_version: ids.data.version,
    p_proposal: ids.data.proposalId,
    p_figures: buildFigures(evaluation),
    p_acknowledged: acknowledged,
    p_idempotency_key: ids.data.key,
    ...(note.trim() !== "" && { p_note: note.trim() }),
  });
  if (error) return fail(friendlyComparisonError(error), {}, { note });
  refresh(ids.data.workspaceId);
  return { status: "ok", message: "Decision recorded. Nothing has been booked." };
}

export async function archiveComparison(
  _: ComparisonActionState,
  form: FormData,
): Promise<ComparisonActionState> {
  const ids = z.object({ workspaceId: uuid, comparisonId: uuid, version }).safeParse({
    workspaceId: form.get("workspaceId"),
    comparisonId: form.get("comparisonId"),
    version: form.get("version"),
  });
  if (!ids.success) return fail("Reload the page and try again.");
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const supabase = await createUserClient();
  const { error } = await supabase.rpc("archive_comparison", {
    p_wedding: ids.data.workspaceId,
    p_comparison: ids.data.comparisonId,
    p_expected_version: ids.data.version,
  });
  if (error) return fail(friendlyComparisonError(error));
  refresh(ids.data.workspaceId);
  redirect(`/app/${ids.data.workspaceId}/discover/compare`);
}
