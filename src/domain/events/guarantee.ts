/**
 * Caterer count, the guarantee (ADR-031 D5, REL-08). Pure.
 *
 * A locked count is the number the couple told the caterer. Replies keep moving; the count does not
 * change unless someone revises it. This module only describes the gap between the two, in plain
 * words, and builds the "what I saw" payload the database checks before it locks.
 */
import type { EventDemand } from "@/domain/events/demand";

export type GuaranteeMeal = { id: string; name: string; active: boolean; count: number };

/** What the person looked at when they decided. The database refuses the lock if replies moved. */
export type GuaranteePreview = {
  yes: number;
  withoutMeal: number;
  meals: { id: string; count: number }[];
};

export function previewOf(
  demand: Pick<EventDemand, "yes" | "yesWithoutMeal" | "meals">,
): GuaranteePreview {
  return {
    yes: demand.yes,
    withoutMeal: demand.yesWithoutMeal,
    meals: demand.meals.map((m) => ({ id: m.id, count: m.count })),
  };
}

/** Same rule as `app_private.guarantee_snapshot`: totals and per-meal counts, order ignored. */
export function previewMatches(a: GuaranteePreview, b: GuaranteePreview): boolean {
  if (a.yes !== b.yes || a.withoutMeal !== b.withoutMeal) return false;
  if (a.meals.length !== b.meals.length) return false;
  const counts = new Map(b.meals.map((m) => [m.id, m.count]));
  if (counts.size !== b.meals.length) return false;
  return a.meals.every((m) => counts.get(m.id) === m.count);
}

export type DriftState = "match" | "over" | "under";

export type Drift = {
  state: DriftState;
  /** How many places the locked count is above or below the attending count. */
  gap: number;
  /** True when a person may need to act (more guests than the caterer has been told about). */
  advise: boolean;
};

const guests = (n: number) => `${n} ${n === 1 ? "guest" : "guests"}`;

/**
 * Locked count against the attending count. "Over" means the caterer was told more than are coming
 * now (usually fine, but money is committed). "Under" means more guests are coming than the caterer
 * has been told, which is when a revision is worth considering.
 */
export function guaranteeDrift(locked: number, yes: number): Drift {
  if (locked === yes) return { state: "match", gap: 0, advise: false };
  if (locked > yes) return { state: "over", gap: locked - yes, advise: false };
  return { state: "under", gap: yes - locked, advise: true };
}

/** "Locked 118 · now 96 attending · 22 more than are attending" in one calm line. */
export function driftSentence(locked: number, yes: number, waiting: number): string {
  const d = guaranteeDrift(locked, yes);
  const head = `Locked ${locked} · now ${yes} attending`;
  const wait = waiting > 0 ? ` (${waiting} still waiting)` : "";
  if (d.state === "match") return `${head}${wait}.`;
  if (d.state === "over") return `${head}${wait} · ${d.gap} more than are attending.`;
  return `${head}${wait} · ${d.gap} more attending than the caterer was told.`;
}

export function lockSentence(count: number): string {
  return `You're telling the caterer ${guests(count)}.`;
}

export type DueInfo = { state: "none" | "future" | "today" | "past"; days: number };

/** `days` is how many days until the date (negative once it has passed). */
export function dueInfo(dueOn: string | null, daysUntil: number | null): DueInfo {
  if (dueOn === null || daysUntil === null) return { state: "none", days: 0 };
  if (daysUntil === 0) return { state: "today", days: 0 };
  return { state: daysUntil > 0 ? "future" : "past", days: daysUntil };
}

export function dueSentence(info: DueInfo, formatted: string): string {
  switch (info.state) {
    case "none":
      return "No date set for sending it.";
    case "today":
      return `The caterer needs it today (${formatted}).`;
    case "future":
      return `The caterer needs it by ${formatted} (${info.days} ${info.days === 1 ? "day" : "days"} away).`;
    case "past":
      return `The caterer's date was ${formatted}.`;
  }
}

/** One row of history, newest first, for the Event page. */
export type GuaranteeVersion = {
  id: string;
  count: number;
  status: "locked" | "superseded";
  lockedAt: string;
  reason: string | null;
  supersedesId: string | null;
};

/** "Revised from 118 to 112: the venue lost a table." Only for rows that revised another. */
export function revisionSentence(
  row: GuaranteeVersion,
  byId: ReadonlyMap<string, GuaranteeVersion>,
): string | null {
  if (!row.supersedesId) return null;
  const before = byId.get(row.supersedesId);
  const from = before ? `from ${before.count} ` : "";
  return `Revised ${from}to ${row.count}: ${row.reason ?? "no reason recorded"}`;
}
