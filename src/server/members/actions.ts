"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { MEMBERSHIP_ROLES, assignableRoles } from "@/domain/permissions";
import { requireCapability, ForbiddenError } from "@/server/auth/workspace-guard";
import { getSessionUser } from "@/server/auth/session";
import { createUserClient } from "@/server/supabase/server";
import { friendlyMemberError } from "./errors";
import { generateInviteToken, hashInviteToken, isWellFormedInviteToken } from "./invite-token";
import { requireSupabaseConfig } from "@/server/supabase/config";
import { parsePublicEnv } from "@/lib/env";

export type ActionState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "ok"; message: string; inviteUrl?: string };

const uuid = z.uuid();
const role = z.enum(MEMBERSHIP_ROLES);
const fail = (message: string): ActionState => ({ status: "error", message });
const membersPath = (w: string) => `/app/${w}/settings/members`;

async function guarded<T>(fn: () => Promise<T>): Promise<T | ActionState> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("You don't have permission to do that.");
    throw e;
  }
}

const inviteInput = z.object({
  workspaceId: uuid,
  email: z.string().trim().min(3).max(254),
  role,
});

export async function inviteCollaborator(_: ActionState, form: FormData): Promise<ActionState> {
  const parsed = inviteInput.safeParse({
    workspaceId: form.get("workspaceId"),
    email: form.get("email"),
    role: form.get("role"),
  });
  if (!parsed.success) return fail("Enter a valid email address and choose a role.");
  const { workspaceId, email } = parsed.data;

  return guarded(async () => {
    const access = await requireCapability(workspaceId, "members.manage");
    // UI hides disallowed roles; the server and database still enforce them.
    if (
      !assignableRoles(access.membership.role, access.membership.grants).includes(parsed.data.role)
    ) {
      return fail("You can't invite someone with that role.");
    }
    if (parsed.data.role === "owner") return fail("Owners can't be added by invitation.");

    const token = generateInviteToken();
    const supabase = await createUserClient();
    const { error } = await supabase.rpc("create_collaborator_invite", {
      p_wedding: workspaceId,
      p_email: email,
      p_role: parsed.data.role,
      p_token_hash: token.hash,
    });
    if (error) return fail(friendlyMemberError(error));

    revalidatePath(membersPath(workspaceId));
    const base = parsePublicEnv(process.env).appUrl;
    return {
      status: "ok",
      message: "Invitation created. Copy the link now. It is shown only once.",
      inviteUrl: new URL(`/invite/${token.raw}`, base).toString(),
    } satisfies ActionState;
  });
}

const revokeInput = z.object({ workspaceId: uuid, inviteId: uuid });

export async function revokeInvite(_: ActionState, form: FormData): Promise<ActionState> {
  const parsed = revokeInput.safeParse({
    workspaceId: form.get("workspaceId"),
    inviteId: form.get("inviteId"),
  });
  if (!parsed.success) return fail("That invitation couldn't be found.");
  return guarded(async () => {
    await requireCapability(parsed.data.workspaceId, "members.manage");
    const supabase = await createUserClient();
    const { error } = await supabase.rpc("revoke_collaborator_invite", {
      p_invite: parsed.data.inviteId,
    });
    if (error) return fail(friendlyMemberError(error));
    revalidatePath(membersPath(parsed.data.workspaceId));
    return { status: "ok", message: "Invitation revoked." } satisfies ActionState;
  });
}

const roleInput = z.object({
  workspaceId: uuid,
  membershipId: uuid,
  role,
  version: z.coerce.number().int().min(1),
});

export async function changeMemberRole(_: ActionState, form: FormData): Promise<ActionState> {
  const parsed = roleInput.safeParse({
    workspaceId: form.get("workspaceId"),
    membershipId: form.get("membershipId"),
    role: form.get("role"),
    version: form.get("version"),
  });
  if (!parsed.success) return fail("Choose a role and try again.");
  return guarded(async () => {
    await requireCapability(parsed.data.workspaceId, "members.manage");
    const supabase = await createUserClient();
    const { error } = await supabase.rpc("change_member_role", {
      p_membership: parsed.data.membershipId,
      p_role: parsed.data.role,
      p_expected_version: parsed.data.version,
    });
    if (error) return fail(friendlyMemberError(error));
    revalidatePath(membersPath(parsed.data.workspaceId));
    return { status: "ok", message: "Role updated." } satisfies ActionState;
  });
}

const grantInput = z.object({
  workspaceId: uuid,
  membershipId: uuid,
  manageMembers: z.enum(["true", "false"]),
  version: z.coerce.number().int().min(1),
});

export async function setPartnerGrant(_: ActionState, form: FormData): Promise<ActionState> {
  const parsed = grantInput.safeParse({
    workspaceId: form.get("workspaceId"),
    membershipId: form.get("membershipId"),
    manageMembers: form.get("manageMembers"),
    version: form.get("version"),
  });
  if (!parsed.success) return fail("That change couldn't be understood.");
  return guarded(async () => {
    await requireCapability(parsed.data.workspaceId, "workspace.manage");
    const supabase = await createUserClient();
    const { error } = await supabase.rpc("set_partner_permissions", {
      p_membership: parsed.data.membershipId,
      p_manage_members: parsed.data.manageMembers === "true",
      p_expected_version: parsed.data.version,
    });
    if (error) return fail(friendlyMemberError(error));
    revalidatePath(membersPath(parsed.data.workspaceId));
    return { status: "ok", message: "Permissions updated." } satisfies ActionState;
  });
}

const removeInput = z.object({
  workspaceId: uuid,
  membershipId: uuid,
  version: z.coerce.number().int().min(1),
  self: z.enum(["true", "false"]).default("false"),
});

export async function removeMember(_: ActionState, form: FormData): Promise<ActionState> {
  const parsed = removeInput.safeParse({
    workspaceId: form.get("workspaceId"),
    membershipId: form.get("membershipId"),
    version: form.get("version"),
    self: form.get("self") ?? "false",
  });
  if (!parsed.success) return fail("That member couldn't be found.");
  const leaving = parsed.data.self === "true";
  return guarded(async () => {
    // Leaving needs only membership; removing others needs administration rights.
    await requireCapability(parsed.data.workspaceId, leaving ? "workspace.view" : "members.manage");
    const supabase = await createUserClient();
    const { error } = await supabase.rpc("remove_member", {
      p_membership: parsed.data.membershipId,
      p_expected_version: parsed.data.version,
    });
    if (error) return fail(friendlyMemberError(error));
    if (leaving) redirect("/app");
    revalidatePath(membersPath(parsed.data.workspaceId));
    return {
      status: "ok",
      message: "Member removed. Their access has ended.",
    } satisfies ActionState;
  });
}

/** Redeems an invitation for the signed-in user. A POST action, never a GET. */
export async function redeemInvite(_: ActionState, form: FormData): Promise<ActionState> {
  const raw = String(form.get("token") ?? "");
  const user = await getSessionUser();
  if (!user) redirect(`/sign-in?next=${encodeURIComponent(`/invite/${raw}`)}`);
  const generic = fail(
    "This invitation isn't valid for the account you're signed in with. It may have expired, been revoked or been sent to a different email address. Ask the person who invited you for a new link.",
  );
  if (!isWellFormedInviteToken(raw)) return generic;

  requireSupabaseConfig();
  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc("redeem_collaborator_invite", {
    p_token_hash: hashInviteToken(raw),
  });
  if (error || typeof data !== "string") return generic;
  redirect(`/app/${data}`);
}
