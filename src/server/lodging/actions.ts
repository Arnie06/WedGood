"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { todayInZone } from "@/domain/dates/date-only";
import { blockNights } from "@/domain/lodging/attrition";
import {
  parseBlockInput,
  parseHotelInput,
  parsePickupInput,
  type BlockInput,
  type HotelInput,
} from "@/domain/lodging/input";
import { isStayKind } from "@/domain/lodging/stays";
import { ForbiddenError, requireCapability } from "@/server/auth/workspace-guard";
import type { EventActionState } from "@/server/events/actions";
import { createUserClient } from "@/server/supabase/server";
import { loadWeddingSettings } from "@/server/workspace/queries";
import { friendlyLodgingError } from "./errors";
import { lodgingEnabled } from "./flag";

const uuid = z.uuid();
const version = z.coerce.number().int().min(1).max(999_999_999);

const HOTEL_FIELDS = [
  "name",
  "address",
  "phone",
  "websiteUrl",
  "guestNote",
  "showToGuests",
  "showRate",
  "candidateId",
] as const;
const BLOCK_FIELDS = [
  "label",
  "checkIn",
  "checkOut",
  "roomsPerNight",
  "nightlyRate",
  "attritionPercent",
  "attritionCharge",
  "cutoffDate",
  "bookingUrl",
  "bookingCode",
  "budgetCategoryId",
] as const;

function fail(
  message: string,
  fieldErrors: Record<string, string> = {},
  values: Record<string, string> = {},
): EventActionState {
  return { status: "error", message, fieldErrors, values };
}
const reload = fail("Reload the page and try again.");
const CHECK = "Please check the highlighted details.";

function read(form: FormData, fields: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = form.get(f);
    out[f] = typeof v === "string" ? v : "";
  }
  return out;
}

/** The workspace access when the caller may manage lodging; otherwise the state to return. */
async function authorize(workspaceId: string) {
  if (!lodgingEnabled()) return { denied: fail("Lodging isn't turned on for this workspace.") };
  try {
    return { access: await requireCapability(workspaceId, "guests.manage") };
  } catch (e) {
    if (e instanceof ForbiddenError)
      return { denied: fail(friendlyLodgingError({ code: "42501" })) };
    throw e;
  }
}

const refresh = (workspaceId: string) => revalidatePath(`/app/${workspaceId}`, "layout");

function finish(
  workspaceId: string,
  result: { error: { code?: string } | null },
  message: string,
  values: Record<string, string> = {},
): EventActionState {
  if (result.error) return fail(friendlyLodgingError(result.error), {}, values);
  refresh(workspaceId);
  return { status: "ok", message };
}

const hotelJson = (v: HotelInput) => ({
  name: v.name,
  address: v.address,
  phone: v.phone,
  websiteUrl: v.websiteUrl,
  guestNote: v.guestNote,
  showToGuests: v.showToGuests,
  showRate: v.showRate,
  candidateId: v.candidateId,
});

const blockJson = (v: BlockInput) => ({
  label: v.label,
  checkIn: v.checkIn,
  checkOut: v.checkOut,
  roomsPerNight: v.roomsPerNight,
  nightlyRateMinor: v.nightlyRateMinor,
  attritionAllowedBp: v.attritionAllowedBp,
  attritionChargeMinor: v.attritionChargeMinor,
  cutoffDate: v.cutoffDate,
  bookingUrl: v.bookingUrl,
  bookingCode: v.bookingCode,
  budgetCategoryId: v.budgetCategoryId,
});

// ---------------------------------------------------------------- hotels
export async function saveLodgingHotel(
  _: EventActionState,
  form: FormData,
): Promise<EventActionState> {
  const values = read(form, HOTEL_FIELDS);
  const ids = z
    .object({ workspaceId: uuid, hotelId: uuid.optional(), version: version.optional() })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      hotelId: form.get("hotelId") || undefined,
      version: form.get("version") || undefined,
    });
  if (!ids.success) return reload;
  const auth = await authorize(ids.data.workspaceId);
  if (auth.denied) return auth.denied;
  const parsed = parseHotelInput(values);
  if (!parsed.ok) return fail(CHECK, parsed.fieldErrors, values);
  const supabase = await createUserClient();
  const { workspaceId, hotelId } = ids.data;
  if (hotelId) {
    if (ids.data.version === undefined) return reload;
    return finish(
      workspaceId,
      await supabase.rpc("update_lodging_hotel", {
        p_wedding: workspaceId,
        p_hotel_id: hotelId,
        p_expected_version: ids.data.version,
        p_hotel: hotelJson(parsed.value),
      }),
      `Saved ${parsed.value.name}.`,
      values,
    );
  }
  return finish(
    workspaceId,
    await supabase.rpc("add_lodging_hotel", {
      p_wedding: workspaceId,
      p_hotel: hotelJson(parsed.value),
    }),
    `Added ${parsed.value.name}.`,
    values,
  );
}

export async function setLodgingHotelArchived(
  _: EventActionState,
  form: FormData,
): Promise<EventActionState> {
  const ids = z
    .object({ workspaceId: uuid, hotelId: uuid, version, archived: z.enum(["yes", "no"]) })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      hotelId: form.get("hotelId"),
      version: form.get("version"),
      archived: form.get("archived"),
    });
  if (!ids.success) return reload;
  const auth = await authorize(ids.data.workspaceId);
  if (auth.denied) return auth.denied;
  const supabase = await createUserClient();
  const archived = ids.data.archived === "yes";
  return finish(
    ids.data.workspaceId,
    await supabase.rpc("set_lodging_hotel_archived", {
      p_wedding: ids.data.workspaceId,
      p_hotel_id: ids.data.hotelId,
      p_expected_version: ids.data.version,
      p_archived: archived,
    }),
    archived
      ? "Archived. Guests no longer see this hotel; answers that name it are kept."
      : "Restored.",
  );
}

// ---------------------------------------------------------------- blocks
export async function saveLodgingBlock(
  _: EventActionState,
  form: FormData,
): Promise<EventActionState> {
  const values = read(form, BLOCK_FIELDS);
  const ids = z
    .object({
      workspaceId: uuid,
      hotelId: uuid.optional(),
      blockId: uuid.optional(),
      version: version.optional(),
    })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      hotelId: form.get("hotelId") || undefined,
      blockId: form.get("blockId") || undefined,
      version: form.get("version") || undefined,
    });
  if (!ids.success || (!ids.data.hotelId && !ids.data.blockId)) return reload;
  const auth = await authorize(ids.data.workspaceId);
  if (auth.denied) return auth.denied;
  const settings = await loadWeddingSettings(ids.data.workspaceId);
  const parsed = parseBlockInput(values, settings.baseCurrency);
  if (!parsed.ok) return fail(CHECK, parsed.fieldErrors, values);
  const supabase = await createUserClient();
  const { workspaceId, blockId, hotelId } = ids.data;
  if (blockId) {
    if (ids.data.version === undefined) return reload;
    return finish(
      workspaceId,
      await supabase.rpc("update_lodging_block", {
        p_wedding: workspaceId,
        p_block_id: blockId,
        p_expected_version: ids.data.version,
        p_block: blockJson(parsed.value),
      }),
      "Saved the room block.",
      values,
    );
  }
  if (!hotelId) return reload;
  return finish(
    workspaceId,
    await supabase.rpc("add_lodging_block", {
      p_wedding: workspaceId,
      p_hotel_id: hotelId,
      p_block: blockJson(parsed.value),
    }),
    "Added the room block.",
    values,
  );
}

export async function removeLodgingBlock(
  _: EventActionState,
  form: FormData,
): Promise<EventActionState> {
  const ids = z.object({ workspaceId: uuid, blockId: uuid, version }).safeParse({
    workspaceId: form.get("workspaceId"),
    blockId: form.get("blockId"),
    version: form.get("version"),
  });
  if (!ids.success) return reload;
  const auth = await authorize(ids.data.workspaceId);
  if (auth.denied) return auth.denied;
  const supabase = await createUserClient();
  return finish(
    ids.data.workspaceId,
    await supabase.rpc("remove_lodging_block", {
      p_wedding: ids.data.workspaceId,
      p_block_id: ids.data.blockId,
      p_expected_version: ids.data.version,
    }),
    "Removed the room block.",
  );
}

export async function recordLodgingPickup(
  _: EventActionState,
  form: FormData,
): Promise<EventActionState> {
  const values = read(form, ["roomNights", "asOf"]);
  const ids = z
    .object({
      workspaceId: uuid,
      blockId: uuid,
      version,
      checkIn: z.iso.date(),
      checkOut: z.iso.date(),
      rooms: z.coerce.number().int().min(1).max(500),
    })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      blockId: form.get("blockId"),
      version: form.get("version"),
      checkIn: form.get("checkIn"),
      checkOut: form.get("checkOut"),
      rooms: form.get("rooms"),
    });
  if (!ids.success) return reload;
  const auth = await authorize(ids.data.workspaceId);
  if (auth.denied) return auth.denied;
  // The bound shown to the couple; the database checks against the stored block.
  const held = ids.data.rooms * blockNights(ids.data.checkIn, ids.data.checkOut);
  const parsed = parsePickupInput(values, held, todayInZone(auth.access.wedding.timezone));
  if (!parsed.ok) return fail(CHECK, parsed.fieldErrors, values);
  const supabase = await createUserClient();
  return finish(
    ids.data.workspaceId,
    await supabase.rpc("record_lodging_pickup", {
      p_wedding: ids.data.workspaceId,
      p_block_id: ids.data.blockId,
      p_expected_version: ids.data.version,
      ...(parsed.value && {
        p_room_nights: parsed.value.roomNights,
        p_as_of: parsed.value.asOf,
      }),
    }),
    parsed.value ? "Saved the hotel's pickup report." : "Cleared the pickup report.",
    values,
  );
}

// ---------------------------------------------------------------- who stays where
export async function setLodgingStays(
  _: EventActionState,
  form: FormData,
): Promise<EventActionState> {
  const ids = z.object({ workspaceId: uuid }).safeParse({ workspaceId: form.get("workspaceId") });
  if (!ids.success) return reload;
  const guests = form
    .getAll("guestId")
    .filter((v): v is string => typeof v === "string" && uuid.safeParse(v).success);
  const choice = form.get("stay");
  if (guests.length === 0) return fail("Choose at least one guest.");
  if (guests.length > 20) return fail("Choose up to 20 guests at a time.");
  // "clear", "elsewhere", "not_staying" or "hotel:<id>".
  let kind: string | null = null;
  let hotelId: string | null = null;
  if (typeof choice !== "string" || choice === "") return fail("Choose where they are staying.");
  if (choice.startsWith("hotel:")) {
    const id = choice.slice("hotel:".length);
    if (!uuid.safeParse(id).success) return reload;
    kind = "hotel";
    hotelId = id;
  } else if (choice !== "clear") {
    if (!isStayKind(choice) || choice === "hotel") return reload;
    kind = choice;
  }
  const auth = await authorize(ids.data.workspaceId);
  if (auth.denied) return auth.denied;
  const supabase = await createUserClient();
  const n = guests.length;
  return finish(
    ids.data.workspaceId,
    await supabase.rpc("set_lodging_stays", {
      p_wedding: ids.data.workspaceId,
      p_guests: guests,
      ...(kind !== null && { p_kind: kind }),
      ...(hotelId !== null && { p_hotel_id: hotelId }),
    }),
    kind === null
      ? `Cleared your choice for ${n} ${n === 1 ? "guest" : "guests"}. Their own answers are kept.`
      : `Saved for ${n} ${n === 1 ? "guest" : "guests"}.`,
  );
}
