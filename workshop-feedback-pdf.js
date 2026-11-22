'use strict';
// The Workshop Feedback report as a PDF (owner, 22 Nov 2026: "a new page /
// section for every workshop"), drawn as the report reads on screen: a first
// page with the totals and a row per workshop, then each workshop on a page
// of its own -- its response rate, each question's average and spread, the
// suggestions, and every response -- by registration number, never by name.
//
// feedback: the report's rep.feedback ({ questions, scale, workshops: [{ no,
// label, name, hall, present, responses, questions: [{ label, n, mean,
// counts }], suggestions: [{ regNo, text, at }], rows: [{ regNo, ratings,
// at }], summary: { overview, strengths, improvements } | null }] }); meta:
// { heading, subline, footer }. The summary (workshop-summary.js) is printed
// as it is, under the workshop's name, with no word of how it was made
// (owner, 22 Nov 2026).
const path = require('path');
const { ensureTextDecoders } = require('./report-pdf');

const FONT_DIR = path.join(__dirname, 'assets', 'fonts');
// The report page's palette, and the on-screen report's five rating colours.
const C = {
  ink: '#0f172a', text: '#1e293b', muted: '#64748b', navy: '#1c3549', head: '#244560', eyebrow: '#4338ca',
  rule: '#e2e8f0', tile: '#f8fafc', track: '#f1f5f9', thBg: '#f1f5f9', thInk: '#475569', zebra: '#f8fafc',
};
const SCALE_COLOURS = ['#dc2626', '#f59e0b', '#94a3b8', '#34d399', '#047857'];
// An average's chip, as on screen: 4.5 and over green, under 3.5 amber.
const tone = (v) => (v == null ? ['#f1f5f9', '#64748b'] : v >= 4.5 ? ['#d1fae5', '#065f46'] : v >= 3.5 ? ['#f1f5f9', '#1e293b'] : ['#fef3c7', '#78350f']);
const M = { top: 40, bottom: 46, left: 40, right: 40 };
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const fmt = (v) => (v == null ? '—' : v.toFixed(1));
const when = (ms) => new Date(Number(ms)).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });

let PDFDocument = null;
function loadPdfKit() {
  if (!PDFDocument) { ensureTextDecoders(); PDFDocument = require('pdfkit'); }
  return PDFDocument;
}

function renderWorkshopFeedbackPdf(feedback, meta = {}) {
  const PDF = loadPdfKit();
  const doc = new PDF({ size: 'A4', margins: M, bufferPages: true, info: { Title: meta.heading, Creator: meta.footer || meta.heading } });
  doc.registerFont('body', path.join(FONT_DIR, 'NotoSans-Regular.ttf'));
  doc.registerFont('bold', path.join(FONT_DIR, 'NotoSans-Bold.ttf'));
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });

  const X = M.left;
  const W = doc.page.width - M.left - M.right;
  const bottom = () => doc.page.height - M.bottom;
  const ws = feedback.workshops || [];
  const scale = feedback.scale || [];
  const short = ['Relevance', 'Facilitation', 'Use'];
  let y = M.top;
  const newPage = () => { doc.addPage(); y = M.top; };
  const textH = (t, w, font, size, opts = {}) => doc.font(font).fontSize(size).heightOfString(String(t || ' '), { width: w, ...opts });
  const chip = (v, x, yy, w = 34, h = 16) => {
    const [bg, ink] = tone(v);
    doc.roundedRect(x, yy, w, h, 3).fill(bg);
    doc.font('bold').fontSize(8.5).fillColor(ink).text(fmt(v), x, yy + 3.2, { width: w, align: 'center', lineBreak: false });
  };
  const bar = (x, yy, w, h, part, whole) => {
    doc.roundedRect(x, yy, w, h, h / 2).fill(C.track);
    if (whole && part) doc.roundedRect(x, yy, Math.max(h, (w * part) / whole), h, h / 2).fill(C.navy);
  };

  // --- Page 1: the totals and a row per workshop ------------------------------
  doc.font('bold').fontSize(16).fillColor(C.ink).text(meta.heading || 'Workshop Feedback', X, y, { width: W });
  y = doc.y + 1;
  doc.font('body').fontSize(8.5).fillColor(C.muted).text(meta.subline || '', X, y, { width: W });
  y = doc.y + 4;
  doc.font('body').fontSize(9).fillColor(C.text).text('Responses by registration number, never by name. Asked of those marked present, not the workshop’s own faculty. Each workshop follows on a page of its own.', X, y, { width: W });
  y = doc.y + 12;

  const responses = ws.reduce((n, w) => n + w.responses, 0);
  const present = ws.reduce((n, w) => n + w.present, 0);
  let sum = 0;
  let cnt = 0;
  ws.forEach((w) => w.questions.forEach((q) => { if (q.mean != null) { sum += q.mean * q.n; cnt += q.n; } }));
  const avg = cnt ? Math.round((sum / cnt) * 10) / 10 : null;
  const suggestions = ws.reduce((n, w) => n + w.suggestions.length, 0);
  const tiles = [['Responses', String(responses), `of ${present} present · ${pct(responses, present)}%`],
    ['Average, all questions', fmt(avg), 'out of 5'], ['Suggestions written', String(suggestions), '']];
  const gap = 10;
  const tw = (W - gap * 2) / 3;
  tiles.forEach(([label, big, small], i) => {
    const tx = X + i * (tw + gap);
    doc.roundedRect(tx, y, tw, 58, 6).fillAndStroke(C.tile, C.rule);
    doc.font('body').fontSize(8.5).fillColor(C.muted).text(label, tx + 10, y + 8, { width: tw - 20, lineBreak: false });
    doc.font('bold').fontSize(16).fillColor(C.ink).text(big, tx + 10, y + 18, { lineBreak: false });
    if (small) doc.font('body').fontSize(8.5).fillColor(C.muted).text(small, tx + 10, y + 40, { width: tw - 20, lineBreak: false });
  });
  y += 58 + 18;

  // The table of workshops: name and hall, response rate, three averages.
  const CW = 58;   // each average's column, wide enough for its heading
  const cName = W - 130 - 3 * CW;
  const cRate = 120;
  const head = () => {
    doc.rect(X, y, W, 18).fill(C.thBg);
    doc.font('bold').fontSize(7).fillColor(C.thInk);
    doc.text('WORKSHOP', X + 6, y + 5.5, { width: cName - 12, characterSpacing: 0.3, lineBreak: false });
    doc.text('RESPONDED', X + cName, y + 5.5, { width: cRate, characterSpacing: 0.3, lineBreak: false });
    short.forEach((s, i) => doc.text(s.toUpperCase(), X + cName + cRate + 10 + i * CW, y + 5.5, { width: CW, align: 'center', lineBreak: false }));
    y += 18;
  };
  head();
  ws.forEach((w, i) => {
    const title = `${w.no ? `${w.no}. ` : ''}${w.name}`;
    const nameH = textH(title, cName - 12, 'bold', 9.5) + (w.hall ? 11 : 0);
    const h = Math.max(34, nameH + 12);
    if (y + h > bottom()) { newPage(); head(); }
    if (i % 2 === 1) doc.rect(X, y, W, h).fill(C.zebra);
    doc.moveTo(X, y + h).lineTo(X + W, y + h).lineWidth(0.5).strokeColor(C.rule).stroke();
    doc.font('bold').fontSize(9.5).fillColor(C.ink).text(title, X + 6, y + 6, { width: cName - 12 });
    if (w.hall) doc.font('body').fontSize(7.5).fillColor(C.muted).text(w.hall, X + 6, doc.y, { width: cName - 12, lineBreak: false });
    if (w.present) {
      bar(X + cName, y + h / 2 - 7, cRate - 12, 6, w.responses, w.present);
      doc.font('body').fontSize(7.5).fillColor(C.muted).text(`${w.responses} of ${w.present} · ${pct(w.responses, w.present)}%`, X + cName, y + h / 2 + 2, { width: cRate, lineBreak: false });
    } else {
      doc.font('body').fontSize(7.5).fillColor(C.muted).text('No one marked present yet', X + cName, y + h / 2 - 4, { width: cRate, lineBreak: false });
    }
    w.questions.forEach((q, k) => chip(q.mean, X + cName + cRate + 10 + k * CW + (CW - 34) / 2, y + h / 2 - 8));
    y += h;
  });
  if (!ws.length) doc.font('body').fontSize(9).fillColor(C.muted).text('No workshops.', X, y + 8);

  // --- A page for each workshop -----------------------------------------------
  ws.forEach((w) => {
    newPage();
    const eyebrow = [w.label, w.hall].filter(Boolean).join(' · ');
    if (eyebrow) {
      doc.font('bold').fontSize(8).fillColor(C.eyebrow).text(eyebrow.toUpperCase(), X, y, { width: W, characterSpacing: 0.6 });
      y = doc.y + 2;
    }
    doc.font('bold').fontSize(16).fillColor(C.ink).text(w.name, X, y, { width: W });
    y = doc.y + 6;
    // Who answered, as a bar.
    const rate = w.present ? `${w.responses} of ${w.present} present responded · ${pct(w.responses, w.present)}%` : 'No one marked present yet';
    if (w.present) bar(X, y + 3, 160, 7, w.responses, w.present);
    doc.font('body').fontSize(9).fillColor(C.text).text(rate, X + (w.present ? 170 : 0), y, { width: W - 170, lineBreak: false });
    y += 22;
    doc.moveTo(X, y).lineTo(X + W, y).lineWidth(0.8).strokeColor(C.rule).stroke();
    y += 12;

    // The summary, when one has been made: the overview, then what worked
    // and what to improve side by side.
    if (w.summary) {
      const s = w.summary;
      const pad = 12;
      const inner = W - pad * 2;
      const colW = (inner - 16) / 2;
      const listH = (items) => (items.length ? 15 + items.reduce((h, t) => h + textH(t, colW - 10, 'body', 9) + 3, 0) : 0);
      const overH = textH(s.overview, inner, 'body', 10, { lineGap: 1.5 });
      const listsH = Math.max(listH(s.strengths), listH(s.improvements));
      const boxH = pad + 14 + overH + (listsH ? 10 + listsH : 0) + pad - 4;
      if (y + boxH > bottom()) newPage();
      doc.roundedRect(X, y, W, boxH, 6).fillAndStroke(C.tile, C.rule);
      let sy = y + pad;
      doc.font('bold').fontSize(7.5).fillColor(C.thInk).text('SUMMARY', X + pad, sy, { characterSpacing: 0.6, lineBreak: false });
      sy += 14;
      doc.font('body').fontSize(10).fillColor(C.text).text(s.overview, X + pad, sy, { width: inner, lineGap: 1.5 });
      sy = doc.y + 10;
      const list = (title, items, x) => {
        if (!items.length) return;
        doc.font('bold').fontSize(9).fillColor(C.ink).text(title, x, sy, { width: colW, lineBreak: false });
        let ly = sy + 15;
        items.forEach((t) => {
          doc.circle(x + 2.5, ly + 5, 1.6).fill(C.muted);
          doc.font('body').fontSize(9).fillColor(C.text).text(t, x + 10, ly, { width: colW - 10 });
          ly = doc.y + 3;
        });
      };
      list('What worked', s.strengths, X + pad);
      list('To improve', s.improvements, X + pad + colW + 16);
      y += boxH + 16;
    }

    // Each question: its average, and how the ratings spread.
    w.questions.forEach((q) => {
      doc.font('bold').fontSize(10.5).fillColor(C.ink).text(q.label, X, y, { width: W - 120, lineBreak: false });
      doc.font('bold').fontSize(18).fillColor(C.ink).text(fmt(q.mean), X + W - 110, y - 4, { width: 70, align: 'right', lineBreak: false });
      doc.font('body').fontSize(7.5).fillColor(C.muted).text(q.n ? `of 5 · ${q.n}` : 'of 5', X + W - 36, y + 4, { width: 36, lineBreak: false });
      y += 20;
      const total = q.counts.reduce((a, b) => a + b, 0);
      doc.roundedRect(X, y, W, 16, 3).fill(C.track);
      if (total) {
        let x = X;
        q.counts.forEach((c, i) => {
          if (!c) return;
          const segW = (W * c) / total;
          doc.rect(x, y, segW, 16).fill(SCALE_COLOURS[i]);
          if (segW >= 12) doc.font('bold').fontSize(7.5).fillColor('#ffffff').text(String(c), x, y + 4, { width: segW, align: 'center', lineBreak: false });
          x += segW;
        });
      } else {
        doc.font('body').fontSize(7.5).fillColor(C.muted).text('No ratings yet', X, y + 4, { width: W, align: 'center', lineBreak: false });
      }
      y += 26;
    });
    // The key to the colours.
    let kx = X;
    scale.forEach((s, i) => {
      doc.rect(kx, y + 1.5, 7, 7).fill(SCALE_COLOURS[i]);
      const label = `${s.value} ${s.label}`;
      doc.font('body').fontSize(7.5).fillColor(C.muted).text(label, kx + 10, y, { lineBreak: false });
      kx += 10 + doc.widthOfString(label) + 14;
    });
    y += 22;

    // The suggestions, each with its registration number.
    const section = (title) => {
      if (y + 40 > bottom()) newPage();
      doc.font('bold').fontSize(11).fillColor(C.head).text(title, X, y, { width: W });
      y = doc.y + 4;
    };
    section(`Suggestions · ${w.suggestions.length}`);
    if (!w.suggestions.length) {
      doc.font('body').fontSize(9).fillColor(C.muted).text('None yet.', X, y);
      y = doc.y + 10;
    }
    w.suggestions.forEach((s) => {
      const quote = `“${s.text}”`;
      const h = textH(quote, W - 14, 'body', 9.5) + 14;
      if (y + h > bottom()) { newPage(); doc.font('bold').fontSize(9).fillColor(C.muted).text(`${w.name} · suggestions, continued`, X, y, { width: W }); y = doc.y + 6; }
      doc.rect(X, y + 1, 2, h - 8).fill(C.rule);
      doc.font('body').fontSize(9.5).fillColor(C.text).text(quote, X + 10, y, { width: W - 14 });
      doc.font('body').fontSize(7.5).fillColor(C.muted).text(`${s.regNo || 'No reg no'} · ${when(s.at)}`, X + 10, doc.y + 1, { width: W - 14, lineBreak: false });
      y = doc.y + 10;
    });
    y += 6;

    // Every response: the three ratings and when it was given.
    section(`Responses · ${(w.rows || []).length}`);
    const cols = [['Reg No', 130, 'left'], ...short.map((s) => [s, 80, 'center']), ['Given', W - 130 - 240, 'right']];
    const tableHead = () => {
      doc.rect(X, y, W, 16).fill(C.thBg);
      let x = X;
      cols.forEach(([t, cw, al]) => {
        doc.font('bold').fontSize(7).fillColor(C.thInk).text(t.toUpperCase(), x + 6, y + 4.5, { width: cw - 12, align: al, characterSpacing: 0.3, lineBreak: false });
        x += cw;
      });
      y += 16;
    };
    if (!(w.rows || []).length) {
      doc.font('body').fontSize(9).fillColor(C.muted).text('None yet.', X, y);
      y = doc.y + 6;
    } else tableHead();
    (w.rows || []).forEach((r, i) => {
      const h = 18;
      if (y + h > bottom()) {
        newPage();
        doc.font('bold').fontSize(9).fillColor(C.muted).text(`${w.name} · responses, continued`, X, y, { width: W });
        y = doc.y + 6;
        tableHead();
      }
      if (i % 2 === 1) doc.rect(X, y, W, h).fill(C.zebra);
      let x = X;
      const cells = [r.regNo || '—', ...r.ratings.map((v) => (v == null ? '—' : String(v))), when(r.at)];
      cells.forEach((t, k) => {
        const [, cw, al] = cols[k];
        doc.font(k >= 1 && k <= 3 ? 'bold' : 'body').fontSize(8.5).fillColor(C.ink).text(t, x + 6, y + 4.5, { width: cw - 12, align: al, lineBreak: false });
        x += cw;
      });
      doc.moveTo(X, y + h).lineTo(X + W, y + h).lineWidth(0.5).strokeColor(C.rule).stroke();
      y += h;
    });
  });

  // The foot of every page: the report's name, and "Page n of m".
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.page.margins.bottom = 0;
    const fy = doc.page.height - M.bottom + 18;
    doc.font('body').fontSize(7).fillColor(C.muted);
    doc.text(meta.footer || '', X, fy, { width: W / 2, lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, X + W / 2, fy, { width: W / 2, align: 'right', lineBreak: false });
  }
  doc.end();
  return done;
}

module.exports = { renderWorkshopFeedbackPdf };
