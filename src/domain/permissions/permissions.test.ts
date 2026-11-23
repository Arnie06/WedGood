import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  GRANT_AREAS,
  assignableRoles,
  can,
  canAdministerMember,
  capabilitiesFor,
  grantedAreas,
  isMembershipRole,
  normalizeAreas,
  parseGrants,
} from ".";

describe("role matrix", () => {
  it("gives owners every capability", () => {
    for (const c of CAPABILITIES) expect(can("owner", c)).toBe(true);
  });

  it("keeps ownership and member administration away from partners by default", () => {
    expect(can("partner", "workspace.manage")).toBe(false);
    expect(can("partner", "members.manage")).toBe(false);
    expect(can("partner", "guests.sensitive.read")).toBe(true);
    expect(can("partner", "settings.edit")).toBe(true);
  });

  it("requires an explicit grant for partner member administration but never ownership", () => {
    expect(can("partner", "members.manage", { manage_members: true })).toBe(true);
    expect(can("partner", "workspace.manage", { manage_members: true })).toBe(false);
  });

  it("ignores grants for non-partner roles", () => {
    expect(can("editor", "members.manage", { manage_members: true })).toBe(false);
    expect(can("viewer", "members.manage", { manage_members: true })).toBe(false);
  });

  it("denies viewers and editors sensitive data, budget, guests and exports by default", () => {
    for (const role of ["viewer", "editor"] as const) {
      for (const c of [
        "guests.sensitive.read",
        "budget.manage",
        "vendors.manage",
        "guests.manage",
        "exports.create",
        "external.send",
        "settings.edit",
      ] as const) {
        expect(can(role, c)).toBe(false);
      }
      expect(can(role, "workspace.view")).toBe(true);
    }
  });

  it("does not hand out external sending by default to anyone but owners", () => {
    expect(can("partner", "external.send")).toBe(false);
  });

  it("returns independent sets", () => {
    const a = capabilitiesFor("viewer");
    a.add("members.manage");
    expect(can("viewer", "members.manage")).toBe(false);
  });
});

describe("administration rules mirror the database", () => {
  it("lets owners assign every role and delegates only editor/viewer", () => {
    expect(assignableRoles("owner")).toEqual(["owner", "partner", "editor", "viewer"]);
    expect(assignableRoles("partner", { manage_members: true })).toEqual(["editor", "viewer"]);
    expect(assignableRoles("partner")).toEqual([]);
    expect(assignableRoles("editor", { manage_members: true })).toEqual([]);
    expect(assignableRoles("viewer")).toEqual([]);
  });

  it("limits delegates to editors and viewers", () => {
    const g = { manage_members: true };
    expect(canAdministerMember("partner", g, "viewer")).toBe(true);
    expect(canAdministerMember("partner", g, "editor")).toBe(true);
    expect(canAdministerMember("partner", g, "partner")).toBe(false);
    expect(canAdministerMember("partner", g, "owner")).toBe(false);
    expect(canAdministerMember("partner", {}, "viewer")).toBe(false);
    expect(canAdministerMember("owner", {}, "owner")).toBe(true);
  });
});

describe("input parsing", () => {
  it("accepts only known roles", () => {
    expect(isMembershipRole("owner")).toBe(true);
    expect(isMembershipRole("admin")).toBe(false);
    expect(isMembershipRole(undefined)).toBe(false);
  });

  it("parses grants defensively", () => {
    expect(parseGrants({ manage_members: true })).toEqual({ manage_members: true });
    expect(parseGrants({ manage_members: "true" })).toEqual({});
    expect(parseGrants(null)).toEqual({});
    expect(parseGrants([])).toEqual({});
    expect(parseGrants({ owner: true })).toEqual({});
  });
});

describe("planner/editor grants (ADR-031 D7)", () => {
  it("gives an editor nothing beyond reading until an area is granted", () => {
    const base = capabilitiesFor("editor", {});
    expect([...base].sort()).toEqual(["design.view", "members.view", "workspace.view"]);
  });

  it("maps each area to its capability and no other", () => {
    expect(can("editor", "budget.manage", { budget: true })).toBe(true);
    expect(can("editor", "guests.manage", { budget: true })).toBe(false);
    expect(can("editor", "vendors.manage", { vendors: true })).toBe(true);
    expect(can("editor", "plan.edit", { plan: true })).toBe(true);
    expect(can("editor", "guests.manage", { guests: true })).toBe(true);
    expect(can("editor", "seating.manage", { guests: true })).toBe(false);
    expect(can("editor", "guests.sensitive.read", { guests: true })).toBe(false);
  });

  it("makes seating and private details depend on guests", () => {
    expect(can("editor", "seating.manage", { seating: true })).toBe(false);
    expect(can("editor", "guests.sensitive.read", { guest_private: true })).toBe(false);
    expect(can("editor", "seating.manage", { guests: true, seating: true })).toBe(true);
    expect(can("editor", "guests.sensitive.read", { guests: true, guest_private: true })).toBe(
      true,
    );
    expect(normalizeAreas(["seating", "plan"])).toEqual(["plan"]);
    expect(normalizeAreas(["guests", "seating", "guest_private"])).toEqual([
      "guests",
      "guest_private",
      "seating",
    ]);
  });

  it("never lets a grant reach what is not an area", () => {
    const everything = Object.fromEntries(GRANT_AREAS.map((a) => [a, true]));
    for (const c of [
      "workspace.manage",
      "settings.edit",
      "members.manage",
      "exports.create",
      "site.publish",
      "external.send",
    ] as const) {
      expect(can("editor", c, { ...everything, manage_members: true })).toBe(false);
    }
  });

  it("ignores grants on a viewer and keeps owner and partner complete without any", () => {
    const everything = Object.fromEntries(GRANT_AREAS.map((a) => [a, true]));
    for (const c of CAPABILITIES) expect(can("viewer", c, everything)).toBe(c.endsWith(".view"));
    for (const c of ["guests.manage", "seating.manage", "budget.manage", "plan.edit"] as const) {
      expect(can("partner", c)).toBe(true);
    }
    expect(can("partner", "site.publish")).toBe(true);
  });

  it("parses stored grants defensively and lists them in a stable order", () => {
    expect(
      parseGrants({ plan: true, guests: "yes", budget: 1, seating: true, nope: true }),
    ).toEqual({
      plan: true,
      seating: true,
    });
    expect(grantedAreas({ seating: true, plan: true })).toEqual(["plan"]);
    expect(grantedAreas({ vendors: true, guests: true, seating: true })).toEqual([
      "guests",
      "seating",
      "vendors",
    ]);
  });
});
