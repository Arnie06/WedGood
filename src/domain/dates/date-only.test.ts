import { describe, expect, it } from "vitest";
import { daysBetween, formatDateOnly, isDateOnly, parseDateOnly } from "./date-only";

describe("date-only values", () => {
  it("accepts real calendar dates only", () => {
    expect(isDateOnly("2027-05-22")).toBe(true);
    expect(isDateOnly("2028-02-29")).toBe(true);
    expect(isDateOnly("2027-02-29")).toBe(false);
    expect(isDateOnly("2027-13-01")).toBe(false);
    expect(isDateOnly("2027-5-22")).toBe(false);
    expect(isDateOnly("2027-05-22T00:00:00Z")).toBe(false);
    expect(() => parseDateOnly("")).toThrow(RangeError);
  });

  it("counts the demo reference countdown as 184 days", () => {
    expect(daysBetween(parseDateOnly("2026-11-19"), parseDateOnly("2027-05-22"))).toBe(184);
  });

  it("is unaffected by DST transitions and handles past dates", () => {
    expect(daysBetween(parseDateOnly("2027-03-13"), parseDateOnly("2027-03-15"))).toBe(2);
    expect(daysBetween(parseDateOnly("2027-05-22"), parseDateOnly("2027-05-20"))).toBe(-2);
  });

  it("formats without shifting the calendar day", () => {
    expect(formatDateOnly(parseDateOnly("2027-05-22"))).toBe("May 22, 2027");
    expect(formatDateOnly(parseDateOnly("2027-05-22"), "en-US", { weekday: "long" })).toBe(
      "Saturday",
    );
  });
});
