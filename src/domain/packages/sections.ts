import type { BudgetSummary } from "@/domain/budget/summary";
import { formatDateOnly, isDateOnly } from "@/domain/dates/date-only";
import { EVENT_KIND_LABELS, type EventKind } from "@/domain/events/event";
import { formatMinor } from "@/domain/money/money";
import { categoryLabel } from "@/domain/candidates/categories";
import { stageLabel } from "@/domain/proposals/stages";
import { presetDef, sectionDef, type PackageRequest, type SectionId } from "./catalog";
import type { Block, DocSection, PackageDocument } from "./document";

/**
 * Turns already-authorized data into the document model. Every figure is computed from integer
 * minor units with the existing domain functions, unknowns stay unknown, and nothing here depends
 * on the clock, so equal data always gives an equal document (and an equal digest).
 *
 * Fields that are sensitive by default (contacts, private notes) are only added when the request
 * asks for them. Guest names, dietary details, links, files and prices never appear in any section.
 */

export type EventIn = {
  id: string;
  name: string;
  kind: string;
  localDate: string | null;
  targetAttendance: number | null;
  capacity: number | null;
};
export type AgendaIn = {
  eventId: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  timezone: string;
  cancelled: boolean;
  location: string | null;
  responsible: string | null;
  contact: string | null;
  notes: string | null;
};
export type VendorIn = {
  name: string;
  kind: "venue" | "vendor";
  category: string;
  stage: string;
  location: string | null;
};
export type PaymentsIn = {
  commitments: {
    id: string;
    title: string;
    amountMinor: number;
    status: "active" | "superseded" | "cancelled";
    signedOn: string | null;
  }[];
  /** Recorded, not voided. */
  payments: { commitmentId: string | null; kind: "charge" | "refund"; amountMinor: number }[];
  installments: {
    commitmentId: string;
    dueOn: string;
    amountMinor: number;
    label: string | null;
  }[];
};
export type RsvpIn = {
  eventId: string;
  invited: number;
  accepted: number;
  pending: number;
  declined: number;
  acceptedWithoutMeal: number;
  meals: { name: string; accepted: number }[];
};
/** The caterer count locked for an event (REL-08). Dates are date-only strings in the wedding's zone. */
export type GuaranteeIn = {
  eventId: string;
  count: number;
  lockedOn: string;
  dueOn: string | null;
  /** How many times the count has been revised since it was first locked. */
  revisions: number;
};
export type SeatingIn = {
  eventId: string;
  hasLayout: boolean;
  state: "none" | "current" | "stale";
  accepted: number;
  confirmedSeated: number;
  tentativeSeated: number;
  unassignedAccepted: number;
  tables: { label: string; capacity: number; confirmed: number; tentative: number; open: number }[];
};
export type BoardIn = {
  title: string;
  description: string | null;
  palette: string[];
  items: { kind: string; title: string; note: string | null }[];
};
export type DocumentIn = { title: string; kind: string; addedOn: string };
export type DecisionIn = {
  title: string;
  guestCount: number;
  chosen: string;
  decidedOn: string;
  inputsChanged: boolean;
};

export type ProjectionInput = {
  name: string;
  date: string | null;
  timezone: string;
  location: string | null;
  currency: string;
  targetGuestCount: number | null;
  events: EventIn[];
  timeline: AgendaIn[];
  vendors: VendorIn[];
  budget: BudgetSummary | null;
  payments: PaymentsIn | null;
  rsvp: RsvpIn[];
  guarantees: GuaranteeIn[];
  seating: SeatingIn[];
  boards: BoardIn[];
  documents: DocumentIn[];
  decisions: DecisionIn[];
};

const MAX_CELL = 400;
const clip = (s: string | null | undefined): string => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > MAX_CELL ? `${t.slice(0, MAX_CELL - 1)}…` : t;
};
const dash = (s: string | null | undefined): string => clip(s) || "—";
const plain = (text: string): Block => ({ type: "text", tone: "plain", text });
const note = (text: string): Block => ({ type: "text", tone: "note", text });
const caution = (text: string): Block => ({ type: "text", tone: "caution", text });
const empty = (text: string): Block[] => [plain(text)];
const num = (n: number | null): string => (n === null ? "Not set" : String(n));

const day = (d: string | null): string =>
  d && isDateOnly(d) ? formatDateOnly(d, "en-US", { dateStyle: "medium" }) : "Not set";

function table(
  caption: string,
  columns: string[],
  rows: string[][],
  right: readonly number[] = [],
): Block {
  return {
    type: "table",
    caption,
    columns,
    align: columns.map((_, i) => (right.includes(i) ? "right" : "left")),
    rows,
  };
}

function when(iso: string, zone: string, withZone: boolean): string {
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(withZone ? { timeZoneName: "short" } : {}),
  };
  try {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: zone }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      ...opts,
      timeZone: "UTC",
      timeZoneName: "short",
    }).format(new Date(iso));
  }
}
function endTime(iso: string, zone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: zone,
    }).format(new Date(iso));
  } catch {
    return "";
  }
}

const eventLabel = (e: EventIn) => EVENT_KIND_LABELS[e.kind as EventKind] ?? "Event";
const byEvent = (events: readonly EventIn[]) =>
  [...events].sort(
    (a, b) =>
      (a.localDate ?? "9999").localeCompare(b.localDate ?? "9999") ||
      a.name.localeCompare(b.name, "en") ||
      a.id.localeCompare(b.id),
  );

function overview(i: ProjectionInput): Block[] {
  return [
    {
      type: "facts",
      items: [
        { label: "Wedding", value: dash(i.name) },
        { label: "Date", value: day(i.date) },
        { label: "Place", value: dash(i.location) },
        { label: "Time zone", value: i.timezone },
        { label: "Currency", value: i.currency },
        { label: "Target guest count", value: num(i.targetGuestCount) },
      ],
    },
  ];
}

function events(i: ProjectionInput): Block[] {
  if (i.events.length === 0) return empty("No events have been added yet.");
  return [
    table(
      "Events",
      ["Event", "Type", "Date", "Target guests", "Venue capacity"],
      byEvent(i.events).map((e) => [
        clip(e.name),
        eventLabel(e),
        day(e.localDate),
        num(e.targetAttendance),
        num(e.capacity),
      ]),
      [3, 4],
    ),
  ];
}

function timeline(i: ProjectionInput, req: PackageRequest): Block[] {
  const blocks: Block[] = [];
  for (const ev of byEvent(i.events)) {
    const items = i.timeline
      .filter((t) => t.eventId === ev.id)
      .sort(
        (a, b) =>
          Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.title.localeCompare(b.title, "en"),
      );
    if (items.length === 0) continue;
    const columns = ["Time", "What", "Who", "Where"];
    if (req.options.includeContacts) columns.push("Contact");
    if (req.options.includeNotes) columns.push("Notes");
    blocks.push(
      table(
        `${clip(ev.name)}${ev.localDate ? ` · ${day(ev.localDate)}` : ""}`,
        columns,
        items.map((t) => {
          const span = t.endsAt
            ? `${when(t.startsAt, t.timezone, t.timezone !== i.timezone)} – ${endTime(t.endsAt, t.timezone)}`
            : when(t.startsAt, t.timezone, t.timezone !== i.timezone);
          const row = [
            span,
            `${t.cancelled ? "Cancelled: " : ""}${clip(t.title)}`,
            dash(t.responsible),
            dash(t.location),
          ];
          if (req.options.includeContacts) row.push(dash(t.contact));
          if (req.options.includeNotes) row.push(dash(t.notes));
          return row;
        }),
      ),
    );
  }
  if (blocks.length === 0) return empty("No agenda items have been added yet.");
  return [
    note(`Times are shown in each item's own time zone; the wedding zone is ${i.timezone}.`),
    ...blocks,
  ];
}

const STAGE_ORDER = ["booked", "considering", "proposal_received", "contacted", "saved"];

function vendors(i: ProjectionInput): Block[] {
  const active = i.vendors.filter((v) => STAGE_ORDER.includes(v.stage));
  const omitted = i.vendors.length - active.length;
  const sorted = [...active].sort(
    (a, b) =>
      STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage) ||
      a.category.localeCompare(b.category, "en") ||
      a.name.localeCompare(b.name, "en"),
  );
  const out: Block[] =
    sorted.length === 0
      ? empty("No venues or vendors are being considered yet.")
      : [
          table(
            "Venues and vendors",
            ["Name", "Type", "Stage", "Place"],
            sorted.map((v) => [
              clip(v.name),
              v.kind === "venue" ? "Venue" : categoryLabel(v.category),
              stageLabel(v.stage),
              dash(v.location),
            ]),
          ),
        ];
  if (omitted > 0) {
    out.push(
      note(
        `${omitted} passed or cancelled ${omitted === 1 ? "option is" : "options are"} not listed.`,
      ),
    );
  }
  return out;
}

function budget(i: ProjectionInput): Block[] {
  const s = i.budget;
  if (!s) return empty("No budget has been set up yet.");
  const m = (n: number) => formatMinor(n, i.currency);
  const lower = s.incomplete ? "At least " : "";
  const blocks: Block[] = [
    {
      type: "facts",
      items: [
        { label: "Target", value: s.targetMinor === null ? "Not set" : m(s.targetMinor) },
        { label: "Committed (signed)", value: m(s.committedMinor) },
        { label: "Paid so far (recorded)", value: m(s.netPaidMinor) },
        { label: "Still owed on commitments", value: m(s.outstandingMinor) },
        { label: "Not yet committed (estimate)", value: `${lower}${m(s.uncommittedMinor)}` },
        s.reserveBp === null
          ? { label: "Contingency reserve", value: "Not set" }
          : { label: "Contingency reserve", value: m(s.reserveMinor) },
        { label: "Forecast", value: `${lower}${m(s.forecastMinor)}` },
        {
          label: "Headroom against target",
          value:
            s.headroomMinor === null
              ? "Not set"
              : `${lower ? "At most " : ""}${m(s.headroomMinor)}`,
        },
      ],
    },
  ];
  if (s.incomplete) {
    blocks.push(
      caution(
        `${s.unknownItemCount} ${s.unknownItemCount === 1 ? "item has" : "items have"} no estimate yet, so the forecast is a lower bound, not a total.`,
      ),
    );
  }
  if (s.overpaidMinor > 0) {
    blocks.push(caution(`Recorded payments exceed commitments by ${m(s.overpaidMinor)}.`));
  }
  if (s.categories.length > 0) {
    blocks.push(
      table(
        "By category",
        ["Category", "Target", "Committed", "Expected", "Forecast"],
        s.categories.map((c) => [
          clip(c.name),
          c.allocationMinor === null ? "Not set" : m(c.allocationMinor),
          m(c.committedMinor),
          m(c.expectedMinor),
          `${c.unknownItemCount > 0 ? "At least " : ""}${m(c.forecastMinor)}`,
        ]),
        [1, 2, 3, 4],
      ),
    );
  }
  blocks.push(
    note("Paid amounts are payments someone recorded here. They do not confirm that money moved."),
  );
  return blocks;
}

function payments(i: ProjectionInput): Block[] {
  const p = i.payments;
  if (!p) return empty("No bookings have been recorded yet.");
  const m = (n: number) => formatMinor(n, i.currency);
  const active = p.commitments
    .filter((c) => c.status === "active")
    .sort(
      (a, b) =>
        (a.signedOn ?? "9999").localeCompare(b.signedOn ?? "9999") ||
        a.title.localeCompare(b.title, "en") ||
        a.id.localeCompare(b.id),
    );
  const net = (id: string) =>
    p.payments
      .filter((x) => x.commitmentId === id)
      .reduce((sum, x) => sum + (x.kind === "charge" ? x.amountMinor : -x.amountMinor), 0);
  const blocks: Block[] = [];
  if (active.length === 0) blocks.push(...empty("No active bookings are recorded."));
  else {
    blocks.push(
      table(
        "Commitments",
        ["Booking", "Signed", "Amount", "Paid (recorded)", "Still owed"],
        active.map((c) => {
          const paid = net(c.id);
          return [
            clip(c.title),
            day(c.signedOn),
            m(c.amountMinor),
            m(paid),
            m(Math.max(0, c.amountMinor - paid)),
          ];
        }),
        [2, 3, 4],
      ),
    );
    const names = new Map(active.map((c) => [c.id, c.title]));
    const due = p.installments
      .filter((x) => names.has(x.commitmentId))
      .sort(
        (a, b) =>
          a.dueOn.localeCompare(b.dueOn) ||
          (names.get(a.commitmentId) ?? "").localeCompare(names.get(b.commitmentId) ?? "", "en") ||
          a.amountMinor - b.amountMinor,
      );
    if (due.length > 0) {
      blocks.push(
        table(
          "Scheduled installments",
          ["Due", "Booking", "For", "Amount"],
          due.map((x) => [
            day(x.dueOn),
            clip(names.get(x.commitmentId)),
            dash(x.label),
            m(x.amountMinor),
          ]),
          [3],
        ),
      );
      blocks.push(
        note(
          "Installments are a schedule. Whether one is paid depends on the recorded payments above.",
        ),
      );
    }
  }
  const other = p.commitments.length - active.length;
  if (other > 0) {
    blocks.push(
      note(
        `${other} replaced or cancelled ${other === 1 ? "booking is" : "bookings are"} not listed.`,
      ),
    );
  }
  return blocks;
}

function rsvp(i: ProjectionInput): Block[] {
  const rows = byEvent(i.events).flatMap((e) => {
    const r = i.rsvp.find((x) => x.eventId === e.id);
    return r ? [{ e, r }] : [];
  });
  const locked = byEvent(i.events).flatMap((e) => {
    const g = i.guarantees.find((x) => x.eventId === e.id);
    return g ? [{ e, g }] : [];
  });
  if (rows.length === 0 && locked.length === 0) {
    return empty("No guests have been invited to an event yet.");
  }
  const meals = rows.flatMap(({ e, r }) => [
    ...r.meals.map((x) => [clip(e.name), clip(x.name), String(x.accepted)]),
    ...(r.acceptedWithoutMeal > 0
      ? [[clip(e.name), "No choice yet", String(r.acceptedWithoutMeal)]]
      : []),
  ]);
  const blocks: Block[] = [];
  if (locked.length > 0) {
    // What the couple has told the caterer. It does not follow later replies.
    blocks.push(
      table(
        "Count for the caterer",
        ["Event", "Count", "Locked on", "Needed by", "Revisions"],
        locked.map(({ e, g }) => [
          clip(e.name),
          String(g.count),
          day(g.lockedOn),
          g.dueOn ? day(g.dueOn) : "—",
          String(g.revisions),
        ]),
        [1, 4],
      ),
    );
  }
  if (rows.length > 0) {
    blocks.push(
      table(
        "Responses by event",
        ["Event", "Invited", "Accepted", "Pending", "Declined"],
        rows.map(({ e, r }) => [
          clip(e.name),
          String(r.invited),
          String(r.accepted),
          String(r.pending),
          String(r.declined),
        ]),
        [1, 2, 3, 4],
      ),
    );
  }
  if (meals.length > 0) {
    blocks.push(table("Meal choices of accepted guests", ["Event", "Meal", "Guests"], meals, [2]));
  }
  blocks.push(
    note(
      locked.length > 0
        ? "The count for the caterer is the number the couple confirmed and is not changed by later replies. Responses and meal totals show replies as of this brief. Guest names, contacts and dietary details are not included."
        : "Only accepted guests are counted in meal totals. Pending guests may still change the count. Guest names, contacts and dietary details are not included.",
    ),
  );
  return blocks;
}

function seating(i: ProjectionInput): Block[] {
  const blocks: Block[] = [];
  for (const e of byEvent(i.events)) {
    const s = i.seating.find((x) => x.eventId === e.id);
    if (!s) continue;
    if (!s.hasLayout || s.tables.length === 0) {
      blocks.push(plain(`${clip(e.name)}: no seating plan has been started.`));
      continue;
    }
    const state =
      s.state === "current"
        ? "Finalized and up to date"
        : s.state === "stale"
          ? "Finalized, but guests or seats changed since"
          : "Not finalized";
    blocks.push({
      type: "facts",
      items: [
        { label: clip(e.name), value: state },
        { label: "Accepted guests", value: String(s.accepted) },
        { label: "Seated (confirmed)", value: String(s.confirmedSeated) },
        { label: "Seated (tentative)", value: String(s.tentativeSeated) },
        { label: "Accepted, no seat yet", value: String(s.unassignedAccepted) },
      ],
    });
    blocks.push(
      table(
        `${clip(e.name)} tables`,
        ["Table", "Seats", "Confirmed", "Tentative", "Open"],
        s.tables.map((t) => [
          clip(t.label),
          String(t.capacity),
          String(t.confirmed),
          String(t.tentative),
          String(t.open),
        ]),
        [1, 2, 3, 4],
      ),
    );
  }
  if (blocks.length === 0) return empty("No seating plan has been started yet.");
  blocks.push(
    note(
      "Counts only. This is not a certified venue layout and does not confirm fire or access clearance.",
    ),
  );
  return blocks;
}

function design(i: ProjectionInput, req: PackageRequest): Block[] {
  if (i.boards.length === 0) return empty("No design boards have been started yet.");
  const blocks: Block[] = [];
  for (const b of [...i.boards].sort((a, c) => a.title.localeCompare(c.title, "en"))) {
    const facts = [
      { label: "Board", value: clip(b.title) },
      { label: "Palette", value: b.palette.length > 0 ? b.palette.join(", ") : "None chosen" },
    ];
    if (b.description) facts.push({ label: "About", value: clip(b.description) });
    blocks.push({ type: "facts", items: facts });
    if (b.items.length > 0) {
      const columns = req.options.includeNotes ? ["Type", "Title", "Note"] : ["Type", "Title"];
      blocks.push(
        table(
          `${clip(b.title)} items`,
          columns,
          b.items.map((x) => {
            const kind =
              x.kind === "image"
                ? "Image (not shown)"
                : x.kind === "link"
                  ? "Link (not shown)"
                  : "Note";
            return req.options.includeNotes
              ? [kind, clip(x.title), dash(x.note)]
              : [kind, clip(x.title)];
          }),
        ),
      );
    }
  }
  return blocks;
}

function documents(i: ProjectionInput): Block[] {
  if (i.documents.length === 0) return empty("No documents have been stored yet.");
  return [
    table(
      "Stored documents",
      ["Title", "Kind", "Added"],
      [...i.documents]
        .sort((a, b) => a.title.localeCompare(b.title, "en") || a.addedOn.localeCompare(b.addedOn))
        .map((d) => [clip(d.title), clip(d.kind.replaceAll("_", " ")), day(d.addedOn)]),
    ),
    note("This is an index. The files themselves are not included."),
  ];
}

function decisions(i: ProjectionInput): Block[] {
  if (i.decisions.length === 0) return empty("No comparison has a recorded decision yet.");
  return [
    table(
      "Decisions",
      ["Comparison", "For guests", "Chosen option", "Decided", "Inputs since"],
      [...i.decisions]
        .sort(
          (a, b) => a.decidedOn.localeCompare(b.decidedOn) || a.title.localeCompare(b.title, "en"),
        )
        .map((d) => [
          clip(d.title),
          String(d.guestCount),
          clip(d.chosen),
          day(d.decidedOn),
          d.inputsChanged ? "Changed" : "Unchanged",
        ]),
      [1],
    ),
    note("Choosing an option is not a booking. Bookings are listed under Bookings and payments."),
  ];
}

const BUILDERS: Record<SectionId, (i: ProjectionInput, r: PackageRequest) => Block[]> = {
  overview,
  events,
  timeline,
  vendors,
  budget,
  payments,
  rsvp,
  seating,
  design,
  documents,
  decisions,
};

export function buildDocument(req: PackageRequest, input: ProjectionInput): PackageDocument {
  const sections: DocSection[] = req.sections.map((id) => ({
    id,
    title: sectionDef(id).label,
    blocks: BUILDERS[id](input, req),
  }));
  return {
    title: req.title,
    recipient: req.recipient,
    presetLabel: presetDef(req.preset).label,
    weddingDate: input.date,
    sections,
  };
}
