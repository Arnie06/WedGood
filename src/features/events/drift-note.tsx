import { CircleAlert, Info } from "lucide-react";
import Link from "next/link";
import { driftSentence, guaranteeDrift } from "@/domain/events/guarantee";

/**
 * "Locked 118 · now 96 attending": the caterer count against today's replies. Calm by default.
 * When more people are attending than the caterer was told, the note says so with an icon and
 * words (never colour alone) and points to the revision. It never changes the locked count.
 */
export function DriftNote({
  locked,
  yes,
  waiting,
  eventName,
  href,
  testId = "drift-note",
}: {
  locked: number;
  yes: number;
  waiting: number;
  /** Shown first when several events are listed together. */
  eventName?: string;
  /** Where to revise it. */
  href?: string;
  testId?: string;
}) {
  const drift = guaranteeDrift(locked, yes);
  const Icon = drift.advise ? CircleAlert : Info;
  return (
    <p
      className="flex items-start gap-2 text-body-md"
      data-testid={testId}
      data-state={drift.state}
    >
      <Icon
        aria-hidden="true"
        className={
          drift.advise
            ? "mt-0.5 size-4 shrink-0 text-danger"
            : "mt-0.5 size-4 shrink-0 text-ink-muted"
        }
      />
      <span>
        {eventName && <span className="font-semibold">{eventName}: </span>}
        {drift.advise && <span className="sr-only">Check: </span>}
        {driftSentence(locked, yes, waiting)}
        {drift.advise && href && (
          <>
            {" "}
            <Link
              href={href}
              className="inline-flex min-h-11 items-center font-semibold text-action-emphasis underline underline-offset-4"
            >
              Review the caterer count
            </Link>
          </>
        )}
      </span>
    </p>
  );
}
