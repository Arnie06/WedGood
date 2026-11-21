import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  assignableRoles,
  can,
  canAdministerMember,
  capabilitiesFor,
  isMembershipRole,
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
