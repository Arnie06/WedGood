"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { quickSetTarget, type SettingsFormState } from "@/server/workspace/actions";

/** One field, one button: set a budget or guest target without leaving Home. */
export function QuickSetForm({
  which,
  workspaceId,
  version,
  label,
  hint,
  inputMode,
  currency,
}: {
  which: "targetBudget" | "targetGuestCount";
  workspaceId: string;
  version: number;
  label: string;
  hint: string;
  inputMode: "decimal" | "numeric";
  currency?: string;
}) {
  const [state, action, pending] = useActionState(quickSetTarget, {
    status: "idle",
  } as SettingsFormState);
  const error = state.status === "error" ? (state.fieldErrors[which] ?? state.message) : undefined;
  const echoed = state.status === "error" ? state.values[which] : undefined;

  if (state.status === "ok") {
    return (
      <p role="status" className="text-body-md text-action-secondary">
        Saved. Thank you.
      </p>
    );
  }

  return (
    <form action={action} className="space-y-3" noValidate>
      <input type="hidden" name="which" value={which} />
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="version" value={version} />
      <TextField
        label={label}
        hint={hint}
        name="value"
        inputMode={inputMode}
        autoComplete="off"
        defaultValue={echoed ?? ""}
        placeholder={
          which === "targetBudget" ? `e.g. 25000${currency ? ` (${currency})` : ""}` : "e.g. 80"
        }
        error={error}
        disabled={pending}
      />
      <Button type="submit" variant="secondary" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}
