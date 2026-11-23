import { describe, expect, it } from "vitest";
import {
  newItemDefaults,
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

describe("parseItemInput count source (REL-03)", () => {
  const base = { name: "Dinner", category: "c1", costMode: "per_guest", amount: "95" };
  const ok = (raw: Record<string, string>) => {
    const r = parseItemInput({ ...base, ...raw }, "USD");
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    return r.value;
  };

  it("defaults to the guest target and keeps the other count fields empty", () => {
    expect(ok({})).toMatchObject({
      countSource: "guest_target",
      countEventId: null,
      countTyped: null,
    });
  });

  it("an event source needs an event", () => {
    const r = parseItemInput({ ...base, countSource: "event_plan", countEvent: "" }, "USD");
    expect(r).toMatchObject({ ok: false, errors: { countEvent: expect.any(String) } });
    expect(ok({ countSource: "event_yes", countEvent: "e1" })).toMatchObject({
      countSource: "event_yes",
      countEventId: "e1",
      countTyped: null,
    });
  });

  it("a typed source takes a whole number, or blank for not known yet", () => {
    expect(ok({ countSource: "typed", countTyped: "80" })).toMatchObject({ countTyped: 80 });
    expect(ok({ countSource: "typed", countTyped: "" })).toMatchObject({ countTyped: null });
    for (const bad of ["0", "-3", "1.5", "lots"]) {
      expect(
        parseItemInput({ ...base, countSource: "typed", countTyped: bad }, "USD"),
      ).toMatchObject({
        ok: false,
        errors: { countTyped: expect.any(String) },
      });
    }
  });

  it("drops stale count fields when the item is not per guest", () => {
    expect(
      ok({ costMode: "fixed", countSource: "event_plan", countEvent: "e1", countTyped: "9" }),
    ).toMatchObject({ countSource: "guest_target", countEventId: null, countTyped: null });
  });

  it("an unknown source is an error", () => {
    expect(parseItemInput({ ...base, countSource: "magic" }, "USD")).toMatchObject({
      ok: false,
      errors: { countSource: expect.any(String) },
    });
  });
});

describe("newItemDefaults (ADR-031 D1)", () => {
  it("starts on the reception's planning number, else the first event", () => {
    expect(
      newItemDefaults([
        { id: "c", kind: "ceremony" },
        { id: "r", kind: "reception" },
      ]),
    ).toMatchObject({ countSource: "event_plan", countEvent: "r" });
    expect(newItemDefaults([{ id: "c", kind: "ceremony" }])).toMatchObject({
      countSource: "event_plan",
      countEvent: "c",
    });
  });
  it("uses the guest target when there is no event to follow", () => {
    expect(newItemDefaults([])).toMatchObject({ countSource: "guest_target", countEvent: "" });
  });
});
