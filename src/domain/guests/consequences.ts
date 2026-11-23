/**
 * What a guest's latest answer change set in motion, per event (UX-05, wireframe W4). Pure.
 *
 * Three lists: what the app updated by itself, what now needs a person, and what a reply never
 * touches. Built only from what is stored: the latest `rsvp_changes` row, the event's current
 * counts (`event_demand`), the guest's seat now, the finalized seating copy, the locked caterer
 * count and the per-guest budget items that count the event. Nothing is stored for this panel.
 *
 * Honesty rules:
 *   - "Before" totals are not shown. Other replies may have moved the totals since, so a line says
 *     what this change did ("1 fewer") and what the total is now.
 *   - The planning number uses today's reply window for a waiting answer, as event_demand does.
 *   - A seat in the finalized copy is only named when the server could match it safely (the copy
 *     stores names, not ids); otherwise no seat line is shown.
 *   - Review lines only appear while the condition still holds now.
 */
import type { EventDemand, PlanningBasis } from "@/domain/events/demand";
import { guaranteeDrift } from "@/domain/events/guarantee";
import type { RsvpStatus } from "@/domain/guests/rsvp";
import type { SnapshotState } from "@/domain/seating/plan";

export type ConsequenceLink = "seating" | "event" | "attention" | "invitations";
export type ConsequenceLine = { id: string; text: string; link?: ConsequenceLink };
export type Consequences = {
  updated: ConsequenceLine[];
  review: ConsequenceLine[];
  unchanged: ConsequenceLine[];
};

export type ConsequenceInput = {
  change: {
    fromStatus: RsvpStatus;
    toStatus: RsvpStatus;
    fromMealId: string | null;
    toMealId: string | null;
    occurredAt: string;
  };
  /** The answer saved now; null when the guest is no longer invited to the event. */
  current: { status: RsvpStatus; mealOptionId: string | null } | null;
  /** Null when the caller cannot read the event's totals. */
  demand: EventDemand | null;
  /** Whether a waiting answer from this guest counts in the planning number today. */
  waitingCounts: boolean;
  /** The guest's seat in the live plan now. */
  seat: { tableLabel: string; seatNumber: number | null; tentative: boolean } | null;
  /** The guest's place in the finalized copy, only when it was matched safely. */
  frozenSeat: { tableLabel: string; seatNumber: number | null } | null;
  /** Null when the event has no seating plan. */
  layout: {
    snapshot: SnapshotState;
    finalizedRevision: number | null;
    finalizedAt: string | null;
    /** An open "seats released" Needs attention item exists for the event. */
    releasedOpen: boolean;
  } | null;
  /** The locked caterer count; `lockedOn` is already formatted for display. */
  guarantee: { count: number; lockedOn: string } | null;
  /** Active per-guest budget items that count this event. */
  budgetItems: readonly { name: string; source: "event_yes" | "event_plan" }[];
};

/** Mirrors `planningNumber`: whether one waiting answer counts today. */
export function waitingCounts(basis: PlanningBasis, replyWindowOpen: boolean): boolean {
  if (basis === "yes") return false;
  if (basis === "yes_waiting") return true;
  return replyWindowOpen;
}

const moved = (d: number) => `${Math.abs(d)} ${d > 0 ? "more" : "fewer"}`;
const guests = (n: number) => `${n} ${n === 1 ? "guest" : "guests"}`;
const place = (s: { tableLabel: string; seatNumber: number | null }) =>
  s.seatNumber !== null
    ? `Seat ${s.seatNumber} at ${s.tableLabel}`
    : `Their place at ${s.tableLabel}`;
const list = (names: string[]) =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

const UNCHANGED_ALWAYS: ConsequenceLine = {
  id: "commitments",
  text: "Signed bookings, contracts, invoices and payments. A reply never changes these.",
};

export function guestConsequences(input: ConsequenceInput): Consequences {
  const { change, current, demand, layout, seat } = input;
  const updated: ConsequenceLine[] = [];
  const review: ConsequenceLine[] = [];
  const unchanged: ConsequenceLine[] = [];

  if (!current) {
    review.push({
      id: "uninvited",
      text: "They are no longer invited to this event, so this answer no longer counts.",
      link: "invitations",
    });
    return { updated, review, unchanged: [UNCHANGED_ALWAYS] };
  }

  const finalizedBefore =
    layout?.finalizedAt != null && Date.parse(layout.finalizedAt) <= Date.parse(change.occurredAt);

  // Updated automatically: the change's own effect, with today's totals.
  const yes = (s: RsvpStatus) => (s === "accepted" ? 1 : 0);
  const counted = (s: RsvpStatus) =>
    s === "accepted" ? 1 : s === "pending" && input.waitingCounts ? 1 : 0;
  const attendingDelta = yes(change.toStatus) - yes(change.fromStatus);
  const planDelta = counted(change.toStatus) - counted(change.fromStatus);
  if (demand) {
    if (attendingDelta !== 0) {
      updated.push({
        id: "attending",
        text: `Attending: ${moved(attendingDelta)}, ${demand.yes} now.`,
      });
    }
    if (planDelta !== 0) {
      updated.push({
        id: "planning",
        text: `Planning number: ${moved(planDelta)}, ${demand.planningNumber} now.`,
      });
    }
    // Meals count only attending answers.
    const fromMeal = change.fromStatus === "accepted" ? change.fromMealId : null;
    const toMeal = change.toStatus === "accepted" ? change.toMealId : null;
    if (fromMeal !== toMeal) {
      const meal = (id: string) => demand.meals.find((m) => m.id === id);
      for (const [id, d] of [
        [fromMeal, -1],
        [toMeal, 1],
      ] as const) {
        if (!id) continue;
        const m = meal(id);
        updated.push({
          id: `meal-${id}`,
          text: `${m?.name ?? "A meal no longer offered"}: ${moved(d)}, ${m?.count ?? 0} now.`,
        });
      }
    }
    const without = (s: RsvpStatus, meal: string | null) => (s === "accepted" && !meal ? 1 : 0);
    const withoutDelta =
      without(change.toStatus, change.toMealId) - without(change.fromStatus, change.fromMealId);
    const offersMeals = demand.meals.length > 0;
    if (withoutDelta !== 0 && offersMeals) {
      updated.push({
        id: "without-meal",
        text: `Attending without a meal: ${moved(withoutDelta)}, ${demand.yesWithoutMeal} now.`,
      });
    }
    const budget = input.budgetItems
      .filter((b) => (b.source === "event_yes" ? attendingDelta !== 0 : planDelta !== 0))
      .map((b) => b.name);
    if (budget.length > 0) {
      updated.push({
        id: "budget",
        text: `Per-guest estimates that count this event follow the new number: ${list(budget)}.`,
      });
    }
  }

  // Seating, in the live plan.
  if (layout) {
    if (change.toStatus !== "accepted" && seat?.tentative) {
      updated.push({
        id: "seat",
        text: `${place(seat)} is held for them until they answer.`,
      });
    } else if (change.toStatus !== "accepted" && !seat && finalizedBefore && input.frozenSeat) {
      updated.push({
        id: "seat",
        text: `${place(input.frozenSeat)} in the finalized plan is free again in the live plan.`,
      });
    }
  }

  // Needs your review: only what still holds now.
  if (layout && layout.snapshot === "stale" && finalizedBefore) {
    review.push({
      id: "plan",
      text: `The finalized seating plan (version ${layout.finalizedRevision}) is out of date. Finalize it again before you print or share it.`,
      link: "seating",
    });
  }
  if (layout && layout.releasedOpen && change.toStatus !== "accepted" && finalizedBefore) {
    review.push({
      id: "attention",
      text: "Needs attention has an open “seats released” item for this event.",
      link: "attention",
    });
  }
  if (current.status === "accepted") {
    if (layout && (!seat || seat.tentative)) {
      review.push({
        id: "unseated",
        text: "They are attending but not seated yet.",
        link: "seating",
      });
    }
    if (!current.mealOptionId && demand && demand.meals.some((m) => m.active)) {
      review.push({
        id: "meal",
        text: "They are attending without a meal choice.",
        link: "invitations",
      });
    }
  }
  if (input.guarantee && demand) {
    const d = guaranteeDrift(input.guarantee.count, demand.yes);
    if (d.state === "under") {
      review.push({
        id: "caterer",
        text: `${guests(d.gap)} more attending than the caterer was told (${input.guarantee.count}). Consider revising the count.`,
        link: "event",
      });
    } else if (d.state === "over") {
      review.push({
        id: "caterer",
        text: `The caterer was told ${input.guarantee.count}; ${demand.yes} ${demand.yes === 1 ? "is" : "are"} attending now, ${d.gap} fewer. Check whether the count can still go down.`,
        link: "event",
      });
    }
  }

  // Not changed.
  if (input.guarantee) {
    unchanged.push({
      id: "guarantee",
      text: `The caterer count stays at ${input.guarantee.count}, locked ${input.guarantee.lockedOn}.`,
    });
  }
  if (layout && finalizedBefore && layout.finalizedRevision !== null) {
    unchanged.push({
      id: "snapshot",
      text: `Finalized seating version ${layout.finalizedRevision} is kept as it was.`,
    });
  }
  unchanged.push(UNCHANGED_ALWAYS);

  return { updated, review, unchanged };
}

/**
 * Finds the guest's place in a finalized copy by name. The copy stores names, not ids, so a match
 * only counts when the name belongs to exactly one guest in the wedding and appears exactly once in
 * the copy. Anything else returns null rather than risk naming another guest's seat.
 */
export function matchFrozenSeat(
  name: string,
  sameNameGuests: number,
  tables: readonly { label: string; guests: readonly { name: string; seat: number | null }[] }[],
): { tableLabel: string; seatNumber: number | null } | null {
  if (sameNameGuests !== 1) return null;
  const hits = tables.flatMap((t) =>
    t.guests
      .filter((g) => g.name === name)
      .map((g) => ({ tableLabel: t.label, seatNumber: g.seat })),
  );
  return hits.length === 1 ? hits[0]! : null;
}
