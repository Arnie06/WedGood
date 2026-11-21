"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { TextAreaField as TextArea } from "@/components/ui/text-area-field";
import { TextField } from "@/components/ui/text-field";
import { MAX_CRITERIA, MAX_WEIGHT, type Criterion } from "@/domain/comparison/evaluate";
import {
  archiveComparison,
  decideComparison,
  saveRatings,
  updateComparison,
  type ComparisonActionState,
} from "@/server/comparisons/actions";
import { errorOf, Feedback } from "./feedback";

const idle: ComparisonActionState = { status: "idle" };

type Hidden = { workspaceId: string; comparisonId: string; version: number };
function HiddenFields({ workspaceId, comparisonId, version }: Hidden) {
  return (
    <>
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="comparisonId" value={comparisonId} />
      <input type="hidden" name="version" value={version} />
    </>
  );
}

/** Scenario, criteria and weights. Two spare rows let people add criteria without extra clicks. */
export function SettingsForm({
  hidden,
  title,
  guestCount,
  criteria,
  acceptsUnknowns,
}: {
  hidden: Hidden;
  title: string;
  guestCount: number;
  criteria: Criterion[];
  acceptsUnknowns: boolean;
}) {
  const [state, action, pending] = useActionState(updateComparison, idle);
  const err = errorOf(state);
  const spare = Math.max(0, Math.min(2, MAX_CRITERIA - criteria.length));
  const rows = [
    ...criteria.map((c) => ({ id: c.id, label: c.label, weight: String(c.weight) })),
    ...Array.from({ length: spare }, () => ({ id: "", label: "", weight: "" })),
  ];
  return (
    <form action={action} className="space-y-5" noValidate>
      <HiddenFields {...hidden} />
      <TextField
        label="Name"
        name="title"
        required
        defaultValue={title}
        error={err?.fieldErrors.title}
      />
      <TextField
        label="Guests to price for"
        name="guestCount"
        required
        inputMode="numeric"
        defaultValue={String(guestCount)}
        hint="Changing this reprices per-guest costs for every option."
        error={err?.fieldErrors.guestCount}
      />
      <fieldset className="space-y-3">
        <legend className="text-label-lg font-semibold">What matters to you</legend>
        <p className="text-body-sm text-ink-muted">
          Give each criterion a weight from 0 (ignore) to {MAX_WEIGHT} (matters most). These are
          starting suggestions; change them to fit you.
        </p>
        {rows.map((r, i) => (
          <div key={r.id || `new-${i}`} className="grid grid-cols-[1fr_6rem] gap-3">
            <input type="hidden" name="criterionId" value={r.id} />
            <TextField
              label={`Criterion ${i + 1}`}
              name="criterionLabel"
              defaultValue={r.label}
              maxLength={60}
            />
            <TextField
              label="Weight"
              name="criterionWeight"
              inputMode="numeric"
              defaultValue={r.weight}
            />
          </div>
        ))}
        {err?.fieldErrors.criteria && (
          <p role="alert" className="text-body-sm text-danger">
            {err.fieldErrors.criteria}
          </p>
        )}
      </fieldset>
      <label className="flex min-h-11 items-start gap-3 text-body-md">
        <input
          type="checkbox"
          name="acceptsUnknowns"
          defaultChecked={acceptsUnknowns}
          className="mt-1 size-5 shrink-0"
        />
        <span>
          Rank options even when some required costs are still unknown
          <span className="block text-body-sm text-ink-muted">
            Totals will still say they&apos;re incomplete.
          </span>
        </span>
      </label>
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "Saving…" : "Save settings"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function RatingsForm({
  hidden,
  criteria,
  options,
}: {
  hidden: Hidden;
  criteria: Criterion[];
  options: { id: string; label: string; ratings: Record<string, number> }[];
}) {
  const [state, action, pending] = useActionState(saveRatings, idle);
  const err = errorOf(state);
  return (
    <form action={action} className="space-y-5" noValidate>
      <HiddenFields {...hidden} />
      {options.map((o) => (
        <fieldset key={o.id} className="space-y-3 rounded-card border border-border-hairline p-4">
          <legend className="px-1 font-serif text-headline-sm break-words">{o.label}</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {criteria.map((c) => {
              const name = `rating:${o.id}:${c.id}`;
              const typed = err?.values[name];
              return (
                <TextField
                  key={c.id}
                  label={`${c.label} (0 to 100)`}
                  name={name}
                  inputMode="numeric"
                  defaultValue={
                    typeof typed === "string" ? typed : (o.ratings[c.id]?.toString() ?? "")
                  }
                />
              );
            })}
          </div>
        </fieldset>
      ))}
      <p className="text-body-sm text-ink-muted">
        Leave a box empty if you haven&apos;t judged it yet. Empty isn&apos;t the same as 0.
      </p>
      {err?.fieldErrors.ratings && (
        <p role="alert" className="text-body-sm text-danger">
          {err.fieldErrors.ratings}
        </p>
      )}
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "Saving…" : "Save ratings"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

/** Choosing is explicit: warnings must be acknowledged, and nothing is booked. */
export function DecideForm({
  hidden,
  proposalId,
  label,
  idempotencyKey,
  warnings,
}: {
  hidden: Hidden;
  proposalId: string;
  label: string;
  idempotencyKey: string;
  warnings: string[];
}) {
  const [state, action, pending] = useActionState(decideComparison, idle);
  const err = errorOf(state);
  return (
    <form action={action} className="space-y-3" noValidate>
      <HiddenFields {...hidden} />
      <input type="hidden" name="proposalId" value={proposalId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      {warnings.length > 0 && (
        <label className="flex min-h-11 items-start gap-3 text-body-md">
          <input type="checkbox" name="acknowledged" className="mt-1 size-5 shrink-0" />
          <span>I&apos;ve read these warnings: {warnings.join("; ")}.</span>
        </label>
      )}
      <TextArea
        label="Note (optional)"
        name="note"
        rows={2}
        maxLength={1000}
        defaultValue={typeof err?.values.note === "string" ? err.values.note : ""}
      />
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : `Choose ${label}`}
      </Button>
      <p className="text-body-sm text-ink-muted">
        This records your choice. It doesn&apos;t book anything or commit any money.
      </p>
      <Feedback state={state} />
    </form>
  );
}

export function ArchiveForm({ hidden }: { hidden: Hidden }) {
  const [state, action, pending] = useActionState(archiveComparison, idle);
  return (
    <form action={action} className="space-y-2">
      <HiddenFields {...hidden} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "Removing…" : "Remove this comparison"}
      </Button>
      <p className="text-body-sm text-ink-muted">
        Your quotes and any recorded decision history stay as they are.
      </p>
      <Feedback state={state} />
    </form>
  );
}
