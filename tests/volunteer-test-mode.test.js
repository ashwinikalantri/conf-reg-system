// Volunteer test mode (owner, 20 Nov 2026): while it is on, everything a
// volunteer changes is recorded and undone when it ends; staff changes
// stay -- even a field staff changed on a row a volunteer touched.
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const V = require('../volunteer-test');
const { call, check, report, adminLogin, loginOtp, loginPassword, ADMIN_PW, openDb, appFile, dataDir } = require('./harness');

const h = (db) => ({
  all: (s, p = []) => new Promise((r, j) => db.all(s, p, (e, x) => (e ? j(e) : r(x)))),
  get: (s, p = []) => new Promise((r, j) => db.get(s, p, (e, x) => (e ? j(e) : r(x)))),
  run: (s, p = []) => new Promise((r, j) => db.run(s, p, function (e) { e ? j(e) : r(this); })),
});
const open = (f) => new Promise((r, j) => { const d = new sqlite3.Database(f, (e) => (e ? j(e) : r(d))); });

(async () => {
  console.log('\n== Recording and undoing ==');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vt-')), 't.db');
  const A = await open(file); const a = h(A);
  await a.run('CREATE TABLE r (id INTEGER PRIMARY KEY, name TEXT UNIQUE, checked INTEGER, note TEXT, pic BLOB)');
  await a.run("INSERT INTO r (name, checked, note, pic) VALUES ('x', 0, 'n', NULL), ('y', 0, 'n', x'00ff'), ('z', 0, 'z', NULL)");
  await a.run('CREATE TABLE sessions (token_hash TEXT PRIMARY KEY)');
  const B = await open(file); B.configure('busyTimeout', 5000); const b = h(B);
  check('the recording connection is armed on every table but sessions', (await V.arm(b)) === 1);
  await b.run("UPDATE r SET checked = 1, note = 'volunteer' WHERE name = 'x'");
  await b.run("INSERT INTO r (name, checked, pic) VALUES ('new', 1, x'0102')");
  await b.run("DELETE FROM r WHERE name = 'z'");
  await b.run("INSERT OR REPLACE INTO r (id, name, checked) VALUES (2, 'y', 5)");
  await b.run("INSERT INTO sessions VALUES ('s')");
  await a.run("UPDATE r SET note = 'staff' WHERE name = 'x'");
  await a.run("INSERT INTO r (name) VALUES ('staffrow')");
  const sum = await V.summary(b);
  check('only the recording connection\'s changes are recorded, sessions aside', sum.changes === 5 && sum.tables.length === 1, sum);
  B.close();
  const u = await V.undoAll(a);
  const rows = await a.all('SELECT name, checked, note, hex(pic) AS pic FROM r ORDER BY id');
  check('undone, last first: the update, the insert, the delete, the replace', JSON.stringify(rows.map((r) => [r.name, r.checked, r.note, r.pic]))
    === JSON.stringify([['x', 0, 'staff', ''], ['y', 0, 'n', '00FF'], ['z', 0, 'z', ''], ['staffrow', null, null, '']]), rows);
  check('...a field staff changed since keeps their value, and is counted as kept', u.kept === 1 && u.undone === 4, u);
  A.close();
  check('a volunteer is someone with volunteer roles only', V.isVolunteerOnly(['DELEGATE', 'VOLUNTEER_MEALS'], new Set(['VOLUNTEER_MEALS']))
    && V.isVolunteerOnly(['VOLUNTEER_MEALS'], new Set(['VOLUNTEER_MEALS'])) && !V.isVolunteerOnly(['FRONT_DESK', 'VOLUNTEER_MEALS'], new Set(['VOLUNTEER_MEALS']))
    && !V.isVolunteerOnly(['DELEGATE'], new Set(['VOLUNTEER_MEALS'])));

  console.log('\n== On the server ==');
  const src = fs.readFileSync(appFile('server.js'), 'utf8');
  check('a volunteer\'s email in test mode is not sent', /if \(\(requestContext\.getStore\(\) \|\| \{\}\)\.volunteerTest\) \{\n\s*console\.log\(`Volunteer test mode: email/.test(src));
  const db = openDb();
  const admin = await adminLogin();
  const desk = await loginPassword('9000000006', ADMIN_PW);
  const N = String(Date.now()).slice(-6);
  const vPhone = `97${N}11`;
  const targets = await db.all('SELECT id, phone_number, registration_number, checked_in_at, checked_in_by, kit_given_at, kit_given_by FROM registrations WHERE checked_in_at IS NULL AND registration_number IS NOT NULL LIMIT 2');
  let snapshot = null;
  const made = {};
  try {
    await db.run("INSERT INTO users (phone_number, full_name, role, created_at, phone_verified) VALUES (?, ?, 'DELEGATE', ?, 1)", [vPhone, `Volunteer ${N}`, Date.now()]);
    await db.run("INSERT INTO user_roles (phone_number, role_key) VALUES (?, 'VOLUNTEER_REGISTRATION')", [vPhone]);
    const vol = await loginOtp(vPhone);
    check('a volunteer signs in', !!vol && targets.length === 2);
    check('only someone who may change settings starts it', (await call('POST', '/api/admin/volunteer-test/start', {}, desk)).status === 403
      && (await call('POST', '/api/admin/volunteer-test/start', {}, vol)).status === 403);
    const st = await call('POST', '/api/admin/volunteer-test/start', {}, admin);
    check('started', st.body.success && st.body.on === true, st.body);
    check('the volunteer is told they are practising; staff that theirs are kept', (await call('GET', '/api/auth/me', null, vol)).body.volunteerTest.practice === true
      && (await call('GET', '/api/auth/me', null, admin)).body.volunteerTest.practice === false);
    // A hall whose only session was long ago: nothing to mark there, but in test mode there is.
    made.hall = (await db.run('INSERT INTO halls (name, code, sort_order, active, created_at) VALUES (?, ?, 99, 1, ?)', [`Test Hall ${N}`, `TH${N}`, Date.now()])).lastID;
    made.session = (await db.run("INSERT INTO programme_sessions (hall_id, session_date, start_time, end_time, title, counts, created_at) VALUES (?, '2020-01-02', '09:00', '10:00', ?, 1, ?)", [made.hall, `Old Session ${N}`, Date.now()])).lastID;
    const hall = (await call('GET', '/api/attendance/halls', null, vol)).body.halls.find((h) => h.id === made.hall);
    check('in test mode a volunteer marks attendance at any time: a session long past is still there to mark', !!hall && !!hall.now && hall.now.id === made.session, hall);
    const [t1, t2] = targets;
    const vc = await call('POST', '/api/desk/checkin', { identifier: t1.registration_number, kit: true }, vol);
    check('the volunteer checks someone in, with the kit', vc.body.success && !!(await db.get('SELECT checked_in_at FROM registrations WHERE id = ?', [t1.id])).checked_in_at, vc.body);
    const sc = await call('POST', '/api/desk/checkin', { identifier: t2.registration_number }, admin);
    check('staff check someone else in', sc.body.success);
    // Staff then correct who gave the volunteer's kit: a later staff change on the same row.
    await db.run("UPDATE registrations SET kit_given_by = 'Staff Person' WHERE id = ?", [t1.id]);
    const view = (await call('GET', '/api/admin/volunteer-test', null, admin)).body;
    check('the record: the volunteer\'s check-in and its log lines, not the staff ones', view.changes >= 2 && view.tables.some((t) => t.table === 'registrations')
      && view.tables.some((t) => t.label === 'Activity log entries'), view);
    const end = await call('POST', '/api/admin/volunteer-test/end', {}, admin);
    snapshot = end.body.snapshot;
    check('ended: undone, a copy saved first', end.body.success && end.body.undone >= 2 && /^pre-volunteer-test-undo-\d{14}\.db$/.test(end.body.snapshot)
      && fs.existsSync(path.join(dataDir(), end.body.snapshot)), end.body);
    const r1 = await db.get('SELECT checked_in_at, kit_given_at, kit_given_by FROM registrations WHERE id = ?', [t1.id]);
    check('the volunteer\'s check-in and kit are gone', r1.checked_in_at === null && r1.kit_given_at === null, r1);
    check('...the field staff changed since is kept', r1.kit_given_by === 'Staff Person');
    check('staff\'s check-in is kept', !!(await db.get('SELECT checked_in_at FROM registrations WHERE id = ?', [t2.id])).checked_in_at);
    check('the volunteer\'s log lines are gone; the end is logged', !(await db.get("SELECT 1 FROM audit_log WHERE action = 'DESK_CHECKIN' AND entity_id = ? AND actor_phone = ?", [String(t1.id), vPhone]))
      && !!(await db.get("SELECT 1 FROM audit_log WHERE action = 'VOLUNTEER_TEST_ENDED'")));
    check('nothing left in the record; test mode off for everyone', (await db.get(`SELECT COUNT(*) AS n FROM ${V.JOURNAL}`)).n === 0
      && (await call('GET', '/api/auth/me', null, vol)).body.volunteerTest === null);
    await call('POST', '/api/desk/checkin', { identifier: t1.registration_number }, vol);
    check('after it, a volunteer\'s change is real', !!(await db.get('SELECT checked_in_at FROM registrations WHERE id = ?', [t1.id])).checked_in_at
      && (await db.get(`SELECT COUNT(*) AS n FROM ${V.JOURNAL}`)).n === 0);
    check('ending again: not on', (await call('POST', '/api/admin/volunteer-test/end', {}, admin)).status === 400);
  } finally {
    await call('POST', '/api/admin/volunteer-test/end', {}, admin).catch(() => {});
    for (const t of targets) {
      await db.run('UPDATE registrations SET checked_in_at = ?, checked_in_by = ?, kit_given_at = ?, kit_given_by = ? WHERE id = ?',
        [t.checked_in_at, t.checked_in_by, t.kit_given_at, t.kit_given_by, t.id]);
    }
    await db.run('DELETE FROM user_roles WHERE phone_number = ?', [vPhone]);
    await db.run('DELETE FROM users WHERE phone_number = ?', [vPhone]);
    if (made.session) await db.run('DELETE FROM programme_sessions WHERE id = ?', [made.session]);
    if (made.hall) await db.run('DELETE FROM halls WHERE id = ?', [made.hall]);
    if (snapshot) fs.rmSync(path.join(dataDir(), snapshot), { force: true });
    db.close();
  }
  report();
})();
