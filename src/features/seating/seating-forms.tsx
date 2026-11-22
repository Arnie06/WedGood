"use client";

import { useId, useState } from "react";
import { useTrayActionState } from "@/components/ui/tray";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextAreaField } from "@/components/ui/text-area-field";
import { TextField } from "@/components/ui/text-field";
import {
  ELEMENT_KINDS,
  freeCorner,
  type ElementKind,
  type FloorElement,
  type PlacedTable,
} from "@/domain/seating/floor";
import { Feedback, Hidden } from "@/features/events/event-forms";
import type { EventActionState } from "@/server/events/actions";
import {
  addSeatingElement,
  addTable,
  applySeatingSuggestion,
  finalizeLayout,
  placeTable,
  removeSeatingElement,
  removeTable,
  seatGuest,
  seatHousehold,
  setTableCaptain,
  setTentativeSeating,
  startSeatingPlan,
  unseatGuest,
  updateSeatingElement,
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
      <SelectField name="shape" label="Shape" defaultValue={valueOf(state, "shape", "round")}>
        <option value="round">Round</option>
        <option value="rectangle">Rectangular</option>
      </SelectField>
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
  table: {
    id: string;
    label: string;
    capacity: number;
    shape: "round" | "rectangle";
    notes: string | null;
    version: number;
  };
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
        <SelectField name="shape" label="Shape" defaultValue={valueOf(state, "shape", table.shape)}>
          <option value="round">Round</option>
          <option value="rectangle">Rectangular</option>
        </SelectField>
        <TextAreaField
          name="notes"
          label="Notes (optional)"
          hint="For example, near the dance floor. Shown here only."
          defaultValue={valueOf(state, "notes", table.notes ?? "")}
          error={errorOf(state, "notes")}
          maxLength={300}
          rows={2}
        />
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

/** Pick the table captain from the guests seated at the table, or choose no one to clear it. */
export function CaptainForm({
  workspaceId,
  tableId,
  tableLabel,
  captainId,
  seated,
}: {
  workspaceId: string;
  tableId: string;
  tableLabel: string;
  captainId: string | null;
  seated: { id: string; name: string }[];
}) {
  const [state, action, pending] = useTrayActionState(setTableCaptain, idle);
  return (
    <form action={action} className="space-y-3" noValidate>
      <Hidden values={{ workspaceId, tableId }} />
      <SelectField
        name="guestId"
        label="Table captain"
        hint="Someone seated here who looks after the table."
        defaultValue={captainId ?? ""}
        disabled={seated.length === 0}
      >
        <option value="">No captain</option>
        {seated.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </SelectField>
      <Button type="submit" variant="secondary" disabled={pending || seated.length === 0}>
        Save captain<span className="sr-only"> for {tableLabel}</span>
      </Button>
      <Feedback state={state} />
    </form>
  );
}

/** Seats a household, or a guest with their plus-one, at one table in a single step. */
export function SeatGroupForm({
  workspaceId,
  layoutId,
  groupLabel,
  guests,
  tables,
}: {
  workspaceId: string;
  layoutId: string;
  groupLabel: string;
  guests: { id: string; name: string }[];
  tables: TableChoice[];
}) {
  const [state, action, pending] = useTrayActionState(seatHousehold, idle);
  const selectId = useId();
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <Hidden values={{ workspaceId, layoutId }} />
      {guests.map((g) => (
        <input key={g.id} type="hidden" name="guestIds" value={g.id} />
      ))}
      <div className="min-w-40 flex-1">
        <label htmlFor={selectId} className="block text-body-sm text-ink-muted">
          Table<span className="sr-only"> for {groupLabel}</span>
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
          {tables.map((t) => (
            <option key={t.id} value={t.id} disabled={t.open < guests.length}>
              {t.label} (
              {t.open < guests.length ? `needs ${guests.length} seats` : `${t.open} open`})
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" variant="secondary" disabled={pending}>
        Seat together<span className="sr-only">: {groupLabel}</span>
      </Button>
      <div className="basis-full">
        <Feedback state={state} />
      </div>
    </form>
  );
}

/**
 * Applies the suggestion shown above it, exactly as reviewed: the placements and the plan revision they
 * were made against travel with the form, and the database refuses the lot if the plan has moved on.
 */
export function ApplySuggestionForm({
  workspaceId,
  layoutId,
  revision,
  placements,
  count,
}: {
  workspaceId: string;
  layoutId: string;
  revision: number;
  placements: { tableId: string; guestIds: string[] }[];
  count: number;
}) {
  const [state, action, pending] = useTrayActionState(applySeatingSuggestion, idle);
  return (
    <form action={action} className="space-y-2">
      <Hidden
        values={{ workspaceId, layoutId, revision, placements: JSON.stringify(placements) }}
      />
      <Button type="submit" variant="emphasis" disabled={pending}>
        Seat {count} {count === 1 ? "guest" : "guests"} this way
      </Button>
      <Feedback state={state} />
    </form>
  );
}

/** From a table: choose someone still to seat and put them here. */
export function SeatAtTableForm({
  workspaceId,
  layoutId,
  tableId,
  tableLabel,
  candidates,
}: {
  workspaceId: string;
  layoutId: string;
  tableId: string;
  tableLabel: string;
  candidates: { id: string; name: string }[];
}) {
  const [state, action, pending] = useTrayActionState(seatGuest, idle, { keepOpen: true });
  return (
    <form action={action} className="space-y-3" noValidate>
      <Hidden values={{ workspaceId, layoutId, tableId }} />
      <SelectField
        name="guestId"
        label="Seat a guest here"
        defaultValue=""
        disabled={candidates.length === 0}
      >
        <option value="" disabled>
          {candidates.length === 0 ? "Everyone has a seat" : "Choose a guest"}
        </option>
        {candidates.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </SelectField>
      <Button type="submit" variant="secondary" disabled={pending || candidates.length === 0}>
        Seat at {tableLabel}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

/** Accessible alternative to dragging a table: type where it goes. */
export function PlaceTableForm({
  workspaceId,
  tableId,
  tableLabel,
  x,
  y,
}: {
  workspaceId: string;
  tableId: string;
  tableLabel: string;
  x: number;
  y: number;
}) {
  const [state, action, pending] = useTrayActionState(placeTable, idle);
  return (
    <form action={action} className="space-y-3" noValidate>
      <Hidden values={{ workspaceId, tableId }} />
      <p className="text-body-sm text-ink-muted">
        Column 0 is the left wall and row 0 is the top wall; the room is 120 columns by 80 rows. You
        can also drag the table on the floor plan, or focus it and use the arrow keys.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="x"
          label="Column"
          inputMode="numeric"
          defaultValue={valueOf(state, "x", String(x))}
          error={errorOf(state, "x")}
          required
        />
        <TextField
          name="y"
          label="Row"
          inputMode="numeric"
          defaultValue={valueOf(state, "y", String(y))}
          error={errorOf(state, "y")}
          required
        />
      </div>
      <Button type="submit" variant="secondary" disabled={pending}>
        Move <span className="sr-only">{tableLabel} </span>to here
      </Button>
      <Feedback state={state} />
    </form>
  );
}

/** Adds a dance floor, stage, bar and so on. It lands in the first free spot; move it afterwards. */
export function AddElementForm({
  workspaceId,
  layoutId,
  tables,
  elements,
}: {
  workspaceId: string;
  layoutId: string;
  tables: PlacedTable[];
  elements: FloorElement[];
}) {
  const [state, action, pending] = useTrayActionState(addSeatingElement, idle);
  const [kind, setKind] = useState<ElementKind>("dance_floor");
  const spec = ELEMENT_KINDS.find((k) => k.kind === kind) ?? ELEMENT_KINDS[0]!;
  const spot = freeCorner({ w: spec.w, h: spec.h }, tables, elements);
  return (
    <form action={action} className="space-y-4" noValidate>
      <Hidden values={{ workspaceId, layoutId, x: spot.x, y: spot.y, w: spec.w, h: spec.h }} />
      <SelectField
        name="kind"
        label="What is it?"
        value={kind}
        onChange={(event) => setKind(event.target.value as ElementKind)}
        error={errorOf(state, "kind")}
      >
        {ELEMENT_KINDS.map((k) => (
          <option key={k.kind} value={k.kind}>
            {k.name}
          </option>
        ))}
      </SelectField>
      <TextField
        name="label"
        label="Name (optional)"
        hint={`Leave blank to call it "${spec.name}".`}
        defaultValue={valueOf(state, "label", "")}
        error={errorOf(state, "label")}
        maxLength={60}
      />
      <Button type="submit" disabled={pending}>
        Add to the room
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function EditElementForm({
  workspaceId,
  element,
}: {
  workspaceId: string;
  element: FloorElement & { version: number };
}) {
  const [state, action, pending] = useTrayActionState(updateSeatingElement, idle);
  const [removeState, removeAction, removing] = useTrayActionState(removeSeatingElement, idle);
  const hidden = { workspaceId, elementId: element.id, version: element.version };
  return (
    <div className="space-y-4">
      <form action={action} className="space-y-4" noValidate>
        <Hidden values={hidden} />
        <TextField
          name="label"
          label="Name"
          defaultValue={valueOf(state, "label", element.label)}
          error={errorOf(state, "label")}
          maxLength={60}
          required
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            name="w"
            label="Width"
            inputMode="numeric"
            defaultValue={valueOf(state, "w", String(element.w))}
            error={errorOf(state, "w")}
            required
          />
          <TextField
            name="h"
            label="Height"
            inputMode="numeric"
            defaultValue={valueOf(state, "h", String(element.h))}
            error={errorOf(state, "h")}
            required
          />
          <TextField
            name="x"
            label="Left edge (column)"
            inputMode="numeric"
            defaultValue={valueOf(state, "x", String(element.x))}
            error={errorOf(state, "x")}
            required
          />
          <TextField
            name="y"
            label="Top edge (row)"
            inputMode="numeric"
            defaultValue={valueOf(state, "y", String(element.y))}
            error={errorOf(state, "y")}
            required
          />
        </div>
        <p className="text-body-sm text-ink-muted">
          Sizes are in floor-plan units (the room is 120 by 80). It is a sketch, not to scale.
        </p>
        <Button type="submit" variant="secondary" disabled={pending}>
          Save {element.label}
        </Button>
        <Feedback state={state} />
      </form>
      <form action={removeAction} className="space-y-2">
        <Hidden values={hidden} />
        <Button type="submit" variant="outline" disabled={removing}>
          Remove {element.label}
        </Button>
        <Feedback state={removeState} />
      </form>
    </div>
  );
}
