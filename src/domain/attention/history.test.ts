import { describe, expect, it } from "vitest";
import { computeAttention, type AttentionItem } from "./attention";
import { parseDateOnly } from "@/domain/dates/date-only";
import {
  HISTORY_LIMIT,
  actorFor,
  historyDate,
  itemHistory,
  type AuditFact,
  type HistoryInput,
  type StoredRow,
} from "./history";

const TZ = "America/New_York";

function storedItem(id = "s1", occurrences = 3): AttentionItem {
  const [item] = computeAttention({
    today: parseDateOnly("2027-05-10"),
    canSeeGuestItems: true,
    events: [],
    storedItems: [{ id, eventId: "e1", eventName: "Reception", occurrences }],
    venues: [],
    vendors: [],
    invoices: [],
    eventCount: 1,
  });
  if (!item) throw new Error("no item");
  return item;
}

function venueItem(): AttentionItem {
  const [item] = computeAttention({
    today: parseDateOnly("2027-05-10"),
    canSeeGuestItems: false,
    events: [],
    storedItems: [],
    venues: [{ id: "v1", name: "Hall", booked: true, usedByEvent: false }],
    vendors: [],
    invoices: [],
    eventCount: 1,
  });
  if (!item) throw new Error("no item");
  return item;
}

const row = (over: Partial<StoredRow> = {}): StoredRow => ({
  id: "s1",
  eventId: "e1",
  status: "open",
  occurrences: 3,
  createdAt: "2027-05-03T14:00:00.000+00:00",
  resolvedAt: null,
  resolvedBy: null,
  ...over,
});

const release = (at: string, eventId = "e1"): AuditFact => ({
  action: "seating.guest_released",
  entityId: eventId,
  kind: null,
  at,
  actor: null,
});

const base = (over: Partial<HistoryInput> = {}): HistoryInput => ({
  timeZone: TZ,
  stored: [],
  audit: [],
  dismissals: [],
  ...over,
});

describe("historyDate", () => {
  it("uses the wedding's zone, not UTC", () => {
    // 02:00 UTC on 4 May is still 3 May in New York.
    expect(historyDate("2027-05-04T02:00:00Z", TZ)).toBe("3 May 2027");
  });
  it("does not throw on a bad value", () => {
    expect(historyDate("nope", TZ)).toBe("Unknown date");
  });
});

describe("stored item history", () => {
  it("groups releases by day: opened, then more", () => {
    const lines = itemHistory(
      storedItem(),
      base({
        stored: [row()],
        audit: [
          release("2027-05-03T14:00:00.000+00:00"),
          release("2027-05-03T14:00:00.000+00:00"),
          release("2027-05-04T15:00:00.000+00:00"),
          // Before this round opened, and on another event: ignored.
          release("2027-05-01T10:00:00.000+00:00"),
          release("2027-05-04T16:00:00.000+00:00", "e2"),
        ],
      }),
    ).map((l) => l.text);
    expect(lines).toEqual([
      "4 May 2027: 1 more seat released",
      "3 May 2027: opened, 2 seats released",
    ]);
  });

  it("falls back to the item row when the activity record is not readable", () => {
    const lines = itemHistory(storedItem(), base({ stored: [row()] }));
    expect(lines.map((l) => l.text)).toEqual(["3 May 2027: opened, 3 seats released in all"]);
  });

  it("shows how an earlier round closed, and who closed it, by role", () => {
    const lines = itemHistory(
      storedItem("s2", 1),
      base({
        stored: [
          row({ id: "s2", createdAt: "2027-05-08T12:00:00.000+00:00", occurrences: 1 }),
          row({
            id: "s1",
            status: "handled",
            resolvedAt: "2027-05-05T12:00:00.000+00:00",
            resolvedBy: "partner",
          }),
        ],
        audit: [
          {
            action: "attention.handled",
            entityId: "s1",
            kind: "seats_released",
            at: "2027-05-05T12:00:00.000+00:00",
            actor: "you",
          },
        ],
      }),
    ).map((l) => l.text);
    expect(lines).toEqual([
      "8 May 2027: opened, 1 seat released in all",
      "Earlier round, 5 May 2027: marked handled by you",
      "Earlier round, 3 May 2027: opened, 3 seats released in all",
    ]);
  });

  it("says when finalizing again closed it", () => {
    const lines = itemHistory(
      storedItem(),
      base({
        stored: [
          row({
            status: "refinalized",
            resolvedAt: "2027-05-06T12:00:00.000+00:00",
            resolvedBy: "owner",
          }),
        ],
      }),
    );
    expect(lines[0]?.text).toBe(
      "6 May 2027: closed when the plan was finalized again by the owner",
    );
  });

  it("caps long histories and says how many are not shown", () => {
    const audit = Array.from({ length: 20 }, (_, i) =>
      release(`2027-05-${String(3 + i).padStart(2, "0")}T15:00:00.000+00:00`),
    );
    const lines = itemHistory(storedItem(), base({ stored: [row()], audit }));
    expect(lines).toHaveLength(HISTORY_LIMIT);
    expect(lines.at(-1)?.text).toBe("9 older entries not shown");
  });
});

describe("computed item history", () => {
  it("lists dismissals and restores for this item only", () => {
    const item = venueItem();
    const lines = itemHistory(
      item,
      base({
        audit: [
          {
            action: "attention.dismissed",
            entityId: "v1",
            kind: "venue_unused",
            at: "2027-05-03T12:00:00Z",
            actor: "partner",
          },
          {
            action: "attention.restored",
            entityId: "v1",
            kind: "venue_unused",
            at: "2027-05-04T12:00:00Z",
            actor: "you",
          },
          {
            action: "attention.dismissed",
            entityId: "v1",
            kind: "vendor_unassigned",
            at: "2027-05-05T12:00:00Z",
            actor: "you",
          },
        ],
      }),
    ).map((l) => l.text);
    expect(lines).toEqual(["4 May 2027: shown again by you", "3 May 2027: dismissed by a partner"]);
  });

  it("explains a dismissed item that came back because it changed", () => {
    const item = { ...venueItem(), fingerprint: "new" };
    const lines = itemHistory(
      item,
      base({
        dismissals: [
          {
            kind: "venue_unused",
            subjectId: "v1",
            fingerprint: "old",
            dismissedAt: "2027-05-03T12:00:00Z",
            dismissedBy: "you",
          },
        ],
      }),
    ).map((l) => l.text);
    expect(lines).toEqual(["Back since then because it changed", "3 May 2027: dismissed by you"]);
  });

  it("has no history when nobody has acted on it", () => {
    expect(itemHistory(venueItem(), base())).toEqual([]);
  });
});

describe("actorFor", () => {
  const roles = new Map([
    ["u-owner", "owner"],
    ["u-ed", "editor"],
  ]);
  it("names only you or a role", () => {
    expect(actorFor("u-me", "u-me", roles)).toBe("you");
    expect(actorFor("u-owner", "u-me", roles)).toBe("owner");
    expect(actorFor("u-ed", "u-me", roles)).toBe("editor");
    expect(actorFor("u-gone", "u-me", roles)).toBe("someone");
    expect(actorFor(null, "u-me", roles)).toBeNull();
  });
});
