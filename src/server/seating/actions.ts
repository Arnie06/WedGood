"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { elementKindName, isElementKind, type ElementKind } from "@/domain/seating/floor";
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
    await requireCapability(workspaceId, "seating.manage");
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

const TABLE_FIELDS = ["label", "capacity", "shape", "notes"] as const;

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
  const shape = values.shape === "rectangle" ? "rectangle" : "round";
  const notes = (values.notes ?? "").replace(/\s+/g, " ").trim();
  if (notes.length > 300) errors.notes = "Use 300 characters or fewer.";
  return { label, capacity, shape, notes, errors };
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
    p_shape: checked.shape,
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
    p_shape: checked.shape,
    p_notes: checked.notes,
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
  const rawSeat = form.get("seat");
  const ids = z
    .object({
      workspaceId: uuid,
      layoutId: uuid,
      guestId: uuid,
      tableId: uuid,
      seat: int.min(1).max(50).nullable(),
    })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      layoutId: form.get("layoutId"),
      guestId: form.get("guestId"),
      tableId: form.get("tableId"),
      seat: typeof rawSeat === "string" && rawSeat !== "" ? rawSeat : null,
    });
  if (!ids.success) return fail("Choose a table first.");
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const supabase = await createUserClient();
  const result = await supabase.rpc("assign_guest_seat", {
    p_wedding: ids.data.workspaceId,
    p_layout: ids.data.layoutId,
    p_guest: ids.data.guestId,
    p_table: ids.data.tableId,
    ...(ids.data.seat !== null && { p_seat: ids.data.seat }),
  });
  if (result.error?.code === "23505") {
    return fail("That seat is taken. Choose an empty seat, or swap places with whoever is there.");
  }
  // A form that carries a "seat" field (even an empty one) is about the seat number itself.
  const message =
    rawSeat === null
      ? "Seated."
      : ids.data.seat === null
        ? "Seat number cleared."
        : `Seat ${ids.data.seat}.`;
  return finish(ids.data.workspaceId, result, message);
}

/** Two seated guests take each other's places in one step (same table or different tables). */
export async function swapSeats(_: EventActionState, form: FormData): Promise<EventActionState> {
  const ids = z
    .object({ workspaceId: uuid, layoutId: uuid, guestId: uuid, otherGuestId: uuid })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      layoutId: form.get("layoutId"),
      guestId: form.get("guestId"),
      otherGuestId: form.get("otherGuestId"),
    });
  if (!ids.success) return fail("Choose who to swap with.");
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const supabase = await createUserClient();
  return finish(
    ids.data.workspaceId,
    await supabase.rpc("swap_guest_seats", {
      p_wedding: ids.data.workspaceId,
      p_layout: ids.data.layoutId,
      p_guest_a: ids.data.guestId,
      p_guest_b: ids.data.otherGuestId,
    }),
    "Swapped places.",
  );
}

/** Gives everyone at a table who has no seat number the lowest free one, in name order. */
export async function numberTableSeats(
  _: EventActionState,
  form: FormData,
): Promise<EventActionState> {
  const ids = z.object({ workspaceId: uuid, tableId: uuid }).safeParse({
    workspaceId: form.get("workspaceId"),
    tableId: form.get("tableId"),
  });
  if (!ids.success) return reload;
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc("number_table_seats", {
    p_wedding: ids.data.workspaceId,
    p_table: ids.data.tableId,
  });
  return finish(
    ids.data.workspaceId,
    { error },
    typeof data === "number" && data > 0
      ? `Numbered ${data} ${data === 1 ? "seat" : "seats"}.`
      : "Everyone here already has a seat number.",
  );
}

/** Seats everyone in a household (or a guest and their plus-one) at one table, all or nothing. */
export async function seatHousehold(
  _: EventActionState,
  form: FormData,
): Promise<EventActionState> {
  const ids = z
    .object({
      workspaceId: uuid,
      layoutId: uuid,
      tableId: uuid,
      guestIds: z.array(uuid).min(1).max(20),
    })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      layoutId: form.get("layoutId"),
      tableId: form.get("tableId"),
      guestIds: form.getAll("guestIds"),
    });
  if (!ids.success) return fail("Choose a table first.");
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc("assign_household_seats", {
    p_wedding: ids.data.workspaceId,
    p_layout: ids.data.layoutId,
    p_table: ids.data.tableId,
    p_guests: ids.data.guestIds,
  });
  if (error?.code === "SE409") {
    return fail("That table doesn't have room for everyone. Nobody was moved.");
  }
  if (error?.code === "SE422") {
    return fail("Someone in this group can't be seated right now. Nobody was moved.");
  }
  return finish(
    ids.data.workspaceId,
    { error },
    typeof data === "number" && data > 0
      ? `Seated ${data} ${data === 1 ? "guest" : "guests"} together.`
      : "Everyone is already at that table.",
  );
}

const suggestionPlacements = z
  .array(z.object({ tableId: uuid, guestIds: z.array(uuid).min(1).max(100) }))
  .min(1)
  .max(100);

/**
 * Applies a suggested seating the couple has reviewed: the exact placements they saw, against the
 * layout revision they saw. The database refuses all of it if the plan changed since, if anyone is no
 * longer eligible or already seated, or if a table can't take them.
 */
export async function applySeatingSuggestion(
  _: EventActionState,
  form: FormData,
): Promise<EventActionState> {
  let placements: unknown = null;
  try {
    placements = JSON.parse(String(form.get("placements") ?? ""));
  } catch {
    placements = null;
  }
  const ids = z
    .object({
      workspaceId: uuid,
      layoutId: uuid,
      revision: int.min(0),
      placements: suggestionPlacements,
    })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      layoutId: form.get("layoutId"),
      revision: form.get("revision"),
      placements,
    });
  if (!ids.success) return reload;
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc("apply_seating_suggestion", {
    p_wedding: ids.data.workspaceId,
    p_layout: ids.data.layoutId,
    p_expected_revision: ids.data.revision,
    p_placements: ids.data.placements.map((p) => ({ table: p.tableId, guests: p.guestIds })),
  });
  if (error?.code === "55000") {
    return fail(
      "The plan changed after this suggestion was made. Nothing was seated. Reload and review a new one.",
    );
  }
  if (error?.code === "SE409" || error?.code === "SE422") {
    return fail(
      "Someone's answer or a table has changed since this suggestion was made. Nothing was seated. Reload and review a new one.",
    );
  }
  return finish(
    ids.data.workspaceId,
    { error },
    typeof data === "number" && data > 0
      ? `Seated ${data} ${data === 1 ? "guest" : "guests"}.`
      : "Nothing to seat.",
  );
}

/** Makes one seated guest the table captain; an empty guest clears it. */
export async function setTableCaptain(
  _: EventActionState,
  form: FormData,
): Promise<EventActionState> {
  const raw = form.get("guestId");
  const ids = z.object({ workspaceId: uuid, tableId: uuid, guestId: uuid.nullable() }).safeParse({
    workspaceId: form.get("workspaceId"),
    tableId: form.get("tableId"),
    guestId: typeof raw === "string" && raw !== "" ? raw : null,
  });
  if (!ids.success) return reload;
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const supabase = await createUserClient();
  const result = await supabase.rpc("set_table_captain", {
    p_wedding: ids.data.workspaceId,
    p_table: ids.data.tableId,
    ...(ids.data.guestId !== null && { p_guest: ids.data.guestId }),
  });
  if (result.error?.code === "SE422") {
    return fail("Only a guest seated at this table can be its captain.");
  }
  return finish(
    ids.data.workspaceId,
    result,
    ids.data.guestId === null ? "Captain removed." : "Table captain set.",
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

// ---------------------------------------------------------------- floor plan (SEAT-2)

export type MoveResult = { ok: true } | { ok: false; message: string };

const position = z.object({
  workspaceId: uuid,
  kind: z.enum(["table", "element"]),
  id: uuid,
  x: z.number().int().min(0).max(120),
  y: z.number().int().min(0).max(80),
});

/**
 * Called by the floor plan after a drag or arrow-key nudge. Last write wins; the plan has no version
 * to conflict on while someone is dragging. The caller reverts its own optimistic position on failure.
 */
export async function moveFloorItem(input: {
  workspaceId: string;
  kind: "table" | "element";
  id: string;
  x: number;
  y: number;
}): Promise<MoveResult> {
  const parsed = position.safeParse(input);
  if (!parsed.success) return { ok: false, message: "That spot is outside the room." };
  const denied = await authorize(parsed.data.workspaceId);
  if (denied)
    return { ok: false, message: denied.status === "error" ? denied.message : "Not allowed." };
  const supabase = await createUserClient();
  const { workspaceId, kind, id, x, y } = parsed.data;
  const result =
    kind === "table"
      ? await supabase.rpc("move_seating_table", {
          p_wedding: workspaceId,
          p_table: id,
          p_x: x,
          p_y: y,
        })
      : await supabase.rpc("move_seating_element", {
          p_wedding: workspaceId,
          p_element: id,
          p_x: x,
          p_y: y,
        });
  if (result.error) return { ok: false, message: friendlySeatingError(result.error) };
  refresh(workspaceId);
  return { ok: true };
}

/** Form version of the same move, for the "Place at" fields in a table's tray. */
export async function placeTable(_: EventActionState, form: FormData): Promise<EventActionState> {
  const ids = z
    .object({ workspaceId: uuid, tableId: uuid, x: int.min(0).max(120), y: int.min(0).max(80) })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      tableId: form.get("tableId"),
      x: form.get("x"),
      y: form.get("y"),
    });
  const values = read(form, ["x", "y"]);
  if (!ids.success) {
    const errors: Record<string, string> = {};
    if (
      !z.coerce.number().int().min(0).max(120).safeParse(values.x).success ||
      values.x?.trim() === ""
    )
      errors.x = "Enter a whole number from 0 to 120.";
    if (
      !z.coerce.number().int().min(0).max(80).safeParse(values.y).success ||
      values.y?.trim() === ""
    )
      errors.y = "Enter a whole number from 0 to 80.";
    return Object.keys(errors).length > 0
      ? fail("Please check the highlighted details.", errors, values)
      : reload;
  }
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const supabase = await createUserClient();
  return finish(
    ids.data.workspaceId,
    await supabase.rpc("move_seating_table", {
      p_wedding: ids.data.workspaceId,
      p_table: ids.data.tableId,
      p_x: ids.data.x,
      p_y: ids.data.y,
    }),
    "Table moved.",
    values,
  );
}

const ELEMENT_FIELDS = ["kind", "label", "x", "y", "w", "h"] as const;

function checkElement(values: Record<string, string>) {
  const errors: Record<string, string> = {};
  const label = (values.label ?? "").replace(/\s+/g, " ").trim();
  if (label === "") errors.label = "Give it a name, such as Dance floor.";
  else if (label.length > 60) errors.label = "Use 60 characters or fewer.";
  const num = (key: string, lo: number, hi: number, message: string) => {
    const raw = (values[key] ?? "").trim();
    const n = Number(raw);
    if (raw === "" || !Number.isInteger(n) || n < lo || n > hi) {
      errors[key] = message;
      return 0;
    }
    return n;
  };
  const w = num("w", 2, 120, "Enter a whole number from 2 to 120.");
  const h = num("h", 2, 80, "Enter a whole number from 2 to 80.");
  const x = num("x", 0, 118, "Enter a whole number from 0 to 118.");
  const y = num("y", 0, 78, "Enter a whole number from 0 to 78.");
  if (!errors.w && !errors.x && x + w > 120) errors.w = "That is wider than the room from there.";
  if (!errors.h && !errors.y && y + h > 80) errors.h = "That is taller than the room from there.";
  return { label, w, h, x, y, errors };
}

export async function addSeatingElement(
  _: EventActionState,
  form: FormData,
): Promise<EventActionState> {
  const values = read(form, ELEMENT_FIELDS);
  const ids = z.object({ workspaceId: uuid, layoutId: uuid }).safeParse({
    workspaceId: form.get("workspaceId"),
    layoutId: form.get("layoutId"),
  });
  if (!ids.success) return reload;
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const kind = isElementKind(values.kind ?? "") ? (values.kind as ElementKind) : null;
  if (kind !== null && (values.label ?? "").trim() === "") values.label = elementKindName(kind);
  const checked = checkElement(values);
  if (kind === null) checked.errors.kind = "Choose what it is.";
  if (Object.keys(checked.errors).length > 0) {
    return fail("Please check the highlighted details.", checked.errors, values);
  }
  const supabase = await createUserClient();
  return finish(
    ids.data.workspaceId,
    await supabase.rpc("add_seating_element", {
      p_wedding: ids.data.workspaceId,
      p_layout: ids.data.layoutId,
      p_kind: kind!,
      p_label: checked.label,
      p_x: checked.x,
      p_y: checked.y,
      p_w: checked.w,
      p_h: checked.h,
    }),
    `Added ${checked.label}.`,
    values,
  );
}

export async function updateSeatingElement(
  _: EventActionState,
  form: FormData,
): Promise<EventActionState> {
  const values = read(form, ELEMENT_FIELDS);
  const ids = z.object({ workspaceId: uuid, elementId: uuid, version: int.min(0) }).safeParse({
    workspaceId: form.get("workspaceId"),
    elementId: form.get("elementId"),
    version: form.get("version"),
  });
  if (!ids.success) return reload;
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const checked = checkElement(values);
  if (Object.keys(checked.errors).length > 0) {
    return fail("Please check the highlighted details.", checked.errors, values);
  }
  const supabase = await createUserClient();
  return finish(
    ids.data.workspaceId,
    await supabase.rpc("update_seating_element", {
      p_wedding: ids.data.workspaceId,
      p_element: ids.data.elementId,
      p_expected_version: ids.data.version,
      p_label: checked.label,
      p_x: checked.x,
      p_y: checked.y,
      p_w: checked.w,
      p_h: checked.h,
    }),
    "Saved.",
    values,
  );
}

export async function removeSeatingElement(
  _: EventActionState,
  form: FormData,
): Promise<EventActionState> {
  const ids = z.object({ workspaceId: uuid, elementId: uuid, version: int.min(0) }).safeParse({
    workspaceId: form.get("workspaceId"),
    elementId: form.get("elementId"),
    version: form.get("version"),
  });
  if (!ids.success) return reload;
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const supabase = await createUserClient();
  return finish(
    ids.data.workspaceId,
    await supabase.rpc("remove_seating_element", {
      p_wedding: ids.data.workspaceId,
      p_element: ids.data.elementId,
      p_expected_version: ids.data.version,
    }),
    "Removed from the room.",
  );
}
