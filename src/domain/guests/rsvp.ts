/** Event-specific RSVP counts (docs/07-DOMAIN-RULES.md "Invitations and guests"). */

export type RsvpStatus = "pending" | "accepted" | "declined";

export type EventResponse = {
  guestId: string;
  eligible: boolean;
  rsvpStatus: RsvpStatus;
  mealOptionId: string | null;
};

export type ResponseSummary = {
  invited: number;
  accepted: number;
  pending: number;
  declined: number;
  /** Meal selections of accepted guests only; declines never count. */
  mealCounts: ReadonlyMap<string, number>;
  acceptedWithoutMeal: number;
};

export function summarizeResponses(responses: readonly EventResponse[]): ResponseSummary {
  const seen = new Set<string>();
  const mealCounts = new Map<string, number>();
  const summary = { invited: 0, accepted: 0, pending: 0, declined: 0, acceptedWithoutMeal: 0 };

  for (const response of responses) {
    if (!response.eligible) continue;
    if (seen.has(response.guestId)) {
      throw new Error(`Guest ${response.guestId} has more than one response for this event`);
    }
    seen.add(response.guestId);
    summary.invited += 1;
    summary[response.rsvpStatus] += 1;
    if (response.rsvpStatus !== "accepted") continue;
    if (response.mealOptionId === null) {
      summary.acceptedWithoutMeal += 1;
    } else {
      mealCounts.set(response.mealOptionId, (mealCounts.get(response.mealOptionId) ?? 0) + 1);
    }
  }

  return { ...summary, mealCounts };
}
