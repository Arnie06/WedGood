"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { useTrayActionState } from "@/components/ui/tray";
import { cn } from "@/lib/cn";
import { initials } from "@/domain/seating/seats";
import { Feedback, Hidden } from "@/features/events/event-forms";
import type { EventActionState } from "@/server/events/actions";
import { numberTableSeats, seatGuest, swapSeats } from "@/server/seating/actions";

const idle: EventActionState = { status: "idle" };

type Report = (state: EventActionState) => void;

/**
 * A form action for the seat tools. The result goes to the one status line under the chips instead of
 * into the form, because a successful change refreshes the data and the form that sent it may no longer
 * exist (the number button disappears once everyone has a number). The tray stays open.
 */
function useSeatForm(
  action: (state: EventActionState, form: FormData) => Promise<EventActionState>,
  report: Report,
  after?: (form: FormData) => void,
) {
  const wrapped = useCallback(
    async (prev: EventActionState, form: FormData) => {
      const next = await action(prev, form);
      report(next);
      if (next.status === "ok") after?.(form);
      return next;
    },
    [action, report, after],
  );
  return useTrayActionState(wrapped, idle, { keepOpen: true });
}

export type SeatChipSlot = {
  seat: number;
  guest: { id: string; name: string; tentative: boolean; captain: boolean } | null;
};

type Props = {
  workspaceId: string;
  layoutId: string;
  tableId: string;
  tableLabel: string;
  slots: SeatChipSlot[];
  /** At this table with no seat number yet. */
  unnumbered: { id: string; name: string }[];
  /** Not seated anywhere yet (and seatable now). */
  candidates: { id: string; name: string }[];
};

const chipName = (s: SeatChipSlot) =>
  s.guest
    ? `Seat ${s.seat}, ${s.guest.name}${s.guest.tentative ? ", waiting to answer" : ""}${
        s.guest.captain ? ", captain" : ""
      }`
    : `Seat ${s.seat}, empty`;

/**
 * The numbered seats at one table, as 44px chips: pick one, then put someone in it, move or swap who is
 * there, or clear its number. Everything is a button and a select, so it works without dragging.
 */
export function SeatChips({
  workspaceId,
  layoutId,
  tableId,
  tableLabel,
  slots,
  unnumbered,
  candidates,
}: Props) {
  const [selected, setSelected] = useState<number | null>(null);
  const [notice, setNotice] = useState<EventActionState>(idle);
  const slot = slots.find((s) => s.seat === selected) ?? null;
  const emptySeats = slots.filter((s) => s.guest === null);
  const neighbours = slots.flatMap((s) => (s.guest ? [{ seat: s.seat, ...s.guest }] : []));

  return (
    <section aria-label="Seat numbers" className="space-y-3">
      <h3 className="text-label-lg font-semibold">Seat numbers</h3>
      {slots.length === 0 ? (
        <p className="text-body-md text-ink-muted">This table has no seats.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {slots.map((s) => (
            <li key={s.seat}>
              <button
                type="button"
                aria-pressed={selected === s.seat}
                data-seat={s.seat}
                onClick={() => {
                  setNotice(idle);
                  setSelected(selected === s.seat ? null : s.seat);
                }}
                className={cn(
                  "flex size-11 flex-col items-center justify-center rounded-full border-2 leading-none",
                  s.guest
                    ? s.guest.tentative
                      ? "border-dashed border-action-secondary bg-status-pending-bg text-status-pending-fg"
                      : "border-action-secondary bg-action-secondary text-on-action-secondary"
                    : "border-dashed border-border-control bg-surface text-ink-muted",
                  selected === s.seat && "outline-2 outline-offset-2 outline-focus",
                )}
              >
                <span aria-hidden="true" className="text-label-md font-semibold">
                  {s.seat}
                </span>
                <span aria-hidden="true" className="text-[10px]">
                  {s.guest ? initials(s.guest.name) : "+"}
                </span>
                <span className="sr-only">{chipName(s)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {slot ? (
        <div
          role="group"
          aria-label={`Seat ${slot.seat}`}
          className="space-y-3 rounded-card border border-border-hairline bg-surface-sunken p-3"
        >
          {slot.guest ? (
            <OccupiedSeat
              key={`${slot.seat}-${slot.guest.id}`}
              workspaceId={workspaceId}
              layoutId={layoutId}
              tableId={tableId}
              seat={slot.seat}
              guest={slot.guest}
              neighbours={neighbours.filter((n) => n.id !== slot.guest?.id)}
              emptySeats={emptySeats.map((e) => e.seat)}
              report={setNotice}
              follow={setSelected}
            />
          ) : (
            <EmptySeat
              key={`${slot.seat}-empty`}
              workspaceId={workspaceId}
              layoutId={layoutId}
              tableId={tableId}
              tableLabel={tableLabel}
              seat={slot.seat}
              unnumbered={unnumbered}
              candidates={candidates}
              report={setNotice}
            />
          )}
        </div>
      ) : (
        <p className="text-body-sm text-ink-muted">
          Choose a seat to put someone in it, move or swap who is there, or clear its number.
        </p>
      )}

      {unnumbered.length > 0 && (
        <NumberSeats
          workspaceId={workspaceId}
          tableId={tableId}
          tableLabel={tableLabel}
          names={unnumbered.map((g) => g.name)}
          report={setNotice}
        />
      )}

      <Feedback state={notice} />
    </section>
  );
}

function OccupiedSeat({
  workspaceId,
  layoutId,
  tableId,
  seat,
  guest,
  neighbours,
  emptySeats,
  report,
  follow,
}: {
  workspaceId: string;
  layoutId: string;
  tableId: string;
  seat: number;
  guest: { id: string; name: string };
  neighbours: { id: string; name: string; seat: number }[];
  emptySeats: number[];
  report: Report;
  /** Keeps the selection on the guest after they move to another seat. */
  follow: (seat: number) => void;
}) {
  const [, swapAction, swapping] = useSeatForm(swapSeats, report);
  const [, moveAction, moving] = useSeatForm(seatGuest, report, (form) => {
    const to = Number(form.get("seat"));
    if (Number.isInteger(to) && to > 0) follow(to);
  });
  const [, clearAction, clearing] = useSeatForm(seatGuest, report);
  return (
    <>
      <p className="text-body-md">
        <span className="font-semibold">Seat {seat}:</span> {guest.name}
      </p>

      <form action={swapAction} className="space-y-2" noValidate>
        <Hidden values={{ workspaceId, layoutId, guestId: guest.id }} />
        <SelectField
          name="otherGuestId"
          label={`Swap ${guest.name} with`}
          defaultValue=""
          disabled={neighbours.length === 0}
        >
          <option value="" disabled>
            {neighbours.length === 0 ? "No one else is seated here" : "Choose a guest"}
          </option>
          {neighbours.map((n) => (
            <option key={n.id} value={n.id}>
              {n.name} (seat {n.seat})
            </option>
          ))}
        </SelectField>
        <Button type="submit" variant="secondary" disabled={swapping || neighbours.length === 0}>
          Swap places
        </Button>
      </form>

      <form action={moveAction} className="space-y-2" noValidate>
        <Hidden values={{ workspaceId, layoutId, guestId: guest.id, tableId }} />
        <SelectField
          name="seat"
          label={`Move ${guest.name} to an empty seat`}
          defaultValue=""
          disabled={emptySeats.length === 0}
        >
          <option value="" disabled>
            {emptySeats.length === 0 ? "No empty seats" : "Choose a seat"}
          </option>
          {emptySeats.map((n) => (
            <option key={n} value={n}>
              Seat {n}
            </option>
          ))}
        </SelectField>
        <Button type="submit" variant="secondary" disabled={moving || emptySeats.length === 0}>
          Move to that seat
        </Button>
      </form>

      <form action={clearAction}>
        <Hidden values={{ workspaceId, layoutId, guestId: guest.id, tableId, seat: "" }} />
        <Button type="submit" variant="quiet" disabled={clearing}>
          Clear seat number
          <span className="sr-only"> for {guest.name}</span>
        </Button>
      </form>
    </>
  );
}

function EmptySeat({
  workspaceId,
  layoutId,
  tableId,
  tableLabel,
  seat,
  unnumbered,
  candidates,
  report,
}: {
  workspaceId: string;
  layoutId: string;
  tableId: string;
  tableLabel: string;
  seat: number;
  unnumbered: { id: string; name: string }[];
  candidates: { id: string; name: string }[];
  report: Report;
}) {
  const [, action, pending] = useSeatForm(seatGuest, report);
  const none = unnumbered.length + candidates.length === 0;
  return (
    <form action={action} className="space-y-2" noValidate>
      <Hidden values={{ workspaceId, layoutId, tableId, seat }} />
      <p className="text-body-md">
        <span className="font-semibold">Seat {seat}</span> is empty.
      </p>
      <SelectField
        name="guestId"
        label={`Put someone in seat ${seat}`}
        defaultValue=""
        disabled={none}
      >
        <option value="" disabled>
          {none ? "Everyone has a seat number" : "Choose a guest"}
        </option>
        {unnumbered.length > 0 && (
          <optgroup label={`At ${tableLabel}, no seat number yet`}>
            {unnumbered.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </optgroup>
        )}
        {candidates.length > 0 && (
          <optgroup label="Not seated yet">
            {candidates.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </optgroup>
        )}
      </SelectField>
      <Button type="submit" variant="secondary" disabled={pending || none}>
        Put in seat {seat}
      </Button>
    </form>
  );
}

function NumberSeats({
  workspaceId,
  tableId,
  tableLabel,
  names,
  report,
}: {
  workspaceId: string;
  tableId: string;
  tableLabel: string;
  names: string[];
  report: Report;
}) {
  const [, action, pending] = useSeatForm(numberTableSeats, report);
  return (
    <form action={action} className="space-y-2">
      <Hidden values={{ workspaceId, tableId }} />
      <p className="text-body-md">
        No seat number yet: <span className="font-semibold">{names.join(", ")}</span>.
      </p>
      <Button type="submit" variant="outline" disabled={pending}>
        Number the seats<span className="sr-only"> at {tableLabel}</span>
      </Button>
      <p className="text-body-sm text-ink-muted">
        Gives each of them the lowest free number, in name order. Anyone already numbered keeps
        their seat.
      </p>
    </form>
  );
}
