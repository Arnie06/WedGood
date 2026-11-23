/**
 * Where an event is held (REL-06): venue, optional space, the capacity that place gives, how a
 * planning number fits it, and what changing the place would touch. Pure; no framework imports.
 *
 * Capacity is never invented. The event's own capacity (the couple's override) wins, then the
 * chosen space, then the venue. A place with no capacity entered has an unknown capacity, which
 * is not zero and is not "fits".
 */

export type CapacitySource = "event" | "space" | "venue";

export type EffectiveCapacity = { value: number; source: CapacitySource } | null;

export type SpaceFacts = {
  seatedCapacity: number | null;
  /** An archived space no longer counts as a place the event can use. */
  archived: boolean;
};
export type VenueFacts = {
  seatedCapacity: number | null;
  ceremonyCapacity: number | null;
  archived: boolean;
};

/**
 * Event override, else the space's seated capacity, else the venue's (ceremony events prefer the
 * venue's ceremony capacity). Archived venues and spaces give nothing: the saved choice is stale.
 */
export function effectiveCapacity(input: {
  eventCapacity: number | null;
  eventKind: string;
  venue: VenueFacts | null;
  space: SpaceFacts | null;
}): EffectiveCapacity {
  if (input.eventCapacity !== null) return { value: input.eventCapacity, source: "event" };
  const { venue, space } = input;
  if (!venue || venue.archived) return null;
  if (space) {
    if (space.archived) return null;
    if (space.seatedCapacity !== null) return { value: space.seatedCapacity, source: "space" };
  }
  const own =
    input.eventKind === "ceremony"
      ? (venue.ceremonyCapacity ?? venue.seatedCapacity)
      : venue.seatedCapacity;
  return own !== null ? { value: own, source: "venue" } : null;
}

export const CAPACITY_SOURCE_LABELS: Record<CapacitySource, string> = {
  event: "set on the event",
  space: "from the space",
  venue: "from the venue",
};

export type Fit =
  | { state: "unknown"; reason: "no_capacity" | "no_count" }
  | { state: "fits"; capacity: number; planning: number; spare: number }
  | { state: "short"; capacity: number; planning: number; shortBy: number };

/** Exactly at capacity fits with 0 spare. One over is short by one. */
export function capacityFit(planning: number | null, capacity: EffectiveCapacity): Fit {
  if (capacity === null) return { state: "unknown", reason: "no_capacity" };
  if (planning === null) return { state: "unknown", reason: "no_count" };
  return planning <= capacity.value
    ? { state: "fits", capacity: capacity.value, planning, spare: capacity.value - planning }
    : { state: "short", capacity: capacity.value, planning, shortBy: planning - capacity.value };
}

export function fitSentence(fit: Fit): string {
  switch (fit.state) {
    case "fits":
      return `Fits ${fit.planning} of ${fit.capacity}`;
    case "short":
      return `Short by ${fit.shortBy}: planning for ${fit.planning}, room for ${fit.capacity}`;
    case "unknown":
      return fit.reason === "no_capacity"
        ? "No capacity entered for this place"
        : "No guest count to compare yet";
  }
}

// ---------------------------------------------------------------- agenda places

/**
 * Case-insensitive, first-occurrence replacement of the old venue's name inside an agenda place.
 * Returns null when the place does not name the venue (or the result would be over 200 characters).
 * The database function `app_private.rewrite_place` applies the same rule; an integration test
 * compares the two.
 */
export function rewritePlace(location: string | null, oldName: string, newName: string) {
  if (location === null || oldName.trim() === "") return null;
  const at = location.toLowerCase().indexOf(oldName.toLowerCase());
  if (at < 0) return null;
  if (location.slice(at, at + oldName.length).toLowerCase() !== oldName.toLowerCase()) return null;
  const next = location.slice(0, at) + newName + location.slice(at + oldName.length);
  return next.length <= 200 ? next : null;
}

export type AgendaPlace = { id: string; title: string; location: string | null };

export function agendaNamingVenue(items: readonly AgendaPlace[], oldName: string, newName: string) {
  return items.flatMap((i) => {
    const after = rewritePlace(i.location, oldName, newName);
    return after === null || i.location === null
      ? []
      : [{ id: i.id, title: i.title, before: i.location, after }];
  });
}

// ---------------------------------------------------------------- impact preview

export type LocationChoice = {
  venueId: string | null;
  venueName: string | null;
  spaceId: string | null;
  spaceName: string | null;
  capacity: EffectiveCapacity;
};

export type ImpactLine = {
  id: string;
  tone: "warning" | "info";
  text: string;
};

/**
 * What changing the place would touch, in plain words. Reviewed before saving; nothing here is
 * applied automatically except the agenda rewrite the person ticks.
 *
 * `tableSeats` is the seat total of the event's current tables (null when there is no plan).
 * `planning` is null for people who may not see guest totals or when nobody is invited.
 */
export function locationImpact(input: {
  from: LocationChoice;
  to: LocationChoice;
  tableSeats: number | null;
  planning: number | null;
  agenda: readonly AgendaPlace[];
  /** The old venue still has an active booking. A reminder only. */
  oldVenueBooked: boolean;
}): ImpactLine[] {
  const { from, to } = input;
  const lines: ImpactLine[] = [];
  const sameVenue = from.venueId === to.venueId;
  const sameSpace = from.spaceId === to.spaceId;
  if (sameVenue && sameSpace) return lines;

  if (sameVenue && !sameSpace) {
    lines.push({
      id: "space",
      tone: "info",
      text: `Moves from ${from.spaceName ?? "the whole venue"} to ${to.spaceName ?? "the whole venue"}.`,
    });
  } else if (from.venueId !== null && to.venueId === null) {
    lines.push({ id: "cleared", tone: "info", text: `${from.venueName} is no longer the place.` });
  }

  if (to.capacity === null && to.venueId !== null) {
    lines.push({
      id: "capacity-unknown",
      tone: "info",
      text: "No capacity is entered for the new place, so it can't be compared yet.",
    });
  }
  if (to.capacity !== null) {
    if (input.tableSeats !== null && input.tableSeats > to.capacity.value) {
      lines.push({
        id: "tables",
        tone: "warning",
        text: `Your tables seat ${input.tableSeats}, which is ${input.tableSeats - to.capacity.value} more than the new place holds (${to.capacity.value}).`,
      });
    }
    const fit = capacityFit(input.planning, to.capacity);
    if (fit.state === "short") {
      lines.push({
        id: "planning",
        tone: "warning",
        text: `You're planning for ${fit.planning} and the new place holds ${fit.capacity}: short by ${fit.shortBy}.`,
      });
    }
    if (fit.state === "fits") {
      lines.push({
        id: "planning",
        tone: "info",
        text: `${fit.planning} of ${fit.capacity} fits.`,
      });
    }
  }

  if (!sameVenue && from.venueName && to.venueName) {
    const named = agendaNamingVenue(input.agenda, from.venueName, to.venueName);
    if (named.length > 0) {
      lines.push({
        id: "agenda",
        tone: "info",
        text: `${named.length} agenda ${named.length === 1 ? "place names" : "places name"} ${from.venueName}.`,
      });
    }
  }
  if (!sameVenue && from.venueId !== null && input.oldVenueBooked) {
    lines.push({
      id: "booking",
      tone: "warning",
      text: `You still have a booking with ${from.venueName}. This doesn't cancel it, change it or tell them anything.`,
    });
  }
  return lines;
}

// ---------------------------------------------------------------- space input

export type SpaceFormValues = {
  name: string;
  seatedCapacity: string;
  standingCapacity: string;
  notes: string;
};

export type SpaceInput = {
  name: string;
  seatedCapacity: number | null;
  standingCapacity: number | null;
  notes: string | null;
};

const MAX_CAPACITY = 100_000;

function capacityField(raw: string, label: string): { value: number | null; error?: string } {
  const text = raw.trim();
  if (text === "") return { value: null };
  if (!/^\d+$/.test(text)) return { value: null, error: `${label} must be a whole number.` };
  const n = Number(text);
  if (n < 1 || n > MAX_CAPACITY)
    return { value: null, error: `${label} must be between 1 and ${MAX_CAPACITY}.` };
  return { value: n };
}

export function validateSpace(
  values: SpaceFormValues,
): { ok: true; input: SpaceInput } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const name = values.name.replace(/\s+/g, " ").trim();
  if (name === "") errors.name = "Add a name for this space.";
  else if (name.length > 80) errors.name = "Use 80 characters or fewer.";
  const seated = capacityField(values.seatedCapacity, "Seated capacity");
  if (seated.error) errors.seatedCapacity = seated.error;
  const standing = capacityField(values.standingCapacity, "Standing capacity");
  if (standing.error) errors.standingCapacity = standing.error;
  const notes = values.notes.trim();
  if (notes.length > 500) errors.notes = "Use 500 characters or fewer.";
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    input: {
      name,
      seatedCapacity: seated.value,
      standingCapacity: standing.value,
      notes: notes === "" ? null : notes,
    },
  };
}
