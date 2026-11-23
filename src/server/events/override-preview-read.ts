import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  overrideImpact,
  type OverrideAnswer,
  type OverrideImpactItem,
} from "@/domain/events/override-impact";
import type { RsvpStatus } from "@/domain/guests/rsvp";
import { snapshotState } from "@/domain/seating/plan";
import type { Database } from "@/server/db/database.types";

// Not marked server-only so the integration test can run these exact reads with a signed-in test
// client. App code goes through the previewOverride and overrideResponse actions.

export type OverridePreview = {
  /** The answer saved now. It can differ from what the page showed if someone changed it since. */
  current: OverrideAnswer;
  /** The answer that would be saved (a meal is dropped unless attending). */
  to: OverrideAnswer;
  changed: boolean;
  items: OverrideImpactItem[];
  /**
   * Fingerprint of what the person was shown: the member's version plus every item. Saving
   * recomputes it and refuses to save on a mismatch, so a reply that moved in between is shown
   * rather than silently overwritten.
   */
  basis: string;
};

const statusOf = (v: string): RsvpStatus => (v === "accepted" || v === "declined" ? v : "pending");

function mealsOf(value: unknown) {
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
 * Read-only preview of `override_rsvp_response` for one active invitation member (UX-02). Every row
 * comes through RLS: members, seating and meals need `can_manage_guests`, caterer counts need
 * `can_read_guest_totals` (which guest managers always pass). Returns null when the member is not
 * active in this workspace or not visible to the caller. Throws when a read fails, so an effect is
 * never left out silently.
 */
export async function readOverridePreview(
  supabase: SupabaseClient<Database>,
  workspaceId: string,
  memberId: string,
  choice: OverrideAnswer,
): Promise<OverridePreview | null> {
  const member = await supabase
    .from("invitation_members")
    .select("id, event_id, guest_id, rsvp_status, meal_option_id, version")
    .eq("wedding_id", workspaceId)
    .eq("id", memberId)
    .eq("active", true)
    .maybeSingle();
  if (member.error) throw new Error("Could not load the preview");
  if (!member.data) return null;
  const m = member.data;

  const [demand, layout, guarantee] = await Promise.all([
    supabase.rpc("event_demand", { p_wedding: workspaceId }),
    supabase
      .from("seating_layouts")
      .select("id, allow_tentative, revision, finalized_revision")
      .eq("wedding_id", workspaceId)
      .eq("event_id", m.event_id)
      .maybeSingle(),
    supabase
      .from("catering_guarantees")
      .select("guaranteed_count")
      .eq("wedding_id", workspaceId)
      .eq("event_id", m.event_id)
      .eq("status", "locked")
      .maybeSingle(),
  ]);
  if (demand.error || layout.error || guarantee.error) {
    throw new Error("Could not load the preview");
  }
  const counts = demand.data.find((d) => d.event_id === m.event_id);

  let seat: { tableLabel: string; seatNumber: number | null; tentative: boolean } | null = null;
  if (layout.data) {
    const a = await supabase
      .from("seat_assignments")
      .select("table_id, seat_number, tentative")
      .eq("wedding_id", workspaceId)
      .eq("layout_id", layout.data.id)
      .eq("guest_id", m.guest_id)
      .maybeSingle();
    if (a.error) throw new Error("Could not load the preview");
    if (a.data) {
      const t = await supabase
        .from("seating_tables")
        .select("label")
        .eq("wedding_id", workspaceId)
        .eq("id", a.data.table_id)
        .maybeSingle();
      if (t.error) throw new Error("Could not load the preview");
      seat = {
        tableLabel: t.data?.label ?? "a table",
        seatNumber: a.data.seat_number,
        tentative: a.data.tentative,
      };
    }
  }

  const current: OverrideAnswer = {
    status: statusOf(m.rsvp_status),
    mealOptionId: m.meal_option_id,
  };
  const impact = overrideImpact({
    from: current,
    to: choice,
    yes: counts?.yes ?? 0,
    yesWithoutMeal: counts?.yes_without_meal ?? 0,
    meals: mealsOf(counts?.meals),
    seat,
    layout: layout.data
      ? {
          allowTentative: layout.data.allow_tentative,
          snapshot: snapshotState({
            revision: layout.data.revision,
            finalizedRevision: layout.data.finalized_revision,
          }),
        }
      : null,
    lockedCount: guarantee.data?.guaranteed_count ?? null,
  });

  const basis = createHash("sha256")
    .update(JSON.stringify([m.id, m.version, impact.to, impact.items]))
    .digest("base64url");
  return { current, to: impact.to, changed: impact.changed, items: impact.items, basis };
}
