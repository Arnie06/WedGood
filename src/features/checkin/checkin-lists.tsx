"use client";

import { useActionState, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import {
  MAX_CHECKIN_BATCH,
  REPLY_LABELS,
  matchesSearch,
  type ArrivalGuest,
} from "@/domain/checkin/checkin";
import { Hidden } from "@/features/events/event-forms";
import {
  checkInGuests,
  recordVendorArrival,
  undoGuestCheckIn,
  undoVendorArrival,
} from "@/server/checkin/actions";
import type { EventActionState } from "@/server/events/actions";

const idle: EventActionState = { status: "idle" };

/** Result line under a row. Polite, so a screen reader hears the outcome without losing its place. */
function Result({ state }: { state: EventActionState }) {
  return (
    <p
      aria-live="polite"
      className={`text-body-sm ${state.status === "error" ? "text-danger" : "text-ink-muted"}`}
      role={state.status === "error" ? "alert" : undefined}
    >
      {state.status === "idle" ? "" : state.message}
    </p>
  );
}

export type GuestRowData = ArrivalGuest & {
  /** "2:14 PM", formatted on the server in the event's own time zone. */
  arrivedLabel: string | null;
};

type Filter = "expected" | "arrived" | "everyone";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "expected", label: "Still expected" },
  { id: "arrived", label: "Arrived" },
  { id: "everyone", label: "Everyone invited" },
];

function GuestRow({
  workspaceId,
  eventId,
  guest,
  householdMates,
}: {
  workspaceId: string;
  eventId: string;
  guest: GuestRowData;
  /** Other guests in this household who have not arrived (not including this guest). */
  householdMates: GuestRowData[];
}) {
  const [inState, checkIn, inPending] = useActionState(checkInGuests, idle);
  const [outState, undo, outPending] = useActionState(undoGuestCheckIn, idle);
  const [groupState, checkInGroup, groupPending] = useActionState(checkInGuests, idle);
  const arrived = guest.arrivedAt !== null;
  const groupIds = [guest.id, ...householdMates.map((m) => m.id)];
  const state = outState.status !== "idle" ? outState : inState;
  return (
    <li className="space-y-1 py-2" data-testid="checkin-guest" data-arrived={arrived}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-body-md font-semibold break-words">{guest.name}</p>
          <p className="text-body-sm text-ink-muted break-words">
            {[guest.household, REPLY_LABELS[guest.reply]].filter(Boolean).join(" · ")}
            {arrived && guest.arrivedLabel ? ` · Arrived ${guest.arrivedLabel}` : ""}
          </p>
        </div>
        {arrived ? (
          <form action={undo} className="shrink-0">
            <Hidden values={{ workspaceId, eventId, guestId: guest.id }} />
            <Button type="submit" variant="quiet" size="sm" disabled={outPending}>
              Undo<span className="sr-only"> check-in for {guest.name}</span>
            </Button>
          </form>
        ) : (
          <form action={checkIn} className="shrink-0">
            <Hidden values={{ workspaceId, eventId }} />
            <input type="hidden" name="guestIds" value={guest.id} />
            <Button type="submit" variant="primary" size="sm" disabled={inPending}>
              Check in<span className="sr-only"> {guest.name}</span>
            </Button>
          </form>
        )}
      </div>
      {!arrived && householdMates.length > 0 && groupIds.length <= MAX_CHECKIN_BATCH && (
        <form action={checkInGroup}>
          <Hidden values={{ workspaceId, eventId }} />
          {groupIds.map((id) => (
            <input key={id} type="hidden" name="guestIds" value={id} />
          ))}
          <Button type="submit" variant="outline" size="sm" disabled={groupPending}>
            Check in the whole household ({groupIds.length})
            <span className="sr-only"> of {guest.name}</span>
          </Button>
        </form>
      )}
      <Result state={groupState.status !== "idle" ? groupState : state} />
    </li>
  );
}

/**
 * Who has arrived. Searching looks at everyone invited, so a guest who turned up without saying
 * yes can be found and recorded; the page then labels them rather than counting them as expected.
 */
export function GuestCheckInList({
  workspaceId,
  eventId,
  guests,
}: {
  workspaceId: string;
  eventId: string;
  guests: GuestRowData[];
}) {
  const [filter, setFilter] = useState<Filter>("expected");
  const [query, setQuery] = useState("");
  const searching = query.trim() !== "";

  const shown = useMemo(() => {
    const byFilter = (g: GuestRowData) =>
      searching && filter === "expected"
        ? true
        : filter === "everyone"
          ? true
          : filter === "arrived"
            ? g.arrivedAt !== null
            : g.reply === "accepted" && g.arrivedAt === null;
    return guests
      .filter((g) => byFilter(g) && matchesSearch(g, query))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [guests, filter, query, searching]);

  const mates = (g: GuestRowData): GuestRowData[] =>
    g.household
      ? guests.filter((o) => o.id !== g.id && o.household === g.household && o.arrivedAt === null)
      : [];

  return (
    <div className="space-y-4">
      <TextField
        label="Find a guest"
        type="search"
        autoComplete="off"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        hint="Search by name or household. Searching looks at everyone invited."
      />
      <div role="group" aria-label="Show" className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Button
            key={f.id}
            variant={filter === f.id ? "emphasis" : "outline"}
            size="sm"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </Button>
        ))}
      </div>
      <p className="text-body-sm text-ink-muted" aria-live="polite" data-testid="checkin-shown">
        {shown.length} {shown.length === 1 ? "guest" : "guests"} shown
      </p>
      {shown.length === 0 ? (
        <p className="text-body-md text-ink-muted">
          {searching
            ? "No one invited matches that search."
            : filter === "expected"
              ? "Everyone who said yes has arrived."
              : filter === "arrived"
                ? "No one has been checked in yet."
                : "No one is invited to this event yet."}
        </p>
      ) : (
        <ul className="divide-y divide-border-hairline border-y border-border-hairline">
          {shown.map((g) => (
            <GuestRow
              key={g.id}
              workspaceId={workspaceId}
              eventId={eventId}
              guest={g}
              householdMates={mates(g)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

export type VendorRowData = {
  id: string;
  name: string;
  arrivedAt: string | null;
  arrivedLabel: string | null;
};

function VendorRow({
  workspaceId,
  eventId,
  vendor,
  canEdit,
}: {
  workspaceId: string;
  eventId: string;
  vendor: VendorRowData;
  canEdit: boolean;
}) {
  const [inState, arrive, inPending] = useActionState(recordVendorArrival, idle);
  const [outState, undo, outPending] = useActionState(undoVendorArrival, idle);
  const arrived = vendor.arrivedAt !== null;
  return (
    <li className="space-y-1 py-2" data-testid="checkin-vendor" data-arrived={arrived}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-body-md font-semibold break-words">{vendor.name}</p>
          <p className="text-body-sm text-ink-muted">
            {arrived ? `Arrived ${vendor.arrivedLabel ?? ""}`.trim() : "Not arrived yet"}
          </p>
        </div>
        {canEdit && (
          <form action={arrived ? undo : arrive} className="shrink-0">
            <Hidden values={{ workspaceId, eventId, vendorId: vendor.id }} />
            <Button
              type="submit"
              variant={arrived ? "quiet" : "primary"}
              size="sm"
              disabled={inPending || outPending}
            >
              {arrived ? "Undo" : "Mark arrived"}
              <span className="sr-only">
                {arrived ? " arrival for " : " "}
                {vendor.name}
              </span>
            </Button>
          </form>
        )}
      </div>
      <Result state={outState.status !== "idle" ? outState : inState} />
    </li>
  );
}

export function VendorCheckInList({
  workspaceId,
  eventId,
  vendors,
  canEdit,
}: {
  workspaceId: string;
  eventId: string;
  vendors: VendorRowData[];
  canEdit: boolean;
}) {
  return (
    <ul className="divide-y divide-border-hairline border-y border-border-hairline">
      {vendors.map((v) => (
        <VendorRow
          key={v.id}
          workspaceId={workspaceId}
          eventId={eventId}
          vendor={v}
          canEdit={canEdit}
        />
      ))}
    </ul>
  );
}
