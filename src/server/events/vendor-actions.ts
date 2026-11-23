"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { diffLinks } from "@/domain/events/vendors";
import { ForbiddenError, requireCapability } from "@/server/auth/workspace-guard";
import { friendlyCandidateError } from "@/server/candidates/errors";
import { createUserClient } from "@/server/supabase/server";

export type VendorLinkState =
  { status: "idle" } | { status: "ok"; message: string } | { status: "error"; message: string };

const uuid = z.uuid();
const ids = z.array(uuid).max(50);

function fail(message: string): VendorLinkState {
  return { status: "error", message };
}

function readIds(form: FormData, name: string): string[] | null {
  const parsed = ids.safeParse(form.getAll(name).map(String));
  return parsed.success ? parsed.data : null;
}

function summary(added: number, removed: number): string {
  if (added + removed === 0) return "Nothing changed.";
  const parts: string[] = [];
  if (added > 0) parts.push(`${added} added`);
  if (removed > 0) parts.push(`${removed} removed`);
  return `Saved. ${parts.join(", ")}.`;
}

function counts(data: unknown): { added: number; removed: number } {
  const d = (data ?? {}) as { added?: unknown; removed?: unknown };
  return { added: Number(d.added ?? 0), removed: Number(d.removed ?? 0) };
}

async function authorize(workspaceId: string): Promise<VendorLinkState | null> {
  try {
    await requireCapability(workspaceId, "vendors.manage");
    return null;
  } catch (e) {
    if (e instanceof ForbiddenError) return fail(friendlyCandidateError({ code: "42501" }));
    throw e;
  }
}

function linkError(error: { code?: string }): VendorLinkState {
  if (error.code === "22023")
    return fail(
      "A vendor you've passed on or removed can't be added to an event. Choose again, or reload.",
    );
  if (error.code === "42501")
    return fail(
      "That event or vendor isn't in your plan any more, or you can't change vendors. Reload and try again.",
    );
  return fail(friendlyCandidateError(error));
}

/**
 * From a vendor: sets which events it works at. The form sends what was shown (`initial`) and what
 * is ticked (`eventId`); only the difference is applied, so someone else's change to a different
 * link is not undone. Nothing is sent to the vendor and no booking, quote or payment changes.
 */
export async function setVendorEvents(
  _: VendorLinkState,
  form: FormData,
): Promise<VendorLinkState> {
  const head = z
    .object({ workspaceId: uuid, vendorId: uuid })
    .safeParse({ workspaceId: form.get("workspaceId"), vendorId: form.get("vendorId") });
  const initial = readIds(form, "initial");
  const selected = readIds(form, "eventId");
  if (!head.success || !initial || !selected) return fail("Reload the page and try again.");
  const denied = await authorize(head.data.workspaceId);
  if (denied) return denied;
  const { add, remove } = diffLinks(initial, selected);
  if (add.length + remove.length === 0) return { status: "ok", message: "Nothing changed." };

  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc("set_vendor_events", {
    p_wedding: head.data.workspaceId,
    p_candidate: head.data.vendorId,
    p_add: add,
    p_remove: remove,
  });
  if (error) return linkError(error);
  revalidatePath(`/app/${head.data.workspaceId}`, "layout");
  const c = counts(data);
  return { status: "ok", message: summary(c.added, c.removed) };
}

/** From an event: sets which vendors work at it. Same rules as `setVendorEvents`. */
export async function setEventVendors(
  _: VendorLinkState,
  form: FormData,
): Promise<VendorLinkState> {
  const head = z
    .object({ workspaceId: uuid, eventId: uuid })
    .safeParse({ workspaceId: form.get("workspaceId"), eventId: form.get("eventId") });
  const initial = readIds(form, "initial");
  const selected = readIds(form, "vendorId");
  if (!head.success || !initial || !selected) return fail("Reload the page and try again.");
  const denied = await authorize(head.data.workspaceId);
  if (denied) return denied;
  const { add, remove } = diffLinks(initial, selected);
  if (add.length + remove.length === 0) return { status: "ok", message: "Nothing changed." };

  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc("set_event_vendors", {
    p_wedding: head.data.workspaceId,
    p_event: head.data.eventId,
    p_add: add,
    p_remove: remove,
  });
  if (error) return linkError(error);
  revalidatePath(`/app/${head.data.workspaceId}`, "layout");
  const c = counts(data);
  return { status: "ok", message: summary(c.added, c.removed) };
}
