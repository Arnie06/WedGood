import { describe, expect, it } from "vitest";
import {
  attendanceRows,
  guestArrivalSentence,
  isReply,
  matchesSearch,
  summarizeGuestArrivals,
  vendorArrivalSentence,
  type ArrivalGuest,
} from "./checkin";

const guest = (
  id: string,
  reply: ArrivalGuest["reply"],
  arrivedAt: string | null = null,
  name = id,
): ArrivalGuest => ({ id, name, household: null, reply, arrivedAt });
const T = "2027-06-12T20:00:00Z";

describe("summarizeGuestArrivals", () => {
  it("keeps arrival separate from the reply", () => {
    const s = summarizeGuestArrivals([
      guest("a", "accepted", T),
      guest("b", "accepted"),
      guest("c", "declined", T),
      guest("d", "pending", T),
      guest("e", "declined"),
    ]);
    expect(s).toMatchObject({ expected: 2, arrivedExpected: 1, arrivedOther: 2, arrivedTotal: 3 });
    expect(s.stillExpected.map((g) => g.id)).toEqual(["b"]);
  });

  it("never counts a declined guest as expected", () => {
    const s = summarizeGuestArrivals([guest("a", "declined"), guest("b", "pending")]);
    expect(s.expected).toBe(0);
    expect(s.stillExpected).toEqual([]);
  });

  it("lists who is still expected in name order", () => {
    const s = summarizeGuestArrivals([
      guest("1", "accepted", null, "Zoe"),
      guest("2", "accepted", null, "Amy"),
    ]);
    expect(s.stillExpected.map((g) => g.name)).toEqual(["Amy", "Zoe"]);
  });
});

describe("sentences", () => {
  it("reports expected arrivals and extras apart", () => {
    const s = summarizeGuestArrivals([guest("a", "accepted", T), guest("b", "pending", T)]);
    expect(guestArrivalSentence(s)).toBe(
      "1 of 1 expected guest has arrived. 1 more arrived without saying yes.",
    );
  });
  it("handles an event nobody has accepted", () => {
    expect(guestArrivalSentence(summarizeGuestArrivals([]))).toBe(
      "No one has said yes to this event yet.",
    );
    expect(guestArrivalSentence(summarizeGuestArrivals([guest("a", "pending", T)]))).toBe(
      "1 guest has arrived. No one had said yes.",
    );
  });
  it("counts vendors without inventing any", () => {
    expect(vendorArrivalSentence([])).toBe("No vendors are linked to this event.");
    expect(
      vendorArrivalSentence([
        { id: "1", name: "A", arrivedAt: T },
        { id: "2", name: "B", arrivedAt: null },
      ]),
    ).toBe("1 of 2 vendors have arrived.");
  });
});

describe("matchesSearch", () => {
  const g = { name: "José Álvarez", household: "The Álvarez family" };
  it("ignores case and accents and checks the household", () => {
    expect(matchesSearch(g, "jose")).toBe(true);
    expect(matchesSearch(g, "ALVAREZ FAM")).toBe(true);
    expect(matchesSearch(g, "smith")).toBe(false);
  });
  it("matches everyone on an empty search", () => {
    expect(matchesSearch(g, "   ")).toBe(true);
  });
});

describe("attendanceRows", () => {
  it("lists every guest, including expected guests who did not arrive", () => {
    const rows = attendanceRows(
      [guest("b", "accepted", null, "Bea"), guest("a", "pending", T, "Al")],
      (iso) => `at ${iso}`,
    );
    expect(rows[0]).toEqual(["Guest", "Household", "Reply", "Arrived", "Checked in at"]);
    expect(rows[1]).toEqual(["Al", "", "Hasn't answered", "Yes", `at ${T}`]);
    expect(rows[2]).toEqual(["Bea", "", "Said yes", "No", ""]);
  });
});

describe("isReply", () => {
  it("accepts only known replies", () => {
    expect(isReply("accepted")).toBe(true);
    expect(isReply("maybe")).toBe(false);
  });
});
