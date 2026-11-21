import type { ScheduledTask } from "@/domain/tasks/schedule";
import type { SummaryTask } from "@/domain/tasks/summary";
import type { TaskRecord } from "@/server/plan/queries";

export const toScheduled = (t: TaskRecord): ScheduledTask => ({
  id: t.id,
  title: t.title,
  status: t.status,
  dateKind: t.dateKind,
  offsetDays: t.offsetDays,
  dueDate: t.dueDate,
  version: t.version,
});

export const toSummary = (t: TaskRecord): SummaryTask => ({
  id: t.id,
  title: t.title,
  status: t.status,
  dueDate: t.dueDate,
  order: t.sortOrder,
});
