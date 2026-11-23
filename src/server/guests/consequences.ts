import "server-only";
import { createUserClient } from "@/server/supabase/server";
import { readGuestConsequences, type EventConsequences } from "./consequences-read";

/** What each event's latest answer change affected, as the signed-in user. Pages also check guests.manage. */
export async function loadGuestConsequences(
  workspaceId: string,
  guestId: string,
  weddingTimeZone: string,
): Promise<EventConsequences[]> {
  return readGuestConsequences(await createUserClient(), workspaceId, guestId, weddingTimeZone);
}
