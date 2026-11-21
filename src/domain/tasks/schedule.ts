/**
 * Task scheduling rules (docs/07-DOMAIN-RULES.md "Tasks, dates and timeline").
 * `relative` tasks follow the wedding date through a day offset; `fixed` tasks
 * (manual tasks, or relative tasks whose date a person edited) never move
 * unless a person edits them. Pure and framework-free.
 */
import { addDays, parseDateOnly, type DateOnly } from "@/domain/dates/date-only";

export type DateKind = "fixed" | "relative";

export type ScheduledTask = {
  id: string;
  title: string;
  status: "open" | "done";
  dateKind: DateKind;
  /** Signed days from the wedding date; present for relative tasks. */
  offsetDays: number | null;
  dueDate: string | null;
  version: number;
};

/** Due date a relative task should have for a wedding date; null when unscheduled. */
export function relativeDueDate(weddingDate: string | null, offsetDays: number): DateOnly | null {
  if (weddingDate === null) return null;
  return addDays(parseDateOnly(weddingDate), offsetDays);
}

export type ReschedulePreview = {
  /** Open relative tasks whose stored date differs from the wedding-date rule. */
  moves: { task: ScheduledTask; from: string | null; to: string | null }[];
  /** Tasks the change will not touch, with the reason. */
  unchanged: { fixed: number; completed: number; alreadyCurrent: number };
};

/**
 * What would change if flexible tasks followed the current wedding date. Fixed
 * and completed tasks are never moved. Nothing is applied here; a person
 * reviews the moves first.
 */
export function previewReschedule(
  weddingDate: string | null,
  tasks: readonly ScheduledTask[],
): ReschedulePreview {
  const moves: ReschedulePreview["moves"] = [];
  const unchanged = { fixed: 0, completed: 0, alreadyCurrent: 0 };
  for (const task of tasks) {
    if (task.dateKind === "fixed") {
      unchanged.fixed += 1;
      continue;
    }
    if (task.status === "done") {
      unchanged.completed += 1;
      continue;
    }
    const target = task.offsetDays === null ? null : relativeDueDate(weddingDate, task.offsetDays);
    if (task.offsetDays === null || target === task.dueDate) {
      unchanged.alreadyCurrent += 1;
      continue;
    }
    moves.push({ task, from: task.dueDate, to: target });
  }
  return { moves, unchanged };
}
