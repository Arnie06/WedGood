import { describe, expect, it } from "vitest";
import { parseBlockInput, parseHotelInput, parsePercentToBp, parsePickupInput } from "./input";
import { publicHotels } from "./publish";
import { stayLabel, stayView, summarizeStays, type StayRecord } from "./stays";

describe("parseHotelInput", () => {
  it("trims, collapses spaces and reads the two switches", () => {
    const r = parseHotelInput({
      name: "  Harbour   Inn ",
      websiteUrl: "https://example.test/inn",
      showToGuests: "on",
    });
    expect(r).toEqual({
      ok: true,
      value: {
        name: "Harbour Inn",
        address: null,
        phone: null,
        websiteUrl: "https://example.test/inn",
        guestNote: null,
        showToGuests: true,
        showRate: false,
        candidateId: null,
      },
    });
  });

  it("refuses a blank name, a non-https link and a bad vendor id", () => {
    const r = parseHotelInput({ name: " ", websiteUrl: "http://x.test", candidateId: "nope" });
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(Object.keys(r.fieldErrors).sort()).toEqual(["candidateId", "name", "websiteUrl"]);
  });
});

describe("parsePercentToBp", () => {
  it("reads whole and decimal percentages", () => {
    expect(parsePercentToBp("20")).toBe(2_000);
    expect(parsePercentToBp("12.5%")).toBe(1_250);
    expect(parsePercentToBp("0")).toBe(0);
    expect(parsePercentToBp("100")).toBe(10_000);
    expect(parsePercentToBp("")).toBeNull();
  });
  it("refuses anything else", () => {
    for (const v of ["101", "-5", "12.555", "abc"]) expect(parsePercentToBp(v)).toBeUndefined();
  });
});

describe("parseBlockInput", () => {
  const ok = {
    checkIn: "2027-06-11",
    checkOut: "2027-06-13",
    roomsPerNight: "20",
    nightlyRate: "189.50",
    attritionPercent: "20",
    attritionCharge: "",
    cutoffDate: "2027-05-10",
    bookingCode: "SMITHWED",
  };
  it("converts money and percent exactly", () => {
    const r = parseBlockInput(ok, "USD");
    expect(r.ok && r.value).toMatchObject({
      roomsPerNight: 20,
      nightlyRateMinor: 18_950,
      attritionAllowedBp: 2_000,
      attritionChargeMinor: null,
      bookingCode: "SMITHWED",
    });
  });
  it("leaves unknown terms null rather than zero", () => {
    const r = parseBlockInput({ ...ok, nightlyRate: "", attritionPercent: "" }, "USD");
    expect(r.ok && r.value).toMatchObject({ nightlyRateMinor: null, attritionAllowedBp: null });
  });
  it("refuses reversed dates, too many nights and bad rooms", () => {
    expect(parseBlockInput({ ...ok, checkOut: "2027-06-11" }, "USD")).toMatchObject({
      ok: false,
      fieldErrors: { checkOut: "Check-out must be after check-in." },
    });
    expect(parseBlockInput({ ...ok, checkOut: "2027-07-12" }, "USD").ok).toBe(false);
    expect(parseBlockInput({ ...ok, roomsPerNight: "0" }, "USD").ok).toBe(false);
    expect(parseBlockInput({ ...ok, roomsPerNight: "501" }, "USD").ok).toBe(false);
  });
});

describe("parsePickupInput", () => {
  it("clears with both blank and checks bounds and the day", () => {
    expect(parsePickupInput({ roomNights: "", asOf: "" }, 40, "2027-05-02")).toEqual({
      ok: true,
      value: null,
    });
    expect(parsePickupInput({ roomNights: "26", asOf: "2027-05-01" }, 40, "2027-05-02")).toEqual({
      ok: true,
      value: { roomNights: 26, asOf: "2027-05-01" },
    });
    expect(parsePickupInput({ roomNights: "41", asOf: "2027-05-01" }, 40, "2027-05-02").ok).toBe(
      false,
    );
    expect(parsePickupInput({ roomNights: "5", asOf: "2027-05-03" }, 40, "2027-05-02").ok).toBe(
      false,
    );
  });
});

describe("stays", () => {
  const hotelA = { kind: "hotel" as const, hotelId: "h-a" };
  const elsewhere = { kind: "elsewhere" as const, hotelId: null };
  it("prefers the planner's choice and shows the guest's when it differs", () => {
    const rec: StayRecord = {
      guestId: "g1",
      planner: hotelA,
      guest: elsewhere,
      guestAnsweredAt: "x",
    };
    expect(stayView(rec)).toEqual({
      effective: hotelA,
      source: "planner",
      guestDiffers: elsewhere,
    });
    expect(stayView({ ...rec, guest: hotelA }).guestDiffers).toBeNull();
    expect(stayView({ ...rec, planner: null })).toEqual({
      effective: elsewhere,
      source: "guest",
      guestDiffers: null,
    });
    expect(stayView(undefined).effective).toBeNull();
  });

  it("labels choices", () => {
    expect(stayLabel(hotelA, () => "Harbour Inn")).toBe("Harbour Inn");
    expect(stayLabel(elsewhere, () => "x")).toBe("Staying elsewhere");
    expect(stayLabel(null, () => "x")).toBe("Not known yet");
  });

  it("counts people and households per hotel, attending guests only", () => {
    const records = new Map<string, StayRecord>([
      ["g1", { guestId: "g1", planner: null, guest: hotelA, guestAnsweredAt: "x" }],
      ["g2", { guestId: "g2", planner: hotelA, guest: null, guestAnsweredAt: null }],
      ["g3", { guestId: "g3", planner: hotelA, guest: null, guestAnsweredAt: null }],
      ["g4", { guestId: "g4", planner: elsewhere, guest: null, guestAnsweredAt: null }],
    ]);
    const s = summarizeStays(
      [
        { id: "g1", household: "The Examples" },
        { id: "g2", household: "The Examples" },
        { id: "g3", household: null },
        { id: "g4", household: null },
        { id: "g5", household: null },
      ],
      records,
    );
    expect(s.byHotel.get("h-a")).toEqual({ people: 3, households: 2 });
    expect(s).toMatchObject({ elsewhere: 1, notStaying: 0, unknown: 1 });
  });
});

describe("publicHotels", () => {
  const hotel = {
    id: "h1",
    name: "Harbour Inn",
    address: "1 Quay St",
    phone: null,
    websiteUrl: null,
    guestNote: null,
    showToGuests: true,
    showRate: false,
    archived: false,
    createdAt: "2026-01-01T00:00:00Z",
  };
  const block = {
    id: "b1",
    hotelId: "h1",
    label: null,
    checkIn: "2027-06-11",
    checkOut: "2027-06-13",
    nightlyRateMinor: 18_900,
    cutoffDate: "2027-05-10",
    bookingUrl: null,
    bookingCode: "SMITHWED",
  };

  it("publishes guest-facing fields only, and the rate only when allowed", () => {
    expect(publicHotels([hotel], [block], "USD")).toEqual([
      {
        name: "Harbour Inn",
        address: "1 Quay St",
        blocks: [
          {
            checkIn: "2027-06-11",
            checkOut: "2027-06-13",
            bookBy: "2027-05-10",
            bookingCode: "SMITHWED",
          },
        ],
      },
    ]);
    const [withRate] = publicHotels([{ ...hotel, showRate: true }], [block], "USD");
    expect(withRate?.blocks[0]).toMatchObject({ nightlyRateMinor: 18_900, currency: "USD" });
  });

  it("leaves out hidden and archived hotels", () => {
    expect(publicHotels([{ ...hotel, showToGuests: false }], [block], "USD")).toEqual([]);
    expect(publicHotels([{ ...hotel, archived: true }], [block], "USD")).toEqual([]);
  });
});
