/**
 * Pure CSV reading and writing for guest lists (docs/10-SECURITY.md "Storage and exports").
 * Reading follows RFC 4180 (quotes, doubled quotes, embedded newlines) and tolerates a BOM and
 * the delimiters spreadsheets commonly emit. Writing neutralizes spreadsheet formulas.
 */

export const MAX_CSV_BYTES = 256 * 1024;
export const MAX_CSV_ROWS = 500;
const MAX_COLUMNS = 40;
const MAX_CELL_CHARS = 2000;

export type CsvParseResult =
  | { ok: true; delimiter: string; headers: string[]; rows: string[][] }
  | { ok: false; error: string };

function detectDelimiter(firstLine: string): string {
  let best = ",";
  let bestCount = 0;
  for (const d of [",", ";", "\t"]) {
    // Count delimiters outside quotes.
    let inQuotes = false;
    let count = 0;
    for (const ch of firstLine) {
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === d && !inQuotes) count++;
    }
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/** Splits CSV text into a header row and data rows. Blank lines are dropped. */
export function parseCsv(input: string): CsvParseResult {
  if (new TextEncoder().encode(input).length > MAX_CSV_BYTES) {
    return { ok: false, error: "That file is larger than 256 KB. Split it into smaller files." };
  }
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (text.includes("\u0000")) {
    return { ok: false, error: "That doesn't look like a CSV text file." };
  }
  const firstLine = text.split(/\r\n|\n|\r/, 1)[0] ?? "";
  const delimiter = detectDelimiter(firstLine);

  const records: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let sawAny = false;
  const endCell = () => {
    row.push(cell);
    cell = "";
  };
  const endRow = () => {
    endCell();
    if (row.some((c) => c.trim() !== "")) records.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    sawAny = true;
    if (inQuotes) {
      if (ch === '"') {
        if (text.charAt(i + 1) === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") {
      inQuotes = true;
    } else if (ch === delimiter) {
      endCell();
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text.charAt(i + 1) === "\n") i++;
      endRow();
    } else cell += ch;
    if (cell.length > MAX_CELL_CHARS) {
      return { ok: false, error: "A cell in this file is unusually long. Check the file." };
    }
  }
  if (inQuotes) return { ok: false, error: "A quoted value is never closed. Check the file." };
  if (sawAny && (cell !== "" || row.length > 0)) endRow();

  const [header, ...rows] = records;
  if (!header) return { ok: false, error: "The file is empty." };
  if (header.length > MAX_COLUMNS) return { ok: false, error: "That file has too many columns." };
  if (rows.length === 0) return { ok: false, error: "The file has a header but no guests." };
  if (rows.length > MAX_CSV_ROWS) {
    return { ok: false, error: `Import up to ${MAX_CSV_ROWS} guests at a time.` };
  }
  const headers = header.map((h) => h.trim());
  // Rows are normalized to the header width; extra cells beyond it are ignored.
  return {
    ok: true,
    delimiter,
    headers,
    rows: rows.map((r) => headers.map((_, i) => r[i] ?? "")),
  };
}

/**
 * Neutralizes a text cell for spreadsheets: a value that could start a formula (leading =, +, -,
 * @, tab, carriage return, or those after whitespace) gets a leading apostrophe so Excel, Sheets
 * and Numbers show it as text. Use only for text columns; trusted numeric fields stay numeric.
 */
export function sanitizeCsvCell(value: string): string {
  return /^[\s]*[=+\-@\t\r]/.test(value) || /^[\t\r]/.test(value) ? `'${value}` : value;
}

function quote(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Serializes rows of text cells (all sanitized) as CSV with CRLF line ends. */
export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((r) => r.map((c) => quote(sanitizeCsvCell(c))).join(",")).join("\r\n") + "\r\n";
}
