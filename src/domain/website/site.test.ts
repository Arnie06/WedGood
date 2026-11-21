import { describe, expect, it } from "vitest";
import {
  cleanText,
  emptyDraft,
  eventField,
  isIsoDate,
  parseHttpsUrl,
  parseSiteForm,
  publicationState,
  readDraft,
  suggestSlug,
  validateSlug,
} from "./site";

const EVENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const base = { template: "classic", title: "Alex & Morgan" };

describe("parseHttpsUrl", () => {
  it("accepts https links to a public host and normalizes them", () => {
    expect(parseHttpsUrl(" https://registry.example.com/alex ")).toEqual({
      ok: true,
      url: "https://registry.example.com/alex",
    });
  });
  it.each([
    "http://registry.example.com",
    "javascript:alert(1)",
    "data:text/html,hi",
    "https://user:pw@example.com",
    "https://user@example.com",
    "https://example.com/a b",
    "https://localhost/x",
    "https://intranet/x",
    "ftp://example.com",
    "example.com",
    "",
  ])("rejects %s", (value) => {
    expect(parseHttpsUrl(value).ok).toBe(false);
  });
  it("rejects very long links", () => {
    expect(parseHttpsUrl(`https://example.com/${"a".repeat(2100)}`).ok).toBe(false);
  });
});

describe("slugs", () => {
  it("accepts lowercase words joined by single hyphens", () => {
    expect(validateSlug(" Alex-and-Morgan ")).toEqual({ ok: true, slug: "alex-and-morgan" });
  });
  it.each([
    "ab",
    "-abc",
    "abc-",
    "a--b",
    "has space",
    "under_score",
    "x".repeat(41),
    "rsvp",
    "app",
  ])("rejects %s", (value) => {
    expect(validateSlug(value).ok).toBe(false);
  });
  it("suggests an address from the title", () => {
    expect(suggestSlug("Alex & Morgan")).toBe("alex-and-morgan");
    expect(suggestSlug("Zoë  Müller!!")).toBe("zoe-muller");
    expect(suggestSlug("A")).toBe("");
  });
});

describe("dates and text", () => {
  it("validates real calendar dates", () => {
    expect(isIsoDate("2027-06-12")).toBe(true);
    expect(isIsoDate("2027-02-30")).toBe(false);
    expect(isIsoDate("06/12/2027")).toBe(false);
  });
  it("normalizes line endings and drops control characters", () => {
    expect(cleanText("a\r\nb\u0000c\u0007")).toBe("a\nbc");
  });
});

describe("parseSiteForm", () => {
  it("builds a minimal draft and omits blank optional fields", () => {
    const r = parseSiteForm({ ...base, tagline: "  ", story: "" }, []);
    expect(r).toEqual({
      ok: true,
      draft: { template: "classic", title: "Alex & Morgan", faq: [], registry: [], events: [] },
    });
  });

  it("requires a title and a known template", () => {
    const r = parseSiteForm({ template: "neon", title: " " }, []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["template", "title"]);
  });

  it("keeps markup as plain text rather than interpreting it", () => {
    const r = parseSiteForm({ ...base, story: "<script>alert(1)</script> & <b>bold</b>" }, []);
    expect(r.ok && r.draft.story).toBe("<script>alert(1)</script> & <b>bold</b>");
  });

  it("requires both halves of a question or a registry row", () => {
    const r = parseSiteForm({ ...base, faq_q_0: "Parking?", reg_label_0: "Gifts" }, []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["faq_0", "reg_0"]);
  });

  it("rejects unsafe registry links and keeps valid ones", () => {
    const bad = parseSiteForm(
      { ...base, reg_label_0: "Gifts", reg_url_0: "javascript:alert(1)" },
      [],
    );
    expect(bad.ok).toBe(false);
    const good = parseSiteForm(
      { ...base, reg_label_0: "Gifts", reg_url_0: "https://registry.example.com/a" },
      [],
    );
    expect(good.ok && good.draft.registry).toEqual([
      { label: "Gifts", url: "https://registry.example.com/a" },
    ]);
  });

  it("adds only events that are shown, per their visibility, and ignores unknown event ids", () => {
    const r = parseSiteForm(
      {
        ...base,
        [eventField(EVENT, "visibility")]: "invited",
        [eventField(EVENT, "when")]: "4 pm",
        [eventField(EVENT, "where")]: "The Garden",
        [eventField(OTHER, "visibility")]: "public",
        [eventField("33333333-3333-4333-8333-333333333333", "visibility")]: "public",
      },
      [EVENT, OTHER, "44444444-4444-4444-8444-444444444444"],
    );
    expect(r.ok && r.draft.events).toEqual([
      { eventId: EVENT, visibility: "invited", when: "4 pm", where: "The Garden" },
      { eventId: OTHER, visibility: "public" },
    ]);
  });

  it("rejects an unknown visibility value", () => {
    const r = parseSiteForm({ ...base, [eventField(EVENT, "visibility")]: "everyone" }, [EVENT]);
    expect(r.ok).toBe(false);
  });

  it("enforces length limits and valid dates", () => {
    const r = parseSiteForm(
      { ...base, title: "x".repeat(121), tagline: "y".repeat(201), date: "2027-13-01" },
      [],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["date", "tagline", "title"]);
  });
});

describe("readDraft", () => {
  it("falls back to an empty draft for unknown shapes", () => {
    expect(readDraft(null)).toEqual(emptyDraft());
    expect(readDraft([1, 2])).toEqual(emptyDraft());
  });
  it("drops malformed list entries and unknown visibility", () => {
    const d = readDraft({
      template: "garden",
      title: "T",
      faq: [{ q: "a" }, { q: "q", a: "a" }, 5],
      registry: [{ label: "x" }],
      events: [
        { eventId: EVENT, visibility: "secret" },
        { eventId: EVENT, visibility: "public" },
      ],
    });
    expect(d.template).toBe("garden");
    expect(d.faq).toEqual([{ q: "q", a: "a" }]);
    expect(d.registry).toEqual([]);
    expect(d.events).toEqual([{ eventId: EVENT, visibility: "public" }]);
  });
});

describe("publicationState", () => {
  const s = { published: false, everPublished: false, draftRev: 3, publishedDraftRev: null };
  it("distinguishes draft, published, changed and unpublished", () => {
    expect(publicationState(s)).toBe("draft");
    expect(publicationState({ ...s, everPublished: true })).toBe("unpublished");
    expect(
      publicationState({ ...s, published: true, everPublished: true, publishedDraftRev: 3 }),
    ).toBe("published");
    expect(
      publicationState({ ...s, published: true, everPublished: true, publishedDraftRev: 2 }),
    ).toBe("published-with-changes");
  });
});
