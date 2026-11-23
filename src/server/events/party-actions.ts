"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { PARTY_MAX_EVENTS, partyExpiry } from "@/domain/events/party";
import { parsePublicEnv } from "@/lib/env";
import { ForbiddenError, requireCapability } from "@/server/auth/workspace-guard";
import { generateInviteToken } from "@/server/members/invite-token";
import { partyLinksEnabled } from "@/server/rsvp/flags";
import { createUserClient } from "@/server/supabase/server";
import type { EventActionState, IssuedLink } from "./actions";
import { friendlyEventError } from "./errors";

const uuid = z.uuid();
const version = z.coerce.number().int().min(0);

const fail = (message: string): EventActionState => ({
  status: "error",
  message,
  fieldErrors: {},
  values: {},
});

async function authorize(workspaceId: string): Promise<EventActionState | null> {
  if (!partyLinksEnabled()) return fail("One link for all events is turned off.");
  try {
    await requireCapability(workspaceId, "guests.manage");
    return null;
  } catch (e) {
    if (e instanceof ForbiddenError) return fail(friendlyEventError({ code: "42501" }));
    throw e;
  }
}

function partyLinkFor(raw: string): string | null {
  try {
    return new URL(`/rsvp/party/${raw}`, parsePublicEnv(process.env).appUrl).toString();
  } catch {
    return null;
  }
}

function friendlyPartyError(error: { code?: string }): string {
  switch (error.code) {
    case "23505":
      return "Some of these invitations already have a link for all events. Reload to see it.";
    case "22023":
      return "These invitations can't share one link. Each event can appear once, and every invitation must be for the same household or the same people. Reload and try again.";
    default:
      return friendlyEventError(error);
  }
}

/** Groups a party's per-event invitations under one new link. Nothing is sent. */
export async function createPartyLink(
  _: EventActionState,
  form: FormData,
): Promise<EventActionState> {
  const ids = z
    .object({
      workspaceId: uuid,
      key: z.string().min(8).max(128),
      invitationIds: z.array(uuid).min(2).max(PARTY_MAX_EVENTS),
    })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      key: form.get("idempotencyKey"),
      invitationIds: form.getAll("invitationId"),
    });
  if (!ids.success) return fail("Reload the page and try again.");
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;

  const supabase = await createUserClient();
  // The link lasts as long as the longest-lived invitation it covers; each event still keeps its
  // own expiry and reply-by date inside it.
  const invs = await supabase
    .from("invitations")
    .select("id, expires_at")
    .eq("wedding_id", ids.data.workspaceId)
    .in("id", ids.data.invitationIds);
  if (invs.error) return fail(friendlyEventError({}));
  const expires = partyExpiry(
    invs.data.map((i) => ({ expiresAt: i.expires_at })),
    new Date(),
  );
  if (!expires || invs.data.length !== ids.data.invitationIds.length) {
    return fail("These invitations changed. Reload the page and try again.");
  }
  const token = generateInviteToken();
  const { data, error } = await supabase.rpc("create_party_link", {
    p_wedding: ids.data.workspaceId,
    p_invitation_ids: ids.data.invitationIds,
    p_expires_at: expires,
    p_token_hash: token.hash,
    p_idempotency_key: ids.data.key,
  });
  if (error) return fail(friendlyPartyError(error));
  const row = data?.[0];
  if (!row) return fail(friendlyEventError({}));
  revalidatePath(`/app/${ids.data.workspaceId}`, "layout");
  const links: IssuedLink[] = [
    {
      invitationId: row.o_party_id,
      label: row.o_label,
      url: row.o_replayed ? null : partyLinkFor(token.raw),
    },
  ];
  return {
    status: "ok",
    message:
      "Link created for all their events. Nothing has been sent. The links for each event still work.",
    links,
  };
}

export async function reissuePartyLink(
  _: EventActionState,
  form: FormData,
): Promise<EventActionState> {
  const ids = z
    .object({ workspaceId: uuid, partyId: uuid, version, label: z.string().max(120) })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      partyId: form.get("partyId"),
      version: form.get("version"),
      label: form.get("label") ?? "",
    });
  if (!ids.success) return fail("Reload the page and try again.");
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const token = generateInviteToken();
  const supabase = await createUserClient();
  const { error } = await supabase.rpc("reissue_party_link", {
    p_wedding: ids.data.workspaceId,
    p_party_id: ids.data.partyId,
    p_expected_version: ids.data.version,
    p_token_hash: token.hash,
  });
  if (error) return fail(friendlyPartyError(error));
  revalidatePath(`/app/${ids.data.workspaceId}`, "layout");
  return {
    status: "ok",
    message: "New link created. The old link for all events no longer works.",
    links: [
      { invitationId: ids.data.partyId, label: ids.data.label, url: partyLinkFor(token.raw) },
    ],
  };
}

export async function revokePartyLink(
  _: EventActionState,
  form: FormData,
): Promise<EventActionState> {
  const ids = z.object({ workspaceId: uuid, partyId: uuid, version }).safeParse({
    workspaceId: form.get("workspaceId"),
    partyId: form.get("partyId"),
    version: form.get("version"),
  });
  if (!ids.success) return fail("Reload the page and try again.");
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const supabase = await createUserClient();
  const { error } = await supabase.rpc("revoke_party_link", {
    p_wedding: ids.data.workspaceId,
    p_party_id: ids.data.partyId,
    p_expected_version: ids.data.version,
  });
  if (error) return fail(friendlyPartyError(error));
  revalidatePath(`/app/${ids.data.workspaceId}`, "layout");
  return {
    status: "ok",
    message:
      "Revoked. The link for all events stops working now; each event's own link still works.",
  };
}
