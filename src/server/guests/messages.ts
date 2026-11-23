import "server-only";
import { createHash } from "node:crypto";
import { effectiveEventZone, formatEventDate } from "@/domain/events/event";
import {
  planConfirmations,
  planReminders,
  type GuestMessageKind,
  type PlannedMessage,
} from "@/domain/guests/guest-mail";
import { zonedDay } from "@/features/events/reply-by";
import { loadEventData, loadInvitationSubmissions } from "@/server/events/queries";
import { loadGuests } from "@/server/guests/queries";
import { createUserClient } from "@/server/supabase/server";

export type GuestMessageStatus = "draft" | "sending" | "sent" | "failed" | "cancelled";

export type GuestMessageRecord = {
  id: string;
  eventId: string;
  invitationId: string;
  guestId: string;
  kind: GuestMessageKind;
  recipientEmail: string;
  subject: string;
  body: string;
  status: GuestMessageStatus;
  attempts: number;
  provider: string | null;
  lastError: string | null;
  createdAt: string;
  approvedAt: string | null;
  sendingSince: string | null;
  sentAt: string | null;
  version: number;
};

const KINDS = new Set<string>(["rsvp_confirmation", "reply_reminder"]);
const STATUSES = new Set<string>(["draft", "sending", "sent", "failed", "cancelled"]);

/**
 * One event's guest emails, newest first. RLS limits rows to people who manage guests; anyone else
 * gets an empty list. Pages also call requireWorkspace.
 */
export async function loadGuestMessages(
  workspaceId: string,
  eventId: string,
): Promise<GuestMessageRecord[]> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from("guest_messages")
    .select(
      "id, event_id, invitation_id, guest_id, kind, recipient_email, subject, body, status, attempts, provider, last_error, created_at, approved_at, sending_since, sent_at, version",
    )
    .eq("wedding_id", workspaceId)
    .eq("event_id", eventId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(500);
  if (error) throw new Error("Could not load guest emails");
  return data.flatMap((r): GuestMessageRecord[] =>
    KINDS.has(r.kind) && STATUSES.has(r.status)
      ? [
          {
            id: r.id,
            eventId: r.event_id,
            invitationId: r.invitation_id,
            guestId: r.guest_id,
            kind: r.kind as GuestMessageKind,
            recipientEmail: r.recipient_email,
            subject: r.subject,
            body: r.body,
            status: r.status as GuestMessageStatus,
            attempts: r.attempts,
            provider: r.provider,
            lastError: r.last_error,
            createdAt: r.created_at,
            approvedAt: r.approved_at,
            sendingSince: r.sending_since,
            sentAt: r.sent_at,
            version: r.version,
          },
        ]
      : [],
  );
}

/** sha256 hex, the same digest app_private.guest_message_state takes. */
export function replyStateHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The messages "prepare" would create for one event right now, from a single read of the replies.
 * Null when the event isn't in this workspace.
 */
export async function planEventMessages(
  workspaceId: string,
  eventId: string,
  kind: GuestMessageKind,
  wedding: { name: string; timezone: string },
  now: Date,
): Promise<PlannedMessage[] | null> {
  const [data, guestData, submissions] = await Promise.all([
    loadEventData(workspaceId),
    loadGuests(workspaceId),
    kind === "rsvp_confirmation" ? loadInvitationSubmissions(workspaceId) : null,
  ]);
  const event = data.events.find((e) => e.id === eventId);
  if (!event) return null;
  const zone = effectiveEventZone(event.timeZone, wedding.timezone);
  const meals = new Map(data.mealOptions.map((m) => [m.id, m.name]));
  const input = {
    ctx: {
      weddingName: wedding.name,
      eventName: event.name,
      eventDate: formatEventDate(event.localDate),
      replyBy: (iso: string) => zonedDay(iso, zone, null).date,
      mealName: (id: string) => meals.get(id) ?? null,
    },
    invitations: data.invitations.filter((i) => i.eventId === eventId),
    members: data.members.filter((m) => m.eventId === eventId),
    guests: guestData.guests,
    replied: new Set(submissions ? submissions.keys() : []),
    hash: replyStateHash,
    now,
  };
  return kind === "rsvp_confirmation" ? planConfirmations(input) : planReminders(input);
}
