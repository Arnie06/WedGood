/**
 * Guest emails the couple can prepare and approve one at a time (UX-16). Pure: which people get a
 * message, the plain-text wording, and the dedupe key and reply fingerprint the database checks.
 *
 * What a message may contain: the wedding and event names, the event date, the reply-by date, the
 * names on the same invitation with their answer and chosen meal. Never: the RSVP link (raw tokens
 * are not stored), dietary or access notes, private notes, answers to the couple's questions,
 * addresses, or anyone outside the invitation.
 */

export type GuestMessageKind = "rsvp_confirmation" | "reply_reminder";

export type MailInvitation = {
  id: string;
  eventId: string;
  revokedAt: string | null;
  expiresAt: string;
  deadline: string | null;
};
export type MailMember = {
  invitationId: string;
  guestId: string;
  active: boolean;
  isPlusOne: boolean;
  status: "pending" | "accepted" | "declined";
  mealOptionId: string | null;
};
export type MailGuest = { id: string; fullName: string; email: string | null; archived: boolean };

export type MailContext = {
  weddingName: string;
  eventName: string;
  /** Long, readable event date, or null when the couple hasn't set one. */
  eventDate: string | null;
  /** Readable reply-by day in the event's zone, or null when there is no reply date. */
  replyBy: (deadlineIso: string) => string;
  mealName: (mealOptionId: string) => string | null;
};

export type PlannedMessage = {
  kind: GuestMessageKind;
  invitationId: string;
  guestId: string;
  dedupeKey: string;
  /** The canonical reply string; the server hashes it (same rule as the database). */
  stateText: string;
  stateHash: string;
  subject: string;
  body: string;
};

const SUBJECT_MAX = 200;
const BODY_MAX = 5000;

/** One line, no control characters, collapsed spaces, capped: safe as an email header value. */
export function cleanSubject(value: string): string {
  const s = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > SUBJECT_MAX ? `${s.slice(0, SUBJECT_MAX - 1)}…` : s;
}

/** Plain-text body: names collapsed to one line each, other control characters dropped, capped. */
function cleanLine(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function capBody(text: string): string {
  return text.length > BODY_MAX ? `${text.slice(0, BODY_MAX - 1)}…` : text;
}

/**
 * The invitation's reply fingerprint input: active people in guest id order,
 * "guestId:status:mealId" joined by commas. Must match app_private.guest_message_state.
 */
export function replyStateText(members: readonly MailMember[], invitationId: string): string {
  return members
    .filter((m) => m.invitationId === invitationId && m.active)
    .sort((a, b) => (a.guestId < b.guestId ? -1 : a.guestId > b.guestId ? 1 : 0))
    .map((m) => `${m.guestId}:${m.status}:${m.mealOptionId ?? ""}`)
    .join(",");
}

const ANSWER: Record<MailMember["status"], string> = {
  accepted: "attending",
  declined: "not attending",
  pending: "no answer yet",
};

export function confirmationText(
  ctx: MailContext,
  people: readonly { name: string; status: MailMember["status"]; meal: string | null }[],
  deadline: string | null,
): { subject: string; body: string } {
  const event = cleanLine(ctx.eventName);
  const lines = [
    "Hello,",
    "",
    `Thank you for replying to ${cleanLine(ctx.weddingName)}. This is what we have for ${event}${
      ctx.eventDate ? ` on ${ctx.eventDate}` : ""
    }:`,
    "",
    ...people.map(
      (p) =>
        `- ${cleanLine(p.name)}: ${ANSWER[p.status]}${
          p.status === "accepted" && p.meal ? `, ${cleanLine(p.meal)}` : ""
        }`,
    ),
    "",
    deadline
      ? `If anything is wrong, you can change your reply until the end of ${ctx.replyBy(deadline)} using the link in your invitation.`
      : "If anything is wrong, you can change your reply using the link in your invitation.",
    "",
    "Please don't reply to this email with changes; use your invitation link so we see them.",
  ];
  return {
    subject: cleanSubject(`Your reply for ${event} is saved`),
    body: capBody(lines.join("\n")),
  };
}

export function reminderText(
  ctx: MailContext,
  waitingFor: readonly string[],
  deadline: string | null,
): { subject: string; body: string } {
  const event = cleanLine(ctx.eventName);
  const names = waitingFor.map(cleanLine);
  const who =
    names.length <= 1
      ? (names[0] ?? "you")
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const lines = [
    "Hello,",
    "",
    `We'd love to know whether ${who} can join us for ${event}${
      ctx.eventDate ? ` on ${ctx.eventDate}` : ""
    }.`,
    "",
    deadline
      ? `Please reply by the end of ${ctx.replyBy(deadline)} using the link in your invitation.`
      : "Please reply using the link in your invitation.",
    "If you can't find it, let us know and we'll send it again.",
    "",
    `With love, ${cleanLine(ctx.weddingName)}`,
  ];
  return {
    subject: cleanSubject(
      deadline
        ? `Please reply for ${event} by ${ctx.replyBy(deadline)}`
        : `Please reply for ${event}`,
    ),
    body: capBody(lines.join("\n")),
  };
}

type PlanInput = {
  ctx: MailContext;
  invitations: readonly MailInvitation[];
  members: readonly MailMember[];
  guests: readonly MailGuest[];
  /** Invitations with at least one recorded guest send (confirmations only go to those). */
  replied: ReadonlySet<string>;
  /** sha256 hex of a state string; the server passes node:crypto, tests a stub. */
  hash: (text: string) => string;
  now: Date;
};

/** Recipients for one invitation: active, unarchived people with an address, one per address. */
function recipients(
  members: readonly MailMember[],
  guestById: ReadonlyMap<string, MailGuest>,
  filter: (m: MailMember) => boolean,
): { member: MailMember; guest: MailGuest & { email: string } }[] {
  const seen = new Set<string>();
  const out: { member: MailMember; guest: MailGuest & { email: string } }[] = [];
  for (const m of [...members].sort((a, b) => (a.guestId < b.guestId ? -1 : 1))) {
    const g = guestById.get(m.guestId);
    if (!m.active || !filter(m) || !g || g.archived || !g.email) continue;
    if (seen.has(g.email)) continue;
    seen.add(g.email);
    out.push({ member: m, guest: { ...g, email: g.email } });
  }
  return out;
}

const isOpen = (inv: MailInvitation, now: Date) =>
  inv.revokedAt === null &&
  new Date(inv.expiresAt).getTime() > now.getTime() &&
  (inv.deadline === null || new Date(inv.deadline).getTime() > now.getTime());

/**
 * One confirmation per address on every invitation of the event that a guest has replied to.
 * The key includes the reply fingerprint, so preparing again after nothing changed creates
 * nothing, and a later change to the replies gives a new draft.
 */
export function planConfirmations(input: PlanInput): PlannedMessage[] {
  const guestById = new Map(input.guests.map((g) => [g.id, g]));
  const out: PlannedMessage[] = [];
  for (const inv of input.invitations) {
    if (inv.revokedAt !== null || !input.replied.has(inv.id)) continue;
    const mine = input.members.filter((m) => m.invitationId === inv.id && m.active);
    if (!mine.some((m) => m.status !== "pending")) continue;
    const stateText = replyStateText(input.members, inv.id);
    const stateHash = input.hash(stateText);
    const people = [...mine]
      .sort((a, b) => Number(a.isPlusOne) - Number(b.isPlusOne))
      .map((m) => ({
        name: guestById.get(m.guestId)?.fullName ?? "Guest",
        status: m.status,
        meal: m.mealOptionId ? input.ctx.mealName(m.mealOptionId) : null,
      }));
    const text = confirmationText(
      input.ctx,
      people,
      inv.deadline && isOpen(inv, input.now) ? inv.deadline : null,
    );
    for (const r of recipients(mine, guestById, () => true)) {
      out.push({
        kind: "rsvp_confirmation",
        invitationId: inv.id,
        guestId: r.guest.id,
        dedupeKey: `confirm:${inv.id}:${stateHash.slice(0, 16)}:${r.guest.id}`,
        stateText,
        stateHash,
        ...text,
      });
    }
  }
  return out;
}

/** UTC calendar day, used to allow at most one reminder per person per day. */
const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/** One reminder per address among the people still waiting on each open invitation. */
export function planReminders(input: PlanInput): PlannedMessage[] {
  const guestById = new Map(input.guests.map((g) => [g.id, g]));
  const out: PlannedMessage[] = [];
  for (const inv of input.invitations) {
    if (!isOpen(inv, input.now)) continue;
    const mine = input.members.filter((m) => m.invitationId === inv.id && m.active);
    const waiting = mine.filter((m) => m.status === "pending");
    if (waiting.length === 0) continue;
    const stateText = replyStateText(input.members, inv.id);
    const stateHash = input.hash(stateText);
    const names = waiting.map((m) => guestById.get(m.guestId)?.fullName ?? "Guest");
    const text = reminderText(input.ctx, names, inv.deadline);
    for (const r of recipients(mine, guestById, (m) => m.status === "pending")) {
      out.push({
        kind: "reply_reminder",
        invitationId: inv.id,
        guestId: r.guest.id,
        dedupeKey: `remind:${inv.id}:${r.guest.id}:${utcDay(input.now)}`,
        stateText,
        stateHash,
        ...text,
      });
    }
  }
  return out;
}
