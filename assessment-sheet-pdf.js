// Judges' assessment sheets (owner, 21 Nov 2026, from their template "ORAL
// PAPER ASSESSMENT", pivoted at their ask): one sheet for each session --
// each hall for the oral and award papers, each screen for the e-posters --
// a row for each presenter in running order, prefilled (name, reg no, time,
// title), and a column for each of the four criteria (25 marks each) and
// the total out of 100, to be filled in by hand. A long list carries on to
// the next page with the heading row repeated.
//
// sheets: [{ heading, venue, session, judges: [name], papers: [{ place, time,
// presenter, regNo, title }] }]; meta: { acronym }.
const path = require('path');
const { ensureTextDecoders } = require('./report-pdf');

const fs = require('fs');
const FONT_DIR = path.join(__dirname, 'assets', 'fonts');
const LOGO = path.join(__dirname, 'public', 'website', 'img', 'nqocn-mgims-logo.png');
// The portal's own colours (owner, 21 Nov 2026: "as per the design of our
// portal"): navy and gold, slate for lines and quiet text.
const NAVY = '#1c3549';
const GOLD = '#b08d3c';
const GOLD_50 = '#faf5e8';
const INK = '#1e293b';
const MUTED = '#64748b';
const LINE = '#cbd5e1';
const ZEBRA = '#f8fafc';
const CREAM = GOLD_50;
const CRITERIA = ['Relevance / Importance of topic', 'Contents of presentation', 'Presentation style / Confidence / Fluency', 'Discussion / Subject clarity'];

let PDFDocument = null;
function loadPdfKit() {
  if (!PDFDocument) { ensureTextDecoders(); PDFDocument = require('pdfkit'); }
  return PDFDocument;
}

function renderAssessmentSheets(sheets, meta = {}) {
  const PDF = loadPdfKit();
  const M = { top: 30, bottom: 30, left: 36, right: 36 };
  const doc = new PDF({ size: 'A4', layout: 'landscape', margins: M, bufferPages: true, autoFirstPage: false,
    info: { Title: `${meta.acronym || 'Conference'} assessment sheets` } });
  doc.registerFont('body', path.join(FONT_DIR, 'NotoSans-Regular.ttf'));
  doc.registerFont('bold', path.join(FONT_DIR, 'NotoSans-Bold.ttf'));
  const pad = 5;

  for (const sheet of sheets) {
    // Pivoted (owner, 21 Nov 2026): a row for each presenter, a column for
    // each scoring area, the total last.
    let page = 0;
    let y = 0;
    let W = 0;
    let X0 = 0;
    let cols = [];
    const startPage = () => {
      doc.addPage();
      page += 1;
      W = doc.page.width - M.left - M.right;
      X0 = M.left;
      y = M.top;
      // The portal's header: the logo, the sheet's name in navy, a gold rule.
      let logoOk = false;
      try { if (fs.existsSync(LOGO)) { doc.image(LOGO, X0, y, { height: 26 }); logoOk = true; } } catch (e) { logoOk = false; }
      if (!logoOk) doc.font('bold').fontSize(12).fillColor(NAVY).text(meta.acronym || '', X0, y + 6, { lineBreak: false });
      doc.font('bold').fontSize(15).fillColor(NAVY).text(sheet.heading, X0, y + 3, { width: W, align: 'right', lineBreak: false });
      doc.font('body').fontSize(8.5).fillColor(MUTED).text(page > 1 ? `${sheet.venue} · continued` : `${meta.acronym || ''} · Judges' assessment sheet`, X0, y + 20, { width: W, align: 'right', lineBreak: false });
      y += 34;
      doc.rect(X0, y, W, 2).fill(GOLD);
      y += 10;
      if (page === 1) {
        // Venue, session and the judge, as label and value, in a quiet card.
        // The judges' names are not printed (owner, 21 Nov 2026): each
        // writes their own.
        // Venue and session wrap, never cut short (owner, 21 Nov 2026).
        const inner = W - 24;
        const wV = inner * 0.24;
        const wS = inner * 0.46;
        doc.font('bold').fontSize(10.5);
        const valH = Math.max(doc.heightOfString(sheet.venue || '', { width: wV - 10 }), doc.heightOfString(sheet.session || '', { width: wS - 10 }), 14);
        const cardH = Math.max(50, 21 + valH + 12);
        doc.roundedRect(X0, y, W, cardH, 8).fillAndStroke(ZEBRA, LINE);
        const field = (label, value, x, yy, w, blank) => {
          doc.font('bold').fontSize(7.5).fillColor(MUTED).text(label.toUpperCase(), x, yy, { width: w, characterSpacing: 0.6, lineBreak: false });
          if (blank) doc.moveTo(x, yy + 26).lineTo(x + w - 10, yy + 26).lineWidth(0.8).strokeColor(NAVY).stroke();
          else doc.font('bold').fontSize(10.5).fillColor(INK).text(value || '', x, yy + 11, { width: w - 10 });
        };
        field('Venue', sheet.venue, X0 + 12, y + 10, wV);
        field('Session', sheet.session, X0 + 12 + wV, y + 10, wS);
        field('Name of the judge', '', X0 + 12 + wV + wS, y + 10, inner - wV - wS, true);
        y += cardH + 8;
        doc.font('body').fontSize(9.5).fillColor(INK).text('Each criterion is worth 25 marks; the total is out of 100.', X0, y, { lineBreak: false });
        y += 18;
      }
      // Columns: #, presenter, title, the four criteria, the total.
      const crit = 80;
      const total = 66;
      const no = 26;
      const who = 165;
      const title = W - no - who - crit * CRITERIA.length - total;
      cols = [
        { key: 'no', w: no, head: '#' }, { key: 'who', w: who, head: 'Presenter' }, { key: 'title', w: title, head: 'Title' },
        ...CRITERIA.map((c) => ({ key: 'crit', w: crit, head: c, sub: '(25)' })), { key: 'total', w: total, head: 'TOTAL', sub: '(out of 100)' },
      ];
      let x = X0;
      for (const c of cols) { c.x = x; x += c.w; }
      // The heading row, cream as the template's.
      doc.font('bold').fontSize(8.5);
      const headH = Math.max(36, ...cols.map((c) => doc.heightOfString(c.head, { width: c.w - pad * 2 }) + (c.sub ? 11 : 0))) + pad * 2;
      doc.rect(X0, y, W, headH).fill(NAVY);
      for (const c of cols) {
        if (c.x > X0) doc.moveTo(c.x, y).lineTo(c.x, y + headH).lineWidth(0.7).strokeColor('#34506a').stroke();
        doc.font('bold').fontSize(8.5).fillColor('#ffffff').text(c.head, c.x + pad, y + pad, { width: c.w - pad * 2 });
        if (c.sub) doc.font('body').fontSize(7.5).fillColor('#d6b46a').text(c.sub, c.x + pad, doc.y, { width: c.w - pad * 2 });
      }
      y += headH;
    };
    const bottom = () => doc.page.height - M.bottom - 28;   // room for the signature
    startPage();
    for (const p of sheet.papers) {
      const c = Object.fromEntries(cols.map((x) => [x.key, x]));
      doc.font('bold').fontSize(9);
      let whoH = doc.heightOfString(p.presenter || '', { width: c.who.w - pad * 2 });
      doc.font('body').fontSize(7.5);
      whoH += p.regNo || p.time ? 11 : 0;   // one line: reg no · time
      const titleH = Math.min(doc.font('body').fontSize(8).heightOfString(p.title || '', { width: c.title.w - pad * 2 }), 30);
      const rowH = Math.max(36, whoH + pad * 2, titleH + pad * 2);
      if (y + rowH > bottom()) startPage();
      if (Number(p.place) % 2 === 0) doc.rect(X0, y, W, rowH).fill(ZEBRA);
      doc.lineWidth(0.7).strokeColor(LINE).rect(X0, y, W, rowH).stroke();
      for (const col of cols) if (col.x > X0) doc.moveTo(col.x, y).lineTo(col.x, y + rowH).stroke();
      doc.rect(c.total.x, y, c.total.w, rowH).fillOpacity(0.6).fill(CREAM).fillOpacity(1);
      doc.lineWidth(0.7).strokeColor(LINE).rect(c.total.x, y, c.total.w, rowH).stroke();
      doc.font('bold').fontSize(10).fillColor(NAVY).text(String(p.place), c.no.x + pad, y + pad, { width: c.no.w - pad * 2, lineBreak: false });
      let yy = y + pad;
      doc.font('bold').fontSize(9).fillColor(INK).text(p.presenter || '', c.who.x + pad, yy, { width: c.who.w - pad * 2 });
      yy = doc.y;
      const meta2 = [p.regNo, p.time].filter(Boolean).join(' · ');
      if (meta2) doc.font('body').fontSize(7.5).fillColor(MUTED).text(meta2, c.who.x + pad, yy + 1, { width: c.who.w - pad * 2, lineBreak: false });
      doc.font('body').fontSize(8).fillColor(INK).text(p.title || '', c.title.x + pad, y + pad, { width: c.title.w - pad * 2, height: 30, ellipsis: true });
      y += rowH;
    }
    const sy = Math.min(y + 12, doc.page.height - M.bottom - 18);
    doc.font('bold').fontSize(9.5).fillColor(NAVY).text('Signature of the judge', X0, sy, { lineBreak: false });
    doc.moveTo(X0 + 125, sy + 12).lineTo(X0 + 380, sy + 12).lineWidth(0.8).strokeColor(NAVY).stroke();
  }
  if (!sheets.length) {
    doc.addPage();
    doc.font('body').fontSize(12).fillColor(INK).text('No sessions to assess yet.', M.left, M.top);
  }
  // A small footer on every page.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    doc.font('body').fontSize(8).fillColor(MUTED).text(`${meta.acronym || ''} · Judges' assessment sheet`, M.left, doc.page.height - 22, { lineBreak: false });
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

module.exports = { renderAssessmentSheets, CRITERIA };
