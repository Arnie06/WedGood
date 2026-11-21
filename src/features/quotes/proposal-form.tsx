"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { TextAreaField } from "@/components/ui/text-area-field";
import { TextField } from "@/components/ui/text-field";
import type { ProposalField } from "@/domain/proposals/input";
import type { ProposalActionState } from "@/server/proposals/actions";

export type ProposalFormDefaults = Record<ProposalField, string>;
type Action = (state: ProposalActionState, form: FormData) => Promise<ProposalActionState>;

/** Quote details and where they came from. Create and edit share it. */
export function ProposalForm({
  action,
  defaults,
  hidden,
  submitLabel,
  pendingLabel,
}: {
  action: Action;
  defaults: ProposalFormDefaults;
  hidden: Record<string, string>;
  submitLabel: string;
  pendingLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {
    status: "idle",
  } as ProposalActionState);
  const echoed = state.status === "error" ? state.values : undefined;
  const errors = state.status === "error" ? state.fieldErrors : {};
  const v = (k: ProposalField) => echoed?.[k] ?? defaults[k];
  return (
    <form action={formAction} className="space-y-5" noValidate>
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <TextField
        label="Name this quote"
        name="title"
        required
        maxLength={160}
        autoComplete="off"
        placeholder="e.g. Saturday package, 120 guests"
        defaultValue={v("title")}
        error={errors.title}
      />
      <div className="grid gap-5 sm:grid-cols-2">
        <TextField
          label="Date you received it"
          hint="Optional."
          name="receivedOn"
          type="date"
          defaultValue={v("receivedOn")}
          error={errors.receivedOn}
        />
        <TextField
          label="Quote is valid until"
          hint="Optional. Check the quote for an expiry."
          name="validUntil"
          type="date"
          defaultValue={v("validUntil")}
          error={errors.validUntil}
        />
      </div>
      <TextField
        label="Link to the quote"
        hint="Optional. We save the link but never open it."
        name="sourceUrl"
        type="url"
        maxLength={2000}
        autoComplete="off"
        placeholder="https://"
        defaultValue={v("sourceUrl")}
        error={errors.sourceUrl}
      />
      <TextAreaField
        label="Notes"
        hint="Optional. What was promised, what to ask next."
        name="notes"
        maxLength={2000}
        defaultValue={v("notes")}
        error={errors.notes}
      />
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
      <Button type="submit" variant="primary" disabled={pending} className="w-full sm:w-auto">
        {pending ? pendingLabel : submitLabel}
      </Button>
    </form>
  );
}
