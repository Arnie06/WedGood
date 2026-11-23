import { instantToLocal, localToInstant } from "@/domain/timeline/zoned";

/**
 * Guest shuttles (UX-17 first slice). Pure rules shared by the server actions, the page and the
 * manifest export. The database re-checks everything that matters (eligibility, seats, one ride
 * each way); these functions only shape input and explain the current state honestly.
 */

export const SHUTTLE_DIRECTIONS = ["to_event", "from_event"] as const;
export type ShuttleDirection = (typeof SHUTTLE_DIRECTIONS)[number];

export const DIRECTION_LABELS: Record<ShuttleDirection, string> = {
  to_event: "To the event",
  from_event: "From the event",
};

export function isShuttleDirection(value: unknown): value is ShuttleDirection {
  return typeof value === "string" && (SHUTTLE_DIRECTIONS as readonly string[]).includes(value);
}

export const MAX_RUN_SEATS = 100;
export const MAX_RUNS_PER_EVENT = 30;

export type ShuttleRunField =
  "direction" | "label" | "pickup" | "dropoff" | "date" | "time" | "capacity" | "notes";

export type ShuttleRunInput = {
  direction: ShuttleDirection;
  label: string;
  pickup: string;
  dropoff: string | null;
  /** ISO instant. */
  departsAt: string;
  capacity: number;
  notes: string | null;
};

export type ShuttleRunParse =
  | { ok: true; value: ShuttleRunInput }
  | { ok: false; fieldErrors: Partial<Record<ShuttleRunField, string>> };

const oneLine = (s: string | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();
const multiline = (s: string | undefined): string => (s ?? "").replace(/\r\n/g, "\n").trim();

/** Validates a run. The date and time are wall-clock in the event's IANA zone. */
export function parseShuttleRunInput(
  raw: Partial<Record<ShuttleRunField, string>>,
  timeZone: string,
): ShuttleRunParse {
  const errors: Partial<Record<ShuttleRunField, string>> = {};
  const direction = (raw.direction ?? "").trim();
  if (!isShuttleDirection(direction)) errors.direction = "Choose which way this shuttle goes.";

  const label = oneLine(raw.label);
  if (label === "") errors.label = "Give this shuttle a name, such as Hotel shuttle 1.";
  else if (label.length > 60) errors.label = "Use 60 characters or fewer.";

  const pickup = oneLine(raw.pickup);
  if (pickup === "") errors.pickup = "Say where guests get on.";
  else if (pickup.length > 200) errors.pickup = "Use 200 characters or fewer.";

  const dropoff = oneLine(raw.dropoff);
  if (dropoff.length > 200) errors.dropoff = "Use 200 characters or fewer.";

  const notes = multiline(raw.notes);
  if (notes.length > 500) errors.notes = "Keep notes to 500 characters or fewer.";

  const capacityRaw = (raw.capacity ?? "").trim();
  const capacity = Number(capacityRaw);
  if (
    capacityRaw === "" ||
    !/^\d+$/.test(capacityRaw) ||
    !Number.isInteger(capacity) ||
    capacity < 1 ||
    capacity > MAX_RUN_SEATS
  ) {
    errors.capacity = `Enter a whole number of seats from 1 to ${MAX_RUN_SEATS}.`;
  }

  const date = (raw.date ?? "").trim();
  const time = (raw.time ?? "").trim();
  if (!date) errors.date = "Choose a date.";
  if (!time) errors.time = "Choose a departure time.";
  let departsAt: Date | null = null;
  if (date && time) {
    const result = localToInstant(date, time, timeZone);
    switch (result.kind) {
      case "ok": {
        const year = result.instant.getUTCFullYear();
        if (year < 1970 || year > 2200) errors.date = "Choose a date between 1970 and 2200.";
        else departsAt = result.instant;
        break;
      }
      case "nonexistent":
        errors.time =
          "That time doesn't exist on this date because clocks move forward. Choose a time outside the skipped hour.";
        break;
      case "ambiguous":
        errors.time =
          "That time happens twice on this date because clocks move back. Choose a time outside the repeated hour.";
        break;
      case "invalid":
        errors.date = "Enter a valid date and time.";
        break;
    }
  }

  if (Object.keys(errors).length > 0 || !departsAt || !isShuttleDirection(direction)) {
    return { ok: false, fieldErrors: errors };
  }
  return {
    ok: true,
    value: {
      direction,
      label,
      pickup,
      dropoff: dropoff || null,
      departsAt: departsAt.toISOString(),
      capacity,
      notes: notes || null,
    },
  };
}

export type ShuttleRun = {
  id: string;
  direction: ShuttleDirection;
  label: string;
  pickup: string;
  dropoff: string | null;
  departsAt: string;
  capacity: number;
  notes: string | null;
  version: number;
};

export type ShuttleAssignment = { runId: string; guestId: string; direction: ShuttleDirection };

/** Form values for editing a run, in the event's zone. */
export function runToFormValues(
  run: ShuttleRun,
  timeZone: string,
): Record<ShuttleRunField, string> {
  const local = instantToLocal(new Date(run.departsAt), timeZone);
  return {
    direction: run.direction,
    label: run.label,
    pickup: run.pickup,
    dropoff: run.dropoff ?? "",
    date: local.date,
    time: local.time,
    capacity: String(run.capacity),
    notes: run.notes ?? "",
  };
}

export type RunView<G> = ShuttleRun & { riders: G[]; open: number };

export type DirectionSummary<G> = {
  direction: ShuttleDirection;
  runs: RunView<G>[];
  seats: number;
  riding: number;
  /** Attending guests with no ride this way. Not everyone needs one; this is a list, not a warning. */
  withoutRide: G[];
};

export type ShuttleSummary<G> = {
  attending: number;
  directions: DirectionSummary<G>[];
};

/**
 * Groups runs by direction (earliest departure first, then name), puts each attending guest on the
 * run they ride, and lists who has no ride each way. Rows for guests who are no longer attending are
 * ignored here (the database removes them in the same transaction as the reply, so this only guards
 * a read that raced a change).
 */
export function summarizeShuttles<G extends { id: string; name: string }>(input: {
  runs: readonly ShuttleRun[];
  assignments: readonly ShuttleAssignment[];
  attending: readonly G[];
}): ShuttleSummary<G> {
  const byName = (a: G, b: G) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  const guests = new Map(input.attending.map((g) => [g.id, g]));
  const sorted = [...input.runs].sort(
    (a, b) =>
      a.departsAt.localeCompare(b.departsAt) ||
      a.label.localeCompare(b.label) ||
      a.id.localeCompare(b.id),
  );
  const directions = SHUTTLE_DIRECTIONS.map((direction): DirectionSummary<G> => {
    const runs = sorted
      .filter((r) => r.direction === direction)
      .map((run): RunView<G> => {
        const riders = input.assignments
          .filter((a) => a.runId === run.id)
          .flatMap((a) => {
            const g = guests.get(a.guestId);
            return g ? [g] : [];
          })
          .sort(byName);
        return { ...run, riders, open: Math.max(0, run.capacity - riders.length) };
      });
    const riding = new Set(runs.flatMap((r) => r.riders.map((g) => g.id)));
    return {
      direction,
      runs,
      seats: runs.reduce((n, r) => n + r.capacity, 0),
      riding: riding.size,
      withoutRide: input.attending.filter((g) => !riding.has(g.id)).sort(byName),
    };
  });
  return { attending: input.attending.length, directions };
}

/** One sentence per direction, e.g. "12 of 40 attending guests have a ride to the event." */
export function coverageSentence(
  d: { direction: ShuttleDirection; riding: number },
  attending: number,
) {
  const way = d.direction === "to_event" ? "to the event" : "back from the event";
  return `${d.riding} of ${attending} attending ${attending === 1 ? "guest has" : "guests have"} a ride ${way}.`;
}

/** Manifest rows for the CSV: one row per rider, runs in departure order. No private details. */
export function manifestRows<G extends { id: string; name: string }>(
  summary: ShuttleSummary<G>,
  timeZone: string,
  formatTime: (iso: string, timeZone: string) => string,
): string[][] {
  const header = ["Direction", "Shuttle", "Departs", "Pickup", "Drop-off", "Guest"];
  const rows: string[][] = [];
  for (const d of summary.directions) {
    for (const run of d.runs) {
      const base = [
        DIRECTION_LABELS[d.direction],
        run.label,
        formatTime(run.departsAt, timeZone),
        run.pickup,
        run.dropoff ?? "",
      ];
      if (run.riders.length === 0) rows.push([...base, "(no riders yet)"]);
      for (const g of run.riders) rows.push([...base, g.name]);
    }
  }
  return [header, ...rows];
}
