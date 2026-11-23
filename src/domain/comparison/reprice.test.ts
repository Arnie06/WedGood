import { describe, expect, it } from "vitest";
import { followsEvent, repriceSuggestion, usableCount } from "./reprice";

describe("repriceSuggestion", () => {
  it("offers nothing when the live number matches or is unknown", () => {
    expect(repriceSuggestion(100, 100)).toBeNull();
    expect(repriceSuggestion(100, null)).toBeNull();
    expect(repriceSuggestion(100, undefined)).toBeNull();
  });
  it("stays quiet below 5% and speaks at exactly 5%", () => {
    expect(repriceSuggestion(100, 104)).toBeNull();
    expect(repriceSuggestion(100, 96)).toBeNull();
    expect(repriceSuggestion(100, 105)).toBe(105);
    expect(repriceSuggestion(100, 95)).toBe(95);
  });
  it("uses the saved number as the base, so small parties notice a single guest", () => {
    expect(repriceSuggestion(10, 11)).toBe(11);
    expect(repriceSuggestion(20, 21)).toBe(21);
    expect(repriceSuggestion(21, 22)).toBeNull();
  });
  it("never suggests a count that cannot be priced", () => {
    expect(repriceSuggestion(100, 0)).toBeNull();
    expect(repriceSuggestion(100, -3)).toBeNull();
    expect(repriceSuggestion(100, 1.5)).toBeNull();
    expect(repriceSuggestion(100, Number.NaN)).toBeNull();
  });
  it("treats a saved count that is not a valid count as nothing to compare", () => {
    expect(repriceSuggestion(0, 10)).toBeNull();
  });
});

describe("usableCount and followsEvent", () => {
  it("rejects zero and unknown planning numbers", () => {
    expect(usableCount(null)).toBe(false);
    expect(usableCount(0)).toBe(false);
    expect(usableCount(1)).toBe(true);
  });
  it("follows the event only while the saved number is the planning number", () => {
    expect(followsEvent(110, 110)).toBe(true);
    expect(followsEvent(120, 110)).toBe(false);
    expect(followsEvent(110, null)).toBe(false);
    expect(followsEvent(110, 0)).toBe(false);
  });
});
