"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextAreaField } from "@/components/ui/text-area-field";
import { TextField } from "@/components/ui/text-field";
import { useSheetClose } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import { revealElement } from "@/lib/reveal";
import { undoTaskCreation, type PlanActionState } from "@/server/plan/actions";

export type TaskFormDefaults = { title: string; notes: string; dueDate: string; assignee: string };

type Action = (state: PlanActionState, form: FormData) => Promise<PlanActionState>;

/** Create (quick add) and edit share one form; edits carry the task id and last-seen version. */
export function TaskForm({
  action,
  defaults,
  hidden,
  assignees,
  submitLabel,
  pendingLabel,
  rotateKey = false,
  compact = false,
  autoFocusTitle = false,
}: {
  action: Action;
  defaults: TaskFormDefaults;
  hidden: Record<string, string>;
  assignees: readonly { userId: string; label: string }[];
  submitLabel: string;
  pendingLabel: string;
  /** Creation: a fresh idempotency key after each success so the next task isn't a replay. */
  rotateKey?: boolean;
  compact?: boolean;
  /** Focus the title when the form appears (inside a sheet). */
  autoFocusTitle?: boolean;
}) {
  // Each successful create gets a fresh idempotency key (base key + count), so the next
  // task isn't mistaken for a replay while a retry after an error still is one.
  const [created, setCreated] = useState(0);
  const { toast } = useToast();
  const closeSheet = useSheetClose();
  const [state, formAction, pending] = useActionState(
    async (prev: PlanActionState, form: FormData) => {
      const next = await action(prev, form);
      if (rotateKey && next.status === "ok") {
        setCreated((n) => n + 1);
        closeSheet();
        const { taskId } = next;
        const workspaceId = hidden.workspaceId;
        toast({
          message: next.message,
          ...(taskId && workspaceId
            ? {
                action: {
                  label: "Undo",
                  run: async () => {
                    const undo = new FormData();
                    undo.set("workspaceId", workspaceId);
                    undo.set("taskId", taskId);
                    undo.set("version", "1");
                    const result = await undoTaskCreation({ status: "idle" }, undo);
                    return result.status === "error" ? { error: result.message } : undefined;
                  },
                },
              }
            : {}),
        });
        if (taskId) revealElement(`task-${taskId}`);
      }
      return next;
    },
    { status: "idle" } as PlanActionState,
  );
  const key = `${hidden.idempotencyKey ?? ""}-${created}`;

  const echoed = state.status === "error" ? state.values : undefined;
  const errors = state.status === "error" ? state.fieldErrors : {};
  const v = (k: keyof TaskFormDefaults) => echoed?.[k] ?? defaults[k];

  return (
    <form action={formAction} className="space-y-5" noValidate>
      {Object.entries(hidden).map(([name, value]) =>
        name === "idempotencyKey" ? null : (
          <input key={name} type="hidden" name={name} value={value} />
        ),
      )}
      {rotateKey && <input type="hidden" name="idempotencyKey" value={key} />}
      <TextField
        label="Task"
        name="title"
        required
        autoFocus={autoFocusTitle}
        maxLength={160}
        autoComplete="off"
        placeholder="e.g. Call the florist"
        defaultValue={v("title")}
        error={errors.title}
      />
      <div className={compact ? "grid gap-5 sm:grid-cols-2" : "space-y-5"}>
        <TextField
          label="Due date"
          hint="Optional. Leave blank if you're not sure yet."
          name="dueDate"
          type="date"
          defaultValue={v("dueDate")}
          error={errors.dueDate}
        />
        <SelectField label="Assigned to" name="assignee" defaultValue={v("assignee")}>
          <option value="">Unassigned</option>
          {assignees.map((a) => (
            <option key={a.userId} value={a.userId}>
              {a.label}
            </option>
          ))}
        </SelectField>
      </div>
      {!compact && (
        <TextAreaField
          label="Notes"
          name="notes"
          maxLength={2000}
          defaultValue={v("notes")}
          error={errors.notes}
        />
      )}
      <div aria-live="polite" className="min-h-6">
        {state.status === "error" && (
          <p role="alert" className="text-body-md text-danger">
            {state.message}
          </p>
        )}
        {state.status === "ok" && !rotateKey && (
          <p className="text-body-md text-action-secondary">{state.message}</p>
        )}
      </div>
      <Button type="submit" variant="primary" disabled={pending} className="w-full sm:w-auto">
        {pending ? pendingLabel : submitLabel}
      </Button>
    </form>
  );
}
