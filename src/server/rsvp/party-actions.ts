"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { friendlyRsvpError } from "@/server/events/errors";
import { createAdminClient } from "@/server/supabase/admin";
import { formBuilderEnabled, guestDetailsEnabled, partyLinksEnabled } from "./flags";
import {
  clientKey,
  rsvpPartyViewSchema,
  toPublicPartyView,
  tokenDigest,
  type RsvpPartyView,
} from "./public";

export type PartyRsvpActionState =
  | { status: "idle" }
  | { status: "ok"; message: string; view: RsvpPartyView }
  | { status: "error"; message: string; view?: RsvpPartyView };

const BROKEN = "This link isn't working. Ask the couple for a new one.";
const MAX_PAYLOAD = 64_000;

const uuid = z.uuid();
// Answers to the couple's questions (UX-11): question key to value. The database checks the keys
// and values against the published version named by the reply.
const answersSchema = z
  .record(z.string().regex(/^q_[a-z0-9]{8}$/), z.string().trim().min(1).max(500))
  .refine((r) => Object.keys(r).length <= 10)
  .optional();
const repliesSchema = z
  .array(
    z.strictObject({
      invitationId: uuid,
      expectedVersion: z.number().int().min(0).max(999_999_999),
      formVersionId: uuid.nullable().optional(),
      responses: z
        .array(
          z.strictObject({
            memberId: uuid,
            status: z.enum(["accepted", "declined"]),
            mealOptionId: uuid.nullable(),
            // Taking a guest-added plus-one off the reply (UX-09); the database checks who they are.
            remove: z.literal(true).optional(),
            dietary: z.string().trim().min(1).max(500).optional(),
            accessibility: z.string().trim().min(1).max(500).optional(),
            answers: answersSchema,
          }),
        )
        .max(13),
      plusOne: z
        .strictObject({
          name: z.string().trim().min(1).max(120),
          mealOptionId: uuid.nullable(),
          dietary: z.string().trim().min(1).max(500).optional(),
          accessibility: z.string().trim().min(1).max(500).optional(),
          answers: answersSchema,
        })
        .nullable(),
    }),
  )
  .min(1)
  .max(12);

/** Public, accountless reply for every event of a party link. The token is the only credential. */
export async function submitPartyRsvp(
  _: PartyRsvpActionState,
  form: FormData,
): Promise<PartyRsvpActionState> {
  if (!partyLinksEnabled()) return { status: "error", message: BROKEN };
  const token = form.get("token");
  const digest = typeof token === "string" ? tokenDigest(token) : null;
  if (!digest) return { status: "error", message: BROKEN };
  const raw = form.get("replies");
  let parsedJson: unknown = null;
  if (typeof raw === "string" && raw.length <= MAX_PAYLOAD) {
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      parsedJson = null;
    }
  }
  const replies = repliesSchema.safeParse(parsedJson);
  if (!replies.success) {
    return { status: "error", message: "Choose yes or no for at least one person." };
  }
  // A decline never carries a meal or notes; the database ignores both too. With the dietary and
  // accessibility questions switched off, any such text is dropped here.
  // The couple's questions likewise: with that switch off, no answers and no form version are sent.
  const askDetails = guestDetailsEnabled();
  const forms = formBuilderEnabled();
  const payload = replies.data.map(({ formVersionId, ...r }) => {
    const version = forms ? (formVersionId ?? null) : null;
    const withAnswers = (a: Record<string, string> | undefined) =>
      version !== null && a && Object.keys(a).length > 0 ? { answers: a } : {};
    return {
      ...r,
      formVersionId: version,
      responses: r.responses.map(({ dietary, accessibility, answers, ...x }) => ({
        ...x,
        mealOptionId: x.status === "accepted" ? x.mealOptionId : null,
        ...(x.status === "accepted" && askDetails && { dietary, accessibility }),
        ...(x.status === "accepted" && withAnswers(answers)),
      })),
      plusOne: r.plusOne
        ? (({ dietary, accessibility, answers, ...p }) => ({
            ...p,
            ...(askDetails && { dietary, accessibility }),
            ...withAnswers(answers),
          }))(r.plusOne)
        : null,
    };
  });

  const admin = createAdminClient();
  const client = await clientKey();
  if (!admin || !client) {
    return {
      status: "error",
      message: "Responses aren't available right now. Please try again later.",
    };
  }
  const { data, error } = await admin.rpc("rsvp_party_submit", {
    p_token_hash: digest,
    p_client: client,
    p_replies: payload,
  });
  if (error) {
    // After a stale or closed event, return the current state so the guest can review it.
    let view: RsvpPartyView | undefined;
    // A missing required answer (RF422) keeps the guest's draft: nothing to reload.
    if (error.code === "55000" || error.code === "RS410") {
      const again = await admin.rpc("rsvp_party_view", { p_token_hash: digest, p_client: client });
      const parsed = rsvpPartyViewSchema.safeParse(again.data);
      if (parsed.success) view = toPublicPartyView(parsed.data);
    }
    const message =
      error.code === "RS410"
        ? "The reply date for one of these events has passed. We've loaded the latest. Please check your answers and send again."
        : friendlyRsvpError(error);
    return view ? { status: "error", message, view } : { status: "error", message };
  }
  if (data === null) return { status: "error", message: BROKEN };
  const parsed = rsvpPartyViewSchema.safeParse(data);
  if (!parsed.success) return { status: "error", message: friendlyRsvpError({}) };
  revalidatePath(`/app/${parsed.data.workspaceId}`, "layout");
  return {
    status: "ok",
    message: "Thank you. Your reply is saved.",
    view: toPublicPartyView(parsed.data),
  };
}
