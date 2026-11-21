import "server-only";
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
    .select("dietary, accessibility, notes")
    .eq("wedding_id", workspaceId)
    .eq("guest_id", guestId)
    .maybeSingle();
  if (error) throw new Error("Could not load guest details");
  return data ?? { dietary: null, accessibility: null, notes: null };
}
