/**
 * What the small cards on the floor plan say about a table and about one seat. Pure and serialisable:
 * derived from the same plan and guest views as the trays, so a card can never disagree with the tray
 * it leads to. Private dietary and access text appears only on the screen of someone signed in to the
 * workspace, exactly as it does in the guest tray; it is never in downloads.
 */
import type { TablePlan, TableShape } from "./plan";
import { canvasSeats, initials, type ChipState } from "./seats";
import type { GuestView } from "./views";

export type TableCard = {
  id: string;
  label: string;
  shape: TableShape;
  capacity: number;
  used: number;
  open: number;
  full: boolean;
  attending: number;
  waiting: number;
  plusOnes: number;
  children: number;
  /** Guests at the table with a dietary note / an access note (the text itself is in the tray). */
  dietary: number;
  accessibility: number;
  captain: string | null;
  /** "Chicken 3", confirmed plus tentative, only choices someone made. */
  meals: string[];
  notes: string | null;
};

export function tableCard(table: TablePlan): TableCard {
  const s = table.stats;
  return {
    id: table.id,
    label: table.label,
    shape: table.shape,
    capacity: table.capacity,
    used: table.used,
    open: table.open,
    full: table.open === 0 && table.capacity > 0,
    attending: s.accepted,
    waiting: s.waiting,
    plusOnes: s.plusOnes,
    children: s.children,
    dietary: s.dietary,
    accessibility: s.accessibility,
    captain: table.seats.find((x) => x.captain)?.guest.name ?? null,
    meals: table.meals
      .filter((m) => m.confirmed + m.tentative > 0)
      .map((m) => `${m.name} ${m.confirmed + m.tentative}`),
    notes: table.notes,
  };
}

export type SeatCardGuest = {
  id: string;
  name: string;
  initials: string;
  /** Waiting to answer, so the seat is held until they do. */
  held: boolean;
  captain: boolean;
  plusOne: boolean;
  /** For a plus-one: who they came with. */
  plusOneOf: string[];
  child: boolean;
  meal: string | null;
  household: string | null;
  dietary: string | null;
  accessibility: string | null;
};

export type SeatCard = {
  seat: number;
  tableId: string;
  tableLabel: string;
  state: ChipState;
  /** False for a guest with no saved seat number: shown in the lowest free seat until numbered. */
  numbered: boolean;
  guest: SeatCardGuest | null;
};

/** One card per seat, in seat order, matching the chips drawn round the table. */
export function seatCards(table: TablePlan, views: ReadonlyMap<string, GuestView>): SeatCard[] {
  return canvasSeats(table).map(({ seat, occupant, numbered }): SeatCard => {
    const base = { seat, tableId: table.id, tableLabel: table.label, numbered };
    if (!occupant) return { ...base, state: "empty", guest: null };
    const view = views.get(occupant.guest.id);
    const info = view?.info ?? occupant.info;
    return {
      ...base,
      state: occupant.tentative ? "waiting" : "seated",
      guest: {
        id: occupant.guest.id,
        name: occupant.guest.name,
        initials: initials(occupant.guest.name),
        held: occupant.tentative,
        captain: occupant.captain,
        plusOne: info?.isPlusOne ?? false,
        plusOneOf: info?.isPlusOne ? info.hostNames : [],
        child: info?.ageGroup === "child",
        meal: view?.meal ?? null,
        household: info?.householdName ?? null,
        dietary: info?.dietary ?? null,
        accessibility: info?.accessibility ?? null,
      },
    };
  });
}

/** The words a screen reader and the hover label use for one seat. */
export function seatLabel(card: Pick<SeatCard, "seat" | "tableLabel" | "guest">): string {
  if (!card.guest) return `${card.tableLabel}, seat ${card.seat}, empty`;
  return `${card.tableLabel}, seat ${card.seat}, ${card.guest.name}${
    card.guest.held ? ", waiting to answer" : ""
  }${card.guest.captain ? ", captain" : ""}`;
}
