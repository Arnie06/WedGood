/**
 * One link per party (UX-06): which invitations can share one link, and what an existing party
 * link covers. Pure. The database (`create_party_link`) re-checks every rule.
 *
 * A party is a household's invitations, or (no household) invitations that invite exactly the
 * same people. Only live invitations (not revoked, not expired) count. A party link needs at
 * least two events and at most one invitation per event.
 */
import { invitationState } from "./invitation";

export const PARTY_MAX_EVENTS = 12;

export type PartyInvitationFacts = {
  id: string;
  eventId: string;
  householdId: string | null;
  label: string;
  revokedAt: string | null;
  expiresAt: string;
  deadline: string | null;
  partyId: string | null;
};
export type PartyMemberFacts = {
  invitationId: string;
  guestId: string;
  isPlusOne: boolean;
  active: boolean;
};
export type PartyFacts = {
  id: string;
  householdId: string | null;
  label: string;
  expiresAt: string;
  revokedAt: string | null;
  version: number;
};

export type PartyGroup = {
  key: string;
  label: string;
  householdId: string | null;
  /** Live invitations of this party, in input order. */
  invitationIds: string[];
  /** The live party link covering some of them, if any. */
  party: PartyFacts | null;
  /** Live invitations the live party link does not cover (for example a later event). */
  notInLink: string[];
  /** Why a new link can't be made, or null when it can. */
  blocked: "has_link" | "too_few_events" | "same_event_twice" | "too_many_events" | null;
};

const isLive = (inv: PartyInvitationFacts, now: Date) => {
  const s = invitationState(inv, now);
  return s === "open" || s === "closed";
};

export function partyIsLive(p: PartyFacts, now: Date): boolean {
  return p.revokedAt === null && new Date(p.expiresAt).getTime() > now.getTime();
}

/**
 * Groups live invitations into parties. Only groups worth showing are returned: two or more live
 * invitations, or a live party link. Ordered by label, then key, so output is deterministic.
 */
export function partyGroups(input: {
  invitations: readonly PartyInvitationFacts[];
  members: readonly PartyMemberFacts[];
  parties: readonly PartyFacts[];
  now: Date;
}): PartyGroup[] {
  const people = new Map<string, string[]>();
  for (const m of input.members) {
    if (!m.active || m.isPlusOne) continue;
    const list = people.get(m.invitationId) ?? [];
    list.push(m.guestId);
    people.set(m.invitationId, list);
  }
  const liveParties = new Map(
    input.parties.filter((p) => partyIsLive(p, input.now)).map((p) => [p.id, p]),
  );

  const groups = new Map<
    string,
    { label: string; householdId: string | null; invs: PartyInvitationFacts[] }
  >();
  for (const inv of input.invitations) {
    if (!isLive(inv, input.now)) continue;
    let key: string;
    if (inv.householdId !== null) {
      key = `h:${inv.householdId}`;
    } else {
      const ids = [...(people.get(inv.id) ?? [])].sort();
      if (ids.length === 0) continue;
      key = `g:${ids.join(",")}`;
    }
    const g = groups.get(key) ?? { label: inv.label, householdId: inv.householdId, invs: [] };
    g.invs.push(inv);
    groups.set(key, g);
  }

  const out: PartyGroup[] = [];
  for (const [key, g] of groups) {
    const party =
      g.invs.map((i) => (i.partyId ? liveParties.get(i.partyId) : undefined)).find(Boolean) ?? null;
    if (g.invs.length < 2 && !party) continue;
    const events = new Set(g.invs.map((i) => i.eventId));
    const blocked: PartyGroup["blocked"] = party
      ? "has_link"
      : g.invs.length < 2
        ? "too_few_events"
        : events.size < g.invs.length
          ? "same_event_twice"
          : g.invs.length > PARTY_MAX_EVENTS
            ? "too_many_events"
            : null;
    out.push({
      key,
      label: party?.label ?? g.label,
      householdId: g.householdId,
      invitationIds: g.invs.map((i) => i.id),
      party,
      notInLink: party ? g.invs.filter((i) => i.partyId !== party.id).map((i) => i.id) : [],
      blocked,
    });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
}

/** The party link stays valid as long as the longest-lived of its invitations. */
export function partyExpiry(
  invitations: readonly { expiresAt: string }[],
  now: Date,
): string | null {
  let best: number | null = null;
  for (const i of invitations) {
    const t = new Date(i.expiresAt).getTime();
    if (t > now.getTime() && (best === null || t > best)) best = t;
  }
  return best === null ? null : new Date(best).toISOString();
}
