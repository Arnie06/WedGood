"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ImpactPreview } from "@/components/ui/impact-preview";
import { SelectField } from "@/components/ui/select-field";
import { useTrayActionState } from "@/components/ui/tray";
import {
  effectiveCapacity,
  locationImpact,
  type AgendaPlace,
  type LocationChoice,
} from "@/domain/events/location";
import { setEventLocation, type LocationActionState } from "@/server/events/location-actions";

const idle: LocationActionState = { status: "idle" };

export type LocationVenue = {
  id: string;
  name: string;
  seatedCapacity: number | null;
  ceremonyCapacity: number | null;
  spaces: { id: string; name: string; seatedCapacity: number | null }[];
};

export type LocationFormContext = {
  workspaceId: string;
  eventId: string;
  eventKind: string;
  /** The event's own capacity override, which wins over the place. */
  eventCapacity: number | null;
  /** 0 when the event has no place yet. */
  version: number;
  venues: LocationVenue[];
  /** What is saved now. Names are kept so a stale (archived) choice can still be described. */
  current: {
    venueId: string | null;
    venueName: string | null;
    spaceId: string | null;
    spaceName: string | null;
    capacity: LocationChoice["capacity"];
  };
  /** Null for people who may not see guest totals, or when nobody is invited. */
  planning: number | null;
  tableSeats: number | null;
  agenda: AgendaPlace[];
  oldVenueBooked: boolean;
};

/**
 * Venue first, then "Space at this venue". Changing the venue clears the space and says so. The
 * impact preview updates as the choice changes; nothing is saved until the button is pressed.
 */
export function EventLocationForm({ ctx }: { ctx: LocationFormContext }) {
  const stale =
    ctx.current.venueId !== null && !ctx.venues.some((v) => v.id === ctx.current.venueId);
  const [venueId, setVenueId] = useState(stale ? "" : (ctx.current.venueId ?? ""));
  // An archived space is no longer offered, so the picker starts on "Whole venue" for it.
  const [spaceId, setSpaceId] = useState(
    ctx.venues
      .find((v) => v.id === ctx.current.venueId)
      ?.spaces.some((s) => s.id === ctx.current.spaceId)
      ? (ctx.current.spaceId ?? "")
      : "",
  );
  const [cleared, setCleared] = useState(false);
  const [updateAgenda, setUpdateAgenda] = useState(false);
  const [state, action, pending] = useTrayActionState(setEventLocation, idle);

  const venue = ctx.venues.find((v) => v.id === venueId) ?? null;
  const space = venue?.spaces.find((s) => s.id === spaceId) ?? null;
  // A saved space that is no longer offered is stale until another one is chosen.
  const spaceStale =
    !stale && ctx.current.spaceId !== null && venueId === ctx.current.venueId && spaceId === "";

  const next: LocationChoice = {
    venueId: venue?.id ?? null,
    venueName: venue?.name ?? null,
    spaceId: space?.id ?? null,
    spaceName: space?.name ?? null,
    capacity: venue
      ? effectiveCapacity({
          eventCapacity: ctx.eventCapacity,
          eventKind: ctx.eventKind,
          venue: {
            seatedCapacity: venue.seatedCapacity,
            ceremonyCapacity: venue.ceremonyCapacity,
            archived: false,
          },
          space: space ? { seatedCapacity: space.seatedCapacity, archived: false } : null,
        })
      : ctx.eventCapacity !== null
        ? { value: ctx.eventCapacity, source: "event" }
        : null,
  };
  const changed = next.venueId !== ctx.current.venueId || next.spaceId !== ctx.current.spaceId;
  const items = locationImpact({
    from: ctx.current,
    to: next,
    tableSeats: ctx.tableSeats,
    planning: ctx.planning,
    agenda: ctx.agenda,
    oldVenueBooked: ctx.oldVenueBooked,
  });
  const agendaItems = items.find((i) => i.id === "agenda");
  const venueChanged = next.venueId !== ctx.current.venueId;

  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="workspaceId" value={ctx.workspaceId} />
      <input type="hidden" name="eventId" value={ctx.eventId} />
      <input type="hidden" name="version" value={ctx.version} />
      <input type="hidden" name="venueId" value={venueId} />
      <input type="hidden" name="spaceId" value={spaceId} />
      <input
        type="hidden"
        name="updateAgenda"
        value={updateAgenda && venueChanged && agendaItems ? "true" : "false"}
      />

      {stale && (
        <p role="status" className="text-body-md text-danger">
          {ctx.current.venueName} is no longer in your saved venues. Choose a venue below, or clear
          the place.
        </p>
      )}
      {spaceStale && (
        <p role="status" className="text-body-md text-danger">
          {ctx.current.spaceName} (no longer at this venue). Choose a space below, or use the whole
          venue.
        </p>
      )}

      <SelectField
        label="Venue"
        value={venueId}
        onChange={(e) => {
          const hadSpace = spaceId !== "";
          setVenueId(e.target.value);
          setSpaceId("");
          setUpdateAgenda(false);
          setCleared(hadSpace && e.target.value !== venueId);
        }}
        hint="Venues you've saved under Discover."
      >
        <option value="">No venue chosen</option>
        {ctx.venues.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </SelectField>

      <SelectField
        label="Space at this venue"
        value={spaceId}
        disabled={venue === null || venue.spaces.length === 0}
        onChange={(e) => {
          setSpaceId(e.target.value);
          setCleared(false);
        }}
        hint={
          venue === null
            ? "Choose a venue first."
            : venue.spaces.length === 0
              ? "This venue has no spaces yet. Add them on its page."
              : "Optional. Leave on the whole venue if the event uses all of it."
        }
      >
        <option value="">Whole venue</option>
        {venue?.spaces.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
            {s.seatedCapacity !== null ? ` (seats ${s.seatedCapacity})` : ""}
          </option>
        ))}
      </SelectField>
      <div aria-live="polite">
        {cleared && (
          <p className="text-body-md text-ink-muted">
            The space was cleared because you changed the venue.
          </p>
        )}
      </div>

      {changed && <ImpactPreview items={items} testId="location-impact" />}

      {changed && venueChanged && agendaItems && (
        <label className="flex min-h-11 items-start gap-3">
          <input
            type="checkbox"
            checked={updateAgenda}
            onChange={(e) => setUpdateAgenda(e.target.checked)}
            className="mt-1 size-5"
          />
          <span className="text-body-md">
            Also change those agenda places to {venue?.name}
            <span className="block text-body-sm text-ink-muted">
              Only the venue name inside each place is replaced. Everything else on the agenda stays
              as it is.
            </span>
          </span>
        </label>
      )}

      <div aria-live="polite" className="min-h-6">
        {state.status === "error" && (
          <p role="alert" className="text-body-md text-danger">
            {state.message}
          </p>
        )}
      </div>
      <Button type="submit" disabled={pending || !changed}>
        {pending ? "Saving…" : venue ? "Save place" : "Clear place"}
      </Button>
    </form>
  );
}
