"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { MAX_CHECKIN_BATCH } from "@/domain/checkin/checkin";
import { ForbiddenError, requireCapability } from "@/server/auth/workspace-guard";
import type { EventActionState } from "@/server/events/actions";
import { createUserClient } from "@/server/supabase/server";
import { friendlyCheckInError } from "./errors";
import { checkInEnabled } from "./flag";

const uuid = z.uuid();
const fail = (message: string): EventActionState => ({
  status: "error",
  message,
  fieldErrors: {},
  values: {},
});
const reload = fail("Reload the page and try again.");

/** Null when the caller may record arrivals of this kind; otherwise the state to return. */
async function authorize(
  workspaceId: string,
  capability: "guests.manage" | "plan.edit",
): Promise<EventActionState | null> {
  if (!checkInEnabled()) return fail("Check-in isn't turned on for this workspace.");
  try {
    await requireCapability(workspaceId, capability);
    return null;
  } catch (e) {
    if (e instanceof ForbiddenError) return fail(friendlyCheckInError({ code: "42501" }));
    throw e;
  }
}

const refresh = (workspaceId: string, eventId: string) =>
  revalidatePath(`/app/${workspaceId}/plan/day-of/${eventId}/check-in`);

type Rpc = { data: unknown; error: { code?: string } | null };

/** A false result means someone else already did it: say so, never a false success. */
function finishBool(
  workspaceId: string,
  eventId: string,
  result: Rpc,
  done: string,
  already: string,
): EventActionState {
  if (result.error) return fail(friendlyCheckInError(result.error));
  refresh(workspaceId, eventId);
  return { status: "ok", message: result.data === true ? done : already };
}

export async function checkInGuests(
  _: EventActionState,
  form: FormData,
): Promise<EventActionState> {
  const ids = z
    .object({
      workspaceId: uuid,
      eventId: uuid,
      guestIds: z.array(uuid).min(1).max(MAX_CHECKIN_BATCH),
    })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      eventId: form.get("eventId"),
      guestIds: form.getAll("guestIds"),
    });
  if (!ids.success) {
    return form.getAll("guestIds").length > MAX_CHECKIN_BATCH
      ? fail(friendlyCheckInError({ code: "54000" }))
      : reload;
  }
  const denied = await authorize(ids.data.workspaceId, "guests.manage");
  if (denied) return denied;
  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc("check_in_guests", {
    p_wedding: ids.data.workspaceId,
    p_event: ids.data.eventId,
    p_guests: ids.data.guestIds,
  });
  if (error) return fail(friendlyCheckInError(error));
  refresh(ids.data.workspaceId, ids.data.eventId);
  const n = typeof data === "number" ? data : 0;
  return {
    status: "ok",
    message: n === 0 ? "Already checked in." : `Checked in ${n} ${n === 1 ? "guest" : "guests"}.`,
  };
}

const person = z.object({ workspaceId: uuid, eventId: uuid });

export async function undoGuestCheckIn(
  _: EventActionState,
  form: FormData,
): Promise<EventActionState> {
  const ids = person.extend({ guestId: uuid }).safeParse({
    workspaceId: form.get("workspaceId"),
    eventId: form.get("eventId"),
    guestId: form.get("guestId"),
  });
  if (!ids.success) return reload;
  const denied = await authorize(ids.data.workspaceId, "guests.manage");
  if (denied) return denied;
  const supabase = await createUserClient();
  return finishBool(
    ids.data.workspaceId,
    ids.data.eventId,
    await supabase.rpc("undo_guest_check_in", {
      p_wedding: ids.data.workspaceId,
      p_event: ids.data.eventId,
      p_guest: ids.data.guestId,
    }),
    "Check-in undone.",
    "They weren't checked in.",
  );
}

export async function recordVendorArrival(
  _: EventActionState,
  form: FormData,
): Promise<EventActionState> {
  const ids = person.extend({ vendorId: uuid }).safeParse({
    workspaceId: form.get("workspaceId"),
    eventId: form.get("eventId"),
    vendorId: form.get("vendorId"),
  });
  if (!ids.success) return reload;
  const denied = await authorize(ids.data.workspaceId, "plan.edit");
  if (denied) return denied;
  const supabase = await createUserClient();
  return finishBool(
    ids.data.workspaceId,
    ids.data.eventId,
    await supabase.rpc("record_vendor_arrival", {
      p_wedding: ids.data.workspaceId,
      p_event: ids.data.eventId,
      p_candidate: ids.data.vendorId,
    }),
    "Marked as arrived.",
    "Already marked as arrived.",
  );
}

export async function undoVendorArrival(
  _: EventActionState,
  form: FormData,
): Promise<EventActionState> {
  const ids = person.extend({ vendorId: uuid }).safeParse({
    workspaceId: form.get("workspaceId"),
    eventId: form.get("eventId"),
    vendorId: form.get("vendorId"),
  });
  if (!ids.success) return reload;
  const denied = await authorize(ids.data.workspaceId, "plan.edit");
  if (denied) return denied;
  const supabase = await createUserClient();
  return finishBool(
    ids.data.workspaceId,
    ids.data.eventId,
    await supabase.rpc("undo_vendor_arrival", {
      p_wedding: ids.data.workspaceId,
      p_event: ids.data.eventId,
      p_candidate: ids.data.vendorId,
    }),
    "Arrival undone.",
    "They weren't marked as arrived.",
  );
}
