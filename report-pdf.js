'use strict';
// Admin reports as a real PDF file, built on the server.
//
// Reports used to be an HTML page the browser printed to PDF, and Safari
// printed every one of them blank -- a preview that rendered, then emptied a
// moment later, even for the one-page Summary. Nothing on the page could be
// shown to cause it, and Safari was not available to test a fix against, so
// the PDF is no longer the browser's to make: this draws it with pdfkit and
// the browser only downloads the file.
//
// Noto Sans rather than the web pages' Source Sans 3, because Source Sans 3
// has no rupee sign (U+20B9) and every money figure in a report carries one.
// Both are bundled under assets/fonts (SIL OFL, see OFL.txt there), so
// nothing is fetched when a PDF is made.
const path = require('path');

const FONT_DIR = path.join(__dirname, 'assets', 'fonts');

// The report page's palette, so the PDF reads as the same document.
const C = {
  ink: '#0f172a', muted: '#64748b', head: '#244560', rule: '#e2e8f0',
  thBg: '#f1f5f9', thInk: '#475569', zebra: '#f8fafc',
};
const MARGIN = { top: 34, bottom: 40, left: 34, right: 34 };
const PAD_X = 5;
const PAD_Y = 4;
const CELL_SIZE = 8;
const TH_SIZE = 6.8;
const TH_SPACING = 0.3;

// fontkit (pdfkit's font engine) builds a TextDecoder('ascii') as it loads,
// and decodes font-name strings as UTF-16BE. A Node build with small ICU --
// the host Node 16 the test suite runs on -- supports neither, and fontkit
// throws before anything is drawn. Production runs Node 24 with full ICU, so
// there this never installs anything. It is only installed at all when a PDF
// is actually requested, and only replaces the decoder for the encodings the
// built-in one cannot handle; every other encoding goes to the original.
function ensureTextDecoders() {
  try { new TextDecoder('ascii'); return; } catch (e) { /* small-icu build */ }
  const Native = TextDecoder;
  const BYTE = new Set(['ascii', 'us-ascii', 'latin1', 'iso-8859-1', 'windows-1252']);
  globalThis.TextDecoder = class TextDecoder {
    constructor(enc = 'utf-8', opts) {
      this.encoding = String(enc).toLowerCase();
      if (BYTE.has(this.encoding)) this.mode = 'latin1';
      else if (this.encoding === 'utf-16be') this.mode = 'utf16be';
      else this.inner = new Native(enc, opts);
    }

    decode(input) {
      if (this.inner) return this.inner.decode(input);
      if (!input) return '';
      const bytes = ArrayBuffer.isView(input)
        ? Buffer.from(input.buffer, input.byteOffset, input.byteLength) : Buffer.from(input);
      if (this.mode === 'latin1') return bytes.toString('latin1');
      const even = Buffer.from(bytes.subarray(0, bytes.length - (bytes.length % 2)));
      return even.swap16().toString('utf16le');
    }
  };
}

let PDFDocument = null;
function loadPdfKit() {
  if (!PDFDocument) {
    ensureTextDecoders();
    PDFDocument = require('pdfkit');
  }
  return PDFDocument;
}

// A column whose every value is a number, an amount or a share reads better
// right-aligned, the way a ledger is set.
const NUMERIC = /^(?:[₹\-−+]?\s?[\d,]+(?:\.\d+)?%?|<1%|>99%|—|-)$/;
function numericColumns(sec) {
  return sec.columns.map((_, i) => {
    const vals = sec.rows.map((r) => String(r[i] == null ? '' : r[i]).trim()).filter(Boolean);
    return vals.length > 0 && vals.every((v) => NUMERIC.test(v)) && vals.some((v) => /\d/.test(v));
  });
}

// Widths that fill the page like the HTML table's width:100%. Each column
// wants the width of its longest value; if they all fit, they share the
// spare width in proportion. If not, every column keeps at least its longest
// single word (so nothing breaks mid-word unless it must) and the rest of
// the space goes to whichever columns wanted more.
function columnWidths(doc, sec, total) {
  const natural = [];
  const minimum = [];
  // Headings are drawn letter-spaced; widthOfString does not count that, so
  // it is added here -- without it a heading like AMOUNT is measured a hair
  // narrower than it is drawn, and wraps mid-word.
  const spaced = (w) => doc.widthOfString(w) + TH_SPACING * w.length + 1;
  sec.columns.forEach((col, i) => {
    doc.font('bold').fontSize(TH_SIZE);
    const head = spaced(String(col).toUpperCase());
    const headWord = Math.max(...String(col).toUpperCase().split(/\s+/).map(spaced));
    doc.font('body').fontSize(CELL_SIZE);
    let longest = 0;
    let longestWord = 0;
    for (const r of sec.rows) {
      const v = String(r[i] == null ? '' : r[i]);
      if (!v) continue;
      longest = Math.max(longest, doc.widthOfString(v));
      for (const w of v.split(/\s+/)) longestWord = Math.max(longestWord, doc.widthOfString(w));
    }
    natural.push(Math.max(head, longest) + 2 * PAD_X);
    // A long token such as an email should not claim a whole column's
    // minimum: past a third of the page it may break.
    minimum.push(Math.min(Math.max(headWord, longestWord) + 2 * PAD_X, total / 3));
  });
  const sumN = natural.reduce((a, b) => a + b, 0);
  if (sumN <= total) return natural.map((n) => (n * total) / sumN);
  const sumM = minimum.reduce((a, b) => a + b, 0);
  if (sumM >= total) return minimum.map((m) => (m * total) / sumM);
  const give = (total - sumM) / (sumN - sumM);
  return natural.map((n, i) => minimum[i] + (n - minimum[i]) * give);
}

function renderReportPdf(rep, meta) {
  const PDF = loadPdfKit();
  const doc = new PDF({
    size: 'A4', layout: 'landscape', margins: MARGIN, bufferPages: true,
    info: { Title: meta.heading, Creator: meta.footer || meta.heading },
  });
  doc.registerFont('body', path.join(FONT_DIR, 'NotoSans-Regular.ttf'));
  doc.registerFont('bold', path.join(FONT_DIR, 'NotoSans-Bold.ttf'));

  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = MARGIN.left;
  const width = doc.page.width - MARGIN.left - MARGIN.right;
  const bottom = () => doc.page.height - MARGIN.bottom;

  doc.font('bold').fontSize(14).fillColor(C.ink).text(meta.heading, left, MARGIN.top, { width });
  doc.moveDown(0.15);
  doc.font('body').fontSize(8.5).fillColor(C.muted).text(meta.subline, { width });
  let y = doc.y + 8;

  const cellHeight = (text, w, font, size, opts = {}) => {
    doc.font(font).fontSize(size);
    return doc.heightOfString(text || ' ', { width: w - 2 * PAD_X, ...opts }) + 2 * PAD_Y;
  };

  for (const sec of rep.sections) {
    const widths = columnWidths(doc, sec, width);
    const numeric = numericColumns(sec);
    const xs = widths.reduce((acc, w, i) => { acc.push(i === 0 ? left : acc[i - 1] + widths[i - 1]); return acc; }, []);
    const heads = sec.columns.map((c) => String(c).toUpperCase());
    const headH = Math.max(...heads.map((h, i) => cellHeight(h, widths[i], 'bold', TH_SIZE, { characterSpacing: TH_SPACING })));

    const drawHeader = () => {
      doc.rect(left, y, width, headH).fill(C.thBg);
      heads.forEach((h, i) => {
        doc.rect(xs[i], y, widths[i], headH).lineWidth(0.5).stroke(C.rule);
        doc.font('bold').fontSize(TH_SIZE).fillColor(C.thInk)
          .text(h, xs[i] + PAD_X, y + PAD_Y, { width: widths[i] - 2 * PAD_X, characterSpacing: TH_SPACING, align: numeric[i] ? 'right' : 'left' });
      });
      y += headH;
    };

    const rowTexts = sec.rows.map((r) => sec.columns.map((_, i) => String(r[i] == null ? '' : r[i])));
    const rowHeights = rowTexts.map((cells) => Math.max(...cells.map((t, i) => cellHeight(t, widths[i], 'body', CELL_SIZE))));
    const titleH = sec.name ? 22 : 0;

    // Never strand a section title, or a header row, at the foot of a page:
    // start the section on a new page unless its title, header and first row
    // all fit.
    const firstRowH = rowHeights.length ? rowHeights[0] : cellHeight('No records', width, 'body', CELL_SIZE);
    if (y + titleH + headH + firstRowH > bottom()) { doc.addPage(); y = MARGIN.top; }

    if (sec.name) {
      y += 6;
      doc.font('bold').fontSize(10.5).fillColor(C.head).text(sec.name, left, y, { continued: rep.kind !== 'summary', width });
      if (rep.kind !== 'summary') doc.font('body').fontSize(8.5).fillColor(C.muted).text(`  (${sec.rows.length})`);
      y = doc.y + 4;
    }
    drawHeader();

    if (!rowTexts.length) {
      const h = cellHeight('No records', width, 'body', CELL_SIZE);
      doc.rect(left, y, width, h).lineWidth(0.5).stroke(C.rule);
      doc.font('body').fontSize(CELL_SIZE).fillColor('#94a3b8').text('No records', left, y + PAD_Y, { width, align: 'center' });
      y += h;
    }

    rowTexts.forEach((cells, r) => {
      const h = rowHeights[r];
      // A row is never split across two pages; the header repeats on the new one.
      if (y + h > bottom()) { doc.addPage(); y = MARGIN.top; drawHeader(); }
      if (r % 2 === 1) doc.rect(left, y, width, h).fill(C.zebra);
      cells.forEach((t, i) => {
        doc.rect(xs[i], y, widths[i], h).lineWidth(0.5).stroke(C.rule);
        doc.font('body').fontSize(CELL_SIZE).fillColor(C.ink)
          .text(t, xs[i] + PAD_X, y + PAD_Y, { width: widths[i] - 2 * PAD_X, align: numeric[i] ? 'right' : 'left', features: ['tnum'] });
      });
      y += h;
    });
    y += 6;
  }

  // "Page n of m" on every page. The footer sits inside the bottom margin, so
  // the margin is lifted while it is written -- otherwise pdfkit takes text
  // below the margin as overflow and starts a blank page for it.
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const saved = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const fy = doc.page.height - MARGIN.bottom + 14;
    doc.font('body').fontSize(7).fillColor(C.muted);
    doc.text(meta.footer || '', left, fy, { width: width / 2, lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, left + width / 2, fy, { width: width / 2, align: 'right', lineBreak: false });
    doc.page.margins.bottom = saved;
  }

  doc.end();
  return done;
}

module.exports = { renderReportPdf, ensureTextDecoders };
