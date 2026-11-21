import { describe, expect, it } from "vitest";
import {
  parseCategoryInput,
  parseItemInput,
  parseReservePercent,
  reservePercentText,
} from "./input";

describe("parseCategoryInput", () => {
  it("accepts a name with no allocation as unset, and zero as zero", () => {
    expect(parseCategoryInput({ name: " Flowers ", allocation: "" }, "USD")).toEqual({
      ok: true,
      value: { name: "Flowers", allocationMinor: null },
    });
    expect(parseCategoryInput({ name: "A", allocation: "0" }, "USD")).toEqual({
      ok: true,
      value: { name: "A", allocationMinor: 0 },
    });
  });
  it("rejects blank names and bad amounts", () => {
    const r = parseCategoryInput({ name: " ", allocation: "abc" }, "USD");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["allocation", "name"]);
  });
});

describe("parseItemInput", () => {
  it("parses a per-guest item with a minimum and drops irrelevant fields", () => {
    const r = parseItemInput(
      {
        name: "Catering",
        category: "c1",
        costMode: "per_guest",
        amount: "95",
        minQty: "120",
        quantity: "9",
      },
      "USD",
    );
    expect(r).toMatchObject({
      ok: true,
      value: { amountMinor: 9500, minQty: 120, quantity: null, costMode: "per_guest" },
    });
  });
  it("keeps a blank amount unknown, never zero", () => {
    const r = parseItemInput({ name: "DJ", category: "c1", amount: "" }, "USD");
    expect(r).toMatchObject({ ok: true, value: { amountMinor: null, costMode: "fixed" } });
  });
  it("rejects over-limit amounts, bad modes, zero quantity and missing category", () => {
    const r = parseItemInput(
      { name: "x", category: "", costMode: "weird", amount: "2000000", quantity: "0" },
      "USD",
    );
    expect(r.ok).toBe(false);
    const q = parseItemInput(
      { name: "x", category: "c", costMode: "quantity", quantity: "0" },
      "USD",
    );
    expect(q.ok).toBe(false);
  });
});

describe("reserve percent", () => {
  it("round-trips whole and fractional percents", () => {
    expect(parseReservePercent("10")).toBe(1000);
    expect(parseReservePercent("7.5%")).toBe(750);
    expect(parseReservePercent("0")).toBe(0);
    expect(parseReservePercent("")).toBeNull();
    expect(parseReservePercent("100")).toBe(10_000);
    expect(parseReservePercent("101")).toBeUndefined();
    expect(parseReservePercent("-1")).toBeUndefined();
    expect(parseReservePercent("1.234")).toBeUndefined();
    expect(reservePercentText(750)).toBe("7.5");
    expect(reservePercentText(1000)).toBe("10");
    expect(reservePercentText(null)).toBe("");
  });
});
