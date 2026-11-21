import { describe, expect, it } from "vitest";
import {
  MAX_DOCUMENT_BYTES,
  defaultTitleFromName,
  formatBytes,
  parseDocumentMeta,
  parseLinkTarget,
  sanitizeDisplayName,
  sniffMime,
  validateFileBytes,
} from "./validate";

const bytes = (...b: number[]) => new Uint8Array(b);
const ascii = (s: string) => new TextEncoder().encode(s);
const PDF = ascii("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF");
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10);
const WEBP = bytes(0x52, 0x49, 0x46, 0x46, 1, 0, 0, 0, 0x57, 0x45, 0x42, 0x50);

describe("sniffMime", () => {
  it("identifies allowed types from signatures", () => {
    expect(sniffMime(PDF)).toBe("application/pdf");
    expect(sniffMime(PNG)).toBe("image/png");
    expect(sniffMime(JPEG)).toBe("image/jpeg");
    expect(sniffMime(WEBP)).toBe("image/webp");
  });
  it("rejects HTML, SVG, scripts, Office and archives even if they look harmless", () => {
    expect(sniffMime(ascii("<html><script>alert(1)</script>"))).toBeNull();
    expect(sniffMime(ascii('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffMime(ascii("#!/bin/sh\nrm -rf /"))).toBeNull();
    expect(sniffMime(bytes(0x50, 0x4b, 0x03, 0x04))).toBeNull();
    expect(sniffMime(bytes(0x4d, 0x5a, 0x90, 0))).toBeNull();
  });
  it("needs the signature at offset zero, not later in the file", () => {
    expect(sniffMime(ascii("   %PDF-1.7"))).toBeNull();
    expect(sniffMime(new Uint8Array())).toBeNull();
  });
  it("does not accept RIFF files that are not WebP", () => {
    expect(sniffMime(bytes(0x52, 0x49, 0x46, 0x46, 1, 0, 0, 0, 0x57, 0x41, 0x56, 0x45))).toBeNull();
  });
});

describe("validateFileBytes", () => {
  it("accepts a matching type and returns the sniffed one", () => {
    expect(validateFileBytes(PDF, "application/pdf")).toEqual({
      ok: true,
      mime: "application/pdf",
    });
    expect(validateFileBytes(PNG, "")).toEqual({ ok: true, mime: "image/png" });
  });
  it("rejects a declared type that disagrees with the bytes", () => {
    const r = validateFileBytes(ascii("<html>"), "application/pdf");
    expect(r.ok).toBe(false);
    const mismatch = validateFileBytes(PNG, "application/pdf");
    expect(mismatch).toEqual({ ok: false, reason: "The file's contents don't match its type." });
  });
  it("rejects empty and oversized files", () => {
    expect(validateFileBytes(new Uint8Array(), "application/pdf").ok).toBe(false);
    const big = new Uint8Array(MAX_DOCUMENT_BYTES + 1);
    big.set(PDF);
    expect(validateFileBytes(big, "application/pdf").ok).toBe(false);
    const exact = new Uint8Array(MAX_DOCUMENT_BYTES);
    exact.set(PDF);
    expect(validateFileBytes(exact, "application/pdf").ok).toBe(true);
  });
  it("rejects PDFs with scripts, launch actions or embedded files", () => {
    for (const marker of [
      "/JavaScript",
      "/JS (x)",
      "/Launch",
      "/EmbeddedFile",
      "/RichMedia",
      "/XFA",
    ]) {
      const pdf = ascii(`%PDF-1.7\n<< /S /Action ${marker} >>`);
      expect(validateFileBytes(pdf, "application/pdf").ok, marker).toBe(false);
    }
  });
  it("does not trip on longer names that merely start the same way", () => {
    expect(validateFileBytes(ascii("%PDF-1.7\n/JSON /Jsx"), "application/pdf").ok).toBe(true);
  });
});

describe("names, metadata and links", () => {
  it("strips paths and control characters from the display name", () => {
    expect(sanitizeDisplayName("..\\..\\evil/contract.pdf")).toBe("contract.pdf");
    expect(sanitizeDisplayName("a\u0000b<script>.pdf")).toBe("abscript.pdf");
    expect(sanitizeDisplayName("..")).toBeNull();
    expect(sanitizeDisplayName("   ")).toBeNull();
    expect(sanitizeDisplayName("x".repeat(300))?.length).toBe(120);
  });
  it("derives a title from the file name", () => {
    expect(defaultTitleFromName("Venue contract v2.pdf")).toBe("Venue contract v2");
    expect(defaultTitleFromName("noextension")).toBe("noextension");
  });
  it("validates metadata", () => {
    expect(parseDocumentMeta({ title: "  Deposit receipt ", kind: "receipt" })).toEqual({
      ok: true,
      value: { title: "Deposit receipt", kind: "receipt" },
    });
    const bad = parseDocumentMeta({ title: " ", kind: "zip" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["kind", "title"]);
    expect(parseDocumentMeta({ title: "x".repeat(161), kind: "other" }).ok).toBe(false);
  });
  it("parses link targets strictly", () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    expect(parseLinkTarget(`payment:${id}`)).toEqual({ type: "payment", id });
    expect(parseLinkTarget(`guest:${id}`)).toBeNull();
    expect(parseLinkTarget("payment:nope")).toBeNull();
    expect(parseLinkTarget(`payment:${id}:x`)).toBeNull();
    expect(parseLinkTarget("")).toBeNull();
  });
  it("formats sizes", () => {
    expect(formatBytes(10)).toBe("10 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
