// The home page while the conference is on (owner, 21 Nov 2026): what is
// happening and what is next, from the programme, at the time asked.
const fs = require('fs');
const { call, check, report, appFile, adminLogin, loginOtp, openDb } = require('./harness');
const L = require('../website-live');

const isBreak = (s) => Number(s.meal) === 1 || (!s.label && /\b(break|breakfast|lunch|tea|registration|dinner)\b/i.test(s.title || ''));
const S = (date, a, b, title, hall, extra = {}) => ({ session_date: date, start_time: a, end_time: b, title, hall, label: '', meal: 0, hall_sort: 1, ...extra });
const at = (date, hm) => Date.parse(`${date}T${hm}:00+05:30`);
const D1 = '2026-11-21';
const D2 = '2026-11-22';
const workshops = Array.from({ length: 8 }, (_, i) => S(D1, '09:00', '16:30', `Workshop topic ${i + 1}`, `Room ${i + 1}`, { label: `Workshop ${i + 1}`, workshop: 1 }));
workshops.push(S(D1, '14:00', '17:00', 'Late workshop', 'Skills Lab', { label: 'Workshop 9', workshop: 1 }));
const sessions = [
  S(D1, '08:00', '09:00', 'Breakfast', 'Lawn', { meal: 1 }), ...workshops,
  S(D1, '13:00', '14:00', 'Lunch', 'Lawn', { meal: 1 }), S(D1, '13:00', '14:00', 'Lunch', 'Garden', { meal: 1 }),
  S(D1, '18:00', '20:00', 'Conference Inauguration', 'Main Auditorium'),
  S(D2, '07:00', '09:30', 'Village visit', 'Village (field visit)', { label: 'Exposure visit' }),
  S(D2, '09:30', '09:50', 'Talk A', 'Main Auditorium', { label: 'Session 1', speakers: 'Dr One' }),
  S(D2, '09:30', '09:50', 'Talk B', 'Hall A', { label: 'Session 1', hall_sort: 2 }),
  S(D2, '10:30', '11:00', 'Tea Break', 'Dining'),
  S(D2, '15:20', '16:00', 'NQOCN Oration', 'Main Auditorium', { label: 'Oration' }),
];
const days = [D1, D2];
const build = (date, hm) => L.build(sessions, { days, now: at(date, hm), isBreak });

(async () => {
  console.log('\n== What is on, and next ==');
  check('not a conference day: not live', build('2026-11-20', '10:00') === null && build('2026-11-23', '10:00') === null);
  const morning = build(D1, '07:30');
  check('before the day: when it begins, and what is coming up', morning.headline === 'Day 1 begins at 8:00 am' && morning.now.kind === 'next' && morning.next[0].title === 'Workshops, 9 in parallel', morning);
  const ws = build(D1, '14:30');
  check('workshops on: said, each with its room, numbered, an odd time shown', ws.headline === 'The workshops are under way' && ws.now.kind === 'workshops' && ws.now.items.length === 9
    && ws.now.items[0].no === 1 && ws.now.items[0].where === 'Room 1' && ws.now.items[0].time === '' && ws.now.items[8].time === '2:00 – 5:00 pm', ws.now);
  check('...today at a glance: done, now, later; meals in two places once', ws.strip.map((x) => `${x.state}:${x.title}`).join('|') === 'done:Breakfast|now:Workshops, 9 in parallel|done:Lunch|later:Conference Inauguration'
    && ws.strip.find((x) => x.title === 'Lunch').where === 'Lawn and Garden', ws.strip);
  check('...next up with a countdown, skipping meals', ws.next[0].title === 'Conference Inauguration' && ws.next[0].in === 'in 3 h 30 min' && ws.next[0].time === '6:00 pm', ws.next);
  check('...tomorrow: field visits, the sessions, the oration', ws.tomorrow && ws.tomorrow.rows.map((r) => r.title).join('|') === 'Village visit|Sessions in 2 halls|Tea Break|NQOCN Oration'
    && ws.tomorrow.rows[0].where === 'Village', ws.tomorrow);
  const night = build(D1, '22:30');
  check('after the day: see you tomorrow, next is tomorrow', /See you tomorrow/.test(night.headline) && night.next[0].in === 'tomorrow' && night.now.kind === 'none');
  const halls = build(D2, '09:40');
  check('sessions on: in which halls, in hall order, with speakers and until when', halls.headline === 'Sessions are on in 2 halls' && halls.now.items.map((x) => x.where).join('|') === 'Main Auditorium|Hall A'
    && halls.now.items[0].speakers === 'Dr One' && halls.now.items[0].time === 'until 9:50 am', halls.now);
  const oration = build(D2, '15:30');
  check('one big moment on: named', oration.headline === 'NQOCN Oration is on now');
  const end = build(D2, '18:00');
  check('the last day over: thank you, no tomorrow', end.headline === 'Thank you for joining us' && end.tomorrow === null && end.last === true);

  console.log('\n== The page ==');
  const admin = await adminLogin();
  const conf = ((await call('GET', '/api/admin/general-settings', null, admin)).body || {}).conference || {};
  const plain = await call('GET', '/website?at=2000-01-01T10:00');
  check('on any other day: the home page as before', plain.status === 200 && !/live-hero/.test(plain.raw) && /hero-actions/.test(plain.raw));
  // A session on the conference's first day, for the page to be live about.
  const prog = (await call('GET', '/api/admin/programme', null, admin)).body;
  const hall = (prog.halls || []).find((h) => h.active) || (await call('POST', '/api/admin/programme/halls', { name: `Live Test Hall ${Date.now()}` }, admin)).body;
  const day = conf.startDate;
  const made = hall && day ? (await call('POST', '/api/admin/programme/sessions', { hallId: hall.id, date: day, start: '09:00', end: '17:00', title: `Live home test ${Date.now()}`, counts: false }, admin)).body : null;
  if (made && made.id) {
    const live = await call('GET', `/website?at=${day}T10:00`);
    check('on a conference day: live, the conference name still at the top, partners and footer below', live.status === 200 && /live-hero/.test(live.raw) && /<h1>/.test(live.raw)
      && /With our partners/.test(live.raw) && /site-footer/.test(live.raw) && /programme-at-a-glance\.pdf/.test(live.raw), live.status);
    check('...checked at a set time, it does not reload itself; live, it does every 5 minutes', !/http-equiv="refresh"/.test(live.raw)
      && /extraHead: live && !at \? '<meta http-equiv="refresh" content="300">'/.test(fs.readFileSync(appFile('website.js'), 'utf8')));
    await call('DELETE', `/api/admin/programme/sessions/${made.id}`, null, admin);
  } else {
    check('a session could be added on the conference\'s first day', false, made);
  }
  console.log('\n== Signed in: the pass and For you ==');
  check('not signed in: nothing', (await call('GET', '/api/site/for-you')).status === 401);
  const db = await openDb();
  const r = await db.get("SELECT r.id, r.phone_number, r.registration_number, r.bank_status, r.checked_in_at FROM registrations r JOIN users u ON u.phone_number = r.phone_number WHERE r.bank_status = 'BANK_VERIFIED' AND r.registration_number IS NOT NULL ORDER BY r.id LIMIT 1");
  if (r) {
    const me = await loginOtp(r.phone_number);
    const mine = (await call('GET', '/api/site/for-you', null, me)).body;
    check('a delegate: their pass, with the badge QR and check-in', mine.success && mine.pass && mine.pass.regNo === r.registration_number
      && mine.pass.qr === `/api/qr/${encodeURIComponent(r.registration_number)}.png` && mine.pass.checkedIn === !!r.checked_in_at, mine);
    await db.run("UPDATE registrations SET bank_status = 'PARTIAL_PAYMENT' WHERE id = ?", [r.id]);
    const owing = (await call('GET', '/api/site/for-you', null, me)).body;
    await db.run('UPDATE registrations SET bank_status = ? WHERE id = ?', [r.bank_status, r.id]);
    check('...a balance due comes first, as something to do', owing.notes[0] && owing.notes[0].tag === 'Balance due' && owing.notes[0].tone === 'act' && owing.notes[0].action.to === 'portal', owing.notes);
    check('...never another person\'s phone or email in it', !/@|\d{10}/.test(JSON.stringify(mine.notes)));
    // Feedback due (21 Nov 2026): only for a workshop they are registered for,
    // once it is over and they were present; not for one they are not in.
    const progAll = (await call('GET', '/api/admin/programme', null, admin)).body;
    const enrolled = (await db.all('SELECT option_id FROM registration_options WHERE registration_id = ?', [r.id])).map((x) => Number(x.option_id));
    const hallId = ((progAll.halls || []).find((h) => h.active) || (progAll.halls || [])[0] || {}).id;
    const mk = async (optionId, title) => (await call('POST', '/api/admin/programme/sessions', { hallId, date: '2020-01-01', start: '09:00', end: '10:00', title, counts: true, optionId }, admin)).body.id;
    const listed = async () => (await call('GET', '/api/admin/programme', null, admin)).body.sessions;
    const theirs = enrolled[0] ? await mk(enrolled[0], `Feedback test theirs ${Date.now()}`) : null;
    const other = (progAll.options || []).find((o) => !enrolled.includes(Number(o.id)));
    const notTheirs = other ? await mk(other.id, `Feedback test other ${Date.now()}`) : null;
    const flags = await listed();
    if (theirs && notTheirs && flags.find((x) => x.id === theirs).workshop && flags.find((x) => x.id === notTheirs).workshop) {
      for (const id of [theirs, notTheirs]) await db.run("INSERT INTO attendance (phone_number, event_key, at, method) VALUES (?, ?, ?, 'MANUAL')", [r.phone_number, `s:${id}`, Date.now()]);
      const fb = (await call('GET', '/api/site/for-you', null, me)).body.notes.filter((n) => n.tag === 'Feedback due');
      check('feedback due: their workshop, over, present, not given -- and not one they are not registered for', fb.length === 1 && fb[0].action.to === 'portal', fb);
      await db.run("DELETE FROM attendance WHERE event_key IN (?, ?)", [`s:${theirs}`, `s:${notTheirs}`]);
    } else {
      check('the fixture has a registered workshop and another to test feedback with', false, { enrolled, other: !!other });
    }
    for (const id of [theirs, notTheirs].filter(Boolean)) await call('DELETE', `/api/admin/programme/sessions/${id}`, null, admin);
  } else {
    check('the fixture has a confirmed registration', false);
  }
  const home = await call('GET', '/website');
  const live = fs.readFileSync(appFile('views/website/partials/live.ejs'), 'utf8');
  check('the home page asks for it; with a pass the general check-in and portal boxes hide; no weather box', /id="you"/.test(home.raw) && /\/api\/site\/for-you/.test(home.raw)
    && (live.match(/if-guest/g) || []).length === 2 && !/Mornings are cool/.test(live));
  check('one fact once: no "Next:" in the banner text, no second PDF button under Tomorrow', !/lead \+= ` Next:/.test(fs.readFileSync(appFile('website-live.js'), 'utf8'))
    && (live.match(/glancePdf/g) || []).length === 1);
  const foot = fs.readFileSync(appFile('views/website/partials/foot.ejs'), 'utf8');
  check('the footer says Sevagram once', /addrParts\.slice\(1\)\.join/.test(foot));
  report();
})();
