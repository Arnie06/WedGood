"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextAreaField } from "@/components/ui/text-area-field";
import { TextField } from "@/components/ui/text-field";
import type { TimelineFormValues } from "@/domain/timeline/timeline";
import {
  createTimelineItem,
  deleteTimelineItem,
  updateTimelineItem,
  type TimelineActionState,
} from "@/server/timeline/actions";

const idle: TimelineActionState = { status: "idle" };

export type Option = { id: string; label: string };

function Status({ state }: { state: TimelineActionState }) {
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

const EMPTY: TimelineFormValues = {
  title: "",
  date: "",
  startTime: "",
  endDate: "",
  endTime: "",
  location: "",
  responsibleLabel: "",
  contact: "",
  notes: "",
  assignee: "",
  vendor: "",
  status: "scheduled",
};

/** Create and edit share one form. Times are wall-clock in the wedding's time zone. */
export function AgendaItemForm({
  mode,
  hidden,
  defaults,
  members,
  vendors,
  timezoneLabel,
}: {
  mode: "create" | "edit";
  hidden: Record<string, string>;
  defaults?: TimelineFormValues;
  members: readonly Option[];
  vendors: readonly Option[];
  timezoneLabel: string;
}) {
  const [created, setCreated] = useState(0);
  const [state, action, pending] = useActionState(
    async (prev: TimelineActionState, form: FormData) => {
      const next =
        mode === "create"
          ? await createTimelineItem(prev, form)
          : await updateTimelineItem(prev, form);
      if (mode === "create" && next.status === "ok") setCreated((n) => n + 1);
      return next;
    },
    idle,
  );
  const base = defaults ?? EMPTY;
  const echoed = state.status === "error" ? state.values : undefined;
  const errors = state.status === "error" ? state.fieldErrors : {};
  const v = (k: keyof TimelineFormValues) => echoed?.[k] ?? base[k];
  // After a successful create the form remounts empty, with a fresh idempotency key.
  const key = `${hidden.idempotencyKey ?? ""}-${created}`;

  return (
    <form
      key={mode === "create" ? created : undefined}
      action={action}
      className="space-y-5"
      noValidate
    >
      {Object.entries(hidden).map(([name, value]) =>
        name === "idempotencyKey" ? null : (
          <input key={name} type="hidden" name={name} value={value} />
        ),
      )}
      {mode === "create" && <input type="hidden" name="idempotencyKey" value={key} />}
      <TextField
        label="What happens"
        name="title"
        required
        maxLength={160}
        autoComplete="off"
        placeholder="Ceremony begins"
        defaultValue={v("title")}
        error={errors.title}
      />
      <div className="grid gap-5 sm:grid-cols-2">
        <TextField
          label="Date"
          name="date"
          type="date"
          required
          defaultValue={v("date")}
          error={errors.date}
        />
        <TextField
          label="Starts"
          hint={`Local time, ${timezoneLabel}`}
          name="startTime"
          type="time"
          required
          defaultValue={v("startTime")}
          error={errors.startTime}
        />
        <TextField
          label="Ends (optional)"
          name="endTime"
          type="time"
          defaultValue={v("endTime")}
          error={errors.endTime}
        />
        <TextField
          label="End date (optional)"
          hint="Only if it finishes on a different day, such as after midnight."
          name="endDate"
          type="date"
          defaultValue={v("endDate")}
          error={errors.endDate}
        />
      </div>
      <TextField
        label="Where (optional)"
        name="location"
        maxLength={200}
        autoComplete="off"
        defaultValue={v("location")}
        error={errors.location}
      />
      <div className="grid gap-5 sm:grid-cols-2">
        <SelectField label="Team member in charge" name="assignee" defaultValue={v("assignee")}>
          <option value="">No one yet</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </SelectField>
        <SelectField label="Venue or vendor" name="vendor" defaultValue={v("vendor")}>
          <option value="">None</option>
          {vendors.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Someone else in charge"
          hint="For example, your maid of honor."
          name="responsibleLabel"
          maxLength={120}
          autoComplete="off"
          defaultValue={v("responsibleLabel")}
          error={errors.responsibleLabel}
        />
        <TextField
          label="Contact"
          hint="A name and phone or email to reach on the day."
          name="contact"
          maxLength={200}
          autoComplete="off"
          defaultValue={v("contact")}
          error={errors.contact}
        />
      </div>
      <TextAreaField
        label="Notes"
        name="notes"
        maxLength={2000}
        defaultValue={v("notes")}
        error={errors.notes}
      />
      {mode === "edit" && (
        <SelectField label="Status" name="status" defaultValue={v("status")}>
          <option value="scheduled">Scheduled</option>
          <option value="cancelled">Cancelled</option>
        </SelectField>
      )}
      <Status state={state} />
      <Button type="submit" variant="primary" disabled={pending} className="w-full sm:w-auto">
        {pending ? "Saving…" : mode === "create" ? "Add to agenda" : "Save changes"}
      </Button>
    </form>
  );
}

export function DeleteAgendaItemForm({
  workspaceId,
  itemId,
  version,
}: {
  workspaceId: string;
  itemId: string;
  version: number;
}) {
  const [state, action, pending] = useActionState(deleteTimelineItem, idle);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="itemId" value={itemId} />
      <input type="hidden" name="version" value={version} />
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Removing…" : "Remove from agenda"}
      </Button>
      <Status state={state} />
    </form>
  );
}

export function PrintButton() {
  return (
    <Button type="button" variant="outline" onClick={() => window.print()} className="print:hidden">
      Print or save as PDF
    </Button>
  );
}
