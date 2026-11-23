import { describe, expect, it } from "vitest";
import {
  blockExposure,
  blockNights,
  requiredRoomNights,
  totalExposure,
  type BlockTerms,
} from "./attrition";

const base: BlockTerms = {
  checkIn: "2027-06-11",
  checkOut: "2027-06-13",
  roomsPerNight: 20,
  nightlyRateMinor: 18_900,
  attritionAllowedBp: 2_000,
  attritionChargeMinor: null,
  pickedUpRoomNights: 25,
  pickedUpAsOf: "2027-05-01",
};

describe("blockNights", () => {
  it("counts nights between date-only days, across a month end", () => {
    expect(blockNights("2027-06-11", "2027-06-13")).toBe(2);
    expect(blockNights("2027-01-31", "2027-02-02")).toBe(2);
  });
});

describe("requiredRoomNights", () => {
  it("rounds up to a whole room-night", () => {
    expect(requiredRoomNights(40, 2_000)).toBe(32);
    expect(requiredRoomNights(10, 1_250)).toBe(9); // 8.75 -> 9
    expect(requiredRoomNights(10, 1_000)).toBe(9); // exact
  });
  it("handles 0% and 100% allowances", () => {
    expect(requiredRoomNights(40, 0)).toBe(40);
    expect(requiredRoomNights(40, 10_000)).toBe(0);
  });
});

describe("blockExposure", () => {
  it("charges the nightly rate per room-night short of the requirement", () => {
    const e = blockExposure(base);
    expect(e).toMatchObject({
      nights: 2,
      roomNightsHeld: 40,
      roomNightsRequired: 32,
      shortfall: 7,
      expectedMinor: 7 * 18_900,
      worstMinor: 32 * 18_900,
      missing: [],
    });
  });

  it("uses the separate attrition charge when given", () => {
    expect(blockExposure({ ...base, attritionChargeMinor: 10_000 }).expectedMinor).toBe(70_000);
  });

  it("owes nothing once pickup meets the requirement", () => {
    expect(blockExposure({ ...base, pickedUpRoomNights: 40 })).toMatchObject({
      shortfall: 0,
      expectedMinor: 0,
    });
  });

  it("keeps unknown inputs unknown instead of zero", () => {
    expect(blockExposure({ ...base, pickedUpRoomNights: null, pickedUpAsOf: null })).toMatchObject({
      expectedMinor: null,
      worstMinor: 32 * 18_900,
      missing: ["pickup"],
    });
    expect(blockExposure({ ...base, attritionAllowedBp: null })).toMatchObject({
      roomNightsRequired: null,
      expectedMinor: null,
      worstMinor: null,
      missing: ["attrition"],
    });
    expect(blockExposure({ ...base, nightlyRateMinor: null })).toMatchObject({
      expectedMinor: null,
      worstMinor: null,
      missing: ["rate"],
    });
  });

  it("stays a safe integer at the largest allowed block", () => {
    const e = blockExposure({
      ...base,
      checkIn: "2027-06-01",
      checkOut: "2027-07-01",
      roomsPerNight: 500,
      nightlyRateMinor: 10_000_000,
      attritionAllowedBp: 0,
      pickedUpRoomNights: 0,
    });
    expect(e.worstMinor).toBe(15_000 * 10_000_000);
    expect(Number.isSafeInteger(e.worstMinor)).toBe(true);
  });
});

describe("totalExposure", () => {
  it("sums known figures and flags anything unknown", () => {
    const rows = [blockExposure(base), blockExposure({ ...base, nightlyRateMinor: null })];
    expect(totalExposure(rows, "expectedMinor")).toEqual({
      totalMinor: 7 * 18_900,
      complete: false,
    });
    expect(totalExposure([blockExposure(base)], "worstMinor")).toEqual({
      totalMinor: 32 * 18_900,
      complete: true,
    });
  });
});
