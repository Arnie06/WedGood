import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import { CalendarX } from "lucide-react";
import Link from "next/link";
import { Card, CardTitle } from "@/components/ui/card";
import { ProgressBar } from "@/components/ui/progress-bar";
import { SheetButton } from "@/components/ui/sheet";
import { todayInZone } from "@/domain/dates/date-only";
import { previewReschedule } from "@/domain/tasks/schedule";
import { groupTasks, progress } from "@/domain/tasks/summary";
import { cn } from "@/lib/cn";
import { GenerateChecklistForm } from "@/features/plan/plan-actions";
import { dueLabel, isOverdue } from "@/features/plan/format";
import { toScheduled, toSummary } from "@/features/plan/mappers";
import { TaskForm } from "@/features/plan/task-form";
import { TaskToggle } from "@/features/plan/task-toggle";
import { createTask } from "@/server/plan/actions";
import { loadAssigneeOptions, loadTasks, type TaskRecord } from "@/server/plan/queries";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadWeddingSettings } from "@/server/workspace/queries";

export const metadata: Metadata = { title: "Checklist" };

const link = "font-semibold text-action-emphasis underline underline-offset-4";

export default async function PlanPage({ params }: { params: Promise<{ w: string }> }) {
  const access = await requireWorkspace((await params).w);
  const base = `/app/${access.wedding.id}`;
  const canEdit = hasCapability(access, "plan.edit");
  const [settings, tasks, assignees] = await Promise.all([
    loadWeddingSettings(access.wedding.id),
    loadTasks(access.wedding.id),
    loadAssigneeOptions(access.wedding.id),
  ]);
  const today = todayInZone(settings.timezone);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const names = new Map(assignees.map((a) => [a.userId, a.label]));
  const groups = groupTasks(tasks.map(toSummary), today);
  const { done, total } = progress(tasks.map(toSummary));
  const drift = previewReschedule(settings.date, tasks.map(toScheduled)).moves.length;
  const hasTemplate = tasks.some((t) => t.templateKey !== null);

  const sections: { key: "overdue" | "upcoming" | "unscheduled"; title: string; empty?: string }[] =
    [
      { key: "overdue", title: "Needs attention" },
      { key: "upcoming", title: "Coming up" },
      { key: "unscheduled", title: "No date yet" },
    ];

  return (
    <div className="max-w-3xl space-y-8">
      <header className="space-y-2">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">Checklist</h1>
        <p className="text-body-lg text-ink-muted">
          {settings.date
            ? "Suggested tasks follow your wedding date. Change a task's date and it stays where you put it."
            : "Set your wedding date and suggested tasks get dates too. Until then they simply have no date."}
        </p>
      </header>

      <p>
        <Link href={`${base}/plan/budget`} className={link}>
          Open your budget
        </Link>
        {" · "}
        <Link href={`${base}/plan/documents`} className={link}>
          Documents
        </Link>
        {" · "}
        <Link href={`${base}/plan/packages`} className={link}>
          Packages
        </Link>
        {" · "}
        <Link href={`${base}/plan/day-of`} className={link}>
          Wedding day
        </Link>
        {" · "}
        <Link href={`${base}/design`} className={link}>
          Design
        </Link>
      </p>

      {drift > 0 && (
        <Card className="border-border-control">
          <CardTitle>Your wedding date changed</CardTitle>
          <p className="mt-2 text-body-md text-ink-muted">
            {drift} flexible {drift === 1 ? "task doesn't" : "tasks don't"} match it yet. Nothing
            moves until you review the changes.
          </p>
          <p className="mt-3">
            <Link href={`${base}/plan/review-dates`} className={link}>
              Review the new dates
            </Link>
          </p>
        </Card>
      )}

      {total > 0 && (
        <ProgressBar
          label="Checklist progress"
          value={done}
          max={total}
          valueText={`${done} of ${total} done`}
        />
      )}

      {canEdit && (
        <div>
          <SheetButton
            label="Add a task"
            title="Add a task"
            description="Leave the date blank if you're not sure yet."
          >
            <TaskForm
              action={createTask}
              rotateKey
              compact
              autoFocusTitle
              assignees={assignees}
              submitLabel="Add task"
              pendingLabel="Adding…"
              defaults={{ title: "", notes: "", dueDate: "", assignee: "" }}
              hidden={{ workspaceId: access.wedding.id, idempotencyKey: randomUUID() }}
            />
          </SheetButton>
        </div>
      )}

      {total === 0 ? (
        <Card>
          <CardTitle>Start with a suggested checklist</CardTitle>
          <p className="mt-2 text-body-md text-ink-muted">
            A planning checklist from about a year out to the week of the wedding. You can edit,
            reschedule or remove anything.
          </p>
          <div className="mt-4">
            {canEdit ? (
              <GenerateChecklistForm
                workspaceId={access.wedding.id}
                label="Add the suggested checklist"
              />
            ) : (
              <p className="text-body-md text-ink-muted">
                You can view the checklist. Ask the workspace owner to add tasks.
              </p>
            )}
          </div>
        </Card>
      ) : (
        <>
          {sections.map(({ key, title }) =>
            groups[key].length === 0 ? null : (
              <section key={key} aria-labelledby={`h-${key}`} className="space-y-3">
                <h2 id={`h-${key}`} className="font-serif text-headline-sm">
                  {title}{" "}
                  <span className="text-body-md text-ink-muted">({groups[key].length})</span>
                </h2>
                {(() => {
                  const list = groups[key];
                  // Overdue always shows in full; long groups show the first few and fold the rest.
                  const head = key === "overdue" ? list : list.slice(0, VISIBLE_PER_GROUP);
                  const rest = key === "overdue" ? [] : list.slice(VISIBLE_PER_GROUP);
                  const items = (rows: typeof list) =>
                    rows.map((s) => (
                      <TaskItem
                        key={s.id}
                        task={byId.get(s.id)!}
                        base={base}
                        workspaceId={access.wedding.id}
                        today={today}
                        assignee={names}
                        canEdit={canEdit}
                      />
                    ));
                  return (
                    <>
                      <ul className="space-y-3">{items(head)}</ul>
                      {rest.length > 0 && (
                        <details className="group">
                          <summary className="flex min-h-11 cursor-pointer items-center text-label-lg font-semibold text-action-emphasis underline underline-offset-4">
                            <span className="group-open:hidden">Show {rest.length} more</span>
                            <span className="hidden group-open:inline">Show fewer</span>
                          </summary>
                          <ul className="mt-3 space-y-3">{items(rest)}</ul>
                        </details>
                      )}
                    </>
                  );
                })()}
              </section>
            ),
          )}
          {groups.done.length > 0 && (
            <details className="space-y-3">
              <summary className="min-h-11 cursor-pointer py-2 font-serif text-headline-sm">
                Done ({groups.done.length})
              </summary>
              <ul className="mt-3 space-y-3">
                {groups.done.map((s) => (
                  <TaskItem
                    key={s.id}
                    task={byId.get(s.id)!}
                    base={base}
                    workspaceId={access.wedding.id}
                    today={today}
                    assignee={names}
                    canEdit={canEdit}
                  />
                ))}
              </ul>
            </details>
          )}
          {canEdit && hasTemplate && (
            <div className="space-y-2 border-t border-border-hairline pt-6">
              <p className="text-body-md text-ink-muted">
                Missing a suggested task? This adds only the ones you don&apos;t already have, and
                never brings back one you removed.
              </p>
              <GenerateChecklistForm
                workspaceId={access.wedding.id}
                label="Add any missing suggestions"
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

const VISIBLE_PER_GROUP = 5;

function TaskItem({
  task,
  base,
  workspaceId,
  today,
  assignee,
  canEdit,
}: {
  task: TaskRecord;
  base: string;
  workspaceId: string;
  today: ReturnType<typeof todayInZone>;
  assignee: Map<string, string>;
  canEdit: boolean;
}) {
  const done = task.status === "done";
  const overdue = isOverdue(task.dueDate, today, done);
  const who = task.assigneeUserId ? assignee.get(task.assigneeUserId) : undefined;
  return (
    <Card
      as="li"
      id={`task-${task.id}`}
      className={cn("flex items-start gap-3 p-4 sm:p-4", overdue && "border-l-4 border-l-danger")}
    >
      <TaskToggle
        workspaceId={workspaceId}
        taskId={task.id}
        version={task.version}
        title={task.title}
        done={done}
        disabled={!canEdit}
      />
      <div className="min-w-0 flex-1 space-y-1">
        <p className={done ? "text-body-lg text-ink-muted line-through" : "text-body-lg"}>
          {canEdit ? (
            <Link
              href={`${base}/plan/tasks/${task.id}`}
              className="underline-offset-4 hover:underline"
            >
              {task.title}
            </Link>
          ) : (
            task.title
          )}
        </p>
        <p
          className={
            overdue
              ? "flex items-center gap-1.5 text-body-sm font-semibold text-danger"
              : "text-body-sm text-ink-muted"
          }
        >
          {overdue && <CalendarX aria-hidden="true" className="size-4 shrink-0" />}
          <span>
            {dueLabel(task.dueDate, today, done)}
            {who ? ` · ${who}` : ""}
          </span>
        </p>
        {task.dateKind !== "relative" && task.dueDate && !done && (
          <p className="text-body-sm text-ink-muted">Date set by you, so it won&apos;t move.</p>
        )}
      </div>
    </Card>
  );
}
