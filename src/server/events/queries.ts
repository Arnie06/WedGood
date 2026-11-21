import "server-only";
import { createUserClient } from "@/server/supabase/server";
import type { EventKind } from "@/domain/events/event";
import type { RsvpStatus } from "@/domain/guests/rsvp";

export type EventRecord = {
  id: string;
  name: string;
  kind: EventKind;
  localDate: string | null;
  targetAttendance: number | null;
  capacity: number | null;
  version: number;
};
export type MealOptionRecord = {
  id: string;
  eventId: string;
  name: string;
  active: boolean;
  version: number;
};
export type InvitationRecord = {
  id: string;
  eventId: string;
  householdId: string | null;
  label: string;
  plusOneQuota: number;
  plusOnesUsed: number;
  deadline: string | null;
  expiresAt: string;
  revokedAt: string | null;
  lastRespondedAt: string | null;
  deliveryStatus: "not_sent" | "shared_manually";
  deliveryMarkedAt: string | null;
  version: number;
};
export type MemberRecord = {
  id: string;
  invitationId: string;
  eventId: string;
  guestId: string;
  isPlusOne: boolean;
  active: boolean;
  status: RsvpStatus;
  mealOptionId: string | null;
};
export type EventData = {
  events: EventRecord[];
  mealOptions: MealOptionRecord[];
  invitations: InvitationRecord[];
  members: MemberRecord[];
};

const KINDS: readonly string[] = [
  "ceremony",
  "reception",
  "rehearsal",
  "welcome",
  "brunch",
  "other",
];
const statusOf = (v: string): RsvpStatus => (v === "accepted" || v === "declined" ? v : "pending");

/** RLS limits these rows to owner and partner. Never selects token_hash. Pages also call requireWorkspace. */
export async function loadEventData(workspaceId: string): Promise<EventData> {
  const supabase = await createUserClient();
  const [events, meals, invitations, members] = await Promise.all([
    supabase
      .from("events")
      .select("id, name, kind, local_date, target_attendance, capacity, version")
      .eq("wedding_id", workspaceId)
      .order("local_date", { nullsFirst: false })
      .order("name")
      .limit(50),
    supabase
      .from("meal_options")
      .select("id, event_id, name, active, version")
      .eq("wedding_id", workspaceId)
      .order("created_at")
      .limit(500),
    supabase
      .from("invitations")
      .select(
        "id, event_id, household_id, label, plus_one_quota, plus_ones_used, deadline, expires_at, revoked_at, last_responded_at, delivery_status, delivery_marked_at, version",
      )
      .eq("wedding_id", workspaceId)
      .order("label")
      .limit(2500),
    supabase
      .from("invitation_members")
      .select(
        "id, invitation_id, event_id, guest_id, is_plus_one, active, rsvp_status, meal_option_id",
      )
      .eq("wedding_id", workspaceId)
      .limit(5000),
  ]);
  if (events.error || meals.error || invitations.error || members.error) {
    throw new Error("Could not load events");
  }
  return {
    events: events.data.map((e) => ({
      id: e.id,
      name: e.name,
      kind: (KINDS.includes(e.kind) ? e.kind : "other") as EventKind,
      localDate: e.local_date,
      targetAttendance: e.target_attendance,
      capacity: e.capacity,
      version: e.version,
    })),
    mealOptions: meals.data.map((m) => ({
      id: m.id,
      eventId: m.event_id,
      name: m.name,
      active: m.active,
      version: m.version,
    })),
    invitations: invitations.data.map((i) => ({
      id: i.id,
      eventId: i.event_id,
      householdId: i.household_id,
      label: i.label,
      plusOneQuota: i.plus_one_quota,
      plusOnesUsed: i.plus_ones_used,
      deadline: i.deadline,
      expiresAt: i.expires_at,
      revokedAt: i.revoked_at,
      lastRespondedAt: i.last_responded_at,
      deliveryStatus: i.delivery_status === "shared_manually" ? "shared_manually" : "not_sent",
      deliveryMarkedAt: i.delivery_marked_at,
      version: i.version,
    })),
    members: members.data.map((m) => ({
      id: m.id,
      invitationId: m.invitation_id,
      eventId: m.event_id,
      guestId: m.guest_id,
      isPlusOne: m.is_plus_one,
      active: m.active,
      status: statusOf(m.rsvp_status),
      mealOptionId: m.meal_option_id,
    })),
  };
}
