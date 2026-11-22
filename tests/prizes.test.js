// Prizes (owner, 22 Nov 2026): 1st, 2nd and 3rd for oral, e-poster and
// award papers, each kind overall, chosen in Abstracts › Step 4; the
// presenter gets a Prize certificate naming the place, the kind and the paper.
const { call, check, report, ADMIN_PW, appFile, adminLogin, loginPassword, openDb } = require('./harness');
const fs = require('fs');

const N = String(Date.now()).slice(-7);

(async () => {
  const admin = await adminLogin();
  const desk = await loginPassword('9000000006', ADMIN_PW);
  const db = openDb();
  let phone = null;
  const ids = [];
  const saved = await db.all('SELECT * FROM presentation_prizes');
  try {
    await db.run('DELETE FROM presentation_prizes');
    const email = `prize-${N}@example.test`;
    const otp = await call('POST', '/api/otp/request', { destination: email });
    const r = await call('POST', '/api/auth/register', { salutation: 'Dr', age: '40', gender: 'Female', designation: 'Professor', institute: 'Test College', pincode: '442102',
      state: 'Maharashtra', district: 'Wardha', name: `Prize Test ${N}`, country: 'United Kingdom', email, emailOtp: otp.body.devOtp, password: 'testpass123' });
    phone = r.body.user.phone_number;
    await db.run(`INSERT INTO registrations (phone_number, delegate_name, category_key, category_label, bank_status, registration_number)
      VALUES (?, ?, 'chw', 'Frontline Health Worker', 'BANK_VERIFIED', ?)`, [phone, `Prize Test ${N}`, `PRZ${N}`]);
    // One abstract each (idx_abstracts_phone): the others are made-up presenters.
    const paper = async (who, allocation, title, told = true) => {
      const x = await db.run(`INSERT INTO abstracts (phone_number, author_name, format, title, text, word_count, status, allocation, decision_sent_at)
        VALUES (?, ?, 'Oral', ?, 'Body', 100, 'ACCEPTED', ?, ?)`, [who, `Presenter ${title}`, title, allocation, told ? Date.now() : null]);
      ids.push(x.lastID);
      return x.lastID;
    };
    const oral = await paper(phone, 'ORAL', `Oral paper ${N}`);
    const oral2 = await paper(`95${N}1`, 'ORAL', `Second oral ${N}`);
    const poster = await paper(`95${N}2`, 'POSTER', `Poster paper ${N}`);
    const untold = await paper(`95${N}3`, 'ORAL', `Not told ${N}`, false);

    console.log('\n== Choosing the winners ==');
    const list = (await call('GET', '/api/admin/prizes', null, admin)).body;
    const oralF = list.formats.find((f) => f.format === 'ORAL');
    check('three kinds, three places each', list.success && list.formats.map((f) => f.format).join() === 'ORAL,POSTER,AWARD'
      && list.formats.every((f) => f.places.map((p) => p.label).join() === 'First Prize,Second Prize,Third Prize'), list.formats && list.formats.map((f) => f.format));
    check('...each kind offers its own papers, told of the decision', oralF.papers.some((p) => p.id === oral) && !oralF.papers.some((p) => p.id === poster)
      && !oralF.papers.some((p) => p.id === untold));
    check('a desk volunteer cannot choose', (await call('PUT', '/api/admin/prizes', { format: 'ORAL', rank: 1, abstractId: oral }, desk)).status === 403);
    check('a poster cannot win an oral prize', (await call('PUT', '/api/admin/prizes', { format: 'ORAL', rank: 1, abstractId: poster }, admin)).status === 400);
    check('...nor a paper whose decision was not sent', (await call('PUT', '/api/admin/prizes', { format: 'ORAL', rank: 1, abstractId: untold }, admin)).status === 400);
    check('a place that is not one, refused', (await call('PUT', '/api/admin/prizes', { format: 'ORAL', rank: 4, abstractId: oral }, admin)).status === 400);
    const set = await call('PUT', '/api/admin/prizes', { format: 'ORAL', rank: 1, abstractId: oral }, admin);
    check('the first prize for oral papers is set', set.body.success
      && !!(await db.get("SELECT 1 AS y FROM audit_log WHERE action = 'PRIZE_SET' AND entity_id = ?", [oral])), set.body);
    const twice = await call('PUT', '/api/admin/prizes', { format: 'ORAL', rank: 2, abstractId: oral }, admin);
    check('...one paper cannot hold two places', twice.status === 409 && /first prize/.test(twice.body.error), twice.body);
    await call('PUT', '/api/admin/prizes', { format: 'ORAL', rank: 2, abstractId: oral2 }, admin);
    await call('PUT', '/api/admin/prizes', { format: 'ORAL', rank: 2, abstractId: null }, admin);
    check('...a place can be cleared', !(await db.get("SELECT 1 AS y FROM presentation_prizes WHERE format = 'ORAL' AND rank = 2")));
    await call('PUT', '/api/admin/prizes', { format: 'POSTER', rank: 3, abstractId: poster }, admin);

    console.log('\n== The certificates ==');
    const me = async () => (await call('GET', '/api/admin/certificates/candidates', null, admin)).body.people.find((p) => p.phone === phone);
    const p0 = await me();
    check('the presenter has the prize due, and only theirs', p0 && p0.prizes.length === 1 && p0.prizes[0].eligible && !p0.prizes[0].issued
      && p0.prizes[0].label === 'First Prize, Oral Paper Presentation', p0 && p0.prizes);
    const prev = await call('GET', `/api/admin/certificates/person-preview.pdf?phone=${encodeURIComponent(phone)}&cert=PRIZE:${oral}`, null, admin);
    const pbuf = prev.buf || Buffer.from(prev.raw || '', 'binary');
    check('a preview of theirs, nothing stored', prev.status === 200 && pbuf.slice(0, 4).toString() === '%PDF'
      && !(await db.get("SELECT 1 AS y FROM certificates WHERE phone_number = ? AND kind = 'PRIZE'", [phone])), prev.status);
    check('...a prize they did not win, refused', (await call('GET', `/api/admin/certificates/person-preview.pdf?phone=${encodeURIComponent(phone)}&cert=PRIZE:${oral2}`, null, admin)).status === 400);
    const spec = await call('GET', '/api/admin/certificates/preview.pdf?kind=PRIZE', null, admin);
    check('a specimen of the Prize certificate draws', (spec.buf || Buffer.from('')).slice(0, 4).toString() === '%PDF');

    const iss = await call('POST', '/api/admin/certificates/issue', { scope: 'prizes', phones: [phone] }, admin);
    check('issued with Prizes', iss.body.success && iss.body.issued.PRIZE === 1 && iss.body.total === 1, iss.body);
    const row = await db.get("SELECT * FROM certificates WHERE phone_number = ? AND kind = 'PRIZE' AND option_id = ?", [phone, oral]);
    const d = JSON.parse(row.detail);
    check('...numbered PR, carrying the place, the kind and the paper', /\/PR\/\d{4}$/.test(row.cert_no) && d.rank === 1 && d.format === 'ORAL'
      && d.title === `Oral paper ${N}` && row.workshop_name === `Oral paper ${N}`, row);
    const again = await call('POST', '/api/admin/certificates/issue', { scope: 'prizes', phones: [phone] }, admin);
    check('...never twice', again.body.issued.PRIZE === 0, again.body);
    const p1 = await me();
    check('the list shows them issued', p1.prizes.every((x) => x.issued && x.issued.cert_no));
    const moved = await call('PUT', '/api/admin/prizes', { format: 'ORAL', rank: 1, abstractId: oral2 }, admin);
    check('an issued place cannot be moved until its certificate is withdrawn', moved.status === 409 && moved.body.error.includes(row.cert_no), moved.body);
    const dl = await call('GET', `/api/admin/certificates/${row.id}.pdf`, null, admin);
    check('the issued certificate prints', dl.status === 200, dl.status);

    console.log('\n== The pages ==');
    const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
    const ejs = fs.readFileSync(appFile('views', 'admin', 'sections', 'abstracts.ejs'), 'utf8');
    check('Prizes is Review Desk Step 5, before Zenodo (Step 6), drawn when the desk opens', /\['5', 'Prizes'\], \['6', 'Zenodo'\]/.test(ejs)
      && /id="abstracts-prizes-block" class="hidden abs-panel" data-step="5">\s*<div id="order-prizes"><\/div>/.test(ejs) && /id="abstracts-zenodo-block" class="hidden abs-panel" data-step="6"/.test(ejs)
      && ejs.indexOf('id="abstracts-screens-block"') < ejs.indexOf('id="abstracts-prizes-block"') && /renderPosterScreens\(\);\n    renderPrizes\(\);\n    const res = await fetch\('\/api\/abstracts'\)/.test(js));
    check('Ready to issue has a Prizes row; settings have its wording', /\['prizes', 'Prizes'/.test(js) && /\['Prizes', \['PRIZE'\]\]/.test(js));
  } finally {
    if (phone) {
      await db.run('DELETE FROM certificates WHERE phone_number = ?', [phone]);
      await db.run('DELETE FROM registrations WHERE phone_number = ?', [phone]);
    }
    await db.run('DELETE FROM presentation_prizes');
    for (const x of saved) await db.run('INSERT INTO presentation_prizes (format, rank, abstract_id, set_by, set_at) VALUES (?, ?, ?, ?, ?)', [x.format, x.rank, x.abstract_id, x.set_by, x.set_at]);
    for (const id of ids) await db.run('DELETE FROM abstracts WHERE id = ?', [id]);
    db.close();
  }
  report();
})();
