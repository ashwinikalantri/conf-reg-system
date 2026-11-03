// Accepted abstracts on Zenodo with a DOI (3 Nov 2026). The presenting author
// agrees in the portal; staff with abstracts.publish send a draft (DOI
// reserved, PDF attached) and then publish, which is permanent. The app
// talks to a stand-in Zenodo started here (tests/run.js points it at
// ZENODO_MOCK_PORT); nothing reaches the real site.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { call, adminLogin, loginOtp, loginPassword, ADMIN_PW, check, report, openDb, dataDir, appFile } = require('./harness');
const Z = require(appFile('zenodo.js'));

// --- the stand-in ------------------------------------------------------------
const GOOD = 'good-token';
const mock = { deps: new Map(), files: new Map(), next: 500, created: 0, failPublish: false, calls: [] };
const PORT = Number(process.env.ZENODO_MOCK_PORT);
const BASE = `http://127.0.0.1:${PORT}`;
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
    const url = new URL(req.url, BASE);
    mock.calls.push(`${req.method} ${url.pathname}`);
    if (req.headers.authorization !== `Bearer ${GOOD}`) return send(401, { message: 'The server could not verify that you are authorized.' });
    const view = (d) => ({ id: d.id, submitted: d.published, doi: d.published ? d.doi : '', links: { bucket: `${BASE}/files/b${d.id}`, html: `${BASE}/deposit/${d.id}` },
      metadata: { ...d.metadata, prereserve_doi: { doi: d.doi, recid: d.id } } });
    let m;
    if (req.method === 'GET' && url.pathname === '/api/deposit/depositions') return send(200, []);
    if (req.method === 'GET' && (m = /^\/api\/communities\/([^/]+)$/.exec(url.pathname))) return m[1] === 'nqocn2026' ? send(200, { id: 'c1', slug: 'nqocn2026' }) : send(404, { message: 'Not found' });
    if (req.method === 'POST' && url.pathname === '/api/deposit/depositions') {
      const id = ++mock.next; mock.created += 1;
      const d = { id, doi: `10.5072/zenodo.${id}`, metadata: {}, published: false };
      mock.deps.set(id, d);
      return send(201, view(d));
    }
    if ((m = /^\/api\/deposit\/depositions\/(\d+)(\/actions\/publish)?$/.exec(url.pathname))) {
      const d = mock.deps.get(Number(m[1]));
      if (!d) return send(404, { message: 'PID does not exist.' });
      if (m[2] && req.method === 'POST') {
        if (mock.failPublish) { mock.failPublish = false; return send(500, { message: 'Internal error' }); }
        d.published = true;
        return send(202, { ...view(d), links: { record_html: `${BASE}/records/${d.id}` } });
      }
      if (req.method === 'GET') return send(200, view(d));
      if (req.method === 'PUT') { d.metadata = JSON.parse(body.toString()).metadata; return send(200, view(d)); }
      if (req.method === 'DELETE') { if (d.published) return send(403, { message: 'published' }); mock.deps.delete(d.id); return send(201); }
    }
    if (req.method === 'PUT' && (m = /^\/files\/b(\d+)\/(.+)$/.exec(url.pathname))) {
      mock.files.set(`${m[1]}/${decodeURIComponent(m[2])}`, body);
      return send(201, { key: decodeURIComponent(m[2]), size: body.length });
    }
    return send(404, { message: `no route ${req.method} ${url.pathname}` });
  });
});

(async () => {
  console.log('\n== The pieces on their own ==');
  check('names go family name first', Z.creatorName('Dr. Amol Joshi') === 'Joshi, Amol' && Z.creatorName('A B Rao') === 'Rao, A B' && Z.creatorName('Madonna') === 'Madonna' && Z.creatorName('Rao, A.') === 'Rao, A.');
  const md = Z.recordMetadata({ abstract: { id: 7, title: 'T', background: 'Why <b>this</b>', conclusion: 'So', keywords: 'KMC; NICU, QI' },
    authors: [{ name: 'Asha Rao', presenting: false }, { name: 'Ravi Shah', presenting: true }], institution: 'MGIMS',
    conference: { name: 'Conf', acronym: 'C26', dates: '21–22 Nov 2026', place: 'Sevagram', url: 'https://x.example' }, community: 'nqocn2026', today: '2026-11-25' });
  check('...a conference paper, open, CC BY 4.0, in the community, DOI reserved', md.upload_type === 'publication' && md.publication_type === 'conferencepaper'
    && md.access_right === 'open' && md.license === 'cc-by-4.0' && md.communities[0].identifier === 'nqocn2026' && md.prereserve_doi === true);
  check('...the presenting author carries the institution, in order', md.creators[0].name === 'Rao, Asha' && !md.creators[0].affiliation && md.creators[1].affiliation === 'MGIMS');
  check('...the sections, as written, and the keywords split', /<b>Background<\/b><\/p><p>Why <b>this<\/b>/.test(md.description) && /Conclusion/.test(md.description) && md.keywords.join('|') === 'KMC|NICU|QI');
  check('...and the conference', md.conference_title === 'Conf' && md.conference_acronym === 'C26' && md.conference_place === 'Sevagram' && md.conference_url === 'https://x.example');

  await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok));
  const admin = await adminLogin();
  const desk = await loginPassword('9000000006', ADMIN_PW);
  const db = await openDb();
  const abs = await db.get("SELECT id, phone_number FROM abstracts WHERE status = 'ACCEPTED' AND title = 'Accepted, not yet assigned'");
  const abs2 = await db.get("SELECT id, phone_number FROM abstracts WHERE status = 'ACCEPTED' AND title = 'Accepted and assigned'");
  check('fixture: two accepted abstracts', !!abs && !!abs2);
  const registered = async (p) => !!(await db.get("SELECT 1 FROM registrations WHERE phone_number = ? AND COALESCE(bank_status, '') != 'REJECTED'", [p]));
  check('fixture: their authors have registered', await registered(abs.phone_number) && await registered(abs2.phone_number));
  const zstate = (id) => db.get('SELECT zenodo_consent, zenodo_state, zenodo_doi, zenodo_id, zenodo_error, status FROM abstracts WHERE id = ?', [id]);

  try {
    console.log('\n== Who may ==');
    check('the front desk may not', (await call('GET', '/api/admin/zenodo', null, desk)).status === 403);
    let z = (await call('GET', '/api/admin/zenodo', null, admin)).body;
    check('a super admin may; off, not set up yet, community nqocn2026 by default', z.success && z.settings.enabled === false && z.settings.configured === false && z.settings.community === 'nqocn2026');
    check('...accepted abstracts only are listed', z.abstracts.length >= 2 && z.abstracts.every((a) => typeof a.consent === 'boolean'));
    check('nothing goes before it is on and has a token', [400, 409].includes((await call('POST', `/api/admin/zenodo/abstracts/${abs.id}/draft`, null, admin)).status) && mock.created === 0);

    console.log('\n== Setting up ==');
    check('a community must be a Zenodo short name', (await call('PUT', '/api/admin/zenodo/settings', { community: 'NQOCN 2026!' }, admin)).status === 400);
    await call('PUT', '/api/admin/zenodo/settings', { token: 'wrong-token', community: 'nqocn2026', sandbox: false }, admin);
    const badCheck = await call('POST', '/api/admin/zenodo/check', null, admin);
    check('a token Zenodo refuses is reported as such', badCheck.status === 502 && /did not accept the token/.test(badCheck.body.error), badCheck.body);
    await call('PUT', '/api/admin/zenodo/settings', { token: GOOD }, admin);
    const goodCheck = await call('POST', '/api/admin/zenodo/check', null, admin);
    check('a good token, and the community found', goodCheck.body.success && goodCheck.body.communityFound === true, goodCheck.body);
    const zr = await call('GET', '/api/admin/zenodo', null, admin);
    check('set up now, and the token is never sent back', zr.body.settings.configured === true && !zr.raw.includes(GOOD));
    check('...it is kept in .env', fs.readFileSync(path.join(dataDir(), '.env'), 'utf8').includes(`ZENODO_TOKEN=${GOOD}`));
    const sAudit = await db.get("SELECT new_value FROM audit_log WHERE action = 'ZENODO_SETTINGS' ORDER BY id DESC LIMIT 1");
    check('...and the activity log never holds it', sAudit && !sAudit.new_value.includes(GOOD) && /new token/.test(sAudit.new_value), sAudit);

    console.log('\n== Switched off, nothing is offered or sent ==');
    const meOff = await loginOtp(abs.phone_number);
    const offCard = (await call('GET', '/api/abstracts/me', null, meOff)).body.abstract;
    check('the author is not offered the consent box', offCard.zenodo_enabled === false);
    check('...and cannot give consent', (await call('PUT', '/api/abstracts/me/zenodo-consent', { consent: true }, meOff)).status === 409);
    const offDraft = await call('POST', `/api/admin/zenodo/abstracts/${abs.id}/draft`, null, admin);
    check('no draft can be sent', offDraft.status === 409 && /switched off/.test(offDraft.body.error) && mock.created === 0, offDraft.body);
    await call('PUT', '/api/admin/zenodo/settings', { enabled: true }, admin);
    check('switched on in Conference setup', (await call('GET', '/api/admin/zenodo', null, admin)).body.settings.enabled === true
      && !!(await db.get("SELECT 1 FROM audit_log WHERE action = 'ZENODO_ON'")));
    check('...the author is offered it now', (await call('GET', '/api/abstracts/me', null, meOff)).body.abstract.zenodo_enabled === true);

    console.log('\n== The author agrees ==');
    const blocked = await call('POST', `/api/admin/zenodo/abstracts/${abs.id}/draft`, null, admin);
    check('without their agreement, nothing goes', blocked.status === 409 && /has not agreed/.test(blocked.body.error) && mock.created === 0, blocked.body);
    const me = await loginOtp(abs.phone_number);
    const agreed = await call('PUT', '/api/abstracts/me/zenodo-consent', { consent: true }, me);
    check('the presenting author agrees in the portal', agreed.body.success === true);
    check('...it is recorded', (await zstate(abs.id)).zenodo_consent === 1 && !!(await db.get("SELECT 1 FROM audit_log WHERE action = 'ZENODO_CONSENT_GIVEN' AND entity_id = ?", [String(abs.id)])));
    check('...and their card shows it', (await call('GET', '/api/abstracts/me', null, me)).body.abstract.zenodo_consent === 1);
    const other = await loginOtp('9000001001'); // an abstract under review
    check('an abstract not accepted cannot be agreed for', (await call('PUT', '/api/abstracts/me/zenodo-consent', { consent: true }, other)).status === 409);

    console.log('\n== Draft ==');
    const draft = await call('POST', `/api/admin/zenodo/abstracts/${abs.id}/draft`, null, admin);
    check('sent as a draft, with the DOI reserved', draft.body.success && /^10\.5072\/zenodo\.\d+$/.test(draft.body.doi), draft.body);
    const dep = [...mock.deps.values()][0];
    check('...a conference paper in the community, CC BY 4.0', dep.metadata.publication_type === 'conferencepaper' && dep.metadata.license === 'cc-by-4.0'
      && dep.metadata.communities[0].identifier === 'nqocn2026' && dep.metadata.title === 'Accepted, not yet assigned');
    check('...its authors family name first', dep.metadata.creators[0].name === 'Payments, Two', dep.metadata.creators);
    const file = [...mock.files.entries()].find(([k]) => k.startsWith(`${dep.id}/`));
    check('...with the PDF attached', file && file[1].slice(0, 5).toString() === '%PDF-' && new RegExp(`abstract-${abs.id}\\.pdf$`).test(file[0]), file && file[0]);
    let st = await zstate(abs.id);
    check('...and the portal knows it is a draft', st.zenodo_state === 'DRAFT' && st.zenodo_doi === draft.body.doi && st.zenodo_id === String(dep.id));
    const again = await call('POST', `/api/admin/zenodo/abstracts/${abs.id}/draft`, null, admin);
    check('sending again refreshes the same draft', again.body.success && mock.created === 1 && again.body.doi === draft.body.doi);

    console.log('\n== Publish ==');
    const pub = await call('POST', `/api/admin/zenodo/abstracts/${abs.id}/publish`, null, admin);
    check('published, with its DOI', pub.body.success && pub.body.doi === draft.body.doi && dep.published === true, pub.body);
    st = await zstate(abs.id);
    check('...recorded as published', st.zenodo_state === 'PUBLISHED' && !!(await db.get("SELECT 1 FROM audit_log WHERE action = 'ZENODO_PUBLISHED' AND entity_id = ?", [String(abs.id)])));
    const mine = (await call('GET', '/api/abstracts/me', null, me)).body.abstract;
    check('the author sees the DOI', mine.zenodo_state === 'PUBLISHED' && mine.zenodo_doi === pub.body.doi);
    const rep = (await call('GET', '/api/admin/reports/abstracts?format=json', null, admin)).body.report.sections[0];
    const row = rep.rows.find((r) => r[0] === 'Accepted, not yet assigned');
    check('the Accepted abstracts report gives the DOI', rep.columns.includes('DOI') && row[rep.columns.indexOf('DOI')] === `https://doi.org/${pub.body.doi}`);

    console.log('\n== After publishing, it stays as it is ==');
    check('the author cannot withdraw', (await call('PUT', '/api/abstracts/me/zenodo-consent', { consent: false }, me)).status === 409);
    check('...nor change the authors', (await call('PUT', '/api/abstracts/me/authors', { authors: [{ name: 'X', presenting: true }] }, me)).status === 409);
    check('the review desk cannot un-accept it', (await call('PUT', `/api/abstracts/${abs.id}/status`, { status: 'REJECTED' }, admin)).status === 409);
    check('a published record cannot be discarded', (await call('DELETE', `/api/admin/zenodo/abstracts/${abs.id}/draft`, null, admin)).status === 409);

    console.log('\n== When Zenodo fails, and a draft thrown away ==');
    const me2 = await loginOtp(abs2.phone_number);
    await call('PUT', '/api/abstracts/me/zenodo-consent', { consent: true }, me2);
    check('a second one drafts', (await call('POST', `/api/admin/zenodo/abstracts/${abs2.id}/draft`, null, admin)).body.success);
    mock.failPublish = true;
    const failed = await call('POST', `/api/admin/zenodo/abstracts/${abs2.id}/publish`, null, admin);
    st = await zstate(abs2.id);
    check('a failure is reported and kept, and it stays a draft', failed.status === 502 && /500/.test(failed.body.error) && st.zenodo_state === 'DRAFT' && /500/.test(st.zenodo_error), failed.body);
    await call('PUT', '/api/abstracts/me/zenodo-consent', { consent: false }, me2);
    check('withdrawn agreement stops publishing', (await call('POST', `/api/admin/zenodo/abstracts/${abs2.id}/publish`, null, admin)).status === 409);
    const gone = await call('DELETE', `/api/admin/zenodo/abstracts/${abs2.id}/draft`, null, admin);
    st = await zstate(abs2.id);
    check('the draft can be discarded, on Zenodo too', gone.body.success && st.zenodo_state === null && !mock.deps.has(Number(st.zenodo_id || 0)) && mock.deps.size === 1);

    console.log('\n== Switched off again ==');
    await call('PUT', '/api/admin/zenodo/settings', { enabled: false }, admin);
    const after = (await call('GET', '/api/abstracts/me', null, me)).body.abstract;
    check('a published DOI still shows to its author', after.zenodo_enabled === false && after.zenodo_doi === pub.body.doi);
    check('...and nothing more can be published', (await call('POST', `/api/admin/zenodo/abstracts/${abs2.id}/publish`, null, admin)).status === 409);
    const general = fs.readFileSync(appFile('views', 'admin', 'sections', 'general.ejs'), 'utf8');
    const reviewDesk = fs.readFileSync(appFile('views', 'admin', 'sections', 'abstracts.ejs'), 'utf8');
    check('the settings and switch are in Conference setup, not on the Review Desk', /id="gs-card-zenodo"/.test(general) && /id="zenodo-enabled"/.test(general)
      && /id="zenodo-token"/.test(general) && !/id="zenodo-token"/.test(reviewDesk) && /showSetupPage\('zenodo'\)/.test(reviewDesk));
  } finally {
    await db.run(`UPDATE abstracts SET zenodo_consent = NULL, zenodo_consent_at = NULL, zenodo_id = NULL, zenodo_doi = NULL, zenodo_url = NULL,
      zenodo_state = NULL, zenodo_at = NULL, zenodo_error = NULL, status = 'ACCEPTED' WHERE id IN (?, ?)`, [abs.id, abs2.id]);
    db.close();
    server.close();
  }
  report();
})();
