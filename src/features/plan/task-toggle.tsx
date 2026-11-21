"use client";

import { Circle, CircleCheck } from "lucide-react";
import { useActionState } from "react";
import { cn } from "@/lib/cn";
import { setTaskStatus, type PlanActionState } from "@/server/plan/actions";

/** One-tap complete/reopen. Disabled for read-only members; shows a stale-version error inline. */
export function TaskToggle({
  workspaceId,
  taskId,
  version,
  title,
  done,
  disabled,
}: {
  workspaceId: string;
  taskId: string;
  version: number;
  title: string;
  done: boolean;
  disabled: boolean;
}) {
  const [state, action, pending] = useActionState(setTaskStatus, {
    status: "idle",
  } as PlanActionState);
  const Icon = done ? CircleCheck : Circle;
  return (
    <form action={action} className="shrink-0">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="version" value={version} />
      <input type="hidden" name="done" value={done ? "false" : "true"} />
      <button
        type="submit"
        disabled={disabled || pending}
        aria-label={done ? `Reopen "${title}"` : `Mark "${title}" done`}
        className={cn(
          "inline-flex size-11 items-center justify-center rounded-full disabled:cursor-not-allowed disabled:opacity-55",
          done ? "text-action-secondary" : "text-ink-muted enabled:hover:text-action-secondary",
        )}
      >
        <Icon aria-hidden="true" className="size-7" />
      </button>
      {state.status === "error" && (
        <p role="alert" className="sr-only">
          {state.message}
        </p>
      )}
    </form>
  );
}
