"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextAreaField } from "@/components/ui/text-area-field";
import { TextField } from "@/components/ui/text-field";
import { COST_MODES, type LineField } from "@/domain/proposals/input";
import type { CostMode } from "@/domain/proposals/normalize";
import type { ProposalActionState } from "@/server/proposals/actions";

export type LineFormDefaults = Record<LineField, string>;
type Action = (state: ProposalActionState, form: FormData) => Promise<ProposalActionState>;

export const EMPTY_LINE: LineFormDefaults = {
  description: "",
  costMode: "fixed",
  amount: "",
  quantity: "",
  minQty: "",
  maxQty: "",
  ratePercent: "",
  percentBase: "no",
  requirement: "required",
  certainty: "quoted",
  includedIn: "",
  evidence: "",
};

/**
 * One cost on a quote. Fields appear for the chosen pricing mode only, and a blank amount
 * is saved as unknown. Adding rotates the idempotency key and clears the form on success.
 */
export function LineForm({
  action,
  currency,
  defaults,
  hidden,
  parents,
  submitLabel,
  pendingLabel,
  rotateKey = false,
}: {
  action: Action;
  currency: string;
  defaults: LineFormDefaults;
  hidden: Record<string, string>;
  /** Other additive costs on this quote that an "included" line can point at. */
  parents: readonly { id: string; description: string }[];
  submitLabel: string;
  pendingLabel: string;
  rotateKey?: boolean;
}) {
  const [created, setCreated] = useState(0);
  const [mode, setMode] = useState<CostMode>(defaults.costMode as CostMode);
  const [state, formAction, pending] = useActionState(
    async (prev: ProposalActionState, form: FormData) => {
      const next = await action(prev, form);
      if (rotateKey && next.status === "ok") {
        setCreated((n) => n + 1);
        setMode(defaults.costMode as CostMode);
      }
      return next;
    },
    { status: "idle" } as ProposalActionState,
  );
  const echoed = state.status === "error" ? state.values : undefined;
  const errors = state.status === "error" ? state.fieldErrors : {};
  const v = (k: LineField) => echoed?.[k] ?? defaults[k];
  const key = `${hidden.idempotencyKey ?? ""}-${created}`;
  const priced = mode === "fixed" || mode === "per_guest" || mode === "quantity";

  return (
    <form action={formAction} className="space-y-5" noValidate key={rotateKey ? created : "edit"}>
      {Object.entries(hidden).map(([name, value]) =>
        name === "idempotencyKey" ? null : (
          <input key={name} type="hidden" name={name} value={value} />
        ),
      )}
      {rotateKey && <input type="hidden" name="idempotencyKey" value={key} />}
      <TextField
        label="What is this cost for?"
        name="description"
        required
        maxLength={200}
        autoComplete="off"
        placeholder="Dinner service"
        defaultValue={v("description")}
        error={errors.description}
      />
      <SelectField
        label="How is it priced?"
        name="costMode"
        value={mode}
        onChange={(e) => setMode(e.target.value as CostMode)}
        error={errors.costMode}
      >
        {COST_MODES.map((m) => (
          <option key={m.value} value={m.value}>
            {m.label} ({m.hint})
          </option>
        ))}
      </SelectField>

      {priced && (
        <TextField
          label={
            mode === "per_guest"
              ? `Price per guest (${currency})`
              : mode === "quantity"
                ? `Price for one (${currency})`
                : `Amount (${currency})`
          }
          hint="Leave blank if you don't know yet. A blank is saved as unknown, never as zero."
          name="amount"
          inputMode="decimal"
          autoComplete="off"
          placeholder={mode === "per_guest" ? "95" : "2500"}
          defaultValue={v("amount")}
          error={errors.amount}
        />
      )}
      {mode === "quantity" && (
        <TextField
          label="How many?"
          hint="For example hours or items. Leave blank if unknown."
          name="quantity"
          inputMode="numeric"
          autoComplete="off"
          defaultValue={v("quantity")}
          error={errors.quantity}
        />
      )}
      {mode === "per_guest" && (
        <div className="grid gap-5 sm:grid-cols-2">
          <TextField
            label="Minimum guests they charge for"
            hint="Optional. From the quote or contract."
            name="minQty"
            inputMode="numeric"
            autoComplete="off"
            defaultValue={v("minQty")}
            error={errors.minQty}
          />
          <TextField
            label="Maximum guests they allow"
            hint="Optional."
            name="maxQty"
            inputMode="numeric"
            autoComplete="off"
            defaultValue={v("maxQty")}
            error={errors.maxQty}
          />
        </div>
      )}
      {mode === "percent" && (
        <TextField
          label="Percentage"
          hint="For example 22 for a 22% service charge. It applies to the costs you mark as part of a percentage."
          name="ratePercent"
          inputMode="decimal"
          autoComplete="off"
          placeholder="22"
          defaultValue={v("ratePercent")}
          error={errors.ratePercent}
        />
      )}
      {mode === "included" && (
        <SelectField
          label="Already covered by"
          name="includedIn"
          defaultValue={v("includedIn")}
          error={errors.includedIn}
          hint={parents.length === 0 ? "Add the cost that covers this first." : undefined}
        >
          <option value="">Choose a cost</option>
          {parents.map((p) => (
            <option key={p.id} value={p.id}>
              {p.description}
            </option>
          ))}
        </SelectField>
      )}
      {priced && (
        <SelectField
          label="Do service charge or tax percentages apply to this?"
          name="percentBase"
          defaultValue={v("percentBase")}
        >
          <option value="no">No</option>
          <option value="yes">Yes, include it in percentages</option>
        </SelectField>
      )}

      <div className="grid gap-5 sm:grid-cols-2">
        <SelectField label="Is it required?" name="requirement" defaultValue={v("requirement")}>
          <option value="required">Required</option>
          <option value="optional">Optional add-on</option>
        </SelectField>
        <SelectField label="How sure is the number?" name="certainty" defaultValue={v("certainty")}>
          <option value="quoted">Quoted by the vendor</option>
          <option value="estimated">My estimate</option>
        </SelectField>
      </div>
      <TextAreaField
        label="Where did this come from?"
        hint="Optional. For example “Email from the planner, Nov 3” or “Page 2 of the PDF”."
        name="evidence"
        maxLength={500}
        defaultValue={v("evidence")}
        error={errors.evidence}
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
