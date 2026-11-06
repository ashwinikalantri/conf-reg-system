// Asking authors to complete their abstract, and a last date on corrections
// (6 Nov 2026). A reviewer picks an abstract and asks its author to
// complete it (results awaited, say) by a date: the status stays -- an
// accepted abstract keeps its acceptance and format -- the author may update
// it until that date, and the desk sees when they did. Corrections ("send
// back") now carry a last date too, after which resubmission is refused.
const { call, adminLogin, loginOtp, loginPassword, ADMIN_PW, check, report, openDb } = require('./harness');

const IST = 5.5 * 3600e3;
const istDay = (offset) => new Date(Date.now() + IST + offset * 86400e3).toISOString().slice(0, 10);
const body = (results) => ({
  format: 'Oral Paper', title: 'Accepted and assigned', keywords: 'quality, safety',
  background: 'Why it matters.', aim: 'What we aimed for.', methods: 'How we did it.', results, conclusion: 'What it means.',
});

(async () => {
  const admin = await adminLogin();
  const desk = await loginPassword('9000000006', ADMIN_PW);
  const db = await openDb();
  const abs = await db.get("SELECT * FROM abstracts WHERE title = 'Accepted and assigned'");
  const abs2 = await db.get("SELECT * FROM abstracts WHERE title = 'Awaiting a decision'");
  check('fixture: an accepted, allotted abstract and one under review', abs && abs.status === 'ACCEPTED' && abs.allocation === 'ORAL' && abs2 && abs2.status === 'UNDER_REVIEW');
  const row = (id) => db.get('SELECT status, allocation, results, revision_until, complete_until, complete_note, completed_at FROM abstracts WHERE id = ?', [id]);
  const ask = (id, b, as = admin) => call('PUT', `/api/abstracts/${id}/completion`, b, as);
  try {
    console.log('\n== Asking ==');
    check('the front desk may not ask', (await ask(abs.id, { note: 'x', until: istDay(3) }, desk)).status === 403);
    check('a note is needed', (await ask(abs.id, { note: '', until: istDay(3) })).status === 400);
    check('...and a date, not one already gone', (await ask(abs.id, { note: 'Add results', until: '' })).status === 400
      && (await ask(abs.id, { note: 'Add results', until: istDay(-1) })).status === 400);
    const heldBefore = (await db.get('SELECT COUNT(*) AS n FROM held_emails')).n;
    const asked = await ask(abs.id, { note: 'Your results were awaited. Please add them.', until: istDay(5) });
    check('a reviewer asks the author to complete it', asked.body.success === true, asked.body);
    let r = await row(abs.id);
    check('...recorded, the status and format untouched', r.complete_until === istDay(5) && /awaited/.test(r.complete_note) && r.status === 'ACCEPTED' && r.allocation === 'ORAL', r);
    check('...with an audit entry', !!(await db.get("SELECT 1 FROM audit_log WHERE action = 'ABSTRACT_COMPLETION_REQUESTED' AND entity_id = ?", [String(abs.id)])));
    const heldAfter = (await db.get('SELECT COUNT(*) AS n FROM held_emails')).n;
    check('...and its email waits for the reviewer to send it, if email is set up', heldAfter >= heldBefore);
    const list = (await call('GET', '/api/abstracts', null, admin)).body.abstracts.find((a) => a.id === abs.id);
    check('the review desk sees the request', list && list.complete_until === istDay(5) && !list.completed_at);

    console.log('\n== The author completes it ==');
    const me = await loginOtp('9000001003');
    const mine = (await call('GET', '/api/abstracts/me', null, me)).body.abstract;
    check('their card says it is open to them, until the date', mine.completion_open === true && mine.complete_until === istDay(5) && mine.revision_open === false);
    const sent = await call('POST', '/api/abstracts', body('80% of mothers practised KMC by week 12.'), me);
    check('they update it', sent.body.success === true && sent.body.completed === true, sent.body);
    r = await row(abs.id);
    check('...the results are in, and it is still accepted for oral', /80%/.test(r.results) && r.status === 'ACCEPTED' && r.allocation === 'ORAL' && !!r.completed_at, r);
    check('...logged', !!(await db.get("SELECT 1 FROM audit_log WHERE action = 'ABSTRACT_COMPLETED' AND entity_id = ?", [String(abs.id)])));
    check('they may update it again before the date', (await call('POST', '/api/abstracts', body('82% by week 12.'), me)).body.success === true);

    console.log('\n== After the date, or withdrawn ==');
    await db.run('UPDATE abstracts SET complete_until = ? WHERE id = ?', [istDay(-1), abs.id]);
    check('after the date their card says so', (await call('GET', '/api/abstracts/me', null, me)).body.abstract.completion_open === false);
    check('...and an update is refused', [403, 409].includes((await call('POST', '/api/abstracts', body('late'), me)).status));
    await ask(abs.id, { note: 'One more thing', until: istDay(2) });
    const gone = await call('DELETE', `/api/abstracts/${abs.id}/completion`, null, admin);
    check('a request can be withdrawn', gone.body.success === true && (await row(abs.id)).complete_until === null);
    check('...after which nothing can be changed', [403, 409].includes((await call('POST', '/api/abstracts', body('after'), me)).status));

    console.log('\n== Corrections carry a last date ==');
    const noDate = await call('PUT', `/api/abstracts/${abs2.id}/status`, { status: 'REVISION_REQUESTED', note: 'Shorten Background.' }, admin);
    check('sending back for corrections needs a last date', noDate.status === 400 && /last date/.test(noDate.body.error));
    const back = await call('PUT', `/api/abstracts/${abs2.id}/status`, { status: 'REVISION_REQUESTED', note: 'Shorten Background.', until: istDay(4) }, admin);
    check('...with one it goes back', back.body.success === true && (await row(abs2.id)).revision_until === istDay(4));
    check('one back with its author for corrections is not also asked to complete', (await ask(abs2.id, { note: 'x', until: istDay(2) })).status === 409);
    const me2 = await loginOtp('9000001001');
    check('the author is told it is open', (await call('GET', '/api/abstracts/me', null, me2)).body.abstract.revision_open === true);
    await db.run('UPDATE abstracts SET revision_until = ? WHERE id = ?', [istDay(-1), abs2.id]);
    const late = await call('POST', '/api/abstracts', { ...body('r'), title: 'Awaiting a decision' }, me2);
    check('after that date a resubmission is refused', late.status === 403 && /last date for corrections/.test(late.body.error), late.body);
    await db.run('UPDATE abstracts SET revision_until = ? WHERE id = ?', [istDay(2), abs2.id]);
    const ok = await call('POST', '/api/abstracts', { ...body('r'), title: 'Awaiting a decision' }, me2);
    r = await row(abs2.id);
    check('before it, it goes back under review and the date is cleared', ok.body.success === true && r.status === 'UNDER_REVIEW' && r.revision_until === null, r);
  } finally {
    const restore = (a) => db.run(`UPDATE abstracts SET status = ?, allocation = ?, format = ?, title = ?, text = ?, background = ?, aim = ?, methods = ?, results = ?, conclusion = ?,
      keywords = ?, word_count = ?, revision_note = ?, revision_until = NULL, complete_note = NULL, complete_until = NULL, complete_requested_at = NULL,
      complete_requested_by = NULL, completed_at = NULL, authors = ?, authors_updated_at = ? WHERE id = ?`,
      [a.status, a.allocation, a.format, a.title, a.text, a.background, a.aim, a.methods, a.results, a.conclusion, a.keywords, a.word_count, a.revision_note,
        a.authors, a.authors_updated_at, a.id]);
    await restore(abs);
    await restore(abs2);
    db.close();
  }
  report();
})();
