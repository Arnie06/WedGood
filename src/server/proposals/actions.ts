"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import {
  parseLineInput,
  parseProposalInput,
  type LineField,
  type ProposalField,
  type RawLineInput,
  type RawProposalInput,
} from "@/domain/proposals/input";
import { MOVABLE_STAGES } from "@/domain/proposals/stages";
import { ForbiddenError, requireCapability } from "@/server/auth/workspace-guard";
import { createUserClient } from "@/server/supabase/server";
import { loadWeddingSettings } from "@/server/workspace/queries";
import { friendlyProposalError } from "./errors";

export type ProposalActionState =
  | { status: "idle" }
  | { status: "ok"; message: string }
  | {
      status: "error";
      message: string;
      fieldErrors: Partial<Record<ProposalField | LineField, string>>;
      values: Record<string, string>;
    };

const uuid = z.uuid();
const version = z.coerce.number().int().min(1);
const idemKey = z.string().min(8).max(128);

function fail(
  message: string,
  fieldErrors: Partial<Record<ProposalField | LineField, string>> = {},
  values: Record<string, string> = {},
): ProposalActionState {
  return { status: "error", message, fieldErrors, values };
}

async function authorize(workspaceId: string): Promise<ProposalActionState | null> {
  try {
    await requireCapability(workspaceId, "vendors.manage");
    return null;
  } catch (e) {
    if (e instanceof ForbiddenError) return fail(friendlyProposalError({ code: "42501" }));
    throw e;
  }
}

function refresh(workspaceId: string) {
  revalidatePath(`/app/${workspaceId}`, "layout");
}

function readValues<K extends string>(
  form: FormData,
  fields: readonly K[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = form.get(f);
    out[f] = typeof v === "string" ? v : "";
  }
  return out;
}

const PROPOSAL_FIELDS = ["title", "receivedOn", "validUntil", "sourceUrl", "notes"] as const;
const LINE_FIELDS = [
  "description",
  "costMode",
  "amount",
  "quantity",
  "minQty",
  "maxQty",
  "ratePercent",
  "percentBase",
  "requirement",
  "certainty",
  "includedIn",
  "evidence",
] as const;

/** Only sends arguments that carry a value, so unknown stays null in the database. */
function proposalArgs(v: {
  title: string;
  receivedOn: string | null;
  validUntil: string | null;
  sourceUrl: string | null;
  notes: string | null;
}) {
  return {
    p_title: v.title,
    ...(v.receivedOn !== null && { p_received_on: v.receivedOn }),
    ...(v.validUntil !== null && { p_valid_until: v.validUntil }),
    ...(v.sourceUrl !== null && { p_source_url: v.sourceUrl }),
    ...(v.notes !== null && { p_notes: v.notes }),
  };
}

function lineArgs(v: {
  description: string;
  costMode: string;
  amountMinor: number | null;
  quantity: number | null;
  minQty: number | null;
  maxQty: number | null;
  rateBp: number | null;
  percentBase: boolean;
  required: boolean;
  certainty: string;
  includedInLineId: string | null;
  evidence: string | null;
}) {
  return {
    p_description: v.description,
    p_cost_mode: v.costMode,
    p_percent_base: v.percentBase,
    p_required: v.required,
    p_certainty: v.certainty,
    ...(v.amountMinor !== null && { p_amount_minor: v.amountMinor }),
    ...(v.quantity !== null && { p_quantity: v.quantity }),
    ...(v.minQty !== null && { p_min_qty: v.minQty }),
    ...(v.maxQty !== null && { p_max_qty: v.maxQty }),
    ...(v.rateBp !== null && { p_rate_bp: v.rateBp }),
    ...(v.includedInLineId !== null && { p_included_in_line_id: v.includedInLineId }),
    ...(v.evidence !== null && { p_evidence: v.evidence }),
  };
}

// ---------------------------------------------------------------- stage

export async function setCandidateStage(
  _: ProposalActionState,
  form: FormData,
): Promise<ProposalActionState> {
  const parsed = z
    .object({
      workspaceId: uuid,
      candidateId: uuid,
      version,
      stage: z.enum(MOVABLE_STAGES as unknown as [string, ...string[]]),
    })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      candidateId: form.get("candidateId"),
      version: form.get("version"),
      stage: form.get("stage"),
    });
  if (!parsed.success) return fail("Reload the page and try again.");
  const denied = await authorize(parsed.data.workspaceId);
  if (denied) return denied;

  const supabase = await createUserClient();
  const { error } = await supabase.rpc("set_candidate_stage", {
    p_wedding: parsed.data.workspaceId,
    p_candidate: parsed.data.candidateId,
    p_expected_version: parsed.data.version,
    p_stage: parsed.data.stage,
  });
  if (error) return fail(friendlyProposalError(error));
  refresh(parsed.data.workspaceId);
  return { status: "ok", message: "Stage updated." };
}

// ---------------------------------------------------------------- proposals

export async function createProposal(
  _: ProposalActionState,
  form: FormData,
): Promise<ProposalActionState> {
  const values = readValues(form, PROPOSAL_FIELDS);
  const ids = z.object({ workspaceId: uuid, candidateId: uuid, key: idemKey }).safeParse({
    workspaceId: form.get("workspaceId"),
    candidateId: form.get("candidateId"),
    key: form.get("idempotencyKey"),
  });
  if (!ids.success) return fail("Reload the page and try again.", {}, values);
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;

  const parsed = parseProposalInput(values as RawProposalInput);
  if (!parsed.ok) return fail("Please check the highlighted details.", parsed.errors, values);

  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc("create_proposal", {
    p_wedding: ids.data.workspaceId,
    p_candidate: ids.data.candidateId,
    p_idempotency_key: ids.data.key,
    ...proposalArgs(parsed.value),
  });
  if (error || !data) return fail(friendlyProposalError(error ?? {}), {}, values);
  refresh(ids.data.workspaceId);
  redirect(`/app/${ids.data.workspaceId}/discover/${ids.data.candidateId}/quotes/${data}`);
}

export async function updateProposal(
  _: ProposalActionState,
  form: FormData,
): Promise<ProposalActionState> {
  const values = readValues(form, PROPOSAL_FIELDS);
  const ids = z.object({ workspaceId: uuid, proposalId: uuid, version }).safeParse({
    workspaceId: form.get("workspaceId"),
    proposalId: form.get("proposalId"),
    version: form.get("version"),
  });
  if (!ids.success) return fail("Reload the page and try again.", {}, values);
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;

  const parsed = parseProposalInput(values as RawProposalInput);
  if (!parsed.ok) return fail("Please check the highlighted details.", parsed.errors, values);

  const supabase = await createUserClient();
  const { error } = await supabase.rpc("update_proposal", {
    p_wedding: ids.data.workspaceId,
    p_proposal: ids.data.proposalId,
    p_expected_version: ids.data.version,
    ...proposalArgs(parsed.value),
  });
  if (error) return fail(friendlyProposalError(error), {}, values);
  refresh(ids.data.workspaceId);
  return { status: "ok", message: "Saved." };
}

export async function setProposalStatus(
  _: ProposalActionState,
  form: FormData,
): Promise<ProposalActionState> {
  const parsed = z
    .object({ workspaceId: uuid, proposalId: uuid, version, status: z.enum(["open", "declined"]) })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      proposalId: form.get("proposalId"),
      version: form.get("version"),
      status: form.get("status"),
    });
  if (!parsed.success) return fail("Reload the page and try again.");
  const denied = await authorize(parsed.data.workspaceId);
  if (denied) return denied;

  const supabase = await createUserClient();
  const { error } = await supabase.rpc("set_proposal_status", {
    p_wedding: parsed.data.workspaceId,
    p_proposal: parsed.data.proposalId,
    p_expected_version: parsed.data.version,
    p_status: parsed.data.status,
  });
  if (error) return fail(friendlyProposalError(error));
  refresh(parsed.data.workspaceId);
  return {
    status: "ok",
    message: parsed.data.status === "declined" ? "Marked as passed." : "Reopened.",
  };
}

export async function archiveProposal(
  _: ProposalActionState,
  form: FormData,
): Promise<ProposalActionState> {
  const parsed = z
    .object({ workspaceId: uuid, candidateId: uuid, proposalId: uuid, version })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      candidateId: form.get("candidateId"),
      proposalId: form.get("proposalId"),
      version: form.get("version"),
    });
  if (!parsed.success) return fail("Reload the page and try again.");
  const denied = await authorize(parsed.data.workspaceId);
  if (denied) return denied;

  const supabase = await createUserClient();
  const { error } = await supabase.rpc("archive_proposal", {
    p_wedding: parsed.data.workspaceId,
    p_proposal: parsed.data.proposalId,
    p_expected_version: parsed.data.version,
  });
  if (error) return fail(friendlyProposalError(error));
  refresh(parsed.data.workspaceId);
  redirect(`/app/${parsed.data.workspaceId}/discover/${parsed.data.candidateId}`);
}

// ---------------------------------------------------------------- lines

export async function addProposalLine(
  _: ProposalActionState,
  form: FormData,
): Promise<ProposalActionState> {
  const values = readValues(form, LINE_FIELDS);
  const ids = z.object({ workspaceId: uuid, proposalId: uuid, version, key: idemKey }).safeParse({
    workspaceId: form.get("workspaceId"),
    proposalId: form.get("proposalId"),
    version: form.get("version"),
    key: form.get("idempotencyKey"),
  });
  if (!ids.success) return fail("Reload the page and try again.", {}, values);
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;

  const settings = await loadWeddingSettings(ids.data.workspaceId);
  const parsed = parseLineInput(settings.baseCurrency, values as RawLineInput);
  if (!parsed.ok) return fail("Please check the highlighted details.", parsed.errors, values);

  const supabase = await createUserClient();
  const { error } = await supabase.rpc("add_proposal_line", {
    p_wedding: ids.data.workspaceId,
    p_proposal: ids.data.proposalId,
    p_expected_version: ids.data.version,
    p_idempotency_key: ids.data.key,
    ...lineArgs(parsed.value),
  });
  if (error) return fail(friendlyProposalError(error), {}, values);
  refresh(ids.data.workspaceId);
  return { status: "ok", message: "Cost added." };
}

export async function updateProposalLine(
  _: ProposalActionState,
  form: FormData,
): Promise<ProposalActionState> {
  const values = readValues(form, LINE_FIELDS);
  const ids = z.object({ workspaceId: uuid, lineId: uuid, version }).safeParse({
    workspaceId: form.get("workspaceId"),
    lineId: form.get("lineId"),
    version: form.get("version"),
  });
  if (!ids.success) return fail("Reload the page and try again.", {}, values);
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;

  const settings = await loadWeddingSettings(ids.data.workspaceId);
  const parsed = parseLineInput(settings.baseCurrency, values as RawLineInput);
  if (!parsed.ok) return fail("Please check the highlighted details.", parsed.errors, values);

  const supabase = await createUserClient();
  const { error } = await supabase.rpc("update_proposal_line", {
    p_wedding: ids.data.workspaceId,
    p_line: ids.data.lineId,
    p_expected_version: ids.data.version,
    ...lineArgs(parsed.value),
  });
  if (error) return fail(friendlyProposalError(error), {}, values);
  refresh(ids.data.workspaceId);
  return { status: "ok", message: "Saved." };
}

export async function removeProposalLine(
  _: ProposalActionState,
  form: FormData,
): Promise<ProposalActionState> {
  const parsed = z.object({ workspaceId: uuid, lineId: uuid, version }).safeParse({
    workspaceId: form.get("workspaceId"),
    lineId: form.get("lineId"),
    version: form.get("version"),
  });
  if (!parsed.success) return fail("Reload the page and try again.");
  const denied = await authorize(parsed.data.workspaceId);
  if (denied) return denied;

  const supabase = await createUserClient();
  const { error } = await supabase.rpc("remove_proposal_line", {
    p_wedding: parsed.data.workspaceId,
    p_line: parsed.data.lineId,
    p_expected_version: parsed.data.version,
  });
  if (error) return fail(friendlyProposalError(error));
  refresh(parsed.data.workspaceId);
  return { status: "ok", message: "Removed." };
}
