/**
 * Event demand: one headcount per event (ADR-031 D2/D3, docs/07 "Invitations and guests"). Pure.
 *
 * The database (`event_demand`) returns raw counts for the same population seating uses: active
 * responses of guests who are not archived. This module turns them into the planning number every
 * page shows, so a count is never computed twice with slightly different rules.
 */

export const PLANNING_BASES = ["auto", "yes", "yes_waiting"] as const;
export type PlanningBasis = (typeof PLANNING_BASES)[number];

export function isPlanningBasis(value: unknown): value is PlanningBasis {
  return typeof value === "string" && (PLANNING_BASES as readonly string[]).includes(value);
}

export const PLANNING_BASIS_LABELS: Record<PlanningBasis, string> = {
  auto: "Attending, plus those still deciding until the reply date",
  yes: "Attending only",
  yes_waiting: "Attending plus everyone still waiting",
};

export type MealCount = { id: string; name: string; active: boolean; count: number };

/** Raw counts for one event, as the database returns them. */
export type EventCounts = {
  eventId: string;
  /** Active responses (named guests, plus-ones included). */
  invited: number;
  yes: number;
  /** Waiting, and the reply window is still open (link live, reply date not passed). */
  waitingOpen: number;
  /** Waiting, but the reply date or link expiry has passed. */
  waitingClosed: number;
  no: number;
  /** Plus-one places allowed but not named yet. Never part of `yes`. */
  openPlusOnes: number;
  seatedConfirmed: number;
  seatedTentative: number;
  yesWithoutMeal: number;
  meals: readonly MealCount[];
};

export type PlanningSettings = { basis: PlanningBasis; includeOpenPlusOnes: boolean };

export type EventDemand = EventCounts & {
  /** Waiting in total (open and closed), for the plain "waiting" figure. */
  waiting: number;
  /** The number to plan for: seats, catering estimates and per-guest costs. */
  planningNumber: number;
  /** Which waiting guests the number includes, after the deadline rule. */
  waitingCounted: number;
  openPlusOnesCounted: number;
  basis: PlanningBasis;
  includeOpenPlusOnes: boolean;
  /** Attending guests without a saved seat (confirmed seats only). */
  needSeat: number;
};

export function planningNumber(
  counts: Pick<EventCounts, "yes" | "waitingOpen" | "waitingClosed" | "openPlusOnes">,
  settings: PlanningSettings,
): { total: number; waitingCounted: number; openPlusOnesCounted: number } {
  let waitingCounted = 0;
  if (settings.basis === "auto") waitingCounted = counts.waitingOpen;
  else if (settings.basis === "yes_waiting")
    waitingCounted = counts.waitingOpen + counts.waitingClosed;
  const openPlusOnesCounted = settings.includeOpenPlusOnes ? counts.openPlusOnes : 0;
  return {
    total: counts.yes + waitingCounted + openPlusOnesCounted,
    waitingCounted,
    openPlusOnesCounted,
  };
}

export function buildDemand(counts: EventCounts, settings: PlanningSettings): EventDemand {
  const plan = planningNumber(counts, settings);
  return {
    ...counts,
    waiting: counts.waitingOpen + counts.waitingClosed,
    planningNumber: plan.total,
    waitingCounted: plan.waitingCounted,
    openPlusOnesCounted: plan.openPlusOnesCounted,
    basis: settings.basis,
    includeOpenPlusOnes: settings.includeOpenPlusOnes,
    needSeat: Math.max(counts.yes - counts.seatedConfirmed, 0),
  };
}

const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;
const places = (n: number) => `${n} plus-one ${n === 1 ? "place" : "places"} not named yet`;

/** Plain-words arithmetic behind the planning number, for the "how we count" text. */
export function describePlanningNumber(demand: EventDemand): string {
  const parts = [`${demand.yes} attending`];
  if (demand.basis !== "yes") {
    if (demand.waitingCounted > 0) {
      parts.push(`${demand.waitingCounted} still waiting`);
    }
  }
  if (demand.openPlusOnesCounted > 0) {
    parts.push(places(demand.openPlusOnesCounted));
  }
  const excluded: string[] = [];
  const waitingLeft = demand.waiting - demand.waitingCounted;
  if (waitingLeft > 0) {
    excluded.push(
      demand.basis === "yes"
        ? `${waitingLeft} still waiting`
        : `${waitingLeft} who did not answer by the reply date`,
    );
  }
  if (!demand.includeOpenPlusOnes && demand.openPlusOnes > 0) {
    excluded.push(places(demand.openPlusOnes));
  }
  const sum = parts.length === 1 ? parts[0] : parts.join(" + ");
  const tail = excluded.length > 0 ? `, not counting ${excluded.join(" or ")}` : "";
  return `Planning for ${people(demand.planningNumber)}: ${sum}${tail}.`;
}

export const HOW_WE_COUNT: readonly { term: string; meaning: string }[] = [
  {
    term: "Invited",
    meaning: "People with an active invitation to this event, plus-ones included.",
  },
  { term: "Attending", meaning: "Guests who answered yes." },
  { term: "Waiting", meaning: "Invited guests who have not answered yet." },
  { term: "Not attending", meaning: "Guests who answered no." },
  {
    term: "Plus-ones not named",
    meaning:
      "Plus-one places an invitation allows that nobody has used yet. Shown on their own, and only added to the planning number if you choose.",
  },
  {
    term: "Planning number",
    meaning:
      "The number to plan seats, food and per-guest costs around. By default it is attending plus those still deciding until the reply date, then attending only.",
  },
  { term: "Seated", meaning: "Attending guests with a seat at a table in the seating plan." },
];
