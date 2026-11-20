// The scientific programme as a printable A4 PDF (owner, 20 Nov 2026):
// day by day, time by time -- each session with its hall, speakers and
// chairs; breaks and meals as a thin band. Drawn from the same rows as the
// website's programme page (website.js programmeDay), so the two agree.
// Served at /programme.pdf on the website's address and /website/programme.pdf.
const path = require('path');
const { ensureTextDecoders } = require('./report-pdf');

const FONT_DIR = path.join(__dirname, 'assets', 'fonts');
const NAVY = '#1c3549';
const GOLD = '#8a6d2b';
const INK = '#1e293b';
const MUTED = '#5b6b7a';
const RULE = '#d9e1e8';
const BAND = '#f3f0e6';

let PDFDocument = null;
function loadPdfKit() {
  if (!PDFDocument) { ensureTextDecoders(); PDFDocument = require('pdfkit'); }
  return PDFDocument;
}

// days: [{ label, rows: [{ kind: 'talks', time, items: [{ when, label, title,
// hall, speakers, chairs, chairLabel }] } | { kind: 'break', text }] }]
// meta: { conference, acronym, dates, venue, url }
function renderProgrammePdf(days, meta) {
  const PDF = loadPdfKit();
  const M = { top: 54, bottom: 50, left: 46, right: 46 };
  const doc = new PDF({ size: 'A4', layout: 'portrait', margins: M, bufferPages: true,
    info: { Title: `${meta.acronym || 'Conference'} Scientific Programme`, Author: meta.conference || '' } });
  doc.registerFont('body', path.join(FONT_DIR, 'NotoSans-Regular.ttf'));
  doc.registerFont('bold', path.join(FONT_DIR, 'NotoSans-Bold.ttf'));
  const W = doc.page.width - M.left - M.right;
  const bottom = () => doc.page.height - M.bottom;
  const TIME_W = 92;
  const BODY_X = M.left + TIME_W;
  const BODY_W = W - TIME_W;

  // The cover band on the first page.
  doc.rect(0, 0, doc.page.width, 118).fill(NAVY);
  doc.fillColor('#d6b46a').font('bold').fontSize(9).text(`${[meta.acronym, meta.venue].filter(Boolean).join('  ·  ').toUpperCase()}`, M.left, 30, { width: W, characterSpacing: 1.2 });
  doc.fillColor('#ffffff').font('bold').fontSize(17).text(meta.conference || 'Scientific Programme', M.left, 46, { width: W });
  doc.font('body').fontSize(11).fillColor('#dbe6ec').text(`Scientific Programme${meta.dates ? `  ·  ${meta.dates}` : ''}`, M.left, doc.y + 2, { width: W });
  doc.y = 140;

  const ensure = (h) => { if (doc.y + h > bottom()) { doc.addPage(); doc.y = M.top; } };
  // How tall an item will be, measured before drawing so it never splits.
  const measure = (it) => {
    let h = 0;
    doc.font('bold').fontSize(8);
    if (it.label) h += doc.heightOfString(it.label.toUpperCase(), { width: BODY_W, characterSpacing: 0.6 }) + 1;
    doc.font('bold').fontSize(11);
    h += doc.heightOfString(it.title, { width: BODY_W }) + 1;
    doc.font('body').fontSize(9);
    h += doc.heightOfString(`${it.when} · ${it.hall}`, { width: BODY_W }) + 2;
    if (it.speakers) h += doc.heightOfString(`Speakers: ${it.speakers}`, { width: BODY_W }) + 1;
    if (it.chairs) h += doc.heightOfString(`${it.chairLabel}: ${it.chairs}`, { width: BODY_W }) + 1;
    return h + 12;
  };

  days.forEach((day, di) => {
    if (di > 0) { doc.addPage(); doc.y = M.top; }
    ensure(40);
    doc.fillColor(NAVY).font('bold').fontSize(15).text(day.label, M.left, doc.y, { width: W });
    const ly = doc.y + 4;
    doc.moveTo(M.left, ly).lineTo(M.left + W, ly).lineWidth(1.2).strokeColor('#d6b46a').stroke();
    doc.y = ly + 10;
    for (const row of day.rows) {
      if (row.kind === 'break') {
        doc.font('body').fontSize(9);
        const h = doc.heightOfString(row.text, { width: W - 20 }) + 10;
        ensure(h + 6);
        const y = doc.y;
        doc.rect(M.left, y, W, h).fill(BAND);
        doc.fillColor(MUTED).font('body').fontSize(9).text(row.text, M.left + 10, y + 5, { width: W - 20 });
        doc.y = y + h + 6;
        continue;
      }
      row.items.forEach((it, i) => {
        const h = measure(it);
        ensure(h);
        const y = doc.y;
        if (i === 0) doc.fillColor(NAVY).font('bold').fontSize(10.5).text(row.time, M.left, y + 1, { width: TIME_W - 10 });
        doc.y = y;
        if (it.label) doc.fillColor(GOLD).font('bold').fontSize(8).text(it.label.toUpperCase(), BODY_X, doc.y, { width: BODY_W, characterSpacing: 0.6 });
        doc.fillColor(INK).font('bold').fontSize(11).text(it.title, BODY_X, doc.y + 1, { width: BODY_W });
        doc.fillColor(MUTED).font('body').fontSize(9).text(`${it.when} · ${it.hall}`, BODY_X, doc.y + 1, { width: BODY_W });
        if (it.speakers) {
          doc.fillColor(INK).font('bold').fontSize(9).text('Speakers: ', BODY_X, doc.y + 2, { width: BODY_W, continued: true })
            .font('body').text(it.speakers);
        }
        if (it.chairs) {
          doc.fillColor(INK).font('bold').fontSize(9).text(`${it.chairLabel}: `, BODY_X, doc.y + 1, { width: BODY_W, continued: true })
            .font('body').text(it.chairs);
        }
        const end = doc.y + 6;
        doc.moveTo(BODY_X, end).lineTo(M.left + W, end).lineWidth(0.5).strokeColor(RULE).stroke();
        doc.y = end + 6;
      });
    }
  });

  // Footers: where the latest is, and the page.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Below the bottom margin: let the footer sit there without a new page.
    doc.page.margins.bottom = 0;
    const y = doc.page.height - 34;
    doc.fillColor(MUTED).font('body').fontSize(8)
      .text(`${meta.acronym || ''} Scientific Programme${meta.url ? `  ·  The latest is always at ${meta.url}` : ''}`, M.left, y, { width: W - 70, lineBreak: false });
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, M.left + W - 70, y, { width: 70, align: 'right', lineBreak: false });
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

module.exports = { renderProgrammePdf };
