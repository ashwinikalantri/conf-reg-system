// The oral and award running order (owner, 20 Nov 2026): as the poster
// screens, without screens -- each paper a turn in one of its format's
// sessions, a time each from the session's start, set by hand.
const fs = require('fs');
const { call, check, report, adminLogin, loginPassword, ADMIN_PW, openDb, appFile } = require('./harness');

(async () => {
  const admin = await adminLogin();
  const desk = await loginPassword('9000000006', ADMIN_PW);
  const db = openDb();
  const N = String(Date.now()).slice(-6);
  const ids = [];
  let hallId = null;
  const sessionIds = [];
  try {
    hallId = (await call('POST', '/api/admin/programme/halls', { name: `Oral Hall ${N}` }, admin)).body.id;
    for (const [start, end] of [['08:00', '09:00'], ['15:00', '15:30']]) {
      sessionIds.push((await call('POST', '/api/admin/programme/sessions', { hallId, date: '2099-04-02', start, end, title: `Oral presentations ${N} ${start}`, counts: true }, admin)).body.id);
    }
    for (let i = 0; i < 5; i++) {
      ids.push((await db.run(`INSERT INTO abstracts (phone_number, author_name, format, title, text, word_count, status, allocation, decision_sent_at)
        VALUES (?, ?, 'Oral', ?, 'Body', 100, 'ACCEPTED', 'ORAL', ?)`, [`96666${N}${i}`, `Oral Person ${i}`, `Oral Paper ${N} ${i}`, Date.now()])).lastID);
    }
    const get = async () => (await call('GET', '/api/admin/oral-order?format=ORAL', null, admin)).body;
    check('only the abstracts desk sets it', (await call('PUT', '/api/admin/oral-order/settings', { format: 'ORAL', sessionIds }, desk)).status === 403);
    const set = await call('PUT', '/api/admin/oral-order/settings', { format: 'ORAL', sessionIds, minutes: 8 }, admin);
    check('the oral sessions chosen from the programme, 8 minutes each', set.body.success, set.body);
    check('...only real sessions', (await call('PUT', '/api/admin/oral-order/settings', { format: 'ORAL', sessionIds: [987654321] }, admin)).status === 400);
    let d = await get();
    const mine = (x) => x.items.filter((p) => ids.includes(p.id));
    check('every oral paper with its decision sent, not yet placed', d.sessions.length === 2 && ids.every((id) => d.unallotted.some((p) => p.id === id)), d);
    const al = await call('POST', '/api/admin/oral-order/allot', { format: 'ORAL' }, admin);
    d = await get();
    check('Place the rest: spread over the sessions, times from each start', al.body.allotted >= 5 && d.unallotted.length === 0
      && d.sessions[0].items[0].time === '8:00 AM' && (d.sessions[0].items[1] || {}).time === '8:08 AM', d.sessions.map((x) => x.items.map((p) => p.time)));
    const first = d.sessions[0].items[0].id;
    await call('POST', '/api/admin/oral-order/move', { format: 'ORAL', abstractId: first, sessionId: d.sessions[0].id, index: 1 }, admin);
    d = await get();
    check('moved down one: second, at 8:08', d.sessions[0].items[1].id === first && d.sessions[0].items[1].time === '8:08 AM');
    await call('POST', '/api/admin/oral-order/move', { format: 'ORAL', abstractId: first, sessionId: d.sessions[1].id, index: 0 }, admin);
    d = await get();
    check('...to the other session, first, at its start', d.sessions[1].items[0].id === first && d.sessions[1].items[0].time === '3:00 PM');
    await call('POST', '/api/admin/oral-order/move', { format: 'ORAL', abstractId: first, sessionId: null }, admin);
    check('...or off, back to not placed', (await get()).unallotted.some((p) => p.id === first));
    check('an abstract that is not an oral paper cannot be placed here', (await call('POST', '/api/admin/oral-order/move', { format: 'ORAL', abstractId: 99999999, sessionId: sessionIds[0] }, admin)).status === 404);
    check('award papers have their own, 10 minutes each by default', (await call('GET', '/api/admin/oral-order?format=AWARD', null, admin)).body.minutes === 10);
    const pdf = await call('GET', '/api/admin/oral-order/order.pdf?format=ORAL', null, admin);
    check('the running order as a PDF', pdf.status === 200 && /application\/pdf/.test(pdf.headers['content-type']));
    await call('POST', '/api/admin/oral-order/allot', { format: 'ORAL' }, admin);
    const rec = (await call('GET', '/api/admin/reminders/audiences/presenters/recipients?format=ORAL', null, admin)).body;
    const src = fs.readFileSync(appFile('server.js'), 'utf8');
    check('Reminders {{screen}} gives an oral presenter their day, time and hall', /for \(const fmt of \['ORAL', 'AWARD'\]\)/.test(src) && rec.success === true);
    const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
    const view = fs.readFileSync(appFile('views', 'admin', 'sections', 'abstracts.ejs'), 'utf8');
    check('Step 4 switches between e-posters, oral and award papers', /data-order-view="ORAL"/.test(view) && /data-order-view="AWARD"/.test(view) && /id="oral-order"/.test(view)
      && /function drawOralOrder\(\)/.test(js));
  } finally {
    if (ids.length) {
      await db.run(`DELETE FROM oral_slots WHERE abstract_id IN (${ids.map(() => '?').join(',')})`, ids);
      await db.run(`DELETE FROM abstracts WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    }
    for (const id of sessionIds) if (id) await db.run('DELETE FROM programme_sessions WHERE id = ?', [id]);
    if (hallId) await db.run('DELETE FROM halls WHERE id = ?', [hallId]);
    await db.run("DELETE FROM schema_meta WHERE key LIKE 'oral_%'");
    await db.run('DELETE FROM oral_slots WHERE session_id NOT IN (SELECT id FROM programme_sessions)');
    db.close();
  }
  report();
})();
