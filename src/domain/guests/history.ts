/**
 * Pure wording for a guest's reply history (REL-05). The database writes one row for every real
 * change of an answer or a meal; this turns a row into the line the page shows. No dates are
 * formatted here so the module stays free of time zone and locale choices.
 */

export type ReplyStatus = "pending" | "accepted" | "declined";
export type ReplyChange = {
  id: string;
  eventId: string;
  fromStatus: ReplyStatus;
  toStatus: ReplyStatus;
  /** Meal names as they were then and now; null when none was chosen. */
  fromMeal: string | null;
  toMeal: string | null;
  source: "guest" | "couple";
  reason: string | null;
  occurredAt: string;
};

const STATUS_LABEL: Record<ReplyStatus, string> = {
  pending: "No answer",
  accepted: "Attending",
  declined: "Not attending",
};

export const replyStatusLabel = (s: ReplyStatus): string => STATUS_LABEL[s];

/** "Attending → Not attending", or "Meal: Fish → Beef" when only the meal moved. */
export function describeReplyChange(c: ReplyChange): string {
  if (c.fromStatus === c.toStatus) {
    return `Meal: ${c.fromMeal ?? "none"} → ${c.toMeal ?? "none"}`;
  }
  const meal = c.toStatus === "accepted" && c.toMeal ? ` (${c.toMeal})` : "";
  return `${STATUS_LABEL[c.fromStatus]} → ${STATUS_LABEL[c.toStatus]}${meal}`;
}

/** Who made the change, in words that are true for every wedding (no names are stored on the row). */
export function describeReplySource(c: Pick<ReplyChange, "source" | "reason">): string {
  if (c.source === "guest") return "From the guest's own link";
  return c.reason
    ? `Entered by you or your partner: ${c.reason}`
    : "Entered by you or your partner";
}

/** Newest first within each event; events in order of their most recent change. */
export function groupReplyChanges<T extends { eventId: string; occurredAt: string }>(
  changes: T[],
): { eventId: string; changes: T[] }[] {
  const sorted = [...changes].sort((a, b) =>
    a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0,
  );
  const groups = new Map<string, T[]>();
  for (const c of sorted) {
    const list = groups.get(c.eventId);
    if (list) list.push(c);
    else groups.set(c.eventId, [c]);
  }
  return [...groups.entries()].map(([eventId, list]) => ({ eventId, changes: list }));
}
