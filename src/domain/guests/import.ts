/**
 * Pure guest input normalization, CSV column mapping, validation and duplicate detection
 * (docs/07-DOMAIN-RULES.md "Invitations and guests"). The same validation backs manual entry and
 * import so the rules live in one place; the database re-checks every limit.
 *
 * Guests are identified by id, never by name. Matching on name or email only ever produces a
 * "possible duplicate" the user decides on; it never silently merges or drops a person.
 */

export const IMPORT_FIELDS = [
  "fullName",
  "firstName",
  "lastName",
  "email",
  "phone",
  "household",
  "tags",
  "ageGroup",
  "dietary",
  "accessibility",
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export const IMPORT_FIELD_LABELS: Record<ImportField, string> = {
  fullName: "Full name",
  firstName: "First name",
  lastName: "Last name",
  email: "Email",
  phone: "Phone",
  household: "Household",
  tags: "Tags",
  ageGroup: "Adult or child",
  dietary: "Dietary needs or allergies (private)",
  accessibility: "Accessibility needs (private)",
};

/** Column index per field; absent means "don't import". */
export type ColumnMapping = Partial<Record<ImportField, number>>;

export const GUEST_LIMITS = {
  name: 120,
  email: 254,
  household: 120,
  tag: 30,
  tags: 10,
  privateText: 500,
  maxActiveGuests: 2000,
} as const;

export type AgeGroup = "adult" | "child";

export type GuestInput = {
  fullName: string;
  email: string | null;
  phone: string | null;
  household: string | null;
  tags: string[];
  ageGroup: AgeGroup | null;
  dietary: string | null;
  accessibility: string | null;
};

// Strips control characters except tab/newline and collapses runs of spaces on one line.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
export function cleanLine(value: string): string {
  return value.replace(CONTROL, "").replace(/\s+/g, " ").trim();
}
export function cleanBlock(value: string): string {
  return value
    .replace(CONTROL, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

const EMAIL = /^[^\s@<>()\\,;:"]+@[^\s@<>()\\,;:"]+\.[^\s@<>()\\,;:"]{2,}$/;
const PHONE = /^\+?[\d\s().-]{7,30}$/;

export function normalizeAgeGroup(value: string): AgeGroup | null | "invalid" {
  const v = cleanLine(value).toLowerCase();
  if (v === "") return null;
  if (["adult", "adults", "a", "grown-up", "grownup", "over 18", "18+"].includes(v)) return "adult";
  if (["child", "children", "kid", "kids", "c", "minor", "under 18"].includes(v)) return "child";
  return "invalid";
}

export function splitTags(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of value.split(/[;,|]/)) {
    const t = cleanLine(part);
    if (t !== "" && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out;
}

export type RawGuest = {
  fullName?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  household?: string;
  tags?: string;
  ageGroup?: string;
  dietary?: string;
  accessibility?: string;
};
export type GuestErrors = Partial<Record<ImportField, string>>;

export function validateGuest(
  raw: RawGuest,
): { ok: true; guest: GuestInput } | { ok: false; errors: GuestErrors } {
  const errors: GuestErrors = {};
  const fullName =
    cleanLine(raw.fullName ?? "") || cleanLine(`${raw.firstName ?? ""} ${raw.lastName ?? ""}`);
  if (fullName === "") errors.fullName = "Add a name.";
  else if (fullName.length > GUEST_LIMITS.name) {
    errors.fullName = `Use ${GUEST_LIMITS.name} characters or fewer.`;
  }

  const emailRaw = cleanLine(raw.email ?? "");
  let email: string | null = null;
  if (emailRaw !== "") {
    if (emailRaw.length > GUEST_LIMITS.email || !EMAIL.test(emailRaw)) {
      errors.email = "That email address doesn't look right.";
    } else email = emailRaw.toLowerCase();
  }

  const phoneRaw = cleanLine(raw.phone ?? "");
  let phone: string | null = null;
  if (phoneRaw !== "") {
    const digits = phoneRaw.replace(/\D/g, "").length;
    if (!PHONE.test(phoneRaw) || digits < 7 || digits > 15) {
      errors.phone = "That phone number doesn't look right.";
    } else phone = phoneRaw;
  }

  const householdRaw = cleanLine(raw.household ?? "");
  if (householdRaw.length > GUEST_LIMITS.household) {
    errors.household = `Use ${GUEST_LIMITS.household} characters or fewer.`;
  }

  const tags = splitTags(raw.tags ?? "");
  if (tags.length > GUEST_LIMITS.tags || tags.some((t) => t.length > GUEST_LIMITS.tag)) {
    errors.tags = `Use up to ${GUEST_LIMITS.tags} tags of ${GUEST_LIMITS.tag} characters or fewer.`;
  }

  const age = normalizeAgeGroup(raw.ageGroup ?? "");
  if (age === "invalid") errors.ageGroup = "Use adult or child, or leave blank.";

  const dietary = cleanBlock(raw.dietary ?? "");
  if (dietary.length > GUEST_LIMITS.privateText) {
    errors.dietary = `Use ${GUEST_LIMITS.privateText} characters or fewer.`;
  }
  const accessibility = cleanBlock(raw.accessibility ?? "");
  if (accessibility.length > GUEST_LIMITS.privateText) {
    errors.accessibility = `Use ${GUEST_LIMITS.privateText} characters or fewer.`;
  }

  if (Object.keys(errors).length > 0 || age === "invalid") return { ok: false, errors };
  return {
    ok: true,
    guest: {
      fullName,
      email,
      phone,
      household: householdRaw === "" ? null : householdRaw,
      tags,
      ageGroup: age,
      dietary: dietary === "" ? null : dietary,
      accessibility: accessibility === "" ? null : accessibility,
    },
  };
}

// ---------------------------------------------------------------- mapping

const HEADER_HINTS: Record<ImportField, readonly string[]> = {
  fullName: ["name", "full name", "guest", "guest name"],
  firstName: ["first name", "first", "given name", "forename"],
  lastName: ["last name", "last", "surname", "family name"],
  email: ["email", "e-mail", "email address"],
  phone: ["phone", "mobile", "cell", "telephone", "phone number"],
  household: ["household", "family", "party", "group", "invitation"],
  tags: ["tags", "tag", "side", "category", "labels"],
  ageGroup: ["age group", "age", "adult or child", "adult/child"],
  dietary: ["dietary", "diet", "allergies", "dietary needs", "dietary restrictions"],
  accessibility: ["accessibility", "access needs", "accessibility needs"],
};

const normHeader = (h: string) =>
  cleanLine(h).toLowerCase().replace(/[_*]/g, " ").replace(/\s+/g, " ").trim();

/** Suggests a mapping from header names. Each column is used at most once. */
export function guessMapping(headers: readonly string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const used = new Set<number>();
  const normalized = headers.map(normHeader);
  for (const field of IMPORT_FIELDS) {
    const idx = normalized.findIndex((h, i) => !used.has(i) && HEADER_HINTS[field].includes(h));
    if (idx >= 0) {
      mapping[field] = idx;
      used.add(idx);
    }
  }
  // "Name" plus separate first/last columns: prefer first+last.
  if (mapping.firstName !== undefined && mapping.lastName !== undefined) delete mapping.fullName;
  return mapping;
}

/** A mapping is usable if each column is chosen once and a name can be built. */
export function validateMapping(
  mapping: ColumnMapping,
  columnCount: number,
): { ok: true } | { ok: false; error: string } {
  const seen = new Set<number>();
  for (const field of IMPORT_FIELDS) {
    const idx = mapping[field];
    if (idx === undefined) continue;
    if (!Number.isInteger(idx) || idx < 0 || idx >= columnCount) {
      return { ok: false, error: "A chosen column doesn't exist in this file." };
    }
    if (seen.has(idx)) return { ok: false, error: "Each column can be used for one field only." };
    seen.add(idx);
  }
  if (
    mapping.fullName === undefined &&
    mapping.firstName === undefined &&
    mapping.lastName === undefined
  ) {
    return { ok: false, error: "Choose which column holds each guest's name." };
  }
  return { ok: true };
}

// ---------------------------------------------------------------- preview and duplicates

export type ExistingGuest = { fullName: string; email: string | null };

export function nameKey(name: string): string {
  return cleanLine(name)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

export type RowStatus = "ready" | "duplicate" | "invalid";
export type PreviewRow = {
  /** 1-based line in the spreadsheet, counting the header as line 1. */
  line: number;
  status: RowStatus;
  guest: GuestInput | null;
  errors: GuestErrors;
  /** Why a row is a possible duplicate. */
  duplicateOf: string | null;
};
export type ImportPreview = {
  rows: PreviewRow[];
  counts: { ready: number; duplicate: number; invalid: number };
};

export function buildPreview(
  rows: readonly (readonly string[])[],
  mapping: ColumnMapping,
  existing: readonly ExistingGuest[],
): ImportPreview {
  const byEmail = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const g of existing) {
    if (g.email) byEmail.set(g.email.toLowerCase(), "a guest already on your list");
    byName.set(nameKey(g.fullName), "a guest already on your list");
  }
  const out: PreviewRow[] = [];
  const counts = { ready: 0, duplicate: 0, invalid: 0 };
  rows.forEach((cells, i) => {
    const line = i + 2;
    const pick = (f: ImportField): string => {
      const idx = mapping[f];
      return idx === undefined ? "" : (cells[idx] ?? "");
    };
    const result = validateGuest({
      fullName: pick("fullName"),
      firstName: pick("firstName"),
      lastName: pick("lastName"),
      email: pick("email"),
      phone: pick("phone"),
      household: pick("household"),
      tags: pick("tags"),
      ageGroup: pick("ageGroup"),
      dietary: pick("dietary"),
      accessibility: pick("accessibility"),
    });
    if (!result.ok) {
      counts.invalid++;
      out.push({ line, status: "invalid", guest: null, errors: result.errors, duplicateOf: null });
      return;
    }
    const g = result.guest;
    const dup =
      (g.email ? byEmail.get(g.email) : undefined) ?? byName.get(nameKey(g.fullName)) ?? null;
    if (g.email && !byEmail.has(g.email)) byEmail.set(g.email, `row ${line}`);
    if (!byName.has(nameKey(g.fullName))) byName.set(nameKey(g.fullName), `row ${line}`);
    if (dup) {
      counts.duplicate++;
      out.push({ line, status: "duplicate", guest: g, errors: {}, duplicateOf: dup });
    } else {
      counts.ready++;
      out.push({ line, status: "ready", guest: g, errors: {}, duplicateOf: null });
    }
  });
  return { rows: out, counts };
}

/** Rows to store: ready always; possible duplicates only when the user chose to include them. */
export function rowsToCommit(preview: ImportPreview, includeDuplicates: boolean): GuestInput[] {
  return preview.rows.flatMap((r) =>
    r.guest && (r.status === "ready" || (includeDuplicates && r.status === "duplicate"))
      ? [r.guest]
      : [],
  );
}

/** The JSON the database RPCs accept (they re-validate every field). */
export function toGuestPayload(guest: GuestInput, notes: string | null = null) {
  return {
    name: guest.fullName,
    email: guest.email,
    phone: guest.phone,
    household: guest.household,
    tags: guest.tags,
    age_group: guest.ageGroup,
    dietary: guest.dietary,
    accessibility: guest.accessibility,
    notes,
  };
}
