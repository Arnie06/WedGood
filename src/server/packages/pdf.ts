import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { Orientation, Paper } from "@/domain/packages/catalog";
import type { PackageMeta } from "@/domain/packages/csv";
import { toPdfText, type Block, type PackageDocument } from "@/domain/packages/document";

/**
 * Renders the document model to a real-text PDF with the built-in fonts (no raster pages, no
 * remote resources, no HTML). Layout is a single pass: wrap, measure, paginate, repeat table
 * headers, split a row only when it cannot fit on any page. Footers are drawn last so they can
 * say "Page X of Y". Output is deterministic for equal input and metadata.
 *
 * Colours follow docs/03-DESIGN.md (warm charcoal text, dusty-rose headings, eucalyptus rules),
 * chosen for print contrast: body text is charcoal on white.
 */

const INK = rgb(0.106, 0.11, 0.102); // #1B1C1A
const MUTED = rgb(0.31, 0.3, 0.28);
const ROSE = rgb(0.545, 0.294, 0.345); // #8B4B58
const EUCALYPTUS = rgb(0.239, 0.353, 0.314); // #3D5A50
const RULE = rgb(0.82, 0.78, 0.73);
const HEAD_BG = rgb(0.945, 0.918, 0.878);

const SIZES: Record<Paper, [number, number]> = { a4: [595.28, 841.89], letter: [612, 792] };
const MARGIN = 54;
const FOOTER = 44;
const PAD = 5;

type Fonts = { serifBold: PDFFont; sans: PDFFont; sansBold: PDFFont; sansItalic: PDFFont };

export type RenderedPdf = { bytes: Uint8Array; pageCount: number; lines: string[] };

export async function renderPdf(
  doc: PackageDocument,
  meta: PackageMeta,
  paper: Paper,
  orientation: Orientation,
): Promise<RenderedPdf> {
  const pdf = await PDFDocument.create();
  const when = new Date(meta.generatedAt);
  pdf.setTitle(toPdfText(doc.title).text);
  pdf.setAuthor("Wedding Workspace");
  pdf.setCreator("Wedding Workspace");
  pdf.setProducer("Wedding Workspace");
  pdf.setSubject(`${toPdfText(doc.presetLabel).text}, plan revision ${meta.revision}`);
  pdf.setLanguage("en-US");
  pdf.setCreationDate(when);
  pdf.setModificationDate(when);

  const f: Fonts = {
    serifBold: await pdf.embedFont(StandardFonts.TimesRomanBold),
    sans: await pdf.embedFont(StandardFonts.Helvetica),
    sansBold: await pdf.embedFont(StandardFonts.HelveticaBold),
    sansItalic: await pdf.embedFont(StandardFonts.HelveticaOblique),
  };
  const [w0, h0] = SIZES[paper];
  const [pw, ph] = orientation === "landscape" ? [h0, w0] : [w0, h0];
  const bodyW = pw - MARGIN * 2;
  const top = ph - MARGIN;
  const bottom = MARGIN + FOOTER;

  const pages: PDFPage[] = [];
  const lines: string[] = [];
  let page = pdf.addPage([pw, ph]);
  pages.push(page);
  let y = top;

  const clean = (s: string) => toPdfText(s).text;
  const newPage = () => {
    page = pdf.addPage([pw, ph]);
    pages.push(page);
    y = top;
  };
  const room = (h: number) => y - h >= bottom;

  /** Greedy wrap by words; a word wider than the line is broken by characters. */
  const wrap = (text: string, font: PDFFont, size: number, width: number): string[] => {
    const out: string[] = [];
    let line = "";
    const push = () => {
      out.push(line);
      line = "";
    };
    for (const word of clean(text).split(" ")) {
      if (word === "") continue;
      const trial = line === "" ? word : `${line} ${word}`;
      if (font.widthOfTextAtSize(trial, size) <= width) {
        line = trial;
        continue;
      }
      if (line !== "") push();
      if (font.widthOfTextAtSize(word, size) <= width) {
        line = word;
        continue;
      }
      let chunk = "";
      for (const ch of word) {
        if (font.widthOfTextAtSize(chunk + ch, size) > width && chunk !== "") {
          out.push(chunk);
          chunk = ch;
        } else chunk += ch;
      }
      line = chunk;
    }
    if (line !== "" || out.length === 0) push();
    return out;
  };

  const text = (
    s: string,
    x: number,
    baseline: number,
    font: PDFFont,
    size: number,
    color = INK,
  ) => {
    if (s === "") return;
    page.drawText(s, { x, y: baseline, size, font, color });
    lines.push(s);
  };

  // ------------------------------------------------------------------ cover
  const fullDate = (d: string | null) => {
    if (!d) return "Date not set";
    return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" }).format(
      new Date(`${d}T00:00:00Z`),
    );
  };
  page.drawRectangle({ x: MARGIN, y: top - 3, width: 64, height: 3, color: ROSE });
  y = top - 70;
  for (const l of wrap(doc.title, f.serifBold, 30, bodyW)) {
    text(l, MARGIN, y, f.serifBold, 30);
    y -= 38;
  }
  y -= 4;
  text(clean(doc.presetLabel), MARGIN, y, f.sansBold, 13, ROSE);
  y -= 20;
  const prepared = doc.recipient ? `Prepared for ${doc.recipient}` : "";
  for (const l of prepared ? wrap(prepared, f.sans, 12, bodyW) : []) {
    text(l, MARGIN, y, f.sans, 12, MUTED);
    y -= 17;
  }
  text(fullDate(doc.weddingDate), MARGIN, y, f.sans, 12, MUTED);
  y -= 40;
  text("Contents", MARGIN, y, f.sansBold, 11, EUCALYPTUS);
  y -= 8;
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: MARGIN + bodyW, y },
    thickness: 0.8,
    color: RULE,
  });
  y -= 18;
  for (const s of doc.sections) {
    text(clean(s.title), MARGIN, y, f.sans, 11);
    y -= 17;
  }
  const generated = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(when);
  const coverNote = [
    `Snapshot of plan revision ${meta.revision}, generated ${generated} UTC.`,
    "It does not update when the plan changes. Download a new one for current figures.",
    `Reference ${meta.digest.slice(0, 12)}`,
  ];
  let ny = bottom + 8 + coverNote.length * 14;
  page.drawLine({
    start: { x: MARGIN, y: ny + 8 },
    end: { x: MARGIN + bodyW, y: ny + 8 },
    thickness: 0.8,
    color: RULE,
  });
  for (const l of coverNote) {
    for (const wl of wrap(l, f.sans, 9.5, bodyW)) {
      text(wl, MARGIN, ny - 8, f.sans, 9.5, MUTED);
      ny -= 14;
    }
  }

  // ------------------------------------------------------------------ blocks
  const LINE = 1.35;

  const drawTable = (b: Extract<Block, { type: "table" }>, sectionTitle: string) => {
    const size = 9.5;
    const lh = size * LINE;
    const cell = (s: string) => clean(s);
    const widthOf = (s: string, font: PDFFont) => font.widthOfTextAtSize(cell(s), size);
    const natural = b.columns.map(
      (c, i) =>
        Math.max(widthOf(c, f.sansBold), ...b.rows.map((r) => widthOf(r[i] ?? "", f.sans))) +
        PAD * 2,
    );
    const minimum = b.columns.map((c, i) => {
      const longest = (s: string, font: PDFFont) =>
        Math.max(
          0,
          ...cell(s)
            .split(" ")
            .map((x) => font.widthOfTextAtSize(x, size)),
        );
      return Math.min(
        natural[i] ?? 0,
        Math.max(longest(c, f.sansBold), ...b.rows.map((r) => longest(r[i] ?? "", f.sans))) +
          PAD * 2,
      );
    });
    const sumNat = natural.reduce((a, c) => a + c, 0);
    let widths: number[];
    if (sumNat <= bodyW) {
      widths = natural.map((n) => (n / sumNat) * bodyW);
    } else {
      const sumMin = minimum.reduce((a, c) => a + c, 0);
      if (sumMin >= bodyW) widths = minimum.map((m) => (m / sumMin) * bodyW);
      else {
        const spare = bodyW - sumMin;
        const want = natural.reduce((a, n, i) => a + n - (minimum[i] ?? 0), 0);
        widths = minimum.map((m, i) => m + (spare * ((natural[i] ?? 0) - m)) / want);
      }
    }
    const xs = widths.reduce<number[]>((acc, w, i) => [...acc, (acc[i] ?? MARGIN) + w], [MARGIN]);

    const cellLines = (s: string, i: number, font: PDFFont) =>
      wrap(s, font, size, (widths[i] ?? bodyW) - PAD * 2);
    const drawCellText = (ls: string[], i: number, font: PDFFont, baseline: number) => {
      ls.forEach((l, n) => {
        const w = font.widthOfTextAtSize(l, size);
        const x =
          b.align[i] === "right" ? (xs[i + 1] ?? MARGIN) - PAD - w : (xs[i] ?? MARGIN) + PAD;
        text(l, x, baseline - n * lh, font, size);
      });
    };

    const header = b.columns.map((c, i) => cellLines(c, i, f.sansBold));
    const headerH = Math.max(...header.map((h) => h.length)) * lh + PAD * 2;
    const drawHeader = () => {
      page.drawRectangle({
        x: MARGIN,
        y: y - headerH,
        width: bodyW,
        height: headerH,
        color: HEAD_BG,
      });
      header.forEach((h, i) => drawCellText(h, i, f.sansBold, y - PAD - size));
      y -= headerH;
    };

    const caption = b.caption === sectionTitle ? [] : wrap(b.caption, f.sansBold, 11, bodyW);
    const firstRow = b.rows[0]?.map((c, i) => cellLines(c, i, f.sans)) ?? [];
    const firstH = Math.min(
      Math.max(1, ...firstRow.map((r) => r.length)) * lh + PAD * 2,
      lh * 3 + PAD * 2,
    );
    if (!room(caption.length * 15 + 8 + headerH + firstH)) newPage();
    for (const l of caption) {
      y -= 11;
      text(l, MARGIN, y, f.sansBold, 11, EUCALYPTUS);
      y -= 4;
    }
    y -= 4;
    drawHeader();

    for (const row of b.rows) {
      let cells = row.map((c, i) => cellLines(c, i, f.sans));
      for (;;) {
        const count = Math.max(1, ...cells.map((c) => c.length));
        const h = count * lh + PAD * 2;
        const pageBody = top - bottom - headerH;
        if (room(h)) {
          cells.forEach((c, i) => drawCellText(c, i, f.sans, y - PAD - size));
          y -= h;
          page.drawLine({
            start: { x: MARGIN, y },
            end: { x: MARGIN + bodyW, y },
            thickness: 0.4,
            color: RULE,
          });
          break;
        }
        if (h <= pageBody) {
          newPage();
          drawHeader();
          continue;
        }
        // Taller than any page: draw what fits, carry the rest over.
        if (!room(lh + PAD * 2 + lh)) {
          newPage();
          drawHeader();
        }
        const fit = Math.max(1, Math.floor((y - bottom - PAD * 2) / lh));
        cells.forEach((c, i) => drawCellText(c.slice(0, fit), i, f.sans, y - PAD - size));
        y -= fit * lh + PAD * 2;
        cells = cells.map((c) => c.slice(fit));
        if (cells.every((c) => c.length === 0)) break;
        newPage();
        drawHeader();
      }
    }
    y -= 14;
  };

  const drawFacts = (b: Extract<Block, { type: "facts" }>) => {
    const size = 10.5;
    const lh = size * LINE;
    const labelW = Math.min(bodyW * 0.38, 200);
    for (const item of b.items) {
      const l = wrap(item.label, f.sansBold, 9.5, labelW - 8);
      const v = wrap(item.value, f.sans, size, bodyW - labelW);
      const h = Math.max(l.length * 9.5 * LINE, v.length * lh) + 8;
      if (!room(h)) newPage();
      l.forEach((s, n) => text(s, MARGIN, y - size - n * 9.5 * LINE, f.sansBold, 9.5, MUTED));
      v.forEach((s, n) => text(s, MARGIN + labelW, y - size - n * lh, f.sans, size));
      y -= h;
    }
    y -= 8;
  };

  const drawText = (b: Extract<Block, { type: "text" }>) => {
    const size = b.tone === "plain" ? 10.5 : 9.5;
    const lh = size * LINE;
    const prefix = b.tone === "caution" ? "Heads up: " : b.tone === "note" ? "Note: " : "";
    const ls = wrap(
      `${prefix}${b.text}`,
      b.tone === "plain" ? f.sans : f.sansItalic,
      size,
      bodyW - 12,
    );
    let i = 0;
    while (i < ls.length) {
      if (!room(lh * 2)) newPage();
      const fit = Math.max(1, Math.min(ls.length - i, Math.floor((y - bottom) / lh)));
      if (b.tone !== "plain") {
        page.drawRectangle({
          x: MARGIN,
          y: y - fit * lh - 2,
          width: 2.5,
          height: fit * lh + 2,
          color: b.tone === "caution" ? ROSE : EUCALYPTUS,
        });
      }
      for (let n = 0; n < fit; n += 1) {
        y -= lh;
        text(
          ls[i + n] ?? "",
          MARGIN + (b.tone === "plain" ? 0 : 10),
          y + 3,
          b.tone === "plain" ? f.sans : f.sansItalic,
          size,
          b.tone === "plain" ? INK : MUTED,
        );
      }
      i += fit;
    }
    y -= 10;
  };

  // ------------------------------------------------------------------ sections
  newPage();
  for (const section of doc.sections) {
    const heading = wrap(section.title, f.serifBold, 20, bodyW);
    if (!room(heading.length * 26 + 90)) newPage();
    for (const l of heading) {
      y -= 22;
      text(l, MARGIN, y, f.serifBold, 20, ROSE);
      y -= 4;
    }
    page.drawLine({
      start: { x: MARGIN, y: y - 2 },
      end: { x: MARGIN + bodyW, y: y - 2 },
      thickness: 1,
      color: EUCALYPTUS,
    });
    y -= 16;
    for (const block of section.blocks) {
      if (block.type === "table") drawTable(block, section.title);
      else if (block.type === "facts") drawFacts(block);
      else drawText(block);
    }
    y -= 10;
  }

  // ------------------------------------------------------------------ footers
  const total = pages.length;
  pages.forEach((p, n) => {
    p.drawLine({
      start: { x: MARGIN, y: MARGIN + FOOTER - 12 },
      end: { x: MARGIN + bodyW, y: MARGIN + FOOTER - 12 },
      thickness: 0.5,
      color: RULE,
    });
    const left =
      wrap(
        `Private${doc.recipient ? ` · Prepared for ${doc.recipient}` : ""}`,
        f.sans,
        8,
        bodyW * 0.62,
      )[0] ?? "";
    const right = `Page ${n + 1} of ${total}`;
    p.drawText(left, { x: MARGIN, y: MARGIN + FOOTER - 26, size: 8, font: f.sans, color: MUTED });
    p.drawText(right, {
      x: MARGIN + bodyW - f.sans.widthOfTextAtSize(right, 8),
      y: MARGIN + FOOTER - 26,
      size: 8,
      font: f.sans,
      color: MUTED,
    });
    const second = `Snapshot of plan revision ${meta.revision} · ${generated} UTC`;
    p.drawText(second, { x: MARGIN, y: MARGIN + FOOTER - 38, size: 8, font: f.sans, color: MUTED });
    lines.push(left, right, second);
  });

  const bytes = await pdf.save({ useObjectStreams: false });
  return { bytes, pageCount: total, lines };
}
