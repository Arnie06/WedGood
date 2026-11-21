"use client";

import { useTrayActionState } from "@/components/ui/tray";
import { Button } from "@/components/ui/button";
import {
  applyReschedule,
  archiveTask,
  generateChecklist,
  type PlanActionState,
} from "@/server/plan/actions";

const idle: PlanActionState = { status: "idle" };

function Status({ state }: { state: PlanActionState }) {
  return (
    <div aria-live="polite" className="min-h-6">
      {state.status === "error" && (
        <p role="alert" className="text-body-md text-danger">
          {state.message}
        </p>
      )}
      {state.status === "ok" && (
        <p className="text-body-md text-action-secondary">{state.message}</p>
      )}
    </div>
  );
}

export function GenerateChecklistForm({
  workspaceId,
  label,
}: {
  workspaceId: string;
  label: string;
}) {
  const [state, action, pending] = useTrayActionState(generateChecklist, idle);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Adding…" : label}
      </Button>
      <Status state={state} />
    </form>
  );
}

export function ArchiveTaskForm({
  workspaceId,
  taskId,
  version,
}: {
  workspaceId: string;
  taskId: string;
  version: number;
}) {
  const [state, action, pending] = useTrayActionState(archiveTask, idle);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="version" value={version} />
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Removing…" : "Remove this task"}
      </Button>
      <Status state={state} />
    </form>
  );
}

export function ApplyRescheduleForm({
  workspaceId,
  moves,
}: {
  workspaceId: string;
  moves: readonly { id: string; version: number }[];
}) {
  const [state, action, pending] = useTrayActionState(applyReschedule, idle);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      {moves.map((m) => (
        <input key={m.id} type="hidden" name="move" value={`${m.id}:${m.version}`} />
      ))}
      <Button type="submit" variant="primary" disabled={pending || moves.length === 0}>
        {pending ? "Updating…" : `Update ${moves.length} ${moves.length === 1 ? "date" : "dates"}`}
      </Button>
      <Status state={state} />
    </form>
  );
}
