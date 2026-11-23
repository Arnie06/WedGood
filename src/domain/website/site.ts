/**
 * Pure guest-website rules (docs/01 P11, docs/10 "Public website intentionally allowlisted").
 * The site is text only: no HTML, no images, https links. Everything here decides from the input
 * alone and never requests a URL. The database re-validates the same shape, so these limits must
 * stay in step with `app_private.site_draft_ok`.
 */

export const TEMPLATES = ["classic", "garden", "modern"] as const;
export type SiteTemplate = (typeof TEMPLATES)[number];
export const TEMPLATE_LABELS: Record<SiteTemplate, string> = {
  classic: "Classic: centred, serif and calm",
  garden: "Garden: soft colour and rounded sections",
  modern: "Modern: left-aligned and airy",
};
export function isTemplate(value: unknown): value is SiteTemplate {
  return typeof value === "string" && (TEMPLATES as readonly string[]).includes(value);
}

export const LIMITS = {
  title: 120,
  tagline: 200,
  location: 200,
  story: 3000,
  travel: 3000,
  faqCount: 10,
  faqQuestion: 200,
  faqAnswer: 1000,
  registryCount: 6,
  registryLabel: 80,
  url: 2048,
  eventCount: 12,
  eventWhen: 120,
  eventWhere: 200,
  eventNotes: 500,
} as const;

/** Fixed form slots (the editor shows this many rows; the stored limit is higher). */
export const FAQ_SLOTS = 6;
export const REGISTRY_SLOTS = 4;

export const VISIBILITIES = ["hidden", "public", "invited"] as const;
export type EventVisibility = (typeof VISIBILITIES)[number];
export const VISIBILITY_LABELS: Record<EventVisibility, string> = {
  hidden: "Not on the website",
  public: "Visible to everyone",
  invited: "Only guests invited to this event",
};

export type SiteEventEntry = {
  eventId: string;
  visibility: "public" | "invited";
  when?: string;
  where?: string;
  notes?: string;
};
export type SiteDraft = {
  template: SiteTemplate;
  title: string;
  tagline?: string;
  /** ISO date (YYYY-MM-DD), chosen deliberately for the website. */
  date?: string;
  location?: string;
  story?: string;
  travel?: string;
  faq: { q: string; a: string }[];
  registry: { label: string; url: string }[];
  events: SiteEventEntry[];
  /** UX-17: show hotels the couple marked for guests (copied from Lodging when publishing). */
  hotels?: boolean;
};

/** A hotel as published: no ids, and a nightly rate only where the couple chose to show it. */
export type PublicHotel = {
  name: string;
  address?: string;
  phone?: string;
  websiteUrl?: string;
  note?: string;
  blocks: {
    label?: string;
    checkIn: string;
    checkOut: string;
    bookBy?: string;
    bookingUrl?: string;
    bookingCode?: string;
    nightlyRateMinor?: number;
    currency?: string;
  }[];
};

/** What a visitor receives. No event ids, no workspace ids. */
export type PublicSite = {
  template: SiteTemplate;
  title: string;
  tagline?: string;
  date?: string;
  location?: string;
  story?: string;
  travel?: string;
  faq: { q: string; a: string }[];
  registry: { label: string; url: string }[];
  events: {
    name: string;
    kind: string;
    localDate?: string;
    visibility: "public" | "invited";
    when?: string;
    where?: string;
    notes?: string;
  }[];
  hotels?: PublicHotel[];
  invitation?: { label: string };
};

export function emptyDraft(title = ""): SiteDraft {
  return { template: "classic", title, faq: [], registry: [], events: [] };
}

// ---------------------------------------------------------------- text and links
// Matches the database check: everything but tab and newline is refused in free text.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Normalizes line endings and drops control characters; never alters visible characters. */
export function cleanText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(CONTROL, "").trim();
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export type UrlResult = { ok: true; url: string } | { ok: false; error: string };

/** Only https links to a real-looking host; no credentials, spaces or script schemes. */
export function parseHttpsUrl(raw: string): UrlResult {
  const text = raw.trim();
  if (text === "") return { ok: false, error: "Enter a link." };
  if (text.length > LIMITS.url) return { ok: false, error: "That link is too long." };
  if (/[\s\u0000-\u001f\u007f@]/.test(text)) {
    return { ok: false, error: "Links can't contain spaces or a username." };
  }
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, error: "Enter a full link starting with https://" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, error: "Links must start with https://" };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, error: "Links can't contain a username or password." };
  }
  const host = parsed.hostname.toLowerCase();
  if (!host.includes(".") || host.endsWith(".") || host === "localhost") {
    return { ok: false, error: "Enter a public website address." };
  }
  const normalized = parsed.toString();
  if (normalized.length > LIMITS.url || normalized.includes("@")) {
    return { ok: false, error: "That link can't be used." };
  }
  return { ok: true, url: normalized };
}

// ---------------------------------------------------------------- slug
export const RESERVED_SLUGS: readonly string[] = [
  "app",
  "api",
  "www",
  "admin",
  "rsvp",
  "invite",
  "sign-in",
  "sign-up",
  "preview",
  "design-system",
  "static",
  "assets",
];

export function normalizeSlug(raw: string): string {
  return raw.trim().toLowerCase();
}

export function validateSlug(
  raw: string,
): { ok: true; slug: string } | { ok: false; error: string } {
  const slug = normalizeSlug(raw);
  if (slug.length < 3 || slug.length > 40) {
    return { ok: false, error: "Use 3 to 40 characters." };
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    return { ok: false, error: "Use lowercase letters, numbers and single hyphens only." };
  }
  if (RESERVED_SLUGS.includes(slug)) return { ok: false, error: "That address is reserved." };
  return { ok: true, slug };
}

/** "Alex & Morgan" becomes "alex-morgan"; the owner can still edit it. */
export function suggestSlug(title: string): string {
  const base = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return base.length >= 3 ? base : "";
}

// ---------------------------------------------------------------- form parsing
export type SiteFormResult =
  { ok: true; draft: SiteDraft } | { ok: false; errors: Record<string, string> };

export const eventField = (eventId: string, name: "visibility" | "when" | "where" | "notes") =>
  `event_${eventId}_${name}`;

/**
 * Turns the editor's flat fields into a draft. Blank optional fields are omitted. `eventIds` are the
 * workspace's events, so a submitted field for any other id is ignored rather than trusted.
 */
export function parseSiteForm(
  fields: Readonly<Record<string, string>>,
  eventIds: readonly string[],
): SiteFormResult {
  const errors: Record<string, string> = {};
  const get = (name: string) => cleanText(fields[name] ?? "");

  const template = get("template");
  if (!isTemplate(template)) errors.template = "Choose a template.";

  const title = get("title");
  if (title === "") errors.title = "Add a title, such as your names.";
  else if (title.length > LIMITS.title) errors.title = `Use ${LIMITS.title} characters or fewer.`;

  const optional = (name: "tagline" | "location" | "story" | "travel"): string | undefined => {
    const value = get(name);
    if (value === "") return undefined;
    if (value.length > LIMITS[name]) {
      errors[name] = `Use ${LIMITS[name]} characters or fewer.`;
      return undefined;
    }
    return value;
  };
  const tagline = optional("tagline");
  const location = optional("location");
  const story = optional("story");
  const travel = optional("travel");

  let date: string | undefined;
  const rawDate = get("date");
  if (rawDate !== "") {
    if (isIsoDate(rawDate)) date = rawDate;
    else errors.date = "Enter a valid date.";
  }

  const faq: SiteDraft["faq"] = [];
  for (let i = 0; i < FAQ_SLOTS; i += 1) {
    const q = get(`faq_q_${i}`);
    const a = get(`faq_a_${i}`);
    if (q === "" && a === "") continue;
    if (q === "" || a === "") {
      errors[`faq_${i}`] = "Add both a question and an answer, or clear both.";
    } else if (q.length > LIMITS.faqQuestion || a.length > LIMITS.faqAnswer) {
      errors[`faq_${i}`] =
        `Keep questions under ${LIMITS.faqQuestion} and answers under ${LIMITS.faqAnswer} characters.`;
    } else {
      faq.push({ q, a });
    }
  }

  const registry: SiteDraft["registry"] = [];
  for (let i = 0; i < REGISTRY_SLOTS; i += 1) {
    const label = get(`reg_label_${i}`);
    const url = get(`reg_url_${i}`);
    if (label === "" && url === "") continue;
    if (label === "" || url === "") {
      errors[`reg_${i}`] = "Add both a name and a link, or clear both.";
      continue;
    }
    if (label.length > LIMITS.registryLabel) {
      errors[`reg_${i}`] = `Keep names under ${LIMITS.registryLabel} characters.`;
      continue;
    }
    const parsed = parseHttpsUrl(url);
    if (parsed.ok) registry.push({ label, url: parsed.url });
    else errors[`reg_${i}`] = parsed.error;
  }

  const events: SiteEventEntry[] = [];
  for (const id of eventIds.slice(0, LIMITS.eventCount)) {
    const visibility = get(eventField(id, "visibility")) || "hidden";
    if (!(VISIBILITIES as readonly string[]).includes(visibility)) {
      errors[`event_${id}`] = "Choose who can see this event.";
      continue;
    }
    if (visibility === "hidden") continue;
    const entry: SiteEventEntry = { eventId: id, visibility: visibility as "public" | "invited" };
    const limits = { when: LIMITS.eventWhen, where: LIMITS.eventWhere, notes: LIMITS.eventNotes };
    for (const key of ["when", "where", "notes"] as const) {
      const value = get(eventField(id, key));
      if (value === "") continue;
      if (value.length > limits[key]) {
        errors[`event_${id}`] = `Keep ${key} under ${limits[key]} characters.`;
      } else {
        entry[key] = value;
      }
    }
    events.push(entry);
  }

  const hotels = get("hotels") === "on";

  if (Object.keys(errors).length > 0 || !isTemplate(template)) return { ok: false, errors };
  return {
    ok: true,
    draft: {
      template,
      title,
      ...(tagline !== undefined && { tagline }),
      ...(date !== undefined && { date }),
      ...(location !== undefined && { location }),
      ...(story !== undefined && { story }),
      ...(travel !== undefined && { travel }),
      faq,
      registry,
      events,
      ...(hotels && { hotels: true }),
    },
  };
}

/** Reads a stored draft defensively; unknown shapes fall back to an empty draft. */
export function readDraft(value: unknown): SiteDraft {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return emptyDraft();
  const o = value as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);
  const list = (k: string): Record<string, unknown>[] =>
    Array.isArray(o[k])
      ? (o[k] as unknown[]).filter(
          (x): x is Record<string, unknown> => typeof x === "object" && x !== null,
        )
      : [];
  const text = (x: Record<string, unknown>, k: string) =>
    typeof x[k] === "string" ? (x[k] as string) : undefined;
  const template = o.template;
  const tagline = str("tagline");
  const date = str("date");
  const location = str("location");
  const story = str("story");
  const travel = str("travel");
  return {
    template: isTemplate(template) ? template : "classic",
    title: str("title") ?? "",
    ...(tagline !== undefined && { tagline }),
    ...(date !== undefined && { date }),
    ...(location !== undefined && { location }),
    ...(story !== undefined && { story }),
    ...(travel !== undefined && { travel }),
    faq: list("faq").flatMap((x) => {
      const q = text(x, "q");
      const a = text(x, "a");
      return q !== undefined && a !== undefined ? [{ q, a }] : [];
    }),
    registry: list("registry").flatMap((x) => {
      const label = text(x, "label");
      const url = text(x, "url");
      return label !== undefined && url !== undefined ? [{ label, url }] : [];
    }),
    events: list("events").flatMap((x) => {
      const eventId = text(x, "eventId");
      const visibility = x.visibility;
      if (eventId === undefined || (visibility !== "public" && visibility !== "invited")) return [];
      const when = text(x, "when");
      const where = text(x, "where");
      const notes = text(x, "notes");
      return [
        {
          eventId,
          visibility,
          ...(when !== undefined && { when }),
          ...(where !== undefined && { where }),
          ...(notes !== undefined && { notes }),
        },
      ];
    }),
    ...(o.hotels === true && { hotels: true }),
  };
}

export type PublicationState = "draft" | "published" | "published-with-changes" | "unpublished";

/** Draft-only sites are "draft"; a site that was published and then pulled is "unpublished". */
export function publicationState(site: {
  published: boolean;
  everPublished: boolean;
  draftRev: number;
  publishedDraftRev: number | null;
}): PublicationState {
  if (site.published) {
    return site.publishedDraftRev !== null && site.publishedDraftRev !== site.draftRev
      ? "published-with-changes"
      : "published";
  }
  return site.everPublished ? "unpublished" : "draft";
}

export function publicPath(slug: string): string {
  return `/w/${slug}`;
}
