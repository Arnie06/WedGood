import "server-only";
import { isMembershipRole, type MembershipRole } from "@/domain/permissions";
import { createUserClient } from "@/server/supabase/server";

export type PendingInvite = { id: string; email: string; role: MembershipRole; expiresAt: string };

/** Unexpired, unredeemed, unrevoked invitations; RLS limits this to member administrators. */
export async function listPendingInvites(workspaceId: string): Promise<PendingInvite[]> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from("collaborator_invites")
    .select("id, email, role, expires_at")
    .eq("wedding_id", workspaceId)
    .is("redeemed_at", null)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error("Could not load invitations");
  return data.flatMap((i) =>
    isMembershipRole(i.role)
      ? [{ id: i.id, email: i.email, role: i.role, expiresAt: i.expires_at }]
      : [],
  );
}
