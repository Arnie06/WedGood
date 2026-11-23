"use client";

import { useState } from "react";
import { Button, ButtonLink } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextAreaField } from "@/components/ui/text-area-field";
import { TextField } from "@/components/ui/text-field";
import { useTrayActionState, useTrayClose } from "@/components/ui/tray";
import { lockSentence, type GuaranteeMeal, type GuaranteePreview } from "@/domain/events/guarantee";
import {
  lockGuarantee,
  reviseGuarantee,
  type GuaranteeActionState,
} from "@/server/events/guarantee-actions";

const idle: GuaranteeActionState = { status: "idle" };

export type GuaranteeFormProps = {
  workspaceId: string;
  eventId: string;
  eventName: string;
  /** Set when revising: the locked row the person is looking at. */
  guaranteeId: string | null;
  /** Replies as they are now. Sent back so the database can refuse if they move. */
  preview: GuaranteePreview;
  meals: readonly GuaranteeMeal[];
  yes: number;
  waiting: number;
  planningNumber: number;
  /** The number to start from: the planning number, or the count being revised. */
  startCount: number;
  caterers: { id: string; label: string }[];
  startCaterer: string;
  startDue: string;
  /** Where "Make a caterer package" goes. */
  packageHref: string;
};

/**
 * Lock or revise the caterer count. The person sees today's replies and the sentence "You're
 * telling the caterer N" before the button. After it saves, the tray stays open on a success panel
 * that offers a caterer package; nothing is emailed or sent from here.
 */
export function GuaranteeForm(p: GuaranteeFormProps) {
  const revising = p.guaranteeId !== null;
  const [keyBase] = useState(() => crypto.randomUUID());
  const [count, setCount] = useState(String(p.startCount));
  const [state, formAction, pending] = useTrayActionState(
    revising ? reviseGuarantee : lockGuarantee,
    idle,
    { keepOpen: true },
  );
  const close = useTrayClose();
  const n = Number.parseInt(count, 10);
  const valid = /^\d{1,4}$/.test(count.trim()) && n >= 1 && n <= 5000;

  if (state.status === "ok") {
    return (
      <div className="space-y-4" data-testid="guarantee-done">
        <p role="status" className="text-body-md font-semibold">
          {state.message}
        </p>
        {state.kind !== "unchanged" && (
          <>
            <p className="text-body-md text-ink-muted">
              Nothing was sent to the caterer. Give them the number yourself, or make a brief that
              includes it.
            </p>
            <p>
              <ButtonLink href={p.packageHref} variant="outline">
                Make a caterer package
              </ButtonLink>
            </p>
          </>
        )}
        <Button type="button" onClick={close}>
          Done
        </Button>
      </div>
    );
  }

  const errorId = "guarantee-error";
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="workspaceId" value={p.workspaceId} />
      {revising ? (
        <input type="hidden" name="guaranteeId" value={p.guaranteeId ?? ""} />
      ) : (
        <input type="hidden" name="eventId" value={p.eventId} />
      )}
      <input type="hidden" name="idempotencyKey" value={keyBase} />
      <input type="hidden" name="preview" value={JSON.stringify(p.preview)} />

      <section aria-label="Replies right now" className="space-y-2" data-testid="guarantee-preview">
        <h3 className="text-label-lg font-semibold">Replies right now</h3>
        <p className="text-body-md">
          {p.yes} attending
          {p.waiting > 0 ? `, ${p.waiting} still waiting` : ""}. The planning number is{" "}
          {p.planningNumber}.
        </p>
        {p.meals.length > 0 ? (
          <ul className="text-body-md">
            {p.meals.map((m) => (
              <li key={m.id}>
                {m.name}: {m.count}
                {m.active ? "" : " (no longer offered)"}
              </li>
            ))}
            {p.preview.withoutMeal > 0 && <li>No meal chosen yet: {p.preview.withoutMeal}</li>}
          </ul>
        ) : (
          <p className="text-body-md text-ink-muted">No meal choices set up for this event.</p>
        )}
        <p className="text-body-sm text-ink-muted">
          These numbers are saved with the count, so you can see later what it was based on. If a
          guest answers while this is open, you&apos;ll be asked to look again.
        </p>
      </section>

      <TextField
        label="Count to give the caterer"
        name="count"
        inputMode="numeric"
        autoComplete="off"
        value={count}
        onChange={(e) => setCount(e.target.value)}
        hint="Whole guests, including any buffer you agreed. It doesn't change when guests reply."
        required
      />
      <p
        role="status"
        aria-live="polite"
        className="text-body-md font-semibold"
        data-testid="lock-sentence"
      >
        {valid ? lockSentence(n) : "Enter a count from 1 to 5,000."}
      </p>

      <SelectField
        label="Caterer"
        name="candidateId"
        defaultValue={p.startCaterer}
        hint={
          p.caterers.length === 0
            ? "No vendors are assigned to this event yet. You can lock without one."
            : "Optional. Only vendors assigned to this event are listed."
        }
      >
        <option value="">No caterer chosen</option>
        {p.caterers.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </SelectField>

      <TextField
        label="Caterer needs it by"
        name="dueOn"
        type="date"
        defaultValue={p.startDue}
        hint="Optional. Adds one checklist reminder a week before. Nothing is sent."
      />

      {revising && (
        <TextAreaField
          label="Why is the count changing?"
          name="reason"
          maxLength={500}
          required
          hint="Kept with the history. The caterer isn't told anything from here."
        />
      )}

      <div aria-live="polite" className="min-h-6">
        {state.status === "error" && (
          <p id={errorId} role="alert" className="text-body-md text-danger">
            {state.message}{" "}
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex min-h-11 items-center font-semibold text-action-emphasis underline underline-offset-4"
            >
              Reload
            </button>
          </p>
        )}
      </div>
      <Button type="submit" variant="emphasis" disabled={pending || !valid}>
        {pending ? "Saving…" : revising ? "Save revised count" : "Lock count"}
      </Button>
    </form>
  );
}
