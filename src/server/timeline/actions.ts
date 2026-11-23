"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { parseTimelineInput, type TimelineFormValues } from "@/domain/timeline/timeline";
import { ForbiddenError, requireCapability } from "@/server/auth/workspace-guard";
import { createUserClient } from "@/server/supabase/server";
import { friendlyTimelineError } from "./errors";
import { loadEventLabels } from "./queries";

export type TimelineActionState =
  | { status: "idle" }
  | { status: "ok"; message: string }
  | {
      status: "error";
      message: string;
      fieldErrors: Record<string, string>;
      values: Partial<TimelineFormValues>;
    };

const uuid = z.uuid();
const version = z.coerce.number().int().min(1);
const idemKey = z.string().min(8).max(128);

const FIELDS = [
  "title",
  "date",
  "startTime",
  "endDate",
  "endTime",
  "location",
  "responsibleLabel",
  "contact",
  "notes",
  "assignee",
  "vendor",
  "status",
] as const;

function fail(
  message: string,
  fieldErrors: Record<string, string> = {},
  values: Partial<TimelineFormValues> = {},
): TimelineActionState {
  return { status: "error", message, fieldErrors, values };
}

function read(form: FormData): Partial<TimelineFormValues> {
  const out: Partial<TimelineFormValues> = {};
  for (const f of FIELDS) {
    const v = form.get(f);
    out[f] = typeof v === "string" ? v : "";
  }
  return out;
}

async function authorize(workspaceId: string): Promise<TimelineActionState | null> {
  try {
    await requireCapability(workspaceId, "plan.edit");
    return null;
  } catch (e) {
    if (e instanceof ForbiddenError) return fail(friendlyTimelineError({ code: "42501" }));
    throw e;
  }
}

const refresh = (workspaceId: string) => revalidatePath(`/app/${workspaceId}`, "layout");
const reload = fail("Reload the page and try again.");

export async function createTimelineItem(
  _: TimelineActionState,
  form: FormData,
): Promise<TimelineActionState> {
  const ids = z.object({ workspaceId: uuid, eventId: uuid, idempotencyKey: idemKey }).safeParse({
    workspaceId: form.get("workspaceId"),
    eventId: form.get("eventId"),
    idempotencyKey: form.get("idempotencyKey"),
  });
  if (!ids.success) return reload;
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;

  const values = read(form);
  // The zone is the event's (its own, else the wedding's), read here, never taken from the browser.
  // The database is told which zone the clock time was typed in and refuses the write if it changed.
  const label = (await loadEventLabels(ids.data.workspaceId)).find(
    (e) => e.id === ids.data.eventId,
  );
  if (!label) return reload;
  const zone = label.effectiveTimeZone;
  const parsed = parseTimelineInput(values, zone);
  if (!parsed.ok) return fail("Please fix the highlighted fields.", parsed.fieldErrors, values);
  const v = parsed.value;

  const supabase = await createUserClient();
  const { error } = await supabase.rpc("create_timeline_item", {
    p_wedding: ids.data.workspaceId,
    p_event: ids.data.eventId,
    p_title: v.title,
    p_starts_at: v.startsAt,
    ...(v.endsAt ? { p_ends_at: v.endsAt } : {}),
    ...(v.location ? { p_location: v.location } : {}),
    ...(v.responsibleLabel ? { p_responsible_label: v.responsibleLabel } : {}),
    ...(v.contact ? { p_contact: v.contact } : {}),
    ...(v.notes ? { p_notes: v.notes } : {}),
    ...(v.assignee ? { p_assignee: v.assignee } : {}),
    ...(v.vendor ? { p_vendor: v.vendor } : {}),
    p_status: v.status,
    p_idempotency_key: ids.data.idempotencyKey,
    p_expected_zone: zone,
  });
  if (error) return fail(friendlyTimelineError(error), {}, values);
  refresh(ids.data.workspaceId);
  return { status: "ok", message: "Added to the agenda." };
}

export async function updateTimelineItem(
  _: TimelineActionState,
  form: FormData,
): Promise<TimelineActionState> {
  const ids = z.object({ workspaceId: uuid, itemId: uuid, version }).safeParse({
    workspaceId: form.get("workspaceId"),
    itemId: form.get("itemId"),
    version: form.get("version"),
  });
  if (!ids.success) return reload;
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;

  const values = read(form);
  const supabase = await createUserClient();
  // The item's stored zone is authoritative (the database keeps it equal to its event's zone), so it
  // is read here and never taken from the browser. If the zone changed after the form was opened, the
  // item's version changed with it and the save below is refused as a conflict, not misread.
  const stored = await supabase
    .from("timeline_items")
    .select("timezone")
    .eq("id", ids.data.itemId)
    .eq("wedding_id", ids.data.workspaceId)
    .maybeSingle();
  if (stored.error || !stored.data) return reload;
  const parsed = parseTimelineInput(values, stored.data.timezone);
  if (!parsed.ok) return fail("Please fix the highlighted fields.", parsed.fieldErrors, values);
  const v = parsed.value;

  const { error } = await supabase.rpc("update_timeline_item", {
    p_wedding: ids.data.workspaceId,
    p_item: ids.data.itemId,
    p_expected_version: ids.data.version,
    p_title: v.title,
    p_starts_at: v.startsAt,
    ...(v.endsAt ? { p_ends_at: v.endsAt } : {}),
    ...(v.location ? { p_location: v.location } : {}),
    ...(v.responsibleLabel ? { p_responsible_label: v.responsibleLabel } : {}),
    ...(v.contact ? { p_contact: v.contact } : {}),
    ...(v.notes ? { p_notes: v.notes } : {}),
    ...(v.assignee ? { p_assignee: v.assignee } : {}),
    ...(v.vendor ? { p_vendor: v.vendor } : {}),
    p_status: v.status,
  });
  if (error) return fail(friendlyTimelineError(error), {}, values);
  refresh(ids.data.workspaceId);
  return { status: "ok", message: "Saved." };
}

export async function deleteTimelineItem(
  _: TimelineActionState,
  form: FormData,
): Promise<TimelineActionState> {
  const ids = z.object({ workspaceId: uuid, itemId: uuid, version }).safeParse({
    workspaceId: form.get("workspaceId"),
    itemId: form.get("itemId"),
    version: form.get("version"),
  });
  if (!ids.success) return reload;
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const supabase = await createUserClient();
  const { error } = await supabase.rpc("delete_timeline_item", {
    p_wedding: ids.data.workspaceId,
    p_item: ids.data.itemId,
    p_expected_version: ids.data.version,
  });
  if (error) return fail(friendlyTimelineError(error));
  refresh(ids.data.workspaceId);
  return { status: "ok", message: "Removed from the agenda." };
}
