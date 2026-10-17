'use strict';
// One e-certificate as a PDF: A4 landscape, drawn with pdfkit.
//
// The design is generated (a navy frame with a gold rule, the conference
// named across the top, "Certificate" and its kind, the name, the wording,
// the signatures, and a verify QR with the certificate number). When a
// designer's artwork is uploaded it is drawn full-page instead of the frame
// and the text is laid over it in the same places.
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
function richText(doc, text, x, y, width, size, lineGap) {
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
        doc.font(word.font).fillColor(C.ink).text(word.w, cx, cy, { lineBreak: false });
        cx += word.ww;
      });
      cy += lineHeight;
    }
    cy += lineGap * 1.5;
  }
  return cy;
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
// image }], background, specimen }
function renderCertificatePdf(opts) {
  const Doc = pdfkit();
  return new Promise((resolve, reject) => {
    const doc = new Doc({ size: 'A4', layout: 'landscape', margin: 0, info: { Title: `${opts.title || 'Certificate'} — ${opts.name || ''}`.trim(), Author: opts.conference && opts.conference.name } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      doc.registerFont('body', path.join(FONT_DIR, 'NotoSans-Regular.ttf'));
      doc.registerFont('bold', path.join(FONT_DIR, 'NotoSans-Bold.ttf'));
      const conf = opts.conference || {};

      if (opts.background) {
        doc.image(opts.background, 0, 0, { width: W, height: H });
      } else {
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
      }

      doc.font('Times-Bold').fontSize(46).fillColor(C.navy)
        .text(String(opts.title || 'Certificate').toUpperCase(), 0, 104, { width: W, align: 'center', characterSpacing: 6 });
      doc.font('Times-Italic').fontSize(20).fillColor(C.goldInk)
        .text(opts.subtitle || '', 0, 158, { width: W, align: 'center' });

      doc.font('body').fontSize(12).fillColor(C.muted)
        .text(opts.lead || 'This is to certify that', 0, 204, { width: W, align: 'center' });
      const name = String(opts.name || '');
      const nameFont = timesCan(name) ? 'Times-BoldItalic' : 'bold';
      let nameSize = 32;
      doc.font(nameFont).fontSize(nameSize);
      while (doc.widthOfString(name) > W - 220 && nameSize > 18) doc.fontSize(--nameSize);
      doc.fillColor(C.navy).text(name, 0, 226, { width: W, align: 'center' });
      doc.lineWidth(0.8).strokeColor(C.gold).moveTo(W / 2 - 220, 268).lineTo(W / 2 + 220, 268).stroke();

      richText(doc, opts.body, 110, 284, W - 220, 12.5, 4);

      // Signatures, spread evenly across the foot.
      const sigs = (opts.signatories || []).slice(0, 4);
      if (sigs.length) {
        const left = 90;
        const right = W - 170;               // the QR has the right-hand corner
        const slot = (right - left) / sigs.length;
        sigs.forEach((s, i) => {
          const cx = left + slot * i + slot / 2;
          const lineY = 486;
          if (s.image) {
            try { doc.image(s.image, cx - 65, lineY - 46, { fit: [130, 42], align: 'center', valign: 'bottom' }); } catch (e) { /* not an image pdfkit reads */ }
          }
          doc.lineWidth(0.6).strokeColor(C.muted).moveTo(cx - 75, lineY).lineTo(cx + 75, lineY).stroke();
          doc.font('bold').fontSize(9.5).fillColor(C.ink).text(s.name || '', cx - 90, lineY + 5, { width: 180, align: 'center' });
          doc.font('body').fontSize(8).fillColor(C.muted).text(s.designation || '', cx - 90, doc.y + 1, { width: 180, align: 'center' });
        });
      }

      // Verify: the QR, and the certificate number with where to check it.
      if (opts.qrPng) doc.image(opts.qrPng, W - 122, H - 132, { width: 66, height: 66 });
      doc.font('body').fontSize(7.5).fillColor(C.muted)
        .text(`Certificate No. ${opts.certNo || ''}`, W - 250, H - 62, { width: 194, align: 'right' });
      if (opts.verifyUrl) {
        doc.text(`Verify: ${String(opts.verifyUrl).replace(/^https?:\/\//, '')}`, 60, H - 62, { width: W - 330, align: 'left' });
      }

      if (opts.specimen) {
        doc.save().fillOpacity(0.12).fillColor('#b91c1c').font('Times-Bold').fontSize(110)
          .rotate(-24, { origin: [W / 2, H / 2] }).text('SPECIMEN', 0, H / 2 - 60, { width: W, align: 'center', lineBreak: false }).restore();
      }
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { renderCertificatePdf, PAGE: { W, H } };
