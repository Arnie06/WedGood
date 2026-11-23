import "server-only";
import { cache } from "react";
import { createUserClient } from "@/server/supabase/server";

/**
 * Reply dates (ISO instants) set on each event's live invitations, keyed by event id. Invitations
 * are readable by the owner and partner only (RLS), so anyone else gets an empty map. Cached per
 * request: Home and the attention loader both read it.
 */
export const loadReplyDeadlines = cache(
  async (workspaceId: string): Promise<ReadonlyMap<string, readonly string[]>> => {
    const supabase = await createUserClient();
    const { data, error } = await supabase
      .from("invitations")
      .select("event_id, deadline")
      .eq("wedding_id", workspaceId)
      .is("revoked_at", null)
      .not("deadline", "is", null)
      .limit(5000);
    if (error) throw new Error("Could not load reply dates");
    const byEvent = new Map<string, string[]>();
    for (const r of data) {
      if (!r.deadline) continue;
      const list = byEvent.get(r.event_id);
      if (list) list.push(r.deadline);
      else byEvent.set(r.event_id, [r.deadline]);
    }
    return byEvent;
  },
);
