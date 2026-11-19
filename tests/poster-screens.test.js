// Step 4 of the abstracts desk, poster screens (owner, 19 Nov 2026): every
// e-poster whose decision has been sent gets a screen and a place in that
// screen's running order; its time follows from the poster session and the
// minutes per poster. Five screens to begin with, more added later. The
// presenter sees their screen in the portal once it is switched on; staff
// see it on the Front Desk whatever the switch.
const fs = require('fs');
const { call, adminLogin, loginPassword, ADMIN_PW, appFile, check, report, openDb } = require('./harness');
const L = require('../poster-screens');

const DESK = '9000000006'; // Dez Counter, FRONT_DESK: no abstracts.assign
const FIXTURE_ORAL = '9000001003'; // Half Price: an accepted ORAL abstract

(async () => {
  console.log('\n== The logic ==');
  const f = L.fit({ total: 83, screens: 5, minutes: 7, session: { start: '14:00', end: '15:00' } });
  check('83 posters on 5 screens at 7 minutes run an hour over a 2-3 PM session',
    f.perScreen === 17 && f.endTime === '3:59 PM' && f.overrun === 59 && f.screensNeeded === 11 && f.minutesThatFit === 3, f);
  check('...and a load that fits says so', L.fit({ total: 40, screens: 5, minutes: 7, session: { start: '14:00', end: '15:00' } }).overrun === 0);
  const plan = L.allotEvenly([1, 2, 3], new Map([[1, 2]]), [10, 11, 12, 13, 14]);
  check('allotting fills the emptiest screen first, the earlier on a tie',
    JSON.stringify(plan.map((x) => x.screenId)) === JSON.stringify([2, 3, 2, 3, 1]) && plan[4].position === 2, plan);
  const b = L.board({
    screens: [{ id: 1, name: 'Screen 1', sort_order: 1 }, { id: 2, name: 'Screen 2', sort_order: 2 }],
    slots: [{ abstract_id: 5, screen_id: 1, position: 4 }, { abstract_id: 6, screen_id: 1, position: 1 }, { abstract_id: 99, screen_id: 2, position: 0 }],
    posters: [{ id: 5 }, { id: 6 }, { id: 7 }], session: { date: '2026-11-22', start: '14:00', end: '15:00' }, minutes: 7,
  });
  check('times follow the order, not the stored numbers', b.screens[0].posters.map((p) => `${p.id}@${p.time}`).join() === '6@2:00 PM,5@2:07 PM');
  check('a slot for an abstract that is no longer an e-poster is ignored', b.screens[1].posters.length === 0);
  check('a poster with no slot waits, not allotted', b.unallotted.map((p) => p.id).join() === '7');
  check('the presenter\'s line', L.placeLine({ name: 'Screen 1' }, b.screens[0].posters[1], { date: '2026-11-22', hall: 'Hall B' })
    === 'Screen 1 · Sunday 22 November · about 2:07 PM (2nd) · Hall B');

  const db = openDb();
  const admin = await adminLogin();
  const desk = await loginPassword(DESK, ADMIN_PW);
  const ids = [];
  const fixtureOral = await db.get("SELECT id, allocation, decision_sent_at FROM abstracts WHERE phone_number = ? AND status = 'ACCEPTED'", [FIXTURE_ORAL]);
  const screensBefore = await db.all('SELECT * FROM poster_screens');
  let hallId = null;
  let sessionId = null;
  try {
    console.log('\n== Five screens, and the posters to put on them ==');
    check('five screens to begin with', screensBefore.length === 5 && screensBefore.map((s) => s.name).join() === 'Screen 1,Screen 2,Screen 3,Screen 4,Screen 5');
    for (let i = 0; i < 7; i++) {
      const r = await db.run(`INSERT INTO abstracts (phone_number, author_name, format, title, text, word_count, status, allocation, decision_sent_at)
        VALUES (?, ?, 'Poster', ?, 'Body', 100, 'ACCEPTED', 'POSTER', ?)`, [`95555000${10 + i}`, `Poster Person ${i + 1}`, `Poster ${i + 1}`, Date.now()]);
      ids.push(r.lastID);
    }
    // Not yet told: no screen for it.
    const untold = await db.run(`INSERT INTO abstracts (phone_number, author_name, format, title, text, word_count, status, allocation)
      VALUES ('9555500099', 'Not Told', 'Poster', 'Decision not sent', 'Body', 100, 'ACCEPTED', 'POSTER')`);
    ids.push(untold.lastID);
    // The fixture's ORAL abstract, as an e-poster told, for the desk record.
    await db.run("UPDATE abstracts SET allocation = 'POSTER', decision_sent_at = ? WHERE id = ?", [Date.now(), fixtureOral.id]);
    hallId = (await call('POST', '/api/admin/programme/halls', { name: `Poster hall ${Date.now()}` }, admin)).body.id;
    sessionId = (await call('POST', '/api/admin/programme/sessions',
      { hallId, date: '2026-11-22', start: '14:00', end: '15:00', label: 'Poster Presentations', title: 'Poster presentations test', counts: false }, admin)).body.id;
    check('a poster session in the programme', !!hallId && !!sessionId);

    let d = (await call('GET', '/api/admin/poster-screens', null, admin)).body;
    check('every e-poster told waits to be allotted, none untold', d.success && d.unallotted.length === 8
      && !d.unallotted.some((p) => p.id === untold.lastID) && d.unallotted.some((p) => p.id === fixtureOral.id), d.unallotted && d.unallotted.length);
    let set = await call('PUT', '/api/admin/poster-screens/settings', { sessionId }, admin);
    check('the session is chosen from the programme', set.body.success, set.body);
    check('...and nothing else', (await call('PUT', '/api/admin/poster-screens/settings', { sessionId: 987654 }, admin)).status === 400);

    console.log('\n== Allotting ==');
    check('a role without abstracts.assign may not allot', (await call('POST', '/api/admin/poster-screens/allot', {}, desk)).status === 403);
    const allot = (await call('POST', '/api/admin/poster-screens/allot', {}, admin)).body;
    d = (await call('GET', '/api/admin/poster-screens', null, admin)).body;
    const sizes = d.screens.map((s) => s.posters.length);
    check('all eight go on, evenly', allot.allotted === 8 && d.unallotted.length === 0 && Math.max(...sizes) - Math.min(...sizes) <= 1, sizes);
    check('times run from the session start, 7 minutes apart', d.screens[0].posters[0].time === '2:00 PM' && d.screens[0].posters[1].time === '2:07 PM', d.screens[0].posters);
    check('allotting again moves nobody', (await call('POST', '/api/admin/poster-screens/allot', {}, admin)).body.allotted === 0);

    console.log('\n== Moving ==');
    const s2 = d.screens[1];
    const last = s2.posters[s2.posters.length - 1];
    await call('POST', '/api/admin/poster-screens/move', { abstractId: last.id, screenId: s2.id, index: 0 }, admin);
    d = (await call('GET', '/api/admin/poster-screens', null, admin)).body;
    check('a poster moved to the top takes the first time', d.screens[1].posters[0].id === last.id && d.screens[1].posters[0].time === '2:00 PM');
    const mover = d.screens[0].posters.find((p) => p.id !== fixtureOral.id);
    await call('POST', '/api/admin/poster-screens/move', { abstractId: mover.id, screenId: d.screens[4].id }, admin);
    d = (await call('GET', '/api/admin/poster-screens', null, admin)).body;
    check('...to another screen, at its end', d.screens[4].posters.slice(-1)[0].id === mover.id && !d.screens[0].posters.some((p) => p.id === mover.id));
    await call('POST', '/api/admin/poster-screens/move', { abstractId: mover.id, screenId: null }, admin);
    d = (await call('GET', '/api/admin/poster-screens', null, admin)).body;
    check('...or off the screens', d.unallotted.some((p) => p.id === mover.id));
    check('an untold abstract cannot be put on a screen', (await call('POST', '/api/admin/poster-screens/move', { abstractId: untold.lastID, screenId: d.screens[0].id }, admin)).status === 404);

    console.log('\n== Settings ==');
    check('minutes per poster must be sensible', (await call('PUT', '/api/admin/poster-screens/settings', { minutes: 1 }, admin)).status === 400);
    await call('PUT', '/api/admin/poster-screens/settings', { minutes: 4 }, admin);
    d = (await call('GET', '/api/admin/poster-screens', null, admin)).body;
    check('changing the minutes changes every time', d.screens[1].posters[1].time === '2:04 PM', d.screens[1].posters);

    console.log('\n== Screens come and go ==');
    const added = (await call('POST', '/api/admin/poster-screens', {}, admin)).body;
    d = (await call('GET', '/api/admin/poster-screens', null, admin)).body;
    check('a sixth screen, empty, named in turn', added.success && d.screens.length === 6 && d.screens[5].name === 'Screen 6' && d.screens[5].posters.length === 0);
    await call('PUT', `/api/admin/poster-screens/${added.id}`, { name: 'Screen 6 (foyer)', moderator: 'Dr Moderator' }, admin);
    await call('POST', '/api/admin/poster-screens/move', { abstractId: mover.id, screenId: added.id }, admin);
    d = (await call('GET', '/api/admin/poster-screens', null, admin)).body;
    check('renamed, with a moderator, and a poster on it', d.screens[5].name === 'Screen 6 (foyer)' && d.screens[5].moderator === 'Dr Moderator' && d.screens[5].posters.length === 1);
    const removed = (await call('DELETE', `/api/admin/poster-screens/${added.id}`, null, admin)).body;
    d = (await call('GET', '/api/admin/poster-screens', null, admin)).body;
    check('removing it sends its poster to Not allotted', removed.unallotted === 1 && d.screens.length === 5 && d.unallotted.some((p) => p.id === mover.id));

    console.log('\n== Files and the running order ==');
    const pdf = await call('GET', '/api/admin/poster-screens/order.pdf', null, admin);
    check('the running order of every screen, as a PDF', pdf.status === 200 && /application\/pdf/.test(pdf.headers['content-type']), pdf.status);
    const one = await call('GET', `/api/admin/poster-screens/order.pdf?screen=${d.screens[0].id}`, null, admin);
    check('...or of one', one.status === 200 && /Screen-1/.test(one.headers['content-disposition'] || ''));
    check('a screen with no file in yet has no zip', (await call('GET', `/api/admin/poster-screens/${d.screens[0].id}/files.zip`, null, admin)).status === 404);

    console.log('\n== Who sees it ==');
    const onDesk = async () => ((await call('GET', `/api/desk/delegate/${FIXTURE_ORAL}`, null, admin)).body.abstracts || []).find((a) => a.id === fixtureOral.id);
    let a = await onDesk();
    check('the Front Desk shows the screen before presenters see it, saying so', a && a.poster && /^Screen \d/.test(a.poster.screen) && a.poster.published === false, a && a.poster);
    await call('PUT', '/api/admin/poster-screens/settings', { published: true }, admin);
    a = await onDesk();
    check('...and once switched on, it is shown', a.poster.published === true && /Sunday 22 November/.test(a.poster.line));
    const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
    check('the portal\'s Abstract card shows "You present on", from the presentation\'s screen', /const sc = p\.screen;/.test(js) && /You present on/.test(js));
    const src = fs.readFileSync(appFile('server.js'), 'utf8');
    check('...only once switched on', /screen: place && place\.published \? place : null/.test(src));
    const rem = require('../reminders');
    const presenters = rem.AUDIENCES.find((x) => x.key === 'presenters');
    check('Reminders can put {{screen}} in a presenter email', presenters.placeholders.includes('screen') && !!rem.PLACEHOLDERS.screen);

    console.log('\n== The page ==');
    const html = (await call('GET', '/admin', null, admin)).raw;
    check('Step 4 is the poster screens, between Presentations and Zenodo (Step 5)', html.indexOf('Step 3 · Presentations') < html.indexOf('Step 4 · Poster screens')
      && html.indexOf('Step 4 · Poster screens') < html.indexOf('Step 5 · Publish'));
    check('one screen at a time on a phone, every screen side by side on a laptop', /id="screens-chips"[^>]*lg:hidden/.test(html)
      && /'flex' : 'hidden lg:flex'/.test(js));
  } finally {
    if (sessionId) await db.run('DELETE FROM programme_sessions WHERE id = ?', [sessionId]);
    if (hallId) await db.run('DELETE FROM halls WHERE id = ?', [hallId]);
    if (ids.length) await db.run(`DELETE FROM abstracts WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    await db.run('UPDATE abstracts SET allocation = ?, decision_sent_at = ? WHERE id = ?', [fixtureOral.allocation, fixtureOral.decision_sent_at, fixtureOral.id]);
    await db.run('DELETE FROM poster_slots');
    await db.run(`DELETE FROM poster_screens WHERE id NOT IN (${screensBefore.map(() => '?').join(',') || 'NULL'})`, screensBefore.map((s) => s.id));
    await db.run("DELETE FROM schema_meta WHERE key IN ('poster_session_id', 'poster_minutes', 'poster_published')");
    db.close();
  }
  report();
})();
