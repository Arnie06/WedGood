"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { validateEvent } from "@/domain/events/event";
import { buildInvitationGroups } from "@/domain/events/invitation";
import { parsePublicEnv } from "@/lib/env";
import { ForbiddenError, requireCapability } from "@/server/auth/workspace-guard";
import { generateInviteToken } from "@/server/members/invite-token";
import { createUserClient } from "@/server/supabase/server";
import { friendlyEventError } from "./errors";

export type IssuedLink = { invitationId: string; label: string; url: string | null };

export type EventActionState =
  | { status: "idle" }
  | { status: "ok"; message: string; links?: IssuedLink[] }
  | {
      status: "error";
      message: string;
      fieldErrors: Record<string, string>;
      values: Record<string, string>;
    };

const uuid = z.uuid();
const version = z.coerce.number().int().min(0);
const idemKey = z.string().min(8).max(128);

function fail(
  message: string,
  fieldErrors: Record<string, string> = {},
  values: Record<string, string> = {},
): EventActionState {
  return { status: "error", message, fieldErrors, values };
}

async function authorize(workspaceId: string): Promise<EventActionState | null> {
  try {
    await requireCapability(workspaceId, "guests.manage");
    return null;
  } catch (e) {
    if (e instanceof ForbiddenError) return fail(friendlyEventError({ code: "42501" }));
    throw e;
  }
}

const refresh = (workspaceId: string) => revalidatePath(`/app/${workspaceId}`, "layout");

function readValues(form: FormData, fields: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = form.get(f);
    out[f] = typeof v === "string" ? v : "";
  }
  return out;
}

function linkFor(raw: string): string | null {
  try {
    return new URL(`/rsvp/${raw}`, parsePublicEnv(process.env).appUrl).toString();
  } catch {
    return null;
  }
}

const EVENT_FIELDS = ["name", "kind", "localDate", "targetAttendance", "capacity"] as const;

export async function saveEvent(_: EventActionState, form: FormData): Promise<EventActionState> {
  const values = readValues(form, EVENT_FIELDS);
  const ids = z
    .object({
      workspaceId: uuid,
      eventId: uuid.optional(),
      version: version.optional(),
      key: idemKey.optional(),
    })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      eventId: form.get("eventId") || undefined,
      version: form.get("version") || undefined,
      key: form.get("idempotencyKey") || undefined,
    });
  if (!ids.success) return fail("Reload the page and try again.", {}, values);
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const checked = validateEvent(values);
  if (!checked.ok) return fail("Please check the highlighted details.", checked.errors, values);
  const supabase = await createUserClient();
  if (ids.data.eventId) {
    if (ids.data.version === undefined) return fail("Reload the page and try again.", {}, values);
    const { error } = await supabase.rpc("update_event", {
      p_wedding: ids.data.workspaceId,
      p_event_id: ids.data.eventId,
      p_expected_version: ids.data.version,
      p_event: checked.event,
    });
    if (error) return failEvent(error, values);
    refresh(ids.data.workspaceId);
    return { status: "ok", message: "Saved." };
  }
  const { error } = await supabase.rpc("create_event", {
    p_wedding: ids.data.workspaceId,
    p_event: checked.event,
    ...(ids.data.key && { p_idempotency_key: ids.data.key }),
  });
  if (error) return failEvent(error, values);
  refresh(ids.data.workspaceId);
  return { status: "ok", message: `Added ${checked.event.name}.` };
}

function failEvent(error: { code?: string }, values: Record<string, string>): EventActionState {
  return error.code === "23505"
    ? fail(
        "Please check the highlighted details.",
        { name: "You already have an event with that name." },
        values,
      )
    : fail(friendlyEventError(error), {}, values);
}

export async function addMealOption(
  _: EventActionState,
  form: FormData,
): Promise<EventActionState> {
  const ids = z.object({ workspaceId: uuid, eventId: uuid }).safeParse({
    workspaceId: form.get("workspaceId"),
    eventId: form.get("eventId"),
  });
  const values = readValues(form, ["name"]);
  if (!ids.success) return fail("Reload the page and try again.", {}, values);
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const name = (values.name ?? "").replace(/\s+/g, " ").trim();
  if (name === "") return fail("Add a name.", { name: "Add a name for this meal." }, values);
  if (name.length > 80)
    return fail(
      "Please check the highlighted details.",
      { name: "Use 80 characters or fewer." },
      values,
    );
  const supabase = await createUserClient();
  const { error } = await supabase.rpc("add_meal_option", {
    p_wedding: ids.data.workspaceId,
    p_event_id: ids.data.eventId,
    p_name: name,
  });
  if (error) {
    return error.code === "23505"
      ? fail(
          "Please check the highlighted details.",
          { name: "That meal is already listed for this event." },
          values,
        )
      : fail(friendlyEventError(error), {}, values);
  }
  refresh(ids.data.workspaceId);
  return { status: "ok", message: `Added ${name}.` };
}

export async function setMealOptionActive(
  _: EventActionState,
  form: FormData,
): Promise<EventActionState> {
  const ids = z
    .object({ workspaceId: uuid, optionId: uuid, version, active: z.enum(["true", "false"]) })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      optionId: form.get("optionId"),
      version: form.get("version"),
      active: form.get("active"),
    });
  if (!ids.success) return fail("Reload the page and try again.");
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const supabase = await createUserClient();
  const active = ids.data.active === "true";
  const { error } = await supabase.rpc("set_meal_option_active", {
    p_wedding: ids.data.workspaceId,
    p_option_id: ids.data.optionId,
    p_expected_version: ids.data.version,
    p_active: active,
  });
  if (error) return fail(friendlyEventError(error));
  refresh(ids.data.workspaceId);
  return {
    status: "ok",
    message: active
      ? "Offered again."
      : "No longer offered. Guests who chose it keep their choice.",
  };
}

/** Parses a `datetime-local`-style or date value as end of that day in UTC. Null when blank. */
function endOfDay(raw: string): string | null | "invalid" {
  if (raw === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return "invalid";
  const d = new Date(`${raw}T23:59:59Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw
    ? "invalid"
    : d.toISOString();
}

export async function createInvitations(
  _: EventActionState,
  form: FormData,
): Promise<EventActionState> {
  const values = readValues(form, ["deadline", "expires", "plusOnes"]);
  const ids = z.object({ workspaceId: uuid, eventId: uuid, key: idemKey }).safeParse({
    workspaceId: form.get("workspaceId"),
    eventId: form.get("eventId"),
    key: form.get("idempotencyKey"),
  });
  if (!ids.success) return fail("Reload the page and try again.", {}, values);
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;

  const errors: Record<string, string> = {};
  const quota = /^[0-5]$/.test(values.plusOnes ?? "") ? Number(values.plusOnes) : null;
  if (quota === null) errors.plusOnes = "Choose 0 to 5.";
  const deadline = endOfDay((values.deadline ?? "").trim());
  if (deadline === "invalid") errors.deadline = "Use a real date.";
  const expiresRaw = (values.expires ?? "").trim();
  const expires = endOfDay(expiresRaw);
  if (expires === "invalid" || expires === null)
    errors.expires = "Choose when the link stops working.";
  const now = Date.now();
  if (
    typeof deadline === "string" &&
    deadline !== "invalid" &&
    new Date(deadline).getTime() <= now
  ) {
    errors.deadline = "Choose a date in the future.";
  }
  if (typeof expires === "string" && new Date(expires).getTime() <= now) {
    errors.expires = "Choose a date in the future.";
  }
  if (
    typeof expires === "string" &&
    typeof deadline === "string" &&
    deadline !== "invalid" &&
    deadline > expires
  ) {
    errors.deadline = "The response deadline should not be after the link stops working.";
  }

  const pickedHouseholds = form
    .getAll("household")
    .filter((v): v is string => typeof v === "string" && uuid.safeParse(v).success);
  const pickedGuests = form
    .getAll("guest")
    .filter((v): v is string => typeof v === "string" && uuid.safeParse(v).success);
  if (pickedHouseholds.length + pickedGuests.length === 0) {
    errors.picks = "Choose at least one household or guest.";
  }
  if (Object.keys(errors).length > 0 || quota === null || typeof expires !== "string") {
    return fail("Please check the highlighted details.", errors, values);
  }

  const supabase = await createUserClient();
  const [guests, invited] = await Promise.all([
    supabase
      .from("guests")
      .select("id, household_id")
      .eq("wedding_id", ids.data.workspaceId)
      .is("archived_at", null)
      .limit(2500),
    supabase
      .from("invitation_members")
      .select("guest_id")
      .eq("wedding_id", ids.data.workspaceId)
      .eq("event_id", ids.data.eventId)
      .eq("active", true)
      .limit(5000),
  ]);
  if (guests.error || invited.error) return fail(friendlyEventError({}), {}, values);
  const built = buildInvitationGroups({
    guests: guests.data.map((g) => ({ id: g.id, householdId: g.household_id })),
    pickedHouseholdIds: pickedHouseholds,
    pickedGuestIds: pickedGuests,
    alreadyInvited: new Set(invited.data.map((m) => m.guest_id)),
  });
  if (built.groups.length === 0) {
    return fail(
      "Everyone you chose is already invited to this event.",
      { picks: "Choose guests who aren't invited yet." },
      values,
    );
  }
  const tokens = built.groups.map(() => generateInviteToken());
  const { data, error } = await supabase.rpc("create_invitations", {
    p_wedding: ids.data.workspaceId,
    p_event_id: ids.data.eventId,
    p_groups: built.groups,
    p_plus_one_quota: quota,
    ...(typeof deadline === "string" && deadline !== "invalid" && { p_deadline: deadline }),
    p_expires_at: expires,
    p_token_hashes: tokens.map((t) => t.hash),
    p_idempotency_key: ids.data.key,
  });
  if (error) return fail(friendlyEventError(error), {}, values);
  refresh(ids.data.workspaceId);
  // The database returns rows in creation order, matching the token order we sent. On an
  // idempotent replay the raw links are gone by design; the owner reissues a link instead.
  const rows = data ?? [];
  const replay = rows.some((r) => r.o_replayed);
  const links: IssuedLink[] = rows.map((r, i) => ({
    invitationId: r.o_invitation_id,
    label: r.o_label,
    url: replay ? null : linkFor(tokens[i]?.raw ?? ""),
  }));
  const skipped = built.skipped > 0 ? ` ${built.skipped} already invited were skipped.` : "";
  return {
    status: "ok",
    message: `Created ${rows.length} ${rows.length === 1 ? "invitation" : "invitations"}. Nothing has been sent. Copy each link and share it yourself.${skipped}`,
    links,
  };
}

export async function reissueInvitation(
  _: EventActionState,
  form: FormData,
): Promise<EventActionState> {
  const ids = z
    .object({ workspaceId: uuid, invitationId: uuid, version, label: z.string().max(120) })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      invitationId: form.get("invitationId"),
      version: form.get("version"),
      label: form.get("label") ?? "",
    });
  if (!ids.success) return fail("Reload the page and try again.");
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const token = generateInviteToken();
  const supabase = await createUserClient();
  const { error } = await supabase.rpc("reissue_invitation", {
    p_wedding: ids.data.workspaceId,
    p_invitation_id: ids.data.invitationId,
    p_expected_version: ids.data.version,
    p_token_hash: token.hash,
  });
  if (error) return fail(friendlyEventError(error));
  refresh(ids.data.workspaceId);
  return {
    status: "ok",
    message: "New link created. The old link no longer works.",
    links: [
      { invitationId: ids.data.invitationId, label: ids.data.label, url: linkFor(token.raw) },
    ],
  };
}

export async function revokeInvitation(
  _: EventActionState,
  form: FormData,
): Promise<EventActionState> {
  const ids = z.object({ workspaceId: uuid, invitationId: uuid, version }).safeParse({
    workspaceId: form.get("workspaceId"),
    invitationId: form.get("invitationId"),
    version: form.get("version"),
  });
  if (!ids.success) return fail("Reload the page and try again.");
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const supabase = await createUserClient();
  const { error } = await supabase.rpc("revoke_invitation", {
    p_wedding: ids.data.workspaceId,
    p_invitation_id: ids.data.invitationId,
    p_expected_version: ids.data.version,
  });
  if (error) return fail(friendlyEventError(error));
  refresh(ids.data.workspaceId);
  return { status: "ok", message: "Revoked. The link stops working now." };
}

/** Records what the owner did ("I shared this link"). The app never claims delivery or a read. */
export async function setInvitationDelivery(
  _: EventActionState,
  form: FormData,
): Promise<EventActionState> {
  const ids = z
    .object({ workspaceId: uuid, invitationId: uuid, version, shared: z.enum(["yes", "no"]) })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      invitationId: form.get("invitationId"),
      version: form.get("version"),
      shared: form.get("shared"),
    });
  if (!ids.success) return fail("Reload the page and try again.");
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const supabase = await createUserClient();
  const shared = ids.data.shared === "yes";
  const { error } = await supabase.rpc("set_invitation_delivery", {
    p_wedding: ids.data.workspaceId,
    p_invitation_id: ids.data.invitationId,
    p_expected_version: ids.data.version,
    p_shared: shared,
  });
  if (error) return fail(friendlyEventError(error));
  refresh(ids.data.workspaceId);
  return {
    status: "ok",
    message: shared ? "Marked as shared by you." : "Marked as not shared.",
  };
}

export async function overrideResponse(
  _: EventActionState,
  form: FormData,
): Promise<EventActionState> {
  const ids = z
    .object({
      workspaceId: uuid,
      memberId: uuid,
      status: z.enum(["pending", "accepted", "declined"]),
      meal: z.union([uuid, z.literal("")]),
    })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      memberId: form.get("memberId"),
      status: form.get("status"),
      meal: form.get("meal") ?? "",
    });
  const values = readValues(form, ["reason"]);
  if (!ids.success) return fail("Reload the page and try again.", {}, values);
  const denied = await authorize(ids.data.workspaceId);
  if (denied) return denied;
  const reason = (values.reason ?? "").replace(/\s+/g, " ").trim();
  if (reason === "")
    return fail("Add a short reason.", { reason: "Say why you are changing this." }, values);
  if (reason.length > 200)
    return fail(
      "Please check the highlighted details.",
      { reason: "Use 200 characters or fewer." },
      values,
    );
  const supabase = await createUserClient();
  const { error } = await supabase.rpc("override_rsvp_response", {
    p_wedding: ids.data.workspaceId,
    p_member_id: ids.data.memberId,
    p_status: ids.data.status,
    ...(ids.data.meal !== "" && { p_meal_option_id: ids.data.meal }),
    p_reason: reason,
  });
  if (error) return fail(friendlyEventError(error), {}, values);
  refresh(ids.data.workspaceId);
  return { status: "ok", message: "Response updated and recorded." };
}
