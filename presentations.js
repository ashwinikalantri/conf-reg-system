// Presentations: the file each presenter uploads before the conference --
// their e-poster, paper or award paper -- checked, named and bundled here.
// Pure (no database), so it can be tested on its own; the routes are in
// server.js.
//
// The rules follow the presentation guidelines (website /presentations):
//   e-poster       one 16:9 slide, as a PDF, under 10 MB;
//   paper / award  a PDF, under 50 MB.
// Every file is a PDF (owner, 17 Nov 2026: PowerPoint was allowed for
// papers until then).
// The file is named <registration no>_<name>_<type>, e.g.
// NQOCN20260045_Ashwini_Kalantri_Poster.pdf, so the AV team never has to.

const zlib = require('zlib');

const MB = 1024 * 1024;
const RULES = {
  POSTER: { kinds: ['pdf'], maxBytes: 10 * MB, onePage: true, label: 'Poster', noun: 'e-poster',
    text: 'PDF, one slide, under 10 MB', template: 'eposter' },
  ORAL: { kinds: ['pdf'], maxBytes: 50 * MB, onePage: false, label: 'Oral', noun: 'paper',
    text: 'PDF, under 50 MB', template: 'paper' },
  AWARD: { kinds: ['pdf'], maxBytes: 50 * MB, onePage: false, label: 'Award', noun: 'award paper',
    text: 'PDF, under 50 MB', template: 'paper' },
};
// The largest any format takes: what the upload itself is cut off at.
const MAX_BYTES = Math.max(...Object.values(RULES).map((r) => r.maxBytes));

// What the bytes are, whatever the file was called: a PDF starts "%PDF-"
// (allowed a little leading junk, as readers do); a .pptx is a zip holding
// ppt/presentation.xml -- told apart only so the refusal can say a
// PowerPoint file is not accepted. An old binary .ppt, a .docx or a renamed
// image is neither.
function fileKind(buf) {
  if (!buf || !buf.length) return null;
  if (buf.slice(0, 1024).toString('latin1').includes('%PDF-')) return 'pdf';
  if (buf.slice(0, 4).toString('latin1') === 'PK\u0003\u0004' && buf.includes('ppt/presentation.xml', 0, 'latin1')) return 'pptx';
  return null;
}

// How many pages a PDF has, or null when that cannot be told. Counts the
// page objects by their object number -- so a page rewritten by a later
// edit (an incremental update) is still one page -- including those packed
// into compressed object streams. Stream contents are skipped, so an image
// that happens to hold the bytes "/Type /Page" is not mistaken for one.
function pdfPageCount(buf) {
  const s = buf.toString('latin1');
  const pages = new Set();
  const isPage = (dict) => /\/Type\s*\/Page(?![A-Za-z])/.test(dict);
  const objRe = /(\d+)\s+\d+\s+obj\b/g;
  let m;
  while ((m = objRe.exec(s))) {
    const start = objRe.lastIndex;
    const end = s.indexOf('endobj', start);
    const stop = end < 0 ? s.length : end;
    const streamAt = s.indexOf('stream', start);
    const hasStream = streamAt >= 0 && streamAt < stop;
    const dict = s.slice(start, hasStream ? streamAt : stop);
    if (isPage(dict)) pages.add(`o${m[1]}`);
    if (hasStream && /\/Type\s*\/ObjStm/.test(dict) && /\/FlateDecode/.test(dict)) {
      for (const n of objStmPages(s, dict, streamAt, stop, isPage)) pages.add(`o${n}`);
    }
    if (end < 0) break;
    objRe.lastIndex = end + 6;
  }
  return pages.size || null;
}

// The page objects inside one compressed object stream: its header lists
// "objnum offset" pairs, then the objects themselves from /First on.
function objStmPages(s, dict, streamAt, stop, isPage) {
  const out = [];
  try {
    let from = streamAt + 6;
    if (s[from] === '\r') from += 1;
    if (s[from] === '\n') from += 1;
    const to = s.lastIndexOf('endstream', stop);
    const data = zlib.inflateSync(Buffer.from(s.slice(from, to < from ? stop : to), 'latin1')).toString('latin1');
    const n = Number((/\/N\s+(\d+)/.exec(dict) || [])[1]);
    const first = Number((/\/First\s+(\d+)/.exec(dict) || [])[1]);
    if (!Number.isInteger(n) || !Number.isInteger(first)) return out;
    const nums = data.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i += 1) {
      const at = first + nums[2 * i + 1];
      const next = i + 1 < n ? first + nums[2 * i + 3] : data.length;
      if (isPage(data.slice(at, next))) out.push(nums[2 * i]);
    }
  } catch (e) { /* not a stream we can read: its pages go uncounted */ }
  return out;
}

// Whether this file will do for this format: null if so, else what to tell
// the presenter. pages is the PDF's page count (null when unknown).
function checkFile(allocation, buf) {
  const rule = RULES[allocation];
  if (!rule) return { error: 'This abstract has no presentation format yet.' };
  const kind = fileKind(buf);
  if (!kind || !rule.kinds.includes(kind)) {
    return { error: `Upload your ${rule.noun} as a PDF${kind === 'pptx' ? ', not a PowerPoint file' : ''}: in PowerPoint, File › Save As › PDF.` };
  }
  if (buf.length > rule.maxBytes) {
    return { error: `The file is ${(buf.length / MB).toFixed(1)} MB. ${rule.noun[0].toUpperCase()}${rule.noun.slice(1)}s must be under ${rule.maxBytes / MB} MB: compress the pictures and save it again.` };
  }
  const pages = kind === 'pdf' ? pdfPageCount(buf) : null;
  if (rule.onePage && pages > 1) {
    return { error: `The PDF has ${pages} pages. An e-poster is one slide: keep the layout you used, delete the other slides and save as PDF again.` };
  }
  return { kind, pages };
}

// A name as it can sit in a file name: letters and digits, words joined by
// "_", accents dropped ("Dr. Anjali Deshpandé" -> "Anjali_Deshpande").
function nameForFile(name) {
  const plain = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/^\s*(dr|prof|mr|mrs|ms|miss)\.?\s+/i, '');
  const words = plain.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return words.join('_').slice(0, 60) || 'Presenter';
}

// <registration no>_<name>_<type>.<pdf|pptx>
function fileName(regNo, name, allocation, kind) {
  const reg = String(regNo || '').replace(/[^A-Za-z0-9-]/g, '') || 'NoRegNo';
  const type = RULES[allocation] ? RULES[allocation].label : 'Presentation';
  return `${reg}_${nameForFile(name)}_${type}.${kind === 'pptx' ? 'pptx' : 'pdf'}`;
}

// The last date, stored as "YYYY-MM-DDTHH:MM" in India time, as a moment.
function dueMs(due) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(String(due || ''));
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:00+05:30`) : null;
}
const isOpen = (due, now = Date.now()) => { const t = dueMs(due); return t == null || now < t; };

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// "10:00 AM, Friday 20 November 2026"
function dueText(due) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(due || ''));
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const h = +m[4];
  return `${((h + 11) % 12) + 1}:${m[5]} ${h < 12 ? 'AM' : 'PM'}, ${DAYS[d.getUTCDay()]} ${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}`;
}

// --- ZIP, for "Download all" -------------------------------------------------
// Stored, not compressed: PDFs and .pptx files are compressed already, and
// storing lets each file go straight out as it is read, one at a time.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// Writes a zip of entries [{ name, read: async () => Buffer }] to a stream.
// A file that cannot be read is left out, not the whole download.
async function writeZip(out, entries, when = new Date()) {
  const dosTime = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
  const dosDate = ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const write = (b) => new Promise((resolve) => { if (out.write(b)) resolve(); else out.once('drain', resolve); });
  const central = [];
  let offset = 0;
  for (const e of entries) {
    let data;
    try { data = await e.read(); } catch (err) { continue; }
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8); local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    await write(local); await write(name); await write(data);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(0, 10); head.writeUInt16LE(dosTime, 12); head.writeUInt16LE(dosDate, 14);
    head.writeUInt32LE(crc, 16); head.writeUInt32LE(data.length, 20); head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(name.length, 28); head.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([head, name]));
    offset += 30 + name.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  await write(dir); await write(end);
}

module.exports = { RULES, MAX_BYTES, fileKind, pdfPageCount, checkFile, nameForFile, fileName, dueMs, isOpen, dueText, crc32, writeZip };
