import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_BYTES,
  displayHost,
  normalizeHex,
  parseBoardInput,
  parseExternalUrl,
  parseItemInput,
  parsePalette,
  readableOn,
  validateImageBytes,
} from "./board";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const PDF = new TextEncoder().encode("%PDF-1.7\n");

describe("normalizeHex", () => {
  it("expands shorthand, lowercases and adds the hash", () => {
    expect(normalizeHex("ABC")).toBe("#aabbcc");
    expect(normalizeHex(" #D88C9A ")).toBe("#d88c9a");
  });
  it("rejects non-colours", () => {
    for (const v of ["", "#12", "#12345", "#gggggg", "rgb(1,2,3)", "red", "#1234567"]) {
      expect(normalizeHex(v)).toBeNull();
    }
  });
});

describe("parsePalette", () => {
  it("splits on commas and whitespace and drops repeats in order", () => {
    expect(parsePalette("#D88C9A, 3d5a50\n#d88c9a  #FFF")).toEqual({
      ok: true,
      colors: ["#d88c9a", "#3d5a50", "#ffffff"],
    });
  });
  it("accepts an empty palette", () => {
    expect(parsePalette("  ")).toEqual({ ok: true, colors: [] });
  });
  it("names the first bad token", () => {
    const r = parsePalette("#d88c9a, blush");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("blush");
  });
  it("allows 8 colours and refuses 9", () => {
    const eight = Array.from({ length: 8 }, (_, i) => `#00000${i}`).join(" ");
    expect(parsePalette(eight).ok).toBe(true);
    expect(parsePalette(`${eight} #000009`).ok).toBe(false);
  });
});

describe("readableOn", () => {
  it("picks dark text on light swatches and white on dark", () => {
    expect(readableOn("#ffffff")).toBe("#1b1c1a");
    expect(readableOn("#d88c9a")).toBe("#1b1c1a");
    expect(readableOn("#000000")).toBe("#ffffff");
    expect(readableOn("#3d5a50")).toBe("#ffffff");
  });
});

describe("parseExternalUrl", () => {
  it("accepts https and http, adding https when the scheme is missing", () => {
    expect(parseExternalUrl("https://example.com/a?b=1")).toEqual({
      ok: true,
      url: "https://example.com/a?b=1",
    });
    expect(parseExternalUrl("example.com/flowers")).toEqual({
      ok: true,
      url: "https://example.com/flowers",
    });
    expect(parseExternalUrl("http://example.com")).toEqual({
      ok: true,
      url: "http://example.com/",
    });
  });
  it("rejects other schemes, credentials, spaces and hostless values", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,hi",
      "file:///etc/passwd",
      "ftp://example.com",
      "https://user:pw@example.com",
      "https://user@example.com",
      "https://exa mple.com",
      "https://localhost",
      "https://",
      "",
      "https://example.com/a@b",
    ]) {
      expect(parseExternalUrl(bad).ok, bad).toBe(false);
    }
  });
  it("rejects very long links", () => {
    expect(parseExternalUrl(`https://example.com/${"a".repeat(2100)}`).ok).toBe(false);
  });
  it("shows a plain host", () => {
    expect(displayHost("https://www.example.com/x")).toBe("example.com");
    expect(displayHost("nonsense")).toBe("");
  });
});

describe("validateImageBytes", () => {
  it("decides from the bytes", () => {
    expect(validateImageBytes(PNG, "image/png")).toEqual({ ok: true, mime: "image/png" });
    expect(validateImageBytes(JPEG, "")).toEqual({ ok: true, mime: "image/jpeg" });
  });
  it("rejects PDFs, mismatches, empty and oversized files", () => {
    expect(validateImageBytes(PDF, "application/pdf").ok).toBe(false);
    expect(validateImageBytes(PNG, "image/jpeg").ok).toBe(false);
    expect(validateImageBytes(new Uint8Array(0), "").ok).toBe(false);
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
    big.set(PNG);
    expect(validateImageBytes(big, "image/png").ok).toBe(false);
    const exact = new Uint8Array(MAX_IMAGE_BYTES);
    exact.set(PNG);
    expect(validateImageBytes(exact, "image/png").ok).toBe(true);
  });
});

describe("parseBoardInput", () => {
  it("normalizes and nulls empty description", () => {
    expect(parseBoardInput({ title: " Florals ", description: " ", palette: "ABC" })).toEqual({
      ok: true,
      value: { title: "Florals", description: null, palette: ["#aabbcc"] },
    });
  });
  it("reports every field error", () => {
    const r = parseBoardInput({ title: "", description: "x".repeat(1001), palette: "nope" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["description", "palette", "title"]);
  });
});

describe("parseItemInput", () => {
  const base = { title: "Arch", note: "", url: "", candidate: "" };
  it("requires a valid URL only for links", () => {
    expect(parseItemInput(base, false).ok).toBe(true);
    const link = parseItemInput(base, true);
    expect(link.ok).toBe(false);
    const good = parseItemInput({ ...base, url: "example.com/arch" }, true);
    expect(good).toEqual({
      ok: true,
      value: { title: "Arch", note: null, url: "https://example.com/arch", candidateId: null },
    });
  });
  it("ignores URL text for notes and rejects a non-uuid vendor", () => {
    const note = parseItemInput({ ...base, url: "javascript:1" }, false);
    expect(note.ok && note.value.url).toBeNull();
    const bad = parseItemInput({ ...base, candidate: "abc" }, false);
    expect(bad.ok).toBe(false);
  });
});
