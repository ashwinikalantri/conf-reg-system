// The scientific programme on a few A4 pages (owner, 20 Nov 2026: first
// "design this to look like a published document", then the canvas design
// "Scientific Programme" with a conference header and the partners'
// logos at the foot of every page). Typeset: Times with Helvetica capitals,
// navy and gold as on the website.
//
// Page 1 opens with the conference header -- the NQOCN/MGIMS logo, the
// dates and place, a navy band with the title; later pages carry a running
// head. A day of many halls side by side (the workshops) is a strip of the
// day's timings and a numbered table of the workshops; a day of a few halls
// is its field visits as a strip, then a timetable -- the time, then a
// column for each hall, each cell the session's label, title and speakers,
// a long session spanning its rows ("until 12:20 pm"), meals and breaks as
// bands across.
//
// sessions: [{ session_date, start_time, end_time, label, title, hall,
// hall_sort, meal, speakers }]; meta: { conference, acronym, venue, dates,
// url, logo: path, partners: [{ name, path }] }.
const fs = require('fs');
const { ensureTextDecoders } = require('./report-pdf');

const INK = '#13212d';
const NAVY = '#1c3549';
const STEEL = '#2f5673';
const GOLD = '#b08d3c';
const GOLD_DARK = '#8a6d2b';
const GOLD_LIGHT = '#d9be7c';
const MUTED = '#51606d';
const ON_NAVY = '#c9d4de';
const RULE = '#c3ccd4';
const LINE = '#d5dce2';
const HAIR = '#e3e7eb';
const BAND = '#f5efe1';
const BAND_EDGE = '#e6dcc3';
const SERIF = 'Times-Roman';
const SERIF_B = 'Times-Bold';
const SERIF_I = 'Times-Italic';
const SERIF_BI = 'Times-BoldItalic';
const SANS = 'Helvetica';
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
const span = (a, b) => (ampm(a) === ampm(b) ? `${clock(a)} – ${clock(b)} ${ampm(b)}` : `${t12(a)} – ${t12(b)}`);
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dayParts = (iso) => { const d = new Date(`${iso}T00:00:00Z`); return { weekday: DAYS[d.getUTCDay()], date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` }; };
const isBreak = (s) => Number(s.meal) === 1 || (!s.label && /\b(break|breakfast|lunch|tea|registration|dinner)\b/i.test(s.title || ''));
// The standard PDF fonts read Windows-1252; anything outside it is left out.
const plain = (t) => String(t || '').replace(/[‐‑‒]/g, '-').replace(/[^\x20-\x7E -ÿ–—‘’“”•…]/g, '');
// A field visit's lead, without the "and Team" the programme adds.
const lead = (who) => String(who || '').replace(/,?\s*and Team\s*$/i, '').trim();
const readable = (p) => { try { return p && fs.existsSync(p); } catch { return false; } };

function renderGlancePdf(sessions, meta) {
  const PDF = loadPdfKit();
  const M = { top: 58, bottom: 82, left: 42, right: 42 };
  const doc = new PDF({ size: 'A4', layout: 'portrait', margins: M, bufferPages: true,
    info: { Title: `${meta.acronym || 'Conference'} Scientific Programme`, Author: meta.conference || '' } });
  const PW = doc.page.width;
  const PH = doc.page.height;
  const X0 = M.left;
  const W = PW - M.left - M.right;
  const BOTTOM = PH - M.bottom;
  const newPage = () => { doc.addPage(); doc.y = M.top; };
  const ensure = (h) => { if (doc.y + h > BOTTOM) { newPage(); return true; } return false; };
  const caps = (text, x, y, opts = {}) => doc.font(opts.font || SANS_B).fontSize(opts.size || 7).fillColor(opts.color || NAVY)
    .text(plain(text).toUpperCase(), x, y, { characterSpacing: opts.spacing == null ? 1 : opts.spacing, lineBreak: false, width: opts.width, align: opts.align, ellipsis: !!opts.width });
  const hline = (y, color, w = 0.75, x1 = X0, x2 = X0 + W) => doc.moveTo(x1, y).lineTo(x2, y).lineWidth(w).strokeColor(color).stroke();
  const logo = readable(meta.logo) ? meta.logo : null;
  const partners = (meta.partners || []).filter((p) => readable(p.path));

  // --- The conference header, page 1 ---
  {
    let y = 17;
    if (logo) doc.image(logo, X0, y, { height: 30 });
    else caps(meta.acronym || '', X0, y + 10, { size: 12 });
    doc.font(SERIF_B).fontSize(12).fillColor(NAVY).text(plain(meta.dates || ''), X0 + W / 2, y + 3, { width: W / 2, align: 'right', lineBreak: false });
    caps(meta.venue || '', X0 + W / 2, y + 19, { size: 7, color: MUTED, width: W / 2, align: 'right', spacing: 0.9 });
    y += 38;
    const conf = String(meta.conference || '').replace(/\s+(\d{4})$/, (m, yr) => (String(meta.acronym || '').includes(yr) ? '' : m));
    const bandH = 52;
    doc.rect(0, y, PW, bandH).fill(NAVY);
    doc.rect(0, y + bandH, PW, 2.25).fill(GOLD);
    caps([meta.acronym, conf].filter(Boolean).join('  ·  '), X0, y + 9, { size: 7, color: GOLD_LIGHT, spacing: 1.05, width: W });
    doc.font(SERIF_B).fontSize(23).fillColor('#ffffff').text('Scientific Programme', X0, y + 21, { width: W, lineBreak: false });
    doc.y = y + bandH + 2.25 + 12;
  }

  const dayHeading = (date, n, sub) => {
    ensure(80);
    const p = dayParts(date);
    const y0 = doc.y;
    caps(`Day ${n}  ·  ${p.weekday}`, X0, y0, { size: 7, color: GOLD_DARK });
    doc.font(SERIF_B).fontSize(18).fillColor(NAVY).text(p.date, X0, y0 + 10, { width: W * 0.6, lineBreak: false });
    if (sub) doc.font(SERIF_I).fontSize(10.5).fillColor(MUTED).text(plain(sub), X0 + W * 0.4, y0 + 15, { width: W * 0.6, align: 'right', lineBreak: false });
    hline(y0 + 32, NAVY, 1.1);
    doc.y = y0 + 32 + 8;
  };
  const sectionLabel = (text, right) => {
    ensure(40);
    const y = doc.y;
    caps(text, X0, y, { size: 7, color: NAVY });
    if (right) doc.font(SERIF_I).fontSize(9).fillColor(MUTED).text(plain(right), X0 + W / 2, y - 1.5, { width: W / 2, align: 'right', lineBreak: false });
    doc.y = y + 12;
  };
  // A strip of timed items in columns: the time, what, where.
  const strip = (items, cols) => {
    const gap = 10.5;
    const cw = (W - gap * (cols - 1)) / cols;
    for (let i = 0; i < items.length; i += cols) {
      const row = items.slice(i, i + cols);
      const hOf = (it) => {
        doc.font(it.strong ? SERIF_B : SERIF).fontSize(10);
        let h = 10 + doc.heightOfString(plain(it.what), { width: cw });
        if (it.where) { doc.font(SERIF_I).fontSize(8.5); h += 1.5 + doc.heightOfString(plain(it.where), { width: cw }); }
        return h;
      };
      const h = Math.max(...row.map(hOf));
      ensure(h + 8);
      const y = doc.y;
      row.forEach((it, j) => {
        const x = X0 + j * (cw + gap);
        doc.font(SANS_B).fontSize(7.5).fillColor(NAVY).text(span(it.a, it.b), x, y, { width: cw, lineBreak: false });
        doc.font(it.strong ? SERIF_B : SERIF).fontSize(10).fillColor(INK).text(plain(it.what), x, y + 10, { width: cw });
        if (it.where) doc.font(SERIF_I).fontSize(8.5).fillColor(MUTED).text(plain(it.where), x, doc.y + 1.5, { width: cw });
      });
      doc.y = y + h + 6;
    }
    hline(doc.y, LINE);
    doc.y += 9;
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
  function workshopDay(date, n, talks, breaks) {
    const num = (s) => Number((/\d+/.exec(s.label || '') || [999])[0]);
    const ws = talks.filter((s) => /workshop|practice/i.test(s.label || '')).sort((a, b) => num(a) - num(b) || a.a - b.a);
    const rest = talks.filter((s) => !ws.includes(s));
    const common = [...ws.reduce((m, s) => m.set(`${s.a}|${s.b}`, (m.get(`${s.a}|${s.b}`) || 0) + 1), new Map()).entries()].sort((a, b) => b[1] - a[1])[0];
    const [ca, cb] = common ? common[0].split('|').map(Number) : [null, null];
    dayHeading(date, n, ws.length ? 'Pre-conference workshops' : '');
    const day = [...breakItems(breaks).map((x) => ({ a: x.a, b: x.b, what: x.text, where: x.where })),
      ...(ws.length ? [{ a: Math.min(...ws.map((s) => s.a)), b: Math.max(...ws.map((s) => s.b)), what: `Workshops, ${ws.length} in parallel`, where: 'Venues below', strong: true }] : []),
      ...rest.map((s) => ({ a: s.a, b: s.b, what: s.title, where: s.hall, strong: true }))].sort((x, y) => x.a - y.a);
    strip(day, Math.min(day.length, 5) || 1);
    if (!ws.length) return;
    sectionLabel('The workshops', ca != null ? `All ${span(ca, cb)}, unless noted` : '');
    // The table: No. | Workshop, its facilitators | Venue -- at the largest
    // type that keeps it on this page, if any does.
    const cNo = 22.5;
    const cVenue = 112;
    const gap = 10.5;
    const cMain = W - cNo - cVenue - gap * 2;
    const xMain = X0 + cNo + gap;
    const xVenue = xMain + cMain + gap;
    const odd = (s) => s.a !== ca || s.b !== cb;
    const SIZES = [{ t: 10, f: 8.25, v: 9.4, p: 3 }, { t: 9.5, f: 7.9, v: 9, p: 2.5 }, { t: 9.25, f: 7.5, v: 8.6, p: 2 }];
    const rowH = (s, z) => {
      doc.font(SERIF_B).fontSize(z.t);
      let left = doc.heightOfString(plain(s.title), { width: cMain });
      if (s.speakers) { doc.font(SERIF_I).fontSize(z.f); left += 1 + doc.heightOfString(plain(s.speakers), { width: cMain }); }
      doc.font(SERIF).fontSize(z.v);
      const right = doc.heightOfString(plain(s.hall), { width: cVenue }) + (odd(s) ? z.v + 2 : 0);
      return Math.max(left, right, 12) + z.p * 2 + 1;
    };
    const HEAD = 17;
    const z = SIZES.find((x) => doc.y + HEAD + ws.reduce((t, s) => t + rowH(s, x), 0) <= BOTTOM) || SIZES[0];
    const head = () => {
      const y = doc.y;
      caps('No.', X0, y, { size: 6.4, color: MUTED });
      caps('Workshop and facilitators', xMain, y, { size: 6.4, color: MUTED });
      caps('Venue', xVenue, y, { size: 6.4, color: MUTED });
      hline(y + 11, INK, 1.1);
      doc.y = y + 11 + 2;
    };
    head();
    for (const s of ws) {
      const h = rowH(s, z);
      if (ensure(h)) head();
      const y = doc.y + z.p;
      doc.font(SERIF_B).fontSize(12).fillColor(GOLD_DARK).text(num(s) === 999 ? '' : String(num(s)), X0, y - 0.5, { width: cNo, lineBreak: false });
      doc.font(SERIF_B).fontSize(z.t).fillColor(INK).text(plain(s.title), xMain, y, { width: cMain });
      if (s.speakers) doc.font(SERIF_I).fontSize(z.f).fillColor(MUTED).text(plain(s.speakers), xMain, doc.y + 1, { width: cMain });
      doc.font(SERIF).fontSize(z.v).fillColor(INK).text(plain(s.hall), xVenue, y + 0.5, { width: cVenue });
      if (odd(s)) doc.font(SERIF_BI).fontSize(z.v - 0.4).fillColor(NAVY).text(span(s.a, s.b), xVenue, doc.y + 1, { width: cVenue });
      const by = y - z.p + h;
      hline(by - 0.5, HAIR);
      doc.y = by;
    }
    doc.y += 10;
  }

  // --- The timetable day ---
  function timetableDay(date, n, talks, breaks, perHall) {
    const order = new Map(talks.map((s) => [s.hall, s.hall_sort == null ? 999 : Number(s.hall_sort)]));
    const halls = [...perHall.entries()].filter(([, k]) => k >= 2).map(([h]) => h).sort((a, b) => order.get(a) - order.get(b) || a.localeCompare(b));
    const elsewhere = talks.filter((s) => !halls.includes(s.hall)).sort((a, b) => a.a - b.a);
    // A break in one of the halls with nothing else on there (registration
    // in the auditorium) is that hall's; the rest run across the table.
    const inHall = (b) => halls.includes(b.hall) && !talks.some((t) => t.hall === b.hall && t.a < b.b && t.b > b.a);
    const cells = [...talks.filter((s) => halls.includes(s.hall)), ...breaks.filter(inHall).map((b) => ({ ...b, isBreak: true }))];
    const across = breakItems(breaks.filter((b) => !inHall(b)));
    dayHeading(date, n, `Conference day  ·  ${halls.length} halls in parallel`);
    if (elsewhere.length) {
      sectionLabel(/visit/i.test(elsewhere.map((s) => s.hall).join(' ')) ? 'Early field visits' : 'Elsewhere');
      strip(elsewhere.map((s) => ({ a: s.a, b: s.b, what: s.title, strong: true,
        where: [s.hall.replace(/\s*\(field visit\)\s*$/i, ''), lead(s.speakers)].filter(Boolean).join('  ·  ') })), Math.min(elsewhere.length, 3));
    }
    sectionLabel('The sessions');
    // Rows: every time something starts -- a session in a hall, or a break.
    const starts = [...new Set([...cells.map((s) => s.a), ...across.map((x) => x.a)])].sort((a, b) => a - b);
    const TIME = 39;
    const COL = (W - TIME) / Math.max(halls.length, 1);
    const colX = (i) => X0 + TIME + i * COL;
    const PX = 7.5;
    const PY = 5;
    const head = () => {
      const y = doc.y;
      const h = 17;
      doc.rect(X0, y, W, h).fill(NAVY);
      caps('Time', X0 + 6, y + 6, { size: 6.4, color: ON_NAVY, spacing: 0.75 });
      halls.forEach((hl, i) => {
        doc.moveTo(colX(i), y).lineTo(colX(i), y + h).lineWidth(0.75).strokeColor('#34506a').stroke();
        caps(hl, colX(i) + PX, y + 5.5, { size: 7, color: '#ffffff', width: COL - PX * 2, spacing: 0.75 });
      });
      doc.y = y + h;
    };
    // What a cell needs, measured.
    const w = COL - PX * 2;
    const hasLabel = (s) => s.label && !s.isBreak && s.label !== s.title;
    const cellH = (s, until) => {
      let h = 0;
      if (hasLabel(s)) { doc.font(SANS_B).fontSize(6.4); h += doc.heightOfString(plain(s.label).toUpperCase(), { width: w, characterSpacing: 0.6 }) + 1.5; }
      doc.font(s.isBreak ? SERIF_I : SERIF_B).fontSize(s.isBreak ? 9.4 : 9.75);
      h += doc.heightOfString(plain(s.title), { width: w });
      if (s.speakers && !s.isBreak) { doc.font(SERIF_I).fontSize(8.6); h += doc.heightOfString(plain(s.speakers), { width: w }) + 1.5; }
      if (until) h += 11.5;
      return h + PY * 2;
    };
    const contH = (until) => 12 + (until ? 11.5 : 0) + PY * 2;
    const drawCell = (s, i, y, cont, until) => {
      const x = colX(i) + PX;
      let yy = y + PY;
      if (cont) {
        // The title if it fits on the line, else the shorter label.
        doc.font(SERIF_I).fontSize(9);
        const name = doc.widthOfString(`${plain(s.title)}, continued`) > w && hasLabel(s) ? s.label : s.title;
        doc.fillColor(MUTED).text(`${plain(name)}, continued`, x, yy, { width: w, height: 11, ellipsis: true, lineBreak: false });
        yy += 10.5;
      } else {
        if (hasLabel(s)) { doc.font(SANS_B).fontSize(6.4).fillColor(STEEL).text(plain(s.label).toUpperCase(), x, yy, { width: w, characterSpacing: 0.6 }); yy = doc.y + 1.5; }
        doc.font(s.isBreak ? SERIF_I : SERIF_B).fontSize(s.isBreak ? 9.4 : 9.75).fillColor(s.isBreak ? MUTED : INK).text(plain(s.title), x, yy, { width: w });
        if (s.speakers && !s.isBreak) doc.font(SERIF_I).fontSize(8.6).fillColor(MUTED).text(plain(s.speakers), x, doc.y + 1.5, { width: w });
        yy = doc.y;
      }
      if (until) doc.font(SERIF_BI).fontSize(8.6).fillColor(NAVY).text(`until ${t12(s.b)}`, x, yy + 1.5, { width: w, lineBreak: false });
    };
    head();
    // Each hall's session under way, row to row: { s, cont } where cont
    // says its next row is a fresh start (after a break band or a new page).
    const open = halls.map(() => null);
    starts.forEach((t, ri) => {
      const next = starts[ri + 1] == null ? Infinity : starts[ri + 1];
      open.forEach((o, i) => { if (o && o.s.b <= t) open[i] = null; });
      // A break across the table at this time: its band first.
      for (const x of across.filter((b) => b.a === t)) {
        const text = `${x.text}${x.where ? `  ·  ${x.where}` : ''}`;
        doc.font(SERIF_I).fontSize(9.4);
        const h = doc.heightOfString(plain(text), { width: W - 96 }) + 10;
        if (ensure(h)) head();
        const y = doc.y;
        doc.rect(X0, y, W, h).fill(BAND);
        hline(y + h - 0.4, BAND_EDGE);
        doc.font(SANS_B).fontSize(7.5).fillColor(GOLD_DARK).text(span(x.a, x.b), X0 + 6, y + 6, { width: 84, lineBreak: false });
        doc.font(SERIF_I).fontSize(9.4).fillColor(INK).text(plain(text), X0 + 92, y + 5, { width: W - 96 });
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
      const need = (o) => (!o ? 0 : o.fresh ? cellH(o.s, o.s.b > next) : o.cont ? contH(o.s.b > next) : 0);
      let rowH = Math.max(26, ...open.map(need));
      if (ensure(rowH)) {
        head();
        open.forEach((o, i) => { if (o && !o.fresh) open[i] = { ...o, cont: true }; });
        rowH = Math.max(26, ...open.map(need));
      }
      const y = doc.y;
      doc.font(SERIF_B).fontSize(10.5).fillColor(NAVY).text(clock(t), X0 + 6, y + PY, { width: TIME - 8, lineBreak: false });
      doc.font(SANS).fontSize(6.4).fillColor(MUTED).text(ampm(t), X0 + 6, y + PY + 11, { width: TIME - 8, lineBreak: false });
      open.forEach((o, i) => {
        if (!o) return;
        if (o.fresh) drawCell(o.s, i, y, false, o.s.b > next);
        else if (o.cont) drawCell(o.s, i, y, true, o.s.b > next);
        open[i] = { s: o.s, cont: false, fresh: false };
      });
      // Rules: under each hall whose session ends by the next row; between halls.
      const by = y + rowH;
      hline(by, LINE, 0.75, X0, X0 + TIME);
      halls.forEach((h, i) => {
        const o = open[i];
        if (!o || o.s.b <= next) hline(by, LINE, 0.75, colX(i), colX(i) + COL);
        doc.moveTo(colX(i), y).lineTo(colX(i), by).lineWidth(0.75).strokeColor(LINE).stroke();
      });
      doc.y = by;
    });
    hline(doc.y, INK, 1.1);
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
    if (perHall.size > 6) workshopDay(date, di + 1, talks, breaks);
    else timetableDay(date, di + 1, talks, breaks, perHall);
  });

  // Running heads, and every page's foot: the partners, then the line.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    if (i > range.start) {
      if (logo) doc.image(logo, X0, 18, { height: 18 });
      else caps(meta.acronym || '', X0, 24, { size: 8 });
      caps(`Scientific Programme  ·  ${meta.dates || ''}`, X0 + W / 2, 24, { size: 6.75, color: MUTED, width: W / 2, align: 'right', spacing: 0.9 });
      hline(42, GOLD, 1.5);
    }
    const lineY = PH - 16.5 - 10;
    if (partners.length) {
      const logosY = lineY - 6 - 21 - 4.5;
      const labelY = logosY - 4.5 - 7;
      hline(labelY - 5.5, RULE);
      caps('In partnership with', X0, labelY, { size: 6.75, color: MUTED, width: W, align: 'center', spacing: 1 });
      const slot = W / partners.length;
      partners.forEach((p, k) => {
        try { doc.image(p.path, X0 + k * slot + (slot - 40.5) / 2, logosY, { fit: [40.5, 21], align: 'center', valign: 'center' }); } catch { /* an unreadable logo is left out */ }
      });
      hline(lineY - 4.5, HAIR);
    } else {
      hline(lineY - 4.5, RULE);
    }
    doc.font(SERIF_I).fontSize(8.25).fillColor(MUTED).text(plain(`The full programme, with chairs${meta.url ? `: ${meta.url}` : ''}  ·  Subject to change`), X0, lineY, { width: W - 40, lineBreak: false });
    doc.font(SERIF_B).fontSize(9).fillColor(NAVY).text(String(i - range.start + 1), X0 + W - 30, lineY - 0.5, { width: 30, align: 'right', lineBreak: false });
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
