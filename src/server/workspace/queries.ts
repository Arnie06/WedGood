import "server-only";
import { notFound } from "next/navigation";
import { createUserClient } from "@/server/supabase/server";

export type WeddingSettingsRow = {
  id: string;
  name: string;
  date: string | null;
  timezone: string;
  baseCurrency: string;
  targetBudgetMinor: number | null;
  targetGuestCount: number | null;
  location: string | null;
  version: number;
};

/** RLS limits this to workspaces the caller belongs to; callers also use requireWorkspace. */
export async function loadWeddingSettings(workspaceId: string): Promise<WeddingSettingsRow> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from("weddings")
    .select(
      "id, name, date, timezone, base_currency, target_budget_minor, target_guest_count, location, version",
    )
    .eq("id", workspaceId)
    .maybeSingle();
  if (error) throw new Error("Could not load wedding details");
  if (!data) notFound();
  return {
    id: data.id,
    name: data.name,
    date: data.date,
    timezone: data.timezone,
    baseCurrency: data.base_currency,
    targetBudgetMinor: data.target_budget_minor,
    targetGuestCount: data.target_guest_count,
    location: data.location,
    version: data.version,
  };
}

/** Cheap head-only counts for the home page prompts. RLS limits them to this member's workspace. */
export async function loadHomeCounts(
  workspaceId: string,
): Promise<{ venueCount: number; guestCount: number }> {
  const supabase = await createUserClient();
  const [venues, guests] = await Promise.all([
    supabase
      .from("candidates")
      .select("id", { count: "exact", head: true })
      .eq("wedding_id", workspaceId)
      .eq("kind", "venue")
      .is("archived_at", null),
    supabase
      .from("guests")
      .select("id", { count: "exact", head: true })
      .eq("wedding_id", workspaceId)
      .is("archived_at", null),
  ]);
  if (venues.error || guests.error) throw new Error("Could not load planning counts");
  return { venueCount: venues.count ?? 0, guestCount: guests.count ?? 0 };
}
