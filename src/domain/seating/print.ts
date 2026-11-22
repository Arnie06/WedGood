import {
  buildSeatingPlan,
  type PlanAssignment,
  type PlanGuest,
  type PlanMeal,
  type PlanMember,
  type PlanTable,
} from "./plan";

/**
 * What the printable seating documents (table list, escort cards) may contain: names, tables, seat
 * numbers and meal choices. Nothing else crosses this boundary: no dietary or access notes, no
 * contact details, no private table notes, no floor-plan positions (the plan is schematic and not
 * to scale, so it is not printed as if it were a venue drawing). Pure and deterministic.
 */

export type PrintGuestLine = {
  name: string;
  /** Null when the guest has no seat number; the table is still known. */
  seat: number | null;
  /** True while the guest hasn't answered (only when the layout allows tentative seating). */
  tentative: boolean;
  /** Null when meals are not requested or the guest has not chosen one. */
  meal: string | null;
};

export type PrintTable = {
  label: string;
  capacity: number;
  guests: PrintGuestLine[];
};

export type EscortCard = {
  name: string;
  table: string;
  seat: number | null;
  meal: string | null;
};

export type PrintModel = {
  tables: PrintTable[];
  /** One card per confirmed seated guest, alphabetical by surname. Tentative guests get none. */
  cards: EscortCard[];
  /** Accepted guests with no seat yet (never on a card). */
  unseated: string[];
  /** Guests seated tentatively; they appear in the table list, marked, but not on cards. */
  tentativeCount: number;
  includeMeals: boolean;
};

const SUFFIX = /^(jr|sr|ii|iii|iv|v)\.?,?$/iu;

/**
 * Sort key: the last word, ignoring a trailing "(child)" style note and a generational suffix
 * (Jr, Sr, II, III, IV). It is a sorting convenience, not a claim about anyone's surname.
 */
export function surnameKey(name: string): string {
  const words = name
    .replace(/\([^)]*\)\s*$/u, "")
    .trim()
    .split(/\s+/u)
    .filter((w) => w !== "");
  while (words.length > 1 && SUFFIX.test(words[words.length - 1] ?? "")) words.pop();
  return (words[words.length - 1] ?? name).toLocaleLowerCase("en").replace(/,$/u, "");
}

const cardOrder = (a: EscortCard, b: EscortCard) =>
  surnameKey(a.name).localeCompare(surnameKey(b.name), "en") ||
  a.name.localeCompare(b.name, "en") ||
  a.table.localeCompare(b.table, "en", { numeric: true });

export function buildPrintModel(input: {
  guests: readonly PlanGuest[];
  members: readonly PlanMember[];
  tables: readonly PlanTable[];
  assignments: readonly PlanAssignment[];
  meals: readonly PlanMeal[];
  allowTentative: boolean;
  includeMeals: boolean;
}): PrintModel {
  // Details are deliberately not passed to the plan, so no private note can reach this model.
  const plan = buildSeatingPlan({
    guests: input.guests,
    members: input.members,
    tables: input.tables.map((t) => ({
      id: t.id,
      label: t.label,
      capacity: t.capacity,
      ...(t.shape ? { shape: t.shape } : {}),
    })),
    assignments: input.assignments,
    meals: input.meals,
    allowTentative: input.allowTentative,
  });
  const mealIdOf = new Map(input.members.map((m) => [m.guestId, m.mealOptionId]));
  const mealName = new Map(input.meals.map((m) => [m.id, m.name]));
  const meal = (guestId: string): string | null => {
    if (!input.includeMeals) return null;
    return mealName.get(mealIdOf.get(guestId) ?? "") ?? null;
  };

  const tables: PrintTable[] = plan.tables.map((t) => ({
    label: t.label,
    capacity: t.capacity,
    guests: t.seats.map((s) => ({
      name: s.guest.name,
      seat: s.seatNumber,
      tentative: s.tentative,
      meal: meal(s.guest.id),
    })),
  }));

  const cards: EscortCard[] = plan.tables
    .flatMap((t) =>
      t.seats
        .filter((s) => !s.tentative)
        .map((s) => ({
          name: s.guest.name,
          table: t.label,
          seat: s.seatNumber,
          meal: meal(s.guest.id),
        })),
    )
    .sort(cardOrder);

  return {
    tables,
    cards,
    unseated: plan.queue.map((g) => g.name),
    tentativeCount: plan.totals.tentativeSeated,
    includeMeals: input.includeMeals,
  };
}
