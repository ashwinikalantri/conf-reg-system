// Once the decision email has gone, the format is fixed (17 Nov 2026). An
// abstract's decision email -- held for Send or Cancel -- names its abstract
// and format; when it is sent the abstract is marked told
// (abstracts.decision_sent_at): it leaves Step 2 for Step 3, and its format
// can no longer be changed. Un-accepting it clears both. Decisions sent
// before held emails named their abstract are found once, at start.
const fs = require('fs');
const { call, adminLogin, appFile, check, report, openDb } = require('./harness');

(async () => {
  const src = fs.readFileSync(appFile('server.js'), 'utf8');
  const admin = await adminLogin();
  const db = openDb();
  const abs = await db.get("SELECT * FROM abstracts WHERE title = 'Accepted and assigned'");
  const me = (await call('GET', '/api/auth/me', null, admin)).body.user;
  const assign = (allocation) => call('PUT', `/api/abstracts/${abs.id}/allocation`, { allocation }, admin);
  const row = () => db.get('SELECT status, allocation, decision_sent_at FROM abstracts WHERE id = ?', [abs.id]);
  const inStep3 = async () => (await call('GET', '/api/admin/presentations', null, admin)).body.presentations.some((x) => x.id === abs.id);
  const presenters = async () => (await call('GET', '/api/admin/reminders/audiences/presenters/recipients', null, admin)).body.recipients.some((p) => p.id === abs.phone_number);
  const heldIds = [];
  try {
    check('fixture: an accepted paper, its email not sent', abs && abs.status === 'ACCEPTED' && abs.allocation === 'ORAL' && !abs.decision_sent_at);

    console.log('\n== Not yet told ==');
    check('the format can be changed', (await assign('POSTER')).body.success === true && (await row()).allocation === 'POSTER');
    check('...and changed back', (await assign('ORAL')).body.success === true && (await row()).allocation === 'ORAL');
    check('it is not in Step 3, nor among the presenters to email', !(await inStep3()) && !(await presenters()));
    const listed = (await call('GET', '/api/abstracts', null, admin)).body.abstracts.find((a) => a.id === abs.id);
    check('the desk is told whether the email has gone', listed && 'decision_sent_at' in listed && !listed.decision_sent_at);

    console.log('\n== A send that fails does not count ==');
    const h = await db.run("INSERT INTO held_emails (to_address, to_name, subject, html, by_phone, status, created_at, ref) VALUES ('told@example.org', 'A', 'Your abstract has been accepted', '<p>x</p>', ?, 'PENDING', ?, ?)",
      [me.phone_number, Date.now(), `abstract:${abs.id}:ORAL`]);
    heldIds.push(h.lastID);
    const d = await call('POST', '/api/admin/held-emails/decide', { ids: [h.lastID], send: true }, admin);
    check('with mail off here, Send fails', d.body.failed === 1 && d.body.sent === 0, d.body);
    check('...and the abstract is not marked told', !(await row()).decision_sent_at);
    check('a successful send marks it, for the format the email names, if it still has that one',
      /sent\+\+;\n\s*await noteHeldEmailSent\(row, req\);/.test(src)
      && /UPDATE abstracts SET decision_sent_at = \? WHERE id = \? AND status = 'ACCEPTED' AND allocation = \? AND decision_sent_at IS NULL/.test(src));
    check('each decision email names its abstract and format, and drops an earlier one still waiting',
      (src.match(/<\/p>`\), ref\);/g) || []).length === 2
      && /const ref = `abstract:\$\{req\.params\.id\}:\$\{allocation\}`;/.test(src)
      && /UPDATE held_emails SET status = 'CANCELLED', decided_at = \? WHERE status = 'PENDING' AND ref LIKE \?/.test(src));

    console.log('\n== Told ==');
    await db.run('UPDATE abstracts SET decision_sent_at = ? WHERE id = ?', [Date.now(), abs.id]);
    const locked = await assign('POSTER');
    check('the format can no longer be changed', locked.status === 409 && /can no longer be changed/.test(locked.body.error) && (await row()).allocation === 'ORAL', locked.body);
    check('...not even re-saved', (await assign('ORAL')).status === 409);
    check('it is in Step 3, and among the presenters to email', (await inStep3()) && (await presenters()));

    console.log('\n== Un-accepted ==');
    const back = await call('PUT', `/api/abstracts/${abs.id}/status`, { status: 'UNDER_REVIEW' }, admin);
    let r = await row();
    check('un-accepting clears the format and the mark', back.body.success === true && r.status === 'UNDER_REVIEW' && r.allocation === null && r.decision_sent_at === null, r);
    await call('PUT', `/api/abstracts/${abs.id}/status`, { status: 'ACCEPTED' }, admin);
    check('accepted again, a format can be chosen afresh', (await assign('ORAL')).body.success === true && (await row()).allocation === 'ORAL');

    console.log('\n== Decisions sent before this ==');
    check('found once, at start, from the decision emails that went', /async function backfillDecisionSentOnBoot\(\)/.test(src)
      && /h\.status = 'SENT' AND h\.subject LIKE 'Your abstract has been%'/.test(src)
      && /\.then\(\(\) => backfillDecisionSentOnBoot\(\)/.test(src) && /'decision_sent_backfill_done'/.test(src));
  } finally {
    await db.run('UPDATE abstracts SET status = ?, allocation = ?, decision_sent_at = ? WHERE id = ?', [abs.status, abs.allocation, abs.decision_sent_at, abs.id]);
    for (const id of heldIds) await db.run('DELETE FROM held_emails WHERE id = ?', [id]);
    db.close();
  }
  report();
})();
