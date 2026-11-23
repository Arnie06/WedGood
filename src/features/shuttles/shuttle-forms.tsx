"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextAreaField } from "@/components/ui/text-area-field";
import { TextField } from "@/components/ui/text-field";
import { useTrayActionState } from "@/components/ui/tray";
import {
  DIRECTION_LABELS,
  MAX_RUN_SEATS,
  SHUTTLE_DIRECTIONS,
  type ShuttleDirection,
  type ShuttleRunField,
} from "@/domain/shuttles/shuttles";
import { Feedback, Hidden } from "@/features/events/event-forms";
import type { EventActionState } from "@/server/events/actions";
import {
  addShuttleRun,
  assignShuttleRiders,
  removeShuttleRun,
  unassignShuttleRider,
  updateShuttleRun,
} from "@/server/shuttles/actions";

const idle: EventActionState = { status: "idle" };
const errorOf = (s: EventActionState, f: string) =>
  s.status === "error" ? s.fieldErrors[f] : undefined;
const valueOf = (s: EventActionState, f: string, fallback: string) =>
  s.status === "error" ? (s.values[f] ?? fallback) : fallback;

type RunFormProps = {
  workspaceId: string;
  eventId: string;
  /** "CDT", shown next to the time so nobody guesses which clock it is. */
  zoneLabel: string;
  initial: Record<ShuttleRunField, string>;
  /** Present when editing; direction is then fixed. */
  run?: { id: string; version: number } | undefined;
};

/** Add or edit one shuttle. Times are in the event's own time zone. */
export function ShuttleRunForm({ workspaceId, eventId, zoneLabel, initial, run }: RunFormProps) {
  const [state, action, pending] = useTrayActionState(run ? updateShuttleRun : addShuttleRun, idle);
  const v = (f: ShuttleRunField) => valueOf(state, f, initial[f]);
  return (
    <form action={action} className="space-y-4" noValidate>
      <Hidden
        values={{
          workspaceId,
          eventId,
          ...(run && { runId: run.id, version: run.version }),
        }}
      />
      {run ? (
        <>
          <input type="hidden" name="direction" value={initial.direction} />
          <p className="text-body-md">
            <span className="font-semibold">Direction:</span>{" "}
            {DIRECTION_LABELS[initial.direction as ShuttleDirection] ?? ""}
            <span className="block text-body-sm text-ink-muted">
              To change direction, add a new shuttle and remove this one.
            </span>
          </p>
        </>
      ) : (
        <SelectField
          name="direction"
          label="Direction"
          defaultValue={v("direction")}
          error={errorOf(state, "direction")}
          required
        >
          {SHUTTLE_DIRECTIONS.map((d) => (
            <option key={d} value={d}>
              {DIRECTION_LABELS[d]}
            </option>
          ))}
        </SelectField>
      )}
      <TextField
        name="label"
        label="Name"
        hint="Something your driver and guests will recognise, such as Hotel shuttle 1."
        defaultValue={v("label")}
        error={errorOf(state, "label")}
        maxLength={60}
        required
      />
      <TextField
        name="pickup"
        label="Pickup point"
        defaultValue={v("pickup")}
        error={errorOf(state, "pickup")}
        maxLength={200}
        required
      />
      <TextField
        name="dropoff"
        label="Drop-off point"
        defaultValue={v("dropoff")}
        error={errorOf(state, "dropoff")}
        maxLength={200}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="date"
          type="date"
          label="Date"
          defaultValue={v("date")}
          error={errorOf(state, "date")}
          required
        />
        <TextField
          name="time"
          type="time"
          label={`Departs (${zoneLabel})`}
          defaultValue={v("time")}
          error={errorOf(state, "time")}
          required
        />
      </div>
      <TextField
        name="capacity"
        label="Seats"
        inputMode="numeric"
        hint={`Guest seats on this vehicle, 1 to ${MAX_RUN_SEATS}.`}
        defaultValue={v("capacity")}
        error={errorOf(state, "capacity")}
        required
      />
      <TextAreaField
        name="notes"
        label="Notes for the driver or coordinator"
        hint="Visible to people who manage guests. Don't put guests' private details here."
        defaultValue={v("notes")}
        error={errorOf(state, "notes")}
        maxLength={500}
        rows={3}
      />
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : run ? "Save shuttle" : "Add shuttle"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function RemoveShuttleForm({
  workspaceId,
  run,
}: {
  workspaceId: string;
  run: { id: string; version: number; label: string; riders: number };
}) {
  const [state, action, pending] = useTrayActionState(removeShuttleRun, idle);
  return (
    <form action={action} className="space-y-4">
      <Hidden values={{ workspaceId, runId: run.id, version: run.version }} />
      <p className="text-body-md">
        {run.riders === 0
          ? `No one is on ${run.label} yet.`
          : `${run.riders} ${run.riders === 1 ? "guest is" : "guests are"} on ${run.label}. They will need another ride.`}
      </p>
      <Button type="submit" variant="emphasis" disabled={pending}>
        {pending ? "Removing…" : `Remove ${run.label}`}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export type RiderChoice = {
  id: string;
  name: string;
  household: string | null;
  /** The other shuttle this guest takes the same way, if any (choosing them moves them). */
  currentRun: string | null;
};

/** Checkbox list: a non-drag way to put several guests (a household) on one shuttle at once. */
export function AddRidersForm({
  workspaceId,
  run,
  choices,
}: {
  workspaceId: string;
  run: { id: string; label: string; open: number };
  choices: RiderChoice[];
}) {
  const [state, action, pending] = useTrayActionState(assignShuttleRiders, idle);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string, on: boolean) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const over = chosen.size > run.open;
  const without = choices.filter((c) => c.currentRun === null);
  const moving = choices.filter((c) => c.currentRun !== null);

  const row = (c: RiderChoice) => (
    <li key={c.id}>
      <label className="flex min-h-11 items-start gap-3 py-1 text-body-md">
        <input
          type="checkbox"
          name="guestIds"
          value={c.id}
          checked={chosen.has(c.id)}
          onChange={(e) => toggle(c.id, e.target.checked)}
          className="mt-1 size-5 shrink-0 accent-action-secondary"
        />
        <span>
          {c.name}
          {(c.household || c.currentRun) && (
            <span className="block text-body-sm text-ink-muted">
              {[c.household, c.currentRun && `Now on ${c.currentRun}; choosing moves them`]
                .filter(Boolean)
                .join(" · ")}
            </span>
          )}
        </span>
      </label>
    </li>
  );

  if (choices.length === 0) {
    return (
      <p className="text-body-md">
        Everyone attending already has a seat on this shuttle. Guests appear here once they accept
        the invitation.
      </p>
    );
  }

  return (
    <form action={action} className="space-y-4">
      <Hidden values={{ workspaceId, runId: run.id }} />
      <p className="text-body-md" aria-live="polite">
        {run.open} {run.open === 1 ? "seat" : "seats"} open. {chosen.size} chosen.
      </p>
      {without.length > 0 && (
        <fieldset className="space-y-1">
          <legend className="text-label-lg font-semibold">No ride this way yet</legend>
          <ul>{without.map(row)}</ul>
        </fieldset>
      )}
      {moving.length > 0 && (
        <details open={without.length === 0}>
          <summary className="min-h-11 cursor-pointer py-2 text-label-lg font-semibold text-action-emphasis">
            Guests on another shuttle ({moving.length})
          </summary>
          <ul className="mt-2">{moving.map(row)}</ul>
        </details>
      )}
      {over && (
        <p className="text-body-md text-danger">
          That&apos;s more guests than open seats. Choose fewer, or add seats to this shuttle first.
        </p>
      )}
      <Button type="submit" disabled={pending || chosen.size === 0 || over || chosen.size > 20}>
        {pending ? "Adding…" : `Add ${chosen.size === 0 ? "" : `${chosen.size} `}to ${run.label}`}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function TakeOffButton({
  workspaceId,
  runId,
  guest,
  runLabel,
}: {
  workspaceId: string;
  runId: string;
  guest: { id: string; name: string };
  runLabel: string;
}) {
  const [state, action, pending] = useTrayActionState(unassignShuttleRider, idle);
  return (
    <form action={action} className="shrink-0">
      <Hidden values={{ workspaceId, runId, guestId: guest.id }} />
      <Button type="submit" variant="quiet" size="sm" disabled={pending}>
        Take off
        <span className="sr-only">
          {" "}
          {guest.name} from {runLabel}
        </span>
      </Button>
      {state.status === "error" && (
        <p role="alert" className="text-body-sm text-danger">
          {state.message}
        </p>
      )}
    </form>
  );
}
