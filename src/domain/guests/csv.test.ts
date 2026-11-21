import { describe, expect, it } from "vitest";
import { MAX_CSV_ROWS, parseCsv, sanitizeCsvCell, toCsv } from "./csv";

describe("parseCsv", () => {
  it("reads headers and rows, ignoring blank lines and a BOM", () => {
    const r = parseCsv("﻿Name,Email\r\nAda,ada@example.test\r\n\r\nBen,\r\n");
    expect(r).toEqual({
      ok: true,
      delimiter: ",",
      headers: ["Name", "Email"],
      rows: [
        ["Ada", "ada@example.test"],
        ["Ben", ""],
      ],
    });
  });
  it("handles quotes, doubled quotes, embedded commas and newlines", () => {
    const r = parseCsv('Name,Notes\n"Smith, Ada","says ""hi""\nthere"\n');
    expect(r.ok && r.rows).toEqual([["Smith, Ada", 'says "hi"\nthere']]);
  });
  it("detects semicolon and tab delimiters", () => {
    const semi = parseCsv("Name;Email\nAda;a@example.test");
    expect(semi.ok && semi.delimiter).toBe(";");
    const tab = parseCsv("Name\tEmail\nAda\ta@example.test");
    expect(tab.ok && tab.rows).toEqual([["Ada", "a@example.test"]]);
  });
  it("pads short rows and drops cells beyond the header", () => {
    const r = parseCsv("A,B\n1\n1,2,3");
    expect(r.ok && r.rows).toEqual([
      ["1", ""],
      ["1", "2"],
    ]);
  });
  it("rejects empty, header-only, unclosed-quote, binary and oversized input", () => {
    expect(parseCsv("").ok).toBe(false);
    expect(parseCsv("Name,Email\n").ok).toBe(false);
    expect(parseCsv('Name\n"open').ok).toBe(false);
    expect(parseCsv("Name\n\u0000\u0001").ok).toBe(false);
    expect(parseCsv("x".repeat(300 * 1024)).ok).toBe(false);
  });
  it("limits row count", () => {
    const rows = Array.from({ length: MAX_CSV_ROWS + 1 }, (_, i) => `G${i}`).join("\n");
    expect(parseCsv(`Name\n${rows}`).ok).toBe(false);
    const ok = Array.from({ length: MAX_CSV_ROWS }, (_, i) => `G${i}`).join("\n");
    expect(parseCsv(`Name\n${ok}`).ok).toBe(true);
  });
});

describe("sanitizeCsvCell (T19)", () => {
  it.each(["=SUM(A1)", "+1 555", "-2", "@cmd", "\t=1", "\r=1", "  =1+1", " +44"])(
    "prefixes %j",
    (v) => {
      expect(sanitizeCsvCell(v)).toBe(`'${v}`);
    },
  );
  it.each(["Ada", "", "a=b", "5 - 3", "O'Neil"])("leaves %j alone", (v) => {
    expect(sanitizeCsvCell(v)).toBe(v);
  });
});

describe("toCsv", () => {
  it("quotes, escapes and neutralizes formulas", () => {
    expect(
      toCsv([
        ["Name", "Note"],
        ['=HYPERLINK("x")', 'a,"b"'],
      ]),
    ).toBe('Name,Note\r\n"\'=HYPERLINK(""x"")","a,""b"""\r\n');
  });
});
