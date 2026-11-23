"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { canonical, definitionProblems, parseDefinition } from "@/domain/guests/rsvp-form";
import { ForbiddenError, requireCapability } from "@/server/auth/workspace-guard";
import { formBuilderEnabled } from "@/server/rsvp/flags";
import { createUserClient } from "@/server/supabase/server";
import { friendlyEventError } from "./errors";

export type RsvpFormActionState =
  | { status: "idle" }
  | { status: "ok"; message: string; version: number }
  | { status: "error"; message: string };

const MAX_DRAFT = 40_000;

function friendlyFormError(error: { code?: string }): string {
  switch (error.code) {
    case "55000":
      return "Someone changed these questions while you were editing. Reload to see the latest, then make your change again.";
    case "RF409":
      return "A question guests have already seen can't change its type. Remove it and add a new question instead.";
    case "22023":
      return "Please check the questions and try again.";
    default:
      return friendlyEventError(error);
  }
}

/**
 * Saves the couple's draft questions for one event and, with intent "publish", publishes that
 * draft to guests. Publishing is two calls: the draft is saved first, then the saved version is
 * published. If the second fails the draft is still saved (a normal state), and nothing reaches
 * guests until a publish succeeds.
 */
export async function saveRsvpForm(
  _: RsvpFormActionState,
  form: FormData,
): Promise<RsvpFormActionState> {
  if (!formBuilderEnabled())
    return { status: "error", message: "Guest questions are switched off." };
  const ids = z
    .object({
      workspaceId: z.uuid(),
      eventId: z.uuid(),
      version: z.coerce.number().int().min(0).max(999_999_999),
      intent: z.enum(["save", "publish"]),
    })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      eventId: form.get("eventId"),
      version: form.get("version"),
      intent: form.get("intent"),
    });
  if (!ids.success) return { status: "error", message: "Reload the page and try again." };
  try {
    await requireCapability(ids.data.workspaceId, "guests.manage");
  } catch (e) {
    if (e instanceof ForbiddenError)
      return { status: "error", message: friendlyFormError({ code: "42501" }) };
    throw e;
  }
  const raw = form.get("draft");
  let json: unknown = null;
  if (typeof raw === "string" && raw.length <= MAX_DRAFT) {
    try {
      json = JSON.parse(raw);
    } catch {
      json = null;
    }
  }
  const def = parseDefinition(json);
  if (!def) return { status: "error", message: "Please check the questions and try again." };
  if (definitionProblems(def).length > 0) {
    return { status: "error", message: "Some questions need fixing first. They are marked below." };
  }

  const supabase = await createUserClient();
  const saved = await supabase.rpc("save_rsvp_form_draft", {
    p_wedding: ids.data.workspaceId,
    p_event_id: ids.data.eventId,
    p_expected_version: ids.data.version,
    p_draft: canonical(def),
  });
  if (saved.error) return { status: "error", message: friendlyFormError(saved.error) };
  const version = saved.data;
  const refresh = () => revalidatePath(`/app/${ids.data.workspaceId}`, "layout");
  if (ids.data.intent === "save") {
    refresh();
    return {
      status: "ok",
      message: "Draft saved. Guests don't see it until you publish.",
      version,
    };
  }
  const published = await supabase.rpc("publish_rsvp_form", {
    p_wedding: ids.data.workspaceId,
    p_event_id: ids.data.eventId,
    p_expected_version: version,
  });
  refresh();
  if (published.error) {
    return {
      status: "error",
      message: `Your draft is saved, but it wasn't published. ${friendlyFormError(published.error)}`,
    };
  }
  const after = await supabase
    .from("rsvp_forms")
    .select("version")
    .eq("wedding_id", ids.data.workspaceId)
    .eq("event_id", ids.data.eventId)
    .maybeSingle();
  return {
    status: "ok",
    message:
      def.questions.length === 0
        ? `Published version ${published.data}. Guests are no longer asked your questions.`
        : `Published version ${published.data}. Guests see these questions from now on.`,
    version: after.data?.version ?? version,
  };
}
