"use client";

import { startTransition, useActionState, useRef, useState } from "react";
import { useToast } from "@/components/ui/toast";
import { useTrayActionState, useTrayClose } from "@/components/ui/tray";
import { Button } from "@/components/ui/button";
import { ImpactPreview } from "@/components/ui/impact-preview";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import { PLANNING_BASES, PLANNING_BASIS_LABELS } from "@/domain/events/demand";
import { EVENT_KINDS, EVENT_KIND_LABELS, effectiveEventZone } from "@/domain/events/event";
import { timeLabel, zoneName } from "@/features/timeline/format";
import {
  addMealOption,
  createInvitations,
  overrideResponse,
  previewOverride,
  reissueInvitation,
  setInvitationDelivery,
  revokeInvitation,
  saveEvent,
  setMealOptionActive,
  type EventActionState,
  type IssuedLink,
  type OverrideActionState,
} from "@/server/events/actions";
import type { OverridePreview } from "@/server/events/override-preview-read";

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
  planningBasis: string;
  /** "true" when the event opts in to counting unnamed plus-ones. */
  planOpenPlusOnes: string;
  /** "true" once all invitations are out and replies should drive costs. */
  invitationsFinal: string;
  /** The event's own IANA zone, or "" to follow the wedding's. */
  timeZone: string;
};
export const emptyEvent: EventFormValues = {
  name: "",
  kind: "reception",
  localDate: "",
  targetAttendance: "",
  capacity: "",
  planningBasis: "auto",
  planOpenPlusOnes: "",
  invitationsFinal: "",
  timeZone: "",
};

/** The first scheduled agenda item, used to show what a zone change does to the clock. */
export type ZonePreviewItem = { count: number; title: string; startsAt: string };

export function EventForm({
  workspaceId,
  initial: initialValues,
  event,
  submitLabel,
  weddingZone,
  timeZones,
  agenda = null,
}: {
  workspaceId: string;
  initial?: Partial<EventFormValues>;
  event?: { id: string; version: number };
  submitLabel: string;
  weddingZone: string;
  timeZones: readonly string[];
  agenda?: ZonePreviewItem | null;
}) {
  const initial: EventFormValues = { ...emptyEvent, ...initialValues };
  const [created, setCreated] = useState(0);
  const [keyBase] = useState(() => crypto.randomUUID());
  const closeTray = useTrayClose();
  const { toast } = useToast();
  const [zone, setZone] = useState(initial.timeZone);
  const [state, formAction, pending] = useActionState(
    async (prev: EventActionState, form: FormData) => {
      const next = await saveEvent(prev, form);
      if (next.status === "ok") {
        closeTray();
        toast({ message: next.message });
      }
      if (next.status === "ok" && !event) {
        setCreated((n) => n + 1);
        setZone("");
      }
      return next;
    },
    idle,
  );
  const echoed = state.status === "error" ? state.values : undefined;
  const errors = state.status === "error" ? state.fieldErrors : {};
  const v = (k: keyof EventFormValues) => echoed?.[k] ?? initial[k];
  // A zone the wedding or event already uses must be selectable even if the runtime's list lacks it.
  const zoneChoices = [...timeZones];
  for (const z of [weddingZone, initial.timeZone]) {
    if (z && !zoneChoices.includes(z)) zoneChoices.push(z);
  }
  const from = effectiveEventZone(initial.timeZone, weddingZone);
  const to = effectiveEventZone(zone, weddingZone);
  const showShift = Boolean(event) && agenda !== null && agenda.count > 0 && from !== to;
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
          hint="Your plan. It stays as your baseline: replies are tracked against it, never replace it."
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
      <div className="space-y-2">
        <SelectField
          label="Time zone"
          hint="Agenda times for this event are read in this zone. Change it only if this event is somewhere else."
          name="timeZone"
          value={zone}
          onChange={(e) => setZone(e.target.value)}
          error={errors.timeZone}
        >
          <option value="">Same as the wedding ({weddingZone.replaceAll("_", " ")})</option>
          {zoneChoices.map((z) => (
            <option key={z} value={z}>
              {z.replaceAll("_", " ")}
            </option>
          ))}
        </SelectField>
        {showShift && agenda && (
          <p className="rounded-control bg-surface-sunken p-3 text-body-sm" role="status">
            {agenda.count === 1
              ? "The 1 agenda item keeps"
              : `The ${agenda.count} agenda items keep`}{" "}
            the same moment; only the clock they are read on changes. “{agenda.title}” now shows as{" "}
            {timeLabel(agenda.startsAt, from)} {zoneName(from, new Date(agenda.startsAt))}, and
            would show as {timeLabel(agenda.startsAt, to)} {zoneName(to, new Date(agenda.startsAt))}
            .
          </p>
        )}
      </div>
      <fieldset className="space-y-3 rounded-card border border-border-hairline p-4">
        <legend className="px-1 text-label-lg font-semibold">How we count guests</legend>
        <SelectField
          label="Planning number"
          name="planningBasis"
          defaultValue={v("planningBasis")}
          error={errors.planningBasis}
          hint="The number seats, food and per-guest costs are planned around."
        >
          {PLANNING_BASES.map((b) => (
            <option key={b} value={b}>
              {PLANNING_BASIS_LABELS[b]}
            </option>
          ))}
        </SelectField>
        <label className="flex min-h-11 items-start gap-3">
          <input
            type="checkbox"
            name="planOpenPlusOnes"
            value="true"
            defaultChecked={v("planOpenPlusOnes") === "true"}
            className="mt-1 size-5"
          />
          <span className="text-body-md">
            Also plan for plus-one places that aren&apos;t named yet
            <span className="block text-body-sm text-ink-muted">
              Off by default. Unused plus-one places are shown on their own either way.
            </span>
          </span>
        </label>
        <label className="flex min-h-11 items-start gap-3">
          <input
            type="checkbox"
            name="invitationsFinal"
            value="true"
            defaultChecked={v("invitationsFinal") === "true"}
            className="mt-1 size-5"
          />
          <span className="text-body-md">
            All invitations for this event are out
            <span className="block text-body-sm text-ink-muted">
              Until then, per-guest costs use whichever is larger: your planned attendance or the
              replies so far. Once this is on, they follow the replies alone. Your plan is kept
              either way, for comparison.
            </span>
          </span>
        </label>
      </fieldset>
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
  const [state, formAction, pending] = useTrayActionState(setMealOptionActive, idle, {
    keepOpen: true,
  });
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
  zoneLabel,
}: {
  workspaceId: string;
  eventId: string;
  households: PickHousehold[];
  guests: PickGuest[];
  defaultExpires: string;
  /** The event's zone, named so the planner knows whose midnight the dates mean. */
  zoneLabel: string;
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
            hint={`Optional. Closes at the end of that day, ${zoneLabel}. After that only you can change answers.`}
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
  const [status, setStatus] = useState(member.status);
  const [meal, setMeal] = useState(member.mealOptionId ?? "");
  const [touched, setTouched] = useState(false);
  const [preview, setPreview] = useState<OverridePreview | null>(null);
  const [checking, setChecking] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // Answers can arrive out of order when the choice changes quickly; only the latest one counts.
  const request = useRef(0);

  const [state, formAction, pending] = useTrayActionState<OverrideActionState>(
    async (prev, form) => {
      const next = await overrideResponse(prev, form);
      if (next.status === "stale") {
        request.current += 1;
        setChecking(false);
        setPreviewError(null);
        setPreview(next.preview);
      }
      return next;
    },
    idle,
    { keepOpen: true },
  );

  async function check(nextStatus: string, nextMeal: string) {
    const id = ++request.current;
    setTouched(true);
    setChecking(true);
    setPreviewError(null);
    const r = await previewOverride({
      workspaceId,
      memberId: member.id,
      status: nextStatus,
      meal: nextStatus === "accepted" ? nextMeal : "",
    });
    if (id !== request.current) return;
    setChecking(false);
    if (r.status === "ok") {
      setPreview(r.preview);
    } else {
      // Without a preview, saving shows it first rather than saving blind.
      setPreview(null);
      setPreviewError(r.message);
    }
  }

  const saved = preview?.current ?? { status: member.status, mealOptionId: member.mealOptionId };
  const chosen = { status, mealOptionId: status === "accepted" && meal !== "" ? meal : null };
  const differs = chosen.status !== saved.status || chosen.mealOptionId !== saved.mealOptionId;
  const fresh =
    preview !== null &&
    preview.to.status === chosen.status &&
    preview.to.mealOptionId === chosen.mealOptionId;
  const movedSincePageLoad =
    preview !== null &&
    (preview.current.status !== member.status ||
      preview.current.mealOptionId !== member.mealOptionId);
  const answerWords = (a: { status: string; mealOptionId: string | null }) =>
    `${OVERRIDE_STATUS_LABEL[a.status] ?? a.status}${
      a.mealOptionId ? ` · ${meals.find((m) => m.id === a.mealOptionId)?.name ?? "a meal"}` : ""
    }`;

  const errors = state.status === "error" ? state.fieldErrors : {};
  const echoed =
    state.status === "error" || state.status === "stale" ? state.values.reason : undefined;
  return (
    <form
      action={formAction}
      // Dispatch by hand so React does not reset the form afterwards: a reset puts the controlled
      // selects back to their first option while state keeps the choice, and the next press would
      // send the wrong answer. Without script the plain form action still works.
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        startTransition(() => formAction(data));
      }}
      className="space-y-3"
      noValidate
    >
      <Hidden values={{ workspaceId, memberId: member.id, basis: fresh ? preview.basis : "" }} />
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label={`Answer for ${member.name}`}
          name="status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            void check(e.target.value, meal);
          }}
        >
          <option value="pending">Not answered</option>
          <option value="accepted">Attending</option>
          <option value="declined">Not attending</option>
        </SelectField>
        <SelectField
          label="Meal"
          name="meal"
          value={status === "accepted" ? meal : ""}
          disabled={status !== "accepted"}
          hint={status !== "accepted" ? "Only for guests who are attending." : undefined}
          onChange={(e) => {
            setMeal(e.target.value);
            void check(status, e.target.value);
          }}
        >
          <option value="">Not chosen</option>
          {meals.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </SelectField>
      </div>
      {movedSincePageLoad && (
        <p className="text-body-md">
          Saved answer now: <span className="font-semibold">{answerWords(saved)}</span> (changed
          since this page loaded).
        </p>
      )}
      {(touched || state.status === "stale") && (
        <ImpactPreview
          testId={`override-impact-${member.id}`}
          busy={checking}
          items={fresh && differs ? preview.items : []}
          emptyText={
            checking || (differs && !fresh && previewError === null)
              ? "Checking what this would change…"
              : !differs
                ? "This is the saved answer, so nothing would change."
                : (previewError ?? "Nothing else is affected.")
          }
        />
      )}
      <TextField
        label="Reason for the change"
        hint="Recorded in the history. Needed even if the reply date has passed."
        name="reason"
        maxLength={200}
        autoComplete="off"
        defaultValue={echoed ?? ""}
        error={errors.reason}
      />
      <div aria-live="polite" className="min-h-6">
        {state.status === "stale" && <p className="text-body-md text-danger">{state.message}</p>}
        {state.status === "error" && (
          <p role="alert" className="text-body-md text-danger">
            {state.message}
          </p>
        )}
        {state.status === "ok" && (
          <p className="text-body-md text-action-secondary">{state.message}</p>
        )}
      </div>
      <Button type="submit" variant="secondary" disabled={pending || checking || !differs}>
        {pending ? "Saving…" : "Record change"}
      </Button>
    </form>
  );
}

const OVERRIDE_STATUS_LABEL: Record<string, string> = {
  pending: "Not answered",
  accepted: "Attending",
  declined: "Not attending",
};
