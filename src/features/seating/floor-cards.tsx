import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { SeatCard, TableCard } from "@/domain/seating/cards";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function Rows({ children }: { children: React.ReactNode }) {
  return <dl className="space-y-1.5">{children}</dl>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[4.75rem_1fr] gap-2 text-body-sm">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** The summary shown in the small card beside a table: the same facts as the table tray, at a glance. */
export function TableCardBody({ card, onEdit }: { card: TableCard; onEdit: () => void }) {
  const includes = [
    card.plusOnes > 0 && plural(card.plusOnes, "plus-one", "plus-ones"),
    card.children > 0 && plural(card.children, "child", "children"),
  ].filter(Boolean);
  const privateNotes = [
    card.dietary > 0 && `${card.dietary} dietary`,
    card.accessibility > 0 && `${card.accessibility} access`,
  ].filter(Boolean);
  return (
    <>
      <Rows>
        <Row label="Seats">
          {card.used} of {card.capacity} taken
          {card.full ? " (full)" : card.capacity > 0 ? `, ${card.open} open` : ""}
        </Row>
        {card.used > 0 && (
          <Row label="Answers">
            {card.attending} attending
            {card.waiting > 0 && `, ${card.waiting} waiting to answer`}
          </Row>
        )}
        {card.captain && <Row label="Captain">{card.captain}</Row>}
        {includes.length > 0 && <Row label="Includes">{includes.join(", ")}</Row>}
        {card.meals.length > 0 && <Row label="Meals">{card.meals.join(" · ")}</Row>}
        {privateNotes.length > 0 && <Row label="Notes">{privateNotes.join(", ")}</Row>}
        {card.notes && <Row label="About">{card.notes}</Row>}
      </Rows>
      {card.used === 0 && <p className="text-body-sm text-ink-muted">No one is seated here yet.</p>}
      <div className="flex">
        <Button type="button" size="sm" onClick={onEdit}>
          Edit table<span className="sr-only"> {card.label}</span>
        </Button>
      </div>
    </>
  );
}

/** The card beside one seat: who is in it and what matters about them, or that it is free. */
export function SeatCardBody({
  card,
  waitingForSeat,
  onEdit,
}: {
  card: SeatCard;
  /** Guests who could be seated now but have no seat yet. */
  waitingForSeat: number;
  onEdit: () => void;
}) {
  const g = card.guest;
  return (
    <>
      {g ? (
        <>
          {(g.captain || g.held || g.plusOne || g.child) && (
            <div className="flex flex-wrap gap-1.5">
              {g.captain && <Badge tone="ceremony">Captain</Badge>}
              {g.held && <Badge tone="pending">Waiting for answer</Badge>}
              {g.plusOne && <Badge>Plus-one</Badge>}
              {g.child && <Badge>Child</Badge>}
            </div>
          )}
          <Rows>
            <Row label="Answer">{g.held ? "Hasn't answered yet; seat held" : "Attending"}</Row>
            <Row label="Meal">{g.meal ?? "No choice yet"}</Row>
            {g.plusOneOf.length > 0 && <Row label="With">{g.plusOneOf.join(", ")}</Row>}
            {g.household && <Row label="Household">{g.household}</Row>}
            {g.dietary && <Row label="Dietary">{g.dietary}</Row>}
            {g.accessibility && <Row label="Access">{g.accessibility}</Row>}
          </Rows>
          {!card.numbered && (
            <p className="text-body-sm text-ink-muted">
              No seat number saved yet, so they are drawn in the lowest free seat. Edit to number
              the seats.
            </p>
          )}
        </>
      ) : (
        <p className="text-body-sm text-ink-muted">
          No one is in this seat.{" "}
          {waitingForSeat > 0
            ? `${plural(waitingForSeat, "guest still needs", "guests still need")} a seat.`
            : "No one is waiting for a seat."}
        </p>
      )}
      <div className="flex">
        <Button type="button" size="sm" onClick={onEdit}>
          Edit seat
          <span className="sr-only">
            {" "}
            {card.seat} at {card.tableLabel}
          </span>
        </Button>
      </div>
    </>
  );
}
