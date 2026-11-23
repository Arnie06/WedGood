/**
 * Live count for comparisons (REL-04, ADR-031). Pure.
 *
 * A comparison's guest count is a saved scenario: it never changes by itself. When the comparison
 * was started from an event's planning number, we compare that saved count with the number the
 * replies give now and offer a repriced COPY if they have drifted. The original is never edited.
 */

/** A suggestion appears when the live number is at least this far from the saved one. */
export const REPRICE_THRESHOLD_PERCENT = 5;

/** The count the comparison can be repriced to, or null when the saved one is still close enough. */
export function repriceSuggestion(saved: number, live: number | null | undefined): number | null {
  if (live === null || live === undefined || !Number.isInteger(live) || live < 1) return null;
  if (!Number.isInteger(saved) || saved < 1 || live === saved) return null;
  return Math.abs(live - saved) * 100 >= saved * REPRICE_THRESHOLD_PERCENT ? live : null;
}

/** One event the setup form can start from. */
export type CountChoice = {
  eventId: string;
  eventName: string;
  /** The event's planning number now. Null when nobody has replied or been invited. */
  planningNumber: number | null;
};

/** Only a number we can price for (1 or more) can be used as a starting point. */
export function usableCount(planningNumber: number | null): planningNumber is number {
  return planningNumber !== null && Number.isInteger(planningNumber) && planningNumber >= 1;
}

/**
 * Should the comparison keep its link to the event? Only when the saved number is the event's
 * planning number as the server computes it now. A number the couple changed is their own.
 */
export function followsEvent(guestCount: number, livePlanningNumber: number | null): boolean {
  return usableCount(livePlanningNumber) && guestCount === livePlanningNumber;
}
