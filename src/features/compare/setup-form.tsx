"use client";

import { useTrayActionState } from "@/components/ui/tray";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { MAX_OPTIONS, MIN_OPTIONS } from "@/domain/comparison/evaluate";
import { createComparison, type ComparisonActionState } from "@/server/comparisons/actions";
import { errorOf, Feedback } from "./feedback";

export type QuoteChoice = { id: string; candidateName: string; title: string; summary: string };

const idle: ComparisonActionState = { status: "idle" };

export function SetupForm({
  workspaceId,
  idempotencyKey,
  defaultGuests,
  choices,
}: {
  workspaceId: string;
  idempotencyKey: string;
  defaultGuests: number | null;
  choices: QuoteChoice[];
}) {
  const [state, action, pending] = useTrayActionState(createComparison, idle);
  const err = errorOf(state);
  const picked = new Set((err?.values.proposalIds as string[] | undefined) ?? []);
  return (
    <form action={action} className="space-y-6" noValidate>
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <TextField
        label="Name"
        name="title"
        required
        maxLength={160}
        placeholder="e.g. Ceremony venues"
        defaultValue={(err?.values.title as string | undefined) ?? ""}
        error={err?.fieldErrors.title}
      />
      <TextField
        label="Guests to price for"
        name="guestCount"
        required
        inputMode="numeric"
        hint="Every option is priced for this same headcount so the totals are comparable."
        defaultValue={
          (err?.values.guestCount as string | undefined) ?? defaultGuests?.toString() ?? ""
        }
        error={err?.fieldErrors.guestCount}
      />
      <fieldset
        className="space-y-2"
        aria-describedby={err?.fieldErrors.proposals ? "pick-error" : undefined}
      >
        <legend className="text-label-lg font-semibold">
          Quotes to compare ({MIN_OPTIONS} to {MAX_OPTIONS})
        </legend>
        {choices.map((c) => (
          <label key={c.id} className="flex min-h-11 items-start gap-3 py-1 text-body-md">
            <input
              type="checkbox"
              name="proposalIds"
              value={c.id}
              defaultChecked={picked.has(c.id)}
              className="mt-1 size-5 shrink-0"
            />
            <span>
              <span className="font-semibold">{c.candidateName}</span>: {c.title}
              <span className="block text-body-sm text-ink-muted">{c.summary}</span>
            </span>
          </label>
        ))}
        {err?.fieldErrors.proposals && (
          <p id="pick-error" role="alert" className="text-body-sm text-danger">
            {err.fieldErrors.proposals}
          </p>
        )}
      </fieldset>
      <Button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Start comparing"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}
