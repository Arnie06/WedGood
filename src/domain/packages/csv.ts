import { toCsv } from "@/domain/guests/csv";
import type { PackageDocument } from "./document";

export type PackageMeta = {
  generatedAt: string;
  revision: number;
  digest: string;
};

/**
 * One flat CSV (docs/11): a row per value, so every table fits one file without merged cells.
 * Columns: Section, Table, Row, Column, Value. Every cell is text; money is already formatted, and
 * `toCsv` neutralizes anything a spreadsheet could read as a formula. This is a CSV, not a workbook.
 */
export function documentToCsv(doc: PackageDocument, meta: PackageMeta): string {
  const rows: string[][] = [["Section", "Table", "Row", "Column", "Value"]];
  const fact = (section: string, table: string, row: number, label: string, value: string) =>
    rows.push([section, table, String(row), label, value]);

  const details: [string, string][] = [
    ["Title", doc.title],
    ["Prepared for", doc.recipient || "Not specified"],
    ["Type", doc.presetLabel],
    ["Wedding date", doc.weddingDate ?? "Not set"],
    ["Generated (UTC)", meta.generatedAt],
    ["Plan revision", String(meta.revision)],
    ["Snapshot digest", meta.digest],
    ["Note", "A snapshot. It does not update when the plan changes."],
  ];
  details.forEach(([k, v], i) => fact("Package", "Details", i + 1, k, v));

  for (const section of doc.sections) {
    let facts = 0;
    for (const block of section.blocks) {
      if (block.type === "facts") {
        for (const item of block.items) {
          facts += 1;
          fact(section.title, "Details", facts, item.label, item.value);
        }
      } else if (block.type === "table") {
        block.rows.forEach((r, ri) => {
          r.forEach((cell, ci) =>
            fact(section.title, block.caption, ri + 1, block.columns[ci] ?? "", cell),
          );
        });
      } else {
        facts += 1;
        fact(
          section.title,
          "Notes",
          facts,
          block.tone === "caution" ? "Caution" : "Note",
          block.text,
        );
      }
    }
  }
  return `﻿${toCsv(rows)}`;
}
