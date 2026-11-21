/**
 * Pure design-board rules (docs/06 boards, docs/10 "Storage and exports"). Everything here decides
 * from the input alone; it never fetches a URL. A saved link is text the couple chose to keep and
 * is only ever shown as a plain outbound link.
 */
import { defaultTitleFromName, sanitizeDisplayName, sniffMime } from "@/domain/documents/validate";

export { defaultTitleFromName, sanitizeDisplayName };

export const MAX_PALETTE_COLORS = 8;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_URL_LENGTH = 2048;
export const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type ImageMime = (typeof IMAGE_MIME_TYPES)[number];

export const RIGHTS = ["own", "permission", "reference"] as const;
export type Rights = (typeof RIGHTS)[number];
export const RIGHTS_LABELS: Record<Rights, string> = {
  own: "I made or took this",
  permission: "I have permission to use it",
  reference: "Inspiration only, kept private",
};
export const RIGHTS_SHORT: Record<Rights, string> = {
  own: "Our own image",
  permission: "Used with permission",
  reference: "Inspiration only",
};

export function isRights(value: unknown): value is Rights {
  return typeof value === "string" && (RIGHTS as readonly string[]).includes(value);
}

export const ITEM_KINDS = ["image", "link", "note"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

// ---------------------------------------------------------------- palette
const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** "#abc" and "ABC" become "#aabbcc"; anything else is null. */
export function normalizeHex(value: string): string | null {
  const match = HEX.exec(value.trim());
  if (!match) return null;
  let digits = (match[1] ?? "").toLowerCase();
  if (digits.length === 3) digits = [...digits].map((d) => d + d).join("");
  return `#${digits}`;
}

export type PaletteResult =
  { ok: true; colors: string[] } | { ok: false; error: string; colors: string[] };

/** Accepts comma, space or newline separated hex colours; drops repeats; keeps first-seen order. */
export function parsePalette(raw: string): PaletteResult {
  const tokens = raw
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter((t) => t !== "");
  const colors: string[] = [];
  const bad: string[] = [];
  for (const token of tokens) {
    const hex = normalizeHex(token);
    if (hex === null) bad.push(token);
    else if (!colors.includes(hex)) colors.push(hex);
  }
  if (bad.length > 0) {
    const shown = bad.slice(0, 3).join(", ");
    return {
      ok: false,
      colors,
      error: `${shown} isn't a colour. Use hex codes like #D88C9A, separated by commas or spaces.`,
    };
  }
  if (colors.length > MAX_PALETTE_COLORS) {
    return {
      ok: false,
      colors,
      error: `Keep the palette to ${MAX_PALETTE_COLORS} colours or fewer.`,
    };
  }
  return { ok: true, colors };
}

/** Black or white, whichever reads better on the swatch (WCAG relative luminance). */
export function readableOn(hex: string): "#1b1c1a" | "#ffffff" {
  const n = Number.parseInt(hex.slice(1), 16);
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const l =
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255);
  // Compare contrast against near-black and white.
  const dark = (l + 0.05) / (0.0111 + 0.05);
  const light = 1.05 / (l + 0.05);
  return dark >= light ? "#1b1c1a" : "#ffffff";
}

// ---------------------------------------------------------------- links
export type UrlResult = { ok: true; url: string } | { ok: false; error: string };

/**
 * Only http(s) with a host, no embedded credentials, no whitespace. The URL is stored as the
 * browser would normalize it. It is never requested by the server.
 */
export function parseExternalUrl(raw: string): UrlResult {
  const text = raw.trim();
  if (text === "") return { ok: false, error: "Paste a link." };
  if (text.length > MAX_URL_LENGTH) return { ok: false, error: "That link is too long." };
  if (/\s/.test(text)) return { ok: false, error: "A link can't contain spaces." };
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, error: "That doesn't look like a web link." };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, error: "Only web links starting with http or https are accepted." };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, error: "Remove the username or password from the link." };
  }
  if (parsed.hostname === "" || !parsed.hostname.includes(".")) {
    return { ok: false, error: "That doesn't look like a web link." };
  }
  const href = parsed.href;
  if (href.length > MAX_URL_LENGTH || href.includes("@")) {
    return { ok: false, error: "Remove the @ sign and anything before it from the link." };
  }
  return { ok: true, url: href };
}

export function displayHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- images
export type ImageCheck = { ok: true; mime: ImageMime } | { ok: false; reason: string };

/** Decides from the bytes, never from the file name or the browser-declared type. */
export function validateImageBytes(bytes: Uint8Array, declaredMime: string): ImageCheck {
  if (bytes.byteLength === 0) return { ok: false, reason: "The file is empty." };
  if (bytes.byteLength > MAX_IMAGE_BYTES)
    return { ok: false, reason: "The image is larger than 5 MB." };
  const mime = sniffMime(bytes);
  if (mime === null || mime === "application/pdf") {
    return { ok: false, reason: "Only JPEG, PNG and WebP images are accepted." };
  }
  if (declaredMime !== "" && declaredMime !== mime) {
    return { ok: false, reason: "The file's contents don't match its type." };
  }
  return { ok: true, mime };
}

// ---------------------------------------------------------------- form input
export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string> };

export type BoardInput = { title: string; description: string | null; palette: string[] };

export function parseBoardInput(raw: {
  title: string;
  description: string;
  palette: string;
}): Parsed<BoardInput> {
  const errors: Record<string, string> = {};
  const title = raw.title.trim();
  if (title === "") errors.title = "Give the board a name.";
  else if (title.length > 120) errors.title = "Keep the name to 120 characters or fewer.";
  const description = raw.description.trim();
  if (description.length > 1000)
    errors.description = "Keep the description to 1,000 characters or fewer.";
  const palette = parsePalette(raw.palette);
  if (!palette.ok) errors.palette = palette.error;
  if (Object.keys(errors).length > 0 || !palette.ok) return { ok: false, errors };
  return {
    ok: true,
    value: { title, description: description === "" ? null : description, palette: palette.colors },
  };
}

export type ItemInput = {
  title: string;
  note: string | null;
  url: string | null;
  candidateId: string | null;
};

/** `needsUrl` is true for links. Notes and images never carry a URL. */
export function parseItemInput(
  raw: { title: string; note: string; url: string; candidate: string },
  needsUrl: boolean,
): Parsed<ItemInput> {
  const errors: Record<string, string> = {};
  const title = raw.title.trim();
  if (title === "") errors.title = "Give it a short title.";
  else if (title.length > 160) errors.title = "Keep the title to 160 characters or fewer.";
  const note = raw.note.trim();
  if (note.length > 1000) errors.note = "Keep the note to 1,000 characters or fewer.";
  let url: string | null = null;
  if (needsUrl) {
    const parsed = parseExternalUrl(raw.url);
    if (parsed.ok) url = parsed.url;
    else errors.url = parsed.error;
  }
  const candidate = raw.candidate.trim();
  if (candidate !== "" && !UUID.test(candidate))
    errors.candidate = "Choose a vendor from the list.";
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      title,
      note: note === "" ? null : note,
      url,
      candidateId: candidate === "" ? null : candidate,
    },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
