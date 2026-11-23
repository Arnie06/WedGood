import { daysBetween, parseDateOnly } from "@/domain/dates/date-only";

/**
 * Room-block attrition (UX-17 lodging). A hotel holds rooms for the wedding and allows a share of
 * the held room-nights to go unbooked; below that the couple may owe a charge per unbooked
 * room-night. The figures here are a possible cost shown BESIDE the forecast, never in it
 * (owner decision 2026-11-23). Integer arithmetic only. Anything unknown stays null, never 0.
 */
export type BlockTerms = {
  checkIn: string;
  checkOut: string;
  roomsPerNight: number;
  nightlyRateMinor: number | null;
  /** Share of held room-nights that may go unbooked without charge, in basis points (0..10000). */
  attritionAllowedBp: number | null;
  /** Charge per unbooked room-night; null means the nightly rate. */
  attritionChargeMinor: number | null;
  /** The hotel's latest pickup report, or null when none was recorded. */
  pickedUpRoomNights: number | null;
  pickedUpAsOf: string | null;
};

export type MissingTerm = "rate" | "attrition" | "pickup";

export type Exposure = {
  nights: number;
  roomNightsHeld: number;
  /** Room-nights that must be booked to owe nothing; null when the allowance is unknown. */
  roomNightsRequired: number | null;
  /** Room-nights short of the requirement at the last report; null when unknown. */
  shortfall: number | null;
  /** Charge if the block closed at the last pickup report; null when any input is unknown. */
  expectedMinor: number | null;
  /** Charge if nothing at all were booked; null when the allowance or the charge is unknown. */
  worstMinor: number | null;
  missing: MissingTerm[];
};

/** Nights between check-in and check-out (date-only, no time zone involved). */
export function blockNights(checkIn: string, checkOut: string): number {
  return daysBetween(parseDateOnly(checkIn), parseDateOnly(checkOut));
}

/** ceil(held × (10000 − bp) / 10000) without floating point. */
export function requiredRoomNights(held: number, allowedBp: number): number {
  const kept = held * (10_000 - allowedBp);
  return Math.floor((kept + 9_999) / 10_000);
}

export function blockExposure(terms: BlockTerms): Exposure {
  const nights = blockNights(terms.checkIn, terms.checkOut);
  const held = terms.roomsPerNight * nights;
  const charge = terms.attritionChargeMinor ?? terms.nightlyRateMinor;
  const missing: MissingTerm[] = [];
  if (charge === null) missing.push("rate");
  if (terms.attritionAllowedBp === null) missing.push("attrition");
  if (terms.pickedUpRoomNights === null) missing.push("pickup");

  const required =
    terms.attritionAllowedBp === null ? null : requiredRoomNights(held, terms.attritionAllowedBp);
  const shortfall =
    required === null || terms.pickedUpRoomNights === null
      ? null
      : Math.max(required - terms.pickedUpRoomNights, 0);
  return {
    nights,
    roomNightsHeld: held,
    roomNightsRequired: required,
    shortfall,
    expectedMinor: shortfall === null || charge === null ? null : shortfall * charge,
    worstMinor: required === null || charge === null ? null : required * charge,
    missing,
  };
}

/** Sums known figures; `complete` is false when any block's figure is unknown. */
export function totalExposure(rows: readonly Exposure[], pick: "expectedMinor" | "worstMinor") {
  let total = 0;
  let complete = true;
  for (const r of rows) {
    const v = r[pick];
    if (v === null) complete = false;
    else total += v;
  }
  return { totalMinor: total, complete };
}
