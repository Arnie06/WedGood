"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { friendlyRsvpError } from "@/server/events/errors";
import { createAdminClient } from "@/server/supabase/admin";
import { formBuilderEnabled, guestDetailsEnabled } from "./flags";
import { clientKey, rsvpViewSchema, toPublicView, tokenDigest, type RsvpView } from "./public";

export type RsvpActionState =
  | { status: "idle" }
  | { status: "ok"; message: string; view: RsvpView }
  | { status: "error"; message: string; view?: RsvpView };

const uuid = z.uuid();
const MAX_NAME = 120;
const MAX_DETAILS = 500;
const MAX_ANSWER = 500;
const QUESTION_KEY = /^q_[a-z0-9]{8}$/;

/**
 * Answers to the couple's questions posted as `${prefix}${questionKey}` (UX-11). Blank is left out.
 * Null when one is over the limit. Which keys and values are allowed is the database's call.
 */
function answerFields(form: FormData, prefix: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [name, value] of form.entries()) {
    if (!name.startsWith(prefix) || typeof value !== "string") continue;
    const key = name.slice(prefix.length);
    if (!QUESTION_KEY.test(key)) continue;
    const v = value.trim();
    if (v === "") continue;
    if (v.length > MAX_ANSWER) return null;
    out[key] = v;
    if (Object.keys(out).length > 10) return null;
  }
  return out;
}

/** Trimmed text from a form field; blank is "nothing typed". Over the limit is refused by the caller. */
function textField(form: FormData, name: string): string | null {
  const v = form.get(name);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

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
  const askDetails = guestDetailsEnabled();
  // The couple's questions: only with the switch on and a published version named by the page.
  const formVersion = form.get("formVersionId");
  const formVersionId =
    formBuilderEnabled() && typeof formVersion === "string" && uuid.safeParse(formVersion).success
      ? formVersion
      : null;
  const responses: {
    memberId: string;
    status: string;
    mealOptionId: string | null;
    remove?: true;
    dietary?: string;
    accessibility?: string;
    answers?: Record<string, string>;
  }[] = [];
  let tooLong = false;
  let answerTooLong = false;
  const answers = (prefix: string) => {
    if (formVersionId === null) return {};
    const found = answerFields(form, prefix);
    if (found === null) {
      answerTooLong = true;
      return {};
    }
    return Object.keys(found).length > 0 ? { answers: found } : {};
  };
  const notes = (dietary: string | null, accessibility: string | null) => {
    if ((dietary?.length ?? 0) > MAX_DETAILS || (accessibility?.length ?? 0) > MAX_DETAILS) {
      tooLong = true;
    }
    return {
      ...(dietary !== null && { dietary }),
      ...(accessibility !== null && { accessibility }),
    };
  };
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
      // Taking a guest-added plus-one off the reply. The database checks they really were added by
      // the guest; anything else is refused.
      ...(status === "declined" && form.get(`remove_${id}`) === "1" && { remove: true as const }),
      // Notes for the couple come only with an "attending" answer and only when the step is on.
      ...(status === "accepted" &&
        askDetails &&
        notes(textField(form, `dietary_${id}`), textField(form, `access_${id}`))),
      ...(status === "accepted" && answers(`ans_${id}_`)),
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
          ...(askDetails &&
            notes(textField(form, "plusOneDietary"), textField(form, "plusOneAccess"))),
          ...answers("plusOneAns_"),
        }
      : null;
  if (responses.length === 0 && !plusOne) {
    return { status: "error", message: "Choose yes or no for at least one person." };
  }
  if (tooLong) {
    return {
      status: "error",
      message: `Use ${MAX_DETAILS} characters or fewer for each note to the couple.`,
    };
  }
  if (answerTooLong) {
    return {
      status: "error",
      message: `Use ${MAX_ANSWER} characters or fewer for each answer.`,
    };
  }
  if (plusOne && plusOne.name.length > MAX_NAME) {
    return { status: "error", message: `Use ${MAX_NAME} characters or fewer for the name.` };
  }

  const admin = createAdminClient();
  const client = await clientKey();
  if (!admin || !client) {
    return {
      status: "error",
      message: "Responses aren't available right now. Please try again later.",
    };
  }
  const { data, error } = await admin.rpc("rsvp_submit", {
    p_token_hash: digest,
    p_client: client,
    p_expected_version: version.data,
    p_responses: responses,
    ...(plusOne && { p_plus_one: plusOne }),
    ...(formVersionId && { p_form_version: formVersionId }),
  });
  if (error) {
    // After a stale-version conflict, return the current state so the guest can review it.
    let view: RsvpView | undefined;
    // A missing required answer (RF422) keeps the guest's draft: nothing to reload.
    if (error.code === "55000" || error.code === "RS410") {
      const again = await admin.rpc("rsvp_view", {
        p_token_hash: digest,
        p_client: client,
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
