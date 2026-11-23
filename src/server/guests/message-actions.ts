"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ForbiddenError, requireCapability } from "@/server/auth/workspace-guard";
import { getMailProvider, type MailOutcome } from "@/server/mail/provider";
import { guestEmailEnabled } from "@/server/rsvp/flags";
import { createUserClient } from "@/server/supabase/server";
import { planEventMessages } from "./messages";

export type GuestMessageActionState =
  { status: "idle" } | { status: "ok"; message: string } | { status: "error"; message: string };

const OFF = "Guest emails are switched off.";
const RELOAD = "Reload the page and try again.";
const MAX_ITEMS = 200;

function friendlyMessageError(error: { code?: string }): string {
  switch (error.code) {
    case "42501":
      return "Only the workspace owner can approve sending email to guests.";
    case "28000":
      return "Please sign in again to continue.";
    case "55000":
      return "This email changed or was already handled. Reload to see the latest.";
    case "GM409":
      return "This email no longer matches: a reply, the guest's address or the invitation changed. Discard it and prepare a new one.";
    case "22023":
      return "Please check the details and try again.";
    default:
      return "We couldn't do that. Nothing was sent. Try again.";
  }
}

/** Gives the denial wording for a missing capability instead of an error page. */
async function guard(workspaceId: string, capability: "guests.manage" | "external.send") {
  try {
    await requireCapability(workspaceId, capability);
    return null;
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return capability === "external.send"
        ? friendlyMessageError({ code: "42501" })
        : "Guest emails can only be managed by people who manage guests.";
    }
    throw e;
  }
}

/**
 * Prepares drafts for one event: confirmations for invitations a guest has replied to, or
 * reminders for people still waiting. The text is written from one read of the replies; the
 * database re-checks each item against that read and skips anything that changed or exists.
 * Nothing is sent.
 */
export async function prepareGuestMessages(
  _: GuestMessageActionState,
  form: FormData,
): Promise<GuestMessageActionState> {
  if (!guestEmailEnabled()) return { status: "error", message: OFF };
  const parsed = z
    .object({
      workspaceId: z.uuid(),
      eventId: z.uuid(),
      kind: z.enum(["rsvp_confirmation", "reply_reminder"]),
    })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      eventId: form.get("eventId"),
      kind: form.get("kind"),
    });
  if (!parsed.success) return { status: "error", message: RELOAD };
  const { workspaceId, eventId, kind } = parsed.data;
  const denied = await guard(workspaceId, "guests.manage");
  if (denied) return { status: "error", message: denied };
  const access = await requireCapability(workspaceId, "guests.manage");

  const planned = await planEventMessages(workspaceId, eventId, kind, access.wedding, new Date());
  if (!planned) return { status: "error", message: RELOAD };
  if (planned.length === 0) {
    return {
      status: "ok",
      message:
        kind === "rsvp_confirmation"
          ? "No one to confirm: no guest with an email address has replied to this event yet."
          : "No one to remind: everyone with an email address on an open invitation has replied.",
    };
  }
  const items = planned.slice(0, MAX_ITEMS).map((p) => ({
    kind: p.kind,
    invitationId: p.invitationId,
    guestId: p.guestId,
    dedupeKey: p.dedupeKey,
    stateHash: p.stateHash,
    subject: p.subject,
    body: p.body,
  }));
  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc("prepare_guest_messages", {
    p_wedding: workspaceId,
    p_items: items,
  });
  if (error) return { status: "error", message: friendlyMessageError(error) };
  const counts = z.object({ created: z.number().int(), skipped: z.number().int() }).safeParse(data);
  if (!counts.success) return { status: "error", message: RELOAD };
  revalidatePath(`/app/${workspaceId}/guests/messages`);
  const { created, skipped } = counts.data;
  const more = planned.length > MAX_ITEMS ? ` Prepare again for the next ${MAX_ITEMS}.` : "";
  const noun = kind === "rsvp_confirmation" ? "confirmation" : "reminder";
  if (created === 0) {
    return {
      status: "ok",
      message: `No new ${noun}s: they are already prepared for today, or the replies changed while preparing.${more}`,
    };
  }
  return {
    status: "ok",
    message: `Prepared ${created} ${noun}${created === 1 ? "" : "s"} to review${
      skipped > 0 ? ` (${skipped} already prepared or no longer needed)` : ""
    }. Nothing has been sent.${more}`,
  };
}

const oneMessage = z.object({
  workspaceId: z.uuid(),
  messageId: z.uuid(),
  version: z.coerce.number().int().min(1).max(999_999_999),
});
function parseOne(form: FormData) {
  return oneMessage.safeParse({
    workspaceId: form.get("workspaceId"),
    messageId: form.get("messageId"),
    version: form.get("version"),
  });
}

export async function discardGuestMessage(
  _: GuestMessageActionState,
  form: FormData,
): Promise<GuestMessageActionState> {
  if (!guestEmailEnabled()) return { status: "error", message: OFF };
  const parsed = parseOne(form);
  if (!parsed.success) return { status: "error", message: RELOAD };
  const { workspaceId, messageId, version } = parsed.data;
  const denied = await guard(workspaceId, "guests.manage");
  if (denied) return { status: "error", message: denied };
  const supabase = await createUserClient();
  const { error } = await supabase.rpc("discard_guest_message", {
    p_wedding: workspaceId,
    p_message: messageId,
    p_expected_version: version,
  });
  if (error) return { status: "error", message: friendlyMessageError(error) };
  revalidatePath(`/app/${workspaceId}/guests/messages`);
  return { status: "ok", message: "Discarded. It won't be sent." };
}

/** Adapter call that never throws: an adapter exception is a failed send, not a crash. */
async function deliver(message: {
  to: string;
  subject: string;
  text: string;
  idempotencyKey: string;
}): Promise<MailOutcome> {
  try {
    return await getMailProvider().send(message);
  } catch {
    return { status: "failed", reason: "The email service did not answer." };
  }
}

const begun = z.object({
  id: z.uuid(),
  version: z.number().int(),
  to: z.string().min(3).max(254),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
});

/**
 * The owner's approval of one message. The database marks it as being sent (and re-checks that it
 * still matches the replies and address), then the provider is called with the message id as the
 * idempotency key, then the outcome is recorded. Success is claimed only on the provider's receipt.
 */
export async function sendGuestMessage(
  _: GuestMessageActionState,
  form: FormData,
): Promise<GuestMessageActionState> {
  if (!guestEmailEnabled()) return { status: "error", message: OFF };
  const parsed = parseOne(form);
  if (!parsed.success) return { status: "error", message: RELOAD };
  const { workspaceId, messageId, version } = parsed.data;
  const denied = await guard(workspaceId, "external.send");
  if (denied) return { status: "error", message: denied };
  const provider = getMailProvider();
  if (!provider.configured) {
    return { status: "error", message: "Email sending isn't set up, so nothing was sent." };
  }

  const supabase = await createUserClient();
  const start = await supabase.rpc("begin_guest_message_send", {
    p_wedding: workspaceId,
    p_message: messageId,
    p_expected_version: version,
  });
  if (start.error) return { status: "error", message: friendlyMessageError(start.error) };
  const msg = begun.safeParse(start.data);
  if (!msg.success) return { status: "error", message: RELOAD };

  const outcome = await deliver({
    to: msg.data.to,
    subject: msg.data.subject,
    text: msg.data.body,
    idempotencyKey: msg.data.id,
  });
  const error =
    outcome.status === "failed"
      ? outcome.reason.slice(0, 300)
      : outcome.status === "rate_limited"
        ? `Rate limited; try again in ${outcome.retryAfterSeconds} seconds.`
        : null;
  const finish = await supabase.rpc("finish_guest_message_send", {
    p_wedding: workspaceId,
    p_message: messageId,
    p_version: msg.data.version,
    p_outcome: outcome.status,
    p_provider: provider.id,
    ...(outcome.status === "succeeded" ? { p_receipt: outcome.providerReceipt } : {}),
    ...(error ? { p_error: error } : {}),
  });
  revalidatePath(`/app/${workspaceId}/guests/messages`);
  if (finish.error) {
    // The provider answered but the record didn't save; the row stays "sending" and can be
    // approved again after ten minutes with the same idempotency key.
    return {
      status: "error",
      message:
        outcome.status === "succeeded"
          ? "The email service accepted it, but we couldn't record that. Reload before trying again."
          : "Nothing was sent, and we couldn't record the result. Reload and try again.",
    };
  }
  switch (outcome.status) {
    case "succeeded":
      return {
        status: "ok",
        message: provider.captureOnly
          ? "Captured by the local test sink. It was not delivered to anyone."
          : "Handed to the email service. That doesn't mean it was delivered or read.",
      };
    case "unconfigured":
      return { status: "error", message: "Email sending isn't set up, so nothing was sent." };
    case "rate_limited":
      return {
        status: "error",
        message: `The email service asked us to wait. Try again in ${outcome.retryAfterSeconds} seconds.`,
      };
    case "failed":
      return { status: "error", message: "The email service refused it. Nothing was sent." };
  }
}
