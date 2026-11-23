"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { parseShuttleRunInput, type ShuttleRunField } from "@/domain/shuttles/shuttles";
import { ForbiddenError, requireCapability } from "@/server/auth/workspace-guard";
import type { EventActionState } from "@/server/events/actions";
import { createUserClient } from "@/server/supabase/server";
import { loadEventLabels } from "@/server/timeline/queries";
import { friendlyShuttleError } from "./errors";
import { shuttlesEnabled } from "./flag";

const uuid = z.uuid();
const RUN_FIELDS: readonly ShuttleRunField[] = [
  "direction",
  "label",
  "pickup",
  "dropoff",
  "date",
  "time",
  "capacity",
  "notes",
];

function fail(
  message: string,
  fieldErrors: Record<string, string> = {},
  values: Record<string, string> = {},
): EventActionState {
  return { status: "error", message, fieldErrors, values };
}
const reload = fail("Reload the page and try again.");

function read(form: FormData, fields: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = form.get(f);
    out[f] = typeof v === "string" ? v : "";
  }
  return out;
}

/** Null when the caller may arrange shuttles; otherwise the state to return. */
async function authorize(workspaceId: string): Promise<EventActionState | null> {
  if (!shuttlesEnabled()) return fail("Shuttles aren't turned on for this workspace.");
  try {
    await requireCapability(workspaceId, "guests.manage");
    return null;
  } catch (e) {
    if (e instanceof ForbiddenError) return fail(friendlyShuttleError({ code: "42501" }));
    throw e;
  }
}

/** The event's own zone, read on the server; never taken from the form. */
async function eventZone(workspaceId: string, eventId: string): Promise<string | null> {
  const labels = await loadEventLabels(workspaceId);
  return labels.find((e) => e.id === eventId)?.effectiveTimeZone ?? null;
}

const refresh = (workspaceId: string) => revalidatePath(`/app/${workspaceId}`, "layout");

type Rpc = { error: { code?: string } | null };
function finish(
  workspaceId: string,
  result: Rpc,
  message: string,
  values: Record<string, string> = {},
): EventActionState {
  if (result.error) {
    if (result.error.code === "23505") {
      return fail(
        "Please check the highlighted details.",
        { label: friendlyShuttleError(result.error) },
        values,
      );
    }
    return fail(friendlyShuttleError(result.error), {}, values);
  }
  refresh(workspaceId);
  return { status: "ok", message };
}

export async function addShuttleRun(
  _: EventActionState,
  form: FormData,
): Promise<EventActionState> {
  const values = read(form, RUN_FIELDS);
  const ids = z
    .object({ workspaceId: uuid, eventId: uuid })
    .safeParse({ workspaceId: form.get("workspaceId"), eventId: form.get("eventId") });
  if (!ids.success) return reload;
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const zone = await eventZone(ids.data.workspaceId, ids.data.eventId);
  if (!zone) return reload;
  const parsed = parseShuttleRunInput(values, zone);
  if (!parsed.ok) return fail("Please check the highlighted details.", parsed.fieldErrors, values);
  const v = parsed.value;
  const supabase = await createUserClient();
  return finish(
    ids.data.workspaceId,
    await supabase.rpc("add_shuttle_run", {
      p_wedding: ids.data.workspaceId,
      p_event: ids.data.eventId,
      p_direction: v.direction,
      p_label: v.label,
      p_pickup: v.pickup,
      p_dropoff: v.dropoff ?? "",
      p_departs_at: v.departsAt,
      p_capacity: v.capacity,
      p_notes: v.notes ?? "",
    }),
    `Added ${v.label}.`,
    values,
  );
}

export async function updateShuttleRun(
  _: EventActionState,
  form: FormData,
): Promise<EventActionState> {
  const values = read(form, RUN_FIELDS);
  const ids = z
    .object({
      workspaceId: uuid,
      eventId: uuid,
      runId: uuid,
      version: z.coerce.number().int().min(1),
    })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      eventId: form.get("eventId"),
      runId: form.get("runId"),
      version: form.get("version"),
    });
  if (!ids.success) return reload;
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const zone = await eventZone(ids.data.workspaceId, ids.data.eventId);
  if (!zone) return reload;
  const parsed = parseShuttleRunInput(values, zone);
  if (!parsed.ok) return fail("Please check the highlighted details.", parsed.fieldErrors, values);
  const v = parsed.value;
  const supabase = await createUserClient();
  return finish(
    ids.data.workspaceId,
    await supabase.rpc("update_shuttle_run", {
      p_wedding: ids.data.workspaceId,
      p_run: ids.data.runId,
      p_expected_version: ids.data.version,
      p_label: v.label,
      p_pickup: v.pickup,
      p_dropoff: v.dropoff ?? "",
      p_departs_at: v.departsAt,
      p_capacity: v.capacity,
      p_notes: v.notes ?? "",
    }),
    "Saved.",
    values,
  );
}

export async function removeShuttleRun(
  _: EventActionState,
  form: FormData,
): Promise<EventActionState> {
  const ids = z
    .object({ workspaceId: uuid, runId: uuid, version: z.coerce.number().int().min(1) })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      runId: form.get("runId"),
      version: form.get("version"),
    });
  if (!ids.success) return reload;
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc("remove_shuttle_run", {
    p_wedding: ids.data.workspaceId,
    p_run: ids.data.runId,
    p_expected_version: ids.data.version,
  });
  return finish(
    ids.data.workspaceId,
    { error },
    typeof data === "number" && data > 0
      ? `Shuttle removed. ${data} ${data === 1 ? "guest needs" : "guests need"} another ride.`
      : "Shuttle removed.",
  );
}

export async function assignShuttleRiders(
  _: EventActionState,
  form: FormData,
): Promise<EventActionState> {
  const ids = z
    .object({ workspaceId: uuid, runId: uuid, guestIds: z.array(uuid).max(20) })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      runId: form.get("runId"),
      guestIds: form.getAll("guestIds"),
    });
  if (!ids.success) {
    return form.getAll("guestIds").length > 20 ? fail("Choose up to 20 guests at a time.") : reload;
  }
  if (ids.data.guestIds.length === 0) return fail("Choose at least one guest.");
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc("assign_shuttle_guests", {
    p_wedding: ids.data.workspaceId,
    p_run: ids.data.runId,
    p_guests: ids.data.guestIds,
  });
  return finish(
    ids.data.workspaceId,
    { error },
    typeof data === "number" && data > 0
      ? `Added ${data} ${data === 1 ? "rider" : "riders"}.`
      : "Everyone you chose is already on this shuttle.",
  );
}

export async function unassignShuttleRider(
  _: EventActionState,
  form: FormData,
): Promise<EventActionState> {
  const ids = z.object({ workspaceId: uuid, runId: uuid, guestId: uuid }).safeParse({
    workspaceId: form.get("workspaceId"),
    runId: form.get("runId"),
    guestId: form.get("guestId"),
  });
  if (!ids.success) return reload;
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const supabase = await createUserClient();
  return finish(
    ids.data.workspaceId,
    await supabase.rpc("unassign_shuttle_guest", {
      p_wedding: ids.data.workspaceId,
      p_run: ids.data.runId,
      p_guest: ids.data.guestId,
    }),
    "Taken off this shuttle.",
  );
}
