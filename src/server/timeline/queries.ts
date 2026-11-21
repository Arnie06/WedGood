import "server-only";
import type { AgendaItem, TimelineStatus } from "@/domain/timeline/timeline";
import { sortAgenda } from "@/domain/timeline/timeline";
import { createUserClient } from "@/server/supabase/server";

export type TimelineRecord = AgendaItem & {
  eventId: string;
  location: string | null;
  contact: string | null;
  notes: string | null;
  version: number;
  createdAt: string;
};

const status = (v: string): TimelineStatus => (v === "cancelled" ? "cancelled" : "scheduled");

/** One event's agenda in chronological order. RLS limits rows to members of the workspace. */
export async function loadTimeline(
  workspaceId: string,
  eventId: string,
): Promise<TimelineRecord[]> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from("timeline_items")
    .select(
      "id, event_id, title, starts_at, ends_at, timezone, location, responsible_label, contact, notes, assignee_user_id, vendor_id, status, version, created_at",
    )
    .eq("wedding_id", workspaceId)
    .eq("event_id", eventId)
    .limit(500);
  if (error) throw new Error("Could not load the agenda");
  return sortAgenda(
    data.map((r) => ({
      id: r.id,
      eventId: r.event_id,
      title: r.title,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      timezone: r.timezone,
      location: r.location,
      responsibleLabel: r.responsible_label,
      contact: r.contact,
      notes: r.notes,
      assigneeUserId: r.assignee_user_id,
      vendorId: r.vendor_id,
      status: status(r.status),
      version: r.version,
      createdAt: r.created_at,
    })),
  );
}

/** Item counts per event, for the index page. */
export async function loadTimelineCounts(workspaceId: string): Promise<Map<string, number>> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from("timeline_items")
    .select("event_id")
    .eq("wedding_id", workspaceId)
    .limit(5000);
  if (error) throw new Error("Could not load the agenda");
  const counts = new Map<string, number>();
  for (const r of data) counts.set(r.event_id, (counts.get(r.event_id) ?? 0) + 1);
  return counts;
}

export type EventLabel = { id: string; name: string; kind: string; localDate: string | null };

/** Event names for agenda pages. Works for every member, unlike the manager-only events table. */
export async function loadEventLabels(workspaceId: string): Promise<EventLabel[]> {
  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc("list_event_labels", { p_wedding: workspaceId });
  if (error) throw new Error("Could not load events");
  return data.map((e) => ({ id: e.id, name: e.name, kind: e.kind, localDate: e.local_date }));
}

export type CalendarItem = {
  id: string;
  eventId: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  location: string | null;
  responsibleLabel: string | null;
  version: number;
};

/** Scheduled (not cancelled) agenda items across every event, for the calendar export. No contacts or notes. */
export async function loadCalendarItems(workspaceId: string): Promise<CalendarItem[]> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from("timeline_items")
    .select("id, event_id, title, starts_at, ends_at, location, responsible_label, version")
    .eq("wedding_id", workspaceId)
    .eq("status", "scheduled")
    .order("starts_at")
    .limit(2000);
  if (error) throw new Error("Could not load the agenda");
  return data.map((r) => ({
    id: r.id,
    eventId: r.event_id,
    title: r.title,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    location: r.location,
    responsibleLabel: r.responsible_label,
    version: r.version,
  }));
}
