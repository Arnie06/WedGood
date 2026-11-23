/**
 * Dietary and accessibility notes come from two places: the couple's own text and what the guest
 * typed on their RSVP link (kept separately so neither overwrites the other). Places that show one
 * line, such as seating panels and place cards, use the combined form.
 */
export type NotePair = { couple: string | null; guest: string | null };

const clean = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

/**
 * One line for both sources. The couple's text comes first; the guest's is added only when it says
 * something different, marked so it is clear who wrote it.
 */
export function combineNote({ couple, guest }: NotePair): string | null {
  const c = clean(couple);
  const g = clean(guest);
  if (!g) return c;
  if (!c) return `Guest says: ${g}`;
  if (c.toLowerCase() === g.toLowerCase()) return c;
  return `${c} · Guest says: ${g}`;
}
