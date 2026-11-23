import { describe, expect, it } from "vitest";
import { buildDemand, type EventCounts } from "@/domain/events/demand";
import {
  buildReplyStrip,
  replyByLabel,
  waitingSummary,
  type ReplyStripEvent,
  type ReplyStripRow,
} from "./reply-strip";

const NOW = new Date("2027-03-01T12:00:00Z");
const NY = "America/New_York";

function demand(id: string, over: Partial<EventCounts> = {}) {
  return buildDemand(
    {
      eventId: id,
      invited: 10,
      yes: 4,
      waitingOpen: 3,
      waitingClosed: 1,
      no: 2,
      openPlusOnes: 0,
      seatedConfirmed: 0,
      seatedTentative: 0,
      yesWithoutMeal: 0,
      meals: [],
      ...over,
    },
    { basis: "auto", includeOpenPlusOnes: false },
  );
}

const ev = (id: string, localDate: string | null, timeZone = NY): ReplyStripEvent => ({
  id,
  name: id,
  localDate,
  timeZone,
});

describe("buildReplyStrip", () => {
  it("counts replies from event demand: attending plus not attending", () => {
    const { rows } = buildReplyStrip(
      [ev("Reception", "2027-06-12")],
      new Map([["Reception", demand("Reception")]]),
      new Map(),
      NOW,
    );
    expect(rows).toEqual([
      expect.objectContaining({
        eventId: "Reception",
        invited: 10,
        replied: 6,
        waiting: 4,
        waitingOpen: 3,
        waitingClosed: 1,
        nextReplyBy: null,
        severalReplyDates: false,
      }),
    ]);
  });

  it("shows nothing when the caller may not see totals (no demand)", () => {
    const strip = buildReplyStrip([ev("Reception", "2027-06-12")], new Map(), new Map(), NOW);
    expect(strip).toEqual({ rows: [], more: 0 });
  });

  it("leaves out events nobody is invited to and events already past in their own zone", () => {
    const strip = buildReplyStrip(
      [
        ev("Empty", "2027-06-12"),
        ev("Yesterday", "2027-02-28"),
        // 12:00 UTC on 1 March is already 2 March in Auckland, so a 1 March event there is past.
        ev("AucklandToday", "2027-03-01", "Pacific/Auckland"),
        ev("Today", "2027-03-01"),
      ],
      new Map([
        ["Empty", demand("Empty", { invited: 0, yes: 0, no: 0, waitingOpen: 0, waitingClosed: 0 })],
        ["Yesterday", demand("Yesterday")],
        ["AucklandToday", demand("AucklandToday")],
        ["Today", demand("Today")],
      ]),
      new Map(),
      NOW,
    );
    expect(strip.rows.map((r) => r.eventId)).toEqual(["Today"]);
  });

  it("orders dated events soonest first and undated ones last, and caps the list", () => {
    const ids = ["Undated", "June", "April", "May", "July"];
    const strip = buildReplyStrip(
      [
        ev("Undated", null),
        ev("June", "2027-06-12"),
        ev("April", "2027-04-01"),
        ev("May", "2027-05-01"),
        ev("July", "2027-07-01"),
      ],
      new Map(ids.map((id) => [id, demand(id)])),
      new Map(),
      NOW,
      4,
    );
    expect(strip.rows.map((r) => r.eventId)).toEqual(["April", "May", "June", "July"]);
    expect(strip.more).toBe(1);
  });

  it("uses the soonest reply date still ahead and ignores passed or broken ones", () => {
    const { rows } = buildReplyStrip(
      [ev("Reception", "2027-06-12")],
      new Map([["Reception", demand("Reception")]]),
      new Map([
        [
          "Reception",
          ["2027-02-01T04:59:59Z", "not a date", "2027-05-02T03:59:59Z", "2027-05-02T03:59:59Z"],
        ],
      ]),
      NOW,
    );
    expect(rows[0]!.nextReplyBy).toBe("2027-05-02T03:59:59Z");
    expect(rows[0]!.severalReplyDates).toBe(false);
  });

  it("flags several reply dates by the event's local day, not by instant", () => {
    const sameDay = buildReplyStrip(
      [ev("Reception", "2027-06-12")],
      new Map([["Reception", demand("Reception")]]),
      // 1 May 10:00 and 23:59 in New York: one reply date.
      new Map([["Reception", ["2027-05-01T14:00:00Z", "2027-05-02T03:59:59Z"]]]),
      NOW,
    );
    expect(sameDay.rows[0]!.severalReplyDates).toBe(false);
    expect(sameDay.rows[0]!.nextReplyBy).toBe("2027-05-01T14:00:00Z");

    const twoDays = buildReplyStrip(
      [ev("Reception", "2027-06-12")],
      new Map([["Reception", demand("Reception")]]),
      new Map([["Reception", ["2027-05-02T03:59:59Z", "2027-05-16T03:59:59Z"]]]),
      NOW,
    );
    expect(twoDays.rows[0]!.severalReplyDates).toBe(true);
  });
});

const row = (over: Partial<ReplyStripRow> = {}): ReplyStripRow => ({
  eventId: "e",
  name: "Reception",
  timeZone: NY,
  invited: 10,
  replied: 6,
  waiting: 4,
  waitingOpen: 4,
  waitingClosed: 0,
  nextReplyBy: "2027-05-02T03:59:59Z",
  severalReplyDates: false,
  ...over,
});

describe("waitingSummary and replyByLabel", () => {
  it("says everyone answered when nobody is waiting, with no date", () => {
    const r = row({ replied: 10, waiting: 0, waitingOpen: 0 });
    expect(waitingSummary(r)).toBe("Everyone has answered");
    expect(replyByLabel(r)).toBeNull();
  });

  it("names those still waiting and the reply date", () => {
    expect(waitingSummary(row())).toBe("4 waiting");
    expect(replyByLabel(row())).toBe("reply by");
    expect(replyByLabel(row({ severalReplyDates: true }))).toBe("next reply date");
  });

  it("separates those who did not answer in time", () => {
    expect(waitingSummary(row({ waitingOpen: 3, waitingClosed: 1 }))).toBe(
      "3 waiting · 1 did not answer by the reply date",
    );
    const closed = row({ waitingOpen: 0, waitingClosed: 4, nextReplyBy: null });
    expect(waitingSummary(closed)).toBe("4 did not answer by the reply date");
    expect(replyByLabel(closed)).toBeNull();
  });

  it("shows no date when none is known (a collaborator, or no reply date set)", () => {
    expect(replyByLabel(row({ nextReplyBy: null }))).toBeNull();
  });
});
