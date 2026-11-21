import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { TaskForm } from "@/features/plan/task-form";
import { ArchiveTaskForm } from "@/features/plan/plan-actions";
import { updateTask } from "@/server/plan/actions";
import { loadAssigneeOptions, loadTask } from "@/server/plan/queries";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";

export const metadata: Metadata = { title: "Edit task" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function EditTaskPage({
  params,
}: {
  params: Promise<{ w: string; taskId: string }>;
}) {
  const { w, taskId } = await params;
  const access = await requireWorkspace(w);
  if (!UUID.test(taskId)) notFound();
  const base = `/app/${access.wedding.id}`;
  const canEdit = hasCapability(access, "plan.edit");
  const [task, assignees] = await Promise.all([
    loadTask(access.wedding.id, taskId),
    loadAssigneeOptions(access.wedding.id),
  ]);
  if (!task) notFound();
  const assigneeActive = assignees.some((a) => a.userId === task.assigneeUserId);

  return (
    <div className="max-w-xl space-y-6">
      <div className="space-y-2">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">Edit task</h1>
        {task.dateKind === "relative" && (
          <p className="text-body-md text-ink-muted">
            <Badge tone="neutral">Moves with your wedding date</Badge> Choosing a date of your own
            keeps this task there from now on.
          </p>
        )}
      </div>
      {canEdit ? (
        <TaskForm
          action={updateTask}
          assignees={assignees}
          submitLabel="Save changes"
          pendingLabel="Saving…"
          defaults={{
            title: task.title,
            notes: task.notes ?? "",
            dueDate: task.dueDate ?? "",
            assignee: assigneeActive ? (task.assigneeUserId ?? "") : "",
          }}
          hidden={{
            workspaceId: access.wedding.id,
            taskId: task.id,
            version: String(task.version),
          }}
        />
      ) : (
        <p className="text-body-md text-ink-muted">
          You can view this task. Ask the workspace owner to change it.
        </p>
      )}
      {canEdit && (
        <div className="space-y-2 border-t border-border-hairline pt-6">
          <ArchiveTaskForm
            workspaceId={access.wedding.id}
            taskId={task.id}
            version={task.version}
          />
        </div>
      )}
      <p>
        <Link
          href={`${base}/plan`}
          className="font-semibold text-action-emphasis underline underline-offset-4"
        >
          Back to the checklist
        </Link>
      </p>
    </div>
  );
}
