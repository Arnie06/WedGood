import {
  daysBetween,
  formatDateOnly,
  parseDateOnly,
  type DateOnly,
} from "@/domain/dates/date-only";

const SHORT: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };

export function shortDate(date: string): string {
  return formatDateOnly(parseDateOnly(date), "en-US", SHORT);
}

/** "Due Mar 3, 2027 · in 12 days", "Overdue since Mar 3, 2027", or "No date yet". Never guesses a date. */
export function dueLabel(dueDate: string | null, today: DateOnly, done = false): string {
  if (dueDate === null) return "No date yet";
  const text = shortDate(dueDate);
  if (done) return `Was due ${text}`;
  const days = daysBetween(today, parseDateOnly(dueDate));
  if (days < 0) return `Overdue since ${text}`;
  if (days === 0) return `Due today, ${text}`;
  if (days === 1) return `Due tomorrow, ${text}`;
  return `Due ${text}`;
}

/** True only for an open task with a date before today; undated tasks are never overdue. */
export function isOverdue(dueDate: string | null, today: DateOnly, done = false): boolean {
  return !done && dueDate !== null && daysBetween(today, parseDateOnly(dueDate)) < 0;
}
