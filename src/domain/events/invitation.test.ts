import { describe, expect, it } from "vitest";
import { buildInvitationGroups, invitationState } from "./invitation";

const now = new Date("2027-03-01T12:00:00Z");
const base = { revokedAt: null, expiresAt: "2027-06-01T00:00:00Z", deadline: null };

describe("invitationState", () => {
  it("is open before the deadline and closed after it", () => {
    expect(invitationState(base, now)).toBe("open");
    expect(invitationState({ ...base, deadline: "2027-03-01T12:00:00Z" }, now)).toBe("open");
    expect(invitationState({ ...base, deadline: "2027-03-01T11:59:59Z" }, now)).toBe("closed");
  });
  it("revoked wins over expired, expired wins over closed", () => {
    const old = { ...base, expiresAt: "2027-01-01T00:00:00Z", deadline: "2027-01-01T00:00:00Z" };
    expect(invitationState(old, now)).toBe("expired");
    expect(invitationState({ ...old, revokedAt: "2027-02-01T00:00:00Z" }, now)).toBe("revoked");
  });
  it("treats the expiry instant as expired", () => {
    expect(invitationState({ ...base, expiresAt: now.toISOString() }, now)).toBe("expired");
  });
});

describe("buildInvitationGroups", () => {
  const guests = [
    { id: "a", householdId: "h1" },
    { id: "b", householdId: "h1" },
    { id: "c", householdId: null },
    { id: "d", householdId: "h2" },
  ];
  it("groups a household and skips guests already invited", () => {
    const r = buildInvitationGroups({
      guests,
      pickedHouseholdIds: ["h1"],
      pickedGuestIds: [],
      alreadyInvited: new Set(["b"]),
    });
    expect(r.groups).toEqual([{ guestIds: ["a"], householdId: "h1" }]);
    expect(r.skipped).toBe(1);
  });
  it("never puts a guest in two groups", () => {
    const r = buildInvitationGroups({
      guests,
      pickedHouseholdIds: ["h1", "h1"],
      pickedGuestIds: ["a", "c", "c", "zzz"],
      alreadyInvited: new Set(),
    });
    expect(r.groups).toEqual([
      { guestIds: ["a", "b"], householdId: "h1" },
      { guestIds: ["c"], householdId: null },
    ]);
    expect(r.skipped).toBe(1);
  });
});
