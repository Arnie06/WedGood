import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardTitle } from "@/components/ui/card";
import { TrayButton } from "@/components/ui/tray";
import {
  DIRECTION_LABELS,
  MAX_RUNS_PER_EVENT,
  coverageSentence,
  runToFormValues,
  summarizeShuttles,
  type ShuttleDirection,
  type ShuttleRunField,
} from "@/domain/shuttles/shuttles";
import {
  AddRidersForm,
  RemoveShuttleForm,
  ShuttleRunForm,
  TakeOffButton,
  type RiderChoice,
} from "@/features/shuttles/shuttle-forms";
import { instantToLocal } from "@/domain/timeline/zoned";
import { dayLabel, timeLabel, zoneName } from "@/features/timeline/format";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { shuttlesEnabled } from "@/server/shuttles/flag";
import { loadShuttles, type ShuttleGuest } from "@/server/shuttles/queries";
import { loadEventLabels } from "@/server/timeline/queries";

export const metadata: Metadata = { title: "Shuttles" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const link = "font-semibold text-action-emphasis underline underline-offset-4";
const linkRow = `${link} inline-flex min-h-11 items-center`;

const HEADINGS: Record<ShuttleDirection, string> = {
  to_event: "Getting there",
  from_event: "Getting home",
};

export default async function ShuttlesPage({
  params,
}: {
  params: Promise<{ w: string; eventId: string }>;
}) {
  const { w, eventId } = await params;
  const access = await requireWorkspace(w);
  if (!shuttlesEnabled() || !UUID.test(eventId)) notFound();
  const wid = access.wedding.id;
  const base = `/app/${wid}`;
  const labels = await loadEventLabels(wid);
  const label = labels.find((e) => e.id === eventId);
  if (!label) notFound();
  const eventHref = `${base}/plan/events/${eventId}`;

  if (!hasCapability(access, "guests.manage")) {
    return (
      <div className="max-w-3xl space-y-4">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">Shuttles</h1>
        <Card>
          <p className="text-body-md">
            Shuttle lists show who is attending, so they are limited to people who manage guests.
          </p>
        </Card>
        <Link href={eventHref} className={linkRow}>
          Back to {label.name}
        </Link>
      </div>
    );
  }

  const tz = label.effectiveTimeZone;
  const data = await loadShuttles(wid, eventId);
  const summary = summarizeShuttles<ShuttleGuest>(data);
  const runName = new Map(data.runs.map((r) => [r.id, r.label]));
  const rideOf = new Map(data.assignments.map((a) => [`${a.direction}:${a.guestId}`, a.runId]));
  const zoneLabel = zoneName(
    tz,
    label.localDate ? new Date(`${label.localDate}T12:00:00Z`) : new Date(),
  );
  const blank: Record<ShuttleRunField, string> = {
    direction: "to_event",
    label: "",
    pickup: "",
    dropoff: "",
    date: label.localDate ?? "",
    time: "",
    capacity: "",
    notes: "",
  };
  const atLimit = data.runs.length >= MAX_RUNS_PER_EVENT;

  const addTray = (direction: ShuttleDirection, variant: "primary" | "outline") => (
    <TrayButton
      label={direction === "to_event" ? "Add a shuttle there" : "Add a shuttle home"}
      variant={variant}
      size="sm"
      title="Add a shuttle"
      description={`${label.name} · times in ${zoneLabel}`}
    >
      <ShuttleRunForm
        workspaceId={wid}
        eventId={eventId}
        zoneLabel={zoneLabel}
        initial={{ ...blank, direction }}
      />
    </TrayButton>
  );

  return (
    <div className="max-w-3xl space-y-6" data-testid="shuttles-page">
      <header className="space-y-3">
        <p className="text-body-md">
          <Link href={eventHref} className={linkRow}>
            Back to {label.name}
          </Link>
        </p>
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">
          Shuttles for {label.name}
        </h1>
        <p className="text-body-lg text-ink-muted">
          Plan rides for guests who are attending. If someone declines or stops attending, they come
          off their shuttle straight away. Nothing here is sent to guests or drivers.
        </p>
        <p className="text-body-md text-ink-muted">
          Times are in {zoneLabel} ({tz}).
        </p>
      </header>

      <Card as="section" aria-labelledby="coverage-heading" className="space-y-3">
        <CardTitle>
          <span id="coverage-heading">Who has a ride</span>
        </CardTitle>
        {summary.attending === 0 ? (
          <p className="text-body-md" data-testid="shuttle-coverage">
            No one has accepted yet. You can add shuttles now and fill them as replies come in.
          </p>
        ) : (
          <ul className="space-y-1 text-body-md" data-testid="shuttle-coverage">
            {summary.directions.map((d) => (
              <li key={d.direction}>
                {coverageSentence(d, summary.attending)}
                {d.runs.length > 0 && (
                  <span className="text-ink-muted">
                    {" "}
                    {d.seats} {d.seats === 1 ? "seat" : "seats"} on {d.runs.length}{" "}
                    {d.runs.length === 1 ? "shuttle" : "shuttles"}.
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="text-body-sm text-ink-muted">
          Not every guest needs a ride, so these are lists, not warnings.
        </p>
        {data.runs.length > 0 && (
          <p>
            <a href={`${eventHref}/shuttles/export`} className={linkRow} download>
              Download the rider list (CSV)
            </a>
          </p>
        )}
      </Card>

      {summary.directions.map((d, index) => (
        <section
          key={d.direction}
          aria-labelledby={`dir-${d.direction}`}
          className="space-y-4"
          data-testid={`shuttles-${d.direction}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id={`dir-${d.direction}`} className="font-serif text-headline-sm">
              {HEADINGS[d.direction]}
            </h2>
            {!atLimit && addTray(d.direction, index === 0 ? "primary" : "outline")}
          </div>
          {atLimit && index === 0 && (
            <p className="text-body-md text-ink-muted">
              This event has {MAX_RUNS_PER_EVENT} shuttles, the most it can hold.
            </p>
          )}

          {d.runs.length === 0 ? (
            <p className="text-body-md text-ink-muted">
              No shuttles {d.direction === "to_event" ? "to" : "from"} {label.name} yet.
            </p>
          ) : (
            <ul className="space-y-4">
              {d.runs.map((run) => {
                const choices: RiderChoice[] = data.attending
                  .filter((g) => !run.riders.some((r) => r.id === g.id))
                  .map((g) => {
                    const other = rideOf.get(`${d.direction}:${g.id}`);
                    return {
                      id: g.id,
                      name: g.name,
                      household: g.household,
                      currentRun: other ? (runName.get(other) ?? "another shuttle") : null,
                    };
                  })
                  .sort((a, b) => a.name.localeCompare(b.name));
                const full = run.open === 0;
                return (
                  <Card
                    as="li"
                    key={run.id}
                    className="space-y-3"
                    aria-labelledby={`run-${run.id}`}
                    data-testid="shuttle-run"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h3
                          id={`run-${run.id}`}
                          className="font-serif text-headline-sm break-words"
                        >
                          {run.label}
                        </h3>
                        <p className="text-body-md">
                          Departs {timeLabel(run.departsAt, tz)}
                          {instantToLocal(new Date(run.departsAt), tz).date !== label.localDate
                            ? `, ${dayLabel(run.departsAt, tz)}`
                            : ""}
                        </p>
                        <p className="text-body-md text-ink-muted break-words">
                          From {run.pickup}
                          {run.dropoff ? ` to ${run.dropoff}` : ""}
                        </p>
                      </div>
                      <p
                        className={`text-label-lg font-semibold ${full ? "text-action-secondary" : ""}`}
                        data-testid="run-seats"
                      >
                        {run.riders.length} of {run.capacity} seats taken
                        {full ? " · Full" : ""}
                      </p>
                    </div>
                    {run.notes && (
                      <p className="text-body-sm whitespace-pre-line text-ink-muted break-words">
                        {run.notes}
                      </p>
                    )}
                    {run.riders.length === 0 ? (
                      <p className="text-body-md text-ink-muted">No riders yet.</p>
                    ) : (
                      <ul
                        className="divide-y divide-border-hairline border-y border-border-hairline"
                        aria-label={`Riders on ${run.label}`}
                      >
                        {run.riders.map((g) => (
                          <li key={g.id} className="flex items-center justify-between gap-3 py-1">
                            <span className="min-w-0 text-body-md break-words">
                              {g.name}
                              {g.household && (
                                <span className="block text-body-sm text-ink-muted">
                                  {g.household}
                                </span>
                              )}
                            </span>
                            <TakeOffButton
                              workspaceId={wid}
                              runId={run.id}
                              guest={{ id: g.id, name: g.name }}
                              runLabel={run.label}
                            />
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="flex flex-wrap gap-3">
                      {!full && (
                        <TrayButton
                          label="Add riders"
                          ariaLabel={`Add riders to ${run.label}`}
                          variant="secondary"
                          size="sm"
                          title={`Add riders to ${run.label}`}
                          description={`${DIRECTION_LABELS[d.direction]} · departs ${timeLabel(run.departsAt, tz)}`}
                        >
                          <AddRidersForm
                            workspaceId={wid}
                            run={{ id: run.id, label: run.label, open: run.open }}
                            choices={choices}
                          />
                        </TrayButton>
                      )}
                      <TrayButton
                        label="Edit"
                        ariaLabel={`Edit ${run.label}`}
                        variant="outline"
                        size="sm"
                        title={`Edit ${run.label}`}
                        description={`Times in ${zoneLabel}`}
                      >
                        <ShuttleRunForm
                          workspaceId={wid}
                          eventId={eventId}
                          zoneLabel={zoneLabel}
                          initial={runToFormValues(run, tz)}
                          run={{ id: run.id, version: run.version }}
                        />
                      </TrayButton>
                      <TrayButton
                        label="Remove"
                        ariaLabel={`Remove ${run.label}`}
                        variant="quiet"
                        size="sm"
                        title={`Remove ${run.label}?`}
                      >
                        <RemoveShuttleForm
                          workspaceId={wid}
                          run={{
                            id: run.id,
                            version: run.version,
                            label: run.label,
                            riders: run.riders.length,
                          }}
                        />
                      </TrayButton>
                    </div>
                  </Card>
                );
              })}
            </ul>
          )}

          {d.runs.length > 0 && d.withoutRide.length > 0 && (
            <details className="rounded-card border border-border-hairline bg-surface p-4">
              <summary className="min-h-11 cursor-pointer py-2 text-label-lg font-semibold text-action-emphasis">
                Attending without a ride {d.direction === "to_event" ? "there" : "home"} (
                {d.withoutRide.length})
              </summary>
              <ul className="mt-2 columns-1 text-body-md sm:columns-2">
                {d.withoutRide.map((g) => (
                  <li key={g.id} className="break-words">
                    {g.name}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      ))}
    </div>
  );
}
