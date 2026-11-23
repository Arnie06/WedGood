/**
 * Per-guest replies for one event, for the guest list (UX-01). Pure.
 *
 * Uses the same population and rules as `event_demand` (src/domain/events/demand.ts and the
 * `app_private.event_demand_rows` SQL): active responses only; "waiting" is pending, open or past
 * the reply date; "attending without a meal" is accepted with no meal chosen; "attending not seated"
 * is accepted with no confirmed seat. Callers pass only guests who are not archived. The integration
 * test compares these filters with `event_demand` so the two cannot drift.
 */

import type { RsvpStatus } from "./rsvp";

export type ReplyAnswer = "yes" | "no" | "waiting" | "not_invited";

export const ANSWER_LABELS: Record<ReplyAnswer, string> = {
  yes: "Attending",
  waiting: "Waiting",
  no: "Not attending",
  not_invited: "Not invited",
};

export const REPLY_FILTERS = [
  "yes",
  "waiting",
  "no",
  "not_invited",
  "no_meal",
  "not_seated",
] as const;
export type ReplyFilter = (typeof REPLY_FILTERS)[number];

export const REPLY_FILTER_LABELS: Record<ReplyFilter, string> = {
  yes: "Attending",
  waiting: "Waiting for an answer",
  no: "Not attending",
  not_invited: "Not invited",
  no_meal: "Attending without a meal",
  not_seated: "Attending, not seated",
};

export function isReplyFilter(value: unknown): value is ReplyFilter {
  return typeof value === "string" && (REPLY_FILTERS as readonly string[]).includes(value);
}

export type ReplyMember = {
  guestId: string;
  invitationId: string;
  isPlusOne: boolean;
  active: boolean;
  status: RsvpStatus;
  mealOptionId: string | null;
};
export type ReplyInvitation = { id: string; deadline: string | null; expiresAt: string };
export type ReplyMealOption = { id: string; name: string; active: boolean };
export type ReplySeat = {
  guestId: string;
  tableLabel: string;
  seatNumber: number | null;
  tentative: boolean;
};

export type ReplyInput = {
  now: Date;
  /** Responses for this event only. Inactive ones are ignored. */
  members: readonly ReplyMember[];
  invitations: readonly ReplyInvitation[];
  mealOptions: readonly ReplyMealOption[];
  /** Seats in this event's layout. */
  seats: readonly ReplySeat[];
};

export type GuestReply = {
  answer: Exclude<ReplyAnswer, "not_invited">;
  /** Waiting, and the reply date or link expiry has passed (event_demand's waiting_closed). */
  replyClosed: boolean;
  isPlusOne: boolean;
  /** The chosen meal's name, for attending guests only. */
  meal: string | null;
  seat: { tableLabel: string; seatNumber: number | null; tentative: boolean } | null;
};

export type GuestReplies = {
  byGuest: ReadonlyMap<string, GuestReply>;
  /** True when the event offers meal choices, or someone already chose one. */
  asksMeal: boolean;
};

/** Mirrors the SQL: open while the link has not expired and the reply date has not passed. */
function windowOpen(invitation: ReplyInvitation | undefined, now: Date): boolean {
  if (!invitation) return false;
  const t = now.getTime();
  return (
    Date.parse(invitation.expiresAt) > t &&
    (invitation.deadline === null || Date.parse(invitation.deadline) >= t)
  );
}

const ANSWER_OF: Record<RsvpStatus, GuestReply["answer"]> = {
  accepted: "yes",
  declined: "no",
  pending: "waiting",
};

export function buildGuestReplies(input: ReplyInput): GuestReplies {
  const invitations = new Map(input.invitations.map((i) => [i.id, i]));
  const meals = new Map(input.mealOptions.map((m) => [m.id, m]));
  const seats = new Map(input.seats.map((s) => [s.guestId, s]));
  const byGuest = new Map<string, GuestReply>();
  let mealChosen = false;
  for (const m of input.members) {
    if (!m.active) continue;
    if (byGuest.has(m.guestId)) {
      throw new Error(`Guest ${m.guestId} has more than one active response for this event`);
    }
    const answer = ANSWER_OF[m.status];
    const seat = seats.get(m.guestId);
    if (m.mealOptionId !== null) mealChosen = true;
    byGuest.set(m.guestId, {
      answer,
      replyClosed: answer === "waiting" && !windowOpen(invitations.get(m.invitationId), input.now),
      isPlusOne: m.isPlusOne,
      meal:
        answer === "yes" && m.mealOptionId !== null
          ? (meals.get(m.mealOptionId)?.name ?? "Unknown meal")
          : null,
      // Declines lose their seat in the database; a stale row would still not be shown as a seat.
      seat:
        seat && answer !== "no"
          ? { tableLabel: seat.tableLabel, seatNumber: seat.seatNumber, tentative: seat.tentative }
          : null,
    });
  }
  return { byGuest, asksMeal: mealChosen || input.mealOptions.some((o) => o.active) };
}

export function answerOf(reply: GuestReply | undefined): ReplyAnswer {
  return reply?.answer ?? "not_invited";
}

export function needsMeal(reply: GuestReply | undefined): boolean {
  return reply?.answer === "yes" && reply.meal === null;
}

/** Attending without a confirmed seat; a tentative seat does not count (event_demand's needSeat). */
export function needsSeat(reply: GuestReply | undefined): boolean {
  return reply?.answer === "yes" && (reply.seat === null || reply.seat.tentative);
}

export function matchesReply(reply: GuestReply | undefined, filter: ReplyFilter | ""): boolean {
  switch (filter) {
    case "":
      return true;
    case "no_meal":
      return needsMeal(reply);
    case "not_seated":
      return needsSeat(reply);
    default:
      return answerOf(reply) === filter;
  }
}

export type ReplyTotals = Record<ReplyFilter, number>;

/** Counts over the given (non-archived) guests, one per filter. */
export function replyTotals(guestIds: readonly string[], replies: GuestReplies): ReplyTotals {
  const totals: ReplyTotals = {
    yes: 0,
    waiting: 0,
    no: 0,
    not_invited: 0,
    no_meal: 0,
    not_seated: 0,
  };
  for (const id of guestIds) {
    const r = replies.byGuest.get(id);
    for (const f of REPLY_FILTERS) if (matchesReply(r, f)) totals[f] += 1;
  }
  return totals;
}

/** "Table 3 · seat 4", "Table 3", or "Table 3 · tentative". */
export function describeSeat(seat: NonNullable<GuestReply["seat"]>): string {
  const parts = [seat.tableLabel];
  if (seat.seatNumber !== null) parts.push(`seat ${seat.seatNumber}`);
  if (seat.tentative) parts.push("tentative");
  return parts.join(" · ");
}
