"use client";

import { useActionState, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { useTrayActionState, useTrayClose } from "@/components/ui/tray";
import { useToast } from "@/components/ui/toast";
import { SelectField } from "@/components/ui/select-field";
import { TextAreaField } from "@/components/ui/text-area-field";
import { TextField } from "@/components/ui/text-field";
import {
  saveGuest,
  saveHousehold,
  setGuestArchived,
  type GuestActionState,
} from "@/server/guests/actions";

const idle: GuestActionState = { status: "idle" };

function Feedback({ state }: { state: GuestActionState }) {
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

export type GuestFormValues = {
  fullName: string;
  email: string;
  phone: string;
  household: string;
  tags: string;
  ageGroup: string;
  dietary: string;
  accessibility: string;
  notes: string;
};
export const emptyGuest: GuestFormValues = {
  fullName: "",
  email: "",
  phone: "",
  household: "",
  tags: "",
  ageGroup: "",
  dietary: "",
  accessibility: "",
  notes: "",
};

/**
 * Add or edit one guest. Private fields are only rendered when `showPrivate` is true (the
 * server also refuses to read them otherwise).
 */
export function GuestForm({
  workspaceId,
  householdNames,
  initial = emptyGuest,
  guest,
  showPrivate,
  submitLabel,
  quick = false,
}: {
  workspaceId: string;
  householdNames: readonly string[];
  initial?: GuestFormValues;
  guest?: { id: string; version: number };
  showPrivate: boolean;
  submitLabel: string;
  /**
   * Fast entry for a new guest: only name and household up front, the rest under "More
   * details", focus back on Name after each save, and an Undo toast instead of inline text.
   */
  quick?: boolean;
}) {
  // Fast entry keeps its sheet open (modal), so confirmation and Undo live inside it.
  const closeTray = useTrayClose();
  const { toast } = useToast();
  const [added, setAdded] = useState<{ id: string; message: string; undone: boolean } | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);
  const [created, setCreated] = useState(0);
  const [keyBase] = useState(() => crypto.randomUUID());
  const listId = useId();
  const [state, formAction, pending] = useActionState(
    async (prev: GuestActionState, form: FormData) => {
      if (quick) {
        setAdded(null);
        setUndoError(null);
      }
      const next = await saveGuest(prev, form);
      if (next.status === "ok" && guest) {
        closeTray();
        toast({ message: next.message });
      }
      if (next.status === "ok" && !guest) {
        setCreated((n) => n + 1);
        if (quick) {
          setUndoError(null);
          setAdded(next.id ? { id: next.id, message: next.message, undone: false } : null);
        }
      }
      return next;
    },
    idle,
  );
  async function undoAdd() {
    if (!added) return;
    const undo = new FormData();
    undo.set("workspaceId", workspaceId);
    undo.set("guestId", added.id);
    undo.set("version", "1");
    undo.set("archived", "true");
    const result = await setGuestArchived({ status: "idle" }, undo);
    if (result.status === "error") setUndoError(result.message);
    else setAdded({ ...added, undone: true });
  }
  const echoed = state.status === "error" ? state.values : undefined;
  const errors = state.status === "error" ? state.fieldErrors : {};
  const v = (k: keyof GuestFormValues) => echoed?.[k] ?? initial[k];
  const moreHasError = [
    "email",
    "phone",
    "ageGroup",
    "tags",
    "dietary",
    "accessibility",
    "notes",
  ].some((k) => Boolean(errors[k]));
  return (
    <form action={formAction} className="space-y-4" noValidate key={guest ? "edit" : created}>
      <Hidden
        values={{
          workspaceId,
          ...(guest
            ? { guestId: guest.id, version: guest.version }
            : { idempotencyKey: `${keyBase}-${created}` }),
        }}
      />
      <TextField
        label="Name"
        name="fullName"
        required
        autoFocus={quick}
        maxLength={120}
        autoComplete="off"
        defaultValue={v("fullName")}
        error={errors.fullName}
      />
      <TextField
        label="Household"
        hint="People in the same household are invited together. Type a new name or pick an existing one."
        name="household"
        list={listId}
        maxLength={120}
        autoComplete="off"
        defaultValue={v("household")}
        error={errors.household}
      />
      <datalist id={listId}>
        {householdNames.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      {quick ? (
        <details
          open={moreHasError || undefined}
          className="group rounded-card border border-border-hairline"
        >
          <summary className="flex min-h-11 cursor-pointer items-center px-4 text-label-lg font-semibold text-action-emphasis">
            <span className="group-open:hidden">More details</span>
            <span className="hidden group-open:inline">Fewer details</span>
          </summary>
          <div className="space-y-4 px-4 pb-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="Email"
                name="email"
                type="email"
                maxLength={254}
                autoComplete="off"
                defaultValue={v("email")}
                error={errors.email}
              />
              <TextField
                label="Phone"
                name="phone"
                type="tel"
                maxLength={30}
                autoComplete="off"
                defaultValue={v("phone")}
                error={errors.phone}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                key={`age:${v("ageGroup")}`}
                label="Adult or child"
                name="ageGroup"
                defaultValue={v("ageGroup")}
                error={errors.ageGroup}
              >
                <option value="">Not set</option>
                <option value="adult">Adult</option>
                <option value="child">Child</option>
              </SelectField>
              <TextField
                label="Tags"
                hint="Separate with commas, for example Family, College friends."
                name="tags"
                autoComplete="off"
                defaultValue={v("tags")}
                error={errors.tags}
              />
            </div>
            {showPrivate && (
              <fieldset className="space-y-4 rounded-card border border-border-hairline p-4">
                <legend className="px-2 text-label-lg font-semibold">Private details</legend>
                <p className="text-body-sm text-ink-muted">
                  Only people with access to private details (the owner and partner by default) can
                  see these. They are left out of exports and are never shown to guests.
                </p>
                <TextAreaField
                  label="Dietary needs or allergies"
                  name="dietary"
                  rows={2}
                  maxLength={500}
                  defaultValue={v("dietary")}
                  error={errors.dietary}
                />
                <TextAreaField
                  label="Accessibility needs"
                  name="accessibility"
                  rows={2}
                  maxLength={500}
                  defaultValue={v("accessibility")}
                  error={errors.accessibility}
                />
                <TextAreaField
                  label="Private notes"
                  name="notes"
                  rows={2}
                  maxLength={500}
                  defaultValue={v("notes")}
                  error={errors.notes}
                />
              </fieldset>
            )}
          </div>
        </details>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Email"
              name="email"
              type="email"
              maxLength={254}
              autoComplete="off"
              defaultValue={v("email")}
              error={errors.email}
            />
            <TextField
              label="Phone"
              name="phone"
              type="tel"
              maxLength={30}
              autoComplete="off"
              defaultValue={v("phone")}
              error={errors.phone}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              key={`age:${v("ageGroup")}`}
              label="Adult or child"
              name="ageGroup"
              defaultValue={v("ageGroup")}
              error={errors.ageGroup}
            >
              <option value="">Not set</option>
              <option value="adult">Adult</option>
              <option value="child">Child</option>
            </SelectField>
            <TextField
              label="Tags"
              hint="Separate with commas, for example Family, College friends."
              name="tags"
              autoComplete="off"
              defaultValue={v("tags")}
              error={errors.tags}
            />
          </div>
          {showPrivate && (
            <fieldset className="space-y-4 rounded-card border border-border-hairline p-4">
              <legend className="px-2 text-label-lg font-semibold">Private details</legend>
              <p className="text-body-sm text-ink-muted">
                Only people with access to private details (the owner and partner by default) can
                see these. They are left out of exports and are never shown to guests.
              </p>
              <TextAreaField
                label="Dietary needs or allergies"
                name="dietary"
                rows={2}
                maxLength={500}
                defaultValue={v("dietary")}
                error={errors.dietary}
              />
              <TextAreaField
                label="Accessibility needs"
                name="accessibility"
                rows={2}
                maxLength={500}
                defaultValue={v("accessibility")}
                error={errors.accessibility}
              />
              <TextAreaField
                label="Private notes"
                name="notes"
                rows={2}
                maxLength={500}
                defaultValue={v("notes")}
                error={errors.notes}
              />
            </fieldset>
          )}
        </>
      )}
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : submitLabel}
      </Button>
      {quick ? (
        <div aria-live="polite" className="min-h-11">
          {state.status === "error" && (
            <p role="alert" className="text-body-md text-danger">
              {state.message}
            </p>
          )}
          {added && state.status === "ok" && (
            <p className="flex flex-wrap items-center gap-x-3 text-body-md text-action-secondary">
              <span>{added.undone ? "Removed. You can add them again." : added.message}</span>
              {!added.undone && (
                <button
                  type="button"
                  onClick={undoAdd}
                  className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4"
                >
                  Undo
                </button>
              )}
            </p>
          )}
          {undoError && (
            <p role="alert" className="text-body-md text-danger">
              {undoError}
            </p>
          )}
        </div>
      ) : (
        <Feedback state={state} />
      )}
    </form>
  );
}

export function ArchiveGuestForm({
  workspaceId,
  guestId,
  version,
  archived,
  name,
}: {
  workspaceId: string;
  guestId: string;
  version: number;
  archived: boolean;
  name: string;
}) {
  const [state, formAction, pending] = useTrayActionState(setGuestArchived, idle);
  return (
    <form action={formAction} className="space-y-2">
      <Hidden values={{ workspaceId, guestId, version, archived: String(!archived) }} />
      <p className="text-body-sm text-ink-muted">
        {archived
          ? "Restoring puts this person back on your guest list."
          : "Archiving removes this person from your counts but keeps their record."}
      </p>
      <Button type="submit" variant="outline" disabled={pending}>
        {archived ? `Restore ${name}` : `Archive ${name}`}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function HouseholdForm({
  workspaceId,
  household,
}: {
  workspaceId: string;
  household: { id: string; version: number; name: string; address: string; notes: string };
}) {
  const [state, formAction, pending] = useTrayActionState(saveHousehold, idle);
  const echoed = state.status === "error" ? state.values : undefined;
  const errors = state.status === "error" ? state.fieldErrors : {};
  const v = (k: "name" | "address" | "notes") => echoed?.[k] ?? household[k];
  return (
    <form action={formAction} className="space-y-4" noValidate key={household.version}>
      <Hidden values={{ workspaceId, householdId: household.id, version: household.version }} />
      <TextField
        label="Household name"
        name="name"
        required
        maxLength={120}
        autoComplete="off"
        defaultValue={v("name")}
        error={errors.name}
      />
      <TextAreaField
        label="Mailing address"
        hint="Private. Used for invitations by post."
        name="address"
        rows={2}
        maxLength={300}
        defaultValue={v("address")}
        error={errors.address}
      />
      <TextAreaField
        label="Household notes"
        name="notes"
        rows={2}
        maxLength={500}
        defaultValue={v("notes")}
        error={errors.notes}
      />
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save household"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}
