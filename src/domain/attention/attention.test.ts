import { describe, expect, it } from "vitest";
import { buildDemand } from "@/domain/events/demand";
import { parseDateOnly } from "@/domain/dates/date-only";
import {
  applyDismissals,
  attentionSummary,
  computeAttention,
  forEvent,
  isDismissibleKind,
  itemKey,
  type AttentionInput,
  type EventFacts,
} from "./attention";

const TODAY = parseDateOnly("2027-06-01");

function demand(over: Partial<Parameters<typeof buildDemand>[0]> = {}) {
  return buildDemand(
    {
      eventId: "e1",
      invited: 100,
      yes: 90,
      waitingOpen: 0,
      waitingClosed: 0,
      no: 10,
      openPlusOnes: 0,
      seatedConfirmed: 90,
      seatedTentative: 0,
      yesWithoutMeal: 0,
      meals: [{ id: "m1", name: "Fish", active: true, count: 90 }],
      ...over,
    },
    { basis: "auto", includeOpenPlusOnes: false },
  );
}

function event(over: Partial<EventFacts> = {}): EventFacts {
  return {
    id: "e1",
    name: "Reception",
    localDate: "2027-09-04",
    capacity: { value: 120, source: "space" },
    demand: demand(),
    replyDatePassed: false,
    lockedCount: null,
    planFinalized: false,
    ...over,
  };
}

function input(over: Partial<AttentionInput> = {}): AttentionInput {
  return {
    today: TODAY,
    canSeeGuestItems: true,
    events: [],
    storedItems: [],
    venues: [],
    vendors: [],
    invoices: [],
    eventCount: 1,
    ...over,
  };
}

const kinds = (items: { kind: string }[]) => items.map((i) => i.kind);

describe("computeAttention: capacity", () => {
  it("flags a planning number over the room, with the numbers in words", () => {
    const items = computeAttention(
      input({
        events: [
          event({ demand: demand({ yes: 130 }), capacity: { value: 120, source: "space" } }),
        ],
      }),
    );
    expect(kinds(items)).toEqual(["over_capacity"]);
    expect(items[0]?.severity).toBe("action");
    expect(items[0]?.detail).toContain("Short by 10: planning for 130, room for 120");
    expect(items[0]?.fingerprint).toBe("130|120");
  });
  it("is quiet at exactly capacity, with no capacity, and with nobody invited", () => {
    expect(computeAttention(input({ events: [event({ demand: demand({ yes: 120 }) })] }))).toEqual(
      [],
    );
    expect(
      computeAttention(
        input({ events: [event({ demand: demand({ yes: 500 }), capacity: null })] }),
      ),
    ).toEqual([]);
    expect(
      computeAttention(
        input({ events: [event({ demand: demand({ invited: 0, yes: 0, no: 0, meals: [] }) })] }),
      ),
    ).toEqual([]);
  });
});

describe("computeAttention: caterer count", () => {
  it("flags more attending than the caterer was told, not the other way round", () => {
    const more = computeAttention(input({ events: [event({ lockedCount: 80 })] }));
    expect(kinds(more)).toEqual(["caterer_count"]);
    expect(more[0]?.detail).toContain("80 guests");
    expect(more[0]?.detail).toContain("90 are attending now, 10 more");
    expect(computeAttention(input({ events: [event({ lockedCount: 100 })] }))).toEqual([]);
    expect(computeAttention(input({ events: [event({ lockedCount: 90 })] }))).toEqual([]);
    expect(computeAttention(input({ events: [event({ lockedCount: null })] }))).toEqual([]);
  });
});

describe("computeAttention: meals", () => {
  const missing = demand({ yesWithoutMeal: 3 });
  it("flags attending guests without a meal only after the reply date", () => {
    expect(
      computeAttention(input({ events: [event({ demand: missing, replyDatePassed: false })] })),
    ).toEqual([]);
    const items = computeAttention(
      input({ events: [event({ demand: missing, replyDatePassed: true })] }),
    );
    expect(kinds(items)).toEqual(["meals_missing"]);
    expect(items[0]?.title).toContain("3 guests still without a meal");
  });
  it("says nothing when the event offers no meal", () => {
    const none = demand({ yesWithoutMeal: 3, meals: [] });
    expect(
      computeAttention(input({ events: [event({ demand: none, replyDatePassed: true })] })),
    ).toEqual([]);
    const inactive = demand({
      yesWithoutMeal: 3,
      meals: [{ id: "m", name: "Old", active: false, count: 0 }],
    });
    expect(
      computeAttention(input({ events: [event({ demand: inactive, replyDatePassed: true })] })),
    ).toEqual([]);
  });
});

describe("computeAttention: seating", () => {
  it("flags unseated attending guests only on a finalized plan", () => {
    const short = demand({ seatedConfirmed: 85 });
    expect(
      computeAttention(input({ events: [event({ demand: short, planFinalized: false })] })),
    ).toEqual([]);
    const items = computeAttention(
      input({ events: [event({ demand: short, planFinalized: true })] }),
    );
    expect(kinds(items)).toEqual(["seats_missing"]);
    expect(items[0]?.title).toContain("5 guests without a seat");
    expect(items[0]?.path).toBe("seating/e1");
  });
  it("turns a stored release into a check item with the count, and keeps its row id", () => {
    const one = computeAttention(
      input({ storedItems: [{ id: "s1", eventId: "e1", eventName: "Reception", occurrences: 1 }] }),
    );
    expect(one[0]?.kind).toBe("seats_released");
    expect(one[0]?.storedId).toBe("s1");
    expect(one[0]?.title).toBe("Reception: a seat was released");
    const many = computeAttention(
      input({ storedItems: [{ id: "s1", eventId: "e1", eventName: "Reception", occurrences: 3 }] }),
    );
    expect(many[0]?.title).toBe("Reception: 3 seats were released");
  });
});

describe("computeAttention: role", () => {
  it("never produces reply-derived items for someone who may not see them", () => {
    const everything = input({
      canSeeGuestItems: false,
      events: [
        event({
          demand: demand({ yes: 200, seatedConfirmed: 0, yesWithoutMeal: 4 }),
          lockedCount: 10,
          replyDatePassed: true,
          planFinalized: true,
        }),
      ],
      storedItems: [{ id: "s1", eventId: "e1", eventName: "Reception", occurrences: 2 }],
    });
    expect(computeAttention(everything)).toEqual([]);
  });
  it("still produces venue, vendor and invoice items for them", () => {
    const items = computeAttention(
      input({
        canSeeGuestItems: false,
        venues: [{ id: "v1", name: "The Barn", booked: true, usedByEvent: false }],
        vendors: [{ id: "d1", name: "Lens Co", booked: true, worksAtEvent: false }],
        invoices: [
          {
            id: "i1",
            number: "1042",
            bookingTitle: "Lens Co",
            currency: "USD",
            dueOn: "2027-05-30",
            unpaidMinor: 120000,
          },
        ],
      }),
    );
    expect(kinds(items).sort()).toEqual(["invoice_due", "vendor_unassigned", "venue_unused"]);
  });
});

describe("computeAttention: venues and vendors", () => {
  it("flags a booked venue no event uses, and a booked vendor at no event", () => {
    const items = computeAttention(
      input({
        venues: [
          { id: "v1", name: "The Barn", booked: true, usedByEvent: false },
          { id: "v2", name: "Hall", booked: true, usedByEvent: true },
          { id: "v3", name: "Saved only", booked: false, usedByEvent: false },
        ],
        vendors: [
          { id: "d1", name: "Lens Co", booked: true, worksAtEvent: false },
          { id: "d2", name: "Cake Co", booked: true, worksAtEvent: true },
          { id: "d3", name: "Maybe Co", booked: false, worksAtEvent: false },
        ],
      }),
    );
    expect(items.map((i) => i.subjectId).sort()).toEqual(["d1", "v1"]);
  });
  it("says nothing before there is an event to attach them to", () => {
    expect(
      computeAttention(
        input({
          eventCount: 0,
          venues: [{ id: "v1", name: "The Barn", booked: true, usedByEvent: false }],
          vendors: [{ id: "d1", name: "Lens Co", booked: true, worksAtEvent: false }],
        }),
      ),
    ).toEqual([]);
  });
});

describe("computeAttention: invoices", () => {
  const inv = (dueOn: string, unpaidMinor = 50000) => ({
    id: `i-${dueOn}`,
    number: "7",
    bookingTitle: "Lens Co",
    currency: "USD",
    dueOn,
    unpaidMinor,
  });
  it("is action when overdue, check when due within a week, silent after that or when paid", () => {
    const items = computeAttention(
      input({
        invoices: [
          inv("2027-05-29"),
          inv("2027-06-01"),
          inv("2027-06-08"),
          inv("2027-06-09"),
          inv("2027-05-01", 0),
        ],
      }),
    );
    const byDue = Object.fromEntries(items.map((i) => [i.subjectId, i]));
    expect(byDue["i-2027-05-29"]?.severity).toBe("action");
    expect(byDue["i-2027-05-29"]?.title).toBe("Invoice 7 for Lens Co is 3 days overdue");
    expect(byDue["i-2027-06-01"]?.title).toBe("Invoice 7 for Lens Co is due today");
    expect(byDue["i-2027-06-08"]?.title).toBe("Invoice 7 for Lens Co is due in 7 days");
    expect(byDue["i-2027-06-08"]?.severity).toBe("check");
    expect(byDue["i-2027-06-09"]).toBeUndefined();
    expect(items).toHaveLength(3);
    expect(byDue["i-2027-06-01"]?.detail).toContain("$500.00 still to pay");
  });
});

describe("ordering", () => {
  it("puts action before check, then the earlier event, and is stable", () => {
    const e1 = event({
      id: "e1",
      name: "Ceremony",
      localDate: "2027-09-04",
      demand: demand({ eventId: "e1", yes: 130 }),
    });
    const e2 = event({
      id: "e2",
      name: "Brunch",
      localDate: "2027-09-05",
      demand: demand({ eventId: "e2", yes: 130 }),
    });
    const forward = computeAttention(
      input({
        events: [e2, e1],
        venues: [{ id: "v1", name: "The Barn", booked: true, usedByEvent: false }],
      }),
    );
    expect(forward.map((i) => i.key)).toEqual([
      "over_capacity:e1",
      "over_capacity:e2",
      "venue_unused:v1",
    ]);
    const reversed = computeAttention(
      input({
        events: [e1, e2],
        venues: [{ id: "v1", name: "The Barn", booked: true, usedByEvent: false }],
      }),
    );
    expect(reversed.map((i) => i.key)).toEqual(forward.map((i) => i.key));
  });
});

describe("applyDismissals", () => {
  const base = computeAttention(input({ events: [event({ demand: demand({ yes: 130 }) })] }));
  it("hides an item while it looks as it did, and brings it back when it changes", () => {
    const same = applyDismissals(base, [
      { kind: "over_capacity", subjectId: "e1", fingerprint: "130|120" },
    ]);
    expect(same.visible).toEqual([]);
    expect(same.dismissed).toHaveLength(1);
    const worse = computeAttention(input({ events: [event({ demand: demand({ yes: 135 }) })] }));
    const changed = applyDismissals(worse, [
      { kind: "over_capacity", subjectId: "e1", fingerprint: "130|120" },
    ]);
    expect(changed.visible).toHaveLength(1);
    expect(changed.dismissed).toEqual([]);
  });
  it("matches by kind and subject, not by subject alone", () => {
    const r = applyDismissals(base, [
      { kind: "caterer_count", subjectId: "e1", fingerprint: "130|120" },
    ]);
    expect(r.visible).toHaveLength(1);
  });
  it("never hides a stored item", () => {
    const stored = computeAttention(
      input({ storedItems: [{ id: "s1", eventId: "e1", eventName: "Reception", occurrences: 1 }] }),
    );
    const r = applyDismissals(stored, [
      { kind: "seats_released", subjectId: "s1", fingerprint: "1" },
    ]);
    expect(r.visible).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("filters by event and summarizes", () => {
    const items = computeAttention(
      input({
        events: [event({ demand: demand({ yes: 130 }) })],
        venues: [{ id: "v1", name: "The Barn", booked: true, usedByEvent: false }],
      }),
    );
    expect(forEvent(items, "e1").map((i) => i.kind)).toEqual(["over_capacity"]);
    expect(forEvent(items, "other")).toEqual([]);
    expect(attentionSummary(0)).toBe("Nothing needs you right now.");
    expect(attentionSummary(1)).toBe("1 thing needs you.");
    expect(attentionSummary(4)).toBe("4 things need you.");
  });
  it("knows which kinds can be dismissed", () => {
    expect(isDismissibleKind("over_capacity")).toBe(true);
    expect(isDismissibleKind("seats_released")).toBe(false);
    expect(isDismissibleKind("nonsense")).toBe(false);
    expect(itemKey("venue_unused", "v1")).toBe("venue_unused:v1");
  });
});

describe("item drawer fields (UX-12)", () => {
  it("every item says what it touches and how to fix it, separately from what happened", () => {
    const items = computeAttention(
      input({
        events: [
          event({
            capacity: { value: 50, source: "space" },
            lockedCount: 80,
            planFinalized: true,
            replyDatePassed: true,
            demand: demand({ yesWithoutMeal: 3, seatedConfirmed: 80 }),
          }),
        ],
        storedItems: [{ id: "s1", eventId: "e1", eventName: "Reception", occurrences: 2 }],
        venues: [{ id: "v1", name: "Hall", booked: true, usedByEvent: false }],
        vendors: [{ id: "d1", name: "Band", booked: true, worksAtEvent: false }],
        invoices: [
          {
            id: "i1",
            number: "7",
            bookingTitle: "Band",
            currency: "USD",
            dueOn: "2027-05-30",
            unpaidMinor: 100,
          },
        ],
      }),
    );
    const kinds = new Set(items.map((i) => i.kind));
    expect(kinds.size).toBe(8);
    for (const item of items) {
      expect(item.touches.length).toBeGreaterThan(0);
      expect(item.fix.length).toBeGreaterThan(0);
      expect(item.detail).not.toContain(item.fix);
    }
    const released = items.find((i) => i.kind === "seats_released");
    expect(released?.touches).toContain("out of date");
    expect(released?.fix).toContain("finalize it again");
    const invoice = items.find((i) => i.kind === "invoice_due");
    expect(invoice?.fix).toContain("does not move any money");
  });
});
