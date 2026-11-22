import { describe, expect, it } from "vitest";
import {
  buildSeatingPlan,
  type GuestInfo,
  type PlanAssignment,
  type PlanMember,
  type PlanTable,
} from "./plan";
import { suggestSeating, toPlacements } from "./suggest";

const info = (guestId: string, invitationId: string | null, label = "Family"): GuestInfo => ({
  guestId,
  householdName: null,
  invitationId,
  invitationLabel: invitationId ? label : null,
  isPlusOne: false,
  hostNames: [],
  tags: [],
  ageGroup: null,
  dietary: "private note must never matter here",
  accessibility: null,
});

type Spec = {
  guests: {
    id: string;
    name: string;
    invitation?: string | undefined;
    status?: PlanMember["status"] | undefined;
  }[];
  tables: PlanTable[];
  seated?: PlanAssignment[];
  allowTentative?: boolean;
};

function run(spec: Spec) {
  const plan = buildSeatingPlan({
    guests: spec.guests.map((g) => ({ id: g.id, name: g.name })),
    members: spec.guests.map((g) => ({
      guestId: g.id,
      status: g.status ?? "accepted",
      mealOptionId: null,
    })),
    tables: spec.tables,
    assignments: spec.seated ?? [],
    meals: [],
    allowTentative: spec.allowTentative ?? false,
    info: spec.guests.map((g) => info(g.id, g.invitation ?? null, `Inv ${g.invitation}`)),
  });
  const details = spec.guests.map((g) => info(g.id, g.invitation ?? null, `Inv ${g.invitation}`));
  return { plan, suggestion: suggestSeating({ plan, info: details }) };
}

const guest = (id: string, invitation?: string, status?: PlanMember["status"]) => ({
  id,
  name: `Guest ${id.toUpperCase()}`,
  invitation,
  status,
});

describe("suggested seating", () => {
  it("keeps an invitation together and fills the tightest table first", () => {
    const { suggestion } = run({
      guests: [guest("a", "i1"), guest("b", "i1"), guest("c", "i1"), guest("d"), guest("e")],
      tables: [
        { id: "t1", label: "Table 1", capacity: 6 },
        { id: "t2", label: "Table 2", capacity: 3 },
      ],
    });
    // The group of three takes the table of exactly three; the singles then take table 1.
    const t2 = suggestion.tables.find((t) => t.tableId === "t2")!;
    expect(t2.groups.map((g) => g.guests.map((x) => x.id))).toEqual([["a", "b", "c"]]);
    const t1 = suggestion.tables.find((t) => t.tableId === "t1")!;
    expect(t1.groups.flatMap((g) => g.guests.map((x) => x.id)).sort()).toEqual(["d", "e"]);
    expect(suggestion.placedCount).toBe(5);
    expect(suggestion.unplaced).toEqual([]);
  });

  it("is deterministic and independent of input order", () => {
    const spec: Spec = {
      guests: [
        guest("a", "i1"),
        guest("b", "i1"),
        guest("c", "i2"),
        guest("d", "i2"),
        guest("e"),
        guest("f"),
      ],
      tables: [
        { id: "t1", label: "Table 1", capacity: 4 },
        { id: "t2", label: "Table 2", capacity: 4 },
      ],
    };
    const first = run(spec).suggestion;
    const again = run(spec).suggestion;
    const reversed = run({ ...spec, guests: [...spec.guests].reverse() }).suggestion;
    expect(again).toEqual(first);
    expect(toPlacements(reversed).map((p) => ({ ...p, guestIds: [...p.guestIds].sort() }))).toEqual(
      toPlacements(first).map((p) => ({ ...p, guestIds: [...p.guestIds].sort() })),
    );
  });

  it("never moves people who are already seated and never exceeds capacity", () => {
    const { plan, suggestion } = run({
      guests: [guest("a"), guest("b"), guest("c"), guest("d"), guest("e")],
      tables: [
        { id: "t1", label: "Table 1", capacity: 3 },
        { id: "t2", label: "Table 2", capacity: 2 },
      ],
      seated: [{ guestId: "a", tableId: "t1", tentative: false, seatNumber: 1 }],
    });
    const placedIds = suggestion.tables.flatMap((t) =>
      t.groups.flatMap((g) => g.guests.map((x) => x.id)),
    );
    expect(placedIds).not.toContain("a");
    for (const t of suggestion.tables) {
      expect(t.usedAfter).toBeLessThanOrEqual(t.capacity);
      expect(t.usedBefore).toBe(plan.tables.find((x) => x.id === t.tableId)!.used);
    }
    expect(suggestion.placedCount).toBe(4);
  });

  it("sends the rest of an invitation to the table where part of it already sits", () => {
    const { suggestion } = run({
      guests: [guest("a", "i1"), guest("b", "i1"), guest("c")],
      tables: [
        { id: "t1", label: "Table 1", capacity: 4 },
        { id: "t2", label: "Table 2", capacity: 4 },
      ],
      seated: [{ guestId: "a", tableId: "t2", tentative: false, seatNumber: null }],
    });
    const group = suggestion.tables.flatMap((t) =>
      t.groups.filter((g) => g.key === "i1").map(() => t.tableId),
    );
    expect(group).toEqual(["t2"]);
  });

  it("reports a group that cannot sit together instead of splitting it", () => {
    const { suggestion } = run({
      guests: [guest("a", "i1"), guest("b", "i1"), guest("c", "i1"), guest("d")],
      tables: [
        { id: "t1", label: "Table 1", capacity: 2 },
        { id: "t2", label: "Table 2", capacity: 2 },
      ],
    });
    expect(suggestion.unplaced).toHaveLength(1);
    expect(suggestion.unplaced[0]).toMatchObject({
      key: "i1",
      reason: "too-large",
      needed: 3,
      largestOpen: 2,
    });
    expect(suggestion.unplacedCount).toBe(3);
    expect(suggestion.placedCount).toBe(1);
  });

  it("reports everyone as not placed when every table is full or there are no tables", () => {
    const full = run({
      guests: [guest("a"), guest("b")],
      tables: [{ id: "t1", label: "Table 1", capacity: 1 }],
      seated: [{ guestId: "a", tableId: "t1", tentative: false, seatNumber: null }],
    }).suggestion;
    expect(full.unplaced.map((g) => g.reason)).toEqual(["no-room"]);
    expect(full.tables).toEqual([]);

    const none = run({ guests: [guest("a")], tables: [] }).suggestion;
    expect(none.unplaced).toHaveLength(1);
    expect(none.unplaced[0]!.reason).toBe("no-room");
    expect(none.placedCount).toBe(0);
  });

  it("places waiting guests only when tentative seating is on, and says so", () => {
    const spec: Spec = {
      guests: [guest("a"), guest("b", undefined, "pending"), guest("c", undefined, "declined")],
      tables: [{ id: "t1", label: "Table 1", capacity: 5 }],
    };
    const off = run(spec).suggestion;
    expect(off.tables.flatMap((t) => t.groups.flatMap((g) => g.guests.map((x) => x.id)))).toEqual([
      "a",
    ]);
    const on = run({ ...spec, allowTentative: true }).suggestion;
    expect(on.placedCount).toBe(2);
    expect(on.tentativeCount).toBe(1);
    const ids = on.tables.flatMap((t) => t.groups.flatMap((g) => g.guests.map((x) => x.id)));
    expect(ids).not.toContain("c");
  });

  it("proposes nothing when nobody needs a seat, and carries no private text", () => {
    const empty = run({
      guests: [guest("a")],
      tables: [{ id: "t1", label: "Table 1", capacity: 2 }],
      seated: [{ guestId: "a", tableId: "t1", tentative: false, seatNumber: null }],
    }).suggestion;
    expect(empty).toEqual({
      tables: [],
      unplaced: [],
      placedCount: 0,
      unplacedCount: 0,
      tentativeCount: 0,
    });
    const some = run({
      guests: [guest("a"), guest("b")],
      tables: [{ id: "t1", label: "Table 1", capacity: 2 }],
    }).suggestion;
    expect(JSON.stringify(some)).not.toContain("private note");
    expect(Object.keys(toPlacements(some)[0]!).sort()).toEqual(["guestIds", "tableId"]);
  });
});
