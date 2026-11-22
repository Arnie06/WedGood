import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import type { FloorElement } from "@/domain/seating/floor";
import type { TablePlan } from "@/domain/seating/plan";
import { tableSeats } from "@/domain/seating/seats";
import { toPlacements, type SeatingSuggestion } from "@/domain/seating/suggest";
import type { GuestView } from "@/domain/seating/views";
import {
  ApplySuggestionForm,
  CaptainForm,
  EditElementForm,
  EditTableForm,
  PlaceTableForm,
  SeatAtTableForm,
  SeatForm,
  SeatGroupForm,
  UnseatForm,
  type TableChoice,
} from "./seating-forms";
import { SeatChips } from "./seat-chips";

/** Short text tags for a seated or queued guest. Meaning is in the words, never colour alone. */
export function GuestFlags({ view }: { view: GuestView }) {
  const info = view.info;
  return (
    <>
      {view.table?.captain && <Badge tone="ceremony">Captain</Badge>}
      {view.table?.tentative && <Badge tone="pending">Waiting for answer</Badge>}
      {!view.table && view.status === "pending" && <Badge tone="pending">Waiting for answer</Badge>}
      {info?.isPlusOne && <Badge>Plus-one</Badge>}
      {info?.ageGroup === "child" && <Badge>Child</Badge>}
      {info?.dietary && <Badge>Dietary</Badge>}
      {info?.accessibility && <Badge>Access</Badge>}
    </>
  );
}

const STATUS_TEXT = {
  accepted: "Attending",
  pending: "Hasn't answered yet",
  declined: "Declined",
} as const;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-3 text-body-md">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** What the "tap a guest" tray shows and lets you do. */
export function GuestPanel({
  workspaceId,
  layoutId,
  base,
  view,
  tables,
  allowTentative,
}: {
  workspaceId: string;
  layoutId: string;
  base: string;
  view: GuestView;
  tables: TableChoice[];
  allowTentative: boolean;
}) {
  const info = view.info;
  const seatable = (status: string) =>
    status === "accepted" || (status === "pending" && allowTentative);
  const group = [
    { id: view.id, name: view.name },
    ...view.companions.filter((c) => seatable(c.status)).map((c) => ({ id: c.id, name: c.name })),
  ];
  const canSeat = seatable(view.status);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        <Badge tone={view.status === "accepted" ? "confirmed" : "pending"}>
          {STATUS_TEXT[view.status]}
        </Badge>
        <GuestFlags view={view} />
      </div>

      <dl className="space-y-2">
        <Row label="Seat">
          {view.table ? (
            <>
              {view.table.label}
              {view.table.seatNumber !== null && `, seat ${view.table.seatNumber}`}
              {view.table.tentative && " (held until they answer)"}
            </>
          ) : (
            "Not seated yet"
          )}
        </Row>
        <Row label="Meal">{view.meal ?? "No choice yet"}</Row>
        {info?.isPlusOne && info.hostNames.length > 0 && (
          <Row label="Plus-one of">{info.hostNames.join(", ")}</Row>
        )}
        {info?.householdName && <Row label="Household">{info.householdName}</Row>}
        {info && info.tags.length > 0 && <Row label="Tags">{info.tags.join(", ")}</Row>}
      </dl>

      <section aria-label="Private notes" className="space-y-2">
        <h3 className="text-label-lg font-semibold">Private notes</h3>
        {info?.dietary || info?.accessibility ? (
          <dl className="space-y-2">
            {info.dietary && <Row label="Dietary">{info.dietary}</Row>}
            {info.accessibility && <Row label="Access">{info.accessibility}</Row>}
          </dl>
        ) : (
          <p className="text-body-md text-ink-muted">No dietary or access notes.</p>
        )}
        <p className="text-body-sm text-ink-muted">
          Only you and your partner see these. They aren&apos;t included in downloads.
        </p>
      </section>

      {view.companions.length > 0 && (
        <section aria-label="Same invitation" className="space-y-2">
          <h3 className="text-label-lg font-semibold">On the same invitation</h3>
          <ul className="space-y-1 text-body-md">
            {view.companions.map((c) => (
              <li key={c.id}>
                {c.name}
                {c.isPlusOne && " (plus-one)"}
                <span className="text-ink-muted">
                  {" "}
                  · {STATUS_TEXT[c.status].toLowerCase()} · {c.tableLabel ?? "not seated"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {canSeat && tables.length > 0 && (
        <section aria-label="Seating" className="space-y-3">
          <h3 className="text-label-lg font-semibold">
            {view.table ? "Move or remove" : "Seat this guest"}
          </h3>
          <SeatForm
            workspaceId={workspaceId}
            layoutId={layoutId}
            guest={{ id: view.id, name: view.name }}
            tables={tables}
            {...(view.table ? { currentTableId: view.table.id } : {})}
          />
          {group.length > 1 && (
            <SeatGroupForm
              workspaceId={workspaceId}
              layoutId={layoutId}
              groupLabel={info?.invitationLabel ?? view.name}
              guests={group}
              tables={tables}
            />
          )}
          {view.table && (
            <UnseatForm
              workspaceId={workspaceId}
              layoutId={layoutId}
              guest={{ id: view.id, name: view.name }}
            />
          )}
        </section>
      )}

      <Link
        href={`${base}/guests/${view.id}`}
        className="inline-flex min-h-11 items-center font-semibold text-action-emphasis underline underline-offset-4"
      >
        Open {view.name}&apos;s guest page
      </Link>
    </div>
  );
}

/** What the "tap a table" tray shows and lets you do. */
export function TablePanel({
  workspaceId,
  layoutId,
  table,
  version,
  views,
  candidates,
  position,
}: {
  workspaceId: string;
  layoutId: string;
  table: TablePlan;
  version: number;
  views: Map<string, GuestView>;
  candidates: { id: string; name: string }[];
  /** Where the table sits on the floor plan (centre, grid units). */
  position: { x: number; y: number };
}) {
  const s = table.stats;
  const notes = table.seats.flatMap((seat) => {
    const v = views.get(seat.guest.id);
    return v?.info?.dietary || v?.info?.accessibility ? [{ seat, info: v.info }] : [];
  });
  const meals = table.meals.filter((m) => m.confirmed + m.tentative > 0);
  const seating = tableSeats(table);
  return (
    <div className="space-y-5">
      <dl className="space-y-2">
        <Row label="Seats">
          {table.used} of {table.capacity} taken
          {table.open === 0 ? " (full)" : `, ${table.open} open`}
        </Row>
        <Row label="Answers">
          {s.accepted} attending
          {s.waiting > 0 && `, ${s.waiting} waiting to answer`}
        </Row>
        {(s.plusOnes > 0 || s.children > 0) && (
          <Row label="Includes">
            {[
              s.plusOnes > 0 && `${s.plusOnes} ${s.plusOnes === 1 ? "plus-one" : "plus-ones"}`,
              s.children > 0 && `${s.children} ${s.children === 1 ? "child" : "children"}`,
            ]
              .filter(Boolean)
              .join(", ")}
          </Row>
        )}
        {meals.length > 0 && (
          <Row label="Meals">
            {meals.map((m) => `${m.name} ${m.confirmed + m.tentative}`).join(" · ")}
          </Row>
        )}
        {table.notes && <Row label="Notes">{table.notes}</Row>}
      </dl>

      <section aria-label="Guests at this table" className="space-y-2">
        <h3 className="text-label-lg font-semibold">Guests ({table.used})</h3>
        {table.seats.length === 0 ? (
          <p className="text-body-md text-ink-muted">No one is seated here yet.</p>
        ) : (
          <ul className="space-y-2">
            {table.seats.map((seat) => {
              const v = views.get(seat.guest.id);
              return (
                <li key={seat.guest.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-semibold">
                    {seat.seatNumber !== null && (
                      <span className="font-normal text-ink-muted">{seat.seatNumber}. </span>
                    )}
                    {seat.guest.name}
                  </span>
                  {v && <GuestFlags view={v} />}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <SeatChips
        workspaceId={workspaceId}
        layoutId={layoutId}
        tableId={table.id}
        tableLabel={table.label}
        slots={seating.slots.map((slot) => ({
          seat: slot.seat,
          guest: slot.occupant
            ? {
                id: slot.occupant.guest.id,
                name: slot.occupant.guest.name,
                tentative: slot.occupant.tentative,
                captain: slot.occupant.captain,
              }
            : null,
        }))}
        unnumbered={seating.unnumbered.map((s) => ({ id: s.guest.id, name: s.guest.name }))}
        candidates={table.open === 0 ? [] : candidates}
      />

      {notes.length > 0 && (
        <section aria-label="Dietary and access at this table" className="space-y-2">
          <h3 className="text-label-lg font-semibold">Dietary and access at this table</h3>
          <ul className="space-y-1 text-body-md">
            {notes.map(({ seat, info }) => (
              <li key={seat.guest.id}>
                <span className="font-semibold">{seat.guest.name}:</span>{" "}
                {[info.dietary, info.accessibility].filter(Boolean).join("; ")}
              </li>
            ))}
          </ul>
          <p className="text-body-sm text-ink-muted">
            Only you and your partner see these. They aren&apos;t included in downloads.
          </p>
        </section>
      )}

      <CaptainForm
        workspaceId={workspaceId}
        tableId={table.id}
        tableLabel={table.label}
        captainId={table.captainId}
        seated={table.seats.map((seat) => ({ id: seat.guest.id, name: seat.guest.name }))}
      />

      <SeatAtTableForm
        workspaceId={workspaceId}
        layoutId={layoutId}
        tableId={table.id}
        tableLabel={table.label}
        candidates={table.open === 0 ? [] : candidates}
      />

      <section
        aria-label="Position on the floor plan"
        className="space-y-3 border-t border-border-hairline pt-4"
      >
        <h3 className="text-label-lg font-semibold">Position on the floor plan</h3>
        <PlaceTableForm
          workspaceId={workspaceId}
          tableId={table.id}
          tableLabel={table.label}
          x={position.x}
          y={position.y}
        />
      </section>

      <section aria-label="Edit table" className="space-y-3 border-t border-border-hairline pt-4">
        <h3 className="text-label-lg font-semibold">Edit or remove this table</h3>
        <EditTableForm
          workspaceId={workspaceId}
          table={{
            id: table.id,
            label: table.label,
            capacity: table.capacity,
            shape: table.shape,
            notes: table.notes,
            version,
          }}
        />
      </section>
    </div>
  );
}

/** What the "tap a room item" tray shows: rename, resize, place or remove it. */
export function ElementPanel({
  workspaceId,
  element,
}: {
  workspaceId: string;
  element: FloorElement & { version: number };
}) {
  return <EditElementForm workspaceId={workspaceId} element={element} />;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Review step for suggested seating. Shows exactly what would happen and what could not be placed;
 * nothing is saved until the button is pressed, and the database refuses it if the plan changed.
 */
export function SuggestionPanel({
  workspaceId,
  layoutId,
  revision,
  suggestion,
}: {
  workspaceId: string;
  layoutId: string;
  revision: number;
  suggestion: SeatingSuggestion;
}) {
  const { tables, unplaced } = suggestion;
  return (
    <div className="space-y-5">
      <p className="text-body-md text-ink-muted">
        Nothing is saved until you choose to seat them. Households and plus-ones stay together, no
        one who is already seated is moved, and no table goes over its seats. It doesn&apos;t know
        who gets along, so look it over and adjust anything afterwards.
      </p>

      {suggestion.placedCount > 0 ? (
        <p role="status" className="text-body-md font-semibold">
          {plural(suggestion.placedCount, "guest", "guests")} across{" "}
          {plural(tables.length, "table", "tables")}
          {suggestion.tentativeCount > 0 &&
            `, ${suggestion.tentativeCount} of them held until they answer`}
          .
        </p>
      ) : (
        <p role="status" className="text-body-md font-semibold">
          No one can be seated this way right now.
        </p>
      )}

      {tables.length > 0 && (
        <ul className="space-y-3" aria-label="Proposed seating">
          {tables.map((t) => (
            <li
              key={t.tableId}
              className="space-y-2 rounded-card border border-border-hairline p-3"
            >
              <p className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-semibold">{t.tableLabel}</span>
                <span className="text-body-sm text-ink-muted">
                  {t.usedBefore} now, {t.usedAfter} of {t.capacity} after
                </span>
              </p>
              <ul className="space-y-1 text-body-md">
                {t.groups.map((g) => (
                  <li key={g.key}>
                    {g.guests.map((x) => x.name).join(", ")}
                    {g.guests.some((x) => x.tentative) && (
                      <span className="text-ink-muted"> (waiting for an answer: held)</span>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {unplaced.length > 0 && (
        <section aria-label="Not placed" className="space-y-2">
          <h3 className="text-label-lg font-semibold">
            Not placed ({plural(suggestion.unplacedCount, "guest", "guests")})
          </h3>
          <ul className="space-y-2">
            {unplaced.map((g) => (
              <li key={g.key} className="space-y-1 rounded-card border border-border-hairline p-3">
                <p className="text-body-md">{g.guests.map((x) => x.name).join(", ")}</p>
                <p className="text-body-sm text-ink-muted">
                  {g.reason === "no-room"
                    ? "Every table is full."
                    : `Needs ${g.needed} seats together, but no table has more than ${g.largestOpen} open.`}{" "}
                  Add or enlarge a table, or seat them yourself.
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {suggestion.placedCount > 0 && (
        <ApplySuggestionForm
          workspaceId={workspaceId}
          layoutId={layoutId}
          revision={revision}
          placements={toPlacements(suggestion)}
          count={suggestion.placedCount}
        />
      )}
    </div>
  );
}
