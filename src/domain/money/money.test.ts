import { describe, expect, it } from "vitest";
import { formatMinor } from "./money";

describe("formatMinor", () => {
  it("formats USD minor units exactly", () => {
    expect(formatMinor(1_000_000, "USD")).toBe("$10,000.00");
    expect(formatMinor(5, "USD")).toBe("$0.05");
    expect(formatMinor(0, "USD")).toBe("$0.00");
    expect(formatMinor(-250_050, "USD")).toBe("-$2,500.50");
  });

  it("respects zero-decimal currencies", () => {
    expect(formatMinor(12_000, "JPY")).toBe("¥12,000");
  });

  it("stays exact at the largest safe integer", () => {
    expect(formatMinor(Number.MAX_SAFE_INTEGER, "USD")).toBe("$90,071,992,547,409.91");
  });

  it("rejects fractional or unsafe amounts", () => {
    expect(() => formatMinor(10.5, "USD")).toThrow(RangeError);
    expect(() => formatMinor(Number.MAX_SAFE_INTEGER + 1, "USD")).toThrow(RangeError);
    expect(() => formatMinor(Number.NaN, "USD")).toThrow(RangeError);
  });
});
