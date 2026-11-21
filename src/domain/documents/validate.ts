/**
 * Pure upload validation (docs/10-SECURITY.md "Storage and exports"). It decides from the bytes,
 * never from the file name or the browser-declared type. This is a type and size gate with a
 * heuristic active-content check for PDFs. It is NOT a malware scan, and nothing here may be
 * described as one.
 */

export const DOCUMENT_KINDS = ["contract", "receipt", "invoice", "proposal", "other"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
  contract: "Contract",
  receipt: "Receipt",
  invoice: "Invoice",
  proposal: "Proposal or quote",
  other: "Other",
};

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
export type DocumentMime = (typeof ALLOWED_MIME_TYPES)[number];

export function isDocumentKind(value: unknown): value is DocumentKind {
  return typeof value === "string" && (DOCUMENT_KINDS as readonly string[]).includes(value);
}

/** The type the bytes actually are, or null when they match no allowed signature. */
export function sniffMime(bytes: Uint8Array): DocumentMime | null {
  const at = (i: number) => bytes[i] ?? -1;
  if (at(0) === 0x25 && at(1) === 0x50 && at(2) === 0x44 && at(3) === 0x46 && at(4) === 0x2d) {
    return "application/pdf";
  }
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => at(i) === b)) {
    return "image/png";
  }
  if (
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

// Names that make a PDF do something on open. Compressed object streams can hide them, so this
// reduces risk but does not remove it.
const PDF_ACTIVE_CONTENT = /\/(JavaScript|JS|Launch|EmbeddedFile|RichMedia|XFA)(?![A-Za-z])/;

export type FileCheck = { ok: true; mime: DocumentMime } | { ok: false; reason: string };

export function validateFileBytes(bytes: Uint8Array, declaredMime: string): FileCheck {
  if (bytes.byteLength === 0) return { ok: false, reason: "The file is empty." };
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
    return { ok: false, reason: "The file is larger than 10 MB." };
  }
  const mime = sniffMime(bytes);
  if (mime === null) {
    return { ok: false, reason: "Only PDF, JPEG, PNG and WebP files are accepted." };
  }
  if (declaredMime !== "" && declaredMime !== mime) {
    return { ok: false, reason: "The file's contents don't match its type." };
  }
  if (mime === "application/pdf") {
    const text = new TextDecoder("latin1").decode(bytes);
    if (PDF_ACTIVE_CONTENT.test(text)) {
      return {
        ok: false,
        reason: "This PDF contains scripts or embedded files, which aren't accepted.",
      };
    }
  }
  return { ok: true, mime };
}

/** Display-only name: no path parts, control characters or markup-significant characters. */
export function sanitizeDisplayName(name: string): string | null {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f<>"|?*:]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") return null;
  return cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned;
}

export function defaultTitleFromName(name: string): string {
  const display = sanitizeDisplayName(name) ?? "";
  const dot = display.lastIndexOf(".");
  const stem = dot > 0 ? display.slice(0, dot) : display;
  return stem.slice(0, 160);
}

export type DocumentFormInput = { title: string; kind: DocumentKind };

export function parseDocumentMeta(raw: {
  title: string;
  kind: string;
}): { ok: true; value: DocumentFormInput } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const title = raw.title.trim();
  if (title === "") errors.title = "Give the document a name.";
  else if (title.length > 160) errors.title = "Keep the name to 160 characters or fewer.";
  if (!isDocumentKind(raw.kind)) errors.kind = "Choose what kind of document this is.";
  if (Object.keys(errors).length > 0 || !isDocumentKind(raw.kind)) return { ok: false, errors };
  return { ok: true, value: { title, kind: raw.kind } };
}

export type LinkTargetType = "commitment" | "payment" | "candidate" | "proposal";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parses a select value like "commitment:<uuid>". */
export function parseLinkTarget(value: string): { type: LinkTargetType; id: string } | null {
  const [type, id, ...rest] = value.split(":");
  if (rest.length > 0 || id === undefined || !UUID.test(id)) return null;
  if (type === "commitment" || type === "payment" || type === "candidate" || type === "proposal") {
    return { type, id };
  }
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
