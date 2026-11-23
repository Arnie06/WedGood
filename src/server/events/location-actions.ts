"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ForbiddenError, requireCapability } from "@/server/auth/workspace-guard";
import { createUserClient } from "@/server/supabase/server";
import { friendlyEventError } from "./errors";

export type LocationActionState =
  { status: "idle" } | { status: "ok"; message: string } | { status: "error"; message: string };

const uuid = z.uuid();

function fail(message: string): LocationActionState {
  return { status: "error", message };
}

/**
 * Sets or clears the one place an event is held. The form shows an impact preview first; this
 * only applies the change. Nothing is sent to a venue and no booking is touched. Ticking
 * "update agenda places" rewrites only this event's agenda places that name the old venue.
 */
export async function setEventLocation(
  _: LocationActionState,
  form: FormData,
): Promise<LocationActionState> {
  const parsed = z
    .object({
      workspaceId: uuid,
      eventId: uuid,
      version: z.coerce.number().int().min(0),
      venueId: uuid.optional(),
      spaceId: uuid.optional(),
      updateAgenda: z.boolean(),
    })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      eventId: form.get("eventId"),
      version: form.get("version"),
      venueId: form.get("venueId") || undefined,
      spaceId: form.get("spaceId") || undefined,
      updateAgenda: form.get("updateAgenda") === "true",
    });
  if (!parsed.success) return fail("Reload the page and try again.");
  if (!parsed.data.venueId && parsed.data.spaceId) return fail("Choose a venue first.");
  try {
    await requireCapability(parsed.data.workspaceId, "guests.manage");
  } catch (e) {
    if (e instanceof ForbiddenError) return fail(friendlyEventError({ code: "42501" }));
    throw e;
  }
  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc("set_event_location", {
    p_wedding: parsed.data.workspaceId,
    p_event: parsed.data.eventId,
    p_expected_version: parsed.data.version,
    ...(parsed.data.venueId && { p_candidate: parsed.data.venueId }),
    ...(parsed.data.spaceId && { p_space: parsed.data.spaceId }),
    p_update_agenda: parsed.data.updateAgenda,
  });
  if (error) {
    if (error.code === "22023") return fail("That space isn't at this venue. Choose again.");
    if (error.code === "42501")
      return fail(
        "That venue isn't in your saved list any more, or you can't change events. Reload and try again.",
      );
    return fail(friendlyEventError(error));
  }
  revalidatePath(`/app/${parsed.data.workspaceId}`, "layout");
  const updated =
    data !== null && typeof data === "object" && "agenda_updated" in data
      ? Number((data as { agenda_updated: unknown }).agenda_updated)
      : 0;
  const base = parsed.data.venueId ? "Place saved." : "Place cleared.";
  return {
    status: "ok",
    message:
      updated > 0
        ? `${base} ${updated} agenda ${updated === 1 ? "place" : "places"} updated.`
        : base,
  };
}
