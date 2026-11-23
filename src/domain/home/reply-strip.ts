/**
 * Home "Replies" strip (UX-13, wireframe W1). Pure.
 *
 * One row per upcoming event that has invited anyone: how many have answered, how many are still
 * waiting and the reply date. Counts come only from `event_demand` (via `EventDemand`), so a role
 * that may not see guest totals gets no rows at all. Reply dates come from invitations, which only
 * the owner and partner can read; without them the row simply has no date.
 */
import type { EventDemand } from "@/domain/events/demand";
import { todayInZone } from "@/domain/dates/date-only";
import { instantToLocal } from "@/domain/timeline/zoned";

export type ReplyStripEvent = {
  id: string;
  name: string;
  /** The event's local date (YYYY-MM-DD), or null when not set. */
  localDate: string | null;
  /** The zone the event happens in (its own or the wedding's). */
  timeZone: string;
};

export type ReplyStripRow = {
  eventId: string;
  name: string;
  timeZone: string;
  invited: number;
  /** Attending plus not attending. */
  replied: number;
  waiting: number;
  /** Waiting, and the reply window is still open. */
  waitingOpen: number;
  /** Waiting, but the reply date or link expiry has passed. */
  waitingClosed: number;
  /** The soonest reply date still ahead, as an instant (ISO), or null. */
  nextReplyBy: string | null;
  /** True when live invitations still ahead have different reply dates (in the event's zone). */
  severalReplyDates: boolean;
};

export type ReplyStrip = { rows: ReplyStripRow[]; more: number };

export const REPLY_STRIP_LIMIT = 4;

/**
 * @param deadlines reply dates (ISO instants) of each event's live invitations; omit an event, or
 *   pass an empty map, when the caller may not read invitations.
 */
export function buildReplyStrip(
  events: readonly ReplyStripEvent[],
  demand: ReadonlyMap<string, EventDemand>,
  deadlines: ReadonlyMap<string, readonly string[]>,
  now: Date,
  limit: number = REPLY_STRIP_LIMIT,
): ReplyStrip {
  const upcoming = events.filter((e) => {
    const d = demand.get(e.id);
    if (!d || d.invited === 0) return false;
    return e.localDate === null || e.localDate >= todayInZone(e.timeZone, now);
  });
  // Dated events first, soonest first; undated keep their order at the end.
  const ordered = upcoming
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      if (a.e.localDate === b.e.localDate) return a.i - b.i;
      if (a.e.localDate === null) return 1;
      if (b.e.localDate === null) return -1;
      return a.e.localDate < b.e.localDate ? -1 : 1;
    })
    .map(({ e }) => e);

  const rows = ordered.slice(0, limit).map((e): ReplyStripRow => {
    const d = demand.get(e.id)!;
    const ahead = (deadlines.get(e.id) ?? [])
      .map((iso) => ({ iso, t: Date.parse(iso) }))
      .filter((x) => !Number.isNaN(x.t) && x.t >= now.getTime())
      .sort((a, b) => a.t - b.t);
    const days = new Set(ahead.map((x) => instantToLocal(new Date(x.t), e.timeZone).date));
    return {
      eventId: e.id,
      name: e.name,
      timeZone: e.timeZone,
      invited: d.invited,
      replied: d.yes + d.no,
      waiting: d.waiting,
      waitingOpen: d.waitingOpen,
      waitingClosed: d.waitingClosed,
      nextReplyBy: ahead[0]?.iso ?? null,
      severalReplyDates: days.size > 1,
    };
  });
  return { rows, more: ordered.length - rows.length };
}

/** Plain words for the waiting part of a row, without the date (the page renders that in the event's zone). */
export function waitingSummary(row: ReplyStripRow): string {
  if (row.waiting === 0) return "Everyone has answered";
  if (row.waitingOpen === 0) {
    return `${row.waitingClosed} did not answer by the reply date`;
  }
  const parts = [`${row.waitingOpen} waiting`];
  if (row.waitingClosed > 0) parts.push(`${row.waitingClosed} did not answer by the reply date`);
  return parts.join(" · ");
}

/** The label before the reply date, or null when there is no date to show. */
export function replyByLabel(row: ReplyStripRow): string | null {
  if (row.waitingOpen === 0 || row.nextReplyBy === null) return null;
  return row.severalReplyDates ? "next reply date" : "reply by";
}
