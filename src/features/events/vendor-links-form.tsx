"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useTrayActionState } from "@/components/ui/tray";
import { diffLinks } from "@/domain/events/vendors";
import {
  setEventVendors,
  setVendorEvents,
  type VendorLinkState,
} from "@/server/events/vendor-actions";

const idle: VendorLinkState = { status: "idle" };

export type LinkOption = { id: string; label: string; hint?: string | undefined };

type Props = {
  workspaceId: string;
  /** The vendor (for "Works at") or the event (for "Vendors at this event") being edited. */
  subjectId: string;
  legend: string;
  help: string;
  options: LinkOption[];
  /** Ids that are linked now. Stale ones stay in `options` so they can be seen and cleared. */
  initial: string[];
  empty: string;
};

function LinkChecklist({
  action,
  subjectName,
  checkName,
  props,
}: {
  action: (state: VendorLinkState, form: FormData) => Promise<VendorLinkState>;
  subjectName: "vendorId" | "eventId";
  checkName: "vendorId" | "eventId";
  props: Props;
}) {
  const [selected, setSelected] = useState<string[]>(props.initial);
  const [state, formAction, pending] = useTrayActionState(action, idle);
  const changed = diffLinks(props.initial, selected);
  const dirty = changed.add.length + changed.remove.length > 0;

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="workspaceId" value={props.workspaceId} />
      <input type="hidden" name={subjectName} value={props.subjectId} />
      {props.initial.map((id) => (
        <input key={id} type="hidden" name="initial" value={id} />
      ))}
      <fieldset className="space-y-1">
        <legend className="text-label-lg font-semibold">{props.legend}</legend>
        <p className="pb-2 text-body-sm text-ink-muted">{props.help}</p>
        {props.options.length === 0 ? (
          <p className="text-body-md text-ink-muted">{props.empty}</p>
        ) : (
          <ul>
            {props.options.map((o) => {
              const on = selected.includes(o.id);
              return (
                <li key={o.id}>
                  <label className="flex min-h-11 items-start gap-3 py-1.5">
                    <input
                      type="checkbox"
                      name={checkName}
                      value={o.id}
                      checked={on}
                      onChange={(e) =>
                        setSelected((cur) =>
                          e.target.checked ? [...cur, o.id] : cur.filter((x) => x !== o.id),
                        )
                      }
                      className="mt-0.5 size-5"
                    />
                    <span className="text-body-md break-words">
                      {o.label}
                      {o.hint && (
                        <span className="block text-body-sm text-ink-muted">{o.hint}</span>
                      )}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </fieldset>
      <div aria-live="polite" className="min-h-6">
        {state.status === "error" && (
          <p role="alert" className="text-body-md text-danger">
            {state.message}
          </p>
        )}
      </div>
      <Button type="submit" disabled={pending || !dirty}>
        {pending ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}

/** On a vendor: tick the events it works at. */
export function VendorEventsForm(props: Props) {
  return (
    <LinkChecklist
      action={setVendorEvents}
      subjectName="vendorId"
      checkName="eventId"
      props={props}
    />
  );
}

/** On an event: tick the vendors that work at it. */
export function EventVendorsForm(props: Props) {
  return (
    <LinkChecklist
      action={setEventVendors}
      subjectName="eventId"
      checkName="vendorId"
      props={props}
    />
  );
}
