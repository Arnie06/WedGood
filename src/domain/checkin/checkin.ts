/**
 * Day-of check-in (UX-17 last slice). Pure rules shared by the page, the server actions and the
 * attendance export. Actual arrival is a separate fact from the reply: a "yes" who has not arrived
 * is still expected, and a guest who arrived without saying yes is counted apart, never folded
 * into the expected total. The database re-checks eligibility; these functions only explain the
 * current state honestly.
 */

export const REPLIES = ["accepted", "declined", "pending"] as const;
export type Reply = (typeof REPLIES)[number];

export function isReply(value: unknown): value is Reply {
  return typeof value === "string" && (REPLIES as readonly string[]).includes(value);
}

export const REPLY_LABELS: Record<Reply, string> = {
  accepted: "Said yes",
  declined: "Said no",
  pending: "Hasn't answered",
};

export const MAX_CHECKIN_BATCH = 20;

export type ArrivalGuest = {
  id: string;
  name: string;
  household: string | null;
  reply: Reply;
  /** ISO instant the guest was checked in, or null when they have not arrived. */
  arrivedAt: string | null;
};

export type ArrivalVendor = {
  id: string;
  name: string;
  arrivedAt: string | null;
};

export type GuestArrivalSummary = {
  /** Guests who said yes. The only people "expected". */
  expected: number;
  /** Expected guests who have arrived. */
  arrivedExpected: number;
  /** Arrived guests who did not say yes (declined or never answered). Counted apart. */
  arrivedOther: number;
  /** Everyone checked in, whatever they answered. */
  arrivedTotal: number;
  /** Guests who said yes and have not arrived, by name. */
  stillExpected: ArrivalGuest[];
};

export function summarizeGuestArrivals(guests: readonly ArrivalGuest[]): GuestArrivalSummary {
  const expected = guests.filter((g) => g.reply === "accepted");
  const arrivedExpected = expected.filter((g) => g.arrivedAt !== null).length;
  const arrivedTotal = guests.filter((g) => g.arrivedAt !== null).length;
  return {
    expected: expected.length,
    arrivedExpected,
    arrivedOther: arrivedTotal - arrivedExpected,
    arrivedTotal,
    stillExpected: expected
      .filter((g) => g.arrivedAt === null)
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** "12 of 40 expected guests have arrived. 2 more arrived without saying yes." */
export function guestArrivalSentence(s: GuestArrivalSummary): string {
  if (s.expected === 0) {
    return s.arrivedTotal === 0
      ? "No one has said yes to this event yet."
      : `${s.arrivedTotal} ${s.arrivedTotal === 1 ? "guest has" : "guests have"} arrived. No one had said yes.`;
  }
  const first = `${s.arrivedExpected} of ${s.expected} expected ${s.expected === 1 ? "guest has" : "guests have"} arrived.`;
  if (s.arrivedOther === 0) return first;
  return `${first} ${s.arrivedOther} more arrived without saying yes.`;
}

export function vendorArrivalSentence(vendors: readonly ArrivalVendor[]): string {
  if (vendors.length === 0) return "No vendors are linked to this event.";
  const here = vendors.filter((v) => v.arrivedAt !== null).length;
  return `${here} of ${vendors.length} ${vendors.length === 1 ? "vendor has" : "vendors have"} arrived.`;
}

/** Case- and accent-insensitive match on the guest's name or household. Empty matches everyone. */
export function matchesSearch(
  guest: { name: string; household: string | null },
  query: string,
): boolean {
  const fold = (s: string) =>
    s
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase();
  const q = fold(query).trim();
  if (q === "") return true;
  return fold(guest.name).includes(q) || fold(guest.household ?? "").includes(q);
}

/**
 * Attendance rows for the CSV: one per guest, arrived or not, so the file also lists who was
 * expected and did not come. Names and replies only: no contact, dietary or access details.
 */
export function attendanceRows(
  guests: readonly ArrivalGuest[],
  formatTime: (iso: string) => string,
): string[][] {
  const header = ["Guest", "Household", "Reply", "Arrived", "Checked in at"];
  const rows = [...guests]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((g) => [
      g.name,
      g.household ?? "",
      REPLY_LABELS[g.reply],
      g.arrivedAt ? "Yes" : "No",
      g.arrivedAt ? formatTime(g.arrivedAt) : "",
    ]);
  return [header, ...rows];
}
