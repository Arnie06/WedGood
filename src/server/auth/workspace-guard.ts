import "server-only";
import { notFound } from "next/navigation";
import { cache } from "react";
import {
  can,
  isMembershipRole,
  parseGrants,
  type Capability,
  type MembershipRole,
  type MemberGrants,
} from "@/domain/permissions";
import { createUserClient } from "@/server/supabase/server";
import { requireSessionUser, type SessionUser } from "./session";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type WorkspaceAccess = {
  user: SessionUser;
  wedding: {
    id: string;
    name: string;
    date: string | null;
    timezone: string;
    /** Owner setting: editors and viewers may see guest totals (never names). */
    shareGuestTotals: boolean;
  };
  membership: { id: string; role: MembershipRole; grants: MemberGrants; version: number };
};

/**
 * Route guard for every /app/[w] page, layout and action. Signed-out visitors
 * go to sign-in; signed-in non-members and unknown ids get the same 404, so
 * the existence of another workspace is never revealed. The database enforces
 * the same rule through RLS regardless of what this function decides.
 */
export const requireWorkspace = cache(async (workspaceId: string): Promise<WorkspaceAccess> => {
  const user = await requireSessionUser(`/app/${encodeURIComponent(workspaceId)}`);
  if (!UUID.test(workspaceId)) notFound();

  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from("memberships")
    .select(
      "id, role, permissions, version, weddings!inner(id, name, date, timezone, share_guest_totals)",
    )
    .eq("wedding_id", workspaceId)
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw new Error("Could not verify workspace access");
  if (!data || !isMembershipRole(data.role)) notFound();

  const wedding = Array.isArray(data.weddings) ? data.weddings[0] : data.weddings;
  if (!wedding) notFound();

  return {
    user,
    wedding: {
      id: wedding.id,
      name: wedding.name,
      date: wedding.date,
      timezone: wedding.timezone,
      shareGuestTotals: wedding.share_guest_totals,
    },
    membership: {
      id: data.id,
      role: data.role,
      grants: parseGrants(data.permissions),
      version: data.version,
    },
  };
});

export function hasCapability(access: WorkspaceAccess, capability: Capability): boolean {
  return can(access.membership.role, capability, access.membership.grants);
}

/** For server actions: re-checks membership and capability, throws when denied. */
export async function requireCapability(
  workspaceId: string,
  capability: Capability,
): Promise<WorkspaceAccess> {
  const access = await requireWorkspace(workspaceId);
  if (!hasCapability(access, capability)) throw new ForbiddenError(capability);
  return access;
}

export class ForbiddenError extends Error {
  constructor(public readonly capability: Capability) {
    super(`Missing capability: ${capability}`);
    this.name = "ForbiddenError";
  }
}
