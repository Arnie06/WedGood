/**
 * Role → capability matrix (docs/10-SECURITY.md). Pure and framework-free.
 * Deny by default: a capability not listed for a role is not granted. The
 * database re-enforces everything that mutates data; this matrix drives server
 * guards and honest UI states, never the only line of defence.
 */

export const MEMBERSHIP_ROLES = ["owner", "partner", "editor", "viewer"] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export function isMembershipRole(value: unknown): value is MembershipRole {
  return typeof value === "string" && (MEMBERSHIP_ROLES as readonly string[]).includes(value);
}

export const CAPABILITIES = [
  "workspace.view",
  "workspace.manage", // ownership, deletion, owner transfer
  "settings.edit",
  "guests.manage",
  "guests.sensitive.read",
  "budget.manage",
  "plan.edit",
  "vendors.manage", // venue/vendor candidates and, later, proposals and bookings
  "design.view",
  "exports.create",
  "external.send",
  "members.view",
  "members.manage",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Grants an owner can attach to a partner (stored in memberships.permissions). */
export type PartnerGrants = { manage_members?: boolean };

const ALL = new Set<Capability>(CAPABILITIES);

const PARTNER_DEFAULT = new Set<Capability>([
  "workspace.view",
  "settings.edit",
  "guests.manage",
  "guests.sensitive.read",
  "budget.manage",
  "plan.edit",
  "vendors.manage",
  "design.view",
  "exports.create",
  "members.view",
]);

const EDITOR_DEFAULT = new Set<Capability>(["workspace.view", "design.view", "members.view"]);
const VIEWER_DEFAULT = new Set<Capability>(["workspace.view", "design.view", "members.view"]);

export function capabilitiesFor(role: MembershipRole, grants: PartnerGrants = {}): Set<Capability> {
  switch (role) {
    case "owner":
      return new Set(ALL);
    case "partner": {
      const set = new Set(PARTNER_DEFAULT);
      if (grants.manage_members === true) set.add("members.manage");
      return set;
    }
    case "editor":
      return new Set(EDITOR_DEFAULT);
    case "viewer":
      return new Set(VIEWER_DEFAULT);
  }
}

export function can(role: MembershipRole, capability: Capability, grants: PartnerGrants = {}) {
  return capabilitiesFor(role, grants).has(capability);
}

/** Parses the stored JSON grants defensively; unknown shapes grant nothing. */
export function parseGrants(value: unknown): PartnerGrants {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return (value as Record<string, unknown>).manage_members === true
      ? { manage_members: true }
      : {};
  }
  return {};
}

/** Roles an actor may assign or invite, mirroring the database rules. */
export function assignableRoles(
  actorRole: MembershipRole,
  grants: PartnerGrants = {},
): readonly MembershipRole[] {
  if (actorRole === "owner") return ["owner", "partner", "editor", "viewer"];
  if (actorRole === "partner" && grants.manage_members === true) return ["editor", "viewer"];
  return [];
}

/** Whether `actor` may change or remove a member currently holding `targetRole`. */
export function canAdministerMember(
  actorRole: MembershipRole,
  grants: PartnerGrants,
  targetRole: MembershipRole,
): boolean {
  if (actorRole === "owner") return true;
  if (actorRole === "partner" && grants.manage_members === true) {
    return targetRole === "editor" || targetRole === "viewer";
  }
  return false;
}

export const ROLE_LABELS: Record<MembershipRole, string> = {
  owner: "Owner",
  partner: "Partner",
  editor: "Planner / editor",
  viewer: "Family / viewer",
};
