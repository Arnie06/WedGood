/**
 * What a planner's "Change an answer" would touch, before it is saved (UX-02). Pure.
 *
 * Mirrors the rules the database applies in `app_private.apply_member_response` and
 * `app_private.seating_on_member_change`: a meal only stays with an attending answer; attending
 * confirms a held seat; waiting keeps a seat as held only when the plan allows held seats; anything
 * else releases the seat. Every applied change bumps the plan's revision, so a finalized plan that
 * was current becomes out of date. The caterer's locked count never changes here.
 */
import { guaranteeDrift } from "@/domain/events/guarantee";
import type { RsvpStatus } from "@/domain/guests/rsvp";
import type { SnapshotState } from "@/domain/seating/plan";

export type OverrideAnswer = { status: RsvpStatus; mealOptionId: string | null };

export type OverrideImpactItem = { id: string; tone: "warning" | "info"; text: string };

export type OverrideImpactInput = {
  from: OverrideAnswer;
  /** As chosen in the form. A meal on a non-attending answer is dropped, as the database does. */
  to: OverrideAnswer;
  /** Attending totals for the event now (event_demand). */
  yes: number;
  yesWithoutMeal: number;
  /** Meal tallies for the event now, inactive meals included. */
  meals: readonly { id: string; name: string; active: boolean; count: number }[];
  /** The guest's seat in this event's plan, if any. */
  seat: { tableLabel: string; seatNumber: number | null; tentative: boolean } | null;
  /** Null when the event has no seating plan yet. */
  layout: { allowTentative: boolean; snapshot: SnapshotState } | null;
  /** The caterer count currently locked for the event, or null. */
  lockedCount: number | null;
};

export type OverrideImpact = {
  /** False when the chosen answer is what is saved now; saving would record nothing. */
  changed: boolean;
  /** The answer that would actually be saved. */
  to: OverrideAnswer;
  items: OverrideImpactItem[];
};

/** The answer the database would store for this choice. */
export function effectiveAnswer(a: OverrideAnswer): OverrideAnswer {
  return { status: a.status, mealOptionId: a.status === "accepted" ? a.mealOptionId : null };
}

const place = (seat: NonNullable<OverrideImpactInput["seat"]>) =>
  seat.seatNumber !== null
    ? `seat ${seat.seatNumber} at ${seat.tableLabel}`
    : `their place at ${seat.tableLabel}`;

const guests = (n: number) => `${n} ${n === 1 ? "guest" : "guests"}`;

function catererPhrase(locked: number, yes: number): string {
  const d = guaranteeDrift(locked, yes);
  if (d.state === "match") return "the same as the caterer was told";
  if (d.state === "over") return `${guests(d.gap)} fewer than the caterer was told`;
  return `${guests(d.gap)} more than the caterer was told`;
}

export function overrideImpact(input: OverrideImpactInput): OverrideImpact {
  const from = effectiveAnswer(input.from);
  const to = effectiveAnswer(input.to);
  const changed = from.status !== to.status || from.mealOptionId !== to.mealOptionId;
  if (!changed) return { changed, to, items: [] };

  const items: OverrideImpactItem[] = [];
  const wasYes = from.status === "accepted";
  const nowYes = to.status === "accepted";
  const { seat, layout } = input;

  // Seating, by the same branches as seating_on_member_change.
  let released = false;
  if (seat) {
    const keepsHeld = to.status === "pending" && layout?.allowTentative === true;
    if (to.status === "declined" || (to.status === "pending" && !keepsHeld)) {
      released = true;
      items.push({
        id: "seat",
        tone: "warning",
        text: seat.tentative
          ? `Releases the seat held for them (${place(seat)}).`
          : `Releases ${place(seat)}.`,
      });
    } else if (keepsHeld && !seat.tentative) {
      items.push({
        id: "seat",
        tone: "info",
        text: `Keeps ${place(seat)} for them, held until they answer.`,
      });
    } else if (nowYes && seat.tentative) {
      items.push({
        id: "seat",
        tone: "info",
        text: `Confirms the seat held for them (${place(seat)}).`,
      });
    }
  } else if (layout && nowYes && !wasYes) {
    items.push({
      id: "seat",
      tone: "info",
      text: "Adds them to the guests still to seat. They are not given a seat.",
    });
  }

  if (layout?.snapshot === "current") {
    items.push({
      id: "plan",
      tone: "warning",
      text: "The finalized seating plan becomes out of date. Finalize it again before you print or share it.",
    });
  }
  if (released && layout && layout.snapshot !== "none") {
    items.push({
      id: "attention",
      tone: "info",
      text: "Adds a “seats released” item to Needs attention.",
    });
  }

  const delta = (nowYes ? 1 : 0) - (wasYes ? 1 : 0);
  if (delta !== 0) {
    items.push({
      id: "attending",
      tone: "info",
      text: `Attending goes from ${input.yes} to ${input.yes + delta}.`,
    });
    if (input.lockedCount !== null) {
      const after = input.yes + delta;
      items.push({
        id: "caterer",
        tone: guaranteeDrift(input.lockedCount, after).advise ? "warning" : "info",
        text: `The caterer count stays locked at ${input.lockedCount}. Attending would be ${catererPhrase(input.lockedCount, after)} (now ${catererPhrase(input.lockedCount, input.yes)}).`,
      });
    }
  }

  // Meal tallies. Only attending answers count toward a meal or toward "without a meal".
  const offersMeals = input.meals.some((m) => m.active) || from.mealOptionId !== null;
  if (offersMeals) {
    const name = (id: string) => input.meals.find((m) => m.id === id)?.name ?? "A meal";
    const count = (id: string) => input.meals.find((m) => m.id === id)?.count ?? 0;
    const parts: string[] = [];
    if (from.mealOptionId !== to.mealOptionId) {
      if (from.mealOptionId) {
        const c = count(from.mealOptionId);
        parts.push(`${name(from.mealOptionId)} ${c} → ${Math.max(c - 1, 0)}`);
      }
      if (to.mealOptionId) {
        const c = count(to.mealOptionId);
        parts.push(`${name(to.mealOptionId)} ${c} → ${c + 1}`);
      }
    }
    if (parts.length > 0) {
      items.push({ id: "meals", tone: "info", text: `Meal counts: ${parts.join(" · ")}.` });
    }
    const without = (a: OverrideAnswer) => (a.status === "accepted" && !a.mealOptionId ? 1 : 0);
    const mealDelta = without(to) - without(from);
    if (mealDelta !== 0) {
      items.push({
        id: "without-meal",
        tone: mealDelta > 0 ? "warning" : "info",
        text: `Attending without a meal goes from ${input.yesWithoutMeal} to ${Math.max(input.yesWithoutMeal + mealDelta, 0)}.`,
      });
    }
  }

  return { changed, to, items };
}
