import "server-only";
import type { GuestReplies } from "@/domain/guests/replies";
import { createUserClient } from "@/server/supabase/server";
import { readGuestReplies } from "./replies-read";

/** Answer, meal and seat per guest for one event, as the signed-in user. Pages also check guests.manage. */
export async function loadGuestReplies(
  workspaceId: string,
  eventId: string,
): Promise<GuestReplies> {
  return readGuestReplies(await createUserClient(), workspaceId, eventId);
}
