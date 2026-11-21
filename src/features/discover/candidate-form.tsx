"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextAreaField } from "@/components/ui/text-area-field";
import { TextField } from "@/components/ui/text-field";
import { PRICE_BASES, VENDOR_CATEGORIES, type CandidateKind } from "@/domain/candidates/categories";
import type { CandidateField } from "@/domain/candidates/input";
import type { CandidateActionState } from "@/server/candidates/actions";

export type CandidateFormDefaults = Record<CandidateField, string>;

type Action = (state: CandidateActionState, form: FormData) => Promise<CandidateActionState>;

/** Add and edit share one form; edits carry the candidate id and last-seen version. */
export function CandidateForm({
  action,
  kind,
  currency,
  defaults,
  hidden,
  submitLabel,
  pendingLabel,
}: {
  action: Action;
  kind: CandidateKind;
  currency: string;
  defaults: CandidateFormDefaults;
  hidden: Record<string, string>;
  submitLabel: string;
  pendingLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {
    status: "idle",
  } as CandidateActionState);
  const echoed = state.status === "error" ? state.values : undefined;
  const errors = state.status === "error" ? state.fieldErrors : {};
  const v = (k: CandidateField) => echoed?.[k] ?? defaults[k];
  const noun = kind === "venue" ? "venue" : "vendor";

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <input type="hidden" name="kind" value={kind} />
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <TextField
        label="Name"
        name="name"
        required
        maxLength={160}
        autoComplete="off"
        placeholder={kind === "venue" ? "e.g. Garden House" : "e.g. Lantern Photography"}
        defaultValue={v("name")}
        error={errors.name}
      />
      {kind === "vendor" && (
        <SelectField
          label="What do they do?"
          name="category"
          required
          defaultValue={v("category")}
          error={errors.category}
        >
          <option value="">Choose one</option>
          {VENDOR_CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </SelectField>
      )}
      <TextField
        label="Location"
        hint="Optional. A city, neighborhood or address."
        name="location"
        maxLength={200}
        autoComplete="off"
        defaultValue={v("location")}
        error={errors.location}
      />
      {kind === "venue" && (
        <div className="grid gap-5 sm:grid-cols-2">
          <TextField
            label="Seated capacity"
            hint="Optional. Leave blank if you don't know yet."
            name="seatedCapacity"
            inputMode="numeric"
            autoComplete="off"
            defaultValue={v("seatedCapacity")}
            error={errors.seatedCapacity}
          />
          <TextField
            label="Ceremony capacity"
            hint="Optional."
            name="ceremonyCapacity"
            inputMode="numeric"
            autoComplete="off"
            defaultValue={v("ceremonyCapacity")}
            error={errors.ceremonyCapacity}
          />
        </div>
      )}
      <fieldset className="space-y-5 rounded-card border border-border-hairline p-4">
        <legend className="px-1 text-label-lg font-semibold">Price you were quoted</legend>
        <p className="text-body-sm text-ink-muted">
          Optional. Leave this blank if you don&apos;t have a number yet; a blank price is shown as
          unknown, never as zero. Amounts are in {currency}.
        </p>
        <div className="grid gap-5 sm:grid-cols-2">
          <TextField
            label="Amount"
            name="price"
            inputMode="decimal"
            autoComplete="off"
            placeholder="e.g. 8500"
            defaultValue={v("price")}
            error={errors.price}
          />
          <SelectField
            label="That price is"
            name="priceBasis"
            defaultValue={v("priceBasis")}
            error={errors.priceBasis}
          >
            <option value="">Choose one</option>
            {PRICE_BASES.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </SelectField>
        </div>
        <TextField
          label="Pricing note"
          hint="Optional. For example “From $8,500, plus 22% service”."
          name="pricingDisplay"
          maxLength={200}
          autoComplete="off"
          defaultValue={v("pricingDisplay")}
          error={errors.pricingDisplay}
        />
      </fieldset>
      <div className="grid gap-5 sm:grid-cols-2">
        <TextField
          label="Source link"
          hint={`Optional. Where you found this ${noun}. We save the link but never open it.`}
          name="sourceUrl"
          type="url"
          inputMode="url"
          autoComplete="off"
          placeholder="https://"
          defaultValue={v("sourceUrl")}
          error={errors.sourceUrl}
        />
        <TextField
          label="Source last checked"
          hint="Optional. The day you last looked at it."
          name="sourceCheckedOn"
          type="date"
          defaultValue={v("sourceCheckedOn")}
          error={errors.sourceCheckedOn}
        />
      </div>
      <TextAreaField
        label="Notes"
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
      </div>
      <Button type="submit" variant="primary" disabled={pending} className="w-full sm:w-auto">
        {pending ? pendingLabel : submitLabel}
      </Button>
    </form>
  );
}
