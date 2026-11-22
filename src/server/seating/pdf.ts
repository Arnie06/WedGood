import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { toPdfText } from "@/domain/packages/document";
import type { PrintModel } from "@/domain/seating/print";

/**
 * Printable seating documents as real-text PDFs (built-in fonts, no images, no remote resources).
 * The table list is a flowing A4 or Letter document; escort cards are a sheet of cut-out cards
 * (two columns, five rows of 3.5 by 2 inch cards, with cut lines). Both contain names, tables,
 * seat numbers and meals only (see `buildPrintModel`). Output is deterministic for equal input.
 */

export type SeatingPaper = "a4" | "letter";
export type SeatingPdfKind = "table-list" | "cards";
export type SeatingPdfMeta = {
  /** Shown on the table list and in the document properties. */
  eventName: string;
  weddingName: string;
  /** Date-only (YYYY-MM-DD) or null. */
  eventDate: string | null;
  revision: number;
  generatedAt: string;
};
export type SeatingPdf = {
  bytes: Uint8Array;
  pageCount: number;
  /** Every string drawn, for tests (a PDF's text is otherwise compressed or encoded). */
  lines: string[];
  /** Characters the built-in fonts cannot show exactly (accents are simplified, others become "?"). */
  replaced: number;
};

const INK = rgb(0.106, 0.11, 0.102); // #1B1C1A
const MUTED = rgb(0.31, 0.3, 0.28);
const ROSE = rgb(0.545, 0.294, 0.345); // #8B4B58
const EUCALYPTUS = rgb(0.239, 0.353, 0.314); // #3D5A50
const RULE = rgb(0.82, 0.78, 0.73);
const HEAD_BG = rgb(0.945, 0.918, 0.878);

const SIZES: Record<SeatingPaper, [number, number]> = { a4: [595.28, 841.89], letter: [612, 792] };
const MARGIN = 54;
const FOOTER = 40;

const CARD_W = 252;
const CARD_H = 144;
const CARD_COLS = 2;
const CARD_ROWS = 5;

export async function renderSeatingPdf(
  kind: SeatingPdfKind,
  model: PrintModel,
  meta: SeatingPdfMeta,
  paper: SeatingPaper,
): Promise<SeatingPdf> {
  const pdf = await PDFDocument.create();
  const when = new Date(meta.generatedAt);
  // Distinct strings only, so measuring the same name at several sizes counts it once.
  const simplified = new Map<string, number>();
  const clean = (s: string) => {
    const r = toPdfText(s);
    simplified.set(s, r.replaced);
    return r.text;
  };
  const title = kind === "cards" ? "Escort cards" : "Table list";
  pdf.setTitle(clean(`${meta.eventName} · ${title}`));
  pdf.setAuthor("Wedding Workspace");
  pdf.setCreator("Wedding Workspace");
  pdf.setProducer("Wedding Workspace");
  pdf.setSubject(`Seating plan revision ${meta.revision}`);
  pdf.setLanguage("en-US");
  pdf.setCreationDate(when);
  pdf.setModificationDate(when);

  const f = {
    serifBold: await pdf.embedFont(StandardFonts.TimesRomanBold),
    serif: await pdf.embedFont(StandardFonts.TimesRoman),
    sans: await pdf.embedFont(StandardFonts.Helvetica),
    sansBold: await pdf.embedFont(StandardFonts.HelveticaBold),
  };
  const [pw, ph] = SIZES[paper];
  const lines: string[] = [];
  const pages: PDFPage[] = [];
  let page = pdf.addPage([pw, ph]);
  pages.push(page);

  const draw = (
    s: string,
    x: number,
    y: number,
    font: PDFFont,
    size: number,
    color = INK,
  ): void => {
    if (s === "") return;
    page.drawText(s, { x, y, size, font, color });
    lines.push(s);
  };
  const centered = (s: string, cx: number, y: number, font: PDFFont, size: number, color = INK) =>
    draw(s, cx - font.widthOfTextAtSize(s, size) / 2, y, font, size, color);

  /** Greedy word wrap; a word wider than the line is broken by characters. */
  const wrap = (raw: string, font: PDFFont, size: number, width: number): string[] => {
    const out: string[] = [];
    let line = "";
    for (const word of clean(raw).split(" ")) {
      if (word === "") continue;
      const trial = line === "" ? word : `${line} ${word}`;
      if (font.widthOfTextAtSize(trial, size) <= width) {
        line = trial;
        continue;
      }
      if (line !== "") out.push(line);
      line = "";
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
    if (line !== "" || out.length === 0) out.push(line);
    return out;
  };

  const generated = `${new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(when)} UTC`;

  if (kind === "table-list") drawTableList();
  else drawCards();

  function drawTableList(): void {
    const bodyW = pw - MARGIN * 2;
    const top = ph - MARGIN;
    const bottom = MARGIN + FOOTER;
    let y = top;
    const newPage = () => {
      page = pdf.addPage([pw, ph]);
      pages.push(page);
      y = top;
    };
    const room = (h: number) => y - h >= bottom;

    page.drawRectangle({ x: MARGIN, y: top - 3, width: 64, height: 3, color: ROSE });
    y = top - 36;
    for (const l of wrap(`${meta.eventName} · Table list`, f.serifBold, 24, bodyW)) {
      draw(l, MARGIN, y, f.serifBold, 24);
      y -= 30;
    }
    const date = meta.eventDate
      ? new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" }).format(
          new Date(`${meta.eventDate}T00:00:00Z`),
        )
      : "Date not set";
    for (const l of wrap(`${meta.weddingName} · ${date}`, f.sans, 11, bodyW)) {
      draw(l, MARGIN, y, f.sans, 11, MUTED);
      y -= 16;
    }
    y -= 8;
    const seatedCount = model.tables.reduce((n, t) => n + t.guests.length, 0);
    const summary = `${seatedCount} ${seatedCount === 1 ? "guest" : "guests"} at ${model.tables.length} ${
      model.tables.length === 1 ? "table" : "tables"
    }${model.unseated.length > 0 ? `, ${model.unseated.length} not seated yet` : ""}.`;
    draw(summary, MARGIN, y, f.sans, 10.5, MUTED);
    y -= 26;

    const size = 10.5;
    const lh = 16;
    const seatW = 46;
    const mealW = model.includeMeals ? Math.min(190, bodyW * 0.36) : 0;
    const nameW = bodyW - seatW - mealW;

    if (model.tables.length === 0) {
      draw("No tables yet.", MARGIN, y, f.sans, size, MUTED);
      y -= lh;
    }
    for (const t of model.tables) {
      const heading = `${t.label} · ${t.guests.length} of ${t.capacity} ${
        t.capacity === 1 ? "seat" : "seats"
      }`;
      // Keep a heading with its header row and at least one guest.
      if (!room(26 + lh + 6 + lh * 2)) newPage();
      for (const l of wrap(heading, f.serifBold, 15, bodyW)) {
        y -= 15;
        draw(l, MARGIN, y, f.serifBold, 15, ROSE);
        y -= 4;
      }
      y -= 6;
      const header = () => {
        page.drawRectangle({ x: MARGIN, y: y - lh, width: bodyW, height: lh, color: HEAD_BG });
        draw("Seat", MARGIN + 5, y - lh + 5, f.sansBold, 9.5);
        draw("Guest", MARGIN + seatW, y - lh + 5, f.sansBold, 9.5);
        if (model.includeMeals) draw("Meal", MARGIN + seatW + nameW, y - lh + 5, f.sansBold, 9.5);
        y -= lh;
      };
      header();
      if (t.guests.length === 0) {
        y -= lh;
        draw("Empty", MARGIN + seatW, y + 5, f.sans, size, MUTED);
      }
      for (const g of t.guests) {
        const nameLines = wrap(
          `${g.name}${g.tentative ? " (tentative)" : ""}`,
          f.sans,
          size,
          nameW - 8,
        );
        const mealLines = g.meal ? wrap(g.meal, f.sans, size, mealW - 8) : [""];
        const count = Math.max(nameLines.length, mealLines.length);
        const h = count * lh + 2;
        if (!room(h)) {
          newPage();
          header();
        }
        if (g.seat !== null) draw(String(g.seat), MARGIN + 5, y - lh + 5, f.sans, size);
        nameLines.forEach((l, n) => draw(l, MARGIN + seatW, y - lh + 5 - n * lh, f.sans, size));
        mealLines.forEach((l, n) =>
          draw(l, MARGIN + seatW + nameW, y - lh + 5 - n * lh, f.sans, size),
        );
        y -= h;
        page.drawLine({
          start: { x: MARGIN, y },
          end: { x: MARGIN + bodyW, y },
          thickness: 0.4,
          color: RULE,
        });
      }
      y -= 20;
    }

    if (model.unseated.length > 0) {
      if (!room(60)) newPage();
      draw("Not seated yet", MARGIN, y - 15, f.serifBold, 15, EUCALYPTUS);
      y -= 15 + 14;
      for (const name of model.unseated) {
        for (const l of wrap(name, f.sans, size, bodyW)) {
          if (!room(lh)) newPage();
          y -= lh;
          draw(l, MARGIN, y + 5, f.sans, size);
        }
      }
    }

    pages.forEach((p, n) => {
      const prev = page;
      page = p;
      p.drawLine({
        start: { x: MARGIN, y: MARGIN + FOOTER - 12 },
        end: { x: MARGIN + bodyW, y: MARGIN + FOOTER - 12 },
        thickness: 0.5,
        color: RULE,
      });
      const left = `Private · Seating plan revision ${meta.revision} · ${generated}`;
      const right = `Page ${n + 1} of ${pages.length}`;
      draw(left, MARGIN, MARGIN + FOOTER - 26, f.sans, 8, MUTED);
      draw(
        right,
        MARGIN + bodyW - f.sans.widthOfTextAtSize(right, 8),
        MARGIN + FOOTER - 26,
        f.sans,
        8,
        MUTED,
      );
      if (n === pages.length - 1 && model.tentativeCount > 0) {
        draw(
          "Tentative guests have not answered yet and may change.",
          MARGIN,
          MARGIN + FOOTER - 37,
          f.sans,
          8,
          MUTED,
        );
      }
      page = prev;
    });
  }

  function drawCards(): void {
    const gridW = CARD_W * CARD_COLS;
    const gridH = CARD_H * CARD_ROWS;
    const left = (pw - gridW) / 2;
    const bottomEdge = (ph - gridH) / 2;
    const perPage = CARD_COLS * CARD_ROWS;
    const total = Math.max(1, Math.ceil(model.cards.length / perPage));

    for (let p = 0; p < total; p += 1) {
      if (p > 0) {
        page = pdf.addPage([pw, ph]);
        pages.push(page);
      }
      // Cut lines: the full grid outline plus the inner dividers.
      for (let c = 0; c <= CARD_COLS; c += 1) {
        page.drawLine({
          start: { x: left + c * CARD_W, y: bottomEdge },
          end: { x: left + c * CARD_W, y: bottomEdge + gridH },
          thickness: 0.4,
          color: RULE,
        });
      }
      for (let r = 0; r <= CARD_ROWS; r += 1) {
        page.drawLine({
          start: { x: left, y: bottomEdge + r * CARD_H },
          end: { x: left + gridW, y: bottomEdge + r * CARD_H },
          thickness: 0.4,
          color: RULE,
        });
      }
      const slice = model.cards.slice(p * perPage, (p + 1) * perPage);
      slice.forEach((card, i) => {
        const col = i % CARD_COLS;
        const row = Math.floor(i / CARD_COLS);
        const cx = left + col * CARD_W + CARD_W / 2;
        const cellTop = bottomEdge + gridH - row * CARD_H;
        const innerW = CARD_W - 40;
        // Largest name size, down to 12pt, that fits in at most two lines.
        let size = 22;
        let nameLines = wrap(card.name, f.serifBold, size, innerW);
        while (
          (nameLines.length > 2 ||
            nameLines.some((l) => f.serifBold.widthOfTextAtSize(l, size) > innerW)) &&
          size > 12
        ) {
          size -= 1;
          nameLines = wrap(card.name, f.serifBold, size, innerW);
        }
        const lh = size * 1.15;
        // Table name: shrink to fit one line, then cut with "..." rather than overflow the card.
        let tableSize = 15;
        let tableText = clean(card.table);
        while (f.sansBold.widthOfTextAtSize(tableText, tableSize) > innerW && tableSize > 10)
          tableSize -= 1;
        while (f.sansBold.widthOfTextAtSize(tableText, tableSize) > innerW && tableText.length > 1)
          tableText = `${tableText.slice(0, -4).trimEnd()}...`;
        // Meal: up to two lines; a longer one is cut with "...".
        const mealLines = card.meal ? wrap(card.meal, f.sans, 9.5, innerW) : [];
        if (mealLines.length > 2) {
          const second = mealLines[1] ?? "";
          let cut = second;
          while (f.sans.widthOfTextAtSize(`${cut}...`, 9.5) > innerW && cut.length > 1)
            cut = cut.slice(0, -1).trimEnd();
          mealLines.length = 2;
          mealLines[1] = `${cut}...`;
        }
        const blockH =
          nameLines.length * lh + 6 + 18 + (card.seat !== null ? 14 : 0) + mealLines.length * 12;
        let y = cellTop - (CARD_H - blockH) / 2 - size;
        for (const l of nameLines) {
          centered(l, cx, y, f.serifBold, size);
          y -= lh;
        }
        y -= 6;
        page.drawRectangle({ x: cx - 18, y: y + 4, width: 36, height: 1.2, color: ROSE });
        y -= 18;
        centered(tableText, cx, y, f.sansBold, tableSize, ROSE);
        if (card.seat !== null) {
          y -= 14;
          centered(`Seat ${card.seat}`, cx, y, f.sans, 10, MUTED);
        }
        for (const l of mealLines) {
          y -= 12;
          centered(l, cx, y, f.sans, 9.5, MUTED);
        }
      });
    }
    pages.forEach((p, n) => {
      const prev = page;
      page = p;
      const note = `Escort cards · Seating plan revision ${meta.revision} · ${generated} · Page ${n + 1} of ${pages.length}`;
      centered(note, pw / 2, Math.max(14, bottomEdge / 2 - 3), f.sans, 7.5, MUTED);
      if (n === pages.length - 1 && model.cards.length === 0) {
        centered("No seated guests yet.", pw / 2, ph / 2, f.sans, 12, MUTED);
      }
      page = prev;
    });
  }

  const replaced = [...simplified.values()].reduce((a, n) => a + n, 0);
  if (replaced > 0) {
    const first = pages[0];
    if (first) {
      const prev = page;
      page = first;
      centered(
        "Some characters can't be shown in this PDF and were simplified.",
        pw / 2,
        8,
        f.sans,
        7,
        MUTED,
      );
      page = prev;
    }
  }

  const bytes = await pdf.save({ useObjectStreams: false });
  return { bytes, pageCount: pages.length, lines, replaced };
}
