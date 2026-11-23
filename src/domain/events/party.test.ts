import { describe, expect, it } from "vitest";
import { partyExpiry, partyGroups, type PartyInvitationFacts } from "./party";

const now = new Date("2026-06-01T12:00:00Z");
const later = "2026-09-01T00:00:00Z";
const inv = (id: string, over: Partial<PartyInvitationFacts> = {}): PartyInvitationFacts => ({
  id,
  eventId: `e-${id}`,
  householdId: "h1",
  label: "The Examples",
  revokedAt: null,
  expiresAt: later,
  deadline: null,
  partyId: null,
  ...over,
});
const member = (invitationId: string, guestId: string, isPlusOne = false) => ({
  invitationId,
  guestId,
  isPlusOne,
  active: true,
});

describe("partyGroups", () => {
  it("groups a household's invitations to different events", () => {
    const groups = partyGroups({
      invitations: [inv("a"), inv("b")],
      members: [],
      parties: [],
      now,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ invitationIds: ["a", "b"], blocked: null, party: null });
  });

  it("leaves out a household with only one live invitation", () => {
    const groups = partyGroups({
      invitations: [inv("a"), inv("b", { revokedAt: "2026-05-01T00:00:00Z" })],
      members: [],
      parties: [],
      now,
    });
    expect(groups).toEqual([]);
  });

  it("counts closed invitations as live but not expired ones", () => {
    const groups = partyGroups({
      invitations: [
        inv("a", { deadline: "2026-05-01T00:00:00Z" }),
        inv("b"),
        inv("c", { expiresAt: "2026-05-01T00:00:00Z" }),
      ],
      members: [],
      parties: [],
      now,
    });
    expect(groups[0]?.invitationIds).toEqual(["a", "b"]);
  });

  it("groups individuals only when the same people are invited, ignoring plus-ones", () => {
    const groups = partyGroups({
      invitations: [
        inv("a", { householdId: null, label: "Cy" }),
        inv("b", { householdId: null, label: "Cy" }),
        inv("c", { householdId: null, label: "Di" }),
      ],
      members: [member("a", "cy"), member("b", "cy"), member("b", "p1", true), member("c", "di")],
      parties: [],
      now,
    });
    expect(groups.map((g) => g.invitationIds)).toEqual([["a", "b"]]);
  });

  it("blocks two invitations of one household to the same event", () => {
    const groups = partyGroups({
      invitations: [inv("a", { eventId: "e1" }), inv("b", { eventId: "e1" })],
      members: [],
      parties: [],
      now,
    });
    expect(groups[0]?.blocked).toBe("same_event_twice");
  });

  it("shows the live link and the events it does not cover", () => {
    const party = {
      id: "p1",
      householdId: "h1",
      label: "The Examples",
      expiresAt: later,
      revokedAt: null,
      version: 1,
    };
    const groups = partyGroups({
      invitations: [inv("a", { partyId: "p1" }), inv("b", { partyId: "p1" }), inv("c")],
      members: [],
      parties: [party],
      now,
    });
    expect(groups[0]).toMatchObject({ party, notInLink: ["c"], blocked: "has_link" });
  });

  it("treats a revoked link as no link, so a new one can be made", () => {
    const groups = partyGroups({
      invitations: [inv("a", { partyId: "p1" }), inv("b", { partyId: "p1" })],
      members: [],
      parties: [
        {
          id: "p1",
          householdId: "h1",
          label: "The Examples",
          expiresAt: later,
          revokedAt: "2026-05-01T00:00:00Z",
          version: 2,
        },
      ],
      now,
    });
    expect(groups[0]).toMatchObject({ party: null, blocked: null });
  });

  it("keeps a group with a live link even when only one invitation is left", () => {
    const groups = partyGroups({
      invitations: [
        inv("a", { partyId: "p1" }),
        inv("b", { partyId: "p1", revokedAt: "2026-05-01T00:00:00Z" }),
      ],
      members: [],
      parties: [
        {
          id: "p1",
          householdId: "h1",
          label: "The Examples",
          expiresAt: later,
          revokedAt: null,
          version: 1,
        },
      ],
      now,
    });
    expect(groups[0]).toMatchObject({ invitationIds: ["a"], blocked: "has_link" });
  });

  it("is ordered by label and does not depend on input order", () => {
    const a = [
      inv("a", { householdId: "h2", label: "Zed" }),
      inv("b", { householdId: "h2", label: "Zed" }),
      inv("c", { householdId: "h1", label: "Ann" }),
      inv("d", { householdId: "h1", label: "Ann" }),
    ];
    const one = partyGroups({ invitations: a, members: [], parties: [], now });
    const two = partyGroups({ invitations: [...a].reverse(), members: [], parties: [], now });
    expect(one.map((g) => g.label)).toEqual(["Ann", "Zed"]);
    expect(two.map((g) => g.key)).toEqual(one.map((g) => g.key));
  });
});

describe("partyExpiry", () => {
  it("is the latest future expiry", () => {
    expect(
      partyExpiry(
        [{ expiresAt: "2026-07-01T00:00:00Z" }, { expiresAt: "2026-08-01T00:00:00Z" }],
        now,
      ),
    ).toBe("2026-08-01T00:00:00.000Z");
  });
  it("is null when every invitation has expired", () => {
    expect(partyExpiry([{ expiresAt: "2026-05-01T00:00:00Z" }], now)).toBeNull();
  });
});
