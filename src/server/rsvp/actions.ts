"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { friendlyRsvpError } from "@/server/events/errors";
import { createAdminClient } from "@/server/supabase/admin";
import { clientKey, rsvpViewSchema, toPublicView, tokenDigest, type RsvpView } from "./public";

export type RsvpActionState =
  | { status: "idle" }
  | { status: "ok"; message: string; view: RsvpView }
  | { status: "error"; message: string; view?: RsvpView };

const uuid = z.uuid();
const MAX_NAME = 120;

/** Public, accountless response. The token is the only credential; nothing else is trusted. */
export async function submitRsvp(_: RsvpActionState, form: FormData): Promise<RsvpActionState> {
  const token = form.get("token");
  const digest = typeof token === "string" ? tokenDigest(token) : null;
  const version = z.coerce.number().int().min(0).safeParse(form.get("version"));
  if (!digest || !version.success) {
    return { status: "error", message: "This link isn't working. Ask the couple for a new one." };
  }
  const memberIds = form
    .getAll("memberId")
    .filter((v): v is string => typeof v === "string" && uuid.safeParse(v).success)
    .slice(0, 13);
  const responses: { memberId: string; status: string; mealOptionId: string | null }[] = [];
  for (const id of memberIds) {
    const status = form.get(`status_${id}`);
    if (status !== "accepted" && status !== "declined") continue;
    const meal = form.get(`meal_${id}`);
    responses.push({
      memberId: id,
      status,
      mealOptionId:
        status === "accepted" && typeof meal === "string" && uuid.safeParse(meal).success
          ? meal
          : null,
    });
  }
  const plusName = form.get("plusOneName");
  const plusMeal = form.get("plusOneMeal");
  const plusOne =
    typeof plusName === "string" && plusName.trim() !== ""
      ? {
          name: plusName.trim().slice(0, MAX_NAME + 1),
          mealOptionId:
            typeof plusMeal === "string" && uuid.safeParse(plusMeal).success ? plusMeal : null,
        }
      : null;
  if (responses.length === 0 && !plusOne) {
    return { status: "error", message: "Choose yes or no for at least one person." };
  }
  if (plusOne && plusOne.name.length > MAX_NAME) {
    return { status: "error", message: `Use ${MAX_NAME} characters or fewer for the name.` };
  }

  const admin = createAdminClient();
  if (!admin) {
    return {
      status: "error",
      message: "Responses aren't available right now. Please try again later.",
    };
  }
  const { data, error } = await admin.rpc("rsvp_submit", {
    p_token_hash: digest,
    p_client: await clientKey(),
    p_expected_version: version.data,
    p_responses: responses,
    ...(plusOne && { p_plus_one: plusOne }),
  });
  if (error) {
    // After a stale-version conflict, return the current state so the guest can review it.
    let view: RsvpView | undefined;
    if (error.code === "55000" || error.code === "RS410") {
      const again = await admin.rpc("rsvp_view", {
        p_token_hash: digest,
        p_client: await clientKey(),
      });
      const parsed = rsvpViewSchema.safeParse(again.data);
      if (parsed.success) view = toPublicView(parsed.data);
    }
    return view
      ? { status: "error", message: friendlyRsvpError(error), view }
      : { status: "error", message: friendlyRsvpError(error) };
  }
  if (data === null) {
    return { status: "error", message: "This link isn't working. Ask the couple for a new one." };
  }
  const parsed = rsvpViewSchema.safeParse(data);
  if (!parsed.success) return { status: "error", message: friendlyRsvpError({}) };
  revalidatePath(`/app/${parsed.data.workspaceId}`, "layout");
  return {
    status: "ok",
    message: "Thank you. Your response is saved.",
    view: toPublicView(parsed.data),
  };
}
