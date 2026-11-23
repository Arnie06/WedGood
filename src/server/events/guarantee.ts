import "server-only";
import type { GuaranteeMeal } from "@/domain/events/guarantee";
import { loadEventDemand } from "@/server/events/demand";
import { createUserClient } from "@/server/supabase/server";
import { loadEventLabels } from "@/server/timeline/queries";

export type Guarantee = {
  id: string;
  eventId: string;
  /** The caterer, when one was chosen. */
  candidateId: string | null;
  count: number;
  status: "locked" | "superseded";
  yesAtLock: number;
  withoutMealAtLock: number;
  meals: GuaranteeMeal[];
  dueOn: string | null;
  supersedesId: string | null;
  reason: string | null;
  lockedAt: string;
  /** Who locked it, as a member's user id; null when that account is gone. */
  lockedBy: string | null;
};

export type EventGuarantees = {
  /** The locked count, or null while none is locked. */
  current: Guarantee | null;
  /** Earlier, superseded counts, newest first. */
  history: Guarantee[];
};

function mealsOf(value: unknown): GuaranteeMeal[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((m) => {
    if (typeof m !== "object" || m === null) return [];
    const r = m as Record<string, unknown>;
    return typeof r.id === "string" && typeof r.name === "string" && typeof r.count === "number"
      ? [
          {
            id: r.id,
            name: r.name,
            active: typeof r.active === "boolean" ? r.active : true,
            count: r.count,
          },
        ]
      : [];
  });
}

/**
 * Caterer counts by event. Reply data, so the database returns rows only to owner and partner, or
 * to other members while the owner shares guest totals; for anyone else this is simply empty and
 * the page says totals are not shared.
 */
export async function loadGuarantees(workspaceId: string): Promise<Map<string, EventGuarantees>> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from("catering_guarantees")
    .select(
      "id, event_id, candidate_id, status, guaranteed_count, yes_at_lock, without_meal_at_lock, meals, due_on, supersedes_id, reason, locked_at, locked_by",
    )
    .eq("wedding_id", workspaceId)
    .order("locked_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(500);
  if (error) throw new Error("Could not load caterer counts");
  const byEvent = new Map<string, EventGuarantees>();
  for (const r of data) {
    const g: Guarantee = {
      id: r.id,
      eventId: r.event_id,
      candidateId: r.candidate_id,
      count: r.guaranteed_count,
      status: r.status === "locked" ? "locked" : "superseded",
      yesAtLock: r.yes_at_lock,
      withoutMealAtLock: r.without_meal_at_lock,
      meals: mealsOf(r.meals),
      dueOn: r.due_on,
      supersedesId: r.supersedes_id,
      reason: r.reason,
      lockedAt: r.locked_at,
      lockedBy: r.locked_by,
    };
    const slot = byEvent.get(g.eventId) ?? { current: null, history: [] };
    if (g.status === "locked") slot.current = g;
    else slot.history.push(g);
    byEvent.set(g.eventId, slot);
  }
  return byEvent;
}

/** Member roles by user id, so a page can say "locked by partner" without a name or email. */
export async function loadMemberRoles(workspaceId: string): Promise<Map<string, string>> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from("memberships")
    .select("user_id, role")
    .eq("wedding_id", workspaceId)
    .limit(200);
  if (error) throw new Error("Could not load members");
  return new Map(data.map((m) => [m.user_id, m.role as string]));
}

export type DriftRow = {
  eventId: string;
  eventName: string;
  locked: number;
  yes: number;
  waiting: number;
};

/**
 * Locked caterer counts set against today's replies, for pages that show a drift note (Seating,
 * Budget). Empty unless the member may read guest totals, because the comparison reveals the
 * attending count. Events with no locked count are left out.
 */
export async function loadDriftRows(
  workspaceId: string,
  opts: { canManageGuests: boolean; shareGuestTotals: boolean },
): Promise<DriftRow[]> {
  if (!opts.canManageGuests && !opts.shareGuestTotals) return [];
  const [guarantees, demand, labels] = await Promise.all([
    loadGuarantees(workspaceId),
    loadEventDemand(workspaceId, opts),
    loadEventLabels(workspaceId),
  ]);
  const rows: DriftRow[] = [];
  for (const e of labels) {
    const locked = guarantees.get(e.id)?.current;
    const d = demand.byEvent.get(e.id);
    if (!locked || !d) continue;
    rows.push({
      eventId: e.id,
      eventName: e.name,
      locked: locked.count,
      yes: d.yes,
      waiting: d.waiting,
    });
  }
  return rows;
}
