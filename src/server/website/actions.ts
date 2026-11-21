"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { LIMITS, parseSiteForm, validateSlug } from "@/domain/website/site";
import { ForbiddenError, requireCapability } from "@/server/auth/workspace-guard";
import { createUserClient } from "@/server/supabase/server";
import { friendlyWebsiteError } from "./errors";

export type WebsiteActionState =
  | { status: "idle" }
  | { status: "ok"; message: string }
  | {
      status: "error";
      message: string;
      fieldErrors: Record<string, string>;
      values: Record<string, string>;
    };

const uuid = z.uuid();
const version = z.coerce.number().int().min(0);

function fail(
  message: string,
  fieldErrors: Record<string, string> = {},
  values: Record<string, string> = {},
): WebsiteActionState {
  return { status: "error", message, fieldErrors, values };
}

async function authorize(workspaceId: string): Promise<WebsiteActionState | null> {
  try {
    await requireCapability(workspaceId, "plan.edit");
    return null;
  } catch (e) {
    if (e instanceof ForbiddenError) return fail(friendlyWebsiteError({ code: "42501" }));
    throw e;
  }
}

const refresh = (workspaceId: string) => revalidatePath(`/app/${workspaceId}/website`, "layout");
const RELOAD = "Reload the page and try again.";

/** Echoes every submitted text field so a failed save never loses what was typed. */
function readValues(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of form.entries()) {
    if (typeof value === "string" && name.length <= 80 && !name.startsWith("$")) out[name] = value;
  }
  return out;
}

export async function saveSite(_: WebsiteActionState, form: FormData): Promise<WebsiteActionState> {
  const values = readValues(form);
  const ids = z
    .object({ workspaceId: uuid, version })
    .safeParse({ workspaceId: form.get("workspaceId"), version: form.get("version") });
  if (!ids.success) return fail(RELOAD, {}, values);
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;

  const supabase = await createUserClient();
  // Only this workspace's own events can be shown; RLS limits the read to owners and partners.
  const events = await supabase
    .from("events")
    .select("id")
    .eq("wedding_id", ids.data.workspaceId)
    .order("created_at")
    .limit(LIMITS.eventCount);
  if (events.error) return fail(friendlyWebsiteError(events.error), {}, values);

  const parsed = parseSiteForm(
    values,
    events.data.map((e) => e.id),
  );
  if (!parsed.ok) return fail("Please check the highlighted details.", parsed.errors, values);

  const { error } = await supabase.rpc("save_site_draft", {
    p_wedding: ids.data.workspaceId,
    p_expected_version: ids.data.version,
    p_draft: parsed.draft,
  });
  if (error) return fail(friendlyWebsiteError(error), {}, values);
  refresh(ids.data.workspaceId);
  return { status: "ok", message: "Draft saved. Nothing is public until you publish." };
}

export async function publishSite(
  _: WebsiteActionState,
  form: FormData,
): Promise<WebsiteActionState> {
  const values = readValues(form);
  const ids = z
    .object({ workspaceId: uuid, version })
    .safeParse({ workspaceId: form.get("workspaceId"), version: form.get("version") });
  if (!ids.success) return fail(RELOAD, {}, values);
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  if (form.get("confirm") !== "yes") {
    return fail(
      "Please confirm that you want this page to be public.",
      { confirm: "Required." },
      values,
    );
  }
  const slug = validateSlug(String(form.get("slug") ?? ""));
  if (!slug.ok) return fail("Please check the web address.", { slug: slug.error }, values);

  const supabase = await createUserClient();
  const { error } = await supabase.rpc("publish_site", {
    p_wedding: ids.data.workspaceId,
    p_expected_version: ids.data.version,
    p_slug: slug.slug,
  });
  if (error) {
    const message = friendlyWebsiteError(error);
    return error.code === "23505"
      ? fail(message, { slug: "That address is taken." }, values)
      : fail(message, {}, values);
  }
  refresh(ids.data.workspaceId);
  return { status: "ok", message: "Published. Your website is now public." };
}

export async function unpublishSite(
  _: WebsiteActionState,
  form: FormData,
): Promise<WebsiteActionState> {
  const ids = z
    .object({ workspaceId: uuid, version })
    .safeParse({ workspaceId: form.get("workspaceId"), version: form.get("version") });
  if (!ids.success) return fail(RELOAD);
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const supabase = await createUserClient();
  const { error } = await supabase.rpc("unpublish_site", {
    p_wedding: ids.data.workspaceId,
    p_expected_version: ids.data.version,
  });
  if (error) return fail(friendlyWebsiteError(error));
  refresh(ids.data.workspaceId);
  return { status: "ok", message: "Unpublished. The public page is gone." };
}
