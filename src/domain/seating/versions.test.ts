import { describe, expect, it } from "vitest";
import { parseFrozenPlan } from "./versions";

describe("parseFrozenPlan", () => {
  it("reads a current copy", () => {
    const plan = parseFrozenPlan({
      revision: 7,
      accepted: 3,
      confirmedSeated: 2,
      tentativeSeated: 1,
      tables: [
        {
          label: "A",
          capacity: 8,
          shape: "rectangle",
          notes: "Near the stage",
          guests: [{ name: "Ada", tentative: false, seat: 2, captain: true, meal: "Fish" }],
        },
      ],
    });
    expect(plan).toEqual({
      revision: 7,
      accepted: 3,
      confirmedSeated: 2,
      tentativeSeated: 1,
      tables: [
        {
          label: "A",
          capacity: 8,
          shape: "rectangle",
          notes: "Near the stage",
          guests: [{ name: "Ada", tentative: false, seat: 2, captain: true, meal: "Fish" }],
        },
      ],
    });
  });

  it("fills in what an older copy never stored", () => {
    const plan = parseFrozenPlan({
      revision: 1,
      accepted: 1,
      confirmedSeated: 1,
      tentativeSeated: 0,
      tables: [
        {
          label: "A",
          capacity: 2,
          guests: [{ name: "Ada", tentative: false, seat: null, meal: null }],
        },
      ],
    });
    expect(plan?.tables[0]).toMatchObject({ shape: "round", notes: null });
    expect(plan?.tables[0]?.guests[0]).toMatchObject({ captain: false, seat: null, meal: null });
  });

  it("returns null for something that is not a copy and ignores malformed rows", () => {
    expect(parseFrozenPlan(null)).toBeNull();
    expect(parseFrozenPlan([])).toBeNull();
    expect(parseFrozenPlan("x")).toBeNull();
    const plan = parseFrozenPlan({
      tables: [5, null, { label: "B", capacity: "x", guests: "no" }],
    });
    expect(plan?.tables).toEqual([
      { label: "B", capacity: 0, shape: "round", notes: null, guests: [] },
    ]);
  });
});
