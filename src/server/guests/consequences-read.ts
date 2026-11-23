import type { SupabaseClient } from "@supabase/supabase-js";
import { buildDemand, isPlanningBasis, type MealCount } from "@/domain/events/demand";
import {
  guestConsequences,
  matchFrozenSeat,
  waitingCounts,
  type Consequences,
} from "@/domain/guests/consequences";
import type { ReplyChange } from "@/domain/guests/history";
import type { RsvpStatus } from "@/domain/guests/rsvp";
import { snapshotState } from "@/domain/seating/plan";
import { parseFrozenPlan } from "@/domain/seating/versions";
import type { Database } from "@/server/db/database.types";

// Not marked server-only so the integration test can run these exact reads with a signed-in test
// client. App code must go through loadGuestConsequences (src/server/guests/consequences.ts).

export type EventConsequences = {
  eventId: string;
  eventName: string;
  /** The latest change for this event, worded like the reply history. */
  change: ReplyChange;
  consequences: Consequences;
};

const statusOf = (v: string): RsvpStatus => (v === "accepted" || v === "declined" ? v : "pending");
const fail = (): never => {
  throw new Error("Could not load what this change affected");
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
 * The consequences of a guest's latest answer change on each event (UX-05). Read-only, over
 * existing tables; nothing is written. Every row comes through RLS: reply history, invitations,
 * seating and Needs attention items need `can_manage_guests`; caterer counts need
 * `can_read_guest_totals`; budget item names are readable by every member. A caller without the
 * guests capability therefore gets an empty list. Throws when a read fails, so a consequence is
 * never left out silently. Archived guests are left out of every count, so they get an empty list.
 */
export async function readGuestConsequences(
  supabase: SupabaseClient<Database>,
  workspaceId: string,
  guestId: string,
  weddingTimeZone: string,
): Promise<EventConsequences[]> {
  const [guestRes, changesRes] = await Promise.all([
    supabase
      .from("guests")
      .select("id, full_name, archived_at")
      .eq("wedding_id", workspaceId)
      .eq("id", guestId)
      .maybeSingle(),
    supabase
      .from("rsvp_changes")
      .select(
        "id, event_id, from_status, to_status, from_meal_option_id, to_meal_option_id, source, reason, occurred_at",
      )
      .eq("wedding_id", workspaceId)
      .eq("guest_id", guestId)
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(200),
  ]);
  if (guestRes.error || changesRes.error) fail();
  const guest = guestRes.data;
  if (!guest || guest.archived_at) return [];

  // Latest change per event (rows arrive newest first).
  const latest = new Map<string, NonNullable<typeof changesRes.data>[number]>();
  for (const c of changesRes.data ?? []) if (!latest.has(c.event_id)) latest.set(c.event_id, c);
  if (latest.size === 0) return [];
  const eventIds = [...latest.keys()];

  const [events, members, meals, demand, layouts, guarantees, attention, budget, sameName] =
    await Promise.all([
      supabase.from("events").select("id, name").eq("wedding_id", workspaceId).in("id", eventIds),
      supabase
        .from("invitation_members")
        .select("event_id, invitation_id, rsvp_status, meal_option_id")
        .eq("wedding_id", workspaceId)
        .eq("guest_id", guestId)
        .eq("active", true)
        .in("event_id", eventIds),
      supabase
        .from("meal_options")
        .select("id, name")
        .eq("wedding_id", workspaceId)
        .in("event_id", eventIds)
        .limit(500),
      supabase.rpc("event_demand", { p_wedding: workspaceId }),
      supabase
        .from("seating_layouts")
        .select("id, event_id, revision, finalized_revision, finalized_at, snapshot")
        .eq("wedding_id", workspaceId)
        .in("event_id", eventIds),
      supabase
        .from("catering_guarantees")
        .select("event_id, guaranteed_count, locked_at")
        .eq("wedding_id", workspaceId)
        .eq("status", "locked")
        .in("event_id", eventIds),
      supabase
        .from("attention_items")
        .select("event_id")
        .eq("wedding_id", workspaceId)
        .eq("kind", "seats_released")
        .eq("status", "open")
        .in("event_id", eventIds),
      supabase
        .from("budget_items")
        .select("name, count_source, count_event_id")
        .eq("wedding_id", workspaceId)
        .eq("cost_mode", "per_guest")
        .is("archived_at", null)
        .in("count_source", ["event_yes", "event_plan"])
        .in("count_event_id", eventIds)
        .order("name"),
      supabase
        .from("guests")
        .select("id", { count: "exact", head: true })
        .eq("wedding_id", workspaceId)
        .eq("full_name", guest.full_name),
    ]);
  if (
    events.error ||
    members.error ||
    meals.error ||
    demand.error ||
    layouts.error ||
    guarantees.error ||
    attention.error ||
    budget.error ||
    sameName.error
  ) {
    fail();
  }

  const layoutIds = (layouts.data ?? []).map((l) => l.id);
  const invitationIds = [...new Set((members.data ?? []).map((m) => m.invitation_id))];
  const [seats, invitations] = await Promise.all([
    layoutIds.length > 0
      ? supabase
          .from("seat_assignments")
          .select("layout_id, table_id, seat_number, tentative")
          .eq("wedding_id", workspaceId)
          .eq("guest_id", guestId)
          .in("layout_id", layoutIds)
      : Promise.resolve({ data: [], error: null }),
    invitationIds.length > 0
      ? supabase
          .from("invitations")
          .select("id, deadline, expires_at")
          .eq("wedding_id", workspaceId)
          .in("id", invitationIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (seats.error || invitations.error) fail();
  const tableIds = (seats.data ?? []).map((s) => s.table_id);
  const tables =
    tableIds.length > 0
      ? await supabase
          .from("seating_tables")
          .select("id, label")
          .eq("wedding_id", workspaceId)
          .in("id", tableIds)
      : { data: [], error: null };
  if (tables.error) fail();

  const mealName = new Map((meals.data ?? []).map((m) => [m.id, m.name]));
  const eventName = new Map((events.data ?? []).map((e) => [e.id, e.name]));
  const tableLabel = new Map((tables.data ?? []).map((t) => [t.id, t.label]));
  const now = Date.now();
  const lockedOn = (iso: string) =>
    new Date(iso).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: weddingTimeZone });

  return eventIds.map((eventId) => {
    const c = latest.get(eventId)!;
    const member = (members.data ?? []).find((m) => m.event_id === eventId);
    const inv = member && (invitations.data ?? []).find((i) => i.id === member.invitation_id);
    const windowOpen =
      !!inv &&
      Date.parse(inv.expires_at) > now &&
      (inv.deadline === null || Date.parse(inv.deadline) >= now);
    const d = (demand.data ?? []).find((r) => r.event_id === eventId);
    const basis = d && isPlanningBasis(d.planning_basis) ? d.planning_basis : "auto";
    const layout = (layouts.data ?? []).find((l) => l.event_id === eventId);
    const seat = layout && (seats.data ?? []).find((s) => s.layout_id === layout.id);
    const frozen = layout ? parseFrozenPlan(layout.snapshot) : null;
    const guarantee = (guarantees.data ?? []).find((g) => g.event_id === eventId);

    const consequences = guestConsequences({
      change: {
        fromStatus: statusOf(c.from_status),
        toStatus: statusOf(c.to_status),
        fromMealId: c.from_meal_option_id,
        toMealId: c.to_meal_option_id,
        occurredAt: c.occurred_at,
      },
      current: member
        ? { status: statusOf(member.rsvp_status), mealOptionId: member.meal_option_id }
        : null,
      demand: d
        ? buildDemand(
            {
              eventId,
              invited: d.invited,
              yes: d.yes,
              waitingOpen: d.waiting_open,
              waitingClosed: d.waiting_closed,
              no: d.no,
              openPlusOnes: d.open_plus_ones,
              seatedConfirmed: d.seated_confirmed,
              seatedTentative: d.seated_tentative,
              yesWithoutMeal: d.yes_without_meal,
              meals: mealsOf(d.meals),
            },
            { basis, includeOpenPlusOnes: d.plan_open_plus_ones },
          )
        : null,
      waitingCounts: waitingCounts(basis, windowOpen),
      seat: seat
        ? {
            tableLabel: tableLabel.get(seat.table_id) ?? "a table",
            seatNumber: seat.seat_number,
            tentative: seat.tentative,
          }
        : null,
      frozenSeat: frozen
        ? matchFrozenSeat(guest.full_name, sameName.count ?? 0, frozen.tables)
        : null,
      layout: layout
        ? {
            snapshot: snapshotState({
              revision: layout.revision,
              finalizedRevision: layout.finalized_revision,
            }),
            finalizedRevision: layout.finalized_revision,
            finalizedAt: layout.finalized_at,
            releasedOpen: (attention.data ?? []).some((a) => a.event_id === eventId),
          }
        : null,
      guarantee: guarantee
        ? { count: guarantee.guaranteed_count, lockedOn: lockedOn(guarantee.locked_at) }
        : null,
      budgetItems: (budget.data ?? [])
        .filter((b) => b.count_event_id === eventId)
        .map((b) => ({
          name: b.name,
          source:
            b.count_source === "event_plan" ? ("event_plan" as const) : ("event_yes" as const),
        })),
    });

    return {
      eventId,
      eventName: eventName.get(eventId) ?? "Event",
      change: {
        id: c.id,
        eventId,
        fromStatus: statusOf(c.from_status),
        toStatus: statusOf(c.to_status),
        fromMeal: c.from_meal_option_id ? (mealName.get(c.from_meal_option_id) ?? null) : null,
        toMeal: c.to_meal_option_id ? (mealName.get(c.to_meal_option_id) ?? null) : null,
        source: c.source === "couple" ? "couple" : "guest",
        reason: c.reason,
        occurredAt: c.occurred_at,
      },
      consequences,
    };
  });
}
