/**
 * Who is staying where (UX-17 lodging). The planner's choice and the guest's own answer are kept
 * apart; the planner's wins when both exist, and the page shows both when they differ. Counts are a
 * hint for the couple, never the hotel's pickup: a guest saying "this hotel" is not a booking.
 */
export const STAY_KINDS = ["hotel", "elsewhere", "not_staying"] as const;
export type StayKind = (typeof STAY_KINDS)[number];

export function isStayKind(value: unknown): value is StayKind {
  return typeof value === "string" && (STAY_KINDS as readonly string[]).includes(value);
}

export type StayChoice = { kind: StayKind; hotelId: string | null };

export type StayRecord = {
  guestId: string;
  planner: StayChoice | null;
  guest: StayChoice | null;
  guestAnsweredAt: string | null;
};

export type StayView = {
  effective: StayChoice | null;
  source: "planner" | "guest" | null;
  /** The guest's answer, when the planner chose something different. */
  guestDiffers: StayChoice | null;
};

const same = (a: StayChoice | null, b: StayChoice | null) =>
  a?.kind === b?.kind && (a?.hotelId ?? null) === (b?.hotelId ?? null);

export function stayView(record: StayRecord | undefined): StayView {
  if (!record) return { effective: null, source: null, guestDiffers: null };
  if (record.planner) {
    return {
      effective: record.planner,
      source: "planner",
      guestDiffers: record.guest && !same(record.planner, record.guest) ? record.guest : null,
    };
  }
  return { effective: record.guest, source: record.guest ? "guest" : null, guestDiffers: null };
}

export function stayLabel(choice: StayChoice | null, hotelName: (id: string) => string): string {
  if (!choice) return "Not known yet";
  if (choice.kind === "hotel" && choice.hotelId) return hotelName(choice.hotelId);
  return choice.kind === "elsewhere" ? "Staying elsewhere" : "Not staying overnight";
}

export type StayGuest = { id: string; household: string | null };

export type StaySummary = {
  byHotel: Map<string, { people: number; households: number }>;
  elsewhere: number;
  notStaying: number;
  unknown: number;
};

/**
 * Counts for the attending guests passed in. A guest without a household counts as their own
 * household, so "households" approximates rooms without claiming to.
 */
export function summarizeStays(
  guests: readonly StayGuest[],
  records: ReadonlyMap<string, StayRecord>,
): StaySummary {
  const byHotel = new Map<string, { people: number; households: Set<string> }>();
  let elsewhere = 0;
  let notStaying = 0;
  let unknown = 0;
  for (const g of guests) {
    const { effective } = stayView(records.get(g.id));
    if (!effective) unknown += 1;
    else if (effective.kind === "elsewhere") elsewhere += 1;
    else if (effective.kind === "not_staying") notStaying += 1;
    else if (effective.hotelId) {
      const row = byHotel.get(effective.hotelId) ?? { people: 0, households: new Set<string>() };
      row.people += 1;
      row.households.add(g.household ?? `guest:${g.id}`);
      byHotel.set(effective.hotelId, row);
    }
  }
  return {
    byHotel: new Map(
      [...byHotel].map(([id, r]) => [id, { people: r.people, households: r.households.size }]),
    ),
    elsewhere,
    notStaying,
    unknown,
  };
}
