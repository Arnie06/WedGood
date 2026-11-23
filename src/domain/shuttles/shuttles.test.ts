import { describe, expect, it } from "vitest";
import {
  coverageSentence,
  manifestRows,
  parseShuttleRunInput,
  runToFormValues,
  summarizeShuttles,
  type ShuttleRun,
} from "./shuttles";

const valid = {
  direction: "to_event",
  label: "  Hotel   shuttle 1 ",
  pickup: "Grand Hotel lobby",
  dropoff: "",
  date: "2027-06-12",
  time: "15:30",
  capacity: "24",
  notes: "",
};

describe("parseShuttleRunInput", () => {
  it("accepts a valid run and resolves the departure in the event zone", () => {
    const r = parseShuttleRunInput(valid, "America/Chicago");
    expect(r).toEqual({
      ok: true,
      value: {
        direction: "to_event",
        label: "Hotel shuttle 1",
        pickup: "Grand Hotel lobby",
        dropoff: null,
        departsAt: "2027-06-12T20:30:00.000Z",
        capacity: 24,
        notes: null,
      },
    });
  });

  it("uses the zone it is given (east of UTC)", () => {
    const r = parseShuttleRunInput(valid, "Europe/Athens");
    expect(r.ok && r.value.departsAt).toBe("2027-06-12T12:30:00.000Z");
  });

  it("reports every missing field", () => {
    const r = parseShuttleRunInput({}, "UTC");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.fieldErrors).sort()).toEqual(
      ["capacity", "date", "direction", "label", "pickup", "time"].sort(),
    );
  });

  it.each(["0", "101", "2.5", "-3", "ten", " "])("refuses %j seats", (capacity) => {
    const r = parseShuttleRunInput({ ...valid, capacity }, "UTC");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fieldErrors.capacity).toBeDefined();
  });

  it("accepts the boundaries 1 and 100", () => {
    expect(parseShuttleRunInput({ ...valid, capacity: "1" }, "UTC").ok).toBe(true);
    expect(parseShuttleRunInput({ ...valid, capacity: "100" }, "UTC").ok).toBe(true);
  });

  it("refuses a direction it does not know", () => {
    const r = parseShuttleRunInput({ ...valid, direction: "sideways" }, "UTC");
    expect(!r.ok && r.fieldErrors.direction).toBeTruthy();
  });

  it("refuses a time skipped by a clock change and one that happens twice", () => {
    const skipped = parseShuttleRunInput(
      { ...valid, date: "2027-03-14", time: "02:30" },
      "America/Chicago",
    );
    expect(!skipped.ok && skipped.fieldErrors.time).toMatch(/doesn't exist/);
    const twice = parseShuttleRunInput(
      { ...valid, date: "2027-11-07", time: "01:30" },
      "America/Chicago",
    );
    expect(!twice.ok && twice.fieldErrors.time).toMatch(/twice/);
  });

  it("limits text lengths", () => {
    const r = parseShuttleRunInput(
      {
        ...valid,
        label: "x".repeat(61),
        pickup: "x".repeat(201),
        dropoff: "x".repeat(201),
        notes: "x".repeat(501),
      },
      "UTC",
    );
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(Object.keys(r.fieldErrors).sort()).toEqual(["dropoff", "label", "notes", "pickup"]);
  });

  it("round-trips through the edit form values", () => {
    const r = parseShuttleRunInput(
      { ...valid, dropoff: "Chapel", notes: "Wheelchair lift" },
      "Asia/Tokyo",
    );
    if (!r.ok) throw new Error("expected ok");
    const run: ShuttleRun = { ...r.value, id: "r1", version: 1 };
    const back = parseShuttleRunInput(runToFormValues(run, "Asia/Tokyo"), "Asia/Tokyo");
    expect(back).toEqual(r);
  });
});

const run = (over: Partial<ShuttleRun> & Pick<ShuttleRun, "id">): ShuttleRun => ({
  direction: "to_event",
  label: over.id,
  pickup: "Hotel",
  dropoff: null,
  departsAt: "2027-06-12T20:00:00.000Z",
  capacity: 2,
  notes: null,
  version: 1,
  ...over,
});
const ana = { id: "g1", name: "Ana Example" };
const ben = { id: "g2", name: "Ben Example" };
const cy = { id: "g3", name: "Cy Example" };

describe("summarizeShuttles", () => {
  it("groups by direction in departure order and lists who has no ride each way", () => {
    const s = summarizeShuttles({
      runs: [
        run({ id: "late", departsAt: "2027-06-12T21:00:00.000Z" }),
        run({ id: "early", departsAt: "2027-06-12T19:00:00.000Z", capacity: 3 }),
        run({ id: "home", direction: "from_event", capacity: 10 }),
      ],
      assignments: [
        { runId: "early", guestId: "g2", direction: "to_event" },
        { runId: "early", guestId: "g1", direction: "to_event" },
        { runId: "home", guestId: "g1", direction: "from_event" },
      ],
      attending: [cy, ben, ana],
    });
    const [to, from] = s.directions;
    expect(s.attending).toBe(3);
    expect(to!.runs.map((r) => r.id)).toEqual(["early", "late"]);
    expect(to!.runs[0]!.riders.map((g) => g.name)).toEqual(["Ana Example", "Ben Example"]);
    expect(to!.runs[0]!.open).toBe(1);
    expect(to!.seats).toBe(5);
    expect(to!.riding).toBe(2);
    expect(to!.withoutRide).toEqual([cy]);
    expect(from!.riding).toBe(1);
    expect(from!.withoutRide.map((g) => g.id)).toEqual(["g2", "g3"]);
  });

  it("ignores a ride for someone no longer attending", () => {
    const s = summarizeShuttles({
      runs: [run({ id: "a" })],
      assignments: [{ runId: "a", guestId: "gone", direction: "to_event" }],
      attending: [ana],
    });
    expect(s.directions[0]!.runs[0]!.riders).toEqual([]);
    expect(s.directions[0]!.runs[0]!.open).toBe(2);
    expect(s.directions[0]!.riding).toBe(0);
  });

  it("never reports negative open seats", () => {
    const s = summarizeShuttles({
      runs: [run({ id: "a", capacity: 1 })],
      assignments: [
        { runId: "a", guestId: "g1", direction: "to_event" },
        { runId: "a", guestId: "g2", direction: "to_event" },
      ],
      attending: [ana, ben],
    });
    expect(s.directions[0]!.runs[0]!.open).toBe(0);
  });

  it("handles no runs and no guests", () => {
    const s = summarizeShuttles({ runs: [], assignments: [], attending: [] });
    expect(s.directions.map((d) => [d.seats, d.riding, d.withoutRide.length])).toEqual([
      [0, 0, 0],
      [0, 0, 0],
    ]);
  });
});

describe("coverageSentence", () => {
  it("reads naturally for one and many", () => {
    expect(coverageSentence({ direction: "to_event", riding: 0 }, 1)).toBe(
      "0 of 1 attending guest has a ride to the event.",
    );
    expect(coverageSentence({ direction: "from_event", riding: 4 }, 9)).toBe(
      "4 of 9 attending guests have a ride back from the event.",
    );
  });
});

describe("manifestRows", () => {
  it("lists each rider and empty runs, without private details", () => {
    const s = summarizeShuttles({
      runs: [
        run({ id: "a", label: "Bus A", dropoff: "Chapel" }),
        run({ id: "b", direction: "from_event", label: "Bus B" }),
      ],
      assignments: [{ runId: "a", guestId: "g1", direction: "to_event" }],
      attending: [ana],
    });
    expect(manifestRows(s, "UTC", () => "3:00 PM")).toEqual([
      ["Direction", "Shuttle", "Departs", "Pickup", "Drop-off", "Guest"],
      ["To the event", "Bus A", "3:00 PM", "Hotel", "Chapel", "Ana Example"],
      ["From the event", "Bus B", "3:00 PM", "Hotel", "", "(no riders yet)"],
    ]);
  });
});
