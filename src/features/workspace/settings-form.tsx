"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import { SUPPORTED_CURRENCIES, isValidTimeZone } from "@/domain/wedding/settings";
import type { SettingsFormState } from "@/server/workspace/actions";

export type SettingsDefaults = {
  name: string;
  date: string;
  timezone: string;
  baseCurrency: string;
  targetBudget: string;
  targetGuestCount: string;
  location: string;
};

type Action = (state: SettingsFormState, form: FormData) => Promise<SettingsFormState>;

export function SettingsForm({
  action,
  defaults,
  timeZones,
  submitLabel,
  pendingLabel,
  hidden,
  detectTimeZone = false,
  readOnly = false,
}: {
  action: Action;
  defaults: SettingsDefaults;
  timeZones: readonly string[];
  submitLabel: string;
  pendingLabel: string;
  hidden: Record<string, string>;
  /** Pre-select the browser's zone (new workspaces only; never overrides a saved value). */
  detectTimeZone?: boolean;
  readOnly?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {
    status: "idle",
  } as SettingsFormState);
  const echoed = state.status === "error" ? state.values : undefined;
  const errors = state.status === "error" ? state.fieldErrors : {};
  const v = (k: keyof SettingsDefaults) => echoed?.[k] ?? defaults[k];

  // The browser's zone is synced into the DOM select once, unless the user already chose one.
  const zoneRef = useRef<HTMLSelectElement>(null);
  const zoneTouched = useRef(false);
  useEffect(() => {
    if (!detectTimeZone || zoneTouched.current || !zoneRef.current) return;
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (detected && timeZones.includes(detected) && isValidTimeZone(detected)) {
      zoneRef.current.value = detected;
    }
  }, [detectTimeZone, timeZones]);

  return (
    <form action={formAction} className="space-y-6" noValidate>
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <fieldset disabled={readOnly || pending} className="m-0 min-w-0 space-y-6 border-0 p-0">
        <legend className="sr-only">Wedding details</legend>
        <TextField
          label="Wedding name"
          name="name"
          required
          maxLength={160}
          autoComplete="off"
          placeholder="Alex & Morgan"
          defaultValue={v("name")}
          error={errors.name}
        />
        <TextField
          label="Wedding date"
          hint="Have a date in mind? It's okay if you're still deciding."
          name="date"
          type="date"
          defaultValue={v("date")}
          error={errors.date}
        />
        <TextField
          label="Location"
          hint="A city or region is plenty. Optional."
          name="location"
          maxLength={200}
          autoComplete="off"
          defaultValue={v("location")}
          error={errors.location}
        />
        <TextField
          label="Budget target"
          hint="Set a target, or come back when you're ready."
          name="targetBudget"
          inputMode="decimal"
          autoComplete="off"
          defaultValue={v("targetBudget")}
          error={errors.targetBudget}
        />
        <SelectField
          label="Currency"
          name="baseCurrency"
          required
          defaultValue={v("baseCurrency")}
          error={errors.baseCurrency}
        >
          {SUPPORTED_CURRENCIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Guest count target"
          hint="A rough number is fine. Optional."
          name="targetGuestCount"
          inputMode="numeric"
          autoComplete="off"
          defaultValue={v("targetGuestCount")}
          error={errors.targetGuestCount}
        />
        <SelectField
          label="Time zone"
          hint="Where the wedding takes place. Dates and times follow this zone."
          name="timezone"
          required
          ref={zoneRef}
          defaultValue={v("timezone")}
          onChange={() => {
            zoneTouched.current = true;
          }}
          error={errors.timezone}
        >
          {timeZones.map((z) => (
            <option key={z} value={z}>
              {z.replaceAll("_", " ")}
            </option>
          ))}
        </SelectField>
      </fieldset>

      <div aria-live="polite" className="min-h-6">
        {state.status === "error" && (
          <p role="alert" className="text-body-md text-danger">
            {state.message}
          </p>
        )}
        {state.status === "ok" && (
          <p className="text-body-md text-action-secondary">{state.message}</p>
        )}
        {state.status === "ok" && state.reviewMoves && hidden.workspaceId && (
          <p className="mt-2 text-body-md">
            Your date changed.{" "}
            <Link
              href={`/app/${hidden.workspaceId}/plan/review-dates`}
              className="font-semibold text-action-emphasis underline underline-offset-4"
            >
              Review {state.reviewMoves} checklist {state.reviewMoves === 1 ? "date" : "dates"}
            </Link>
            . Nothing has moved yet.
          </p>
        )}
      </div>

      {readOnly ? (
        <p className="text-body-md text-ink-muted">
          You can view these details. Ask the workspace owner to change them.
        </p>
      ) : (
        <Button type="submit" variant="primary" disabled={pending} className="w-full sm:w-auto">
          {pending ? pendingLabel : submitLabel}
        </Button>
      )}
    </form>
  );
}
