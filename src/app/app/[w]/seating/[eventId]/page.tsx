import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { SelectField } from "@/components/ui/select-field";
import { ProgressBar } from "@/components/ui/progress-bar";
import { TrayButton } from "@/components/ui/tray";
import { overlapNotes, placeTables, type FloorTable } from "@/domain/seating/floor";
import { buildSeatingPlan, snapshotState } from "@/domain/seating/plan";
import { seatCards, tableCard } from "@/domain/seating/cards";
import { suggestSeating } from "@/domain/seating/suggest";
import { buildGuestViews } from "@/domain/seating/views";
import {
  AddElementForm,
  AddTableForm,
  FinalizeForm,
  SeatForm,
  SeatGroupForm,
  StartPlanForm,
  TentativeToggle,
  UnseatForm,
} from "@/features/seating/seating-forms";
import { FloorPlan, type FloorTableNode } from "@/features/seating/floor-plan";
import {
  ElementPanel,
  GuestFlags,
  GuestPanel,
  SuggestionPanel,
  TablePanel,
} from "@/features/seating/seating-panels";
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
  searchParams,
}: {
  params: Promise<{ w: string; eventId: string }>;
  searchParams: Promise<{ view?: string | string[] }>;
}) {
  const { w, eventId } = await params;
  const { view: viewParam } = await searchParams;
  // The floor plan is the default; the list is the same tables as cards, for small screens and screen readers.
  const showList = viewParam === "list";
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
    info: data.info,
  });
  const views = buildGuestViews({
    plan,
    guests: data.guests,
    members: data.members,
    info: data.info,
    meals: data.meals,
  });
  const state = snapshotState(layout);
  const choices = plan.tables.map((t) => ({ id: t.id, label: t.label, open: t.open }));
  const shortBy = plan.totals.unassignedAccepted - plan.totals.openSeats;
  const tableVersion = new Map(data.tables.map((t) => [t.id, t.version]));
  const floorTables: FloorTable[] = data.tables.map((t) => ({
    id: t.id,
    label: t.label,
    capacity: t.capacity,
    shape: t.shape ?? "round",
    x: t.x,
    y: t.y,
  }));
  const placed = placeTables(floorTables, data.elements);
  const placedById = new Map(placed.map((p) => [p.id, p]));
  const overlapWarnings = overlapNotes(placed, data.elements);
  const t = plan.totals;
  const waitingUnseated = data.members.filter(
    (m) =>
      m.status === "pending" &&
      !plan.tables.some((tb) => tb.seats.some((x) => x.guest.id === m.guestId)),
  ).length;
  const suggestion = suggestSeating({ plan, info: data.info });
  const toSeat = layout.allowTentative ? [...plan.queue, ...plan.waitingQueue] : plan.queue;
  const guestPanel = (id: string) => {
    const view = views.get(id);
    return view ? (
      <GuestPanel
        workspaceId={wid}
        layoutId={layout.id}
        base={base}
        view={view}
        tables={choices}
        allowTentative={layout.allowTentative}
      />
    ) : null;
  };
  const tablePanel = (table: (typeof plan.tables)[number]) => {
    const spot = placedById.get(table.id);
    return (
      <TablePanel
        workspaceId={wid}
        layoutId={layout.id}
        table={table}
        version={tableVersion.get(table.id) ?? 0}
        views={views}
        candidates={toSeat.map((g) => ({ id: g.id, name: g.name }))}
        position={{ x: spot?.x ?? 0, y: spot?.y ?? 0 }}
        guestHrefBase={`${base}/guests`}
      />
    );
  };
  const floorNodes: FloorTableNode[] = plan.tables.flatMap((table) => {
    const spot = placedById.get(table.id);
    return spot
      ? [
          {
            id: table.id,
            label: table.label,
            capacity: table.capacity,
            shape: table.shape,
            x: spot.x,
            y: spot.y,
            size: spot.size,
            used: table.used,
            waiting: table.stats.waiting,
            captain: table.seats.find((x) => x.captain)?.guest.name ?? null,
          },
        ]
      : [];
  });
  const guestLink = (id: string, name: string) => (
    <TrayButton
      label={name}
      title={name}
      triggerStyle="plain"
      ariaLabel={`${name} details`}
      className="font-semibold"
    >
      {guestPanel(id)}
    </TrayButton>
  );

  const tablesSection = (
    <section aria-labelledby="tables" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="tables" className="font-serif text-headline-sm">
          Tables ({plan.tables.length})
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <TrayButton label="Add a table" title="Add a table" variant="secondary" size="sm">
            <AddTableForm workspaceId={wid} layoutId={layout.id} />
          </TrayButton>
          {!showList && (
            <TrayButton
              label="Add to the room"
              title="Add to the room"
              description="A dance floor, stage, bar or anything else that takes up space."
              variant="outline"
              size="sm"
            >
              <AddElementForm
                workspaceId={wid}
                layoutId={layout.id}
                tables={placed}
                elements={data.elements}
              />
            </TrayButton>
          )}
        </div>
      </div>
      <nav aria-label="Seating view" className="flex gap-2">
        {[
          { href: `${base}/seating/${event.id}`, label: "Floor plan", active: !showList },
          { href: `${base}/seating/${event.id}?view=list`, label: "List", active: showList },
        ].map((tab) => (
          <Link
            key={tab.label}
            href={tab.href}
            replace
            scroll={false}
            aria-current={tab.active ? "page" : undefined}
            className={`inline-flex min-h-11 items-center rounded-full px-4 text-label-lg font-semibold ${
              tab.active
                ? "bg-nav-selected text-on-action-emphasis"
                : "border border-border-control text-ink"
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      {plan.tables.length === 0 && (
        <p className="text-body-md text-ink-muted">No tables yet. Add your first one.</p>
      )}
      {!showList && (plan.tables.length > 0 || data.elements.length > 0) && (
        <>
          <FloorPlan
            workspaceId={wid}
            tables={floorNodes}
            elements={data.elements}
            tablePanels={Object.fromEntries(plan.tables.map((tb) => [tb.id, tablePanel(tb)]))}
            tableCards={Object.fromEntries(plan.tables.map((tb) => [tb.id, tableCard(tb)]))}
            seatCards={Object.fromEntries(plan.tables.map((tb) => [tb.id, seatCards(tb, views)]))}
            waitingForSeat={toSeat.length}
            guestHrefBase={`${base}/guests`}
            elementPanels={Object.fromEntries(
              data.elements.map((e) => [
                e.id,
                <ElementPanel key={e.id} workspaceId={wid} element={e} />,
              ]),
            )}
          />
          {overlapWarnings.length > 0 && (
            <ul role="status" className="space-y-1 text-body-md text-ink-muted">
              {overlapWarnings.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
        </>
      )}
      {showList &&
        plan.tables.map((table) => {
          const captain = table.seats.find((x) => x.captain);
          const st = table.stats;
          return (
            <Card key={table.id} className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle>{table.label}</CardTitle>
                <TrayButton
                  label="Details and edit"
                  title={table.label}
                  description={`${table.shape === "round" ? "Round" : "Rectangular"} table`}
                  triggerStyle="link"
                  ariaLabel={`Details and edit for ${table.label}`}
                >
                  {tablePanel(table)}
                </TrayButton>
              </div>
              <ProgressBar
                label="Seats"
                value={table.used}
                max={table.capacity}
                valueText={`${table.used} of ${table.capacity} seats${table.open === 0 ? " (full)" : ""}`}
              />
              {table.used > 0 && (
                <p className="text-body-md text-ink-muted">
                  {st.accepted} attending
                  {st.waiting > 0 && ` · ${st.waiting} waiting to answer`}
                  {captain && ` · Captain: ${captain.guest.name}`}
                </p>
              )}
              {table.used === 0 && (
                <p className="text-body-md text-ink-muted">No one is seated here yet.</p>
              )}
              {(st.plusOnes > 0 || st.children > 0 || st.dietary > 0 || st.accessibility > 0) && (
                <p className="flex flex-wrap gap-1.5">
                  {st.plusOnes > 0 && (
                    <Badge>
                      {st.plusOnes} {st.plusOnes === 1 ? "plus-one" : "plus-ones"}
                    </Badge>
                  )}
                  {st.children > 0 && (
                    <Badge>
                      {st.children} {st.children === 1 ? "child" : "children"}
                    </Badge>
                  )}
                  {st.dietary > 0 && <Badge>{st.dietary} dietary</Badge>}
                  {st.accessibility > 0 && <Badge>{st.accessibility} access</Badge>}
                </p>
              )}
              <ul className="space-y-2">
                {table.seats.map((seat) => {
                  const view = views.get(seat.guest.id);
                  return (
                    <li
                      key={seat.guest.id}
                      className="flex flex-wrap items-center justify-between gap-2 border-t border-border-hairline pt-2 first:border-t-0 first:pt-0"
                    >
                      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        {guestLink(seat.guest.id, seat.guest.name)}
                        {view && <GuestFlags view={view} />}
                      </div>
                      <UnseatForm workspaceId={wid} layoutId={layout.id} guest={seat.guest} />
                    </li>
                  );
                })}
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
            </Card>
          );
        })}
    </section>
  );

  return (
    <div className="max-w-3xl space-y-8">
      {header}

      <section aria-label="Totals">
        <Card className="space-y-4">
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
            {[
              ["Attending", t.accepted],
              ["Seated", t.confirmedSeated],
              ["Still to seat", t.unassignedAccepted],
              ["Open seats", t.openSeats],
              ["Dietary notes", t.dietary],
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

      {!showList && tablesSection}

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
        {!layout.allowTentative && waitingUnseated > 0 && (
          <p className="text-body-md text-ink-muted">
            {waitingUnseated} {waitingUnseated === 1 ? "guest hasn't" : "guests haven't"} answered
            yet. To hold seats for them while you plan, turn on tentative seating under{" "}
            <a href="#options" className={link}>
              Options
            </a>
            .
          </p>
        )}
        {plan.tables.length > 0 && toSeat.length > 0 && (
          <div className="space-y-2">
            <TrayButton
              label="Suggest seating"
              title="Suggested seating"
              description="A starting point for guests who have no seat yet."
              variant="secondary"
            >
              <SuggestionPanel
                workspaceId={wid}
                layoutId={layout.id}
                revision={layout.revision}
                suggestion={suggestion}
              />
            </TrayButton>
          </div>
        )}
        {plan.tables.length > 0 && plan.queueGroups.length > 0 && (
          <div className="space-y-3">
            <h3 className="text-label-lg font-semibold">Seat together</h3>
            <ul className="space-y-3">
              {plan.queueGroups.map((group) => (
                <li
                  key={group.key}
                  className="space-y-2 rounded-card border border-border-hairline p-3"
                >
                  <p className="font-semibold">{group.label}</p>
                  <p className="text-body-md text-ink-muted">
                    {group.guests.map((g) => g.name).join(", ")}
                  </p>
                  <SeatGroupForm
                    workspaceId={wid}
                    layoutId={layout.id}
                    groupLabel={group.label}
                    guests={group.guests}
                    tables={choices}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}
        <ul className="space-y-3">
          {toSeat.map((g) => {
            const view = views.get(g.id);
            return (
              <li key={g.id} className="space-y-2 rounded-card border border-border-hairline p-3">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  {guestLink(g.id, g.name)}
                  {view && <GuestFlags view={view} />}
                </div>
                {plan.tables.length > 0 && (
                  <SeatForm workspaceId={wid} layoutId={layout.id} guest={g} tables={choices} />
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {showList && tablesSection}

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
          <form
            method="get"
            action={`${base}/seating/${event.id}/export/pdf`}
            aria-labelledby="print-heading"
            className="space-y-3 border-t border-border pt-4"
          >
            <h3 id="print-heading" className="font-serif text-headline-sm">
              Print
            </h3>
            <p className="text-body-sm text-ink-muted">
              A table list for you, the venue or the caterer, or escort cards to cut out. Both show
              the plan as it is now and do not update. Cards are printed for confirmed guests only.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField label="Document" name="doc" defaultValue="table-list">
                <option value="table-list">Table list</option>
                <option value="cards">Escort cards (10 per sheet)</option>
              </SelectField>
              <SelectField label="Paper" name="paper" defaultValue="a4">
                <option value="a4">A4</option>
                <option value="letter">US Letter</option>
              </SelectField>
            </div>
            <label className="flex min-h-11 items-start gap-3 py-2 text-body-md">
              <input type="checkbox" name="meals" value="1" className="mt-1 size-5 shrink-0" />
              <span>Include meal choices</span>
            </label>
            <Button type="submit" variant="secondary">
              Download PDF
            </Button>
          </form>
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
