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
  "seating.manage",
  "budget.manage",
  "plan.edit",
  "vendors.manage", // venue/vendor candidates and, later, proposals and bookings
  "design.view",
  "exports.create",
  "site.publish", // puts the guest website on the public internet; never grantable
  "external.send",
  "members.view",
  "members.manage",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * Areas an owner can open to a planner/editor (ADR-031 D7). Partners hold all of them by default and
 * viewers can never hold any. Stored as flat booleans in memberships.permissions and re-checked by
 * the database helpers, so this list is a mirror, not the enforcement.
 */
export const GRANT_AREAS = [
  "guests",
  "guest_private",
  "seating",
  "budget",
  "vendors",
  "plan",
] as const;
export type GrantArea = (typeof GRANT_AREAS)[number];

export function isGrantArea(value: unknown): value is GrantArea {
  return typeof value === "string" && (GRANT_AREAS as readonly string[]).includes(value);
}

/**
 * Seating and private guest details are meaningless without the guest list, so they depend on it.
 * The database applies the same rule when it reads a stored grant, and refuses to store a grant set
 * that breaks it.
 */
export const GRANT_REQUIRES: Readonly<Partial<Record<GrantArea, GrantArea>>> = {
  guest_private: "guests",
  seating: "guests",
};

export const GRANT_LABELS: Record<GrantArea, { label: string; help: string }> = {
  guests: {
    label: "Guests",
    help: "See and edit guests, households, events, replies and invitation links. Also sees the seating plan, read-only.",
  },
  guest_private: {
    label: "Private guest details",
    help: "See and edit dietary, access and private notes. Needs Guests.",
  },
  seating: {
    label: "Seating",
    help: "Arrange tables and seats and finalize the plan. Needs Guests.",
  },
  budget: {
    label: "Budget and bookings",
    help: "See and edit budget, quotes accepted as bookings, payments, invoices and documents.",
  },
  vendors: {
    label: "Venues and vendors",
    help: "See and edit venue and vendor shortlists, quotes, comparisons and spaces.",
  },
  plan: {
    label: "Plan and design",
    help: "Edit the checklist, agenda, design boards and website draft. Publishing stays with you and your partner.",
  },
};

/**
 * Grants stored on a membership: `manage_members` for a partner, per-area booleans for an editor.
 * Each role reads only the keys that apply to it.
 */
export type MemberGrants = { manage_members?: boolean } & Partial<Record<GrantArea, boolean>>;

/** Drops grants that break a dependency (for example seating without guests). */
export function normalizeAreas(areas: Iterable<GrantArea>): GrantArea[] {
  const set = new Set(areas);
  for (const area of GRANT_AREAS) {
    const needs = GRANT_REQUIRES[area];
    if (set.has(area) && needs && !set.has(needs)) set.delete(area);
  }
  return GRANT_AREAS.filter((a) => set.has(a));
}

export function grantedAreas(grants: MemberGrants): GrantArea[] {
  return normalizeAreas(GRANT_AREAS.filter((a) => grants[a] === true));
}

const AREA_CAPABILITY: Record<GrantArea, Capability> = {
  guests: "guests.manage",
  guest_private: "guests.sensitive.read",
  seating: "seating.manage",
  budget: "budget.manage",
  vendors: "vendors.manage",
  plan: "plan.edit",
};

const ALL = new Set<Capability>(CAPABILITIES);

const PARTNER_DEFAULT = new Set<Capability>([
  "workspace.view",
  "settings.edit",
  "guests.manage",
  "guests.sensitive.read",
  "seating.manage",
  "budget.manage",
  "plan.edit",
  "vendors.manage",
  "design.view",
  "exports.create",
  "site.publish",
  "members.view",
]);

const EDITOR_DEFAULT = new Set<Capability>(["workspace.view", "design.view", "members.view"]);
const VIEWER_DEFAULT = new Set<Capability>(["workspace.view", "design.view", "members.view"]);

export function capabilitiesFor(role: MembershipRole, grants: MemberGrants = {}): Set<Capability> {
  switch (role) {
    case "owner":
      return new Set(ALL);
    case "partner": {
      const set = new Set(PARTNER_DEFAULT);
      if (grants.manage_members === true) set.add("members.manage");
      return set;
    }
    case "editor": {
      const set = new Set(EDITOR_DEFAULT);
      for (const area of grantedAreas(grants)) set.add(AREA_CAPABILITY[area]);
      return set;
    }
    case "viewer":
      return new Set(VIEWER_DEFAULT);
  }
}

export function can(role: MembershipRole, capability: Capability, grants: MemberGrants = {}) {
  return capabilitiesFor(role, grants).has(capability);
}

/** Parses the stored JSON grants defensively; unknown keys and non-true values grant nothing. */
export function parseGrants(value: unknown): MemberGrants {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const out: MemberGrants = {};
  if (raw.manage_members === true) out.manage_members = true;
  for (const area of GRANT_AREAS) if (raw[area] === true) out[area] = true;
  return out;
}

/** Roles an actor may assign or invite, mirroring the database rules. */
export function assignableRoles(
  actorRole: MembershipRole,
  grants: MemberGrants = {},
): readonly MembershipRole[] {
  if (actorRole === "owner") return ["owner", "partner", "editor", "viewer"];
  if (actorRole === "partner" && grants.manage_members === true) return ["editor", "viewer"];
  return [];
}

/** Whether `actor` may change or remove a member currently holding `targetRole`. */
export function canAdministerMember(
  actorRole: MembershipRole,
  grants: MemberGrants,
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
