"use client";

import { useId } from "react";
import { useTrayActionState } from "@/components/ui/tray";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { Feedback, Hidden } from "@/features/events/event-forms";
import type { EventActionState } from "@/server/events/actions";
import {
  addTable,
  finalizeLayout,
  removeTable,
  seatGuest,
  setTentativeSeating,
  startSeatingPlan,
  unseatGuest,
  updateTable,
} from "@/server/seating/actions";

const idle: EventActionState = { status: "idle" };
const errorOf = (s: EventActionState, f: string) =>
  s.status === "error" ? s.fieldErrors[f] : undefined;
const valueOf = (s: EventActionState, f: string, fallback: string) =>
  s.status === "error" ? (s.values[f] ?? fallback) : fallback;

export type TableChoice = { id: string; label: string; open: number };

export function StartPlanForm({ workspaceId, eventId }: { workspaceId: string; eventId: string }) {
  const [state, action, pending] = useTrayActionState(startSeatingPlan, idle);
  return (
    <form action={action} className="space-y-2">
      <Hidden values={{ workspaceId, eventId }} />
      <Button type="submit" disabled={pending}>
        Start the seating plan
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function TentativeToggle({
  workspaceId,
  layoutId,
  version,
  allow,
}: {
  workspaceId: string;
  layoutId: string;
  version: number;
  allow: boolean;
}) {
  const [state, action, pending] = useTrayActionState(setTentativeSeating, idle);
  return (
    <form action={action} className="space-y-2">
      <Hidden values={{ workspaceId, layoutId, version, allow: String(!allow) }} />
      <Button type="submit" variant="outline" disabled={pending}>
        {allow ? "Turn off tentative seating" : "Allow tentative seating"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function AddTableForm({ workspaceId, layoutId }: { workspaceId: string; layoutId: string }) {
  const [state, action, pending] = useTrayActionState(addTable, idle);
  return (
    <form action={action} className="space-y-4" noValidate>
      <Hidden values={{ workspaceId, layoutId }} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="label"
          label="Table name"
          defaultValue={valueOf(state, "label", "")}
          error={errorOf(state, "label")}
          maxLength={60}
          required
        />
        <TextField
          name="capacity"
          label="Seats"
          inputMode="numeric"
          defaultValue={valueOf(state, "capacity", "8")}
          error={errorOf(state, "capacity")}
          required
        />
      </div>
      <Button type="submit" disabled={pending}>
        Add table
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function EditTableForm({
  workspaceId,
  table,
}: {
  workspaceId: string;
  table: { id: string; label: string; capacity: number; version: number };
}) {
  const [state, action, pending] = useTrayActionState(updateTable, idle);
  const [removeState, removeAction, removing] = useTrayActionState(removeTable, idle);
  return (
    <div className="space-y-4">
      <form action={action} className="space-y-4" noValidate>
        <Hidden values={{ workspaceId, tableId: table.id, version: table.version }} />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            name="label"
            label="Table name"
            defaultValue={valueOf(state, "label", table.label)}
            error={errorOf(state, "label")}
            maxLength={60}
            required
          />
          <TextField
            name="capacity"
            label="Seats"
            inputMode="numeric"
            defaultValue={valueOf(state, "capacity", String(table.capacity))}
            error={errorOf(state, "capacity")}
            required
          />
        </div>
        <Button type="submit" variant="secondary" disabled={pending}>
          Save {table.label}
        </Button>
        <Feedback state={state} />
      </form>
      <form action={removeAction} className="space-y-2">
        <Hidden values={{ workspaceId, tableId: table.id, version: table.version }} />
        <p className="text-body-sm text-ink-muted">
          Removing a table puts its guests back in the list to seat. It doesn&apos;t change
          anyone&apos;s answer.
        </p>
        <Button type="submit" variant="outline" disabled={removing}>
          Remove {table.label}
        </Button>
        <Feedback state={removeState} />
      </form>
    </div>
  );
}

/** Accessible alternative to dragging: choose a table, then press the button. */
export function SeatForm({
  workspaceId,
  layoutId,
  guest,
  tables,
  currentTableId,
}: {
  workspaceId: string;
  layoutId: string;
  guest: { id: string; name: string };
  tables: TableChoice[];
  currentTableId?: string;
}) {
  const [state, action, pending] = useTrayActionState(seatGuest, idle);
  const selectId = useId();
  const choices = tables.filter((t) => t.id !== currentTableId);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <Hidden values={{ workspaceId, layoutId, guestId: guest.id }} />
      <div className="min-w-40 flex-1">
        <label htmlFor={selectId} className="block text-body-sm text-ink-muted">
          {currentTableId ? "Move" : "Table"}
          <span className="sr-only"> for {guest.name}</span>
        </label>
        <select
          id={selectId}
          name="tableId"
          defaultValue=""
          className="block min-h-11 w-full rounded-control border border-border-control bg-surface-sunken px-3 text-body-md text-ink focus-visible:border-focus"
        >
          <option value="" disabled>
            Choose a table
          </option>
          {choices.map((t) => (
            <option key={t.id} value={t.id} disabled={t.open === 0}>
              {t.label} ({t.open === 0 ? "full" : `${t.open} open`})
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" variant={currentTableId ? "outline" : "secondary"} disabled={pending}>
        {currentTableId ? "Move" : "Seat"}
        <span className="sr-only"> {guest.name}</span>
      </Button>
      <div className="basis-full">
        <Feedback state={state} />
      </div>
    </form>
  );
}

export function UnseatForm({
  workspaceId,
  layoutId,
  guest,
}: {
  workspaceId: string;
  layoutId: string;
  guest: { id: string; name: string };
}) {
  const [state, action, pending] = useTrayActionState(unseatGuest, idle);
  return (
    <form action={action}>
      <Hidden values={{ workspaceId, layoutId, guestId: guest.id }} />
      <Button type="submit" variant="quiet" disabled={pending}>
        Remove
        <span className="sr-only"> {guest.name} from the table</span>
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function FinalizeForm({
  workspaceId,
  layoutId,
  revision,
  label,
}: {
  workspaceId: string;
  layoutId: string;
  revision: number;
  label: string;
}) {
  const [state, action, pending] = useTrayActionState(finalizeLayout, idle);
  return (
    <form action={action} className="space-y-2">
      <Hidden values={{ workspaceId, layoutId, revision }} />
      <Button type="submit" variant="emphasis" disabled={pending}>
        {label}
      </Button>
      <Feedback state={state} />
    </form>
  );
}
