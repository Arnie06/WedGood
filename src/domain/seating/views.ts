import type { GuestInfo, PlanGuest, PlanMeal, PlanMember, SeatingPlan } from "./plan";

/**
 * Everything the "tap a guest" panel shows, derived from the same plan and rows as the totals so
 * the panel can never disagree with the table card. Pure; no database or framework imports.
 */
export type GuestCompanion = {
  id: string;
  name: string;
  status: "pending" | "accepted" | "declined";
  isPlusOne: boolean;
  /** Where they sit, or null when they have no seat. */
  tableLabel: string | null;
};

export type GuestView = {
  id: string;
  name: string;
  status: "pending" | "accepted" | "declined";
  meal: string | null;
  info: GuestInfo | null;
  table: {
    id: string;
    label: string;
    tentative: boolean;
    captain: boolean;
    seatNumber: number | null;
  } | null;
  /** The rest of their invitation: a household, or the guest they came with. */
  companions: GuestCompanion[];
};

export function buildGuestViews(input: {
  plan: SeatingPlan;
  guests: readonly PlanGuest[];
  members: readonly PlanMember[];
  info: readonly GuestInfo[];
  meals: readonly PlanMeal[];
}): Map<string, GuestView> {
  const nameOf = new Map(input.guests.map((g) => [g.id, g.name]));
  const memberOf = new Map(input.members.map((m) => [m.guestId, m]));
  const infoOf = new Map(input.info.map((i) => [i.guestId, i]));
  const mealName = new Map(input.meals.map((m) => [m.id, m.name]));

  const seatOf = new Map<string, NonNullable<GuestView["table"]> & { tableLabel: string }>();
  for (const t of input.plan.tables) {
    for (const s of t.seats) {
      seatOf.set(s.guest.id, {
        id: t.id,
        label: t.label,
        tableLabel: t.label,
        tentative: s.tentative,
        captain: s.captain,
        seatNumber: s.seatNumber,
      });
    }
  }

  const byInvitation = new Map<string, string[]>();
  for (const i of input.info) {
    if (!i.invitationId) continue;
    byInvitation.set(i.invitationId, [...(byInvitation.get(i.invitationId) ?? []), i.guestId]);
  }

  const views = new Map<string, GuestView>();
  for (const m of input.members) {
    const name = nameOf.get(m.guestId);
    if (name === undefined) continue;
    const info = infoOf.get(m.guestId) ?? null;
    const seat = seatOf.get(m.guestId);
    const companions: GuestCompanion[] = (
      info?.invitationId ? (byInvitation.get(info.invitationId) ?? []) : []
    )
      .filter((id) => id !== m.guestId)
      .map((id) => ({
        id,
        name: nameOf.get(id) ?? "Guest",
        status: memberOf.get(id)?.status ?? "pending",
        isPlusOne: infoOf.get(id)?.isPlusOne ?? false,
        tableLabel: seatOf.get(id)?.tableLabel ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id));
    views.set(m.guestId, {
      id: m.guestId,
      name,
      status: m.status,
      meal: m.mealOptionId ? (mealName.get(m.mealOptionId) ?? null) : null,
      info,
      table: seat
        ? {
            id: seat.id,
            label: seat.label,
            tentative: seat.tentative,
            captain: seat.captain,
            seatNumber: seat.seatNumber,
          }
        : null,
      companions,
    });
  }
  return views;
}
