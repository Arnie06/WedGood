/**
 * The one place for host-specific policy on the link lookup (ADR-029). It ships with
 * no blocked sites. When the owner decides that a site must not be read, add its host
 * here with the reason and note it in docs/15-DECISIONS.md. Matching is on the exact
 * host or any subdomain of it, ignoring a leading "www.".
 */
export type SiteRule = { host: string; reason: string };

export const BLOCKED_SITES: readonly SiteRule[] = [];

export type SiteDecision = { allowed: true } | { allowed: false; reason: string };

export function siteDecision(
  hostname: string,
  rules: readonly SiteRule[] = BLOCKED_SITES,
): SiteDecision {
  const host = hostname
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
  for (const rule of rules) {
    const blockedHost = rule.host.toLowerCase().replace(/^www\./, "");
    if (host === blockedHost || host.endsWith(`.${blockedHost}`)) {
      return { allowed: false, reason: rule.reason };
    }
  }
  return { allowed: true };
}
