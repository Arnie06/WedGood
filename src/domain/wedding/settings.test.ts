import { describe, expect, it } from "vitest";
import {
  changedSettingKeys,
  minorToMajorInput,
  parseMajorToMinor,
  parseSettingsInput,
} from "./settings";

const base = { name: "Alex & Morgan", timezone: "America/Los_Angeles", baseCurrency: "USD" };

describe("parseSettingsInput", () => {
  it("accepts a minimal workspace with every optional value unknown (null, not zero)", () => {
    const r = parseSettingsInput(base);
    expect(r).toEqual({
      ok: true,
      value: {
        ...base,
        date: null,
        targetBudgetMinor: null,
        targetGuestCount: null,
        location: null,
      },
    });
  });

  it("parses date, budget, guests and location", () => {
    const r = parseSettingsInput({
      ...base,
      date: "2027-05-22",
      targetBudget: "40,000",
      targetGuestCount: "120",
      location: "  Napa   Valley ",
    });
    expect(r.ok && r.value).toMatchObject({
      date: "2027-05-22",
      targetBudgetMinor: 4_000_000,
      targetGuestCount: 120,
      location: "Napa Valley",
    });
  });

  it("keeps an explicit zero target distinct from unknown", () => {
    const r = parseSettingsInput({ ...base, targetBudget: "0", targetGuestCount: "0" });
    expect(r.ok && r.value).toMatchObject({ targetBudgetMinor: 0, targetGuestCount: 0 });
  });

  it("rejects bad input with field errors", () => {
    const r = parseSettingsInput({
      name: "  ",
      date: "2027-02-30",
      timezone: "Mars/Olympus",
      baseCurrency: "XXX",
      targetGuestCount: "-3",
      location: "x".repeat(201),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(Object.keys(r.errors).sort()).toEqual(
        ["baseCurrency", "date", "location", "name", "targetGuestCount", "timezone"].sort(),
      );
    }
  });

  it("rejects over-precise or malformed budgets", () => {
    for (const bad of ["12.345", "abc", "-5", "1e6", "1,23"]) {
      const r = parseSettingsInput({ ...base, targetBudget: bad });
      expect(r.ok, bad).toBe(false);
    }
  });
});

describe("parseMajorToMinor", () => {
  it("is exact for decimal amounts", () => {
    expect(parseMajorToMinor("0.10", "USD")).toBe(10);
    expect(parseMajorToMinor("19.99", "USD")).toBe(1999);
    expect(parseMajorToMinor("$1 250.5", "USD")).toBe(125_050);
  });
  it("honours zero-decimal currencies", () => {
    expect(parseMajorToMinor("500000", "JPY")).toBe(500_000);
    expect(parseMajorToMinor("500000.5", "JPY")).toBeUndefined();
  });
  it("treats blank as unknown", () => {
    expect(parseMajorToMinor("  ", "USD")).toBeNull();
  });
  it("rejects absurd amounts", () => {
    expect(parseMajorToMinor("999999999999", "USD")).toBeUndefined();
  });
});

describe("minorToMajorInput", () => {
  it("round-trips", () => {
    for (const [minor, cur] of [
      [4_000_000, "USD"],
      [1999, "USD"],
      [5, "USD"],
      [500_000, "JPY"],
    ] as const) {
      expect(parseMajorToMinor(minorToMajorInput(minor, cur), cur)).toBe(minor);
    }
    expect(minorToMajorInput(null, "USD")).toBe("");
  });
});

describe("changedSettingKeys", () => {
  it("lists only differing keys", () => {
    const a = parseSettingsInput(base);
    const b = parseSettingsInput({ ...base, date: "2027-05-22" });
    if (!a.ok || !b.ok) throw new Error("setup");
    expect(changedSettingKeys(a.value, b.value)).toEqual(["date"]);
  });
});
