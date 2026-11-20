import { summarizeCommitments, type CommitmentSummary } from "@/domain/budget/commitments";
import { daysBetween } from "@/domain/dates/date-only";
import { summarizeResponses, type ResponseSummary } from "@/domain/guests/rsvp";
import type { SampleTask, SampleWorkspace } from "./sample-workspace";

export type HomeSummary = {
  daysToGo: number;
  budget: CommitmentSummary & { targetMinor: number };
  primaryEvent: {
    name: string;
    responses: ResponseSummary;
    meals: ReadonlyArray<{ name: string; count: number }>;
  };
  tasks: { done: number; total: number; next: readonly SampleTask[] };
};

/** Every figure on the preview home screen is derived here from records. */
export function buildHomeSummary(workspace: SampleWorkspace): HomeSummary {
  const [primary] = workspace.events;
  if (!primary) throw new Error("Sample workspace needs at least one event");
  const responses = summarizeResponses(primary.responses);

  const openTasks = workspace.tasks
    .filter((task) => !task.done)
    .toSorted((a, b) => {
      if (a.dueDate === b.dueDate) return a.title.localeCompare(b.title);
      if (a.dueDate === null) return 1;
      if (b.dueDate === null) return -1;
      return a.dueDate < b.dueDate ? -1 : 1;
    });

  return {
    daysToGo: daysBetween(workspace.referenceDate, workspace.weddingDate),
    budget: {
      ...summarizeCommitments(workspace.commitments, workspace.payments),
      targetMinor: workspace.targetBudgetMinor,
    },
    primaryEvent: {
      name: primary.name,
      responses,
      meals: primary.mealOptions.map((option) => ({
        name: option.name,
        count: responses.mealCounts.get(option.id) ?? 0,
      })),
    },
    tasks: {
      done: workspace.tasks.filter((task) => task.done).length,
      total: workspace.tasks.length,
      next: openTasks.slice(0, 3),
    },
  };
}
