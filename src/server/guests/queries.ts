import "server-only";
import type { ReplyChange, ReplyStatus } from "@/domain/guests/history";
import type { AgeGroup } from "@/domain/guests/import";
import { createUserClient } from "@/server/supabase/server";

export type GuestRecord = {
  id: string;
  householdId: string | null;
  fullName: string;
  email: string | null;
  phone: string | null;
  ageGroup: AgeGroup | null;
  tags: string[];
  archived: boolean;
  version: number;
};
export type HouseholdRecord = {
  id: string;
  name: string;
  address: string | null;
  notes: string | null;
  version: number;
};
export type GuestPrivateDetails = {
  dietary: string | null;
  accessibility: string | null;
  notes: string | null;
  /** What the guest typed on their RSVP link, kept apart from the couple's own text. */
  guestDietary: string | null;
  guestAccessibility: string | null;
  /** When the guest last saved notes through their RSVP link, if ever. */
  guestAnsweredAt: string | null;
};

export const NO_PRIVATE_DETAILS: GuestPrivateDetails = {
  dietary: null,
  accessibility: null,
  notes: null,
  guestDietary: null,
  guestAccessibility: null,
  guestAnsweredAt: null,
};
export type GuestData = { guests: GuestRecord[]; households: HouseholdRecord[] };

const ageOf = (v: string | null): AgeGroup | null => (v === "adult" || v === "child" ? v : null);

/** RLS limits these rows to owner and partner. Pages also call requireWorkspace. */
export async function loadGuests(workspaceId: string): Promise<GuestData> {
  const supabase = await createUserClient();
  const [guests, households] = await Promise.all([
    supabase
      .from("guests")
      .select("id, household_id, full_name, email, phone, age_group, tags, archived_at, version")
      .eq("wedding_id", workspaceId)
      .order("full_name")
      .limit(2500),
    supabase
      .from("households")
      .select("id, name, address, notes, version")
      .eq("wedding_id", workspaceId)
      .is("archived_at", null)
      .order("name")
      .limit(2500),
  ]);
  if (guests.error || households.error) throw new Error("Could not load guests");
  return {
    guests: guests.data.map((g) => ({
      id: g.id,
      householdId: g.household_id,
      fullName: g.full_name,
      email: g.email,
      phone: g.phone,
      ageGroup: ageOf(g.age_group),
      tags: g.tags,
      archived: g.archived_at !== null,
      version: g.version,
    })),
    households: households.data,
  };
}

/** Private details are read only for one guest at a time, on that guest's page. */
export async function loadGuestPrivateDetails(
  workspaceId: string,
  guestId: string,
): Promise<GuestPrivateDetails> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from("guest_private_details")
    .select("dietary, accessibility, notes, guest_dietary, guest_accessibility, guest_answered_at")
    .eq("wedding_id", workspaceId)
    .eq("guest_id", guestId)
    .maybeSingle();
  if (error) throw new Error("Could not load guest details");
  if (!data) return NO_PRIVATE_DETAILS;
  return {
    dietary: data.dietary,
    accessibility: data.accessibility,
    notes: data.notes,
    guestDietary: data.guest_dietary,
    guestAccessibility: data.guest_accessibility,
    guestAnsweredAt: data.guest_answered_at,
  };
}

export type GuestReplyHistory = { eventNames: Record<string, string>; changes: ReplyChange[] };

const statusOf = (v: string): ReplyStatus => (v === "accepted" || v === "declined" ? v : "pending");

/**
 * Every recorded change of this guest's answers, newest first. RLS limits the rows to owner and
 * partner; anyone else gets an empty list. Meal names are looked up now, so a renamed meal shows
 * its current name.
 */
export async function loadGuestReplyHistory(
  workspaceId: string,
  guestId: string,
): Promise<GuestReplyHistory> {
  const supabase = await createUserClient();
  const changesRes = await supabase
    .from("rsvp_changes")
    .select(
      "id, event_id, from_status, to_status, from_meal_option_id, to_meal_option_id, source, reason, occurred_at",
    )
    .eq("wedding_id", workspaceId)
    .eq("guest_id", guestId)
    .order("occurred_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(200);
  if (changesRes.error) throw new Error("Could not load reply history");
  if (changesRes.data.length === 0) return { eventNames: {}, changes: [] };
  const eventIds = [...new Set(changesRes.data.map((c) => c.event_id))];
  const [eventRes, mealRes] = await Promise.all([
    supabase.from("events").select("id, name").eq("wedding_id", workspaceId).in("id", eventIds),
    supabase
      .from("meal_options")
      .select("id, name")
      .eq("wedding_id", workspaceId)
      .in("event_id", eventIds)
      .limit(500),
  ]);
  if (eventRes.error || mealRes.error) throw new Error("Could not load reply history");
  const meals = new Map(mealRes.data.map((m) => [m.id, m.name]));
  return {
    eventNames: Object.fromEntries(eventRes.data.map((e) => [e.id, e.name])),
    changes: changesRes.data.map((c) => ({
      id: c.id,
      eventId: c.event_id,
      fromStatus: statusOf(c.from_status),
      toStatus: statusOf(c.to_status),
      fromMeal: c.from_meal_option_id ? (meals.get(c.from_meal_option_id) ?? null) : null,
      toMeal: c.to_meal_option_id ? (meals.get(c.to_meal_option_id) ?? null) : null,
      source: c.source === "couple" ? "couple" : "guest",
      reason: c.reason,
      occurredAt: c.occurred_at,
    })),
  };
}
