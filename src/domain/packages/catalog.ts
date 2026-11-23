import type { Capability } from "@/domain/permissions";

/**
 * Package sections, presets and request validation (docs/11-EXPORTS-AND-OPERATIONS.md).
 * A preset is a starting selection, never a grant: every section still needs the actor's
 * capability, and the database re-checks the role. Pure and framework-free.
 */

export const SECTION_IDS = [
  "overview",
  "events",
  "timeline",
  "vendors",
  "budget",
  "payments",
  "rsvp",
  "seating",
  "design",
  "documents",
  "decisions",
] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export type SectionDef = {
  id: SectionId;
  label: string;
  description: string;
  /** Needed to include the section. Sections with no sensitive fields still need workspace access. */
  capability: Capability;
  /** Shown beside the option so people know what leaves the workspace. */
  shares: string;
};

export const SECTIONS: readonly SectionDef[] = [
  {
    id: "overview",
    label: "Overview",
    description: "Name, date, place, time zone and currency.",
    capability: "exports.create",
    shares: "Wedding name, date and place.",
  },
  {
    id: "events",
    label: "Events",
    description: "Each event with its date and target size.",
    capability: "exports.create",
    shares: "Event names, dates and sizes.",
  },
  {
    id: "timeline",
    label: "Schedule",
    description: "The agenda for each event, in order.",
    capability: "plan.edit",
    shares: "Agenda items and who is responsible. Contacts and notes only if you choose them.",
  },
  {
    id: "vendors",
    label: "Venues and vendors",
    description: "Who you are considering or have booked, by stage.",
    capability: "vendors.manage",
    shares: "Names, categories, stages and places. No prices, links or notes.",
  },
  {
    id: "budget",
    label: "Budget",
    description: "Target, planned, committed, paid and outstanding by category.",
    capability: "budget.manage",
    shares: "Your target and every category total.",
  },
  {
    id: "payments",
    label: "Bookings and payments",
    description: "Commitments, what you have recorded as paid, and installments due.",
    capability: "budget.manage",
    shares: "Vendor names, contract amounts, due dates and recorded payments.",
  },
  {
    id: "rsvp",
    label: "Guest counts and meals",
    description:
      "Invited, accepted, pending and declined, with meal totals and any locked caterer count.",
    capability: "guests.manage",
    shares:
      "Counts only, including the caterer count you locked. No guest names, contacts or dietary details.",
  },
  {
    id: "seating",
    label: "Seating overview",
    description: "Tables, seats filled and seats open for each event.",
    capability: "guests.manage",
    shares: "Table labels and counts only. No guest names.",
  },
  {
    id: "design",
    label: "Design boards",
    description: "Palettes and the notes and links you saved as titles.",
    capability: "design.view",
    shares: "Palette colours and item titles. No images, links or private notes.",
  },
  {
    id: "documents",
    label: "Documents index",
    description: "The titles and kinds of documents you have stored.",
    capability: "budget.manage",
    shares: "Titles and kinds only. Files are never included.",
  },
  {
    id: "decisions",
    label: "Decisions",
    description: "The option you chose in each comparison.",
    capability: "vendors.manage",
    shares: "Comparison titles, chosen option and decision date.",
  },
];

const BY_ID = new Map(SECTIONS.map((s) => [s.id, s]));

export function isSectionId(value: unknown): value is SectionId {
  return typeof value === "string" && BY_ID.has(value as SectionId);
}

export function sectionDef(id: SectionId): SectionDef {
  const def = BY_ID.get(id);
  if (!def) throw new Error(`Unknown section ${id}`);
  return def;
}

export const PRESET_IDS = [
  "master",
  "financial",
  "venue_comparison",
  "caterer",
  "coordinator",
  "custom",
] as const;
export type PresetId = (typeof PRESET_IDS)[number];

export type PresetDef = {
  id: PresetId;
  label: string;
  recipient: string;
  summary: string;
  sections: readonly SectionId[];
};

export const PRESETS: readonly PresetDef[] = [
  {
    id: "master",
    label: "Wedding book",
    recipient: "The couple",
    summary: "Your plan in one place, without guest details or contracts.",
    sections: [
      "overview",
      "events",
      "timeline",
      "vendors",
      "budget",
      "rsvp",
      "seating",
      "design",
      "documents",
      "decisions",
    ],
  },
  {
    id: "financial",
    label: "Financial report",
    recipient: "The couple",
    summary: "Budget, commitments, what is paid and what is still due.",
    sections: ["overview", "budget", "payments"],
  },
  {
    id: "venue_comparison",
    label: "Venue and vendor choices",
    recipient: "The couple or family",
    summary: "Who you are considering and what you decided.",
    sections: ["overview", "vendors", "decisions"],
  },
  {
    id: "caterer",
    label: "Caterer brief",
    recipient: "Caterer",
    summary:
      "Events, headcount, meal totals and your locked caterer count. No names or dietary details.",
    sections: ["overview", "events", "timeline", "rsvp"],
  },
  {
    id: "coordinator",
    label: "Coordinator handoff",
    recipient: "Coordinator",
    summary: "Schedule, vendors, headcount and table layout.",
    sections: ["overview", "events", "timeline", "vendors", "rsvp", "seating"],
  },
  {
    id: "custom",
    label: "Custom",
    recipient: "",
    summary: "Choose exactly which sections to include.",
    sections: ["overview"],
  },
];

export function isPresetId(value: unknown): value is PresetId {
  return typeof value === "string" && (PRESET_IDS as readonly string[]).includes(value);
}

export function presetDef(id: PresetId): PresetDef {
  const def = PRESETS.find((p) => p.id === id);
  if (!def) throw new Error(`Unknown preset ${id}`);
  return def;
}

export const FORMATS = ["pdf", "csv"] as const;
export type PackageFormat = (typeof FORMATS)[number];
export const PAPERS = ["a4", "letter"] as const;
export type Paper = (typeof PAPERS)[number];
export const ORIENTATIONS = ["portrait", "landscape"] as const;
export type Orientation = (typeof ORIENTATIONS)[number];

/** Redactions. Everything sensitive is off unless chosen. */
export type PackageOptions = { includeContacts: boolean; includeNotes: boolean };

export type PackageRequest = {
  title: string;
  preset: PresetId;
  recipient: string;
  sections: SectionId[];
  options: PackageOptions;
  formats: PackageFormat[];
  paper: Paper;
  orientation: Orientation;
};

export const MAX_TITLE = 120;
export const MAX_RECIPIENT = 80;

export type RequestField = "title" | "recipient" | "sections" | "formats";
export type RawRequest = {
  title?: string | null;
  preset?: string | null;
  recipient?: string | null;
  sections?: readonly string[] | null;
  includeContacts?: string | null;
  includeNotes?: string | null;
  formats?: readonly string[] | null;
  paper?: string | null;
  orientation?: string | null;
};

export type RequestParse =
  | { ok: true; value: PackageRequest }
  | { ok: false; errors: Partial<Record<RequestField, string>> };

const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/**
 * Validates a request and drops sections the actor may not include. Dropped ids are returned so
 * the page can say so; the actor can never widen the selection by editing the form.
 */
export function parsePackageRequest(
  raw: RawRequest,
  allowed: ReadonlySet<Capability>,
  fallbackTitle: string,
): RequestParse & { dropped: SectionId[] } {
  const errors: Partial<Record<RequestField, string>> = {};
  const preset: PresetId = isPresetId(raw.preset) ? raw.preset : "master";
  const def = presetDef(preset);
  const title = clean(raw.title) || `${fallbackTitle} · ${def.label}`;
  if (title.length > MAX_TITLE) errors.title = `Keep the title under ${MAX_TITLE + 1} characters.`;
  const recipient = clean(raw.recipient) || def.recipient;
  if (recipient.length > MAX_RECIPIENT) {
    errors.recipient = `Keep this under ${MAX_RECIPIENT + 1} characters.`;
  }

  const requested = raw.sections && raw.sections.length > 0 ? raw.sections : def.sections;
  const picked = new Set<SectionId>();
  const dropped: SectionId[] = [];
  for (const id of requested) {
    if (!isSectionId(id)) continue;
    if (allowed.has(sectionDef(id).capability)) picked.add(id);
    else dropped.push(id);
  }
  // Canonical order keeps the document, and therefore the digest, independent of click order.
  const sections = SECTION_IDS.filter((id) => picked.has(id));
  if (sections.length === 0) errors.sections = "Choose at least one section you can include.";

  const formats = FORMATS.filter((f) => (raw.formats ?? ["pdf"]).includes(f));
  if (formats.length === 0) errors.formats = "Choose PDF, CSV or both.";

  const paper = (PAPERS as readonly string[]).includes(raw.paper ?? "")
    ? (raw.paper as Paper)
    : "a4";
  const orientation = (ORIENTATIONS as readonly string[]).includes(raw.orientation ?? "")
    ? (raw.orientation as Orientation)
    : "portrait";

  if (Object.keys(errors).length > 0) return { ok: false, errors, dropped };
  return {
    ok: true,
    dropped,
    value: {
      title,
      preset,
      recipient,
      sections,
      options: {
        includeContacts: raw.includeContacts === "on" || raw.includeContacts === "true",
        includeNotes: raw.includeNotes === "on" || raw.includeNotes === "true",
      },
      formats,
      paper,
      orientation,
    },
  };
}
