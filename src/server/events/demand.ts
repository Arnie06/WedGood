import "server-only";
import {
  buildDemand,
  isPlanningBasis,
  type EventDemand,
  type MealCount,
} from "@/domain/events/demand";
import { createUserClient } from "@/server/supabase/server";

export type EventDemandResult = {
  /** False when the caller may not read totals (a collaborator while sharing is off). */
  visible: boolean;
  /** Keyed by event id. Empty when not visible. */
  byEvent: ReadonlyMap<string, EventDemand>;
};

function mealsOf(value: unknown): MealCount[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((m) => {
    if (typeof m !== "object" || m === null) return [];
    const r = m as Record<string, unknown>;
    return typeof r.id === "string" &&
      typeof r.name === "string" &&
      typeof r.active === "boolean" &&
      typeof r.count === "number"
      ? [{ id: r.id, name: r.name, active: r.active, count: r.count }]
      : [];
  });
}

/**
 * The only reader of reply counts. Owner and partner always; other members only when the owner has
 * turned on "Let collaborators see guest totals". The database decides; `canSeeGuests` only tells us
 * whether an empty answer means "no events" or "not shared", so the page can say which.
 */
export async function loadEventDemand(
  workspaceId: string,
  opts: { canManageGuests: boolean; shareGuestTotals: boolean },
): Promise<EventDemandResult> {
  const visible = opts.canManageGuests || opts.shareGuestTotals;
  if (!visible) return { visible: false, byEvent: new Map() };
  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc("event_demand", { p_wedding: workspaceId });
  if (error) throw new Error("Could not load guest totals");
  const byEvent = new Map<string, EventDemand>();
  for (const r of data) {
    byEvent.set(
      r.event_id,
      buildDemand(
        {
          eventId: r.event_id,
          invited: r.invited,
          yes: r.yes,
          waitingOpen: r.waiting_open,
          waitingClosed: r.waiting_closed,
          no: r.no,
          openPlusOnes: r.open_plus_ones,
          seatedConfirmed: r.seated_confirmed,
          seatedTentative: r.seated_tentative,
          yesWithoutMeal: r.yes_without_meal,
          meals: mealsOf(r.meals),
        },
        {
          basis: isPlanningBasis(r.planning_basis) ? r.planning_basis : "auto",
          includeOpenPlusOnes: r.plan_open_plus_ones,
        },
      ),
    );
  }
  return { visible: true, byEvent };
}
