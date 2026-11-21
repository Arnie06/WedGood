"use client";

import { useActionState, useState } from "react";
import { useTrayActionState } from "@/components/ui/tray";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import { EVENT_KINDS, EVENT_KIND_LABELS } from "@/domain/events/event";
import {
  addMealOption,
  createInvitations,
  overrideResponse,
  reissueInvitation,
  setInvitationDelivery,
  revokeInvitation,
  saveEvent,
  setMealOptionActive,
  type EventActionState,
  type IssuedLink,
} from "@/server/events/actions";

const idle: EventActionState = { status: "idle" };

export function Feedback({ state }: { state: EventActionState }) {
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

export function Hidden({ values }: { values: Record<string, string | number> }) {
  return Object.entries(values).map(([name, value]) => (
    <input key={name} type="hidden" name={name} value={value} />
  ));
}

/** Links are shown once, right after they are created. Nothing is sent from here. */
export function LinkList({ links }: { links: IssuedLink[] }) {
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <ul className="space-y-3">
      {links.map((l) => (
        <li key={l.invitationId} className="rounded-card border border-border-hairline p-3">
          <p className="text-label-lg font-semibold">{l.label}</p>
          {l.url ? (
            <>
              <label
                className="mt-1 block text-body-sm text-ink-muted"
                htmlFor={`link-${l.invitationId}`}
              >
                Private link for {l.label}
              </label>
              <input
                id={`link-${l.invitationId}`}
                readOnly
                value={l.url}
                onFocus={(e) => e.currentTarget.select()}
                className="mt-1 min-h-11 w-full rounded-control border border-border-strong bg-surface px-3 text-body-sm"
              />
              <Button
                type="button"
                variant="secondary"
                className="mt-2"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(l.url ?? "");
                    setCopied(l.invitationId);
                  } catch {
                    setCopied(null);
                  }
                }}
              >
                {copied === l.invitationId ? "Copied" : "Copy link"}
              </Button>
            </>
          ) : (
            <p className="text-body-sm text-ink-muted">
              This request was already used. Links can&apos;t be shown again; use “New link” on the
              invitation.
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

export type EventFormValues = {
  name: string;
  kind: string;
  localDate: string;
  targetAttendance: string;
  capacity: string;
};
export const emptyEvent: EventFormValues = {
  name: "",
  kind: "reception",
  localDate: "",
  targetAttendance: "",
  capacity: "",
};

export function EventForm({
  workspaceId,
  initial = emptyEvent,
  event,
  submitLabel,
}: {
  workspaceId: string;
  initial?: EventFormValues;
  event?: { id: string; version: number };
  submitLabel: string;
}) {
  const [created, setCreated] = useState(0);
  const [keyBase] = useState(() => crypto.randomUUID());
  const [state, formAction, pending] = useActionState(
    async (prev: EventActionState, form: FormData) => {
      const next = await saveEvent(prev, form);
      if (next.status === "ok" && !event) setCreated((n) => n + 1);
      return next;
    },
    idle,
  );
  const echoed = state.status === "error" ? state.values : undefined;
  const errors = state.status === "error" ? state.fieldErrors : {};
  const v = (k: keyof EventFormValues) => echoed?.[k] ?? initial[k];
  return (
    <form action={formAction} className="space-y-4" noValidate key={event ? "edit" : created}>
      <Hidden
        values={{
          workspaceId,
          ...(event
            ? { eventId: event.id, version: event.version }
            : { idempotencyKey: `${keyBase}-${created}` }),
        }}
      />
      <TextField
        label="Event name"
        name="name"
        required
        maxLength={120}
        autoComplete="off"
        defaultValue={v("name")}
        error={errors.name}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField label="Kind" name="kind" defaultValue={v("kind")} error={errors.kind}>
          {EVENT_KINDS.map((k) => (
            <option key={k} value={k}>
              {EVENT_KIND_LABELS[k]}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Date"
          hint="Leave blank if not decided."
          name="localDate"
          type="date"
          defaultValue={v("localDate")}
          error={errors.localDate}
        />
        <TextField
          label="Planned attendance"
          hint="Your target, separate from RSVPs."
          name="targetAttendance"
          inputMode="numeric"
          autoComplete="off"
          defaultValue={v("targetAttendance")}
          error={errors.targetAttendance}
        />
        <TextField
          label="Capacity"
          hint="Leave blank if unknown."
          name="capacity"
          inputMode="numeric"
          autoComplete="off"
          defaultValue={v("capacity")}
          error={errors.capacity}
        />
      </div>
      <Feedback state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}

export function MealOptionForm({ workspaceId, eventId }: { workspaceId: string; eventId: string }) {
  const [count, setCount] = useState(0);
  const [state, formAction, pending] = useActionState(
    async (prev: EventActionState, form: FormData) => {
      const next = await addMealOption(prev, form);
      if (next.status === "ok") setCount((n) => n + 1);
      return next;
    },
    idle,
  );
  const errors = state.status === "error" ? state.fieldErrors : {};
  return (
    <form action={formAction} className="space-y-2" noValidate key={count}>
      <Hidden values={{ workspaceId, eventId }} />
      <TextField
        label="Add a meal choice"
        name="name"
        maxLength={80}
        autoComplete="off"
        error={errors.name}
      />
      <Feedback state={state} />
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "Adding…" : "Add meal choice"}
      </Button>
    </form>
  );
}

export function MealToggle({
  workspaceId,
  option,
}: {
  workspaceId: string;
  option: { id: string; name: string; active: boolean; version: number };
}) {
  const [state, formAction, pending] = useTrayActionState(setMealOptionActive, idle);
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-3">
      <Hidden
        values={{
          workspaceId,
          optionId: option.id,
          version: option.version,
          active: String(!option.active),
        }}
      />
      <span className={option.active ? "" : "text-ink-muted line-through"}>{option.name}</span>
      <Button type="submit" variant="outline" disabled={pending}>
        {option.active ? "Stop offering" : "Offer again"}
        <span className="sr-only"> {option.name}</span>
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export type PickHousehold = { id: string; name: string; invitable: number; total: number };
export type PickGuest = { id: string; name: string };

export function InviteForm({
  workspaceId,
  eventId,
  households,
  guests,
  defaultExpires,
}: {
  workspaceId: string;
  eventId: string;
  households: PickHousehold[];
  guests: PickGuest[];
  defaultExpires: string;
}) {
  const [keyBase, setKeyBase] = useState(() => crypto.randomUUID());
  const [state, formAction, pending] = useActionState(
    async (prev: EventActionState, form: FormData) => {
      const next = await createInvitations(prev, form);
      if (next.status === "ok") setKeyBase(crypto.randomUUID());
      return next;
    },
    idle,
  );
  const errors = state.status === "error" ? state.fieldErrors : {};
  const echoed = state.status === "error" ? state.values : undefined;
  return (
    <div className="space-y-4">
      <form action={formAction} className="space-y-4" noValidate>
        <Hidden values={{ workspaceId, eventId, idempotencyKey: keyBase }} />
        <fieldset className="space-y-2">
          <legend className="text-label-lg font-semibold">Who to invite</legend>
          <p className="text-body-sm text-ink-muted">
            A household gets one shared link. Someone with no household gets their own.
          </p>
          {errors.picks && (
            <p role="alert" className="text-body-sm text-danger">
              {errors.picks}
            </p>
          )}
          <ul className="max-h-72 space-y-1 overflow-y-auto rounded-card border border-border-hairline p-2">
            {households.map((h) => (
              <li key={h.id}>
                <label className="flex min-h-11 items-center gap-3 px-1">
                  <input
                    type="checkbox"
                    name="household"
                    value={h.id}
                    disabled={h.invitable === 0}
                    className="size-5"
                  />
                  <span>
                    {h.name}{" "}
                    <span className="text-body-sm text-ink-muted">
                      {h.invitable === 0
                        ? "(all already invited)"
                        : `(${h.invitable} of ${h.total} ${h.total === 1 ? "guest" : "guests"})`}
                    </span>
                  </span>
                </label>
              </li>
            ))}
            {guests.map((g) => (
              <li key={g.id}>
                <label className="flex min-h-11 items-center gap-3 px-1">
                  <input type="checkbox" name="guest" value={g.id} className="size-5" />
                  <span>{g.name}</span>
                </label>
              </li>
            ))}
            {households.length + guests.length === 0 && (
              <li className="p-2 text-body-sm text-ink-muted">
                Everyone is already invited to this event.
              </li>
            )}
          </ul>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-3">
          <SelectField
            label="Plus-ones allowed"
            name="plusOnes"
            defaultValue={echoed?.plusOnes ?? "0"}
            error={errors.plusOnes}
          >
            {[0, 1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </SelectField>
          <TextField
            label="Reply by"
            hint="Optional. After this date only you can change answers."
            name="deadline"
            type="date"
            defaultValue={echoed?.deadline ?? ""}
            error={errors.deadline}
          />
          <TextField
            label="Link works until"
            name="expires"
            type="date"
            required
            defaultValue={echoed?.expires ?? defaultExpires}
            error={errors.expires}
          />
        </div>
        <Feedback state={state} />
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create invitation links"}
        </Button>
      </form>
      {state.status === "ok" && state.links && <LinkList links={state.links} />}
    </div>
  );
}

export function InvitationActions({
  workspaceId,
  invitation,
}: {
  workspaceId: string;
  invitation: { id: string; version: number; label: string; shared: boolean };
}) {
  const [reissued, reissueAction, reissuing] = useTrayActionState(reissueInvitation, idle);
  const [revoked, revokeAction, revoking] = useTrayActionState(revokeInvitation, idle);
  const [delivery, deliveryAction, delivering] = useTrayActionState(setInvitationDelivery, idle);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        <form action={reissueAction}>
          <Hidden
            values={{
              workspaceId,
              invitationId: invitation.id,
              version: invitation.version,
              label: invitation.label,
            }}
          />
          <Button type="submit" variant="secondary" disabled={reissuing}>
            New link<span className="sr-only"> for {invitation.label}</span>
          </Button>
        </form>
        <form action={deliveryAction}>
          <Hidden
            values={{
              workspaceId,
              invitationId: invitation.id,
              version: invitation.version,
              shared: invitation.shared ? "no" : "yes",
            }}
          />
          <Button type="submit" variant="secondary" disabled={delivering}>
            {invitation.shared ? "Mark as not shared" : "Mark as shared"}
            <span className="sr-only"> for {invitation.label}</span>
          </Button>
        </form>
        <form action={revokeAction}>
          <Hidden
            values={{ workspaceId, invitationId: invitation.id, version: invitation.version }}
          />
          <Button type="submit" variant="outline" disabled={revoking}>
            Revoke<span className="sr-only"> invitation for {invitation.label}</span>
          </Button>
        </form>
      </div>
      <Feedback
        state={
          reissued.status !== "idle" ? reissued : delivery.status !== "idle" ? delivery : revoked
        }
      />
      {reissued.status === "ok" && reissued.links && <LinkList links={reissued.links} />}
    </div>
  );
}

export function OverrideForm({
  workspaceId,
  member,
  meals,
}: {
  workspaceId: string;
  member: { id: string; name: string; status: string; mealOptionId: string | null };
  meals: { id: string; name: string }[];
}) {
  const [state, formAction, pending] = useTrayActionState(overrideResponse, idle);
  const errors = state.status === "error" ? state.fieldErrors : {};
  return (
    <form action={formAction} className="space-y-3" noValidate>
      <Hidden values={{ workspaceId, memberId: member.id }} />
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField label={`Answer for ${member.name}`} name="status" defaultValue={member.status}>
          <option value="pending">Not answered</option>
          <option value="accepted">Attending</option>
          <option value="declined">Not attending</option>
        </SelectField>
        <SelectField label="Meal" name="meal" defaultValue={member.mealOptionId ?? ""}>
          <option value="">Not chosen</option>
          {meals.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </SelectField>
      </div>
      <TextField
        label="Reason for the change"
        hint="Recorded in the history. Needed even if the reply date has passed."
        name="reason"
        maxLength={200}
        autoComplete="off"
        error={errors.reason}
      />
      <Feedback state={state} />
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "Saving…" : "Record change"}
      </Button>
    </form>
  );
}
