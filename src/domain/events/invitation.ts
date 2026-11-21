/** Invitation state and grouping rules (docs/07 "Invitations and guests"). Pure. */

export type InvitationFacts = {
  revokedAt: string | null;
  expiresAt: string;
  deadline: string | null;
};
export type InvitationState = "revoked" | "expired" | "closed" | "open";

/**
 * revoked and expired links cannot be read or answered at all. closed means the link works but
 * the response deadline has passed, so only the owner can change answers (with a reason).
 */
export function invitationState(inv: InvitationFacts, now: Date): InvitationState {
  if (inv.revokedAt !== null) return "revoked";
  if (new Date(inv.expiresAt).getTime() <= now.getTime()) return "expired";
  if (inv.deadline !== null && now.getTime() > new Date(inv.deadline).getTime()) return "closed";
  return "open";
}

export type InvitableGuest = { id: string; householdId: string | null };
export type InvitationGroup = { guestIds: string[]; householdId: string | null };

/**
 * One invitation per picked household (all its active guests not already invited to this event)
 * and one per picked individual. A guest never lands in two groups and an already-invited guest
 * is skipped, so the one-active-response-per-event rule holds before the database checks it.
 */
export function buildInvitationGroups(input: {
  guests: readonly InvitableGuest[];
  pickedHouseholdIds: readonly string[];
  pickedGuestIds: readonly string[];
  alreadyInvited: ReadonlySet<string>;
}): { groups: InvitationGroup[]; skipped: number } {
  const taken = new Set<string>(input.alreadyInvited);
  const groups: InvitationGroup[] = [];
  let skipped = 0;
  for (const householdId of new Set(input.pickedHouseholdIds)) {
    const ids: string[] = [];
    for (const g of input.guests) {
      if (g.householdId !== householdId) continue;
      if (taken.has(g.id)) skipped += 1;
      else ids.push(g.id);
    }
    if (ids.length === 0) continue;
    ids.forEach((id) => taken.add(id));
    groups.push({ guestIds: ids.slice(0, 12), householdId });
  }
  const known = new Map(input.guests.map((g) => [g.id, g]));
  for (const guestId of new Set(input.pickedGuestIds)) {
    if (!known.has(guestId)) continue;
    if (taken.has(guestId)) {
      skipped += 1;
      continue;
    }
    taken.add(guestId);
    groups.push({ guestIds: [guestId], householdId: null });
  }
  return { groups, skipped };
}
