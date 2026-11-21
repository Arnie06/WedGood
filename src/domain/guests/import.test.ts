import { describe, expect, it } from "vitest";
import {
  GUEST_LIMITS,
  buildPreview,
  guessMapping,
  nameKey,
  normalizeAgeGroup,
  rowsToCommit,
  splitTags,
  validateGuest,
  validateMapping,
} from "./import";

describe("validateGuest", () => {
  it("normalizes a full record", () => {
    const r = validateGuest({
      fullName: "  Ada   Lovelace ",
      email: " ADA@Example.Test ",
      phone: "+1 (555) 010-2000",
      household: " The  Lovelaces ",
      tags: "Family; college, family",
      ageGroup: "Adult",
      dietary: "Vegetarian\r\nno nuts",
      accessibility: "",
    });
    expect(r).toEqual({
      ok: true,
      guest: {
        fullName: "Ada Lovelace",
        email: "ada@example.test",
        phone: "+1 (555) 010-2000",
        household: "The Lovelaces",
        tags: ["Family", "college"],
        ageGroup: "adult",
        dietary: "Vegetarian\nno nuts",
        accessibility: null,
      },
    });
  });
  it("builds a name from first and last", () => {
    const r = validateGuest({ firstName: "Ben", lastName: "Ng" });
    expect(r.ok && r.guest.fullName).toBe("Ben Ng");
  });
  it("reports each problem separately and keeps no partial guest", () => {
    const r = validateGuest({
      email: "nope",
      phone: "12",
      tags: "x".repeat(31),
      ageGroup: "teen",
      dietary: "x".repeat(GUEST_LIMITS.privateText + 1),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(Object.keys(r.errors).sort()).toEqual(
        ["ageGroup", "dietary", "email", "fullName", "phone", "tags"].sort(),
      );
    }
  });
  it("strips control characters", () => {
    const r = validateGuest({ fullName: "Ada\u0007 L\u0000ovelace" });
    expect(r.ok && r.guest.fullName).toBe("Ada Lovelace");
  });
  it("keeps formula-looking text verbatim (neutralized on export, escaped on render)", () => {
    const r = validateGuest({ fullName: "=1+1" });
    expect(r.ok && r.guest.fullName).toBe("=1+1");
  });
});

describe("helpers", () => {
  it("age group synonyms", () => {
    expect(normalizeAgeGroup("Kids")).toBe("child");
    expect(normalizeAgeGroup("")).toBeNull();
    expect(normalizeAgeGroup("elder")).toBe("invalid");
  });
  it("splitTags dedupes ignoring case", () => {
    expect(splitTags("a, A ;b|")).toEqual(["a", "b"]);
  });
  it("nameKey ignores case, spacing and accents", () => {
    expect(nameKey("  José   Núñez")).toBe(nameKey("jose nunez"));
  });
});

describe("mapping", () => {
  it("guesses from common headers, once per column", () => {
    expect(guessMapping(["First Name", "Last Name", "E-mail", "Mobile", "Party", "Side"])).toEqual({
      firstName: 0,
      lastName: 1,
      email: 2,
      phone: 3,
      household: 4,
      tags: 5,
    });
    expect(guessMapping(["Name", "Email"])).toEqual({ fullName: 0, email: 1 });
  });
  it("requires a name column and unique, in-range columns", () => {
    expect(validateMapping({ email: 0 }, 2).ok).toBe(false);
    expect(validateMapping({ fullName: 0, email: 0 }, 2).ok).toBe(false);
    expect(validateMapping({ fullName: 5 }, 2).ok).toBe(false);
    expect(validateMapping({ firstName: 0 }, 2).ok).toBe(true);
  });
});

describe("buildPreview", () => {
  const mapping = { fullName: 0, email: 1 };
  it("separates ready, duplicate and invalid rows with file line numbers", () => {
    const p = buildPreview(
      [
        ["Ada Lovelace", "ada@example.test"],
        ["", "x@example.test"],
        ["Ada Lovelace", ""],
        ["Someone", "ada@example.test"],
        ["Existing Person", ""],
        ["Ben", "ben@example.test"],
      ],
      mapping,
      [{ fullName: "existing  person", email: null }],
    );
    expect(p.rows.map((r) => [r.line, r.status])).toEqual([
      [2, "ready"],
      [3, "invalid"],
      [4, "duplicate"],
      [5, "duplicate"],
      [6, "duplicate"],
      [7, "ready"],
    ]);
    expect(p.counts).toEqual({ ready: 2, duplicate: 3, invalid: 1 });
    expect(p.rows[2]?.duplicateOf).toBe("row 2");
    expect(p.rows[4]?.duplicateOf).toBe("a guest already on your list");
  });
  it("two people with the same name are not merged, only flagged", () => {
    const p = buildPreview(
      [
        ["Sam Lee", ""],
        ["Sam Lee", ""],
      ],
      { fullName: 0 },
      [],
    );
    expect(rowsToCommit(p, false)).toHaveLength(1);
    expect(rowsToCommit(p, true)).toHaveLength(2);
  });
  it("never commits invalid rows", () => {
    const p = buildPreview(
      [
        ["", ""],
        ["Ok", ""],
      ],
      { fullName: 0 },
      [],
    );
    expect(rowsToCommit(p, true).map((g) => g.fullName)).toEqual(["Ok"]);
  });
});
