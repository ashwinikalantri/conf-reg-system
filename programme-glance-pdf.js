// The programme at a glance (owner, 20 Nov 2026: "design this to look like
// a published document"): A4 portrait, typeset -- a title block, running
// heads, thin rules, serif type. A day of many halls side by side (the
// workshops) is "The day" in order and a table of the workshops; a day of a
// few halls is a timetable -- the time, then a column for each hall, each
// cell the session's label, title and speakers, a long session spanning its
// rows ("until 12:00"), the meals and breaks as lines across. Sessions held
// anywhere else (field visits) are listed before it.
//
// sessions: [{ session_date, start_time, end_time, label, title, hall,
// hall_sort, meal, speakers }]; meta: { conference, acronym, venue, dates, url }.
const { ensureTextDecoders } = require('./report-pdf');

const INK = '#1a1f24';
const NAVY = '#1c3549';
const MUTED = '#5f6b75';
const RULE = '#b9c2ca';
const HAIR = '#dde3e8';
const SERIF = 'Times-Roman';
const SERIF_B = 'Times-Bold';
const SERIF_I = 'Times-Italic';
const SANS_B = 'Helvetica-Bold';

let PDFDocument = null;
function loadPdfKit() {
  if (!PDFDocument) { ensureTextDecoders(); PDFDocument = require('pdfkit'); }
  return PDFDocument;
}

const toMin = (hm) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(hm || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const clock = (min) => { const h = Math.floor(min / 60); return `${h % 12 || 12}:${String(min % 60).padStart(2, '0')}`; };
const ampm = (min) => (Math.floor(min / 60) < 12 ? 'am' : 'pm');
const t12 = (min) => `${clock(min)} ${ampm(min)}`;
const span = (a, b) => (ampm(a) === ampm(b) ? `${clock(a)}–${clock(b)} ${ampm(b)}` : `${t12(a)}–${t12(b)}`);
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dayParts = (iso) => { const d = new Date(`${iso}T00:00:00Z`); return { weekday: DAYS[d.getUTCDay()], date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` }; };
const isBreak = (s) => Number(s.meal) === 1 || (!s.label && /\b(break|breakfast|lunch|tea|registration|dinner)\b/i.test(s.title || ''));
// The standard PDF fonts read Windows-1252; anything outside it is left out.
const plain = (t) => String(t || '').replace(/[‐‑‒]/g, '-').replace(/[^\x20-\x7E -ÿ–—‘’“”•…]/g, '');

function renderGlancePdf(sessions, meta) {
  const PDF = loadPdfKit();
  const M = { top: 58, bottom: 48, left: 54, right: 54 };
  const doc = new PDF({ size: 'A4', layout: 'portrait', margins: M, bufferPages: true,
    info: { Title: `${meta.acronym || 'Conference'} Programme at a Glance`, Author: meta.conference || '' } });
  const PW = doc.page.width;
  const PH = doc.page.height;
  const X0 = M.left;
  const W = PW - M.left - M.right;
  const BOTTOM = PH - M.bottom;
  const newPage = () => { doc.addPage(); doc.y = M.top; };
  const ensure = (h) => { if (doc.y + h > BOTTOM) { newPage(); return true; } return false; };
  const caps = (text, x, y, opts = {}) => doc.font(SANS_B).fontSize(opts.size || 7).fillColor(opts.color || NAVY)
    .text(plain(text).toUpperCase(), x, y, { characterSpacing: opts.spacing == null ? 1.1 : opts.spacing, lineBreak: false, width: opts.width, align: opts.align, ellipsis: !!opts.width });

  // --- Title block ---
  doc.y = M.top - 8;
  const top = doc.y;
  caps(`${meta.acronym || ''}${meta.venue ? `  ·  ${meta.venue}` : ''}`, X0, top, { size: 7.5, width: W * 0.6 });
  if (meta.dates) caps(meta.dates, X0 + W * 0.6, top, { size: 7.5, width: W * 0.4, align: 'right' });
  doc.y = top;
  doc.font(SERIF_B).fontSize(27).fillColor(INK).text('Programme at a Glance', X0, doc.y + 12, { width: W });
  doc.font(SERIF_I).fontSize(12.5).fillColor(MUTED).text(plain(meta.conference || ''), X0, doc.y + 2, { width: W });
  const ry = doc.y + 10;
  doc.moveTo(X0, ry).lineTo(X0 + W, ry).lineWidth(1.4).strokeColor(INK).stroke();
  doc.moveTo(X0, ry + 3).lineTo(X0 + W, ry + 3).lineWidth(0.4).strokeColor(INK).stroke();
  doc.y = ry + 18;

  const dayHeading = (date, sub) => {
    ensure(70);
    const p = dayParts(date);
    const y0 = doc.y;
    caps(p.weekday, X0, y0, { size: 8, color: MUTED });
    doc.font(SERIF_B).fontSize(20).fillColor(NAVY).text(p.date, X0, y0 + 11, { width: W * 0.65, lineBreak: false });
    if (sub) doc.font(SERIF_I).fontSize(10.5).fillColor(MUTED).text(plain(sub), X0 + W * 0.4, y0 + 18, { width: W * 0.6, align: 'right', lineBreak: false });
    const y = y0 + 35;
    doc.moveTo(X0, y).lineTo(X0 + W, y).lineWidth(0.8).strokeColor(NAVY).stroke();
    doc.y = y + 10;
  };
  const sectionLabel = (text) => {
    ensure(28);
    caps(text, X0, doc.y, { size: 7.5, color: NAVY });
    doc.y += 13;
  };
  // A timed list: the time in a column of its own, then the event and where.
  const timedList = (items) => {
    for (const it of items) {
      const body = `${plain(it.text)}${it.where ? `  ${plain(it.where)}` : ''}`;
      doc.font(SERIF).fontSize(10);
      const h = Math.max(13, doc.heightOfString(body, { width: W - 110 }) + 3);
      ensure(h);
      const y = doc.y;
      doc.font(SERIF).fontSize(10).fillColor(MUTED).text(span(it.a, it.b), X0, y, { width: 100, lineBreak: false });
      doc.font(it.strong ? SERIF_B : SERIF).fontSize(10).fillColor(INK).text(plain(it.text), X0 + 110, y, { width: W - 110, continued: !!it.where });
      if (it.where) doc.font(SERIF_I).fillColor(MUTED).text(`  ${plain(it.where)}`);
      doc.y = Math.max(doc.y, y + h);
    }
    doc.y += 8;
  };

  // Meals and breaks served in more than one place, once.
  function breakItems(breaks) {
    const out = new Map();
    for (const b of breaks) {
      const k = `${b.a}|${b.b}|${b.title}`;
      if (!out.has(k)) out.set(k, { a: b.a, b: b.b, text: b.title, where: [] });
      out.get(k).where.push(b.hall);
    }
    return [...out.values()].map((x) => ({ ...x, where: [...new Set(x.where)].join(' and ') }));
  }

  // --- The workshop day ---
  function workshopDay(date, talks, breaks) {
    const num = (s) => Number((/\d+/.exec(s.label || '') || [999])[0]);
    const ws = talks.filter((s) => /workshop|practice/i.test(s.label || '')).sort((a, b) => num(a) - num(b) || a.a - b.a);
    const rest = talks.filter((s) => !ws.includes(s));
    const common = [...ws.reduce((m, s) => m.set(`${s.a}|${s.b}`, (m.get(`${s.a}|${s.b}`) || 0) + 1), new Map()).entries()].sort((a, b) => b[1] - a[1])[0];
    const [ca, cb] = common ? common[0].split('|').map(Number) : [null, null];
    dayHeading(date, ws.length ? 'Pre-conference workshops' : '');
    sectionLabel('The day');
    timedList([...breakItems(breaks),
      ...(ws.length ? [{ a: Math.min(...ws.map((s) => s.a)), b: Math.max(...ws.map((s) => s.b)), text: `Workshops, ${ws.length} in parallel`, where: 'listed below', strong: true }] : []),
      ...rest.map((s) => ({ a: s.a, b: s.b, text: s.title, where: s.hall, strong: true }))].sort((x, y) => x.a - y.a));
    if (!ws.length) return;
    sectionLabel(`The workshops${ca != null ? `  ·  ${span(ca, cb)} unless noted` : ''}`);
    // The table: No. | Workshop, its facilitators | Venue.
    const cNo = 30;
    const cVenue = 112;
    const cMain = W - cNo - cVenue;
    const head = () => {
      const y = doc.y;
      caps('No.', X0, y, { size: 6.5, color: MUTED });
      caps('Workshop and facilitators', X0 + cNo, y, { size: 6.5, color: MUTED });
      caps('Venue', X0 + cNo + cMain + 8, y, { size: 6.5, color: MUTED });
      doc.moveTo(X0, y + 11).lineTo(X0 + W, y + 11).lineWidth(0.8).strokeColor(INK).stroke();
      doc.y = y + 17;
    };
    head();
    for (const s of ws) {
      const odd = s.a !== ca || s.b !== cb;
      doc.font(SERIF_B).fontSize(10);
      const tH = doc.heightOfString(plain(s.title), { width: cMain - 10 });
      doc.font(SERIF_I).fontSize(8);
      const fH = s.speakers ? doc.heightOfString(plain(s.speakers), { width: cMain - 10 }) + 1 : 0;
      doc.font(SERIF).fontSize(9.5);
      const vH = doc.heightOfString(plain(s.hall), { width: cVenue - 8 }) + (odd ? 12 : 0);
      const h = Math.max(tH + fH + 2, vH) + 6;
      if (ensure(h)) head();
      const y = doc.y;
      doc.font(SERIF_B).fontSize(11).fillColor(NAVY).text(String(num(s) === 999 ? '' : num(s)), X0, y, { width: cNo - 6, lineBreak: false });
      doc.font(SERIF_B).fontSize(10).fillColor(INK).text(plain(s.title), X0 + cNo, y, { width: cMain - 10 });
      if (s.speakers) doc.font(SERIF_I).fontSize(8).fillColor(MUTED).text(plain(s.speakers), X0 + cNo, doc.y + 1, { width: cMain - 10 });
      doc.font(SERIF).fontSize(9.5).fillColor(INK).text(plain(s.hall), X0 + cNo + cMain + 8, y + 1, { width: cVenue - 8 });
      if (odd) doc.font(SERIF_I).fontSize(9).fillColor(NAVY).text(span(s.a, s.b), X0 + cNo + cMain + 8, doc.y + 1, { width: cVenue - 8 });
      const by = y + h - 3;
      doc.moveTo(X0, by).lineTo(X0 + W, by).lineWidth(0.4).strokeColor(HAIR).stroke();
      doc.y = by + 4;
    }
  }

  // --- The timetable day ---
  function timetableDay(date, talks, breaks, perHall) {
    const order = new Map(talks.map((s) => [s.hall, s.hall_sort == null ? 999 : Number(s.hall_sort)]));
    const halls = [...perHall.entries()].filter(([, n]) => n >= 2).map(([h]) => h).sort((a, b) => order.get(a) - order.get(b) || a.localeCompare(b));
    const elsewhere = talks.filter((s) => !halls.includes(s.hall)).sort((a, b) => a.a - b.a);
    // A break in one of the halls with nothing else on there (registration
    // in the auditorium) is that hall's; the rest run across the table.
    const inHall = (b) => halls.includes(b.hall) && !talks.some((t) => t.hall === b.hall && t.a < b.b && t.b > b.a);
    const cells = [...talks.filter((s) => halls.includes(s.hall)), ...breaks.filter(inHall).map((b) => ({ ...b, isBreak: true }))];
    const across = breakItems(breaks.filter((b) => !inHall(b)));
    dayHeading(date, `${halls.length} halls in parallel`);
    if (elsewhere.length) {
      sectionLabel('Field visits and sessions elsewhere');
      timedList(elsewhere.map((s) => ({ a: s.a, b: s.b, text: s.title, where: s.hall })));
    }
    sectionLabel('The sessions');
    // Rows: every time something starts -- a session in a hall, or a break.
    const starts = [...new Set([...cells.map((s) => s.a), ...across.map((x) => x.a)])].sort((a, b) => a - b);
    const TIME = 44;
    const COL = (W - TIME) / Math.max(halls.length, 1);
    const colX = (i) => X0 + TIME + i * COL;
    const pad = 6;
    const head = () => {
      const y = doc.y;
      caps('Time', X0, y, { size: 6.5, color: MUTED });
      halls.forEach((h, i) => caps(h, colX(i) + pad, y, { size: 7, color: NAVY, width: COL - pad * 2, spacing: 0.8 }));
      doc.moveTo(X0, y + 12).lineTo(X0 + W, y + 12).lineWidth(0.8).strokeColor(INK).stroke();
      doc.y = y + 16;
    };
    // What a cell needs, measured.
    const cellH = (s) => {
      const w = COL - pad * 2;
      let h = 0;
      if (s.label) { doc.font(SANS_B).fontSize(6); h += doc.heightOfString(plain(s.label).toUpperCase(), { width: w, characterSpacing: 0.6 }) + 1.5; }
      doc.font(s.isBreak ? SERIF_I : SERIF_B).fontSize(9.5);
      h += doc.heightOfString(plain(s.title), { width: w });
      if (s.speakers && !s.isBreak) { doc.font(SERIF_I).fontSize(8.3); h += doc.heightOfString(plain(s.speakers), { width: w }) + 1.5; }
      return h + 9;
    };
    const drawCell = (s, i, y, cont, until) => {
      const x = colX(i) + pad;
      const w = COL - pad * 2;
      if (cont) { doc.font(SERIF_I).fontSize(8.3).fillColor(MUTED).text(`Continued: ${plain(s.title)}`, x, y + 4, { width: w, height: 10, ellipsis: true, lineBreak: false }); return; }
      let yy = y + 4;
      if (s.label) { doc.font(SANS_B).fontSize(6).fillColor(NAVY).text(plain(s.label).toUpperCase(), x, yy, { width: w, characterSpacing: 0.6 }); yy = doc.y + 1.5; }
      doc.font(s.isBreak ? SERIF_I : SERIF_B).fontSize(9.5).fillColor(s.isBreak ? MUTED : INK).text(plain(s.title), x, yy, { width: w });
      if (s.speakers && !s.isBreak) doc.font(SERIF_I).fontSize(8.3).fillColor(MUTED).text(plain(s.speakers), x, doc.y + 1.5, { width: w });
      if (until) doc.font(SERIF_I).fontSize(8).fillColor(NAVY).text(`until ${t12(s.b)}`, x, doc.y + 1.5, { width: w });
    };
    head();
    // Each hall's session under way, row to row: { s, cont } where cont
    // says its next row is a fresh start (after a break line or a new page).
    const open = halls.map(() => null);
    starts.forEach((t, ri) => {
      const next = starts[ri + 1] == null ? Infinity : starts[ri + 1];
      // Sessions over by now leave their hall.
      open.forEach((o, i) => { if (o && o.s.b <= t) open[i] = null; });
      // A break across the table at this time: its own line first.
      for (const x of across.filter((b) => b.a === t)) {
        const text = `${x.text}${x.where ? `, ${x.where}` : ''}`;
        doc.font(SERIF_I).fontSize(9.5);
        const h = doc.heightOfString(plain(text), { width: W - TIME - 12 }) + 10;
        if (ensure(h)) head();
        const y = doc.y;
        doc.rect(X0, y, W, h).fill('#f4f1ea');
        doc.font(SERIF).fontSize(9).fillColor(MUTED).text(span(x.a, x.b), X0 + 2, y + 5, { width: TIME + 40, lineBreak: false });
        doc.font(SERIF_I).fontSize(9.5).fillColor(INK).text(plain(text), X0 + TIME + 44, y + 4.5, { width: W - TIME - 50 });
        doc.y = y + h;
        open.forEach((o, i) => { if (o) open[i] = { ...o, cont: true }; });
      }
      halls.forEach((h, i) => {
        const s = cells.find((c) => c.hall === h && c.a === t);
        if (s) open[i] = { s, cont: false, fresh: true };
      });
      // Nothing starts in a hall now (only a break did): the halls carry on
      // at the next row, marked continued there.
      if (!open.some((o) => o && o.fresh)) return;
      const need = (o) => (!o ? 0 : o.fresh ? cellH(o.s) + (o.s.b > next ? 11 : 0) : o.cont ? 16 : 0);
      let rowH = Math.max(22, ...open.map(need));
      if (ensure(rowH)) {
        head();
        open.forEach((o, i) => { if (o && !o.fresh) open[i] = { ...o, cont: true }; });
        rowH = Math.max(22, ...open.map(need));
      }
      const y = doc.y;
      doc.font(SERIF_B).fontSize(9.5).fillColor(INK).text(clock(t), X0 + 2, y + 4, { width: TIME - 6, lineBreak: false });
      doc.font(SERIF).fontSize(7).fillColor(MUTED).text(ampm(t), X0 + 2, y + 15, { width: TIME - 6, lineBreak: false });
      open.forEach((o, i) => {
        if (!o) return;
        if (o.fresh) drawCell(o.s, i, y, false, o.s.b > next);
        else if (o.cont) drawCell(o.s, i, y, true, false);
        open[i] = { s: o.s, cont: false, fresh: false };
      });
      // Rules: under each hall whose session ends by the next row; between halls.
      const by = y + rowH;
      doc.moveTo(X0, by).lineTo(X0 + TIME, by).lineWidth(0.4).strokeColor(HAIR).stroke();
      halls.forEach((h, i) => {
        const o = open[i];
        if (!o || o.s.b <= next) doc.moveTo(colX(i), by).lineTo(colX(i) + COL, by).lineWidth(0.4).strokeColor(HAIR).stroke();
        doc.moveTo(colX(i), y).lineTo(colX(i), by).lineWidth(0.4).strokeColor(HAIR).stroke();
      });
      doc.y = by;
    });
    doc.moveTo(X0, doc.y).lineTo(X0 + W, doc.y).lineWidth(0.8).strokeColor(INK).stroke();
    doc.y += 14;
  }

  const dates = [...new Set(sessions.map((s) => s.session_date))].sort();
  dates.forEach((date, di) => {
    if (di > 0) newPage();
    const day = sessions.filter((s) => s.session_date === date && s.title).map((s) => ({ ...s, a: toMin(s.start_time), b: toMin(s.end_time) }))
      .filter((s) => s.a != null && s.b != null && s.b > s.a);
    const talks = day.filter((s) => !isBreak(s));
    const breaks = day.filter(isBreak);
    const perHall = new Map();
    for (const s of talks) perHall.set(s.hall, (perHall.get(s.hall) || 0) + 1);
    if (perHall.size > 6) workshopDay(date, talks, breaks);
    else timetableDay(date, talks, breaks, perHall);
  });

  // Running heads and folios.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    if (i > range.start) {
      caps(`${meta.acronym || ''}  ·  Programme at a Glance`, X0, 32, { size: 6.5, color: MUTED });
      doc.moveTo(X0, 44).lineTo(X0 + W, 44).lineWidth(0.4).strokeColor(RULE).stroke();
    }
    doc.moveTo(X0, PH - 40).lineTo(X0 + W, PH - 40).lineWidth(0.4).strokeColor(RULE).stroke();
    doc.font(SERIF_I).fontSize(8).fillColor(MUTED).text(plain(`The full programme, with chairs and every detail${meta.url ? `: ${meta.url}` : ''}. Subject to change.`),
      X0, PH - 33, { width: W - 40, lineBreak: false });
    doc.font(SERIF).fontSize(9).fillColor(INK).text(String(i - range.start + 1), X0 + W - 30, PH - 33, { width: 30, align: 'right', lineBreak: false });
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

module.exports = { renderGlancePdf, isBreak };
