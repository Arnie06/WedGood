import "server-only";

import { cookies } from "next/headers";
import { resolveDensity, type Density } from "@/domain/display/density";
import type { MembershipRole } from "@/domain/permissions";

/**
 * The spacing choice is a per-browser display preference, not wedding data, so it lives in a
 * cookie scoped to one workspace's path. A planner can keep a different setting per wedding, and
 * the cookie is never sent to any other workspace or page.
 */
export function densityCookie(workspaceId: string): { name: string; path: string } {
  return { name: `wg-density-${workspaceId}`, path: `/app/${workspaceId}` };
}

export async function readDensity(workspaceId: string, role: MembershipRole): Promise<Density> {
  const store = await cookies();
  return resolveDensity(store.get(densityCookie(workspaceId).name)?.value, role);
}
