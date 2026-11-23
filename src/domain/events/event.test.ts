import { describe, expect, it } from "vitest";
import { effectiveEventZone, validateEvent } from "./event";

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
        planningBasis: "auto",
        planOpenPlusOnes: false,
        invitationsFinal: false,
        timeZone: null,
      },
    });
  });
  it("reads a time zone, and blank means follow the wedding", () => {
    const own = validateEvent({ name: "A", timeZone: " Europe/Rome " });
    expect(own.ok && own.event.timeZone).toBe("Europe/Rome");
    const blank = validateEvent({ name: "A", timeZone: "" });
    expect(blank.ok && blank.event.timeZone).toBeNull();
    const absent = validateEvent({ name: "A" });
    expect(absent.ok && absent.event.timeZone).toBeNull();
  });
  it("refuses a zone that is not a real one", () => {
    for (const timeZone of ["Mars/Olympus", "not a zone", "x".repeat(65)]) {
      const r = validateEvent({ name: "A", timeZone });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(Object.keys(r.errors)).toEqual(["timeZone"]);
    }
  });
  it("reads the invitations-complete switch, off unless ticked", () => {
    const on = validateEvent({ name: "A", invitationsFinal: "true" });
    expect(on.ok && on.event.invitationsFinal).toBe(true);
    const off = validateEvent({ name: "A" });
    expect(off.ok && off.event.invitationsFinal).toBe(false);
  });
  it("reads the planning basis and the plus-one opt-in", () => {
    const r = validateEvent({ name: "A", planningBasis: "yes", planOpenPlusOnes: "true" });
    expect(r.ok && [r.event.planningBasis, r.event.planOpenPlusOnes]).toEqual(["yes", true]);
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
    [{ name: "A", planningBasis: "everyone" }, "planningBasis"],
  ])("rejects %j", (values, field) => {
    const r = validateEvent(values);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toHaveProperty(field);
  });
});

describe("effectiveEventZone", () => {
  it("uses the event's own zone, else the wedding's", () => {
    expect(effectiveEventZone("Europe/Rome", "America/Chicago")).toBe("Europe/Rome");
    expect(effectiveEventZone(null, "America/Chicago")).toBe("America/Chicago");
    expect(effectiveEventZone(undefined, "America/Chicago")).toBe("America/Chicago");
    expect(effectiveEventZone("  ", "America/Chicago")).toBe("America/Chicago");
  });
});
