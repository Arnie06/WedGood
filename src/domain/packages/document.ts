/**
 * The document model every package renderer receives (docs/11-EXPORTS-AND-OPERATIONS.md). It holds
 * only text that is already formatted and already redacted, so the preview, the PDF and the CSV
 * can never show a field the others do not. Pure and framework-free.
 */

export const TEMPLATE_VERSION = 1;

export type Align = "left" | "right";

export type Block =
  | { type: "facts"; items: { label: string; value: string }[] }
  | { type: "table"; caption: string; columns: string[]; align: Align[]; rows: string[][] }
  | { type: "text"; tone: "plain" | "note" | "caution"; text: string };

export type DocSection = { id: string; title: string; blocks: Block[] };

/** Everything that decides what the recipient reads. Timestamps and viewer identity are excluded. */
export type PackageDocument = {
  title: string;
  recipient: string;
  presetLabel: string;
  weddingDate: string | null;
  sections: DocSection[];
};

/** Stable JSON: object keys sorted, no whitespace. Equal content always gives equal text. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** The text a digest is computed over. The version keeps old digests distinct after a template change. */
export function digestInput(doc: PackageDocument): string {
  return canonicalJson({ v: TEMPLATE_VERSION, doc });
}

const MAX_JSON_BYTES = 1_000_000;

/** Narrow runtime check for a stored snapshot before it is rendered again. */
export function parseStoredDocument(value: unknown): PackageDocument | null {
  if (typeof value !== "object" || value === null) return null;
  const doc = value as Partial<PackageDocument>;
  if (
    typeof doc.title !== "string" ||
    typeof doc.recipient !== "string" ||
    typeof doc.presetLabel !== "string" ||
    !(doc.weddingDate === null || typeof doc.weddingDate === "string") ||
    !Array.isArray(doc.sections)
  ) {
    return null;
  }
  if (canonicalJson(value).length > MAX_JSON_BYTES) return null;
  for (const s of doc.sections as unknown[]) {
    const sec = s as Partial<DocSection>;
    if (
      typeof sec?.id !== "string" ||
      typeof sec.title !== "string" ||
      !Array.isArray(sec.blocks)
    ) {
      return null;
    }
    for (const b of sec.blocks as unknown[]) {
      const block = b as Block;
      if (block?.type === "facts") {
        if (!Array.isArray(block.items)) return null;
      } else if (block?.type === "table") {
        if (
          !Array.isArray(block.columns) ||
          !Array.isArray(block.rows) ||
          !Array.isArray(block.align)
        )
          return null;
        if (block.rows.some((r) => !Array.isArray(r) || r.length !== block.columns.length)) {
          return null;
        }
      } else if (block?.type === "text") {
        if (typeof block.text !== "string") return null;
      } else {
        return null;
      }
    }
  }
  return doc as PackageDocument;
}

/** Characters the built-in PDF fonts can show (Windows-1252). Anything else is replaced. */
const CP1252_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ".split("").map((c) => c.codePointAt(0)));

function isWinAnsi(code: number): boolean {
  return (
    code === 0x0a ||
    (code >= 0x20 && code <= 0x7e) ||
    (code >= 0xa0 && code <= 0xff) ||
    CP1252_EXTRA.has(code)
  );
}

/**
 * Makes text safe for the PDF's built-in fonts: tabs and line breaks become spaces, accents the
 * font lacks are dropped (Nguyễn becomes Nguyen), and anything else becomes "?". `replaced` counts
 * characters that changed meaning, so the preview can say so instead of silently altering names.
 */
export function toPdfText(input: string): { text: string; replaced: number } {
  let replaced = 0;
  let out = "";
  for (const ch of input.replace(/[\t\r\n]+/g, " ")) {
    const code = ch.codePointAt(0) ?? 0;
    if (isWinAnsi(code)) {
      out += ch;
      continue;
    }
    const base = ch.normalize("NFD").replace(/\p{M}+/gu, "");
    if (base.length > 0 && [...base].every((b) => isWinAnsi(b.codePointAt(0) ?? 0))) {
      out += base;
      replaced += 1;
      continue;
    }
    out += "?";
    replaced += 1;
  }
  return { text: out, replaced };
}

/** How many characters the PDF cannot show exactly. The CSV keeps them unchanged. */
export function countPdfReplacements(doc: PackageDocument): number {
  let total = 0;
  const add = (s: string) => {
    total += toPdfText(s).replaced;
  };
  add(doc.title);
  add(doc.recipient);
  for (const s of doc.sections) {
    add(s.title);
    for (const b of s.blocks) {
      if (b.type === "facts") b.items.forEach((i) => (add(i.label), add(i.value)));
      else if (b.type === "table") {
        add(b.caption);
        b.columns.forEach(add);
        b.rows.forEach((r) => r.forEach(add));
      } else add(b.text);
    }
  }
  return total;
}
