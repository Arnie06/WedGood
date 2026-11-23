import { describe, expect, it } from "vitest";
import {
  agendaByVendor,
  canLinkVendor,
  diffLinks,
  groupForEvent,
  vendorLabel,
  vendorState,
} from "./vendors";

const v = (stage = "saved", archived = false, name = "Lens Co") => ({ name, stage, archived });

describe("vendorState and vendorLabel", () => {
  it("treats shortlisted and booked vendors as current", () => {
    for (const stage of ["saved", "contacted", "proposal_received", "considering", "booked"]) {
      expect(vendorState(v(stage))).toBe("current");
      expect(vendorLabel(v(stage))).toBe("Lens Co");
    }
  });
  it("flags passed vendors in words", () => {
    expect(vendorState(v("declined"))).toBe("passed");
    expect(vendorState(v("cancelled"))).toBe("passed");
    expect(vendorLabel(v("declined"))).toBe("Lens Co (passed)");
  });
  it("says archived before passed", () => {
    expect(vendorState(v("declined", true))).toBe("archived");
    expect(vendorLabel(v("booked", true))).toBe("Lens Co (archived)");
  });
  it("only current vendors can be newly linked", () => {
    expect(canLinkVendor(v("booked"))).toBe(true);
    expect(canLinkVendor(v("cancelled"))).toBe(false);
    expect(canLinkVendor(v("saved", true))).toBe(false);
  });
});

describe("diffLinks", () => {
  it("returns only what changed", () => {
    expect(diffLinks(["a", "b"], ["b", "c"])).toEqual({ add: ["c"], remove: ["a"] });
  });
  it("is empty when nothing changed, whatever the order", () => {
    expect(diffLinks(["a", "b"], ["b", "a"])).toEqual({ add: [], remove: [] });
    expect(diffLinks([], [])).toEqual({ add: [], remove: [] });
  });
  it("ignores duplicates in the choice", () => {
    expect(diffLinks([], ["x", "x"])).toEqual({ add: ["x"], remove: [] });
  });
  it("can clear everything", () => {
    expect(diffLinks(["a", "b"], [])).toEqual({ add: [], remove: ["a", "b"] });
  });
});

describe("groupForEvent", () => {
  const all = [{ id: "1" }, { id: "2" }, { id: "3" }];
  it("puts this event's vendors first and keeps order inside each group", () => {
    const g = groupForEvent(all, new Set(["3", "1"]));
    expect(g.atEvent.map((x) => x.id)).toEqual(["1", "3"]);
    expect(g.others.map((x) => x.id)).toEqual(["2"]);
  });
  it("puts everyone in the other group when none are linked", () => {
    const g = groupForEvent(all, new Set());
    expect(g.atEvent).toEqual([]);
    expect(g.others).toHaveLength(3);
  });
});

describe("agendaByVendor", () => {
  it("groups by vendor, skipping items without one", () => {
    const items = [
      { id: "i1", vendorId: "a" },
      { id: "i2", vendorId: null },
      { id: "i3", vendorId: "a" },
      { id: "i4", vendorId: "b" },
    ];
    const m = agendaByVendor(items);
    expect(m.get("a")?.map((i) => i.id)).toEqual(["i1", "i3"]);
    expect(m.get("b")?.map((i) => i.id)).toEqual(["i4"]);
    expect(m.size).toBe(2);
  });
});
