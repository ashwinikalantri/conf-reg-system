'use strict';
// One e-certificate as a PDF: A4 landscape, drawn with pdfkit.
//
// Two layouts:
//
// - Generated: a navy frame with a gold rule, the conference named across
//   the top, "Certificate" and its kind, the name, the wording, the
//   signatures, the sponsors' logos in a row along the foot, and a verify QR
//   with the certificate number (the QR carries the link; it is not printed).
//
// - On the designer's artwork, when one is uploaded: the artwork carries the
//   conference, the host, the NQOCN mark and the word "Certificate" across
//   its top, and a patterned border along its foot. The text is set in the
//   plain field between: the kind under "Certificate", the name, the wording,
//   the signatures, the logos, and the QR in the empty left-hand margin --
//   clear of the faint motif on the right. The page takes the artwork's
//   proportions (A4's width; its own height) so nothing is stretched or cut.
//
// Text: Times for the title and the name, as certificates are set; Noto Sans
// (bundled, see assets/fonts) for everything else, since a venue or a
// council name may hold characters Times cannot draw. A name Times cannot
// draw is set in Noto Sans too.
const path = require('path');
const { ensureTextDecoders } = require('./report-pdf');

const FONT_DIR = path.join(__dirname, 'assets', 'fonts');
const W = 841.89;
const H = 595.28;
const C = {
  navy: '#1c3549', steel: '#2f5673', gold: '#b08d3c', goldInk: '#8a6d2b',
  ink: '#1e293b', muted: '#5b6b7d', faint: '#eef3f6',
  // The artwork's own: the terracotta of its "Certificate", the indigo of
  // its MGIMS line, and a warm ink that sits on linen.
  terracotta: '#9c4128', indigo: '#2e2a86', linenInk: '#33281f', linenMuted: '#6b5a48',
};

let PDFDocument = null;
function pdfkit() {
  if (!PDFDocument) { ensureTextDecoders(); PDFDocument = require('pdfkit'); }
  return PDFDocument;
}

// Times (WinAnsi) draws Latin-1 and little else.
const timesCan = (s) => !/[^\u0000-ÿ–—‘’“”]/.test(String(s || ''));

// Paragraph text with **bold** spans, centred. Laid out here word by word:
// pdfkit's own centring goes wrong when a line mixes fonts. A line break in
// the text starts a new paragraph.
function richText(doc, text, x, y, width, size, lineGap, color = C.ink) {
  doc.fontSize(size);
  const lineHeight = size * 1.25 + lineGap;
  let cy = y;
  for (const para of String(text || '').split(/\n+/)) {
    // Words, each knowing its font; bold toggles at every **.
    const words = [];
    const parts = para.split(/\*\*/);
    parts.forEach((part, i) => {
      const font = i % 2 ? 'bold' : 'body';
      // A part that starts mid-word (the comma after a bold number) joins
      // the word before it -- when there is no space on either side.
      const glued = words.length && part && !/^\s/.test(part) && !/\s$/.test(parts[i - 1] || ' ');
      part.split(/\s+/).filter(Boolean).forEach((w, j) => words.push({ w, font, glued: glued && j === 0 }));
    });
    const space = (font) => { doc.font(font); return doc.widthOfString(' '); };
    const lines = [];
    let line = [];
    let lineW = 0;
    for (const word of words) {
      doc.font(word.font);
      const ww = doc.widthOfString(word.w);
      const gap = (wd) => (line.length && !wd.glued ? space(wd.font) : 0);
      if (line.length && !word.glued && lineW + gap(word) + ww > width) { lines.push({ words: line, w: lineW }); line = []; lineW = 0; }
      lineW += gap(word) + ww;
      line.push({ ...word, ww });
    }
    if (line.length) lines.push({ words: line, w: lineW });
    for (const l of lines) {
      let cx = x + (width - l.w) / 2;
      l.words.forEach((word, i) => {
        if (i && !word.glued) cx += space(word.font);
        doc.font(word.font).fillColor(color).text(word.w, cx, cy, { lineBreak: false });
        cx += word.ww;
      });
      cy += lineHeight;
    }
    cy += lineGap * 1.5;
  }
  return cy;
}

// The sponsors' logos, one row centred between left and right: all the same
// height, shrunk together when they would not fit, a wide wordmark capped so
// it does not crowd the rest. logos: [Buffer].
function drawLogos(doc, logos, top, left, right, height, gap = 16) {
  const imgs = [];
  for (const buf of logos || []) {
    try { const img = doc.openImage(buf); imgs.push({ img, ratio: img.width / img.height }); } catch (e) { /* not an image pdfkit reads */ }
  }
  if (!imgs.length) return;
  const gaps = gap * (imgs.length - 1);
  const widthAt = (h) => imgs.reduce((t, x) => t + Math.min(x.ratio * h, h * 2.4), 0) + gaps;
  let h = height;
  if (widthAt(h) > right - left) h = Math.max(12, height * (right - left - gaps) / (widthAt(height) - gaps));
  let x = left + (right - left - widthAt(h)) / 2;
  for (const { img, ratio } of imgs) {
    const w = Math.min(ratio * h, h * 2.4);
    doc.image(img, x, top + (height - h) / 2, { fit: [w, h], align: 'center', valign: 'center' });
    x += w + gap;
  }
}

// The page size for an artwork: A4's width, the artwork's height -- within
// reason; anything far from a landscape page is drawn on A4.
function pageFor(doc, background) {
  try {
    const img = doc.openImage(background);
    const ratio = img.width / img.height;
    return { img, height: ratio >= 1.2 && ratio <= 1.7 ? W / ratio : H };
  } catch (e) {
    return null;
  }
}

function drawFrame(doc) {
  doc.rect(0, 0, W, H).fill('#ffffff');
  doc.lineWidth(12).strokeColor(C.navy).rect(18, 18, W - 36, H - 36).stroke();
  doc.lineWidth(1.4).strokeColor(C.gold).rect(32, 32, W - 64, H - 64).stroke();
  doc.lineWidth(0.5).strokeColor(C.gold).rect(37, 37, W - 74, H - 74).stroke();
  // A small gold diamond in each inner corner.
  for (const [cx, cy] of [[37, 37], [W - 37, 37], [37, H - 37], [W - 37, H - 37]]) {
    doc.save().translate(cx, cy).rotate(45).rect(-5, -5, 10, 10).fill(C.gold).restore();
  }
}

// opts: { kind, title, subtitle, lead, name, body, conference: { name,
// acronym }, certNo, verifyUrl, qrPng, signatories: [{ name, designation,
// image }], logos: [Buffer], background, specimen }
function renderCertificatePdf(opts) {
  const Doc = pdfkit();
  return new Promise((resolve, reject) => {
    // The artwork is opened on a scratch document first: its proportions
    // set the page.
    const probe = opts.background ? pageFor(new Doc({ autoFirstPage: false }), opts.background) : null;
    const PH = probe ? probe.height : H;
    const doc = new Doc({ size: [W, PH], margin: 0, info: { Title: `${opts.title || 'Certificate'} — ${opts.name || ''}`.trim(), Author: opts.conference && opts.conference.name } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      doc.registerFont('body', path.join(FONT_DIR, 'NotoSans-Regular.ttf'));
      doc.registerFont('bold', path.join(FONT_DIR, 'NotoSans-Bold.ttf'));
      if (probe) {
        doc.image(opts.background, 0, 0, { width: W, height: PH });
        onArtwork(doc, opts, PH);
      } else {
        generated(doc, opts);
      }
      if (opts.specimen) {
        doc.save().fillOpacity(0.12).fillColor('#b91c1c').font('Times-Bold').fontSize(110)
          .rotate(-24, { origin: [W / 2, PH / 2] }).text('SPECIMEN', 0, PH / 2 - 60, { width: W, align: 'center', lineBreak: false }).restore();
      }
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// The name, large, shrunk to fit; Times unless it holds what Times cannot draw.
function drawName(doc, name, y, size, color, maxWidth) {
  const font = timesCan(name) ? 'Times-BoldItalic' : 'bold';
  let s = size;
  doc.font(font).fontSize(s);
  while (doc.widthOfString(name) > maxWidth && s > 16) doc.fontSize(--s);
  doc.fillColor(color).text(name, 0, y + (size - s) * 0.6, { width: W, align: 'center', lineBreak: false });
}

// Up to six in one row: each gets an equal share of the width, and with
// more than four the type steps down so a name and its designation still
// fit their share (a designation wraps to a second line).
function drawSignatures(doc, sigs, left, right, lineY, ink, muted, sigH = 40) {
  if (!sigs.length) return;
  const slot = (right - left) / sigs.length;
  const crowded = sigs.length > 4;
  const textW = Math.min(176, slot - 2);
  const lineHalf = Math.min(72, slot / 2 - 8);
  const imgW = Math.min(130, slot - 12);
  sigs.forEach((s, i) => {
    const cx = left + slot * i + slot / 2;
    if (s.image) {
      try { doc.image(s.image, cx - imgW / 2, lineY - sigH - 4, { fit: [imgW, sigH], align: 'center', valign: 'bottom' }); } catch (e) { /* not an image pdfkit reads */ }
    }
    doc.lineWidth(0.6).strokeColor(muted).moveTo(cx - lineHalf, lineY).lineTo(cx + lineHalf, lineY).stroke();
    doc.font('bold').fontSize(crowded ? 8 : 9.5).fillColor(ink).text(s.name || '', cx - textW / 2, lineY + 5, { width: textW, align: 'center' });
    doc.font('body').fontSize(crowded ? 7 : 8).fillColor(muted).text(s.designation || '', cx - textW / 2, doc.y + 1, { width: textW, align: 'center' });
  });
}

// Over the designer's artwork. Positions are fractions of the page height,
// read off the artwork: its "Certificate" ends at 40%, its border starts at
// 90.6%; the motif on the right begins at 87% of the width.
function onArtwork(doc, opts, PH) {
  const y = (f) => PH * f;
  const field = { left: 150, right: W * 0.87 - 20 };   // clear of the QR column and the motif
  const mid = (field.left + field.right) / 2;
  const centred = (top, width = field.right - field.left) => ({ x: mid - width / 2, top, width });

  // The kind, under the artwork's "Certificate".
  const sub = centred(y(0.408));
  doc.font('Times-Italic').fontSize(19).fillColor(C.terracotta)
    .text(opts.subtitle || '', sub.x, sub.top, { width: sub.width, align: 'center' });

  doc.font('body').fontSize(10.5).fillColor(C.linenMuted)
    .text(opts.lead || 'This is to certify that', sub.x, y(0.456), { width: sub.width, align: 'center' });

  // drawName centres on the page; centre it on the field instead.
  doc.save().translate(mid - W / 2, 0);
  // A clear space under the line above it.
  drawName(doc, String(opts.name || ''), y(0.497), 30, C.indigo, field.right - field.left - 40);
  doc.restore();
  doc.lineWidth(0.8).strokeColor(C.terracotta).strokeOpacity(0.55)
    .moveTo(mid - 200, y(0.562)).lineTo(mid + 200, y(0.562)).stroke().strokeOpacity(1);

  const bodyW = field.right - field.left - 20;
  richText(doc, opts.body, mid - bodyW / 2, y(0.575), bodyW, 11, 3, C.linenInk);

  // The signatures run wider than the text: from beside the QR to the
  // motif's edge.
  drawSignatures(doc, (opts.signatories || []).slice(0, 6), 118, W * 0.87, y(0.775), C.linenInk, C.linenMuted, 28);

  // The sponsors, straight on the linen (white grounds taken out, see
  // clearWhiteGround).
  if (opts.logos && opts.logos.length) drawLogos(doc, opts.logos, y(0.857), field.left, field.right, y(0.04), 14);

  // Verify, in the empty left margin.
  const qx = 40;
  const qy = y(0.70);
  if (opts.qrPng) {
    doc.save().fillOpacity(0.9).fillColor('#ffffff').roundedRect(qx - 4, qy - 4, 70, 70, 4).fill().restore();
    doc.image(opts.qrPng, qx, qy, { width: 62, height: 62 });
  }
  doc.font('body').fontSize(6.5).fillColor(C.linenMuted)
    .text(`Certificate No.\n${opts.certNo || ''}`, qx - 4, qy + 70, { width: 104, align: 'left' });
}

function generated(doc, opts) {
  const conf = opts.conference || {};
  drawFrame(doc);
  // The acronym, faint, behind the wording.
  if (conf.acronym) {
    doc.save().fillOpacity(0.045).fillColor(C.steel).font('Times-Bold').fontSize(118)
      .text(conf.acronym, 0, H / 2 - 70, { width: W, align: 'center', lineBreak: false }).restore();
  }
  // The conference across the top.
  doc.font('bold').fontSize(11).fillColor(C.steel)
    .text(String(conf.acronym || '').toUpperCase(), 0, 58, { width: W, align: 'center', characterSpacing: 3 });
  doc.font('body').fontSize(10).fillColor(C.muted)
    .text(conf.name || '', 90, 74, { width: W - 180, align: 'center' });

  doc.font('Times-Bold').fontSize(46).fillColor(C.navy)
    .text(String(opts.title || 'Certificate').toUpperCase(), 0, 104, { width: W, align: 'center', characterSpacing: 6 });
  doc.font('Times-Italic').fontSize(20).fillColor(C.goldInk)
    .text(opts.subtitle || '', 0, 158, { width: W, align: 'center' });

  doc.font('body').fontSize(12).fillColor(C.muted)
    .text(opts.lead || 'This is to certify that', 0, 204, { width: W, align: 'center' });
  drawName(doc, String(opts.name || ''), 234, 32, C.navy, W - 220);
  doc.lineWidth(0.8).strokeColor(C.gold).moveTo(W / 2 - 220, 276).lineTo(W / 2 + 220, 276).stroke();

  richText(doc, opts.body, 110, 291, W - 220, 12.5, 4);

  // Signatures across the foot -- raised a little when the sponsors' logos
  // take the row beneath them. The QR has the right-hand corner.
  const hasLogos = !!(opts.logos && opts.logos.length);
  drawSignatures(doc, (opts.signatories || []).slice(0, 6), 70, W - 160, hasLogos ? 452 : 486, C.ink, C.muted);
  if (hasLogos) drawLogos(doc, opts.logos, 498, 70, W - 150, 28);

  // Verify: the QR, and the certificate number under it.
  const footY = hasLogos ? H - 52 : H - 62;
  if (opts.qrPng) doc.image(opts.qrPng, W - 122, footY - 70, { width: 66, height: 66 });
  doc.font('body').fontSize(7.5).fillColor(C.muted)
    .text(`Certificate No. ${opts.certNo || ''}`, W - 250, footY, { width: 194, align: 'right' });
}

// The posters for the hall doors: one A4 portrait page per hall -- the
// conference, the hall's name, its QR (a portal link carrying the hall's
// code) and how to use it. pages: [{ hall, code, qr }].
function renderHallPosters(pages, conference = {}) {
  const Doc = pdfkit();
  const PW = 595.28;
  const PH = 841.89;
  return new Promise((resolve, reject) => {
    const doc = new Doc({ size: 'A4', margin: 0, autoFirstPage: false, info: { Title: 'Hall attendance QR codes', Author: conference.name } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      doc.registerFont('body', path.join(FONT_DIR, 'NotoSans-Regular.ttf'));
      doc.registerFont('bold', path.join(FONT_DIR, 'NotoSans-Bold.ttf'));
      for (const p of pages) {
        doc.addPage();
        doc.rect(0, 0, PW, PH).fill('#ffffff');
        doc.rect(0, 0, PW, 132).fill(C.navy);
        doc.rect(0, 132, PW, 5).fill(C.gold);
        doc.font('bold').fontSize(13).fillColor('#d6b46a')
          .text(String(conference.acronym || '').toUpperCase(), 0, 40, { width: PW, align: 'center', characterSpacing: 4 });
        doc.font('body').fontSize(11).fillColor('#ffffff').text(conference.name || '', 60, 64, { width: PW - 120, align: 'center' });
        doc.font('bold').fontSize(13).fillColor(C.steel)
          .text('MARK YOUR ATTENDANCE', 0, 168, { width: PW, align: 'center', characterSpacing: 3 });
        let size = 50;
        doc.font(timesCan(p.hall) ? 'Times-Bold' : 'bold').fontSize(size);
        while (doc.widthOfString(p.hall) > PW - 80 && size > 26) doc.fontSize(--size);
        doc.fillColor(C.navy).text(p.hall, 40, 192, { width: PW - 80, align: 'center' });
        const qr = 330;
        doc.image(p.qr, (PW - qr) / 2, 272, { width: qr, height: qr });
        const steps = ['Open your phone camera and scan this code.', 'Log in to the registration portal if asked.',
          'You are marked present at the session on in this hall now.'];
        let y = 630;
        steps.forEach((t, i) => {
          doc.circle(118, y + 9, 11).fill(C.steel);
          doc.font('bold').fontSize(11).fillColor('#ffffff').text(String(i + 1), 107, y + 2.5, { width: 22, align: 'center' });
          doc.font('body').fontSize(13).fillColor(C.ink).text(t, 142, y, { width: PW - 200 });
          y += 34;
        });
        doc.font('body').fontSize(10).fillColor(C.muted)
          .text("Can't scan? Show your badge to the volunteer at the door.", 0, 752, { width: PW, align: 'center' });
        doc.fontSize(8).text(`Hall code ${p.code}`, 0, 790, { width: PW, align: 'center' });
      }
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// A logo on a white square reads as a white box on the linen. The white
// that reaches the edges is taken out (flood-filled from the border, so
// white inside the mark -- a letter's counter -- stays), and the soft edge
// around it fades by how pale it is, so no white fringe is left while the
// mark's own colour stays solid. A logo with
// no white border (already transparent, or on its own colour) comes back
// as it was. PNG or JPEG in, PNG out; kept by content, as every
// certificate asks for the same few.
const clearedLogos = new Map();
function clearWhiteGround(buffer) {
  const key = require('crypto').createHash('sha1').update(buffer).digest('hex');
  if (!clearedLogos.has(key)) clearedLogos.set(key, clearWhite(buffer));
  return clearedLogos.get(key);
}
function clearWhite(buffer) {
  try {
    const { PNG } = require('pngjs');
    let img;
    if (buffer[0] === 0x89 && buffer[1] === 0x50) img = PNG.sync.read(buffer);
    else if (buffer[0] === 0xff && buffer[1] === 0xd8) img = require('jpeg-js').decode(buffer, { formatAsRGBA: true });
    else return buffer;
    const { width: w, height: h } = img;
    const d = img.data;
    const whiteAt = (p) => d[p * 4 + 3] > 200 && d[p * 4] > 232 && d[p * 4 + 1] > 232 && d[p * 4 + 2] > 232;
    const border = [];
    for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
    for (let y = 1; y < h - 1; y++) border.push(y * w, y * w + w - 1);
    const seeds = border.filter(whiteAt);
    if (seeds.length < border.length * 0.6) return buffer;
    const ground = new Uint8Array(w * h);
    for (const p of seeds) ground[p] = 1;
    while (seeds.length) {
      const p = seeds.pop();
      const x = p % w;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
        if (q >= 0 && q < w * h && !ground[q] && whiteAt(q)) { ground[q] = 1; seeds.push(q); }
      }
    }
    // The ground goes; the two pixels around it fade with their paleness.
    const near = new Uint8Array(w * h);
    for (let p = 0; p < w * h; p++) {
      if (!ground[p]) continue;
      const x = p % w;
      const y = (p - x) / w;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < w && ny >= 0 && ny < h && !ground[ny * w + nx]) near[ny * w + nx] = 1;
        }
      }
    }
    const out = new PNG({ width: w, height: h });
    for (let p = 0; p < w * h; p++) {
      const i = p * 4;
      let [r, g, b, a] = [d[i], d[i + 1], d[i + 2], d[i + 3]];
      if (ground[p]) a = 0;
      else if (near[p]) {
        // How far from white; anything half-way to a colour is solid.
        const k = Math.min(1, 2 * Math.max(1 - r / 255, 1 - g / 255, 1 - b / 255));
        if (k < 0.008) a = 0;
        else {
          const un = (c) => Math.max(0, Math.min(255, Math.round(255 - (255 - c) / k)));
          r = un(r); g = un(g); b = un(b);
          a = Math.round(a * k);
        }
      }
      out.data[i] = r; out.data[i + 1] = g; out.data[i + 2] = b; out.data[i + 3] = a;
    }
    return PNG.sync.write(out);
  } catch (e) {
    return buffer;
  }
}

// The copy of the designer's artwork that goes into each certificate. Every
// certificate carries the background whole, and an artwork straight from the
// designer can run to tens of megabytes -- a certificate to email. This one
// is A4 at 300 dpi at most (3508 pixels across), as a quality-90 JPEG: a
// 16 MB artwork becomes about 2.6 MB with no visible difference. PNG or JPEG
// in; a transparent PNG is laid on white. Returns null for what it cannot
// read, and the original is used.
const PRINT_WIDTH = 3508;
function certificateCopy(buffer) {
  try {
    let img;
    if (buffer[0] === 0x89 && buffer[1] === 0x50) {
      const png = require('pngjs').PNG.sync.read(buffer);
      const d = png.data;
      for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3] / 255;
        d[i] = d[i] * a + 255 * (1 - a); d[i + 1] = d[i + 1] * a + 255 * (1 - a); d[i + 2] = d[i + 2] * a + 255 * (1 - a); d[i + 3] = 255;
      }
      img = { width: png.width, height: png.height, data: d };
    } else {
      img = decodeCmyk(buffer) || require('jpeg-js').decode(buffer, { maxMemoryUsageInMB: 2048, maxResolutionInMP: 400, formatAsRGBA: true });
    }
    if (img.width > PRINT_WIDTH) img = shrink(img, PRINT_WIDTH, Math.round(img.height * PRINT_WIDTH / img.width));
    const out = require('jpeg-js').encode(img, 90).data;
    return out.length < buffer.length ? out : buffer;
  } catch (e) {
    return null;
  }
}

// A CMYK JPEG -- what a designer exports for print -- in RGB. jpeg-js turns
// CMYK into RGB by the crudest formula, which pushes the artwork's indigo to
// a bright blue; this uses xpdf/poppler's table instead (what PDF viewers do
// for a CMYK image, and what the original looks like on a certificate). It
// needs the decoder's raw ink values, which jpeg-js does not export: its
// decoder is loaded from source for them (jpeg-js is pinned to 0.4.4 for
// this). Returns null for any other JPEG, or on any failure.
let JpegImage;
function decodeCmyk(buffer) {
  try {
    if (!JpegImage) {
      const fs = require('fs');
      const src = fs.readFileSync(require.resolve('jpeg-js/lib/decoder.js'), 'utf8');
      // eslint-disable-next-line no-new-func
      JpegImage = new Function('module', 'Buffer', `${src}\n;return JpegImage;`)({}, Buffer);
    }
    const d = new JpegImage();
    d.opts = { colorTransform: undefined, tolerantDecoding: true, maxResolutionInMP: 400, maxMemoryUsageInMB: 2048 };
    JpegImage.resetMaxMemoryUsage(2048 * 1024 * 1024);
    d.parse(new Uint8Array(buffer));
    if (!d.components || d.components.length !== 4) return null;
    const ink = d.getData(d.width, d.height);   // C, M, Y, K: 0 = no ink
    const out = Buffer.alloc(d.width * d.height * 4);
    for (let i = 0, j = 0; i < ink.length; i += 4, j += 4) {
      const rgb = cmykToRgb(ink[i] / 255, ink[i + 1] / 255, ink[i + 2] / 255, ink[i + 3] / 255);
      out[j] = rgb[0]; out[j + 1] = rgb[1]; out[j + 2] = rgb[2]; out[j + 3] = 255;
    }
    return { width: d.width, height: d.height, data: out };
  } catch (e) {
    return null;
  }
}

// xpdf's GfxDeviceCMYKColorSpace::getRGB: each of the 16 ink combinations'
// measured colour, blended by how much of each ink there is.
function cmykToRgb(c, m, y, k) {
  const c1 = 1 - c; const m1 = 1 - m; const y1 = 1 - y; const k1 = 1 - k;
  let r = 0; let g = 0; let b = 0; let x;
  x = c1 * m1 * y1 * k1; r += x; g += x; b += x;
  x = c1 * m1 * y1 * k; r += 0.1373 * x; g += 0.1216 * x; b += 0.1255 * x;
  x = c1 * m1 * y * k1; r += x; g += 0.9490 * x;
  x = c1 * m1 * y * k; r += 0.1098 * x; g += 0.1020 * x;
  x = c1 * m * y1 * k1; r += 0.9255 * x; b += 0.5490 * x;
  x = c1 * m * y1 * k; r += 0.1412 * x;
  x = c1 * m * y * k1; r += 0.9294 * x; g += 0.1098 * x; b += 0.1412 * x;
  x = c1 * m * y * k; r += 0.1333 * x;
  x = c * m1 * y1 * k1; g += 0.6784 * x; b += 0.9373 * x;
  x = c * m1 * y1 * k; g += 0.0588 * x; b += 0.1412 * x;
  x = c * m1 * y * k1; g += 0.6510 * x; b += 0.3137 * x;
  x = c * m1 * y * k; g += 0.0745 * x;
  x = c * m * y1 * k1; r += 0.1804 * x; g += 0.1922 * x; b += 0.5725 * x;
  x = c * m * y1 * k; b += 0.0078 * x;
  x = c * m * y * k1; r += 0.2118 * x; g += 0.2119 * x; b += 0.2235 * x;
  const to8 = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return [to8(r), to8(g), to8(b)];
}

// Box-filter downscale of an RGBA image.
function shrink(img, tw, th) {
  const out = Buffer.alloc(tw * th * 4);
  const sx = img.width / tw;
  const sy = img.height / th;
  for (let y = 0; y < th; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(img.height, Math.floor((y + 1) * sy)));
    for (let x = 0; x < tw; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(img.width, Math.floor((x + 1) * sx)));
      let r = 0; let g = 0; let b = 0; let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * img.width + xx) * 4;
          r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++;
        }
      }
      const j = (y * tw + x) * 4;
      out[j] = r / n; out[j + 1] = g / n; out[j + 2] = b / n; out[j + 3] = 255;
    }
  }
  return { width: tw, height: th, data: out };
}

module.exports = { renderCertificatePdf, renderHallPosters, certificateCopy, clearWhiteGround, cmykToRgb, PAGE: { W, H } };
