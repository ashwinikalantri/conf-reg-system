// Reports as a real PDF, drawn on the server.
//
// Safari printed every report blank -- a preview that rendered, then emptied a
// moment later, the one-page Summary included -- and two rounds of fixing the
// print page could not be tested against Safari from here. So the PDF is no
// longer the browser's to make: GET ?format=pdf returns a file pdfkit drew,
// and the PDF buttons download it.
//
// What this file holds it to, each a way it could be built wrongly:
//   * it is a real, non-blank PDF with the report's own text in it, fonts
//     embedded (no dependence on what the reader's machine has);
//   * the rupee sign survives -- the web font has none, which is why the PDF
//     carries Noto Sans;
//   * it reveals nothing the page would not: the same permission and the
//     same per-block gating as every other format;
//   * a long report paginates properly: the header on every page, no row
//     lost or duplicated, "Page n of m" on each;
//   * the buttons download it, and a refusal shows as a message rather than
//     replacing the panel.
const { call, check, report, ADMIN_PW, appFile, adminLogin, loginPassword, openDb } = require('./harness');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nqocn-pdf-'));
let n = 0;
const save = (buf) => { const f = path.join(tmp, `r${n++}.pdf`); fs.writeFileSync(f, buf); return f; };
const text = (buf, page) => execFileSync('pdftotext',
  [...(page ? ['-f', String(page), '-l', String(page)] : []), '-layout', save(buf), '-']).toString();
const pageCount = (buf) => Number((/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [save(buf)]).toString()) || [])[1]);
const fonts = (buf) => execFileSync('pdffonts', [save(buf)]).toString().split('\n').slice(2).filter(Boolean);
// Share of page 1 that is not white, from a small greyscale render. A blank
// PDF -- the actual complaint -- scores 0.
function ink(buf) {
  const root = path.join(tmp, `ink${n++}`);
  execFileSync('pdftoppm', ['-f', '1', '-l', '1', '-r', '30', '-gray', save(buf), root]);
  const file = fs.readdirSync(tmp).find((f) => f.startsWith(path.basename(root)));
  const pgm = fs.readFileSync(path.join(tmp, file));
  // P5 header: "P5\n<w> <h>\n<max>\n", then one byte per pixel.
  let at = 0;
  for (let fields = 0; fields < 4; fields++) {
    while (/\s/.test(String.fromCharCode(pgm[at]))) at++;
    while (!/\s/.test(String.fromCharCode(pgm[at]))) at++;
  }
  const px = pgm.subarray(at + 1);
  let dark = 0;
  for (const v of px) if (v < 200) dark++;
  return dark / px.length;
}
const has = (tool) => { try { execFileSync('which', [tool], { stdio: 'ignore' }); return true; } catch (e) { return false; } };

(async () => {
  console.log('\n== The tools that read the PDF back are here ==');
  const tools = ['pdftotext', 'pdfinfo', 'pdffonts', 'pdftoppm'].filter((t) => !has(t));
  check('poppler-utils is installed (pdftotext, pdfinfo, pdffonts, pdftoppm)', tools.length === 0, tools);
  if (tools.length) { report(); return; }

  const admin = await adminLogin();
  const db = openDb({ readOnly: true });
  const pdf = (type, cookie, q = '') => call('GET', `/api/admin/reports/${type}?format=pdf${q}`, null, cookie);

  console.log('\n== The Summary comes back as a real PDF file ==');
  const sum = await pdf('summary', admin);
  check('it responds', sum.status === 200, sum.status);
  check('...as a PDF', /^application\/pdf/.test(sum.type || ''), sum.type);
  check('...to be saved, under the conference\'s name for it',
    sum.headers['content-disposition'] === 'attachment; filename="fixcon2099-summary-report.pdf"', sum.headers['content-disposition']);
  check('...and it is a PDF, byte for byte', sum.buf.slice(0, 5).toString() === '%PDF-', sum.buf.slice(0, 8).toString());
  check('...never cached, like every report', /no-store/.test(sum.headers['cache-control'] || ''));

  console.log('\n== ...and it is not blank ==');
  const sumText = text(sum.buf);
  const inkShare = ink(sum.buf);
  check('page 1 has something printed on it', inkShare > 0.01, inkShare.toFixed(4));
  check('it carries the heading', sumText.includes('FIXCON 2099 · Summary — Headline Figures'), sumText.slice(0, 120));
  check('...and says what it is', sumText.includes('Summary figures — no individual records'));
  check('...with the blocks', ['Registrations', 'Money', 'Programme occupancy', 'Abstracts'].every((b) => sumText.includes(b)));
  check('the rupee sign survives (the web font has none)', sumText.includes('₹'));
  check('pages are numbered', /Page 1 of \d+/.test(sumText));
  const f = fonts(sum.buf);
  check('its font is embedded, so it reads the same on any machine',
    f.length > 0 && f.every((line) => /NotoSans/.test(line) && /\byes\s+yes\s+yes\b/.test(line)), f);

  console.log('\n== It is the report, not a picture of it ==');
  const json = (await call('GET', '/api/admin/reports/summary?format=json', null, admin)).body.report;
  const collected = json.sections.find((s) => s.name === 'Money').rows.find((r) => /^Collected/.test(r[0]));
  check('the collected figure is the report\'s own', sumText.includes(String(collected[2])), collected);
  const regs = (await db.all('SELECT registration_number AS r FROM registrations')).map((x) => x.r).filter(Boolean);
  check('fixture: there are registration numbers to look for', regs.length > 3, regs.length);
  check('like every other format of the Summary, it names no one', !regs.some((r) => sumText.includes(r)));

  const del = await pdf('delegates', admin);
  const delText = text(del.buf);
  const delJson = (await call('GET', '/api/admin/reports/delegates?format=json', null, admin)).body.report;
  const delRows = delJson.sections.reduce((a, s) => a + s.rows.length, 0);
  check('a line-list report lists its records', delRows > 0 && regs.filter((r) => delText.includes(r)).length > 0,
    { delRows, found: regs.filter((r) => delText.includes(r)).length });
  check('...under its column headings', /REG NO/.test(delText) && /EMAIL/.test(delText));
  check('...and counts them as the page does', delText.includes(`${delRows} record(s)`), delRows);
  check('...saved under its own name', /filename="fixcon2099-delegates-report\.pdf"/.test(del.headers['content-disposition'] || ''));

  console.log('\n== It shows only what the page would ==');
  const desk = await pdf('summary', await loginPassword('9000000006', ADMIN_PW));
  check('the Front Desk, which holds no report, is refused', desk.status === 403 && desk.body.success === false, desk.status);
  const opsText = text((await pdf('summary', await loginPassword('9000000004', ADMIN_PW))).buf);
  check('Operations gets its Summary PDF', opsText.includes('Registrations'));
  check('...without the Money block or a single rupee figure', !opsText.includes('Money') && !opsText.includes('₹'));
  const noOption = await pdf('workshops', admin);
  check('a workshop PDF with no workshop picked is refused with a reason',
    noOption.status === 400 && /Select a workshop/.test(noOption.body.error || ''), [noOption.status, noOption.body.error]);

  console.log('\n== A long report paginates properly ==');
  // Through the renderer itself: the fixture is too small to run to pages.
  const { renderReportPdf } = require(appFile('report-pdf.js'));
  const rows = Array.from({ length: 300 }, (_, i) => [
    `ROW-${String(i + 1).padStart(4, '0')}`, `Delegate ${i}`,
    `someone.with.a.long.address${i}@example-institute.ac.in`, 'Nurse / Community Health Officer',
    `₹${(1500 + i).toLocaleString('en-IN')}`, i % 7 ? 'AIIMS, Nagpur' : 'Mahatma Gandhi Institute of Medical Sciences, Sevagram']);
  const long = await renderReportPdf({ title: 'Long', sections: [
    { name: 'Delegates', columns: ['Reg No', 'Name', 'Email', 'Category', 'Amount', 'Institution'], rows },
    { name: 'Nothing here', columns: ['A', 'B'], rows: [] },
  ] }, { heading: 'FIXCON · Long', subline: 'Generated now · 300 record(s)', footer: 'FIXCON · Long' });
  const pages = pageCount(long);
  check('it runs to several pages', pages > 3, pages);
  const perPage = Array.from({ length: pages }, (_, i) => text(long, i + 1));
  check('the column headings repeat on every page', perPage.every((t) => /REG NO/.test(t)),
    perPage.map((t, i) => (/REG NO/.test(t) ? null : i + 1)).filter(Boolean));
  check('every page says which it is', perPage.every((t, i) => t.includes(`Page ${i + 1} of ${pages}`)));
  const ids = perPage.join('\n').match(/ROW-\d{4}/g) || [];
  check('no row is lost', new Set(ids).size === 300, new Set(ids).size);
  check('...or printed twice', ids.length === 300, ids.length);
  check('an empty section says so rather than drawing nothing', perPage.join('\n').includes('No records'));
  check('no page is left blank at the end', perPage[pages - 1].replace(/Page \d+ of \d+|FIXCON · Long/g, '').trim().length > 0);

  console.log('\n== The report page offers the PDF, not the print dialog ==');
  const page = await call('GET', '/api/admin/reports/summary', null, admin);
  check('the page links to the PDF', /<a id="download-pdf" href="\/api\/admin\/reports\/summary\?format=pdf">Download PDF<\/a>/.test(String(page.body)));
  check('...with the same heading the PDF carries', String(page.body).includes('<h1>FIXCON 2099 · Summary — Headline Figures</h1>'));

  console.log('\n== The PDF buttons download the file ==');
  // downloadReport driven for real in a sandbox, with fetch, the blob URL and
  // the link click stubbed so what it asked for and what it did are visible.
  const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
  const mkEl = (tag) => ({ tag, href: '', download: '', style: {}, dataset: {}, clicks: 0, innerHTML: '', textContent: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    click() { this.clicks++; }, remove() {}, appendChild() {}, addEventListener() {}, setAttribute() {},
    getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [] });
  const made = [];
  const doc = { getElementById: () => mkEl('div'), querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, createElement: (t) => { const e = mkEl(t); made.push(e); return e; },
    body: mkEl('body'), documentElement: mkEl('html'), readyState: 'loading', cookie: '' };
  const asked = [];
  const toasts = [];
  let respond = null;
  class SandboxURL extends URL {}
  SandboxURL.createObjectURL = () => 'blob:fixture';
  SandboxURL.revokeObjectURL = () => {};
  const sandbox = {
    document: doc,
    window: { addEventListener() {}, open: (u) => asked.push(['window.open', u]), location: { href: '', hash: '', pathname: '/', search: '' },
      matchMedia: () => ({ matches: false, addEventListener() {} }), history: { replaceState() {} } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node' },
    fetch: async (u) => { asked.push(u); return respond(u); },
    console: { log() {}, warn() {}, error() {}, info() {} },
    // The minute-long revoke timer must not hold this process open.
    setTimeout: (fn, ms) => (ms >= 1000 ? 0 : setTimeout(fn, ms)), clearTimeout, setInterval: () => 0, clearInterval,
    URL: SandboxURL, Intl, Date, Math, JSON, Promise, requestAnimationFrame: () => 0,
    __toasts: toasts,
  };
  sandbox.window.document = doc; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${js}
    showToast = (msg) => { globalThis.__toasts.push(msg); };
    globalThis.__dl = downloadReport;`, sandbox, { filename: 'app.js+driver' });
  const ok = (name) => () => ({ ok: true, headers: { get: (h) => (h === 'Content-Disposition' ? `attachment; filename="${name}"` : null) }, blob: async () => 'BLOB' });

  respond = ok('fixcon2099-summary-report.pdf');
  await sandbox.__dl('summary');
  const link = made.filter((e) => e.tag === 'a').pop();
  check('the PDF button asks the server for a PDF', asked[asked.length - 1] === '/api/admin/reports/summary?format=pdf', asked);
  check('...and saves it under the server\'s filename',
    !!link && link.download === 'fixcon2099-summary-report.pdf' && link.href === 'blob:fixture' && link.clicks === 1, link && { d: link.download, h: link.href, c: link.clicks });
  check('...saying it is on its way, since a long one takes a moment', toasts.includes('Preparing the PDF…'), toasts);
  check('...without opening a tab for the browser to print', !asked.some((a) => Array.isArray(a) && a[0] === 'window.open'));

  respond = ok('x.pdf');
  await sandbox.__dl('workshops', null, '&optionId=5');
  check('the workshop PDF keeps the picked workshop', asked[asked.length - 1] === '/api/admin/reports/workshops?format=pdf&optionId=5', asked[asked.length - 1]);
  respond = ok('fixcon2099-delegates-report.csv');
  toasts.length = 0;
  await sandbox.__dl('delegates', 'csv');
  check('Excel still downloads CSV', asked[asked.length - 1] === '/api/admin/reports/delegates?format=csv');
  check('...without the PDF\'s "preparing" note', !toasts.includes('Preparing the PDF…'));

  respond = () => ({ ok: false, json: async () => ({ success: false, error: 'You do not have permission for this report.' }) });
  const before = made.filter((e) => e.tag === 'a' && e.clicks).length;
  await sandbox.__dl('users', 'csv');
  check('a refusal shows the server\'s reason', toasts.includes('You do not have permission for this report.'), toasts);
  check('...and saves nothing', made.filter((e) => e.tag === 'a' && e.clicks).length === before);

  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  report();
})();
