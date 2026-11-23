import { HOW_WE_COUNT, describePlanningNumber, type EventDemand } from "@/domain/events/demand";

/** Explains each word once, in plain language. Native disclosure: keyboard and screen-reader ready. */
export function HowWeCount() {
  return (
    <details className="text-body-md">
      <summary className="inline-flex min-h-11 cursor-pointer items-center font-semibold text-action-emphasis underline underline-offset-4">
        How we count
      </summary>
      <dl className="mt-2 space-y-2">
        {HOW_WE_COUNT.map((h) => (
          <div key={h.term}>
            <dt className="font-semibold">{h.term}</dt>
            <dd className="text-ink-muted">{h.meaning}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/** Shown instead of counts when the viewer may not read guest totals. */
export function TotalsHidden() {
  return (
    <p className="text-body-md text-ink-muted" data-testid="totals-hidden">
      Guest totals are shared only with the owner and partner. Ask the owner if you need them.
    </p>
  );
}

/**
 * The one place reply counts are drawn. Every page passes the same server-computed `EventDemand`, so
 * the numbers cannot drift apart. Unnamed plus-ones stay on their own line, never inside Attending.
 */
export function CountStrip({
  demand,
  eventName,
  capacity,
}: {
  demand: EventDemand;
  eventName: string;
  capacity?: number | null;
}) {
  const main: [string, number][] = [
    ["Invited", demand.invited],
    ["Attending", demand.yes],
    ["Waiting", demand.waiting],
    ["Not attending", demand.no],
  ];
  const over = capacity != null && demand.yes > capacity;
  const planOver = capacity != null && !over && demand.planningNumber > capacity;
  return (
    <div className="space-y-3" data-testid="count-strip">
      <dl
        className="grid grid-cols-2 gap-4 sm:grid-cols-4"
        aria-label={`Responses for ${eventName}`}
      >
        {main.map(([label, n]) => (
          <div key={label}>
            <dt className="text-label-lg text-ink-muted">{label}</dt>
            <dd className="font-serif text-headline-sm">{n}</dd>
          </div>
        ))}
      </dl>
      <p className="text-body-md" data-testid="planning-number">
        {describePlanningNumber(demand)}
      </p>
      {over && (
        <p role="status" className="text-body-md text-danger">
          {demand.yes} guests are attending, which is more than the capacity of {capacity}.
        </p>
      )}
      {planOver && (
        <p role="status" className="text-body-md text-danger">
          The planning number of {demand.planningNumber} is more than the capacity of {capacity}.
        </p>
      )}
      <HowWeCount />
    </div>
  );
}
