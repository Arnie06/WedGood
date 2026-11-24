import "server-only";
import {
  isReply,
  type ArrivalGuest,
  type ArrivalVendor,
  type Reply,
} from "@/domain/checkin/checkin";
import { createUserClient } from "@/server/supabase/server";

/**
 * Every guest with an active invitation to this event (any reply), with whether they have been
 * checked in. RLS limits the rows to people who manage guests, so anyone else gets an empty list,
 * never someone else's data. Names, household names and replies only: no contact, dietary or
 * access details. Archived guests are left out.
 */
export async function loadGuestArrivals(
  workspaceId: string,
  eventId: string,
): Promise<ArrivalGuest[]> {
  const supabase = await createUserClient();
  const [memberRes, checkinRes] = await Promise.all([
    supabase
      .from("invitation_members")
      .select("guest_id, rsvp_status")
      .eq("wedding_id", workspaceId)
      .eq("event_id", eventId)
      .eq("active", true)
      .limit(5000),
    supabase
      .from("guest_checkins")
      .select("guest_id, checked_in_at")
      .eq("wedding_id", workspaceId)
      .eq("event_id", eventId)
      .limit(5000),
  ]);
  if (memberRes.error || checkinRes.error) throw new Error("Could not load check-in");
  if (memberRes.data.length === 0) return [];

  const ids = [...new Set(memberRes.data.map((m) => m.guest_id))];
  const [guestRes, householdRes] = await Promise.all([
    supabase
      .from("guests")
      .select("id, full_name, household_id")
      .eq("wedding_id", workspaceId)
      .is("archived_at", null)
      .in("id", ids)
      .limit(5000),
    supabase.from("households").select("id, name").eq("wedding_id", workspaceId).limit(5000),
  ]);
  if (guestRes.error || householdRes.error) throw new Error("Could not load check-in");

  const households = new Map(householdRes.data.map((h) => [h.id, h.name]));
  const reply = new Map<string, Reply>();
  for (const m of memberRes.data) if (isReply(m.rsvp_status)) reply.set(m.guest_id, m.rsvp_status);
  const arrived = new Map(checkinRes.data.map((c) => [c.guest_id, c.checked_in_at]));

  return guestRes.data.flatMap((g) => {
    const r = reply.get(g.id);
    if (!r) return [];
    return [
      {
        id: g.id,
        name: g.full_name,
        household: g.household_id ? (households.get(g.household_id) ?? null) : null,
        reply: r,
        arrivedAt: arrived.get(g.id) ?? null,
      },
    ];
  });
}

/** Vendors linked to this event and whether each has arrived. Readable by every member. */
export async function loadVendorArrivals(
  workspaceId: string,
  eventId: string,
): Promise<ArrivalVendor[]> {
  const supabase = await createUserClient();
  const [linkRes, arrivalRes] = await Promise.all([
    supabase
      .from("event_vendors")
      .select("candidate_id")
      .eq("wedding_id", workspaceId)
      .eq("event_id", eventId)
      .limit(200),
    supabase
      .from("vendor_arrivals")
      .select("candidate_id, arrived_at")
      .eq("wedding_id", workspaceId)
      .eq("event_id", eventId)
      .limit(200),
  ]);
  if (linkRes.error || arrivalRes.error) throw new Error("Could not load check-in");
  if (linkRes.data.length === 0) return [];
  const { data, error } = await supabase
    .from("candidates")
    .select("id, name")
    .eq("wedding_id", workspaceId)
    .in(
      "id",
      linkRes.data.map((l) => l.candidate_id),
    )
    .limit(200);
  if (error) throw new Error("Could not load check-in");
  const arrived = new Map(arrivalRes.data.map((a) => [a.candidate_id, a.arrived_at]));
  return data
    .map((c) => ({ id: c.id, name: c.name, arrivedAt: arrived.get(c.id) ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
