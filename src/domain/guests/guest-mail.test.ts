import { describe, expect, it } from "vitest";
import {
  cleanSubject,
  confirmationText,
  draftMatchesPlan,
  planConfirmations,
  planReminders,
  replyStateText,
  reminderText,
  type MailContext,
  type MailGuest,
  type MailInvitation,
  type MailMember,
  type PlannedMessage,
} from "./guest-mail";

const now = new Date("2027-03-01T12:00:00Z");
const ctx: MailContext = {
  weddingName: "Alex & Morgan",
  eventName: "Reception",
  eventDate: "Saturday, June 12, 2027",
  replyBy: (iso) => `[${iso.slice(0, 10)}]`,
  mealName: (id) => ({ m1: "Fish", m2: "Risotto" })[id] ?? null,
};
const inv = (over: Partial<MailInvitation> = {}): MailInvitation => ({
  id: "i1",
  eventId: "e1",
  revokedAt: null,
  expiresAt: "2027-12-01T00:00:00Z",
  deadline: "2027-05-01T06:59:59Z",
  ...over,
});
const member = (over: Partial<MailMember>): MailMember => ({
  invitationId: "i1",
  guestId: "g1",
  active: true,
  isPlusOne: false,
  status: "pending",
  mealOptionId: null,
  ...over,
});
const guests: MailGuest[] = [
  { id: "g1", fullName: "Sam Example", email: "sam@example.test", archived: false },
  { id: "g2", fullName: "Jo Example", email: "jo@example.test", archived: false },
  { id: "g3", fullName: "Kit Example", email: null, archived: false },
];
const hash = (t: string) => `h(${t})`.padEnd(64, "0").slice(0, 64);
const base = { ctx, guests, hash, now };

describe("cleanSubject", () => {
  it("cannot carry a header break", () => {
    expect(cleanSubject("Hi\r\nBcc: x@example.test")).toBe("Hi Bcc: x@example.test");
  });
  it("caps the length", () => {
    expect(cleanSubject("a".repeat(500))).toHaveLength(200);
  });
});

describe("replyStateText", () => {
  it("orders by guest id and ignores inactive people and other invitations", () => {
    const text = replyStateText(
      [
        member({ guestId: "g2", status: "accepted", mealOptionId: "m1" }),
        member({ guestId: "g1", status: "declined" }),
        member({ guestId: "g0", active: false }),
        member({ guestId: "g9", invitationId: "other" }),
      ],
      "i1",
    );
    expect(text).toBe("g1:declined:,g2:accepted:m1");
  });
});

describe("confirmationText", () => {
  it("lists answers and meals but nothing private", () => {
    const t = confirmationText(
      ctx,
      [
        { name: "Sam Example", status: "accepted", meal: "Fish" },
        { name: "Jo\nExample", status: "declined", meal: "Fish" },
      ],
      "2027-05-01T06:59:59Z",
    );
    expect(t.subject).toBe("Your reply for Reception is saved");
    expect(t.body).toContain("- Sam Example: attending, Fish");
    expect(t.body).toContain("- Jo Example: not attending\n");
    expect(t.body).toContain("until the end of [2027-05-01]");
    expect(t.body).not.toMatch(/https?:|rsvp\//i);
  });
});

describe("reminderText", () => {
  it("names everyone still waiting", () => {
    const t = reminderText(ctx, ["Sam", "Jo", "Kit"], null);
    expect(t.body).toContain("whether Sam, Jo and Kit can join us for Reception");
    expect(t.subject).toBe("Please reply for Reception");
  });
});

describe("planConfirmations", () => {
  it("only for replied invitations, one per address, keyed by the reply state", () => {
    const members = [
      member({ guestId: "g1", status: "accepted", mealOptionId: "m1" }),
      member({ guestId: "g2", status: "declined" }),
      member({ guestId: "g3", status: "accepted", isPlusOne: true }),
    ];
    const out = planConfirmations({
      ...base,
      invitations: [inv(), inv({ id: "i2" })],
      members,
      replied: new Set(["i1"]),
    });
    expect(out.map((m) => m.guestId)).toEqual(["g1", "g2"]);
    const first = out[0];
    expect(first?.stateText).toBe("g1:accepted:m1,g2:declined:,g3:accepted:");
    expect(first?.dedupeKey).toBe(`confirm:i1:${hash(first?.stateText ?? "").slice(0, 16)}:g1`);
    expect(first?.body).toContain("Kit Example: attending");
  });

  it("skips revoked invitations and archived or duplicate addresses", () => {
    const out = planConfirmations({
      ...base,
      guests: [
        { id: "g1", fullName: "A", email: "same@example.test", archived: false },
        { id: "g2", fullName: "B", email: "same@example.test", archived: false },
        { id: "g4", fullName: "C", email: "c@example.test", archived: true },
      ],
      invitations: [inv(), inv({ id: "i2", revokedAt: "2027-01-01T00:00:00Z" })],
      members: [
        member({ guestId: "g1", status: "accepted" }),
        member({ guestId: "g2", status: "accepted" }),
        member({ guestId: "g4", status: "accepted" }),
        member({ invitationId: "i2", guestId: "g1", status: "accepted" }),
      ],
      replied: new Set(["i1", "i2"]),
    });
    expect(out.map((m) => [m.invitationId, m.guestId])).toEqual([["i1", "g1"]]);
  });

  it("leaves out the change-until date once the reply date has passed", () => {
    const [m] = planConfirmations({
      ...base,
      invitations: [inv({ deadline: "2027-02-01T00:00:00Z" })],
      members: [member({ status: "accepted" })],
      replied: new Set(["i1"]),
    });
    expect(m?.body).not.toContain("until the end of");
  });
});

describe("planReminders", () => {
  it("goes only to people still waiting on open invitations, once per day", () => {
    const out = planReminders({
      ...base,
      invitations: [
        inv(),
        inv({ id: "closed", deadline: "2027-02-01T00:00:00Z" }),
        inv({ id: "expired", expiresAt: "2027-02-01T00:00:00Z" }),
      ],
      members: [
        member({ guestId: "g1", status: "accepted" }),
        member({ guestId: "g2" }),
        member({ guestId: "g3" }),
        member({ invitationId: "closed", guestId: "g1" }),
        member({ invitationId: "expired", guestId: "g1" }),
      ],
      replied: new Set(),
    });
    expect(out.map((m) => m.guestId)).toEqual(["g2"]);
    expect(out[0]?.dedupeKey).toBe("remind:i1:g2:2027-03-01");
    expect(out[0]?.body).toContain("whether Jo Example and Kit Example can join us");
    expect(out[0]?.subject).toBe("Please reply for Reception by [2027-05-01]");
  });

  it("does nothing when everyone has replied", () => {
    expect(
      planReminders({
        ...base,
        invitations: [inv()],
        members: [member({ status: "declined" })],
        replied: new Set(["i1"]),
      }),
    ).toEqual([]);
  });
});

describe("draftMatchesPlan", () => {
  const planned: PlannedMessage = {
    kind: "reply_reminder",
    invitationId: "inv-1",
    guestId: "g-1",
    dedupeKey: "remind:inv-1:g-1:2026-11-23",
    stateText: "g-1:pending:",
    stateHash: "0".repeat(64),
    subject: "A note about our wedding",
    body: "We'd love to know.",
  };
  const draft = {
    kind: "reply_reminder" as const,
    invitationId: "inv-1",
    guestId: "g-1",
    subject: planned.subject,
    body: planned.body,
  };

  it("matches text the composer would write now", () => {
    expect(draftMatchesPlan(draft, [planned])).toBe("match");
  });

  it("refuses a body or subject the composer did not write", () => {
    expect(draftMatchesPlan({ ...draft, body: "Click https://example.invalid" }, [planned])).toBe(
      "different",
    );
    expect(draftMatchesPlan({ ...draft, subject: "Urgent" }, [planned])).toBe("different");
  });

  it("is missing when the composer would no longer write to this person", () => {
    expect(draftMatchesPlan(draft, [])).toBe("missing");
    expect(draftMatchesPlan({ ...draft, guestId: "g-2" }, [planned])).toBe("missing");
    expect(draftMatchesPlan({ ...draft, kind: "rsvp_confirmation" }, [planned])).toBe("missing");
  });
});
