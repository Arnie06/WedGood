/**
 * Derived checklist views: grouping, progress and "next steps". Unknown stays
 * unknown: a task without a date is "unscheduled", never "due today".
 */
import { daysBetween, parseDateOnly, type DateOnly } from "@/domain/dates/date-only";

export type SummaryTask = {
  id: string;
  title: string;
  status: "open" | "done";
  dueDate: string | null;
  /** Position in the suggested template, used to order undated tasks. */
  order: number;
};

export type TaskBucket = "overdue" | "upcoming" | "unscheduled" | "done";

export function bucketFor(task: SummaryTask, today: DateOnly): TaskBucket {
  if (task.status === "done") return "done";
  if (task.dueDate === null) return "unscheduled";
  return daysBetween(today, parseDateOnly(task.dueDate)) < 0 ? "overdue" : "upcoming";
}

function byDueThenOrder(a: SummaryTask, b: SummaryTask): number {
  if (a.dueDate !== null && b.dueDate !== null && a.dueDate !== b.dueDate) {
    return a.dueDate < b.dueDate ? -1 : 1;
  }
  if (a.order !== b.order) return a.order - b.order;
  return a.title.localeCompare(b.title);
}

export type GroupedTasks = Record<TaskBucket, SummaryTask[]>;

export function groupTasks(tasks: readonly SummaryTask[], today: DateOnly): GroupedTasks {
  const groups: GroupedTasks = { overdue: [], upcoming: [], unscheduled: [], done: [] };
  for (const t of tasks) groups[bucketFor(t, today)].push(t);
  groups.overdue.sort(byDueThenOrder);
  groups.upcoming.sort(byDueThenOrder);
  groups.unscheduled.sort(byDueThenOrder);
  groups.done.sort(byDueThenOrder);
  return groups;
}

/** Overdue first, then soonest dated, then undated in suggested order. */
export function nextSteps(
  tasks: readonly SummaryTask[],
  today: DateOnly,
  limit = 3,
): SummaryTask[] {
  const g = groupTasks(tasks, today);
  return [...g.overdue, ...g.upcoming, ...g.unscheduled].slice(0, Math.max(0, limit));
}

export type Progress = { done: number; total: number };

export function progress(tasks: readonly SummaryTask[]): Progress {
  return { total: tasks.length, done: tasks.filter((t) => t.status === "done").length };
}
