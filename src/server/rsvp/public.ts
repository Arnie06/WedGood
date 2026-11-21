import "server-only";
import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { z } from "zod";
import { createAdminClient } from "@/server/supabase/admin";
import { hashInviteToken, isWellFormedInviteToken } from "@/server/members/invite-token";

const status = z.enum(["pending", "accepted", "declined"]);
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
  members: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      isPlusOne: z.boolean(),
      status,
      mealOptionId: z.string().nullable(),
    }),
  ),
});
type FullView = z.infer<typeof rsvpViewSchema>;
/** What a guest receives: no workspace id, no other households, no contact details. */
export type RsvpView = Omit<FullView, "workspaceId">;

export function toPublicView(full: FullView): RsvpView {
  const { workspaceId: _workspaceId, ...rest } = full;
  void _workspaceId;
  return rest;
}

export type RsvpLookup =
  | { kind: "ok"; view: RsvpView }
  | { kind: "invalid" }
  | { kind: "throttled" }
  | { kind: "unavailable" };

/** Privacy-preserving client key for throttling: a hash, never the address itself. */
export async function clientKey(): Promise<string> {
  const h = await headers();
  const forwarded =
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? "unknown";
  return createHash("sha256").update(`rsvp|${forwarded}`).digest("hex").slice(0, 32);
}

export function tokenDigest(raw: string): string | null {
  return isWellFormedInviteToken(raw) ? hashInviteToken(raw) : null;
}

/** Loads the invitation projection for a raw token. Failure reasons are deliberately collapsed. */
export async function lookupInvitation(raw: string): Promise<RsvpLookup> {
  const admin = createAdminClient();
  if (!admin) return { kind: "unavailable" };
  const client = await clientKey();
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
