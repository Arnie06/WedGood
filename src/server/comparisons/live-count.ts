import "server-only";
import type { CountChoice } from "@/domain/comparison/reprice";
import { hasCapability, type WorkspaceAccess } from "@/server/auth/workspace-guard";
import { loadEventDemand } from "@/server/events/demand";
import { loadEventLabels } from "@/server/timeline/queries";

export type LiveCounts = {
  /** False when this member may not read guest totals (ADR-031 D2). No counts are returned then. */
  visible: boolean;
  events: CountChoice[];
};

/**
 * Each event's planning number right now, for comparisons (REL-04). It reads the same
 * `event_demand` every other page uses, so a comparison never counts replies its own way.
 * An event nobody is invited to has no number (unknown), not zero.
 */
export async function loadLiveCounts(access: WorkspaceAccess): Promise<LiveCounts> {
  const workspaceId = access.wedding.id;
  const [records, demand] = await Promise.all([
    loadEventLabels(workspaceId),
    loadEventDemand(workspaceId, {
      canManageGuests: hasCapability(access, "guests.manage"),
      shareGuestTotals: access.wedding.shareGuestTotals,
    }),
  ]);
  if (!demand.visible) return { visible: false, events: [] };
  return {
    visible: true,
    // The reception first: it is the event most per-guest quotes are priced for.
    events: [...records]
      .sort((a, b) => Number(b.kind === "reception") - Number(a.kind === "reception"))
      .map((e) => {
        const d = demand.byEvent.get(e.id);
        return {
          eventId: e.id,
          eventName: e.name,
          planningNumber: d && d.invited > 0 ? d.planningNumber : null,
        };
      }),
  };
}
