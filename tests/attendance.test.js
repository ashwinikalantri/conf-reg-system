// Attendance, session by session.
//
//   * Which session a scan marks: the one on in that hall now (from a little
//     before it starts until it ends); a break takes no attendance.
//   * Completing the conference: on each conference day, present at a
//     session before lunch and one after (where the day has both).
//   * A delegate scans a hall's door QR; a volunteer picks the hall and
//     scans a badge. A workshop takes those enrolled; others only with a
//     reason. An attendance manager can mark or remove anyone, any time,
//     with a reason.
//   * The programme: halls (each with an unguessable code) and sessions,
//     edited by those who may; posters to print.
//   * The delegate sees the programme, what they were present at, and how
//     far they are towards the certificate.
const { call, check, report, ADMIN_PW, appFile, adminLogin, loginPassword, openDb } = require('./harness');
const fs = require('fs');
const A = require('../attendance');

const IST = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+05:30`);
const N = String(Date.now()).slice(-7);
const S = (id, date, start, end, extra = {}) => ({ id, session_date: date, start_time: start, end_time: end, title: `S${id}`, counts: 1, ...extra });

(async () => {
  console.log('\n== Which session a scan marks ==');
  const d = '2026-11-22';
  const hallA = [S(1, d, '09:30', '09:50'), S(2, d, '09:50', '10:10'), S(3, d, '10:30', '11:00', { counts: 0, title: 'Tea' }), S(4, d, '11:00', '11:20'), S(5, '2026-11-21', '09:00', '16:30')];
  const at = (t) => A.currentSession(hallA, IST(d, t));
  check('during a session: that one', at('09:40').session.id === 1);
  check('as one ends and the next begins: the next', at('09:50').session.id === 2);
  check('a little before a session (15 minutes): that one', at('09:20').session.id === 1);
  check('...but not earlier', at('09:10').session === null && at('09:10').next.id === 1);
  check('in the tea break: nothing, and the next is the one after tea', at('10:35').session === null && at('10:35').next.id === 4);
  check('...unless it is about to start', at('10:50').session.id === 4);
  check('the break itself never takes attendance', !A.sessionWindow(hallA[2], IST(d, '10:40')).open);
  check('another day\'s session is not on today', A.currentSession(hallA, IST('2026-11-21', '10:00')).session.id === 5);
  check('the minutes before can be set', A.currentSession(hallA, IST(d, '09:00'), 30).session.id === 1);
  check('a window says why it is shut', /opens for attendance at 9:15 AM/.test(A.sessionWindow(hallA[0], IST(d, '09:00')).reason)
    && /over/.test(A.sessionWindow(hallA[0], IST(d, '12:00')).reason));

  console.log('\n== Completing the conference ==');
  const conf = [S(10, d, '09:30', '09:50'), S(11, d, '11:00', '11:20'), S(12, d, '14:20', '14:40'), S(13, d, '16:30', '17:00')];
  const done = (...ids) => A.completion(conf.filter((s) => ids.includes(s.id)), conf, '13:00');
  check('a session before lunch and one after: complete', done(11, 13).complete === true);
  check('only mornings: not, and says what is missing', !done(10, 11).complete && done(10, 11).missing.join() === '22 Nov, after lunch');
  check('nothing: not', !done().complete && done().missing.length === 2);
  const twoDays = [...conf, S(20, '2026-11-23', '10:00', '11:00')];
  check('a second day with only a morning asks only for its morning',
    A.completion(twoDays.filter((s) => [10, 12, 20].includes(s.id)), twoDays, '13:00').complete
    && A.completion(twoDays, twoDays, '13:00').parts.length === 3);
  check('no conference sessions at all: not complete', !A.completion([], [], '13:00').complete);
  const isWs = (s) => s.workshop === 1;
  check('a workshop\'s sessions do not count for the conference', A.conferenceSessions([S(1, d, '09:00', '10:00', { workshop: 1 }), S(2, d, '10:00', '11:00'), S(3, d, '11:00', '12:00', { counts: 0 })], isWs).map((s) => s.id).join() === '2');

  console.log('\n== The programme ==');
  const admin = await adminLogin();
  const desk = await loginPassword('9000000006', ADMIN_PW);      // FRONT_DESK
  const reviewer = await loginPassword('9000000003', ADMIN_PW);  // ACADEMIC_REVIEWER
  const db = openDb();
  const today = A.istParts(Date.now()).date;
  const option = await db.get(`SELECT o.id, o.name, o.group_id FROM program_options o JOIN program_groups g ON g.id = o.group_id WHERE g.name = 'Workshops' AND o.active = 1 LIMIT 1`);
  const base = { salutation: 'Dr', age: '40', gender: 'Female', designation: 'Professor', institute: 'Test College', pincode: '442102', state: 'Maharashtra', district: 'Wardha' };
  const signUp = async (tag) => {
    const email = `att-${tag}-${N}@example.test`;
    const otp = await call('POST', '/api/otp/request', { destination: email });
    const r = await call('POST', '/api/auth/register', { ...base, name: `Attendee ${tag} ${N}`, country: 'United Kingdom', email, emailOtp: otp.body.devOtp, password: 'testpass123' });
    const phone = r.body.user.phone_number;
    const reg = await db.run(`INSERT INTO registrations (phone_number, delegate_name, category_key, category_label, bank_status, registration_number)
      VALUES (?, ?, 'chw', 'Frontline Health Worker', 'BANK_VERIFIED', ?)`, [phone, `Attendee ${tag} ${N}`, `AT${tag}${N}`]);
    return { phone, cookie: r.cookie, email, regId: reg.lastID, registration_number: `AT${tag}${N}` };
  };
  const made = { halls: [], sessions: [], people: [] };
  try {
    const hall = (await call('POST', '/api/admin/programme/halls', { name: `Test Hall ${N}` }, admin)).body;
    check('a hall is added', hall.success === true);
    made.halls.push(hall.id);
    const wsHall = (await call('POST', '/api/admin/programme/halls', { name: `Workshop Room ${N}` }, admin)).body;
    made.halls.push(wsHall.id);
    check('only the programme\'s editors may add one', (await call('POST', '/api/admin/programme/halls', { name: 'X' }, desk)).status === 403);
    const prog = (await call('GET', '/api/admin/programme', null, admin)).body;
    const h = prog.halls.find((x) => x.id === hall.id);
    check('each hall has its own unguessable code, and the address its QR carries', /^[A-Z2-9]{8}$/.test(h.code) && h.url.endsWith(`/?hall=${h.code}`));
    const post = (b) => call('POST', '/api/admin/programme/sessions', b, admin);
    check('a session needs a hall, a date, times in order and a title',
      (await post({ hallId: hall.id, date: today, start: '10:00', end: '09:00', title: 'x' })).status === 400
      && (await post({ hallId: hall.id, date: today, start: '09:00', end: '10:00', title: '' })).status === 400
      && (await post({ hallId: 999999, date: today, start: '09:00', end: '10:00', title: 'x' })).status === 400);
    const all = await post({ hallId: hall.id, date: today, start: '00:00', end: '23:59', label: 'Session 1', title: `All Day Talk ${N}`, speakers: 'Dr Speaker', chairs: 'Dr Chair', counts: true });
    check('a session is added', all.body.success === true, all.body);
    made.sessions.push(all.body.id);
    const ws = await post({ hallId: wsHall.id, date: today, start: '00:00', end: '23:59', title: `Workshop ${N}`, counts: true, optionId: option.id });
    made.sessions.push(ws.body.id);
    const breakS = await post({ hallId: hall.id, date: '2099-01-01', start: '10:00', end: '10:30', title: 'Tea', counts: false });
    made.sessions.push(breakS.body.id);
    const listed = (await call('GET', '/api/admin/programme', null, admin)).body.sessions;
    check('...listed, a workshop\'s marked as one', listed.find((s) => s.id === ws.body.id).workshop === true && listed.find((s) => s.id === all.body.id).workshop === false);
    const edited = await call('PUT', `/api/admin/programme/sessions/${all.body.id}`, { chairs: 'Dr New Chair' }, admin);
    check('a session is edited, field by field', edited.body.success && (await db.get('SELECT chairs, title FROM programme_sessions WHERE id = ?', [all.body.id])).chairs === 'Dr New Chair');
    const poster = await call('GET', `/api/admin/programme/posters.pdf?hall=${hall.id}`, null, admin);
    check('a hall\'s poster is a PDF', poster.status === 200 && /application\/pdf/.test(poster.headers['content-type']));

    console.log('\n== At the door ==');
    const inP = await signUp('in');
    const outP = await signUp('out');
    made.people.push(inP, outP);
    await db.run('INSERT INTO registration_options (registration_id, group_id, option_id, is_faculty) VALUES (?, ?, ?, 0)', [inP.regId, option.group_id, option.id]);
    const halls = (await call('GET', '/api/attendance/halls', null, desk)).body.halls;
    check('the desk sees each hall and what is on there now', halls.find((x) => x.id === hall.id).now.id === all.body.id);
    const scan = (b, who = desk) => call('POST', '/api/attendance/scan', b, who);
    const first = await scan({ hallId: hall.id, identifier: inP.registration_number });
    check('a badge scanned: present at the session on there', first.body.success && first.body.session.id === all.body.id && first.body.already === false, first.body);
    const again = await scan({ hallId: hall.id, identifier: inP.registration_number });
    check('...a second scan says they already are', again.body.already === true && again.body.at === first.body.at);
    check('nobody found: said', (await scan({ hallId: hall.id, identifier: 'NO-SUCH-PERSON' })).status === 404);
    const notEnrolled = await scan({ hallId: wsHall.id, identifier: outP.registration_number });
    check('a workshop: someone not enrolled is refused, and asked about', notEnrolled.status === 409 && notEnrolled.body.notEnrolled === true);
    const letIn = await scan({ hallId: wsHall.id, identifier: outP.registration_number, notEnrolledReason: 'Swapped with a colleague' });
    check('...let in with a reason, which is kept', letIn.body.success === true
      && /Not enrolled: Swapped/.test((await db.get('SELECT note FROM attendance WHERE phone_number = ? AND event_key = ?', [outP.phone, `s:${ws.body.id}`])).note));
    const empty = (await call('POST', '/api/admin/programme/halls', { name: `Empty Hall ${N}` }, admin)).body;
    made.halls.push(empty.id);
    check('a hall with nothing on: says so', /No session is on/.test((await scan({ hallId: empty.id, identifier: inP.registration_number })).body.error || ''));
    check('an academic reviewer cannot take attendance', (await scan({ hallId: hall.id, identifier: inP.registration_number }, reviewer)).status === 403);

    console.log('\n== Scanning the hall\'s QR ==');
    await db.run('DELETE FROM attendance WHERE phone_number = ? AND event_key = ?', [inP.phone, `s:${all.body.id}`]);
    const self = (code, who = inP.cookie) => call('POST', '/api/attendance/hall', { code }, who);
    const ok = await self(h.code);
    check('a delegate scanning a hall\'s QR is marked present at the session on there', ok.body.success && ok.body.session.id === all.body.id && ok.body.hall === `Test Hall ${N}`
      && (await db.get('SELECT method FROM attendance WHERE phone_number = ? AND event_key = ? AND removed_at IS NULL', [inP.phone, `s:${all.body.id}`])).method === 'SELF', ok.body);
    check('a code that is not a hall\'s: refused', (await self('ZZZZZZZZ')).status === 404);
    const wsCode = prog.halls.find((x) => x.id === wsHall.id).code;
    const other = await signUp('other');
    made.people.push(other);
    check('a workshop they are not enrolled in: refused, sent to the volunteer', /not enrolled/.test((await self(wsCode, other.cookie)).body.error || ''));
    check('nobody signed out can', (await call('POST', '/api/attendance/hall', { code: h.code })).status === 401);
    const newCode = await call('PUT', `/api/admin/programme/halls/${hall.id}`, { newCode: true }, admin);
    check('a hall can be given a new code; the old one stops working', newCode.body.success && (await self(h.code)).status === 404);

    console.log('\n== Their own record ==');
    const me = (await call('GET', '/api/attendance/me', null, inP.cookie)).body;
    check('the sessions they were present at', me.attended.some((s) => s.id === all.body.id && s.at));
    check('how far towards the certificate, part by part', Array.isArray(me.completion.parts) && me.completion.parts.length >= 1);
    check('...and their workshop', me.workshops.some((w) => w.optionId === option.id && w.present === false));
    const conf = (await call('GET', '/api/conference')).body;
    const dayBefore = new Date(`${conf.startDate}T00:00:00Z`);
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
    check('attendance is shown to delegates from the day before the conference, not yet', me.showAttendance === false && me.showAttendanceFrom === dayBefore.toISOString().slice(0, 10), [me.showAttendance, me.showAttendanceFrom]);
    check('...a date that can be set', (await call('PUT', '/api/admin/certificates/settings', { attendance: { showFrom: 'soon' } }, admin)).status === 400);
    await call('PUT', '/api/admin/certificates/settings', { attendance: { showFrom: today } }, admin);
    check('...and from that day, it is', (await call('GET', '/api/attendance/me', null, inP.cookie)).body.showAttendance === true);
    await call('PUT', '/api/admin/certificates/settings', { attendance: { showFrom: '' } }, admin);
    const pg = (await call('GET', '/api/programme', null, inP.cookie)).body;
    check('the programme, with what they were present at', pg.sessions.some((s) => s.id === all.body.id && s.speakers === 'Dr Speaker') && pg.mine.includes(all.body.id) && !!pg.now.date);
    check('...open to delegates, not to anyone signed out', (await call('GET', '/api/programme')).status === 401);
    const save = (b) => call('PUT', '/api/attendance/me/certificate', b, inP.cookie);
    check('a name too short is refused', (await save({ certificateName: 'Al' })).status === 400);
    check('a number without its council is refused', (await save({ certificateName: '', councilRegNo: '2012/03/1234' })).status === 400);
    const saved = await save({ certificateName: `Dr Certificate Name ${N}`, councilName: 'Maharashtra Medical Council', councilRegNo: ' 2012/03/1234 ' });
    const u = await db.get('SELECT certificate_name, council_reg_no FROM users WHERE phone_number = ?', [inP.phone]);
    check('their certificate details are saved, the number tidied', saved.body.success && u.certificate_name === `Dr Certificate Name ${N}` && u.council_reg_no === '2012/03/1234');
    await db.run("UPDATE registrations SET category_key = 'faculty_mo' WHERE id = ?", [inP.regId]);
    check('a doctor is asked for the council number; others are not', (await call('GET', '/api/attendance/me', null, inP.cookie)).body.certificate.asksCouncilNumber === true
      && (await call('GET', '/api/attendance/me', null, outP.cookie)).body.certificate.asksCouncilNumber === false);

    console.log('\n== Counts, roster and corrections ==');
    const sum = (await call('GET', '/api/attendance/summary', null, desk)).body;
    check('each session that takes attendance, with how many are present', sum.sessions.find((s) => s.id === all.body.id).present === 1 && !sum.sessions.some((s) => s.id === breakS.body.id));
    check('...a workshop\'s, of how many enrolled', sum.sessions.find((s) => s.id === ws.body.id).enrolled >= 1);
    const roster = (await call('GET', `/api/attendance/roster?session=${ws.body.id}`, null, desk)).body.people;
    check('a workshop\'s roster: who enrolled is not present, who came without enrolling', roster.some((p) => p.phone === inP.phone && !p.attendance && p.expected)
      && roster.some((p) => p.phone === outP.phone && p.attendance && !p.expected));
    check('the desk cannot correct attendance', (await call('POST', '/api/attendance/manual', { sessionId: ws.body.id, phone: inP.phone, reason: 'x' }, desk)).status === 403);
    check('marking by hand needs a reason', (await call('POST', '/api/attendance/manual', { sessionId: ws.body.id, phone: inP.phone }, admin)).status === 400);
    const manual = await call('POST', '/api/attendance/manual', { sessionId: ws.body.id, identifier: inP.email, reason: 'Paper register' }, admin);
    check('...by ID, mobile or email, at any time', manual.body.success === true && manual.body.method === 'MANUAL', manual.body);
    const row = await db.get('SELECT id FROM attendance WHERE phone_number = ? AND event_key = ? AND removed_at IS NULL', [outP.phone, `s:${ws.body.id}`]);
    check('removing one needs a reason', (await call('DELETE', `/api/attendance/${row.id}`, {}, admin)).status === 400);
    await call('DELETE', `/api/attendance/${row.id}`, { reason: 'Scanned by mistake' }, admin);
    check('...and keeps the row, marked', !!(await db.get('SELECT removed_at FROM attendance WHERE id = ?', [row.id])).removed_at);
    check('a session people were present at cannot be deleted', (await call('DELETE', `/api/admin/programme/sessions/${all.body.id}`, null, admin)).status === 409);
    check('...one nobody was at can', (await call('DELETE', `/api/admin/programme/sessions/${breakS.body.id}`, null, admin)).body.success === true);
    made.sessions = made.sessions.filter((x) => x !== breakS.body.id);

    console.log('\n== The pages ==');
    const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
    const view = fs.readFileSync(appFile('views', 'admin', 'sections', 'attendance.ejs'), 'utf8');
    const portal = fs.readFileSync(appFile('views', 'portal', 'sections', 'dashboard.ejs'), 'utf8');
    check('the admin tab: a hall, what is on, scan; counts; who was present', ['id="att-hall"', 'id="att-now"', 'onclick="openAttendanceScanner()"', 'id="att-summary"', 'id="att-roster"'].every((x) => view.includes(x)));
    const programmePage = fs.readFileSync(appFile('views', 'admin', 'sections', 'programme.ejs'), 'utf8');
    check('the programme is its own Settings page, not a view of Attendance',
      ['id="section-programme"', 'id="prog-halls"', 'id="prog-sessions"', 'posters.pdf'].every((x) => programmePage.includes(x))
      && !view.includes('id="prog-sessions"'));
    check('the camera stays open, counting one badge once', /now - attState\.lastScan\.at < 4000/.test(js));
    check('the portal keeps a hall code until login, and takes it out of the address',
      /storageSet\('session', 'nqocn_hall', code\);\n\s*window\.history\.replaceState/.test(js) && /markFromHallCode\(\)\.then/.test(js));
    check('the portal: the programme, and the attendance card', ['id="programme-card"', 'id="attendance-list"', 'id="cert-name"'].every((x) => portal.includes(x)));
  } finally {
    for (const p of made.people) {
      await db.run('DELETE FROM attendance WHERE phone_number = ?', [p.phone]);
      await db.run('DELETE FROM registration_options WHERE registration_id = ?', [p.regId]);
      await db.run('DELETE FROM registrations WHERE id = ?', [p.regId]);
    }
    for (const id of made.sessions) await db.run('DELETE FROM programme_sessions WHERE id = ?', [id]);
    for (const id of made.halls) await db.run('DELETE FROM halls WHERE id = ?', [id]);
  }
  db.close();
  report();
})();
