import type { SupabaseClient } from "@supabase/supabase-js";
import { buildGuestReplies, type GuestReplies } from "@/domain/guests/replies";
import type { RsvpStatus } from "@/domain/guests/rsvp";
import type { Database } from "@/server/db/database.types";

// Not marked server-only so the integration test can run these exact reads with a signed-in test
// client. App code must go through loadGuestReplies (src/server/guests/replies.ts).

const statusOf = (v: string): RsvpStatus => (v === "accepted" || v === "declined" ? v : "pending");

/**
 * Per-guest answer, meal and seat for one event (UX-01). Read-only, over existing tables. RLS limits
 * every row to owner, partner and holders of the guests grant (`can_manage_guests`). Never selects
 * token hashes or private details.
 */
export async function readGuestReplies(
  supabase: SupabaseClient<Database>,
  workspaceId: string,
  eventId: string,
): Promise<GuestReplies> {
  const [members, invitations, meals, layout] = await Promise.all([
    supabase
      .from("invitation_members")
      .select("guest_id, invitation_id, is_plus_one, active, rsvp_status, meal_option_id")
      .eq("wedding_id", workspaceId)
      .eq("event_id", eventId)
      .eq("active", true)
      .limit(5000),
    supabase
      .from("invitations")
      .select("id, deadline, expires_at")
      .eq("wedding_id", workspaceId)
      .eq("event_id", eventId)
      .limit(2500),
    supabase
      .from("meal_options")
      .select("id, name, active")
      .eq("wedding_id", workspaceId)
      .eq("event_id", eventId)
      .limit(100),
    supabase
      .from("seating_layouts")
      .select("id")
      .eq("wedding_id", workspaceId)
      .eq("event_id", eventId)
      .maybeSingle(),
  ]);
  if (members.error || invitations.error || meals.error || layout.error) {
    throw new Error("Could not load replies");
  }

  let seats: {
    guestId: string;
    tableLabel: string;
    seatNumber: number | null;
    tentative: boolean;
  }[] = [];
  if (layout.data) {
    const [tables, assignments] = await Promise.all([
      supabase
        .from("seating_tables")
        .select("id, label")
        .eq("wedding_id", workspaceId)
        .eq("layout_id", layout.data.id)
        .limit(500),
      supabase
        .from("seat_assignments")
        .select("guest_id, table_id, seat_number, tentative")
        .eq("wedding_id", workspaceId)
        .eq("layout_id", layout.data.id)
        .limit(5000),
    ]);
    if (tables.error || assignments.error) throw new Error("Could not load replies");
    const labels = new Map(tables.data.map((t) => [t.id, t.label]));
    seats = assignments.data.map((a) => ({
      guestId: a.guest_id,
      tableLabel: labels.get(a.table_id) ?? "A table",
      seatNumber: a.seat_number,
      tentative: a.tentative,
    }));
  }

  return buildGuestReplies({
    now: new Date(),
    members: members.data.map((m) => ({
      guestId: m.guest_id,
      invitationId: m.invitation_id,
      isPlusOne: m.is_plus_one,
      active: m.active,
      status: statusOf(m.rsvp_status),
      mealOptionId: m.meal_option_id,
    })),
    invitations: invitations.data.map((i) => ({
      id: i.id,
      deadline: i.deadline,
      expiresAt: i.expires_at,
    })),
    mealOptions: meals.data,
    seats,
  });
}
