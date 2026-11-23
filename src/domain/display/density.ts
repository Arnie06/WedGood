import type { MembershipRole } from "@/domain/permissions";

/**
 * List spacing (UX-18). One set of components; "compact" only tightens padding and gaps so a
 * planner working across many weddings sees more rows at once. Touch targets keep their 44px
 * minimum in both settings.
 */
export const DENSITIES = ["comfortable", "compact"] as const;
export type Density = (typeof DENSITIES)[number];

export const DENSITY_LABELS: Record<Density, string> = {
  comfortable: "Comfortable",
  compact: "Compact",
};

export function isDensity(value: unknown): value is Density {
  return typeof value === "string" && (DENSITIES as readonly string[]).includes(value);
}

/** Planners (the editor role) start compact; couples and viewers start comfortable. */
export function defaultDensity(role: MembershipRole): Density {
  return role === "editor" ? "compact" : "comfortable";
}

/** A saved choice wins; anything missing or unrecognised falls back to the role default. */
export function resolveDensity(saved: unknown, role: MembershipRole): Density {
  return isDensity(saved) ? saved : defaultDensity(role);
}
