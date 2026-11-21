"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { parseTimelineInput, type TimelineFormValues } from "@/domain/timeline/timeline";
import { ForbiddenError, requireCapability } from "@/server/auth/workspace-guard";
import { createUserClient } from "@/server/supabase/server";
import { loadWeddingSettings } from "@/server/workspace/queries";
import { friendlyTimelineError } from "./errors";

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
  // The zone comes from the workspace, never from the browser.
  const settings = await loadWeddingSettings(ids.data.workspaceId);
  const parsed = parseTimelineInput(values, settings.timezone);
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
  const timezone = z.string().min(1).max(64).safeParse(form.get("timezone"));
  if (!timezone.success) return reload;
  const parsed = parseTimelineInput(values, timezone.data);
  if (!parsed.ok) return fail("Please fix the highlighted fields.", parsed.fieldErrors, values);
  const v = parsed.value;

  const supabase = await createUserClient();
  // The item's stored zone is authoritative: a tampered zone field can only misread the
  // wall-clock the person typed, and the RPC never accepts a zone.
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
