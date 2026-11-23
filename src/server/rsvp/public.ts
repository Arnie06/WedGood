import "server-only";
import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { z } from "zod";
import { createAdminClient } from "@/server/supabase/admin";
import { hashInviteToken, isWellFormedInviteToken } from "@/server/members/invite-token";
import { parseDefinition } from "@/domain/guests/rsvp-form";
import { parseClientIpConfig, throttleSubject } from "./client-ip";
import { addToCalendarEnabled, formBuilderEnabled, guestDetailsEnabled } from "./flags";

const status = z.enum(["pending", "accepted", "declined"]);
// UX-11: the published version of the couple's questions, or null. Questions are re-checked with
// the domain parser; a malformed definition fails the whole view rather than half-rendering.
const formSchema = z
  .object({
    versionId: z.string(),
    version: z.number().int(),
    questions: z.unknown(),
  })
  .transform((f, ctx) => {
    const parsed = parseDefinition({ questions: f.questions });
    if (!parsed) {
      ctx.addIssue({ code: "custom", message: "bad form" });
      return z.NEVER;
    }
    return { versionId: f.versionId, version: f.version, questions: parsed.questions };
  })
  .nullable();
export const rsvpViewSchema = z.object({
  workspaceId: z.string(),
  weddingName: z.string(),
  label: z.string(),
  version: z.number().int(),
  deadline: z.string().nullable(),
  closed: z.boolean(),
  plusOneRemaining: z.number().int(),
  event: z.object({
    name: z.string(),
    kind: z.string(),
    localDate: z.string().nullable(),
    timezone: z.string(),
  }),
  mealOptions: z.array(z.object({ id: z.string(), name: z.string() })),
  form: formSchema,
  members: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      isPlusOne: z.boolean(),
      status,
      mealOptionId: z.string().nullable(),
      // UX-07: whether the guest has answered the dietary and accessibility questions. The
      // answers themselves are never part of any guest-facing view (decision Q2).
      detailsSaved: z.boolean(),
      personKey: z.string(),
      // UX-11: which of the couple's questions this person has answered, never the answers.
      answered: z.array(z.string()),
    }),
  ),
});
type FullView = z.infer<typeof rsvpViewSchema>;
/**
 * What a guest receives: no workspace id, no other households, no contact details, and no
 * dietary or accessibility text. `askDetails` says whether those questions are switched on;
 * `form` is null when the couple's questions are switched off.
 */
export type RsvpView = Omit<FullView, "workspaceId"> & {
  askDetails: boolean;
  addToCalendar: boolean;
};

export function toPublicView(full: FullView): RsvpView {
  const { workspaceId: _workspaceId, ...rest } = full;
  void _workspaceId;
  return {
    ...rest,
    form: formBuilderEnabled() ? rest.form : null,
    askDetails: guestDetailsEnabled(),
    addToCalendar: addToCalendarEnabled(),
  };
}

export type RsvpLookup =
  | { kind: "ok"; view: RsvpView }
  | { kind: "invalid" }
  | { kind: "throttled" }
  | { kind: "unavailable" };

/**
 * Privacy-preserving client key for the failed-guess throttle: a hash, never the address itself.
 * The address comes from the trusted header named by CLIENT_IP_HEADER (UX-15, see ./client-ip).
 * Null in production when that header isn't configured: callers then report "unavailable"
 * instead of throttling on a value any client can forge.
 */
export async function clientKey(): Promise<string | null> {
  const config = parseClientIpConfig(
    process.env.CLIENT_IP_HEADER,
    process.env.NODE_ENV === "production",
  );
  const h = await headers();
  const subject = throttleSubject((name) => h.get(name), config);
  if (subject === null) return null;
  return createHash("sha256").update(`rsvp|${subject}`).digest("hex").slice(0, 32);
}

/** Shown when a reply named no form version although the event's questions are published. */
export const FORM_CHANGED =
  "The couple's questions have been updated. We've loaded them. Please check your answers and send again.";

export function tokenDigest(raw: string): string | null {
  return isWellFormedInviteToken(raw) ? hashInviteToken(raw) : null;
}

/** One event inside a party link (UX-06): the single-event view plus the invitation it answers. */
const partyEventSchema = rsvpViewSchema
  .omit({ workspaceId: true, weddingName: true, label: true })
  .extend({ invitationId: z.string() });
export const rsvpPartyViewSchema = z.object({
  workspaceId: z.string(),
  weddingName: z.string(),
  label: z.string(),
  events: z.array(partyEventSchema).max(12),
});
type FullPartyView = z.infer<typeof rsvpPartyViewSchema>;
export type RsvpPartyEvent = z.infer<typeof partyEventSchema> & { askDetails: boolean };
/** What a guest receives from a party link: no workspace id, contact details or other parties. */
export type RsvpPartyView = Omit<FullPartyView, "workspaceId" | "events"> & {
  events: RsvpPartyEvent[];
  addToCalendar: boolean;
};

export function toPublicPartyView(full: FullPartyView): RsvpPartyView {
  const { workspaceId: _workspaceId, events, ...rest } = full;
  void _workspaceId;
  const askDetails = guestDetailsEnabled();
  const forms = formBuilderEnabled();
  return {
    ...rest,
    events: events.map((e) => ({ ...e, form: forms ? e.form : null, askDetails })),
    addToCalendar: addToCalendarEnabled(),
  };
}

export type RsvpPartyLookup =
  | { kind: "ok"; view: RsvpPartyView }
  | { kind: "invalid" }
  | { kind: "throttled" }
  | { kind: "unavailable" };

/** Party link lookup; failure reasons collapsed exactly as for a single-event link. */
export async function lookupParty(raw: string): Promise<RsvpPartyLookup> {
  const admin = createAdminClient();
  const client = await clientKey();
  if (!admin || !client) return { kind: "unavailable" };
  const digest = tokenDigest(raw);
  if (!digest) {
    await admin.rpc("rsvp_party_view", { p_token_hash: "0".repeat(64), p_client: client });
    return { kind: "invalid" };
  }
  const { data, error } = await admin.rpc("rsvp_party_view", {
    p_token_hash: digest,
    p_client: client,
  });
  if (error) return error.code === "RS429" ? { kind: "throttled" } : { kind: "unavailable" };
  if (data === null) return { kind: "invalid" };
  const parsed = rsvpPartyViewSchema.safeParse(data);
  return parsed.success
    ? { kind: "ok", view: toPublicPartyView(parsed.data) }
    : { kind: "unavailable" };
}

/** Loads the invitation projection for a raw token. Failure reasons are deliberately collapsed. */
export async function lookupInvitation(raw: string): Promise<RsvpLookup> {
  const admin = createAdminClient();
  const client = await clientKey();
  if (!admin || !client) return { kind: "unavailable" };
  const digest = tokenDigest(raw);
  if (!digest) {
    // Malformed tokens count as failed guesses too.
    await admin.rpc("rsvp_view", { p_token_hash: "0".repeat(64), p_client: client });
    return { kind: "invalid" };
  }
  const { data, error } = await admin.rpc("rsvp_view", { p_token_hash: digest, p_client: client });
  if (error) return error.code === "RS429" ? { kind: "throttled" } : { kind: "unavailable" };
  if (data === null) return { kind: "invalid" };
  const parsed = rsvpViewSchema.safeParse(data);
  return parsed.success ? { kind: "ok", view: toPublicView(parsed.data) } : { kind: "unavailable" };
}
