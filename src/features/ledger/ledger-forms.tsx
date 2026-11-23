"use client";

import { useActionState, useState } from "react";
import { useTrayActionState } from "@/components/ui/tray";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextAreaField } from "@/components/ui/text-area-field";
import { TextField } from "@/components/ui/text-field";
import { ALLOCATION_ROWS, INSTALLMENT_ROWS } from "@/domain/ledger/input";
import {
  createInvoice,
  recordPayment,
  voidInvoice,
  voidPayment,
  type LedgerActionState,
} from "@/server/ledger/actions";

const idle: LedgerActionState = { status: "idle" };
/**
 * A form that clears after a save. The count of saves travels with the result, so the fresh form and
 * the "saved" message arrive in the same render and never pick up the values of an earlier refused try.
 */
type FormRun = { state: LedgerActionState; created: number };
type Action = (state: LedgerActionState, form: FormData) => Promise<LedgerActionState>;

function Feedback({ state }: { state: LedgerActionState }) {
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

// ---------------------------------------------------------------- booking and amendment

export type CostOption = { id: string; label: string };

/**
 * One form for booking and for amending. Nothing is recorded until the confirmation box is ticked,
 * and the server re-checks every figure.
 */
export function BookingForm({
  action,
  workspaceId,
  currency,
  costs,
  defaults,
  hidden,
  submitLabel,
  pendingLabel,
  confirmLabel,
}: {
  action: Action;
  workspaceId: string;
  currency: string;
  costs: readonly CostOption[];
  defaults: Record<string, string>;
  hidden: Record<string, string | number>;
  submitLabel: string;
  pendingLabel: string;
  confirmLabel: string;
}) {
  const [keyBase] = useState(() => crypto.randomUUID());
  const [state, formAction, pending] = useTrayActionState(action, idle);
  const echoed = state.status === "error" ? state.values : undefined;
  const errors = state.status === "error" ? state.fieldErrors : {};
  const v = (k: string) => echoed?.[k] ?? defaults[k] ?? "";
  const extraSchedule = Array.from({ length: INSTALLMENT_ROWS }, (_, n) => n)
    .slice(3)
    .some((n) => v(`dueOn${n}`) !== "" || v(`instAmount${n}`) !== "" || errors[`dueOn${n}`]);

  const scheduleRow = (n: number) => (
    <div key={n} className="grid gap-3 sm:grid-cols-3">
      <TextField
        label={`Due date ${n + 1}`}
        name={`dueOn${n}`}
        type="date"
        defaultValue={v(`dueOn${n}`)}
        error={errors[`dueOn${n}`]}
      />
      <TextField
        label={`Amount due (${currency})`}
        name={`instAmount${n}`}
        inputMode="decimal"
        autoComplete="off"
        placeholder={n === 0 ? "e.g. 2500" : undefined}
        defaultValue={v(`instAmount${n}`)}
        error={errors[`instAmount${n}`]}
      />
      <TextField
        label="Label"
        name={`instLabel${n}`}
        autoComplete="off"
        maxLength={80}
        placeholder={n === 0 ? "e.g. Deposit" : undefined}
        defaultValue={v(`instLabel${n}`)}
        error={errors[`instLabel${n}`]}
      />
    </div>
  );

  return (
    <form action={formAction} className="space-y-8" noValidate>
      <Hidden values={{ workspaceId, ...hidden }} />
      <input type="hidden" name="idempotencyKey" value={keyBase} />

      <div className="space-y-4">
        <TextField
          label="Name of this booking"
          name="title"
          required
          maxLength={160}
          autoComplete="off"
          placeholder="e.g. Venue contract"
          defaultValue={v("title")}
          error={errors.title}
        />
        <TextField
          label={`Total you're committing to (${currency})`}
          hint="The amount in the signed or agreed contract. Taxes and fees you know are included go here too."
          name="amount"
          required
          inputMode="decimal"
          autoComplete="off"
          placeholder="e.g. 12000"
          defaultValue={v("amount")}
          error={errors.amount}
        />
        <TextField
          label="Date signed or agreed"
          hint="Optional."
          name="signedOn"
          type="date"
          defaultValue={v("signedOn")}
          error={errors.signedOn}
        />
      </div>

      <fieldset className="space-y-4">
        <legend className="font-serif text-headline-sm">What it covers in your budget</legend>
        <p className="text-body-md text-ink-muted">
          Pick the planned costs this booking pays for, so it counts once in your forecast instead
          of on top of them. If you choose just one and leave the amount blank, it covers the whole
          total.
        </p>
        {Array.from({ length: ALLOCATION_ROWS }, (_, n) => (
          <div key={n} className="grid gap-3 sm:grid-cols-2">
            <SelectField
              // A refused submit resets selects to their first render; remount to keep the choice.
              key={`${n}:${v(`allocItem${n}`)}`}
              label={`Cost ${n + 1}`}
              name={`allocItem${n}`}
              defaultValue={v(`allocItem${n}`)}
              error={errors[`allocItem${n}`]}
            >
              <option value="">{n === 0 ? "Choose a cost" : "None"}</option>
              {costs.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </SelectField>
            <TextField
              label={`Amount (${currency})`}
              name={`allocAmount${n}`}
              inputMode="decimal"
              autoComplete="off"
              defaultValue={v(`allocAmount${n}`)}
              error={errors[`allocAmount${n}`]}
            />
          </div>
        ))}
        {costs.length === 0 && (
          <p className="text-body-md text-ink-muted">
            There are no free planned costs to attach. Add one on the budget page first.
          </p>
        )}
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="font-serif text-headline-sm">Payment schedule</legend>
        <p className="text-body-md text-ink-muted">
          When money is due. This is a plan, not a record of payment. You&apos;ll record each
          payment once it&apos;s made.
        </p>
        {[0, 1, 2].map(scheduleRow)}
        <details open={extraSchedule}>
          <summary className="min-h-11 cursor-pointer py-2 text-label-lg font-semibold text-action-emphasis">
            More due dates
          </summary>
          <div className="mt-3 space-y-4">{[3, 4, 5].map(scheduleRow)}</div>
        </details>
      </fieldset>

      <div className="space-y-2">
        <label className="flex min-h-11 items-start gap-3 text-body-md">
          <input
            type="checkbox"
            name="confirm"
            value="yes"
            defaultChecked={v("confirm") === "yes"}
            aria-invalid={errors.confirm ? true : undefined}
            className="mt-1 size-5 shrink-0 accent-action-secondary"
          />
          <span>{confirmLabel}</span>
        </label>
        {errors.confirm && (
          <p role="alert" className="text-body-sm text-danger">
            {errors.confirm}
          </p>
        )}
      </div>
      <p className="text-body-sm text-ink-muted">
        This only records your booking here. Nothing is sent to the vendor and no money moves.
      </p>
      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? pendingLabel : submitLabel}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

// ---------------------------------------------------------------- payments

/** Records a payment or refund that already happened. Target: a booking, or a choice of unbooked costs. */
export function PaymentForm({
  workspaceId,
  commitmentId,
  costs,
  invoices,
  currency,
  today,
  idPrefix,
}: {
  workspaceId: string;
  commitmentId?: string;
  costs?: readonly CostOption[];
  /** Invoices on this booking a payment can name. Only offered on a booking. */
  invoices?: readonly CostOption[];
  currency: string;
  today: string;
  idPrefix: string;
}) {
  const [keyBase] = useState(() => crypto.randomUUID());
  const [{ state, created }, formAction, pending] = useActionState(
    async (prev: FormRun, form: FormData): Promise<FormRun> => {
      const next = await recordPayment(prev.state, form);
      return { state: next, created: next.status === "ok" ? prev.created + 1 : prev.created };
    },
    { state: idle, created: 0 },
  );
  const echoed = state.status === "error" ? state.values : undefined;
  const errors = state.status === "error" ? state.fieldErrors : {};
  const v = (k: string, d = "") => echoed?.[k] ?? d;
  return (
    <form action={formAction} className="space-y-4" noValidate key={`${idPrefix}-${created}`}>
      <Hidden values={{ workspaceId }} />
      {commitmentId && <input type="hidden" name="commitmentId" value={commitmentId} />}
      <input type="hidden" name="idempotencyKey" value={`${keyBase}-${created}`} />
      {!commitmentId && (
        <SelectField
          key={`item:${v("itemId")}`}
          label="Which cost?"
          name="itemId"
          required
          defaultValue={v("itemId")}
          error={errors.itemId}
        >
          <option value="">Choose a cost</option>
          {(costs ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </SelectField>
      )}
      <SelectField
        key={`kind:${v("kind", "charge")}`}
        label="What happened?"
        name="kind"
        defaultValue={v("kind", "charge")}
        error={errors.kind}
      >
        <option value="charge">I paid money</option>
        <option value="refund">I got money back (refund)</option>
      </SelectField>
      {commitmentId && invoices && invoices.length > 0 && (
        <SelectField
          key={`invoice:${v("invoiceId")}`}
          label="Which invoice is this paying?"
          hint="Optional. Only for money you paid, not for a refund."
          name="invoiceId"
          defaultValue={v("invoiceId")}
          error={errors.invoiceId}
        >
          <option value="">Not for a specific invoice</option>
          {invoices.map((i) => (
            <option key={i.id} value={i.id}>
              {i.label}
            </option>
          ))}
        </SelectField>
      )}
      <TextField
        label={`Amount (${currency})`}
        name="amount"
        required
        inputMode="decimal"
        autoComplete="off"
        placeholder="e.g. 2500"
        defaultValue={v("amount")}
        error={errors.amount}
      />
      <TextField
        label="Date the money moved"
        hint="Only record money that has already moved."
        name="paidOn"
        type="date"
        required
        max={today}
        defaultValue={v("paidOn", today)}
        error={errors.paidOn}
      />
      <TextField
        label="How you paid"
        hint="Optional, like “Visa ending 4242” or “check”. Don't enter full card or account numbers."
        name="method"
        autoComplete="off"
        maxLength={60}
        defaultValue={v("method")}
        error={errors.method}
      />
      <TextField
        label="Receipt or confirmation number"
        hint="Optional. Recording the same number twice is refused, which protects against double entry."
        name="externalRef"
        autoComplete="off"
        maxLength={120}
        defaultValue={v("externalRef")}
        error={errors.externalRef}
      />
      <TextAreaField
        label="Note"
        name="note"
        rows={2}
        maxLength={500}
        defaultValue={v("note")}
        error={errors.note}
      />
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "Recording…" : "Record this"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function VoidPaymentForm({
  workspaceId,
  paymentId,
}: {
  workspaceId: string;
  paymentId: string;
}) {
  const [state, formAction, pending] = useTrayActionState(voidPayment, idle);
  const echoed = state.status === "error" ? state.values.reason : undefined;
  return (
    <form action={formAction} className="space-y-3" noValidate>
      <Hidden values={{ workspaceId, paymentId }} />
      <TextField
        label="Why was this a mistake?"
        hint="It stays in the history, marked as entered by mistake, and no longer counts."
        name="reason"
        required
        maxLength={200}
        autoComplete="off"
        defaultValue={echoed ?? ""}
        error={state.status === "error" ? state.fieldErrors.reason : undefined}
      />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Mark as entered by mistake"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

// ---------------------------------------------------------------- invoices

/** Records an invoice the vendor sent. It does not change the contract or the budget forecast. */
export function InvoiceForm({
  workspaceId,
  commitmentId,
  currency,
  idPrefix,
}: {
  workspaceId: string;
  commitmentId: string;
  currency: string;
  idPrefix: string;
}) {
  const [keyBase] = useState(() => crypto.randomUUID());
  const [{ state, created }, formAction, pending] = useActionState(
    async (prev: FormRun, form: FormData): Promise<FormRun> => {
      const next = await createInvoice(prev.state, form);
      return { state: next, created: next.status === "ok" ? prev.created + 1 : prev.created };
    },
    { state: idle, created: 0 },
  );
  const echoed = state.status === "error" ? state.values : undefined;
  const errors = state.status === "error" ? state.fieldErrors : {};
  const v = (k: string) => echoed?.[k] ?? "";
  return (
    <form action={formAction} className="space-y-4" noValidate key={`${idPrefix}-${created}`}>
      <Hidden values={{ workspaceId, commitmentId }} />
      <input type="hidden" name="idempotencyKey" value={`${keyBase}-${created}`} />
      <TextField
        label={`Amount on the invoice (${currency})`}
        name="amount"
        required
        inputMode="decimal"
        autoComplete="off"
        placeholder="e.g. 6000"
        defaultValue={v("amount")}
        error={errors.amount}
      />
      <TextField
        label="Invoice number"
        hint="Optional. The same number twice on one booking is refused, which protects against double entry."
        name="number"
        autoComplete="off"
        maxLength={60}
        defaultValue={v("number")}
        error={errors.number}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Date issued"
          hint="Optional."
          name="issuedOn"
          type="date"
          defaultValue={v("issuedOn")}
          error={errors.issuedOn}
        />
        <TextField
          label="Due date"
          hint="Optional."
          name="dueOn"
          type="date"
          defaultValue={v("dueOn")}
          error={errors.dueOn}
        />
      </div>
      <TextAreaField
        label="Note"
        name="note"
        rows={2}
        maxLength={500}
        defaultValue={v("note")}
        error={errors.note}
      />
      <p className="text-body-sm text-ink-muted">
        An invoice is a request for money. It doesn&apos;t change what you&apos;ve committed to, and
        it isn&apos;t a payment.
      </p>
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "Adding…" : "Add this invoice"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function VoidInvoiceForm({
  workspaceId,
  invoiceId,
}: {
  workspaceId: string;
  invoiceId: string;
}) {
  const [state, formAction, pending] = useTrayActionState(voidInvoice, idle);
  const echoed = state.status === "error" ? state.values.reason : undefined;
  return (
    <form action={formAction} className="space-y-3" noValidate>
      <Hidden values={{ workspaceId, invoiceId }} />
      <TextField
        label="Why was this a mistake?"
        hint="It stays in the history, marked as entered by mistake, and no longer counts. Payments that named it stay as payments on the booking."
        name="reason"
        required
        maxLength={200}
        autoComplete="off"
        defaultValue={echoed ?? ""}
        error={state.status === "error" ? state.fieldErrors.reason : undefined}
      />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Mark as entered by mistake"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}
