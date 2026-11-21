"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { todayInZone } from "@/domain/dates/date-only";
import {
  bookingFieldNames,
  parseBookingInput,
  parsePaymentInput,
  type BookingInput,
} from "@/domain/ledger/input";
import { ForbiddenError, requireCapability } from "@/server/auth/workspace-guard";
import { loadBudget } from "@/server/budget/queries";
import { createUserClient } from "@/server/supabase/server";
import { loadWeddingSettings } from "@/server/workspace/queries";
import { friendlyLedgerError } from "./errors";
import { loadLedger } from "./queries";

export type LedgerActionState =
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

function fail(
  message: string,
  fieldErrors: Record<string, string> = {},
  values: Record<string, string> = {},
): LedgerActionState {
  return { status: "error", message, fieldErrors, values };
}

async function authorize(workspaceId: string): Promise<LedgerActionState | null> {
  try {
    await requireCapability(workspaceId, "budget.manage");
    return null;
  } catch (e) {
    if (e instanceof ForbiddenError) return fail(friendlyLedgerError({ code: "42501" }));
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

const BOOKING_FIELDS = bookingFieldNames();
const bookingArgs = (b: BookingInput) => ({
  p_title: b.title,
  p_amount_minor: b.amountMinor,
  p_allocations: b.allocations.map((a) => ({ itemId: a.itemId, amountMinor: a.amountMinor })),
  p_installments: b.installments.map((i) => ({
    dueOn: i.dueOn,
    amountMinor: i.amountMinor,
    ...(i.label !== null && { label: i.label }),
  })),
  p_confirmed: b.confirmed,
  ...(b.signedOn !== null && { p_signed_on: b.signedOn }),
});

/** Costs a new or amended booking may cover: not covered by another booking, no direct payments. */
async function coverableItemIds(workspaceId: string, ignoreCommitment?: string) {
  const [budget, ledger] = await Promise.all([loadBudget(workspaceId), loadLedger(workspaceId)]);
  const covered = new Set(
    ledger.allocations
      .filter((a) => a.active && a.commitmentId !== ignoreCommitment)
      .map((a) => a.budgetItemId),
  );
  const paid = new Set(
    ledger.payments.filter((p) => !p.voided && p.budgetItemId !== null).map((p) => p.budgetItemId),
  );
  return new Set(budget.items.map((i) => i.id).filter((id) => !covered.has(id) && !paid.has(id)));
}

// ---------------------------------------------------------------- booking

export async function bookCommitment(
  _: LedgerActionState,
  form: FormData,
): Promise<LedgerActionState> {
  const values = readValues(form, BOOKING_FIELDS);
  const ids = z
    .object({
      workspaceId: uuid,
      candidateId: uuid,
      version,
      key: idemKey,
      proposalId: z.union([uuid, z.literal("")]),
    })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      candidateId: form.get("candidateId"),
      version: form.get("version"),
      key: form.get("idempotencyKey"),
      proposalId: form.get("proposalId") ?? "",
    });
  if (!ids.success) return fail("Reload the page and try again.", {}, values);
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;

  const settings = await loadWeddingSettings(ids.data.workspaceId);
  const parsed = parseBookingInput(
    values,
    settings.baseCurrency,
    await coverableItemIds(ids.data.workspaceId),
  );
  if (!parsed.ok) return fail("Please check the highlighted details.", parsed.errors, values);

  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc("book_commitment", {
    p_wedding: ids.data.workspaceId,
    p_candidate: ids.data.candidateId,
    p_expected_candidate_version: ids.data.version,
    p_idempotency_key: ids.data.key,
    ...(ids.data.proposalId !== "" && { p_proposal: ids.data.proposalId }),
    ...bookingArgs(parsed.value),
  });
  if (error || typeof data !== "string") return fail(friendlyLedgerError(error ?? {}), {}, values);
  refresh(ids.data.workspaceId);
  redirect(`/app/${ids.data.workspaceId}/plan/budget/bookings/${data}`);
}

export async function amendCommitment(
  _: LedgerActionState,
  form: FormData,
): Promise<LedgerActionState> {
  const values = readValues(form, BOOKING_FIELDS);
  const ids = z.object({ workspaceId: uuid, commitmentId: uuid, version, key: idemKey }).safeParse({
    workspaceId: form.get("workspaceId"),
    commitmentId: form.get("commitmentId"),
    version: form.get("version"),
    key: form.get("idempotencyKey"),
  });
  if (!ids.success) return fail("Reload the page and try again.", {}, values);
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;

  const settings = await loadWeddingSettings(ids.data.workspaceId);
  const parsed = parseBookingInput(
    values,
    settings.baseCurrency,
    await coverableItemIds(ids.data.workspaceId, ids.data.commitmentId),
  );
  if (!parsed.ok) return fail("Please check the highlighted details.", parsed.errors, values);

  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc("amend_commitment", {
    p_wedding: ids.data.workspaceId,
    p_commitment: ids.data.commitmentId,
    p_expected_version: ids.data.version,
    p_idempotency_key: ids.data.key,
    ...bookingArgs(parsed.value),
  });
  if (error || typeof data !== "string") return fail(friendlyLedgerError(error ?? {}), {}, values);
  refresh(ids.data.workspaceId);
  redirect(`/app/${ids.data.workspaceId}/plan/budget/bookings/${data}`);
}

// ---------------------------------------------------------------- payments

const PAYMENT_FIELDS = [
  "itemId",
  "kind",
  "amount",
  "paidOn",
  "method",
  "note",
  "externalRef",
] as const;

/** Records money that has already moved, on a booking (commitmentId) or on one unbooked cost (itemId). */
export async function recordPayment(
  _: LedgerActionState,
  form: FormData,
): Promise<LedgerActionState> {
  const values = readValues(form, PAYMENT_FIELDS);
  const ids = z
    .object({
      workspaceId: uuid,
      commitmentId: z.union([uuid, z.literal("")]),
      itemId: z.union([uuid, z.literal("")]),
      key: idemKey,
    })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      commitmentId: form.get("commitmentId") ?? "",
      itemId: form.get("itemId") ?? "",
      key: form.get("idempotencyKey"),
    });
  if (!ids.success || (ids.data.commitmentId === "") === (ids.data.itemId === "")) {
    // An unbooked cost is chosen in the form, so a missing choice is a field error, not a reload.
    if (ids.success && ids.data.commitmentId === "" && ids.data.itemId === "") {
      return fail("Please check the highlighted details.", { itemId: "Choose a cost." }, values);
    }
    return fail("Reload the page and try again.", {}, values);
  }
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;

  const settings = await loadWeddingSettings(ids.data.workspaceId);
  const today = todayInZone(settings.timezone);
  const parsed = parsePaymentInput(
    {
      kind: values.kind,
      amount: values.amount,
      paidOn: values.paidOn,
      method: values.method,
      note: values.note,
      externalRef: values.externalRef,
    },
    settings.baseCurrency,
    today,
  );
  if (!parsed.ok) return fail("Please check the highlighted details.", parsed.errors, values);

  const supabase = await createUserClient();
  const p = parsed.value;
  const { error } = await supabase.rpc("record_payment", {
    p_wedding: ids.data.workspaceId,
    p_kind: p.kind,
    p_amount_minor: p.amountMinor,
    p_paid_on: p.paidOn,
    p_idempotency_key: ids.data.key,
    ...(ids.data.commitmentId !== "" && { p_commitment: ids.data.commitmentId }),
    ...(ids.data.itemId !== "" && { p_item: ids.data.itemId }),
    ...(p.method !== null && { p_method: p.method }),
    ...(p.note !== null && { p_note: p.note }),
    ...(p.externalRef !== null && { p_external_ref: p.externalRef }),
  });
  if (error) return fail(friendlyLedgerError(error), {}, values);
  refresh(ids.data.workspaceId);
  return {
    status: "ok",
    message: p.kind === "refund" ? "Refund recorded." : "Payment recorded.",
  };
}

export async function voidPayment(
  _: LedgerActionState,
  form: FormData,
): Promise<LedgerActionState> {
  const values = readValues(form, ["reason"]);
  const ids = z.object({ workspaceId: uuid, paymentId: uuid }).safeParse({
    workspaceId: form.get("workspaceId"),
    paymentId: form.get("paymentId"),
  });
  if (!ids.success) return fail("Reload the page and try again.", {}, values);
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const reason = (values.reason ?? "").trim();
  if (reason === "" || reason.length > 200) {
    return fail(
      "Please check the highlighted details.",
      { reason: "Say briefly why (up to 200 characters). It stays in the history." },
      values,
    );
  }
  const supabase = await createUserClient();
  const { error } = await supabase.rpc("void_payment", {
    p_wedding: ids.data.workspaceId,
    p_payment: ids.data.paymentId,
    p_reason: reason,
  });
  if (error) return fail(friendlyLedgerError(error), {}, values);
  refresh(ids.data.workspaceId);
  return { status: "ok", message: "Marked as entered by mistake." };
}
