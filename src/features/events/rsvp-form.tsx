"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import { submitRsvp, type RsvpActionState } from "@/server/rsvp/actions";
import type { RsvpView } from "@/server/rsvp/public";

const idle: RsvpActionState = { status: "idle" };

export function RsvpForm({ token, initial }: { token: string; initial: RsvpView }) {
  const [state, formAction, pending] = useActionState(submitRsvp, idle);
  const view = state.status === "idle" ? initial : (state.view ?? initial);
  const closed = view.closed;
  const answered = view.members.some((m) => m.status !== "pending");
  return (
    <form action={formAction} key={view.version} className="space-y-6" noValidate>
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="version" value={view.version} />
      {view.members.map((m) => (
        <fieldset key={m.id} className="space-y-3 rounded-card border border-border-hairline p-4">
          <legend className="px-2 text-label-lg font-semibold">
            {m.name}
            {m.isPlusOne ? " (plus-one)" : ""}
          </legend>
          <input type="hidden" name="memberId" value={m.id} />
          <div className="space-y-1">
            {(
              [
                ["accepted", "Attending"],
                ["declined", "Not attending"],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex min-h-11 items-center gap-3">
                <input
                  type="radio"
                  name={`status_${m.id}`}
                  value={value}
                  defaultChecked={m.status === value}
                  disabled={closed}
                  className="size-5"
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
          {view.mealOptions.length > 0 && (
            <SelectField
              label="Meal choice (if attending)"
              name={`meal_${m.id}`}
              defaultValue={m.mealOptionId ?? ""}
              disabled={closed}
            >
              <option value="">No choice yet</option>
              {view.mealOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </SelectField>
          )}
        </fieldset>
      ))}

      {view.plusOneRemaining > 0 && !closed && (
        <fieldset className="space-y-3 rounded-card border border-border-hairline p-4">
          <legend className="px-2 text-label-lg font-semibold">Bringing a guest?</legend>
          <p className="text-body-sm text-ink-muted">
            You may add {view.plusOneRemaining} more{" "}
            {view.plusOneRemaining === 1 ? "guest" : "guests"}. Leave blank if not.
          </p>
          <TextField
            label="Guest's full name"
            name="plusOneName"
            maxLength={120}
            autoComplete="off"
          />
          {view.mealOptions.length > 0 && (
            <SelectField label="Their meal choice" name="plusOneMeal" defaultValue="">
              <option value="">No choice yet</option>
              {view.mealOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </SelectField>
          )}
        </fieldset>
      )}

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
      {closed ? (
        <p className="text-body-md">
          The reply date has passed, so answers can&apos;t be changed here. Please contact the
          couple.
        </p>
      ) : (
        <Button type="submit" disabled={pending}>
          {pending ? "Sending…" : answered ? "Update my response" : "Send my response"}
        </Button>
      )}
      {view.deadline && !closed && (
        <p className="text-body-sm text-ink-muted">
          Please reply by{" "}
          {new Date(view.deadline).toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
            timeZone: "UTC",
          })}
          .
        </p>
      )}
    </form>
  );
}
