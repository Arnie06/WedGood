import "server-only";
import { createUserClient } from "@/server/supabase/server";
import { isPlanningBasis, type PlanningBasis } from "@/domain/events/demand";
import type { EventKind } from "@/domain/events/event";
import type { RsvpStatus } from "@/domain/guests/rsvp";

export type EventRecord = {
  id: string;
  name: string;
  kind: EventKind;
  localDate: string | null;
  targetAttendance: number | null;
  capacity: number | null;
  planningBasis: PlanningBasis;
  planOpenPlusOnes: boolean;
  invitationsFinal: boolean;
  /** The event's own zone; null follows the wedding's. */
  timeZone: string | null;
  version: number;
};
export type MealOptionRecord = {
  id: string;
  eventId: string;
  name: string;
  active: boolean;
  version: number;
};
export type InvitationRecord = {
  id: string;
  eventId: string;
  householdId: string | null;
  label: string;
  plusOneQuota: number;
  plusOnesUsed: number;
  deadline: string | null;
  expiresAt: string;
  revokedAt: string | null;
  lastRespondedAt: string | null;
  deliveryStatus: "not_sent" | "shared_manually";
  deliveryMarkedAt: string | null;
  /** The party link (UX-06) this invitation was grouped into, live or not. */
  partyId: string | null;
  version: number;
};
export type MemberRecord = {
  id: string;
  invitationId: string;
  eventId: string;
  guestId: string;
  isPlusOne: boolean;
  active: boolean;
  status: RsvpStatus;
  mealOptionId: string | null;
};
/** One guest send (UX-08). Counts and a fingerprint only: never names, answers or note text. */
export type SubmissionRecord = {
  id: string;
  sendId: string;
  invitationId: string;
  partyId: string | null;
  submittedAt: string;
  formVersion: number;
  payloadHash: string;
  acceptedRevision: number;
  acceptedCount: number;
  declinedCount: number;
  plusOneAdded: boolean;
  plusOnesRemoved: number;
  detailsCount: number;
  /** True when the guest answered a published version of the couple's questions (UX-11). */
  customForm: boolean;
  /** People whose answers to the couple's questions changed in this send. */
  answersCount: number;
};
export type PartyRecord = {
  id: string;
  householdId: string | null;
  label: string;
  expiresAt: string;
  revokedAt: string | null;
  version: number;
};
export type EventData = {
  events: EventRecord[];
  mealOptions: MealOptionRecord[];
  invitations: InvitationRecord[];
  members: MemberRecord[];
  parties: PartyRecord[];
};

const KINDS: readonly string[] = [
  "ceremony",
  "reception",
  "rehearsal",
  "welcome",
  "brunch",
  "other",
];

type EventRow = {
  id: string;
  name: string;
  kind: string;
  local_date: string | null;
  target_attendance: number | null;
  capacity: number | null;
  planning_basis: string;
  plan_open_plus_ones: boolean;
  invitations_final: boolean;
  time_zone: string | null;
  version: number;
};
const EVENT_COLUMNS =
  "id, name, kind, local_date, target_attendance, capacity, planning_basis, plan_open_plus_ones, invitations_final, time_zone, version";

function mapEvent(e: EventRow): EventRecord {
  return {
    id: e.id,
    name: e.name,
    kind: (KINDS.includes(e.kind) ? e.kind : "other") as EventKind,
    localDate: e.local_date,
    targetAttendance: e.target_attendance,
    capacity: e.capacity,
    planningBasis: isPlanningBasis(e.planning_basis) ? e.planning_basis : "auto",
    planOpenPlusOnes: e.plan_open_plus_ones,
    invitationsFinal: e.invitations_final,
    timeZone: e.time_zone,
    version: e.version,
  };
}

/** Events only, for pages that do not need invitations. RLS limits rows to owner and partner. */
export async function loadEventRecords(workspaceId: string): Promise<EventRecord[]> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from("events")
    .select(EVENT_COLUMNS)
    .eq("wedding_id", workspaceId)
    .order("local_date", { nullsFirst: false })
    .order("name")
    .limit(50);
  if (error) throw new Error("Could not load events");
  return data.map(mapEvent);
}

const statusOf = (v: string): RsvpStatus => (v === "accepted" || v === "declined" ? v : "pending");

/** RLS limits these rows to owner and partner. Never selects token_hash. Pages also call requireWorkspace. */
export async function loadEventData(workspaceId: string): Promise<EventData> {
  const supabase = await createUserClient();
  const [events, meals, invitations, members, parties] = await Promise.all([
    supabase
      .from("events")
      .select(EVENT_COLUMNS)
      .eq("wedding_id", workspaceId)
      .order("local_date", { nullsFirst: false })
      .order("name")
      .limit(50),
    supabase
      .from("meal_options")
      .select("id, event_id, name, active, version")
      .eq("wedding_id", workspaceId)
      .order("created_at")
      .limit(500),
    supabase
      .from("invitations")
      .select(
        "id, event_id, household_id, label, plus_one_quota, plus_ones_used, deadline, expires_at, revoked_at, last_responded_at, delivery_status, delivery_marked_at, party_id, version",
      )
      .eq("wedding_id", workspaceId)
      .order("label")
      .limit(2500),
    supabase
      .from("invitation_members")
      .select(
        "id, invitation_id, event_id, guest_id, is_plus_one, active, rsvp_status, meal_option_id",
      )
      .eq("wedding_id", workspaceId)
      .limit(5000),
    supabase
      .from("invitation_parties")
      .select("id, household_id, label, expires_at, revoked_at, version")
      .eq("wedding_id", workspaceId)
      .order("created_at")
      .limit(2500),
  ]);
  if (events.error || meals.error || invitations.error || members.error || parties.error) {
    throw new Error("Could not load events");
  }
  return {
    events: events.data.map(mapEvent),
    mealOptions: meals.data.map((m) => ({
      id: m.id,
      eventId: m.event_id,
      name: m.name,
      active: m.active,
      version: m.version,
    })),
    invitations: invitations.data.map((i) => ({
      id: i.id,
      eventId: i.event_id,
      householdId: i.household_id,
      label: i.label,
      plusOneQuota: i.plus_one_quota,
      plusOnesUsed: i.plus_ones_used,
      deadline: i.deadline,
      expiresAt: i.expires_at,
      revokedAt: i.revoked_at,
      lastRespondedAt: i.last_responded_at,
      deliveryStatus: i.delivery_status === "shared_manually" ? "shared_manually" : "not_sent",
      deliveryMarkedAt: i.delivery_marked_at,
      partyId: i.party_id,
      version: i.version,
    })),
    members: members.data.map((m) => ({
      id: m.id,
      invitationId: m.invitation_id,
      eventId: m.event_id,
      guestId: m.guest_id,
      isPlusOne: m.is_plus_one,
      active: m.active,
      status: statusOf(m.rsvp_status),
      mealOptionId: m.meal_option_id,
    })),
    parties: parties.data.map((p) => ({
      id: p.id,
      householdId: p.household_id,
      label: p.label,
      expiresAt: p.expires_at,
      revokedAt: p.revoked_at,
      version: p.version,
    })),
  };
}

/**
 * Every recorded guest send, newest first, grouped by invitation. RLS limits the rows to owner and
 * partner; anyone else gets an empty map. Pages also call requireWorkspace.
 */
export async function loadInvitationSubmissions(
  workspaceId: string,
): Promise<Map<string, SubmissionRecord[]>> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from("rsvp_submissions")
    .select(
      "id, send_id, invitation_id, party_id, submitted_at, form_version, payload_hash, accepted_revision, accepted_count, declined_count, plus_one_added, plus_ones_removed, details_count, form_version_id, answers_count",
    )
    .eq("wedding_id", workspaceId)
    .order("submitted_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(2500);
  if (error) throw new Error("Could not load submissions");
  const byInvitation = new Map<string, SubmissionRecord[]>();
  for (const r of data) {
    const list = byInvitation.get(r.invitation_id) ?? [];
    list.push({
      id: r.id,
      sendId: r.send_id,
      invitationId: r.invitation_id,
      partyId: r.party_id,
      submittedAt: r.submitted_at,
      formVersion: r.form_version,
      payloadHash: r.payload_hash,
      acceptedRevision: r.accepted_revision,
      acceptedCount: r.accepted_count,
      declinedCount: r.declined_count,
      plusOneAdded: r.plus_one_added,
      plusOnesRemoved: r.plus_ones_removed,
      detailsCount: r.details_count,
      customForm: r.form_version_id !== null,
      answersCount: r.answers_count,
    });
    byInvitation.set(r.invitation_id, list);
  }
  return byInvitation;
}
