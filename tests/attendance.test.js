// Attendance, for the e-certificates.
//
//   * The events and their windows: each day's sign-in (an hour before the
//     day starts until it ends), the last day's sign-out (15:00-18:00), each
//     workshop's sign-in (half an hour before it starts until it ends) -- in
//     IST, on its own date.
//   * Completing the conference = in on every day, out on the last.
//   * Self sign-in codes are signed, and good for five minutes only.
//   * A volunteer signs people in by desk pass; a workshop takes those
//     enrolled, others only with a reason. An attendance manager can record
//     or remove one at any time, with a reason.
//   * The delegate sees their own record, and sets the name their
//     certificate carries and (doctor or medical PG) their council number.
const { call, check, report, ADMIN_PW, appFile, adminLogin, loginPassword, openDb } = require('./harness');
const fs = require('fs');
const A = require('../attendance');

const IST = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+05:30`);
const N = String(Date.now()).slice(-7);

(async () => {
  console.log('\n== Events and their windows ==');
  const ws = [{ id: 7, name: 'Leadership', session_date: '2026-11-20', start_time: '09:30', end_time: '13:00' },
    { id: 8, name: 'No date yet' }];
  const evs = A.buildEvents({ startDate: '2026-11-21', endDate: '2026-11-22', workshops: ws });
  check('a sign-in for each day, a sign-out on the last, then each workshop',
    evs.map((e) => e.e).join() === 'day1:IN,day2:IN,day2:OUT,ws:7:IN,ws:8:IN', evs.map((e) => e.e));
  const [d1, d2, out, w7, w8] = evs;
  check('a day opens an hour before 8 AM and closes at 5 PM', d1.from === '07:00' && d1.until === '17:00' && d1.date === '2026-11-21');
  check('signing out: 3 PM to 6 PM on the last day', out.from === '15:00' && out.until === '18:00' && out.date === '2026-11-22');
  check('a workshop: half an hour early, to its end', w7.from === '09:00' && w7.until === '13:00' && w7.date === '2026-11-20');
  check('one-day conference: its day and its sign-out', A.buildEvents({ startDate: '2026-11-21', endDate: '' }).map((e) => e.e).join() === 'day1:IN,day1:OUT');
  check('no dates, no conference events', A.buildEvents({ startDate: '' }).length === 0);
  check('the hours come from settings', A.buildEvents({ startDate: '2026-11-21', hours: { dayStart: '09:00', signInEarlyMinutes: 30 } })[0].from === '08:30');

  const open = (ev, date, t) => A.windowStatus(ev, IST(date, t));
  check('Day 1 at 7:30 AM: open', open(d1, '2026-11-21', '07:30').open === true);
  check('...at 6:30 AM: not yet, saying when it opens', open(d1, '2026-11-21', '06:30').open === false && /opens at 7:00 AM/.test(open(d1, '2026-11-21', '06:30').reason));
  check('...at 5:30 PM: closed', open(d1, '2026-11-21', '17:30').open === false && /closed at 5:00 PM/.test(open(d1, '2026-11-21', '17:30').reason));
  check('...on another day: no, naming its date', open(d1, '2026-11-22', '09:00').open === false && /21 Nov/.test(open(d1, '2026-11-22', '09:00').reason));
  check('signing out at 4 PM on the last day: open; at noon: not yet', open(out, '2026-11-22', '16:00').open && !open(out, '2026-11-22', '12:00').open);
  check('a workshop with no date cannot be signed into, and says to set it', !A.windowStatus(w8, Date.now()).open && /Programs/.test(A.windowStatus(w8, Date.now()).reason));
  check('IST, not the server\'s zone: 11:00 PM UTC on the 20th is the 21st in India', A.istParts(Date.parse('2026-11-20T23:00:00Z')).date === '2026-11-21');

  console.log('\n== Completing the conference ==');
  const rows = (...keys) => keys.map((k) => ({ event_key: k }));
  check('in on both days and out on the last: complete', A.completion(rows('day1:IN', 'day2:IN', 'day2:OUT'), evs).complete === true);
  const noOut = A.completion(rows('day1:IN', 'day2:IN', 'ws:7:IN'), evs);
  check('no sign-out: not complete, and says so', !noOut.complete && noOut.missing.join() === 'Day 2 · Sign out');
  check('a workshop alone does not complete it', !A.completion(rows('ws:7:IN'), evs).complete);

  console.log('\n== Self sign-in codes ==');
  const secret = 'test-secret';
  const t0 = Date.parse('2026-11-21T03:00:00Z');
  const token = A.makeToken(secret, 'day1:IN', t0);
  check('a code reads back as its event', A.readToken(secret, token, t0 + 1000).e === 'day1:IN');
  check('...for five minutes', !!A.readToken(secret, token, t0 + 4.5 * 60e3).e && /expired/.test(A.readToken(secret, token, t0 + 5.5 * 60e3).error));
  check('a code from the future is refused', !!A.readToken(secret, token, t0 - 60e3).error);
  check('changing its event breaks it', !!A.readToken(secret, token.replace('day1:IN', 'day2:IN'), t0).error);
  check('another key\'s code is refused', !!A.readToken('other', token, t0).error);
  check('rubbish is refused', !!A.readToken(secret, 'not a code', t0).error && !!A.readToken(secret, '', t0).error);

  console.log('\n== The routes ==');
  const admin = await adminLogin();
  const desk = await loginPassword('9000000006', ADMIN_PW);      // FRONT_DESK
  const reviewer = await loginPassword('9000000003', ADMIN_PW);  // ACADEMIC_REVIEWER
  const db = openDb();
  const today = A.istParts(Date.now()).date;
  const option = await db.get(
    `SELECT o.id, o.name, o.session_date, o.start_time, o.end_time FROM program_options o JOIN program_groups g ON g.id = o.group_id
      WHERE g.name = 'Workshops' AND o.active = 1 AND EXISTS (SELECT 1 FROM registration_options ro WHERE ro.option_id = o.id) LIMIT 1`);
  check('fixture: a workshop with someone enrolled', !!option);
  const groupsNow = (await call('GET', '/api/admin/program-groups', null, admin)).body.groups;
  check('the Workshops group takes attendance from the start', groupsNow.find((g) => g.name === 'Workshops').takes_attendance === 1);
  check('...QI Practices does not, until switched on', groupsNow.find((g) => g.name === 'QI Practices').takes_attendance === 0);
  // Two delegates of the test's own (the shared fixture's are signed in to
  // by other tests): one enrolled in the workshop, one not.
  const base = { salutation: 'Dr', age: '40', gender: 'Female', designation: 'Professor', institute: 'Test College', pincode: '442102', state: 'Maharashtra', district: 'Wardha' };
  const signUp = async (email, name) => {
    const otp = await call('POST', '/api/otp/request', { destination: email });
    const r = await call('POST', '/api/auth/register', { ...base, name, country: 'United Kingdom', email, emailOtp: otp.body.devOtp, password: 'testpass123' });
    return { phone: r.body.user && r.body.user.phone_number, cookie: r.cookie, email };
  };
  const register = async (who, n) => {
    const r = await db.run(`INSERT INTO registrations (phone_number, delegate_name, category_key, category_label, bank_status, registration_number)
      VALUES (?, ?, 'chw', 'Frontline Health Worker', 'BANK_VERIFIED', ?)`, [who.phone, `Attendee ${n} ${N}`, `ATT${n}${N}`]);
    return { ...who, id: r.lastID, phone_number: who.phone, registration_number: `ATT${n}${N}`, category_key: 'chw' };
  };
  const enrolled = await register(await signUp(`att-in-${N}@example.test`, `Attendee In ${N}`), 1);
  const other = await register(await signUp(`att-out-${N}@example.test`, `Attendee Out ${N}`), 2);
  await db.run('INSERT INTO registration_options (registration_id, group_id, option_id, is_faculty) VALUES (?, (SELECT group_id FROM program_options WHERE id = ?), ?, 0)', [enrolled.id, option.id, option.id]);
  check('fixture: one enrolled, one not', !!enrolled && !!other);
  const e = `ws:${option.id}:IN`;
  const made = [];
  try {
    console.log('\n== The workshop master ==');
    const put = (body) => call('PUT', `/api/admin/program-options/${option.id}`, body, admin);
    check('an end before the start is refused', (await put({ sessionDate: today, startTime: '12:00', endTime: '11:00' })).status === 400);
    check('a bad date is refused', (await put({ sessionDate: '21-11-2026' })).status === 400);
    const set = await put({ sessionDate: today, startTime: '00:00', endTime: '23:59' });
    check('a date and times are saved', set.body.success === true && (await db.get('SELECT session_date, start_time, end_time FROM program_options WHERE id = ?', [option.id])).end_time === '23:59', set.body);
    const listed = (await call('GET', '/api/admin/program-groups', null, admin)).body.groups.flatMap((g) => g.options).find((o) => o.id === option.id);
    check('...and listed with the option', listed.session_date === today && listed.start_time === '00:00');
    const qiGroup = await db.get("SELECT id FROM program_groups WHERE name = 'QI Practices'");
    await call('PUT', `/api/admin/program-groups/${qiGroup.id}`, { takesAttendance: true }, admin);
    const qiOn = Number((await db.get('SELECT takes_attendance FROM program_groups WHERE id = ?', [qiGroup.id])).takes_attendance);
    await call('PUT', `/api/admin/program-groups/${qiGroup.id}`, { takesAttendance: false }, admin);
    check('a group can be switched to take attendance, and back', qiOn === 1 && Number((await db.get('SELECT takes_attendance FROM program_groups WHERE id = ?', [qiGroup.id])).takes_attendance) === 0);
    await db.run('UPDATE program_groups SET takes_attendance = NULL WHERE id = ?', [qiGroup.id]);

    const events = (await call('GET', '/api/attendance/events', null, desk)).body.events || [];
    const mine = events.find((x) => x.e === e);
    check('the desk sees the workshop, open now', !!mine && mine.window.open === true, mine);

    console.log('\n== Signing in at the door ==');
    const scan = (body, who = desk) => call('POST', '/api/attendance/scan', { e, ...body }, who);
    const first = await scan({ identifier: enrolled.registration_number });
    check('an enrolled delegate is signed in', first.body.success === true && first.body.already === false && !!first.body.name, first.body);
    const again = await scan({ identifier: enrolled.registration_number });
    check('...and a second scan says when they already were', again.body.success === true && again.body.already === true && again.body.at === first.body.at);
    const notEnrolled = await scan({ identifier: other.registration_number });
    check('someone not enrolled is refused, and asked about', notEnrolled.status === 409 && notEnrolled.body.notEnrolled === true);
    const letIn = await scan({ identifier: other.registration_number, notEnrolledReason: 'Swapped with a colleague' });
    check('...let in with a reason, which is kept', letIn.body.success === true
      && /Not enrolled: Swapped/.test((await db.get('SELECT note FROM attendance WHERE phone_number = ? AND event_key = ? AND removed_at IS NULL', [other.phone_number, e])).note));
    check('nobody found: said', (await scan({ identifier: 'NQOCN-NOBODY-999' })).status === 404);
    const dayEvent = events.find((x) => x.scope === 'day' && !x.window.open);
    if (dayEvent) check('a day not open now is refused, with when', (await call('POST', '/api/attendance/scan', { e: dayEvent.e, identifier: enrolled.registration_number }, desk)).status === 409);
    check('an academic reviewer cannot take attendance', (await scan({ identifier: enrolled.registration_number }, reviewer)).status === 403);
    check('...nor someone signed out', (await call('POST', '/api/attendance/scan', { e, identifier: 'x' })).status === 401);

    console.log('\n== Signing in from the screen ==');
    const qr = await call('GET', `/api/attendance/screen-qr.png?e=${encodeURIComponent(e)}`, null, desk);
    check('the screen\'s code is a PNG, never cached', qr.status === 200 && /image\/png/.test(qr.headers['content-type']) && /no-store/.test(qr.headers['cache-control']));
    const secretRow = await db.get("SELECT value FROM schema_meta WHERE key = 'attendance_secret'");
    check('...signed with a key made once and kept', !!secretRow && secretRow.value.length === 64);
    const delegate = enrolled.cookie;
    await db.run('UPDATE attendance SET removed_at = ?, removed_by = ?, removed_reason = ? WHERE phone_number = ? AND event_key = ?', [Date.now(), 'test', 'retest', enrolled.phone_number, e]);
    const self = (token) => call('POST', '/api/attendance/self', { token }, delegate);
    const ok = await self(A.makeToken(secretRow.value, e, Date.now()));
    check('a delegate scanning the screen is signed in', ok.body.success === true && ok.body.already === false
      && (await db.get('SELECT method FROM attendance WHERE phone_number = ? AND event_key = ? AND removed_at IS NULL', [enrolled.phone_number, e])).method === 'SELF', ok.body);
    check('an old code is refused', /expired/.test((await self(A.makeToken(secretRow.value, e, Date.now() - 6 * 60e3))).body.error || ''));
    check('a made-up code is refused', (await self(A.makeToken('guess', e, Date.now()))).status === 400);
    check('...and nobody signed out can use one', (await call('POST', '/api/attendance/self', { token: A.makeToken(secretRow.value, e, Date.now()) })).status === 401);

    console.log('\n== Their own record ==');
    const me = (await call('GET', '/api/attendance/me', null, delegate)).body;
    check('it lists the days and their workshop, with when they signed in', me.registered && me.events.some((x) => x.e === e && x.at) && me.events.filter((x) => x.scope === 'day').length >= 0);
    check('...and their default certificate name', !!me.certificate.defaultName && me.certificate.name === null);
    const save = (body) => call('PUT', '/api/attendance/me/certificate', body, delegate);
    check('a name too short is refused', (await save({ certificateName: 'Al' })).status === 400);
    check('a number without its council is refused', (await save({ certificateName: '', councilRegNo: '2012/03/1234' })).status === 400);
    check('a number with odd characters is refused', (await save({ certificateName: '', councilName: 'Maharashtra Medical Council', councilRegNo: 'abc<1>' })).status === 400);
    const saved = await save({ certificateName: `Dr Certificate Name ${N}`, councilName: 'Maharashtra Medical Council', councilRegNo: ' 2012/03/1234 ' });
    const u = await db.get('SELECT certificate_name, council_name, council_reg_no FROM users WHERE phone_number = ?', [enrolled.phone_number]);
    check('the details are saved, the number tidied', saved.body.success === true && u.certificate_name === `Dr Certificate Name ${N}` && u.council_reg_no === '2012/03/1234', u);
    await db.run("UPDATE registrations SET category_key = 'chw' WHERE id = ?", [enrolled.id]);
    const asWorker = (await call('GET', '/api/attendance/me', null, delegate)).body.certificate;
    await db.run("UPDATE registrations SET category_key = 'faculty_mo' WHERE id = ?", [enrolled.id]);
    const asDoctor = (await call('GET', '/api/attendance/me', null, delegate)).body.certificate;
    check('a doctor is asked for the council number; others are not', asDoctor.asksCouncilNumber === true && asWorker.asksCouncilNumber === false);

    console.log('\n== Counts, roster and corrections ==');
    const sum = (await call('GET', '/api/attendance/summary', null, desk)).body;
    const wsSum = sum.events.find((x) => x.e === e);
    check('the counts: in, of those enrolled', wsSum.count === 2 && wsSum.expected >= 1, wsSum);
    const roster = (await call('GET', `/api/attendance/roster?e=${encodeURIComponent(e)}`, null, desk)).body.people;
    check('the roster has everyone enrolled, and who is in', roster.some((p) => p.phone === enrolled.phone_number && p.attendance && p.attendance.method === 'SELF'));
    check('...and someone let in without enrolment, marked so', roster.some((p) => p.phone === other.phone_number && !p.expected && p.attendance));
    check('the desk cannot correct attendance', (await call('POST', '/api/attendance/manual', { e, phone: other.phone_number, reason: 'x' }, desk)).status === 403);
    const row = roster.find((p) => p.phone === other.phone_number).attendance;
    check('removing one needs a reason', (await call('DELETE', `/api/attendance/${row.id}`, {}, admin)).status === 400);
    const removed = await call('DELETE', `/api/attendance/${row.id}`, { reason: 'Scanned by mistake' }, admin);
    const kept = await db.get('SELECT removed_at, removed_reason FROM attendance WHERE id = ?', [row.id]);
    check('...and keeps the row, marked, with it', removed.body.success === true && !!kept.removed_at && kept.removed_reason === 'Scanned by mistake');
    check('recording one by hand needs a reason too', (await call('POST', '/api/attendance/manual', { e, phone: other.phone_number }, admin)).status === 400);
    const manual = await call('POST', '/api/attendance/manual', { e, phone: other.phone_number, reason: 'Signed the paper register' }, admin);
    check('...and is recorded as by hand', manual.body.success === true && manual.body.method === 'MANUAL');
    const logged = await db.get("SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'attendance' AND action IN ('ATTENDANCE_RECORDED', 'ATTENDANCE_REMOVED') AND new_value LIKE ?", [`%${other.phone_number}%`]);
    check('each is in the activity log', logged.n >= 2, logged.n);

    console.log('\n== The pages ==');
    const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
    const src = fs.readFileSync(appFile('server.js'), 'utf8');
    const view = fs.readFileSync(appFile('views', 'admin', 'sections', 'attendance.ejs'), 'utf8');
    const portal = fs.readFileSync(appFile('views', 'portal', 'sections', 'dashboard.ejs'), 'utf8');
    check('checking in at the desk on a conference day is that day\'s sign-in',
      /Checking in on a conference day is that day's sign-in\.[\s\S]{0,300}method: 'DESK'/.test(src));
    check('the admin tab: scan, the screen, counts and the roster', ['id="att-event"', 'onclick="openAttendanceScanner()"', 'id="att-screen-qr"', 'id="att-summary"', 'id="att-roster"'].every((x) => view.includes(x)));
    check('the screen asks for a fresh code every 20 seconds', /attState\.screenTimer = setInterval\(refresh, 20000\);/.test(js));
    check('the camera stays open, counting one desk pass once', /now - attState\.lastScan\.at < 4000/.test(js));
    check('the portal keeps the venue code until login, and takes it out of the address',
      /storageSet\('session', 'nqocn_attend', code\);\n\s*window\.history\.replaceState/.test(js) && /signInFromVenueCode\(\)\.then\(loadAttendanceCard\)/.test(js));
    check('the portal card: attendance, name and council number', ['id="attendance-list"', 'id="cert-name"', 'id="cert-council-no"'].every((x) => portal.includes(x)));
  } finally {
    await db.run('DELETE FROM attendance WHERE event_key = ?', [e]);
    await db.run('UPDATE program_options SET session_date = ?, start_time = ?, end_time = ? WHERE id = ?', [option.session_date, option.start_time, option.end_time, option.id]);
    for (const who of [enrolled, other]) {
      await db.run('DELETE FROM registration_options WHERE registration_id = ?', [who.id]);
      await db.run('DELETE FROM registrations WHERE id = ?', [who.id]);
    }
  }
  db.close();
  report();
})();
