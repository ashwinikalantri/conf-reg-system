// Presentations (17 Nov 2026): each presenter uploads their e-poster or paper
// in the portal before the last date; the file is named
// <registration no>_<name>_<type>; staff see what has come in on the
// abstracts desk (Step 3), open it, download all as a zip, upload on a
// presenter's behalf, and move the last date. The presenters are an audience
// in the Reminders composer, and the guidelines are a page on the website.
// The rules: an e-poster is a one-slide PDF under 10 MB; a paper or award
// paper a PDF under 50 MB (PowerPoint was taken for papers until the owner
// made every file a PDF, the same day).
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { call, adminLogin, loginOtp, loginPassword, ADMIN_PW, HOST, PORT, appFile, dataDir, check, report, openDb } = require('./harness');
const P = require('../presentations');

// A PDF of n pages, written out as a slide export is: a catalog, a page
// tree, and each page with its content stream -- whose text says
// "/Type /Page", which must not count as one.
function pdfOf(n) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${Array.from({ length: n }, (_, i) => `${3 + 2 * i} 0 R`).join(' ')}] /Count ${n} >>`];
  for (let i = 0; i < n; i += 1) {
    const text = `BT /F1 24 Tf 72 400 Td (Slide ${i + 1}: /Type /Page in the text) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 960 540] /Contents ${4 + 2 * i} 0 R >>`);
    objs.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  }
  return Buffer.from(`%PDF-1.4\n${objs.map((o, i) => `${i + 1} 0 obj\n${o}\nendobj\n`).join('')}trailer << /Root 1 0 R >>\n%%EOF\n`, 'latin1');
}

// A .pptx in shape: a zip holding ppt/presentation.xml.
async function pptx() {
  const chunks = [];
  const sink = { write: (b) => { chunks.push(Buffer.from(b)); return true; }, once() {} };
  await P.writeZip(sink, [{ name: '[Content_Types].xml', read: async () => Buffer.from('<Types/>') }, { name: 'ppt/presentation.xml', read: async () => Buffer.from('<p:presentation/>') }]);
  return Buffer.concat(chunks);
}

// Posted as the portal does: a multipart form with one file.
function upload(url, buf, filename, cookie) {
  return new Promise((resolve, reject) => {
    const boundary = `----t${Date.now()}${Math.random().toString(16).slice(2)}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      buf, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const r = http.request({ host: HOST, port: PORT, path: url, method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length, ...(cookie ? { Cookie: cookie } : {}) } },
    (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => {
      let b = Buffer.concat(c).toString(); try { b = JSON.parse(b); } catch (e) { /* text */ }
      resolve({ status: res.statusCode, body: b }); }); });
    r.on('error', reject); r.write(body); r.end();
  });
}

const IST = 5.5 * 3600e3;
const istAt = (hours) => new Date(Date.now() + IST + hours * 3600e3).toISOString().slice(0, 16);

(async () => {
  console.log('\n== The rules, on their own ==');
  const one = pdfOf(1);
  const three = pdfOf(3);
  const deck = await pptx();
  check('a PDF and a .pptx are told by their bytes, not their names', P.fileKind(one) === 'pdf' && P.fileKind(deck) === 'pptx'
    && P.fileKind(Buffer.from('PK\u0003\u0004 a zip that is no presentation')) === null && P.fileKind(Buffer.from('hello')) === null);
  check('pages are counted, and words on a slide are not pages', P.pdfPageCount(one) === 1 && P.pdfPageCount(three) === 3, [P.pdfPageCount(one), P.pdfPageCount(three)]);
  {
    // Pages packed in a compressed object stream, as Acrobat saves them.
    const a = '<< /Type /Page /Parent 2 0 R >>';
    const b = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
    const head = `3 0 2 ${a.length + 1} `;
    const packed = zlib.deflateSync(Buffer.from(`${head}${a} ${b}`, 'latin1'));
    const pdf = Buffer.concat([
      Buffer.from(`%PDF-1.5\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n5 0 obj << /Type /ObjStm /N 2 /First ${head.length} /Filter /FlateDecode /Length ${packed.length} >>\nstream\n`, 'latin1'),
      packed, Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1')]);
    check('...including pages packed in a compressed object stream', P.pdfPageCount(pdf) === 1, P.pdfPageCount(pdf));
  }
  check('an e-poster: one page, PDF only', !P.checkFile('POSTER', one).error && /3 pages/.test(P.checkFile('POSTER', three).error)
    && /PDF/.test(P.checkFile('POSTER', deck).error));
  check('a paper or award paper: a PDF, any number of slides', !P.checkFile('ORAL', three).error && !P.checkFile('AWARD', one).error);
  check('...and a PowerPoint file is refused for every format, saying so', ['ORAL', 'AWARD', 'POSTER'].every((f) => /as a PDF, not a PowerPoint file/.test(P.checkFile(f, deck).error)));
  const big = Buffer.concat([one, Buffer.alloc(10 * 1024 * 1024)]);
  check('an e-poster over 10 MB is refused, a paper of that size is not', /under 10 MB/.test(P.checkFile('POSTER', big).error) && !P.checkFile('ORAL', big).error);
  check('named <registration no>_<name>_<type>, the salutation and accents dropped',
    P.fileName('NQOCN20260045', 'Dr. Anjali Deshpandé', 'POSTER', 'pdf') === 'NQOCN20260045_Anjali_Deshpande_Poster.pdf'
    && P.fileName('NQOCN20260046', 'R. K. Sharma', 'AWARD', 'pdf') === 'NQOCN20260046_R_K_Sharma_Award.pdf'
    && P.fileName('NQOCN20260047', 'Asha Patil', 'ORAL', 'pdf') === 'NQOCN20260047_Asha_Patil_Oral.pdf');
  check('the last date reads as India time', P.dueText('2026-11-20T10:00') === '10:00 AM, Friday 20 November 2026'
    && P.isOpen('2026-11-20T10:00', Date.parse('2026-11-20T04:29:00Z')) && !P.isOpen('2026-11-20T10:00', Date.parse('2026-11-20T04:30:00Z')));
  {
    const chunks = [];
    const sink = { write: (b) => { chunks.push(Buffer.from(b)); return true; }, once() {} };
    await P.writeZip(sink, [{ name: 'A_Oral.pdf', read: async () => one }, { name: 'gone.pdf', read: async () => { throw new Error('missing'); } }]);
    const z = Buffer.concat(chunks);
    const end = z.slice(z.length - 22);
    check('the zip holds what could be read, intact', end.readUInt32LE(0) === 0x06054b50 && end.readUInt16LE(10) === 1
      && z.readUInt32LE(14) === P.crc32(one) && z.slice(30 + 10, 30 + 10 + one.length).equals(one));
  }

  const admin = await adminLogin();
  const desk = await loginPassword('9000000006', ADMIN_PW);
  const db = openDb();
  const abs = await db.get("SELECT * FROM abstracts WHERE title = 'Accepted and assigned'");
  const presenter = await db.get('SELECT full_name, registration_number FROM users WHERE phone_number = ?', [abs.phone_number]);
  const dueBefore = (await call('GET', '/api/conference', null, null)).body.presentationsDue;
  // Step 3 holds the abstracts whose decision email has gone (the fixture's
  // was never sent: there is no mail here).
  await db.run('UPDATE abstracts SET decision_sent_at = ? WHERE id = ?', [Date.now(), abs.id]);
  const dir = appFile('uploads', 'presentations');
  const setDue = (due, as = admin) => call('PUT', '/api/admin/presentations/due', { due }, as);
  try {
    check('fixture: an accepted paper by a registered delegate', abs && abs.status === 'ACCEPTED' && abs.allocation === 'ORAL' && !!presenter.registration_number);
    check('the last date is set out of the box, as announced', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dueBefore || ''), dueBefore);
    check('the front desk may not move it', (await setDue(istAt(48), desk)).status === 403);
    check('a date needs a time too', (await setDue('2026-11-20')).status === 400);
    const moved = await setDue(istAt(48));
    check('the abstracts desk moves it', moved.body.success === true && moved.body.open === true && !!moved.body.dueText, moved.body);

    console.log('\n== The presenter ==');
    const me = await loginOtp(abs.phone_number);
    const card = (await call('GET', '/api/abstracts/me', null, me)).body.presentation;
    check('their card says what to send and by when', card && card.label === 'Oral' && card.noun === 'paper' && card.kinds.join() === 'pdf' && card.text === 'PDF, under 50 MB'
      && card.maxMb === 50 && card.template === 'paper' && card.open === true && card.file === null, card);
    check('nothing is not a file', (await upload('/api/abstracts/me/presentation', Buffer.alloc(0), 'x.pdf', me)).status === 400);
    const junk = await upload('/api/abstracts/me/presentation', Buffer.from('not a presentation at all'), 'talk.pdf', me);
    check('a file that is no PDF is refused, whatever it is called', junk.status === 400 && /Upload your paper as a PDF/.test(junk.body.error), junk.body);
    const sent = await upload('/api/abstracts/me/presentation', three, 'my talk final v3.pdf', me);
    const name = `${presenter.registration_number}_${P.nameForFile(presenter.full_name)}_Oral.pdf`;
    check('a PDF is received, named for them', sent.body.success === true && sent.body.presentation.file.fileName === name
      && sent.body.presentation.file.pages === 3, sent.body);
    check('...kept under that name', fs.existsSync(path.join(dir, name)));
    check('...and logged', !!(await db.get("SELECT 1 FROM audit_log WHERE action = 'PRESENTATION_UPLOADED' AND entity_id = ?", [String(abs.id)])));
    const own = await call('GET', '/api/abstracts/me/presentation', null, me);
    check('they can open it, in the browser', own.status === 200 && own.type === 'application/pdf' && /^inline; filename="/.test(own.headers['content-disposition']) && own.buf.equals(three));
    const ppt = await upload('/api/abstracts/me/presentation', deck, 'talk.pptx', me);
    check('a PowerPoint file is refused, saying so', ppt.status === 400 && /not a PowerPoint file/.test(ppt.body.error), ppt.body);
    const two = pdfOf(2);
    const replaced = await upload('/api/abstracts/me/presentation', two, 'talk final.pdf', me);
    check('a new PDF replaces the old, under the same name', replaced.body.success === true && replaced.body.presentation.file.fileName === name
      && replaced.body.presentation.file.pages === 2, replaced.body);
    check('...the new one is what is kept', fs.readFileSync(path.join(dir, name)).equals(two));
    check('someone else cannot read it', (await call('GET', '/api/abstracts/me/presentation', null, admin)).status === 404);

    console.log('\n== As an e-poster ==');
    await db.run("UPDATE abstracts SET allocation = 'POSTER' WHERE id = ?", [abs.id]);
    const poster = (await call('GET', '/api/abstracts/me', null, me)).body.presentation;
    check('the card asks for a one-slide PDF under 10 MB, on the e-poster template', poster.kinds.join() === 'pdf' && poster.maxMb === 10 && poster.onePage && poster.template === 'eposter');
    check('...still showing what they sent for the paper', poster.file && poster.file.allocation === 'ORAL');
    const many = await upload('/api/abstracts/me/presentation', three, 'poster.pdf', me);
    check('three slides are refused', many.status === 400 && /3 pages/.test(many.body.error), many.body);
    check('...and so is a .pptx', (await upload('/api/abstracts/me/presentation', deck, 'poster.pptx', me)).status === 400);
    const posted = await upload('/api/abstracts/me/presentation', one, 'poster.pdf', me);
    check('one slide is received, named as a poster', posted.body.success === true && /_Poster\.pdf$/.test(posted.body.presentation.file.fileName), posted.body);

    console.log('\n== The abstracts desk ==');
    check('the front desk cannot see them', (await call('GET', '/api/admin/presentations', null, desk)).status === 403);
    const list = (await call('GET', '/api/admin/presentations', null, admin)).body;
    const mine = list.presentations.find((x) => x.id === abs.id);
    check('each abstract with a format, its presenter, number and file', list.success && mine && mine.regNo === presenter.registration_number
      && mine.allocation === 'POSTER' && mine.file && /_Poster\.pdf$/.test(mine.file.fileName) && list.rules.POSTER.maxMb === 10, mine);
    check('...with all its authors, the presenting one marked', Array.isArray(mine.authors) && mine.authors.length >= 1
      && mine.authors.filter((a) => a.presenting).length === 1 && mine.authors.every((a) => a.name)
      && typeof mine.authorsGiven === 'boolean', mine.authors);
    check('...and only those', list.presentations.every((x) => ['ORAL', 'POSTER', 'AWARD'].includes(x.allocation)));
    const file = await call('GET', `/api/admin/presentations/${abs.id}/file`, null, admin);
    check('a file opens', file.status === 200 && file.buf.equals(one));
    const zip = await call('GET', '/api/admin/presentations/zip?format=POSTER', null, admin);
    check('the e-posters download as one zip, by their names', zip.status === 200 && zip.type === 'application/zip'
      && zip.buf.includes(Buffer.from(mine.file.fileName)) && /Presentations_Poster_/.test(zip.headers['content-disposition']));
    check('...and an empty format says so', (await call('GET', '/api/admin/presentations/zip?format=AWARD', null, admin)).status === 404
      || (await db.get("SELECT 1 FROM presentations p JOIN abstracts a ON a.id = p.abstract_id WHERE a.allocation = 'AWARD'")));

    console.log('\n== Copies on Google Drive ==');
    // The host script's reports, as it writes them beside the database.
    const driveFile = (n) => path.join(dataDir(), `.presentations-drive-${n}.json`);
    const clearDrive = () => ['status', 'error', 'request'].forEach((n) => { try { fs.unlinkSync(driveFile(n)); } catch (e) { /* none */ } });
    clearDrive();
    try {
      let d = (await call('GET', '/api/admin/presentations', null, admin)).body;
      check('before any copy: the folder named, nothing in it, the file not yet there', d.drive && d.drive.copiedAt === null && d.drive.folder === 'NQOCN 2026 Presentations'
        && d.drive.files === 0 && d.drive.error === null && d.presentations.find((x) => x.id === abs.id).file.inDrive === false, d.drive);
      const size = fs.statSync(path.join(dir, mine.file.fileName)).size;
      fs.writeFileSync(driveFile('status'), JSON.stringify({ checkedAt: Date.now(), folder: 'NQOCN 2026 Presentations', folderId: 'TOPid_1-x',
        folders: { Oral: 'ORALid', Poster: 'POSTERid', Award: 'AWARDid' }, files: [{ path: `Poster/${mine.file.fileName}`, size }, { path: 'Oral/Someone_Oral.pdf', size: 9 }] }));
      d = (await call('GET', '/api/admin/presentations', null, admin)).body;
      check('after one: when, how many, and links to the folder and each format\'s', d.drive.files === 2 && !!d.drive.copiedAt
        && d.drive.folderUrl === 'https://drive.google.com/drive/folders/TOPid_1-x' && d.drive.folderUrls.POSTER === 'https://drive.google.com/drive/folders/POSTERid', d.drive);
      check('...and the file is marked as in Drive', d.presentations.find((x) => x.id === abs.id).file.inDrive === true);
      fs.writeFileSync(driveFile('status'), JSON.stringify({ checkedAt: Date.now(), folderId: 'bad"><script>', files: [{ path: `Poster/${mine.file.fileName}`, size: size + 1 }] }));
      d = (await call('GET', '/api/admin/presentations', null, admin)).body;
      check('a different size on Drive is not this file (it was replaced since)', d.presentations.find((x) => x.id === abs.id).file.inDrive === false);
      check('...and a folder id that is not one makes no link', d.drive.folderUrl === null);
      fs.writeFileSync(driveFile('error'), JSON.stringify({ at: Date.now(), error: 'rateLimitExceeded' }));
      check('a failed copy is reported', (await call('GET', '/api/admin/presentations', null, admin)).body.drive.error === 'rateLimitExceeded');
      check('the front desk cannot ask for a copy', (await call('POST', '/api/admin/presentations/drive', null, desk)).status === 403);
      const asked = await call('POST', '/api/admin/presentations/drive', null, admin);
      check('the abstracts desk can, leaving the request for the server', asked.body.success === true && asked.body.drive.requested === true && fs.existsSync(driveFile('request')), asked.body);
    } finally {
      clearDrive();
    }

    console.log('\n== After the last date ==');
    await setDue(istAt(-1));
    const late = await upload('/api/abstracts/me/presentation', one, 'late.pdf', me);
    check('the presenter can no longer upload', late.status === 400 && /closed/.test(late.body.error), late.body);
    check('...their card says so', (await call('GET', '/api/abstracts/me', null, me)).body.presentation.open === false);
    check('the front desk cannot upload for them', (await upload(`/api/admin/presentations/${abs.id}`, one, 'x.pdf', desk)).status === 403);
    const forThem = await upload(`/api/admin/presentations/${abs.id}`, one, 'emailed.pdf', admin);
    check('the abstracts desk can, for a file that was emailed', forThem.body.success === true && forThem.body.presentation.file.byStaff === true, forThem.body);
    check('...logged as theirs', !!(await db.get("SELECT 1 FROM audit_log WHERE action = 'PRESENTATION_UPLOADED_BY_STAFF' AND entity_id = ?", [String(abs.id)])));

    console.log('\n== The presenters, in the Reminders composer ==');
    const auds = (await call('GET', '/api/admin/reminders/audiences', null, admin)).body.audiences;
    const all = auds.find((a) => a.key === 'presenters');
    const awaiting = auds.find((a) => a.key === 'presenters_awaiting');
    check('two audiences: every presenter, and those whose file has not come', all && awaiting && all.filters.join() === 'format' && all.count >= awaiting.count + 1);
    const people = (await call('GET', '/api/admin/reminders/audiences/presenters/recipients?format=POSTER', null, admin)).body.recipients;
    const them = people.find((p) => p.id === abs.phone_number);
    check('...narrowed by format, each marked with theirs and whether it came', them && them.tags.includes('E-poster') && them.tags.includes('File received')
      && people.every((p) => p.tags.includes('E-poster')));
    const waitingList = (await call('GET', '/api/admin/reminders/audiences/presenters_awaiting/recipients', null, admin)).body.recipients;
    check('...and once it has come, they are not awaited', !waitingList.some((p) => p.id === abs.phone_number));
    const preview = (await call('POST', '/api/admin/reminders/audiences/presenters/preview',
      { subject: 'Your {{format}}', bodyHtml: '<p>{{name}} {{regno}} {{filerules}} {{deadline}} {{title}}</p>', recipientId: abs.phone_number, filters: { format: 'POSTER' } }, admin)).body;
    check('each email carries their own format, number, file rules and the last date', preview.subject === 'Your e-poster'
      && preview.html.includes(presenter.registration_number) && preview.html.includes('PDF, one slide, under 10 MB')
      && preview.html.includes(P.dueText(istAt(-1))), preview.subject);

    console.log('\n== On the website, and on the desk ==');
    const page = await call('GET', '/website/presentations', null, null);
    check('the guidelines are a page of their own', page.status === 200 && /<h1>Presentation guidelines<\/h1>/.test(page.raw)
      && ['id="eposter"', 'id="paper"', 'id="award"'].every((s) => page.raw.includes(s)));
    check('...with both templates and the way to upload', page.raw.includes('href="/website/files/nqocn-2026-eposter-template.pptx" download')
      && page.raw.includes('href="/website/files/nqocn-2026-paper-template.pptx" download') && /Upload in the portal/.test(page.raw));
    check('...every file a PDF, papers too', page.raw.includes('<b>Paper or award paper:</b> PDF, under 50 MB.') && !/PowerPoint \(\.pptx\) file,/.test(page.raw));
    check('...the times from the guidelines', ['5 + 2', '6 + 2', '7 + 3'].every((t) => page.raw.includes(`<b>${t}</b>`)));
    check('...and the last date, from the desk', page.raw.includes(P.dueText(istAt(-1)).replace(/,/g, ',')));
    check('...in the menu under Registration', page.raw.includes('href="/website/presentations" aria-current="page"'));
    const abstractsPage = (await call('GET', '/website/abstracts', null, null)).raw;
    check('the abstract guidelines give the times in the guidelines', /6 minutes to present and 2 for discussion; an award paper 7 and 3; an e-poster 5 and 2/.test(abstractsPage)
      && !/5 minutes to present and 2 minutes for discussion/.test(abstractsPage));
    const adminHtml = (await call('GET', '/admin', null, admin)).raw;
    check('the desk has Step 3, Presentations, and Zenodo is Step 5 (Step 4 poster screens, 19 Nov 2026)', /<span class="abs-tab-n text-slate-400">3<\/span>Presentations/.test(adminHtml)
      && /<span class="abs-tab-n text-slate-400">5<\/span>Zenodo/.test(adminHtml) && /id="abstracts-presentations-block" class="abs-panel" data-step="3"/.test(adminHtml));
    check('the composer can narrow by format', /id="rem-format"/.test(adminHtml) && /<option value="POSTER">E-poster<\/option>/.test(adminHtml));
    const portalHtml = (await call('GET', '/portal', null, null)).raw;
    check('the Abstract card has a place for the presentation', /id="abstract-presentation"/.test(portalHtml));
  } finally {
    await db.run('UPDATE abstracts SET allocation = ?, decision_sent_at = ? WHERE id = ?', [abs.allocation, abs.decision_sent_at, abs.id]);
    const rows = await db.all('SELECT file_name FROM presentations WHERE abstract_id = ?', [abs.id]);
    for (const r of rows) { try { fs.unlinkSync(path.join(dir, r.file_name)); } catch (e) { /* already gone */ } }
    await db.run('DELETE FROM presentations WHERE abstract_id = ?', [abs.id]);
    if (dueBefore) await setDue(dueBefore);
    db.close();
  }
  report();
})();
