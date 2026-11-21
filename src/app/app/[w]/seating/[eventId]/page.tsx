import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import { buildSeatingPlan, snapshotState } from "@/domain/seating/plan";
import {
  AddTableForm,
  EditTableForm,
  FinalizeForm,
  SeatForm,
  StartPlanForm,
  TentativeToggle,
  UnseatForm,
} from "@/features/seating/seating-forms";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadSeating } from "@/server/seating/queries";

export const metadata: Metadata = { title: "Seating plan" };

const link = "font-semibold text-action-emphasis underline underline-offset-4";
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }) + " UTC";

export default async function SeatingPage({
  params,
}: {
  params: Promise<{ w: string; eventId: string }>;
}) {
  const { w, eventId } = await params;
  const access = await requireWorkspace(w);
  const wid = access.wedding.id;
  const base = `/app/${wid}`;
  if (!z.uuid().safeParse(eventId).success) notFound();

  if (!hasCapability(access, "guests.manage")) {
    return (
      <div className="max-w-3xl space-y-4">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">Seating plan</h1>
        <Card>
          <p className="text-body-md">
            Seating shows guest names and answers, so it is limited to the workspace owner and
            partner.
          </p>
        </Card>
      </div>
    );
  }

  const data = await loadSeating(wid, eventId);
  if (!data) notFound();
  const { event, layout } = data;

  const header = (
    <header className="space-y-2">
      <h1 className="font-serif text-headline-mobile md:text-headline-lg">Seating: {event.name}</h1>
      <p className="flex flex-wrap gap-x-6 gap-y-1 text-body-md">
        <Link href={`${base}/seating`} className={`${link} inline-flex min-h-11 items-center`}>
          All events
        </Link>
        <Link
          href={`${base}/guests/invitations`}
          className={`${link} inline-flex min-h-11 items-center`}
        >
          Events and invitations
        </Link>
      </p>
    </header>
  );

  if (!layout) {
    return (
      <div className="max-w-3xl space-y-6">
        {header}
        <Card className="space-y-3">
          <p className="text-body-md text-ink-muted">
            No seating plan yet. Start one, add your tables, then seat the guests who are attending.
            Nothing is sent to anyone.
          </p>
          <StartPlanForm workspaceId={wid} eventId={event.id} />
        </Card>
      </div>
    );
  }

  const plan = buildSeatingPlan({
    guests: data.guests,
    members: data.members,
    tables: data.tables,
    assignments: data.assignments,
    meals: data.meals,
    allowTentative: layout.allowTentative,
  });
  const state = snapshotState(layout);
  const choices = plan.tables.map((t) => ({ id: t.id, label: t.label, open: t.open }));
  const shortBy = plan.totals.unassignedAccepted - plan.totals.openSeats;
  const tableVersion = new Map(data.tables.map((t) => [t.id, t.version]));
  const seatedAt = new Map<string, string>();
  for (const t of plan.tables) {
    for (const g of [...t.confirmed, ...t.tentative]) seatedAt.set(g.id, t.id);
  }
  const t = plan.totals;

  return (
    <div className="max-w-3xl space-y-8">
      {header}

      <section aria-label="Totals">
        <Card className="space-y-4">
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[
              ["Attending", t.accepted],
              ["Seated", t.confirmedSeated],
              ["Still to seat", t.unassignedAccepted],
              ["Open seats", t.openSeats],
            ].map(([label, n]) => (
              <div key={label}>
                <dt className="text-label-lg text-ink-muted">{label}</dt>
                <dd className="font-serif text-headline-sm">{n}</dd>
              </div>
            ))}
          </dl>
          {(t.tentativeSeated > 0 || layout.allowTentative) && (
            <p className="text-body-md text-ink-muted">
              Tentative (waiting for an answer, not counted as seated): {t.tentativeSeated}
            </p>
          )}
          {event.capacity !== null && t.capacity > event.capacity && (
            <p role="status" className="text-body-md text-danger">
              Your tables have {t.capacity} seats, which is more than the {event.capacity} this
              event is set up for.
            </p>
          )}
          {shortBy > 0 && (
            <p role="status" className="text-body-md text-danger">
              You need {shortBy} more {shortBy === 1 ? "seat" : "seats"} for everyone who is
              attending. Add a table or make one larger.
            </p>
          )}
          {plan.issues.map((issue) => (
            <p key={issue} role="alert" className="text-body-md text-danger">
              {issue}
            </p>
          ))}
        </Card>
      </section>

      <section aria-labelledby="final" className="space-y-3">
        <h2 id="final" className="font-serif text-headline-sm">
          Final plan
        </h2>
        <Card className="space-y-3">
          {state === "none" && (
            <p className="text-body-md text-ink-muted">
              Not finalized. Finalizing freezes a copy of this plan, with guest names and meals, to
              share later. You can keep editing; the copy won&apos;t change.
            </p>
          )}
          {state === "current" && layout.finalizedAt && (
            <p className="text-body-md">
              <Badge tone="confirmed">Finalized</Badge> {when(layout.finalizedAt)}. The plan
              hasn&apos;t changed since.
            </p>
          )}
          {state === "stale" && layout.finalizedAt && (
            <div role="status" className="space-y-1">
              <p className="text-body-md">
                <Badge tone="pending">Out of date</Badge> Finalized {when(layout.finalizedAt)}, but
                seating, an answer or a meal has changed since.
              </p>
              {layout.frozen && (
                <p className="text-body-sm text-ink-muted">
                  The frozen copy had {layout.frozen.accepted} attending and{" "}
                  {layout.frozen.confirmedSeated} seated.
                </p>
              )}
            </div>
          )}
          {state !== "current" && (
            <FinalizeForm
              workspaceId={wid}
              layoutId={layout.id}
              revision={layout.revision}
              label={state === "stale" ? "Finalize again" : "Finalize this plan"}
            />
          )}
        </Card>
      </section>

      <section aria-labelledby="queue" className="space-y-3">
        <h2 id="queue" className="font-serif text-headline-sm">
          Guests to seat ({plan.queue.length})
        </h2>
        {plan.tables.length === 0 && plan.queue.length > 0 && (
          <p className="text-body-md text-ink-muted">Add a table below, then seat your guests.</p>
        )}
        {plan.queue.length === 0 && (
          <p className="text-body-md text-ink-muted">
            {t.accepted === 0
              ? "No one has said they are attending yet. Guests appear here when they accept."
              : "Everyone who is attending has a seat."}
          </p>
        )}
        <ul className="space-y-3">
          {plan.queue.map((g) => (
            <li key={g.id} className="rounded-card border border-border-hairline p-3">
              <p className="font-semibold">{g.name}</p>
              {plan.tables.length > 0 && (
                <SeatForm workspaceId={wid} layoutId={layout.id} guest={g} tables={choices} />
              )}
            </li>
          ))}
        </ul>
        {layout.allowTentative && plan.waitingQueue.length > 0 && (
          <div className="space-y-3">
            <h3 className="text-label-lg font-semibold">
              Waiting for an answer ({plan.waitingQueue.length})
            </h3>
            <ul className="space-y-3">
              {plan.waitingQueue.map((g) => (
                <li key={g.id} className="rounded-card border border-border-hairline p-3">
                  <p className="font-semibold">
                    {g.name} <Badge tone="pending">Tentative</Badge>
                  </p>
                  {plan.tables.length > 0 && (
                    <SeatForm workspaceId={wid} layoutId={layout.id} guest={g} tables={choices} />
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section aria-labelledby="tables" className="space-y-3">
        <h2 id="tables" className="font-serif text-headline-sm">
          Tables ({plan.tables.length})
        </h2>
        {plan.tables.length === 0 && (
          <p className="text-body-md text-ink-muted">No tables yet. Add your first one below.</p>
        )}
        {plan.tables.map((table) => (
          <Card key={table.id} className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>{table.label}</CardTitle>
              <p className="text-body-md">
                {table.used} of {table.capacity} seats
                {table.open === 0 && (
                  <span className="ml-2">
                    <Badge tone="neutral">Full</Badge>
                  </span>
                )}
              </p>
            </div>
            {table.used === 0 && (
              <p className="text-body-md text-ink-muted">No one is seated here yet.</p>
            )}
            <ul className="space-y-3">
              {[
                ...table.confirmed.map((g) => ({ g, tentative: false })),
                ...table.tentative.map((g) => ({ g, tentative: true })),
              ].map(({ g, tentative }) => (
                <li
                  key={g.id}
                  className="space-y-2 border-t border-border-hairline pt-3 first:border-t-0 first:pt-0"
                >
                  <p>
                    <span className="font-semibold">{g.name}</span>
                    {tentative && (
                      <>
                        {" "}
                        <Badge tone="pending">Tentative</Badge>
                      </>
                    )}
                  </p>
                  <SeatForm
                    workspaceId={wid}
                    layoutId={layout.id}
                    guest={g}
                    tables={choices}
                    currentTableId={seatedAt.get(g.id) ?? table.id}
                  />
                  <UnseatForm workspaceId={wid} layoutId={layout.id} guest={g} />
                </li>
              ))}
            </ul>
            {table.meals.some((m) => m.confirmed + m.tentative > 0) && (
              <p className="text-body-sm text-ink-muted">
                Meals:{" "}
                {table.meals
                  .filter((m) => m.confirmed + m.tentative > 0)
                  .map(
                    (m) =>
                      `${m.name} ${m.confirmed}${m.tentative ? ` (+${m.tentative} tentative)` : ""}`,
                  )
                  .join(" · ")}
              </p>
            )}
            <details>
              <summary className="min-h-11 cursor-pointer font-semibold text-action-emphasis">
                Edit or remove {table.label}
              </summary>
              <div className="mt-3">
                <EditTableForm
                  workspaceId={wid}
                  table={{
                    id: table.id,
                    label: table.label,
                    capacity: table.capacity,
                    version: tableVersion.get(table.id) ?? 0,
                  }}
                />
              </div>
            </details>
          </Card>
        ))}
        <Card className="space-y-3">
          <h3 className="font-serif text-headline-sm">Add a table</h3>
          <AddTableForm workspaceId={wid} layoutId={layout.id} />
        </Card>
      </section>

      <section aria-labelledby="meals" className="space-y-3">
        <h2 id="meals" className="font-serif text-headline-sm">
          Meal report
        </h2>
        <Card className="space-y-3">
          {t.accepted === 0 ? (
            <p className="text-body-md text-ink-muted">Meal totals appear when guests accept.</p>
          ) : (
            <>
              <p className="text-body-sm text-ink-muted">
                Everyone who is attending, counted once. Declined guests are never included.
              </p>
              <table className="w-full text-left text-body-md">
                <caption className="sr-only">Meal choices of guests who are attending</caption>
                <thead>
                  <tr className="border-b border-border-hairline">
                    <th scope="col" className="py-2 pr-4 font-semibold">
                      Meal
                    </th>
                    <th scope="col" className="py-2 text-right font-semibold">
                      Guests
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {plan.meals.map((m) => (
                    <tr key={m.mealOptionId ?? "none"} className="border-b border-border-hairline">
                      <th scope="row" className="py-2 pr-4 font-normal">
                        {m.name}
                      </th>
                      <td className="py-2 text-right">{m.confirmed}</td>
                    </tr>
                  ))}
                  <tr>
                    <th scope="row" className="py-2 pr-4">
                      Total attending
                    </th>
                    <td className="py-2 text-right font-semibold">{t.accepted}</td>
                  </tr>
                </tbody>
              </table>
              {t.acceptedWithoutMeal > 0 && (
                <p role="status" className="text-body-md text-danger">
                  {t.acceptedWithoutMeal}{" "}
                  {t.acceptedWithoutMeal === 1 ? "guest hasn't" : "guests haven't"} chosen a meal
                  yet.
                </p>
              )}
            </>
          )}
          <p className="flex flex-wrap gap-x-6 gap-y-1 text-body-md">
            <a
              href={`${base}/seating/${event.id}/export?view=seating`}
              className={`${link} inline-flex min-h-11 items-center`}
            >
              Download seating as CSV
            </a>
            <a
              href={`${base}/seating/${event.id}/export?view=meals`}
              className={`${link} inline-flex min-h-11 items-center`}
            >
              Download meal totals as CSV
            </a>
          </p>
          <p className="text-body-sm text-ink-muted">
            Downloads include names, tables and meals only. Dietary and access notes stay private
            for now.
          </p>
        </Card>
      </section>

      <section aria-labelledby="options" className="space-y-3">
        <h2 id="options" className="font-serif text-headline-sm">
          Options
        </h2>
        <Card className="space-y-3">
          <p className="text-body-md text-ink-muted">
            Tentative seating lets you hold a table for guests who haven&apos;t answered yet. They
            are counted separately and never as seated.
          </p>
          <TentativeToggle
            workspaceId={wid}
            layoutId={layout.id}
            version={layout.version}
            allow={layout.allowTentative}
          />
        </Card>
      </section>
    </div>
  );
}
