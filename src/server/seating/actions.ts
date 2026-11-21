"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ForbiddenError, requireCapability } from "@/server/auth/workspace-guard";
import type { EventActionState } from "@/server/events/actions";
import { createUserClient } from "@/server/supabase/server";
import { friendlySeatingError } from "./errors";

const uuid = z.uuid();
const int = z.coerce.number().int();

function fail(
  message: string,
  fieldErrors: Record<string, string> = {},
  values: Record<string, string> = {},
): EventActionState {
  return { status: "error", message, fieldErrors, values };
}

function read(form: FormData, fields: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = form.get(f);
    out[f] = typeof v === "string" ? v : "";
  }
  return out;
}

async function authorize(workspaceId: string): Promise<EventActionState | null> {
  try {
    await requireCapability(workspaceId, "guests.manage");
    return null;
  } catch (e) {
    if (e instanceof ForbiddenError) return fail(friendlySeatingError({ code: "42501" }));
    throw e;
  }
}

const refresh = (workspaceId: string) => revalidatePath(`/app/${workspaceId}`, "layout");
const reload: EventActionState = fail("Reload the page and try again.");

type Rpc = { error: { code?: string } | null };

async function finish(
  workspaceId: string,
  result: Rpc,
  message: string,
  values: Record<string, string> = {},
): Promise<EventActionState> {
  if (result.error) return fail(friendlySeatingError(result.error), {}, values);
  refresh(workspaceId);
  return { status: "ok", message };
}

export async function startSeatingPlan(
  _: EventActionState,
  form: FormData,
): Promise<EventActionState> {
  const ids = z.object({ workspaceId: uuid, eventId: uuid }).safeParse({
    workspaceId: form.get("workspaceId"),
    eventId: form.get("eventId"),
  });
  if (!ids.success) return reload;
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const supabase = await createUserClient();
  return finish(
    ids.data.workspaceId,
    await supabase.rpc("ensure_seating_layout", {
      p_wedding: ids.data.workspaceId,
      p_event_id: ids.data.eventId,
    }),
    "Seating plan started.",
  );
}

export async function setTentativeSeating(
  _: EventActionState,
  form: FormData,
): Promise<EventActionState> {
  const ids = z
    .object({
      workspaceId: uuid,
      layoutId: uuid,
      version: int.min(0),
      allow: z.enum(["true", "false"]),
    })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      layoutId: form.get("layoutId"),
      version: form.get("version"),
      allow: form.get("allow"),
    });
  if (!ids.success) return reload;
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const supabase = await createUserClient();
  return finish(
    ids.data.workspaceId,
    await supabase.rpc("set_seating_tentative", {
      p_wedding: ids.data.workspaceId,
      p_layout: ids.data.layoutId,
      p_expected_version: ids.data.version,
      p_allow: ids.data.allow === "true",
    }),
    ids.data.allow === "true" ? "Tentative seating is on." : "Tentative seating is off.",
  );
}

const TABLE_FIELDS = ["label", "capacity"] as const;

function checkTable(values: Record<string, string>) {
  const label = (values.label ?? "").replace(/\s+/g, " ").trim();
  const capacity = Number(values.capacity);
  const errors: Record<string, string> = {};
  if (label === "") errors.label = "Give the table a name, such as Table 1.";
  else if (label.length > 60) errors.label = "Use 60 characters or fewer.";
  if (
    !Number.isInteger(capacity) ||
    capacity < 1 ||
    capacity > 50 ||
    (values.capacity ?? "").trim() === ""
  ) {
    errors.capacity = "Enter a whole number of seats from 1 to 50.";
  }
  return { label, capacity, errors };
}

export async function addTable(_: EventActionState, form: FormData): Promise<EventActionState> {
  const values = read(form, TABLE_FIELDS);
  const ids = z.object({ workspaceId: uuid, layoutId: uuid }).safeParse({
    workspaceId: form.get("workspaceId"),
    layoutId: form.get("layoutId"),
  });
  if (!ids.success) return reload;
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const checked = checkTable(values);
  if (Object.keys(checked.errors).length > 0) {
    return fail("Please check the highlighted details.", checked.errors, values);
  }
  const supabase = await createUserClient();
  const result = await supabase.rpc("add_seating_table", {
    p_wedding: ids.data.workspaceId,
    p_layout: ids.data.layoutId,
    p_label: checked.label,
    p_capacity: checked.capacity,
  });
  if (result.error?.code === "23505") {
    return fail(
      "Please check the highlighted details.",
      { label: "You already have a table with that name." },
      values,
    );
  }
  return finish(ids.data.workspaceId, result, `Added ${checked.label}.`, values);
}

export async function updateTable(_: EventActionState, form: FormData): Promise<EventActionState> {
  const values = read(form, TABLE_FIELDS);
  const ids = z.object({ workspaceId: uuid, tableId: uuid, version: int.min(0) }).safeParse({
    workspaceId: form.get("workspaceId"),
    tableId: form.get("tableId"),
    version: form.get("version"),
  });
  if (!ids.success) return reload;
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const checked = checkTable(values);
  if (Object.keys(checked.errors).length > 0) {
    return fail("Please check the highlighted details.", checked.errors, values);
  }
  const supabase = await createUserClient();
  const result = await supabase.rpc("update_seating_table", {
    p_wedding: ids.data.workspaceId,
    p_table: ids.data.tableId,
    p_expected_version: ids.data.version,
    p_label: checked.label,
    p_capacity: checked.capacity,
  });
  if (result.error?.code === "23505") {
    return fail(
      "Please check the highlighted details.",
      { label: "You already have a table with that name." },
      values,
    );
  }
  return finish(ids.data.workspaceId, result, "Saved.", values);
}

export async function removeTable(_: EventActionState, form: FormData): Promise<EventActionState> {
  const ids = z.object({ workspaceId: uuid, tableId: uuid, version: int.min(0) }).safeParse({
    workspaceId: form.get("workspaceId"),
    tableId: form.get("tableId"),
    version: form.get("version"),
  });
  if (!ids.success) return reload;
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc("remove_seating_table", {
    p_wedding: ids.data.workspaceId,
    p_table: ids.data.tableId,
    p_expected_version: ids.data.version,
  });
  return finish(
    ids.data.workspaceId,
    { error },
    typeof data === "number" && data > 0
      ? `Table removed. ${data} ${data === 1 ? "guest is" : "guests are"} back in the list to seat.`
      : "Table removed.",
  );
}

export async function seatGuest(_: EventActionState, form: FormData): Promise<EventActionState> {
  const ids = z
    .object({ workspaceId: uuid, layoutId: uuid, guestId: uuid, tableId: uuid })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      layoutId: form.get("layoutId"),
      guestId: form.get("guestId"),
      tableId: form.get("tableId"),
    });
  if (!ids.success) return fail("Choose a table first.");
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const supabase = await createUserClient();
  return finish(
    ids.data.workspaceId,
    await supabase.rpc("assign_guest_seat", {
      p_wedding: ids.data.workspaceId,
      p_layout: ids.data.layoutId,
      p_guest: ids.data.guestId,
      p_table: ids.data.tableId,
    }),
    "Seated.",
  );
}

export async function unseatGuest(_: EventActionState, form: FormData): Promise<EventActionState> {
  const ids = z.object({ workspaceId: uuid, layoutId: uuid, guestId: uuid }).safeParse({
    workspaceId: form.get("workspaceId"),
    layoutId: form.get("layoutId"),
    guestId: form.get("guestId"),
  });
  if (!ids.success) return reload;
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const supabase = await createUserClient();
  return finish(
    ids.data.workspaceId,
    await supabase.rpc("unassign_guest_seat", {
      p_wedding: ids.data.workspaceId,
      p_layout: ids.data.layoutId,
      p_guest: ids.data.guestId,
    }),
    "Removed from the table.",
  );
}

export async function finalizeLayout(
  _: EventActionState,
  form: FormData,
): Promise<EventActionState> {
  const ids = z.object({ workspaceId: uuid, layoutId: uuid, revision: int.min(0) }).safeParse({
    workspaceId: form.get("workspaceId"),
    layoutId: form.get("layoutId"),
    revision: form.get("revision"),
  });
  if (!ids.success) return reload;
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const supabase = await createUserClient();
  return finish(
    ids.data.workspaceId,
    await supabase.rpc("finalize_seating_layout", {
      p_wedding: ids.data.workspaceId,
      p_layout: ids.data.layoutId,
      p_expected_revision: ids.data.revision,
    }),
    "Plan finalized.",
  );
}
