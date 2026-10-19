'use strict';
// One abstract as a PDF for the reviewer: A4 portrait, drawn with pdfkit.
//
// The stored sections hold sanitizeAbstractHtml() output: escaped text with
// only <b>, <i>, <sup> and <sub> restored. They are read back here into
// styled runs and laid out word by word, since pdfkit cannot raise or lower
// a run inside a line. Noto Sans (bundled, see assets/fonts) draws the text;
// there is no bundled italic, so italics use the built-in Helvetica-Oblique
// where it can draw the word, and Noto Sans regular where it cannot.
const path = require('path');
const { ensureTextDecoders } = require('./report-pdf');

const FONT_DIR = path.join(__dirname, 'assets', 'fonts');
const W = 595.28;
const H = 841.89;
const MARGIN = 56;
const C = { navy: '#1c3549', gold: '#b08d3c', ink: '#1e293b', muted: '#5b6b7d', rule: '#d8e0e6' };

let PDFDocument = null;
function pdfkit() {
  if (!PDFDocument) { ensureTextDecoders(); PDFDocument = require('pdfkit'); }
  return PDFDocument;
}

const latin1 = (s) => !/[^\u0000-ÿ–—‘’“”]/.test(String(s || ''));
const unescapeHtml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// Stored HTML -> [{ text, bold, italic, script }], script being 'sup' | 'sub' | ''.
function parseRuns(html) {
  const runs = [];
  const state = { b: 0, i: 0, sup: 0, sub: 0 };
  for (const part of String(html || '').split(/(<\/?(?:b|i|sup|sub)>)/)) {
    const tag = /^<(\/?)(b|i|sup|sub)>$/.exec(part);
    if (tag) { state[tag[2]] = Math.max(0, state[tag[2]] + (tag[1] ? -1 : 1)); continue; }
    if (!part) continue;
    runs.push({ text: unescapeHtml(part), bold: state.b > 0, italic: state.i > 0, script: state.sup > 0 ? 'sup' : state.sub > 0 ? 'sub' : '' });
  }
  return runs;
}

// Draws styled runs as a justified-left paragraph from (x, doc.y), wrapping
// at `width` and starting a new page when the bottom margin is reached.
function drawRuns(doc, runs, x, width, size, color, lineGap = 3) {
  const fontFor = (run, word) => {
    if (run.bold) return 'bold';
    if (run.italic && latin1(word)) return 'Helvetica-Oblique';
    return 'body';
  };
  const lineHeight = size * 1.3 + lineGap;
  const bottom = H - MARGIN - 20;
  let y = doc.y;
  let cx = x;
  const newLine = () => {
    cx = x; y += lineHeight;
    if (y + lineHeight > bottom) { doc.addPage(); y = MARGIN; }
  };
  if (y + lineHeight > bottom) { doc.addPage(); y = MARGIN; }
  for (const run of runs) {
    const small = run.script ? size * 0.7 : size;
    const rise = run.script === 'sup' ? -size * 0.35 : run.script === 'sub' ? size * 0.2 : 0;
    // Tokens keep their trailing space so a run that ends mid-word joins the next.
    const tokens = run.text.match(/\n|[^\s]+[^\S\n]*|[^\S\n]+/g) || [];
    for (const tok of tokens) {
      if (tok === '\n') { newLine(); continue; }
      const word = tok.replace(/\s+$/, '');
      const font = fontFor(run, tok);
      doc.font(font).fontSize(small);
      const full = doc.widthOfString(tok);
      const bare = doc.widthOfString(word);
      if (cx > x && cx + bare > x + width) newLine();
      if (word) doc.fillColor(color).text(word, cx, y + rise, { lineBreak: false });
      cx += full;
    }
  }
  doc.y = y + lineHeight;
  doc.x = x;
}

const STATUS_LABEL = {
  UNDER_REVIEW: 'Under review', ACCEPTED: 'Approved', REJECTED: 'Rejected', REVISION_REQUESTED: 'Corrections requested',
};

// abstract: the abstracts row. opts: { conference: { name, acronym } }
function renderAbstractPdf(abstract, opts = {}) {
  const Doc = pdfkit();
  const conf = opts.conference || {};
  return new Promise((resolve, reject) => {
    const doc = new Doc({
      size: 'A4', margin: MARGIN, bufferPages: true,
      info: { Title: abstract.title || 'Abstract', Author: abstract.author_name || '', Subject: `Abstract ${abstract.id}` },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      doc.registerFont('body', path.join(FONT_DIR, 'NotoSans-Regular.ttf'));
      doc.registerFont('bold', path.join(FONT_DIR, 'NotoSans-Bold.ttf'));
      const width = W - MARGIN * 2;

      // Header: conference, then a gold rule.
      doc.font('bold').fontSize(9).fillColor(C.gold)
        .text(String(conf.name || conf.acronym || 'Abstract').toUpperCase(), MARGIN, MARGIN, { width, characterSpacing: 0.6 });
      doc.moveDown(0.4);
      doc.lineWidth(1).strokeColor(C.gold).moveTo(MARGIN, doc.y).lineTo(W - MARGIN, doc.y).stroke();
      doc.moveDown(0.9);

      // Title, author, format and decision.
      doc.font('bold').fontSize(16).fillColor(C.navy).text(abstract.title || 'Untitled', MARGIN, doc.y, { width });
      doc.moveDown(0.5);
      doc.font('body').fontSize(10).fillColor(C.ink).text(abstract.author_name || '', MARGIN, doc.y, { width });
      const status = STATUS_LABEL[abstract.status || 'UNDER_REVIEW'] || abstract.status;
      const meta = [`Abstract #${abstract.id}`, abstract.format, status, abstract.allocation ? `Allotted: ${abstract.allocation.charAt(0)}${abstract.allocation.slice(1).toLowerCase()}` : '']
        .filter(Boolean).join('  ·  ');
      doc.font('body').fontSize(9).fillColor(C.muted).text(meta, MARGIN, doc.y + 2, { width });
      doc.moveDown(0.8);
      doc.lineWidth(0.5).strokeColor(C.rule).moveTo(MARGIN, doc.y).lineTo(W - MARGIN, doc.y).stroke();
      doc.moveDown(0.9);

      // A corrections note belongs with the abstract it was written for.
      if (abstract.status === 'REVISION_REQUESTED' && abstract.revision_note) {
        doc.font('bold').fontSize(8).fillColor('#b45309').text('CORRECTIONS REQUESTED', MARGIN, doc.y, { width, characterSpacing: 0.5 });
        doc.moveDown(0.2);
        drawRuns(doc, [{ text: abstract.revision_note, bold: false, italic: false, script: '' }], MARGIN, width, 10, '#92400e');
        doc.moveDown(0.6);
      }

      // The structured sections. Older abstracts hold one block of text.
      const sections = [['Background', abstract.background], ['Aim', abstract.aim], ['Methods', abstract.methods],
        ['Results', abstract.results], ['Conclusion', abstract.conclusion]].filter(([, v]) => v && String(v).trim());
      if (!sections.length && abstract.text) sections.push(['Abstract', abstract.text]);
      for (const [label, html] of sections) {
        if (doc.y > H - MARGIN - 80) doc.addPage();
        doc.font('bold').fontSize(8).fillColor(C.muted).text(label.toUpperCase(), MARGIN, doc.y, { width, characterSpacing: 0.5 });
        doc.moveDown(0.25);
        drawRuns(doc, parseRuns(html), MARGIN, width, 10.5, C.ink);
        doc.moveDown(0.7);
      }

      if (abstract.keywords) {
        doc.font('bold').fontSize(9).fillColor(C.ink).text('Keywords: ', MARGIN, doc.y, { width, continued: true })
          .font('body').text(unescapeHtml(String(abstract.keywords)));
      }
      if (abstract.word_count) {
        doc.moveDown(0.3);
        doc.font('body').fontSize(8).fillColor(C.muted).text(`${abstract.word_count} words`, MARGIN, doc.y, { width });
      }

      // Page numbers, once the page count is known.
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        doc.page.margins.bottom = 0; // text below the margin would otherwise start a page
        doc.font('body').fontSize(8).fillColor(C.muted)
          .text(`Page ${i + 1} of ${range.count}`, MARGIN, H - MARGIN + 8, { width, align: 'right', lineBreak: false });
      }
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { renderAbstractPdf, parseRuns };
