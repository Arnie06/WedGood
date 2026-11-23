import { daysBetween, parseDateOnly, type DateOnly } from "@/domain/dates/date-only";
import { guaranteeDrift } from "@/domain/events/guarantee";
import { capacityFit, fitSentence, type EffectiveCapacity } from "@/domain/events/location";
import type { EventDemand } from "@/domain/events/demand";
import { formatMinor } from "@/domain/money/money";

/**
 * Needs attention (REL-10, ADR-031 D6). Pure and framework-free.
 *
 * Conditions are computed from the same facts every other page reads, each time. Nothing is stored
 * about them except a dismissal, and a dismissal only hides a condition while it looks the way it
 * did when it was dismissed (its fingerprint). The one stored kind, `seats_released`, is an event
 * that cannot be recomputed later, so the database keeps it.
 *
 * Who may see an item is decided by the caller, which only passes the facts a person may read; the
 * `canSeeGuestItems` flag repeats that rule here so a mistake in a caller cannot show reply data.
 */

export const ATTENTION_KINDS = [
  "over_capacity",
  "caterer_count",
  "meals_missing",
  "seats_missing",
  "seats_released",
  "venue_unused",
  "vendor_unassigned",
  "invoice_due",
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

/** Items built from replies or seating. Only owner and partner may see these. */
export const GUEST_KINDS: readonly AttentionKind[] = [
  "over_capacity",
  "caterer_count",
  "meals_missing",
  "seats_missing",
  "seats_released",
];

/** Kinds a person can dismiss: computed conditions. The stored kind is marked handled instead. */
export type DismissibleKind = Exclude<AttentionKind, "seats_released">;

export function isDismissibleKind(value: unknown): value is DismissibleKind {
  return (
    typeof value === "string" &&
    (ATTENTION_KINDS as readonly string[]).includes(value) &&
    value !== "seats_released"
  );
}

export type Severity = "action" | "check";

export const SEVERITY_LABELS: Record<Severity, string> = {
  action: "Action needed",
  check: "Check",
};

export type AttentionItem = {
  /** `${kind}:${subjectId}`, stable across reloads. */
  key: string;
  kind: AttentionKind;
  /** The event, venue, vendor or invoice this is about. */
  subjectId: string;
  /** The event it belongs to, for the Event page list. Null for venue, vendor and invoice items. */
  eventId: string | null;
  severity: Severity;
  title: string;
  /** What happened, as facts. */
  detail: string;
  /** The parts of the wedding this affects. */
  touches: string;
  /** What would sort it out. Nothing here does it for the couple. */
  fix: string;
  /** Path under the workspace, without a leading slash, such as `plan/events/<id>`. */
  path: string;
  cta: string;
  /** What the condition looked like. A dismissal only hides an item with the same fingerprint. */
  fingerprint: string;
  /** Set for the stored kind: the row to mark handled. */
  storedId: string | null;
};

// ---------------------------------------------------------------- inputs

export type EventFacts = {
  id: string;
  name: string;
  localDate: string | null;
  capacity: EffectiveCapacity;
  demand: EventDemand;
  /** True once the latest reply date on this event's invitations has passed. */
  replyDatePassed: boolean;
  /** The count told to the caterer, or null while none is locked. */
  lockedCount: number | null;
  /** The seating plan has been finalized at least once. */
  planFinalized: boolean;
};

export type StoredItemFacts = {
  id: string;
  eventId: string;
  eventName: string;
  occurrences: number;
};

export type VenueFacts = { id: string; name: string; booked: boolean; usedByEvent: boolean };
export type VendorFacts = { id: string; name: string; booked: boolean; worksAtEvent: boolean };
export type InvoiceFacts = {
  id: string;
  number: string | null;
  /** The booking the invoice is on, as the couple named it. */
  bookingTitle: string;
  currency: string;
  dueOn: string;
  /** What the invoice still asks for after the payments that name it. Zero when paid or void. */
  unpaidMinor: number;
};

export type AttentionInput = {
  today: DateOnly;
  /** Whether this person may see items built from replies and seating (owner and partner). */
  canSeeGuestItems: boolean;
  events: readonly EventFacts[];
  storedItems: readonly StoredItemFacts[];
  venues: readonly VenueFacts[];
  vendors: readonly VendorFacts[];
  invoices: readonly InvoiceFacts[];
  /** How many events exist. Venue and vendor items only make sense once there is an event to attach to. */
  eventCount: number;
};

/** How many days ahead an invoice counts as "due soon". */
export const INVOICE_SOON_DAYS = 7;

/** The parts of the wedding each kind affects, for the item drawer (UX-12). */
export const TOUCHES: Record<AttentionKind, string> = {
  over_capacity: "The event's place and capacity, and the guest list",
  caterer_count: "The count you gave the caterer and the catering estimate",
  meals_missing: "Meal totals for the caterer",
  seats_missing: "The finalized seating plan",
  seats_released: "The finalized seating plan, now out of date",
  venue_unused: "Events, capacity checks and the agenda",
  vendor_unassigned: "Event vendor lists and the day-of plan",
  invoice_due: "The budget and the booking's payments",
};

const guests = (n: number) => `${n} ${n === 1 ? "guest" : "guests"}`;

export function itemKey(kind: AttentionKind, subjectId: string): string {
  return `${kind}:${subjectId}`;
}

// ---------------------------------------------------------------- computing

export function computeAttention(input: AttentionInput): AttentionItem[] {
  const out: AttentionItem[] = [];
  const eventPath = (id: string) => `plan/events/${id}`;

  if (input.canSeeGuestItems) {
    for (const e of input.events) {
      const d = e.demand;
      const make = (
        kind: AttentionKind,
        severity: Severity,
        title: string,
        detail: string,
        fix: string,
        path: string,
        cta: string,
        fingerprint: string,
      ) =>
        out.push({
          key: itemKey(kind, e.id),
          kind,
          subjectId: e.id,
          eventId: e.id,
          severity,
          title,
          detail,
          touches: TOUCHES[kind],
          fix,
          path,
          cta,
          fingerprint,
          storedId: null,
        });

      // 1. The planning number is more than the room holds. Unknown capacity or count says nothing.
      const fit = capacityFit(d.invited > 0 ? d.planningNumber : null, e.capacity);
      if (fit.state === "short") {
        make(
          "over_capacity",
          "action",
          `${e.name}: more guests than the room holds`,
          `${fitSentence(fit)}.`,
          "Choose a bigger space, change the capacity if it is wrong, or review who is invited.",
          eventPath(e.id),
          "Open the event",
          `${fit.planning}|${fit.capacity}`,
        );
      }

      // 2. More are attending than the caterer was told. (A locked count above the attending
      //    number is money already committed and is shown on the event, not raised here.)
      if (e.lockedCount !== null) {
        const drift = guaranteeDrift(e.lockedCount, d.yes);
        if (drift.advise) {
          make(
            "caterer_count",
            "action",
            `${e.name}: more attending than the caterer was told`,
            `You told the caterer ${guests(e.lockedCount)} and ${d.yes} are attending now, ${drift.gap} more.`,
            "Revise the count if you want them to plan for everyone. The count you gave stays until you do.",
            eventPath(e.id),
            "Review the caterer count",
            `${e.lockedCount}|${d.yes}`,
          );
        }
      }

      // 3. Attending guests without a meal, after the reply date, when the event offers meals.
      if (e.replyDatePassed && d.yesWithoutMeal > 0 && d.meals.some((m) => m.active)) {
        make(
          "meals_missing",
          "action",
          `${e.name}: ${guests(d.yesWithoutMeal)} still without a meal`,
          `The reply date has passed and ${d.yesWithoutMeal} attending ${d.yesWithoutMeal === 1 ? "guest hasn't" : "guests haven't"} chosen a meal.`,
          "Ask them for their choice, or record it for them on the invitations page.",
          `guests/invitations#event-${e.id}`,
          "Open meal choices",
          String(d.yesWithoutMeal),
        );
      }

      // 4. A finalized seating plan with attending guests who have no seat.
      if (e.planFinalized && d.needSeat > 0) {
        make(
          "seats_missing",
          "check",
          `${e.name}: ${guests(d.needSeat)} without a seat`,
          `You finalized the seating plan, and ${d.needSeat} attending ${d.needSeat === 1 ? "guest has" : "guests have"} no seat on it.`,
          "Give them a seat on the plan, then finalize it again.",
          `seating/${e.id}`,
          "Open the seating plan",
          String(d.needSeat),
        );
      }
    }

    // Stored: seats released after the plan was finalized.
    for (const s of input.storedItems) {
      out.push({
        key: itemKey("seats_released", s.id),
        kind: "seats_released",
        subjectId: s.id,
        eventId: s.eventId,
        severity: "check",
        title: `${s.eventName}: ${s.occurrences === 1 ? "a seat was released" : `${s.occurrences} seats were released`}`,
        detail: `${s.occurrences === 1 ? "A guest lost their seat" : `${s.occurrences} guests lost their seats`} after you finalized the seating plan (a decline, a removal or an unlinked invitation).`,
        touches: TOUCHES.seats_released,
        fix: "Review the plan, then finalize it again. That closes this by itself.",
        path: `seating/${s.eventId}`,
        cta: "Open the seating plan",
        fingerprint: String(s.occurrences),
        storedId: s.id,
      });
    }
  }

  // Venues and vendors that are booked but tied to no event. Only once there is an event to tie to.
  if (input.eventCount > 0) {
    for (const v of input.venues) {
      if (!v.booked || v.usedByEvent) continue;
      out.push({
        key: itemKey("venue_unused", v.id),
        kind: "venue_unused",
        subjectId: v.id,
        eventId: null,
        severity: "check",
        title: `${v.name} is booked but no event uses it`,
        detail: "It is booked, and no event has it as its place.",
        touches: TOUCHES.venue_unused,
        fix: "Choose it as the place for an event so capacity and the agenda can use it, or dismiss this if it is for something else.",
        path: "plan/events",
        cta: "Open events",
        fingerprint: "open",
        storedId: null,
      });
    }
    for (const v of input.vendors) {
      if (!v.booked || v.worksAtEvent) continue;
      out.push({
        key: itemKey("vendor_unassigned", v.id),
        kind: "vendor_unassigned",
        subjectId: v.id,
        eventId: null,
        severity: "check",
        title: `${v.name} is booked but works at no event`,
        detail: "They are booked, and no event lists them.",
        touches: TOUCHES.vendor_unassigned,
        fix: "Assign them to the events they will work at so the day-of plan lists them, or dismiss this if it does not apply.",
        path: `discover/${v.id}`,
        cta: "Open the vendor",
        fingerprint: "open",
        storedId: null,
      });
    }
  }

  // Invoices past due, or due within a week, with something still to pay.
  for (const inv of input.invoices) {
    if (inv.unpaidMinor <= 0) continue;
    const days = daysBetween(input.today, parseDateOnly(inv.dueOn));
    if (days > INVOICE_SOON_DAYS) continue;
    const label = inv.number ? `Invoice ${inv.number}` : "An invoice";
    const owed = formatMinor(inv.unpaidMinor, inv.currency);
    const when =
      days < 0
        ? `${-days} ${days === -1 ? "day" : "days"} overdue`
        : days === 0
          ? "due today"
          : `due in ${days} ${days === 1 ? "day" : "days"}`;
    out.push({
      key: itemKey("invoice_due", inv.id),
      kind: "invoice_due",
      subjectId: inv.id,
      eventId: null,
      severity: days < 0 ? "action" : "check",
      title: `${label} for ${inv.bookingTitle} is ${when}`,
      detail: `${owed} still to pay.`,
      touches: TOUCHES.invoice_due,
      fix: "Once you have paid, record a payment that names the invoice. That clears this. Recording a payment does not move any money.",
      path: "plan/budget",
      cta: "Open the budget",
      fingerprint: `${inv.dueOn}|${inv.unpaidMinor}`,
      storedId: null,
    });
  }

  return sortAttention(out, input.events);
}

const KIND_ORDER: Record<AttentionKind, number> = Object.fromEntries(
  ATTENTION_KINDS.map((k, i) => [k, i]),
) as Record<AttentionKind, number>;

/** Action before check, then by event date (undated last), then kind, then key, so the order is stable. */
export function sortAttention(
  items: readonly AttentionItem[],
  events: readonly Pick<EventFacts, "id" | "localDate">[],
): AttentionItem[] {
  const dateOf = new Map(events.map((e) => [e.id, e.localDate ?? "9999-12-31"]));
  const rank = (s: Severity) => (s === "action" ? 0 : 1);
  return [...items].sort((a, b) => {
    if (rank(a.severity) !== rank(b.severity)) return rank(a.severity) - rank(b.severity);
    const da = (a.eventId && dateOf.get(a.eventId)) || "9999-12-31";
    const db = (b.eventId && dateOf.get(b.eventId)) || "9999-12-31";
    if (da !== db) return da < db ? -1 : 1;
    if (KIND_ORDER[a.kind] !== KIND_ORDER[b.kind]) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

// ---------------------------------------------------------------- dismissals

export type DismissalFacts = { kind: string; subjectId: string; fingerprint: string };

export type SplitAttention = { visible: AttentionItem[]; dismissed: AttentionItem[] };

/**
 * A dismissal hides an item only while its fingerprint matches. If the condition has changed (a new
 * capacity, more guests, a different amount) the item is shown again. Stored items are never
 * dismissed, only handled, so they ignore this list.
 */
export function applyDismissals(
  items: readonly AttentionItem[],
  dismissals: readonly DismissalFacts[],
): SplitAttention {
  const seen = new Map(
    dismissals.map((d) => [itemKey(d.kind as AttentionKind, d.subjectId), d.fingerprint]),
  );
  const visible: AttentionItem[] = [];
  const dismissed: AttentionItem[] = [];
  for (const item of items) {
    const fp = item.storedId === null ? seen.get(item.key) : undefined;
    if (fp !== undefined && fp === item.fingerprint) dismissed.push(item);
    else visible.push(item);
  }
  return { visible, dismissed };
}

export function forEvent(items: readonly AttentionItem[], eventId: string): AttentionItem[] {
  return items.filter((i) => i.eventId === eventId);
}

/** "3 things need you", "1 thing needs you", or the calm empty line. */
export function attentionSummary(count: number): string {
  if (count === 0) return "Nothing needs you right now.";
  return count === 1 ? "1 thing needs you." : `${count} things need you.`;
}
