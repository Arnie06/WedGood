import { describe, expect, it } from "vitest";
import { parseMajorToMinor } from "@/domain/wedding/settings";
import { NO_FILTERS, filterCandidates, parseFilters, type FilterableCandidate } from "./filter";
import { displayHost, parseCandidateInput, parseSourceUrl } from "./input";

describe("parseSourceUrl", () => {
  it("accepts http and https links and normalizes them", () => {
    expect(parseSourceUrl("https://Example.com/venues?id=1")).toBe(
      "https://example.com/venues?id=1",
    );
    expect(parseSourceUrl("  http://example.com  ")).toBe("http://example.com/");
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>1</script>",
    "file:///etc/passwd",
    "ftp://example.com",
    "https://user:pass@example.com",
    "https://user@example.com",
    "example.com",
    "https://",
    "https://exa mple.com",
    "",
    `https://example.com/${"a".repeat(2000)}`,
  ])("rejects %s", (bad) => {
    expect(parseSourceUrl(bad)).toBeNull();
  });

  it("shows a compact host", () => {
    expect(displayHost("https://www.example.com/x")).toBe("example.com");
  });
});

const venueRaw = { name: "  Garden   House ", seatedCapacity: "120", ceremonyCapacity: "" };

describe("parseCandidateInput", () => {
  it("requires only a name; blanks stay unknown, never zero", () => {
    const r = parseCandidateInput("venue", "USD", { name: "Garden House" });
    expect(r).toMatchObject({
      ok: true,
      value: {
        name: "Garden House",
        category: "venue",
        sourceUrl: null,
        priceMinor: null,
        priceBasis: null,
        seatedCapacity: null,
        ceremonyCapacity: null,
        notes: null,
      },
    });
  });

  it("normalizes whitespace and reads capacity", () => {
    const r = parseCandidateInput("venue", "USD", venueRaw);
    expect(r).toMatchObject({ ok: true, value: { name: "Garden House", seatedCapacity: 120 } });
  });

  it("stores price as exact minor units and requires a basis", () => {
    const ok = parseCandidateInput("venue", "USD", {
      name: "A",
      price: "8,500.50",
      priceBasis: "total",
    });
    expect(ok).toMatchObject({ ok: true, value: { priceMinor: 850050, priceBasis: "total" } });
    const noBasis = parseCandidateInput("venue", "USD", { name: "A", price: "8500" });
    expect(noBasis).toMatchObject({ ok: false, errors: { priceBasis: expect.any(String) } });
  });

  it("treats a typed zero as a real zero, distinct from blank", () => {
    const r = parseCandidateInput("vendor", "USD", {
      name: "A",
      category: "florist",
      price: "0",
      priceBasis: "total",
    });
    expect(r).toMatchObject({ ok: true, value: { priceMinor: 0 } });
  });

  it("uses the currency's decimals", () => {
    const r = parseCandidateInput("venue", "JPY", {
      name: "A",
      price: "850000",
      priceBasis: "total",
    });
    expect(r).toMatchObject({ ok: true, value: { priceMinor: 850000 } });
    expect(
      parseCandidateInput("venue", "JPY", { name: "A", price: "1.5", priceBasis: "total" }).ok,
    ).toBe(false);
  });

  it("reports every problem and keeps nothing", () => {
    const r = parseCandidateInput("venue", "USD", {
      name: "",
      sourceUrl: "javascript:alert(1)",
      price: "abc",
      seatedCapacity: "-4",
      sourceCheckedOn: "2027-02-31",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(Object.keys(r.errors).sort()).toEqual(
        ["name", "price", "seatedCapacity", "sourceCheckedOn", "sourceUrl"].sort(),
      );
    }
  });

  it("requires a category for vendors and ignores capacity", () => {
    expect(parseCandidateInput("vendor", "USD", { name: "A" })).toMatchObject({
      ok: false,
      errors: { category: expect.any(String) },
    });
    const r = parseCandidateInput("vendor", "USD", {
      name: "A",
      category: "caterer",
      seatedCapacity: "999",
    });
    expect(r).toMatchObject({ ok: true, value: { category: "caterer", seatedCapacity: null } });
  });

  it("rejects an unknown vendor category and a capacity of zero", () => {
    expect(parseCandidateInput("vendor", "USD", { name: "A", category: "venue" }).ok).toBe(false);
    expect(parseCandidateInput("venue", "USD", { name: "A", seatedCapacity: "0" }).ok).toBe(false);
  });

  it("enforces length limits", () => {
    expect(parseCandidateInput("venue", "USD", { name: "x".repeat(161) }).ok).toBe(false);
    expect(parseCandidateInput("venue", "USD", { name: "A", notes: "x".repeat(2001) }).ok).toBe(
      false,
    );
  });
});

function c(over: Partial<FilterableCandidate> & { name: string }): FilterableCandidate {
  return {
    kind: "venue",
    category: "venue",
    location: null,
    notes: null,
    pricingDisplay: null,
    priceMinor: null,
    priceBasis: null,
    priceCurrency: null,
    seatedCapacity: null,
    isFavorite: false,
    ...over,
  };
}

const items = [
  c({
    name: "Vineyard Estate",
    seatedCapacity: 180,
    priceMinor: 850000,
    priceBasis: "total",
    priceCurrency: "USD",
    location: "Napa",
  }),
  c({
    name: "Coastal Terrace",
    seatedCapacity: 150,
    priceMinor: 1200000,
    priceBasis: "total",
    priceCurrency: "USD",
    isFavorite: true,
  }),
  c({
    name: "Garden House",
    seatedCapacity: 120,
    priceMinor: 650000,
    priceBasis: "total",
    priceCurrency: "USD",
  }),
  c({ name: "Mystery Barn" }),
  c({
    name: "Lantern Photography",
    kind: "vendor",
    category: "photographer",
    priceMinor: 9500,
    priceBasis: "per_guest",
    priceCurrency: "USD",
    notes: "Café-style candids",
  }),
];
const names = (r: { matches: FilterableCandidate[] }) => r.matches.map((m) => m.name);

describe("filterCandidates", () => {
  it("returns everything with no filters", () => {
    expect(filterCandidates(items, NO_FILTERS, "USD").matches).toHaveLength(5);
  });

  it("searches name, place and notes ignoring case and accents", () => {
    expect(names(filterCandidates(items, { ...NO_FILTERS, q: "napa" }, "USD"))).toEqual([
      "Vineyard Estate",
    ]);
    expect(names(filterCandidates(items, { ...NO_FILTERS, q: "CAFE" }, "USD"))).toEqual([
      "Lantern Photography",
    ]);
  });

  it("filters by category and favorites", () => {
    expect(
      names(filterCandidates(items, { ...NO_FILTERS, category: "photographer" }, "USD")),
    ).toEqual(["Lantern Photography"]);
    expect(names(filterCandidates(items, { ...NO_FILTERS, favoritesOnly: true }, "USD"))).toEqual([
      "Coastal Terrace",
    ]);
  });

  it("minimum capacity keeps big-enough venues, drops small ones and vendors, and counts unknowns", () => {
    const r = filterCandidates(items, { ...NO_FILTERS, minSeated: 150 }, "USD");
    expect(names(r)).toEqual(["Vineyard Estate", "Coastal Terrace"]);
    expect(r.hiddenUnknown).toBe(1); // Mystery Barn: capacity unknown
  });

  it("includes unknowns only when asked", () => {
    const r = filterCandidates(
      items,
      { ...NO_FILTERS, minSeated: 150, includeUnknown: true },
      "USD",
    );
    expect(names(r)).toEqual(["Vineyard Estate", "Coastal Terrace", "Mystery Barn"]);
    expect(r.hiddenUnknown).toBe(0);
  });

  it("price ceiling treats per-guest, other-currency and missing prices as unknown, not cheap", () => {
    const withEuro = [
      ...items,
      c({ name: "Euro Hall", priceMinor: 1000, priceBasis: "total", priceCurrency: "EUR" }),
    ];
    const r = filterCandidates(withEuro, { ...NO_FILTERS, maxPriceMinor: 900000 }, "USD");
    expect(names(r)).toEqual(["Vineyard Estate", "Garden House"]);
    expect(r.hiddenUnknown).toBe(3); // Mystery Barn, Lantern (per guest), Euro Hall
  });

  it("a price at the ceiling matches", () => {
    expect(names(filterCandidates(items, { ...NO_FILTERS, maxPriceMinor: 650000 }, "USD"))).toEqual(
      ["Garden House"],
    );
  });

  it("does not mutate its input", () => {
    const copy = [...items];
    filterCandidates(items, { ...NO_FILTERS, q: "x" }, "USD");
    expect(items).toEqual(copy);
  });
});

describe("parseFilters", () => {
  it("reads valid params and ignores junk without guessing", () => {
    const { filters, errors } = parseFilters(
      {
        q: "napa",
        seated: "150",
        price: "10,000",
        favorites: "1",
        unknown: "1",
        category: "caterer",
      },
      "USD",
      parseMajorToMinor,
    );
    expect(filters).toEqual({
      q: "napa",
      category: "caterer",
      minSeated: 150,
      maxPriceMinor: 1000000,
      favoritesOnly: true,
      includeUnknown: true,
    });
    expect(errors).toEqual({});
  });

  it("reports bad numbers and applies no filter for them", () => {
    const { filters, errors } = parseFilters(
      { seated: "many", price: "cheap" },
      "USD",
      parseMajorToMinor,
    );
    expect(filters.minSeated).toBeNull();
    expect(filters.maxPriceMinor).toBeNull();
    expect(Object.keys(errors).sort()).toEqual(["maxPrice", "minSeated"]);
  });

  it("takes the first of repeated params and trims the query length", () => {
    const { filters } = parseFilters(
      { q: ["a", "b"], category: undefined },
      "USD",
      parseMajorToMinor,
    );
    expect(filters.q).toBe("a");
    expect(filters.category).toBe("all");
    expect(parseFilters({ q: "x".repeat(500) }, "USD", parseMajorToMinor).filters.q).toHaveLength(
      100,
    );
  });
});
