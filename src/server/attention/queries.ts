import "server-only";
import {
  applyDismissals,
  computeAttention,
  type AttentionItem,
  type EventFacts,
  type InvoiceFacts,
  type StoredItemFacts,
} from "@/domain/attention/attention";
import {
  actorFor,
  itemHistory,
  type AuditFact,
  type HistoryLine,
  type StoredRow,
} from "@/domain/attention/history";
import { todayInZone } from "@/domain/dates/date-only";
import { effectiveCapacity } from "@/domain/events/location";
import { invoiceRows } from "@/domain/ledger/invoices";
import { hasCapability, type WorkspaceAccess } from "@/server/auth/workspace-guard";
import { loadEventDemand } from "@/server/events/demand";
import { loadGuarantees } from "@/server/events/guarantee";
import { loadBookedVenueIds, loadEventLocations, loadVenueOptions } from "@/server/events/location";
import { loadEventRecords } from "@/server/events/queries";
import { loadReplyDeadlines } from "@/server/events/reply-dates";
import { loadEventVendorData } from "@/server/events/vendors";
import { createUserClient } from "@/server/supabase/server";
import { loadEventLabels } from "@/server/timeline/queries";

export type AttentionResult = {
  /** Items to show, most urgent first. */
  visible: AttentionItem[];
  /** Computed items an owner or partner has dismissed and that still look the same. */
  dismissed: AttentionItem[];
  /** Whether this person may dismiss and mark handled. */
  canAct: boolean;
};

/** The latest reply date set on each event's live invitations. */
async function loadLatestReplyDates(workspaceId: string): Promise<Map<string, number>> {
  const latest = new Map<string, number>();
  for (const [eventId, list] of await loadReplyDeadlines(workspaceId)) {
    for (const iso of list) {
      const t = Date.parse(iso);
      if (Number.isNaN(t)) continue;
      latest.set(eventId, Math.max(latest.get(eventId) ?? 0, t));
    }
  }
  return latest;
}

async function loadFinalizedEvents(workspaceId: string): Promise<Set<string>> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from("seating_layouts")
    .select("event_id, finalized_revision")
    .eq("wedding_id", workspaceId)
    .not("finalized_revision", "is", null)
    .limit(200);
  if (error) throw new Error("Could not load seating plans");
  return new Set(data.map((r) => r.event_id));
}

async function loadOpenStoredItems(
  workspaceId: string,
): Promise<{ id: string; eventId: string; occurrences: number }[]> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from("attention_items")
    .select("id, event_id, occurrences")
    .eq("wedding_id", workspaceId)
    .eq("status", "open")
    .limit(200);
  if (error) throw new Error("Could not load attention items");
  return data.map((r) => ({ id: r.id, eventId: r.event_id, occurrences: r.occurrences }));
}

async function loadDismissals(workspaceId: string) {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from("attention_dismissals")
    .select("kind, subject_id, fingerprint")
    .eq("wedding_id", workspaceId)
    .limit(500);
  if (error) throw new Error("Could not load dismissed items");
  return data.map((r) => ({ kind: r.kind, subjectId: r.subject_id, fingerprint: r.fingerprint }));
}

/** Invoices still owing and due, on bookings that are active. Visible to every member, like payments. */
async function loadInvoiceFacts(workspaceId: string, today: string): Promise<InvoiceFacts[]> {
  const supabase = await createUserClient();
  const [invoices, payments, bookings] = await Promise.all([
    supabase
      .from("invoices")
      .select(
        "id, commitment_id, number, amount_minor, issued_on, due_on, note, voided_at, void_reason",
      )
      .eq("wedding_id", workspaceId)
      .is("voided_at", null)
      .not("due_on", "is", null)
      .limit(2000),
    supabase
      .from("payments")
      .select("invoice_id, kind, amount_minor, voided_at")
      .eq("wedding_id", workspaceId)
      .not("invoice_id", "is", null)
      .limit(5000),
    supabase
      .from("commitments")
      .select("id, title, currency")
      .eq("wedding_id", workspaceId)
      .eq("status", "active")
      .limit(500),
  ]);
  if (invoices.error || payments.error || bookings.error) {
    throw new Error("Could not load invoices");
  }
  const booking = new Map(bookings.data.map((b) => [b.id, b]));
  const rows = invoiceRows(
    invoices.data
      .filter((i) => booking.has(i.commitment_id))
      .map((i) => ({
        id: i.id,
        commitmentId: i.commitment_id,
        number: i.number,
        amountMinor: i.amount_minor,
        issuedOn: i.issued_on,
        dueOn: i.due_on,
        note: i.note,
        voided: i.voided_at !== null,
        voidReason: i.void_reason,
      })),
    payments.data.map((p) => ({
      invoiceId: p.invoice_id,
      kind: p.kind === "refund" ? ("refund" as const) : ("charge" as const),
      amountMinor: p.amount_minor,
      voided: p.voided_at !== null,
    })),
    today,
  );
  return rows.flatMap((r) => {
    const b = booking.get(r.commitmentId);
    if (!b || r.dueOn === null || r.unpaidMinor <= 0) return [];
    return [
      {
        id: r.id,
        number: r.number,
        bookingTitle: b.title,
        currency: b.currency,
        dueOn: r.dueOn,
        unpaidMinor: r.unpaidMinor,
      },
    ];
  });
}

/**
 * Everything that needs the couple's attention, for Home, the Event page and the full list.
 *
 * Owner and partner see everything. Other members see only the items that carry no reply data
 * (venue, vendor, invoice): the reply-derived facts are never loaded for them, and the pure rules
 * also refuse them. The database gives the same answer through row security.
 */
export async function loadAttention(
  access: WorkspaceAccess,
  timezone: string,
): Promise<AttentionResult> {
  const wid = access.wedding.id;
  const canGuests = hasCapability(access, "guests.manage");
  const today = todayInZone(timezone);

  const [labels, locations, venues, bookedVenues, vendorData, invoices, dismissals] =
    await Promise.all([
      loadEventLabels(wid),
      loadEventLocations(wid),
      loadVenueOptions(wid),
      loadBookedVenueIds(wid),
      loadEventVendorData(wid),
      loadInvoiceFacts(wid, today),
      loadDismissals(wid),
    ]);

  const events: EventFacts[] = [];
  let storedItems: StoredItemFacts[] = [];
  if (canGuests) {
    const [records, demand, guarantees, replyDates, finalized, stored] = await Promise.all([
      loadEventRecords(wid),
      loadEventDemand(wid, { canManageGuests: true, shareGuestTotals: true }),
      loadGuarantees(wid),
      loadLatestReplyDates(wid),
      loadFinalizedEvents(wid),
      loadOpenStoredItems(wid),
    ]);
    const now = Date.now();
    for (const label of labels) {
      const record = records.find((r) => r.id === label.id);
      const d = demand.byEvent.get(label.id);
      if (!record || !d) continue;
      const place = locations.get(label.id) ?? null;
      const latest = replyDates.get(label.id);
      events.push({
        id: label.id,
        name: label.name,
        localDate: label.localDate,
        capacity: effectiveCapacity({
          eventCapacity: record.capacity,
          eventKind: label.kind,
          venue: place
            ? {
                seatedCapacity: place.venue.seatedCapacity,
                ceremonyCapacity: place.venue.ceremonyCapacity,
                archived: place.venue.archived,
              }
            : null,
          space: place?.space
            ? { seatedCapacity: place.space.seatedCapacity, archived: place.space.archived }
            : null,
        }),
        demand: d,
        replyDatePassed: latest !== undefined && latest < now,
        lockedCount: guarantees.get(label.id)?.current?.count ?? null,
        planFinalized: finalized.has(label.id),
      });
    }
    const nameOf = new Map(labels.map((l) => [l.id, l.name]));
    storedItems = stored.flatMap((s) => {
      const name = nameOf.get(s.eventId);
      return name
        ? [{ id: s.id, eventId: s.eventId, eventName: name, occurrences: s.occurrences }]
        : [];
    });
  }

  const usedVenueIds = new Set([...locations.values()].map((l) => l.venue.id));
  const items = computeAttention({
    today,
    canSeeGuestItems: canGuests,
    events,
    storedItems,
    eventCount: labels.length,
    venues: venues.map((v) => ({
      id: v.id,
      name: v.name,
      booked: bookedVenues.has(v.id),
      usedByEvent: usedVenueIds.has(v.id),
    })),
    vendors: vendorData.vendors
      .filter((v) => v.state === "current")
      .map((v) => ({
        id: v.id,
        name: v.name,
        booked: v.stage === "booked",
        worksAtEvent: (vendorData.byVendor.get(v.id) ?? []).length > 0,
      })),
    invoices,
  });
  const { visible, dismissed } = applyDismissals(items, dismissals);
  return { visible, dismissed, canAct: canGuests };
}

export type AttentionHistory = {
  /** History lines per item key, newest first. */
  byKey: Map<string, HistoryLine[]>;
  /** True when this person cannot read the activity record, so only part of the history shows. */
  partial: boolean;
};

const HISTORY_ACTIONS = [
  "seating.guest_released",
  "attention.handled",
  "attention.dismissed",
  "attention.restored",
] as const;

function isHistoryAction(value: string): value is AuditFact["action"] {
  return (HISTORY_ACTIONS as readonly string[]).includes(value);
}

function isStoredStatus(value: string): value is StoredRow["status"] {
  return value === "open" || value === "handled" || value === "refinalized";
}

/**
 * History for the item drawer (UX-12), read from rows that already exist: the stored items (open and
 * closed), the activity record and the dismissals. Row security decides what comes back; the
 * activity record is owner and partner only, so for anyone else the history is marked partial.
 * People are shown as "you" or by role.
 */
export async function loadAttentionHistory(
  access: WorkspaceAccess,
  items: readonly AttentionItem[],
  timezone: string,
): Promise<AttentionHistory> {
  const wid = access.wedding.id;
  const byKey = new Map<string, HistoryLine[]>();
  const partial = access.membership.role !== "owner" && access.membership.role !== "partner";
  if (items.length === 0) return { byKey, partial };

  const supabase = await createUserClient();
  const wantStored = items.some((i) => i.storedId !== null);
  const [members, stored, layouts, audit, dismissals] = await Promise.all([
    supabase.from("memberships").select("user_id, role").eq("wedding_id", wid).limit(200),
    wantStored
      ? supabase
          .from("attention_items")
          .select("id, event_id, status, occurrences, created_at, resolved_at, resolved_by")
          .eq("wedding_id", wid)
          .order("created_at", { ascending: false })
          .limit(200)
      : Promise.resolve({ data: [], error: null }),
    wantStored
      ? supabase.from("seating_layouts").select("id, event_id").eq("wedding_id", wid).limit(200)
      : Promise.resolve({ data: [], error: null }),
    partial
      ? Promise.resolve({ data: [], error: null })
      : supabase
          .from("audit_events")
          .select("entity_id, action, safe_changes, actor_id, occurred_at")
          .eq("wedding_id", wid)
          .in("action", [...HISTORY_ACTIONS])
          .order("occurred_at", { ascending: false })
          .limit(1000),
    supabase
      .from("attention_dismissals")
      .select("kind, subject_id, fingerprint, dismissed_at, dismissed_by")
      .eq("wedding_id", wid)
      .limit(500),
  ]);
  if (members.error || stored.error || layouts.error || audit.error || dismissals.error) {
    throw new Error("Could not load attention history");
  }

  const roles = new Map(members.data.map((m) => [m.user_id, m.role as string]));
  const who = (id: string | null) => actorFor(id, access.user.id, roles);
  const eventOfLayout = new Map(layouts.data.map((l) => [l.id, l.event_id]));

  const auditFacts: AuditFact[] = audit.data.flatMap((a) => {
    if (!isHistoryAction(a.action)) return [];
    const entityId =
      a.action === "seating.guest_released" ? eventOfLayout.get(a.entity_id) : a.entity_id;
    if (!entityId) return [];
    const changes = a.safe_changes;
    const kind =
      changes &&
      typeof changes === "object" &&
      !Array.isArray(changes) &&
      typeof changes.kind === "string"
        ? changes.kind
        : null;
    return [{ action: a.action, entityId, kind, at: a.occurred_at, actor: who(a.actor_id) }];
  });

  const input = {
    timeZone: timezone,
    stored: stored.data.flatMap((r): StoredRow[] =>
      isStoredStatus(r.status)
        ? [
            {
              id: r.id,
              eventId: r.event_id,
              status: r.status,
              occurrences: r.occurrences,
              createdAt: r.created_at,
              resolvedAt: r.resolved_at,
              resolvedBy: who(r.resolved_by),
            },
          ]
        : [],
    ),
    audit: auditFacts,
    dismissals: dismissals.data.map((d) => ({
      kind: d.kind,
      subjectId: d.subject_id,
      fingerprint: d.fingerprint,
      dismissedAt: d.dismissed_at,
      dismissedBy: who(d.dismissed_by),
    })),
  };
  for (const item of items) byKey.set(item.key, itemHistory(item, input));
  return { byKey, partial };
}
