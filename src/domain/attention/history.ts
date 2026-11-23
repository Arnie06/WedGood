import { instantToLocal } from "@/domain/timeline/zoned";
import { formatDateOnly, parseDateOnly } from "@/domain/dates/date-only";
import { itemKey, type AttentionItem } from "./attention";

/**
 * Needs-attention item history (UX-12). Pure and framework-free.
 *
 * Nothing new is stored: the history is read back from rows that already exist. A stored item
 * (`seats_released`) has its own row plus one `seating.guest_released` audit event per release and
 * an `attention.handled` audit event when someone closes it; earlier rounds for the same event are
 * closed rows. A computed item has only `attention.dismissed` / `attention.restored` audit events
 * and, while hidden, a dismissal row.
 *
 * Who did something is shown as "You" or by role, never by name or email, so the drawer adds no
 * personal data to the page. Audit events are readable by owner and partner only (database row
 * security); for anyone else the caller passes none and marks the history partial.
 */

export type Actor = "you" | "owner" | "partner" | "editor" | "viewer" | "someone";

export type StoredRow = {
  id: string;
  eventId: string;
  status: "open" | "handled" | "refinalized";
  occurrences: number;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: Actor | null;
};

export type AuditFact = {
  action:
    "seating.guest_released" | "attention.handled" | "attention.dismissed" | "attention.restored";
  /** Event for a release (resolved from the layout), the item row for handled, else the subject. */
  entityId: string;
  /** For dismissed and restored: the kind named in the audit row. */
  kind: string | null;
  at: string;
  actor: Actor | null;
};

export type DismissalRow = {
  kind: string;
  subjectId: string;
  fingerprint: string;
  dismissedAt: string;
  dismissedBy: Actor | null;
};

export type HistoryLine = { at: string; text: string };

export type HistoryInput = {
  timeZone: string;
  stored: readonly StoredRow[];
  audit: readonly AuditFact[];
  dismissals: readonly DismissalRow[];
};

/** How many lines a drawer shows; older ones are summarized. */
export const HISTORY_LIMIT = 12;

const ACTOR_LABEL: Record<Actor, string> = {
  you: "you",
  owner: "the owner",
  partner: "a partner",
  editor: "a planner",
  viewer: "a viewer",
  someone: "someone",
};

/** " by you", " by a partner", or "" when nobody is known. Shared with the caterer count card. */
export const by = (actor: Actor | null) => (actor ? ` by ${ACTOR_LABEL[actor]}` : "");

const seats = (n: number) => (n === 1 ? "1 seat" : `${n} seats`);

/** "4 May 2027" in the wedding's zone. Bad input reads as "Unknown date" rather than throwing. */
export function historyDate(at: string, timeZone: string): string {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return "Unknown date";
  const { date } = instantToLocal(new Date(t), timeZone);
  return formatDateOnly(parseDateOnly(date), "en-GB", { dateStyle: "medium" });
}

const within = (at: string, from: string, to: string | null) => {
  const t = Date.parse(at);
  return t >= Date.parse(from) && (to === null || t <= Date.parse(to));
};

/** Releases counted per calendar day, oldest first. */
function releasesByDay(
  times: readonly string[],
  timeZone: string,
): { at: string; count: number }[] {
  const days = new Map<string, { at: string; count: number }>();
  for (const at of [...times].sort()) {
    const day = historyDate(at, timeZone);
    const entry = days.get(day);
    if (entry) entry.count += 1;
    else days.set(day, { at, count: 1 });
  }
  return [...days.values()];
}

function storedLines(row: StoredRow, input: HistoryInput): HistoryLine[] {
  const tz = input.timeZone;
  const lines: HistoryLine[] = [];
  const releases = input.audit
    .filter(
      (a) =>
        a.action === "seating.guest_released" &&
        a.entityId === row.eventId &&
        within(a.at, row.createdAt, row.resolvedAt),
    )
    .map((a) => a.at);
  const days = releasesByDay(releases, tz);
  if (days.length === 0) {
    // No audit rows readable: fall back to what the item row itself says.
    lines.push({
      at: row.createdAt,
      text: `${historyDate(row.createdAt, tz)}: opened, ${seats(row.occurrences)} released in all`,
    });
  } else {
    days.forEach((d, i) =>
      lines.push({
        at: d.at,
        text:
          i === 0
            ? `${historyDate(d.at, tz)}: opened, ${seats(d.count)} released`
            : `${historyDate(d.at, tz)}: ${d.count === 1 ? "1 more seat" : `${d.count} more seats`} released`,
      }),
    );
  }
  if (row.resolvedAt) {
    const handled = input.audit.find(
      (a) => a.action === "attention.handled" && a.entityId === row.id,
    );
    lines.push({
      at: row.resolvedAt,
      text:
        row.status === "refinalized"
          ? `${historyDate(row.resolvedAt, tz)}: closed when the plan was finalized again${by(row.resolvedBy)}`
          : `${historyDate(row.resolvedAt, tz)}: marked handled${by(handled?.actor ?? row.resolvedBy)}`,
    });
  }
  return lines;
}

/**
 * History for one item, newest first. For a stored item it covers this round and earlier closed
 * rounds for the same event. For a computed item it covers dismissals and restores, and says when a
 * dismissed item came back because it changed.
 */
export function itemHistory(item: AttentionItem, input: HistoryInput): HistoryLine[] {
  const tz = input.timeZone;
  let lines: HistoryLine[] = [];

  if (item.storedId !== null) {
    const rows = input.stored.filter((r) => r.eventId === item.eventId);
    for (const r of rows) {
      const own = storedLines(r, input);
      lines.push(
        ...(r.id === item.storedId
          ? own
          : own.map((l) => ({ at: l.at, text: `Earlier round, ${l.text}` }))),
      );
    }
  } else {
    for (const a of input.audit) {
      if (a.entityId !== item.subjectId || a.kind !== item.kind) continue;
      if (a.action === "attention.dismissed") {
        lines.push({ at: a.at, text: `${historyDate(a.at, tz)}: dismissed${by(a.actor)}` });
      } else if (a.action === "attention.restored") {
        lines.push({ at: a.at, text: `${historyDate(a.at, tz)}: shown again${by(a.actor)}` });
      }
    }
    const dismissal = input.dismissals.find(
      (d) => itemKey(d.kind as AttentionItem["kind"], d.subjectId) === item.key,
    );
    if (dismissal && dismissal.fingerprint !== item.fingerprint) {
      if (!lines.some((l) => l.at === dismissal.dismissedAt)) {
        lines.push({
          at: dismissal.dismissedAt,
          text: `${historyDate(dismissal.dismissedAt, tz)}: dismissed${by(dismissal.dismissedBy)}`,
        });
      }
      lines.push({
        at: dismissal.dismissedAt,
        text: "Back since then because it changed",
      });
    }
  }

  // Newest first; a tie keeps the order the lines were made in, read backwards.
  lines = lines
    .map((l, i) => ({ l, i }))
    .sort((a, b) => {
      const diff = (Date.parse(b.l.at) || 0) - (Date.parse(a.l.at) || 0);
      return diff !== 0 ? diff : b.i - a.i;
    })
    .map(({ l }) => l);
  if (lines.length > HISTORY_LIMIT) {
    const older = lines.length - (HISTORY_LIMIT - 1);
    lines = [
      ...lines.slice(0, HISTORY_LIMIT - 1),
      { at: "", text: `${older} older ${older === 1 ? "entry" : "entries"} not shown` },
    ];
  }
  return lines;
}

/** Turns a member's id into "you" or a role, so no name or email reaches the page. */
export function actorFor(
  userId: string | null,
  currentUserId: string,
  roles: ReadonlyMap<string, string>,
): Actor | null {
  if (!userId) return null;
  if (userId === currentUserId) return "you";
  const role = roles.get(userId);
  return role === "owner" || role === "partner" || role === "editor" || role === "viewer"
    ? role
    : "someone";
}
