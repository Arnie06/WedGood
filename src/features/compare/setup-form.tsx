"use client";

import { useState } from "react";
import { useTrayActionState } from "@/components/ui/tray";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import { MAX_OPTIONS, MIN_OPTIONS } from "@/domain/comparison/evaluate";
import { usableCount, type CountChoice } from "@/domain/comparison/reprice";
import { createComparison, type ComparisonActionState } from "@/server/comparisons/actions";
import { errorOf, Feedback } from "./feedback";

export type QuoteChoice = { id: string; candidateName: string; title: string; summary: string };

const idle: ComparisonActionState = { status: "idle" };

export function SetupForm({
  workspaceId,
  idempotencyKey,
  defaultGuests,
  countChoices,
  choices,
}: {
  workspaceId: string;
  idempotencyKey: string;
  defaultGuests: number | null;
  /** Events and their planning numbers. Empty when this member may not see guest totals. */
  countChoices: CountChoice[];
  choices: QuoteChoice[];
}) {
  const [state, action, pending] = useTrayActionState(createComparison, idle);
  const err = errorOf(state);
  // Start from the first event with a number (the server lists the reception first); the count stays
  // editable. A number typed over it is the couple's own and no longer follows that event.
  const firstUsable = countChoices.find((c) => usableCount(c.planningNumber));
  const [source, setSource] = useState<string>(
    (err?.values.countEventId as string | undefined) ?? firstUsable?.eventId ?? "",
  );
  const [count, setCount] = useState<string>(
    (err?.values.guestCount as string | undefined) ??
      (firstUsable?.planningNumber?.toString() || defaultGuests?.toString() || ""),
  );
  const chosen = countChoices.find((c) => c.eventId === source);
  const followed = chosen && usableCount(chosen.planningNumber) ? chosen : null;
  const edited = followed !== null && count.trim() !== String(followed.planningNumber);
  const countHint = followed
    ? edited
      ? `You changed the number, so this comparison will use your number and not follow replies to ${followed.eventName}.`
      : `Taken from replies to ${followed.eventName} today. The comparison keeps this number if replies change; we'll tell you when it's worth repricing.`
    : "Every option is priced for this same headcount so the totals are comparable.";
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
      {countChoices.length > 0 && (
        <SelectField
          label="Start the guest count from"
          name="countEventId"
          value={source}
          onChange={(e) => {
            const next = e.target.value;
            setSource(next);
            const pick = countChoices.find((c) => c.eventId === next);
            if (pick && usableCount(pick.planningNumber)) setCount(String(pick.planningNumber));
            else if (defaultGuests !== null) setCount(String(defaultGuests));
          }}
        >
          {countChoices.map((c) => (
            <option key={c.eventId} value={c.eventId} disabled={!usableCount(c.planningNumber)}>
              {usableCount(c.planningNumber)
                ? `${c.eventName}: ${c.planningNumber} guests`
                : `${c.eventName}: no replies yet`}
            </option>
          ))}
          <option value="">
            {defaultGuests !== null ? `Your guest target (${defaultGuests})` : "A number I type"}
          </option>
        </SelectField>
      )}
      <TextField
        label="Guests to price for"
        name="guestCount"
        required
        inputMode="numeric"
        hint={countHint}
        value={count}
        onChange={(e) => setCount(e.target.value)}
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
