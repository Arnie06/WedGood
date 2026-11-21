/**
 * iCalendar (RFC 5545) export. Pure. Timed entries are written as UTC instants so every calendar
 * app shows the same moment; events with only a date become all-day entries. Nothing private
 * (contacts, notes, guest data) is accepted here, so it cannot leak into a downloaded file.
 */

export type IcsEntry =
  | {
      kind: "timed";
      uid: string;
      title: string;
      startsAt: string; // ISO instant
      endsAt: string | null;
      location: string | null;
      description: string | null;
      sequence: number;
    }
  | {
      kind: "allDay";
      uid: string;
      title: string;
      date: string; // YYYY-MM-DD
      description: string | null;
      sequence: number;
    };

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Escapes TEXT values: backslash, semicolon, comma, newlines; drops other control characters. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\r\n|\r|\n/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/** Folds a content line to 75 octets per line (continuations start with one space). */
export function foldIcsLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const lines: string[] = [];
  let current = "";
  let size = 0;
  for (const ch of line) {
    const bytes = encoder.encode(ch).length;
    const limit = lines.length === 0 ? 75 : 74; // continuation lines lose one octet to the space
    if (size + bytes > limit) {
      lines.push(current);
      current = ch;
      size = bytes;
    } else {
      current += ch;
      size += bytes;
    }
  }
  lines.push(current);
  return lines.join("\r\n ");
}

function utcStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error("Invalid instant");
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

function dateValue(date: string): { compact: string; next: string } {
  const m = DATE_ONLY.exec(date);
  if (!m) throw new Error("Invalid date");
  const utc = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (utc.toISOString().slice(0, 10) !== date) throw new Error("Invalid date");
  const next = new Date(utc.getTime() + 86_400_000).toISOString().slice(0, 10);
  return { compact: date.replace(/-/g, ""), next: next.replace(/-/g, "") };
}

export type IcsOptions = { calendarName: string; productId?: string; now: Date };

export function buildIcs(entries: readonly IcsEntry[], options: IcsOptions): string {
  const stamp = utcStamp(options.now.toISOString());
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${options.productId ?? "-//Wedding Workspace//Calendar export//EN"}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(options.calendarName)}`,
  ];
  for (const e of entries) {
    lines.push("BEGIN:VEVENT", `UID:${e.uid}`, `DTSTAMP:${stamp}`, `SEQUENCE:${e.sequence}`);
    if (e.kind === "allDay") {
      const d = dateValue(e.date);
      lines.push(`DTSTART;VALUE=DATE:${d.compact}`, `DTEND;VALUE=DATE:${d.next}`);
    } else {
      lines.push(`DTSTART:${utcStamp(e.startsAt)}`);
      if (e.endsAt) lines.push(`DTEND:${utcStamp(e.endsAt)}`);
      if (e.location) lines.push(`LOCATION:${escapeIcsText(e.location)}`);
    }
    lines.push(`SUMMARY:${escapeIcsText(e.title)}`);
    if (e.description) lines.push(`DESCRIPTION:${escapeIcsText(e.description)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}
