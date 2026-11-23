import { describe, expect, it } from "vitest";
import {
  buildGuestReplies,
  describeSeat,
  isReplyFilter,
  matchesReply,
  replyTotals,
  type ReplyInput,
  type ReplyMember,
} from "./replies";

const now = new Date("2027-05-01T12:00:00Z");
const member = (guestId: string, over: Partial<ReplyMember> = {}): ReplyMember => ({
  guestId,
  invitationId: "inv-open",
  isPlusOne: false,
  active: true,
  status: "pending",
  mealOptionId: null,
  ...over,
});

function input(over: Partial<ReplyInput> = {}): ReplyInput {
  return {
    now,
    members: [],
    invitations: [
      { id: "inv-open", deadline: "2027-05-10T23:59:59Z", expiresAt: "2027-06-01T00:00:00Z" },
      { id: "inv-late", deadline: "2027-04-30T23:59:59Z", expiresAt: "2027-06-01T00:00:00Z" },
      { id: "inv-expired", deadline: null, expiresAt: "2027-04-01T00:00:00Z" },
    ],
    mealOptions: [
      { id: "fish", name: "Fish", active: true },
      { id: "old", name: "Old menu", active: false },
    ],
    seats: [],
    ...over,
  };
}

describe("buildGuestReplies", () => {
  it("maps answers, meals and seats; guests with no active response are not invited", () => {
    const r = buildGuestReplies(
      input({
        members: [
          member("ada", { status: "accepted", mealOptionId: "fish" }),
          member("bo", { status: "declined", mealOptionId: "fish" }),
          member("cy"),
          member("old", { active: false, status: "accepted" }),
        ],
        seats: [
          { guestId: "ada", tableLabel: "Table 6", seatNumber: 4, tentative: false },
          { guestId: "bo", tableLabel: "Table 6", seatNumber: 5, tentative: false },
        ],
      }),
    );
    expect(r.byGuest.get("ada")).toMatchObject({ answer: "yes", meal: "Fish" });
    expect(r.byGuest.get("ada")?.seat).toEqual({
      tableLabel: "Table 6",
      seatNumber: 4,
      tentative: false,
    });
    // A decline never shows a meal or a seat.
    expect(r.byGuest.get("bo")).toMatchObject({ answer: "no", meal: null, seat: null });
    expect(r.byGuest.get("cy")).toMatchObject({ answer: "waiting", replyClosed: false });
    expect(r.byGuest.has("old")).toBe(false);
    expect(matchesReply(r.byGuest.get("old"), "not_invited")).toBe(true);
  });

  it("marks waiting guests whose reply date or link has passed, using the same rule as the SQL", () => {
    const r = buildGuestReplies(
      input({
        members: [
          member("open"),
          member("late", { invitationId: "inv-late" }),
          member("expired", { invitationId: "inv-expired" }),
          member("orphan", { invitationId: "missing" }),
        ],
      }),
    );
    expect(r.byGuest.get("open")?.replyClosed).toBe(false);
    expect(r.byGuest.get("late")?.replyClosed).toBe(true);
    expect(r.byGuest.get("expired")?.replyClosed).toBe(true);
    expect(r.byGuest.get("orphan")?.replyClosed).toBe(true);
  });

  it("a reply date exactly now is still open (deadline >= now)", () => {
    const r = buildGuestReplies(
      input({
        invitations: [
          { id: "inv-open", deadline: now.toISOString(), expiresAt: "2027-06-01T00:00:00Z" },
        ],
        members: [member("a")],
      }),
    );
    expect(r.byGuest.get("a")?.replyClosed).toBe(false);
  });

  it("keeps the name of an inactive meal someone already chose", () => {
    const r = buildGuestReplies(
      input({ members: [member("a", { status: "accepted", mealOptionId: "old" })] }),
    );
    expect(r.byGuest.get("a")?.meal).toBe("Old menu");
  });

  it("asks for a meal only when the event offers one or someone chose one", () => {
    expect(buildGuestReplies(input({ mealOptions: [] })).asksMeal).toBe(false);
    expect(
      buildGuestReplies(input({ mealOptions: [{ id: "x", name: "X", active: false }] })).asksMeal,
    ).toBe(false);
    expect(buildGuestReplies(input()).asksMeal).toBe(true);
  });

  it("refuses two active responses for one guest", () => {
    expect(() => buildGuestReplies(input({ members: [member("a"), member("a")] }))).toThrow(
      /more than one/,
    );
  });
});

describe("filters and totals", () => {
  const replies = buildGuestReplies(
    input({
      members: [
        member("seated", { status: "accepted", mealOptionId: "fish" }),
        member("tentative", { status: "accepted", mealOptionId: "fish" }),
        member("nomeal", { status: "accepted" }),
        member("wait"),
        member("waitseat"),
        member("no", { status: "declined" }),
      ],
      seats: [
        { guestId: "seated", tableLabel: "T1", seatNumber: null, tentative: false },
        { guestId: "tentative", tableLabel: "T1", seatNumber: 2, tentative: true },
        { guestId: "waitseat", tableLabel: "T2", seatNumber: 1, tentative: true },
      ],
    }),
  );
  const ids = ["seated", "tentative", "nomeal", "wait", "waitseat", "no", "stranger"];

  it("counts each filter the way event_demand does", () => {
    expect(replyTotals(ids, replies)).toEqual({
      yes: 3,
      waiting: 2,
      no: 1,
      not_invited: 1,
      no_meal: 1,
      // A tentative seat is not a confirmed seat.
      not_seated: 2,
    });
  });

  it("filters guests and treats an empty filter as everyone", () => {
    expect(ids.filter((id) => matchesReply(replies.byGuest.get(id), "not_seated"))).toEqual([
      "tentative",
      "nomeal",
    ]);
    expect(ids.filter((id) => matchesReply(replies.byGuest.get(id), ""))).toHaveLength(7);
  });

  it("validates filter values from the URL", () => {
    expect(isReplyFilter("no_meal")).toBe(true);
    expect(isReplyFilter("accepted")).toBe(false);
    expect(isReplyFilter(undefined)).toBe(false);
  });

  it("describes seats in plain words", () => {
    expect(describeSeat({ tableLabel: "Table 6", seatNumber: 4, tentative: false })).toBe(
      "Table 6 · seat 4",
    );
    expect(describeSeat({ tableLabel: "Table 6", seatNumber: null, tentative: true })).toBe(
      "Table 6 · tentative",
    );
  });
});
