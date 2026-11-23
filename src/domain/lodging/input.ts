import { isIsoDate, parseHttpsUrl } from "@/domain/website/site";
import { parseMajorToMinor } from "@/domain/wedding/settings";
import { blockNights } from "./attrition";

/**
 * Form parsing for hotels, room blocks and pickup reports. Shapes what the couple typed into the
 * JSON the database RPCs accept; the database re-checks every limit.
 */
export const LODGING_LIMITS = {
  hotelName: 120,
  address: 300,
  phone: 40,
  guestNote: 500,
  blockLabel: 60,
  bookingCode: 60,
  roomsPerNight: 500,
  nights: 30,
  rateMinor: 10_000_000,
  hotels: 30,
  blocksPerHotel: 10,
} as const;

type Raw = Record<string, string | undefined>;
type Parse<T, F extends string> =
  { ok: true; value: T } | { ok: false; fieldErrors: Partial<Record<F, string>> };

const text = (raw: Raw, k: string) => (raw[k] ?? "").replace(/\r\n?/g, "\n").trim();
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function optionalText(
  raw: Raw,
  k: string,
  max: number,
  errors: Record<string, string>,
): string | null {
  const v = text(raw, k);
  if (v === "") return null;
  if (v.length > max) errors[k] = `Use ${max} characters or fewer.`;
  else if (CONTROL.test(v)) errors[k] = "Remove unusual characters.";
  return v;
}

function optionalUrl(raw: Raw, k: string, errors: Record<string, string>): string | null {
  const v = text(raw, k);
  if (v === "") return null;
  const parsed = parseHttpsUrl(v);
  if (!parsed.ok) {
    errors[k] = parsed.error;
    return null;
  }
  return parsed.url;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------- hotels
export type HotelField =
  | "name"
  | "address"
  | "phone"
  | "websiteUrl"
  | "guestNote"
  | "showToGuests"
  | "showRate"
  | "candidateId";

export type HotelInput = {
  name: string;
  address: string | null;
  phone: string | null;
  websiteUrl: string | null;
  guestNote: string | null;
  showToGuests: boolean;
  showRate: boolean;
  candidateId: string | null;
};

export function parseHotelInput(raw: Raw): Parse<HotelInput, HotelField> {
  const errors: Record<string, string> = {};
  const name = text(raw, "name").replace(/\s+/g, " ");
  if (name === "") errors.name = "Enter the hotel's name.";
  else if (name.length > LODGING_LIMITS.hotelName)
    errors.name = `Use ${LODGING_LIMITS.hotelName} characters or fewer.`;
  const address = optionalText(raw, "address", LODGING_LIMITS.address, errors);
  const phone = optionalText(raw, "phone", LODGING_LIMITS.phone, errors);
  const websiteUrl = optionalUrl(raw, "websiteUrl", errors);
  const guestNote = optionalText(raw, "guestNote", LODGING_LIMITS.guestNote, errors);
  const candidate = text(raw, "candidateId");
  if (candidate !== "" && !UUID.test(candidate))
    errors.candidateId = "Choose a vendor from the list.";
  if (Object.keys(errors).length > 0) return { ok: false, fieldErrors: errors };
  return {
    ok: true,
    value: {
      name,
      address,
      phone,
      websiteUrl,
      guestNote,
      showToGuests: raw.showToGuests === "on",
      showRate: raw.showRate === "on",
      candidateId: candidate === "" ? null : candidate,
    },
  };
}

// ---------------------------------------------------------------- blocks
export type BlockField =
  | "label"
  | "checkIn"
  | "checkOut"
  | "roomsPerNight"
  | "nightlyRate"
  | "attritionPercent"
  | "attritionCharge"
  | "cutoffDate"
  | "bookingUrl"
  | "bookingCode"
  | "budgetCategoryId";

export type BlockInput = {
  label: string | null;
  checkIn: string;
  checkOut: string;
  roomsPerNight: number;
  nightlyRateMinor: number | null;
  attritionAllowedBp: number | null;
  attritionChargeMinor: number | null;
  cutoffDate: string | null;
  bookingUrl: string | null;
  bookingCode: string | null;
  budgetCategoryId: string | null;
};

/** "20", "12.5" or "12.25" percent to basis points; null for blank, undefined when invalid. */
export function parsePercentToBp(input: string): number | null | undefined {
  const v = input.trim().replace(/%$/, "").trim();
  if (v === "") return null;
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(v);
  if (!m) return undefined;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return bp <= 10_000 ? bp : undefined;
}

function optionalMoney(
  raw: Raw,
  k: string,
  currency: string,
  errors: Record<string, string>,
): number | null {
  const v = parseMajorToMinor(text(raw, k), currency);
  if (v === undefined || (v !== null && (v < 1 || v > LODGING_LIMITS.rateMinor))) {
    errors[k] = "Enter an amount, like 189 or 189.50.";
    return null;
  }
  return v;
}

export function parseBlockInput(raw: Raw, currency: string): Parse<BlockInput, BlockField> {
  const errors: Record<string, string> = {};
  const label = optionalText(raw, "label", LODGING_LIMITS.blockLabel, errors);
  const checkIn = text(raw, "checkIn");
  const checkOut = text(raw, "checkOut");
  if (!isIsoDate(checkIn)) errors.checkIn = "Choose the first night.";
  if (!isIsoDate(checkOut)) errors.checkOut = "Choose the check-out day.";
  if (!errors.checkIn && !errors.checkOut) {
    const nights = blockNights(checkIn, checkOut);
    if (nights < 1) errors.checkOut = "Check-out must be after check-in.";
    else if (nights > LODGING_LIMITS.nights)
      errors.checkOut = `A block can cover up to ${LODGING_LIMITS.nights} nights.`;
  }
  const roomsText = text(raw, "roomsPerNight");
  const rooms = /^\d{1,3}$/.test(roomsText) ? Number(roomsText) : NaN;
  if (!(rooms >= 1 && rooms <= LODGING_LIMITS.roomsPerNight))
    errors.roomsPerNight = `Enter how many rooms are held each night (1 to ${LODGING_LIMITS.roomsPerNight}).`;
  const nightlyRateMinor = optionalMoney(raw, "nightlyRate", currency, errors);
  const bp = parsePercentToBp(text(raw, "attritionPercent"));
  if (bp === undefined) errors.attritionPercent = "Enter a percentage from 0 to 100, like 20.";
  const attritionChargeMinor = optionalMoney(raw, "attritionCharge", currency, errors);
  const cutoff = text(raw, "cutoffDate");
  if (cutoff !== "" && !isIsoDate(cutoff)) errors.cutoffDate = "Choose a date.";
  const bookingUrl = optionalUrl(raw, "bookingUrl", errors);
  const bookingCode = optionalText(raw, "bookingCode", LODGING_LIMITS.bookingCode, errors);
  const category = text(raw, "budgetCategoryId");
  if (category !== "" && !UUID.test(category))
    errors.budgetCategoryId = "Choose a category from the list.";
  if (Object.keys(errors).length > 0) return { ok: false, fieldErrors: errors };
  return {
    ok: true,
    value: {
      label,
      checkIn,
      checkOut,
      roomsPerNight: rooms,
      nightlyRateMinor,
      attritionAllowedBp: bp ?? null,
      attritionChargeMinor,
      cutoffDate: cutoff === "" ? null : cutoff,
      bookingUrl,
      bookingCode,
      budgetCategoryId: category === "" ? null : category,
    },
  };
}

// ---------------------------------------------------------------- pickup report
export type PickupField = "roomNights" | "asOf";

/** Both blank clears the report. */
export function parsePickupInput(
  raw: Raw,
  roomNightsHeld: number,
  today: string,
): Parse<{ roomNights: number; asOf: string } | null, PickupField> {
  const errors: Record<string, string> = {};
  const n = text(raw, "roomNights");
  const asOf = text(raw, "asOf");
  if (n === "" && asOf === "") return { ok: true, value: null };
  const nights = /^\d{1,5}$/.test(n) ? Number(n) : NaN;
  if (!(nights >= 0)) errors.roomNights = "Enter the number of room-nights booked, like 26.";
  else if (nights > roomNightsHeld)
    errors.roomNights = `That's more than the ${roomNightsHeld} room-nights held.`;
  if (!isIsoDate(asOf)) errors.asOf = "Choose the day of the hotel's report.";
  else if (asOf > today) errors.asOf = "The report day can't be in the future.";
  if (Object.keys(errors).length > 0) return { ok: false, fieldErrors: errors };
  return { ok: true, value: { roomNights: nights, asOf } };
}
