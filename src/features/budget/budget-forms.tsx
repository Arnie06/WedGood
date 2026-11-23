"use client";

import { useActionState, useState } from "react";
import { useToast } from "@/components/ui/toast";
import { useTrayActionState, useTrayClose } from "@/components/ui/tray";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextAreaField } from "@/components/ui/text-area-field";
import { TextField } from "@/components/ui/text-field";
import {
  BUDGET_COST_MODES,
  COUNT_SOURCE_OPTIONS,
  type CategoryField,
  type ItemField,
} from "@/domain/budget/input";
import { isReplyBased, type BudgetCostMode, type CountSource } from "@/domain/budget/summary";
import {
  addSuggestedCategories,
  archiveCategory,
  archiveItem,
  setReserve,
  type BudgetActionState,
} from "@/server/budget/actions";

const idle: BudgetActionState = { status: "idle" };
type Action = (state: BudgetActionState, form: FormData) => Promise<BudgetActionState>;

function Feedback({ state }: { state: BudgetActionState }) {
  return (
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
  );
}

function Hidden({ values }: { values: Record<string, string | number> }) {
  return Object.entries(values).map(([name, value]) => (
    <input key={name} type="hidden" name={name} value={value} />
  ));
}

// ---------------------------------------------------------------- category

export function CategoryForm({
  action,
  workspaceId,
  currency,
  defaults,
  extraHidden,
  submitLabel,
  pendingLabel,
  rotateKey = false,
}: {
  action: Action;
  workspaceId: string;
  currency: string;
  defaults: Record<CategoryField, string>;
  extraHidden?: Record<string, string | number>;
  submitLabel: string;
  pendingLabel: string;
  /** Creating: a fresh idempotency key per successful submit, and the form clears. */
  rotateKey?: boolean;
}) {
  const closeTray = useTrayClose();
  const { toast } = useToast();
  const [created, setCreated] = useState(0);
  const [keyBase] = useState(() => crypto.randomUUID());
  const [state, formAction, pending] = useActionState(
    async (prev: BudgetActionState, form: FormData) => {
      const next = await action(prev, form);
      if (rotateKey && next.status === "ok") setCreated((n) => n + 1);
      if (next.status === "ok") {
        closeTray();
        toast({ message: next.message });
      }
      return next;
    },
    idle,
  );
  const echoed = state.status === "error" ? state.values : undefined;
  const errors = state.status === "error" ? state.fieldErrors : {};
  const v = (k: CategoryField) => echoed?.[k] ?? defaults[k];
  return (
    <form action={formAction} className="space-y-4" noValidate key={rotateKey ? created : "edit"}>
      <Hidden values={{ workspaceId, ...extraHidden }} />
      {rotateKey && <input type="hidden" name="idempotencyKey" value={`${keyBase}-${created}`} />}
      <TextField
        label="Category name"
        name="name"
        required
        maxLength={80}
        autoComplete="off"
        placeholder="e.g. Flowers"
        defaultValue={v("name")}
        error={errors.name}
      />
      <TextField
        label={`Target for this category (${currency})`}
        hint="Optional. Leave blank if you haven't decided. This is guidance, not a limit."
        name="allocation"
        inputMode="decimal"
        autoComplete="off"
        placeholder="e.g. 4000"
        defaultValue={v("allocation")}
        error={errors.allocation}
      />
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? pendingLabel : submitLabel}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function SuggestedCategoriesForm({
  workspaceId,
  label,
}: {
  workspaceId: string;
  label: string;
}) {
  const [state, action, pending] = useTrayActionState(addSuggestedCategories, idle);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Adding…" : label}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

// ---------------------------------------------------------------- item

export type ItemFormDefaults = Record<ItemField, string>;

/** One planned cost. Fields follow the chosen mode, and a blank amount is saved as unknown. */
export function ItemForm({
  action,
  workspaceId,
  currency,
  categories,
  events,
  defaults,
  extraHidden,
  submitLabel,
  pendingLabel,
  rotateKey = false,
  idPrefix,
}: {
  action: Action;
  workspaceId: string;
  currency: string;
  categories: readonly { id: string; name: string }[];
  /** Events a per-guest cost can follow. Empty = only the guest target or a typed number. */
  events: readonly { id: string; name: string }[];
  defaults: ItemFormDefaults;
  extraHidden?: Record<string, string | number>;
  submitLabel: string;
  pendingLabel: string;
  rotateKey?: boolean;
  idPrefix?: string;
}) {
  const closeTray = useTrayClose();
  const { toast } = useToast();
  const [created, setCreated] = useState(0);
  const [keyBase] = useState(() => crypto.randomUUID());
  const [mode, setMode] = useState<BudgetCostMode>(defaults.costMode as BudgetCostMode);
  const [source, setSource] = useState<CountSource>(
    COUNT_SOURCE_OPTIONS.some((o) => o.value === defaults.countSource)
      ? (defaults.countSource as CountSource)
      : "guest_target",
  );
  // A stored event source stays visible even if the event list is empty, so nothing is silently dropped.
  const sourceOptions = COUNT_SOURCE_OPTIONS.filter(
    (o) => !isReplyBased(o.value) || events.length > 0 || o.value === source,
  );
  const [state, formAction, pending] = useActionState(
    async (prev: BudgetActionState, form: FormData) => {
      const next = await action(prev, form);
      if (rotateKey && next.status === "ok") {
        setCreated((n) => n + 1);
        setMode("fixed");
        setSource(defaults.countSource as CountSource);
      }
      if (next.status === "ok") {
        closeTray();
        toast({ message: next.message });
      }
      return next;
    },
    idle,
  );
  const echoed = state.status === "error" ? state.values : undefined;
  const errors = state.status === "error" ? state.fieldErrors : {};
  const v = (k: ItemField) => echoed?.[k] ?? defaults[k];
  return (
    <form
      action={formAction}
      className="space-y-4"
      noValidate
      key={rotateKey ? created : (idPrefix ?? "edit")}
    >
      <Hidden values={{ workspaceId, ...extraHidden }} />
      {rotateKey && <input type="hidden" name="idempotencyKey" value={`${keyBase}-${created}`} />}
      <TextField
        label="What is this cost?"
        name="name"
        required
        maxLength={160}
        autoComplete="off"
        placeholder="e.g. Dinner and drinks"
        defaultValue={v("name")}
        error={errors.name}
      />
      <SelectField
        label="Category"
        name="category"
        required
        defaultValue={v("category")}
        error={errors.category}
      >
        <option value="">Choose a category</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </SelectField>
      <SelectField
        label="How is it priced?"
        name="costMode"
        value={mode}
        onChange={(e) => setMode(e.target.value as BudgetCostMode)}
        error={errors.costMode}
      >
        {BUDGET_COST_MODES.map((m) => (
          <option key={m.value} value={m.value}>
            {m.label} ({m.hint})
          </option>
        ))}
      </SelectField>
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
        placeholder={mode === "per_guest" ? "e.g. 95" : "e.g. 2500"}
        defaultValue={v("amount")}
        error={errors.amount}
      />
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
        <SelectField
          label="Which guest count?"
          hint="Follows replies when you pick an event, so the cost updates as guests answer."
          name="countSource"
          value={source}
          onChange={(e) => setSource(e.target.value as CountSource)}
          error={errors.countSource}
        >
          {sourceOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </SelectField>
      )}
      {mode === "per_guest" && isReplyBased(source) && (
        <SelectField
          label="Which event?"
          name="countEvent"
          required
          defaultValue={v("countEvent")}
          error={errors.countEvent}
        >
          <option value="">Choose an event</option>
          {events.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </SelectField>
      )}
      {mode === "per_guest" && source === "typed" && (
        <TextField
          label="How many guests?"
          hint="Leave blank if unknown."
          name="countTyped"
          inputMode="numeric"
          autoComplete="off"
          defaultValue={v("countTyped")}
          error={errors.countTyped}
        />
      )}
      {mode === "per_guest" && (
        <TextField
          label="Minimum guests you'll be charged for"
          hint="Optional. From the quote or contract."
          name="minQty"
          inputMode="numeric"
          autoComplete="off"
          defaultValue={v("minQty")}
          error={errors.minQty}
        />
      )}
      <TextAreaField
        label="Notes"
        name="notes"
        rows={2}
        maxLength={1000}
        defaultValue={v("notes")}
        error={errors.notes}
      />
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? pendingLabel : submitLabel}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

// ---------------------------------------------------------------- archive, reserve

function ArchiveForm({
  action,
  fields,
  label,
}: {
  action: Action;
  fields: Record<string, string | number>;
  label: string;
}) {
  const [state, formAction, pending] = useTrayActionState(action, idle);
  return (
    <form action={formAction} className="space-y-2">
      <Hidden values={fields} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "Removing…" : label}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export const ArchiveItemForm = (p: {
  workspaceId: string;
  itemId: string;
  version: number;
  name: string;
}) => (
  <ArchiveForm
    action={archiveItem}
    fields={{ workspaceId: p.workspaceId, itemId: p.itemId, version: p.version }}
    label={`Remove ${p.name}`}
  />
);

export const ArchiveCategoryForm = (p: {
  workspaceId: string;
  categoryId: string;
  version: number;
  name: string;
}) => (
  <ArchiveForm
    action={archiveCategory}
    fields={{ workspaceId: p.workspaceId, categoryId: p.categoryId, version: p.version }}
    label={`Remove ${p.name}`}
  />
);

export function ReserveForm({
  workspaceId,
  version,
  percent,
}: {
  workspaceId: string;
  version: number;
  percent: string;
}) {
  const [state, action, pending] = useTrayActionState(setReserve, idle);
  const echoed = state.status === "error" ? state.values.reserve : undefined;
  return (
    <form action={action} className="space-y-3" noValidate key={`${version}-${percent}`}>
      <Hidden values={{ workspaceId, version }} />
      <TextField
        label="Reserve for the unexpected (%)"
        hint="A cushion on top of your known costs, such as 10. It is a plan, not money you owe. Leave blank for none."
        name="reserve"
        inputMode="decimal"
        autoComplete="off"
        placeholder="e.g. 10"
        defaultValue={echoed ?? percent}
        error={state.status === "error" ? state.fieldErrors.reserve : undefined}
      />
      <Button type="submit" variant="secondary" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Save reserve"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}
