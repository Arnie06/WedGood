/**
 * Pulls a few plain-text facts out of a web page for a member to review (ADR-029).
 * This is parsing, not interpretation: page content is untrusted data, is never run
 * or followed as instructions, and nothing here invents prices, capacity, availability
 * or ratings. Output is text only, truncated, and safe to put in a form field.
 */
export type PageDetails = {
  name: string | null;
  location: string | null;
  phone: string | null;
  description: string | null;
  /** Lower-case host of the page, for "from example.com" labels. */
  host: string;
};

const LIMITS = { name: 160, location: 200, phone: 40, description: 500 } as const;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "—",
  hellip: "…",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code =
        body[1]?.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (
        !Number.isFinite(code) ||
        code < 32 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)
      )
        return " ";
      return String.fromCodePoint(code);
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Strips tags and control characters, decodes entities, collapses whitespace. */
export function toPlainText(raw: string, max: number): string | null {
  const noTags = raw.replace(/<[^>]*>/g, " ");
  const cleaned = decodeEntities(noTags).replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ");
  // Decoding can reintroduce angle brackets (&lt;b&gt;); plain text never contains them.
  const collapsed = cleaned.replace(/[<>]/g, " ").replace(/\s+/g, " ").trim();
  if (collapsed === "") return null;
  return collapsed.length > max ? `${collapsed.slice(0, max - 1).trimEnd()}…` : collapsed;
}

function metaContent(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const tag of html.match(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi) ?? []) {
    const key = /\b(?:property|name)\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const value = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const k = (key?.[1] ?? key?.[2])?.toLowerCase();
    const v = value?.[1] ?? value?.[2];
    if (k && v !== undefined && !out.has(k)) out.set(k, v);
  }
  return out;
}

type Json = unknown;

function* walk(node: Json, depth = 0): Generator<Record<string, unknown>> {
  if (depth > 6 || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node.slice(0, 50)) yield* walk(item, depth + 1);
    return;
  }
  const obj = node as Record<string, unknown>;
  yield obj;
  const graph = obj["@graph"];
  if (graph) yield* walk(graph, depth + 1);
}

const BUSINESS_TYPES =
  /LocalBusiness|Organization|EventVenue|Place|Restaurant|Hotel|LodgingBusiness|Store|Photographer|FoodEstablishment|ProfessionalService|CivicStructure|LandmarksOrHistoricalBuildings/i;

function typeMatches(value: unknown): boolean {
  const types = Array.isArray(value) ? value : [value];
  return types.some((t) => typeof t === "string" && BUSINESS_TYPES.test(t));
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function formatAddress(address: unknown): string | null {
  if (typeof address === "string") return address;
  if (address === null || typeof address !== "object") return null;
  const a = address as Record<string, unknown>;
  const parts = [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode]
    .map(str)
    .filter((p): p is string => p !== null && p.trim() !== "");
  return parts.length > 0 ? parts.join(", ") : null;
}

function fromJsonLd(html: string): {
  name: string | null;
  location: string | null;
  phone: string | null;
} {
  const found = {
    name: null as string | null,
    location: null as string | null,
    phone: null as string | null,
  };
  const blocks =
    html.match(
      /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    ) ?? [];
  for (const block of blocks.slice(0, 10)) {
    const body = block.replace(/^<script\b[^>]*>/i, "").replace(/<\/script>$/i, "");
    let parsed: Json;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    for (const obj of walk(parsed)) {
      if (!typeMatches(obj["@type"])) continue;
      found.name ??= str(obj.name);
      found.location ??= formatAddress(obj.address);
      found.phone ??= str(obj.telephone);
    }
  }
  return found;
}

/** "Garden House | Weddings in Napa" and similar: keep the part before the separator. */
function cleanTitle(title: string): string {
  const first = title.split(/\s[|–—·-]\s/)[0]?.trim();
  return first && first.length >= 2 ? first : title;
}

export function extractPageDetails(html: string, pageUrl: URL): PageDetails {
  const head = html.slice(0, 600_000);
  const meta = metaContent(head);
  const ld = fromJsonLd(head);
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];

  const nameRaw =
    ld.name ??
    meta.get("og:site_name") ??
    meta.get("og:title") ??
    (titleTag ? cleanTitle(toPlainText(titleTag, 300) ?? "") : null);
  const descRaw =
    meta.get("og:description") ??
    meta.get("description") ??
    meta.get("twitter:description") ??
    null;

  return {
    name: nameRaw ? toPlainText(nameRaw, LIMITS.name) : null,
    location: ld.location ? toPlainText(ld.location, LIMITS.location) : null,
    phone: ld.phone ? toPlainText(ld.phone, LIMITS.phone) : null,
    description: descRaw ? toPlainText(descRaw, LIMITS.description) : null,
    host: pageUrl.hostname.toLowerCase().replace(/^www\./, ""),
  };
}
