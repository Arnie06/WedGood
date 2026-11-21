import { describe, expect, it } from "vitest";
import { validateEvent } from "./event";

describe("validateEvent", () => {
  it("keeps blank optional numbers unknown, never zero", () => {
    const r = validateEvent({
      name: " Reception ",
      kind: "reception",
      localDate: "",
      capacity: "",
    });
    expect(r).toEqual({
      ok: true,
      event: {
        name: "Reception",
        kind: "reception",
        localDate: null,
        targetAttendance: null,
        capacity: null,
      },
    });
  });
  it("accepts an explicit zero target but not zero capacity", () => {
    const r = validateEvent({ name: "A", targetAttendance: "0", capacity: "0" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors)).toEqual(["capacity"]);
    const ok = validateEvent({ name: "A", targetAttendance: "0" });
    expect(ok.ok && ok.event.targetAttendance).toBe(0);
  });
  it.each([
    [{ name: "" }, "name"],
    [{ name: "x".repeat(121) }, "name"],
    [{ name: "A", kind: "party" }, "kind"],
    [{ name: "A", localDate: "2027-02-30" }, "localDate"],
    [{ name: "A", targetAttendance: "12.5" }, "targetAttendance"],
    [{ name: "A", capacity: "5001" }, "capacity"],
    [{ name: "A", capacity: "-3" }, "capacity"],
  ])("rejects %j", (values, field) => {
    const r = validateEvent(values);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toHaveProperty(field);
  });
});
