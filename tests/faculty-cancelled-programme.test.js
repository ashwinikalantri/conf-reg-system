// Cancelled faculty leave the programme (6 Nov 2026): their names drop out of
// the speakers and chairs lines everyone reads -- the portal, the website,
// the posters -- while the Programme editor still lists them, marked, so
// staff can see and remove them. And a typed-in faculty member has an
// Institution of their own (shown until they are linked to an account).
const fs = require('fs');
const { call, adminLogin, loginOtp, check, report, openDb, appFile } = require('./harness');

(async () => {
  const admin = await adminLogin();
  const db = await openDb();
  const N = Date.now() % 100000;
  const made = { guests: [], halls: [], sessions: [] };
  try {
    const add = async (name, extra = {}) => {
      const cols = { guest_name: name, created_at: Date.now(), ...extra };
      const r = await db.run(`INSERT INTO guests (${Object.keys(cols).join(', ')}) VALUES (${Object.keys(cols).map(() => '?').join(', ')})`, Object.values(cols));
      made.guests.push(r.lastID);
      return r.lastID;
    };
    const stays = await add(`Dr Stays ${N}`, { guest_designation: 'Professor', guest_institution: `Stay Institute ${N}` });
    const goes = await add(`Dr Goes ${N}`, { overall_status: 'Cancelled' });
    const hall = (await call('POST', '/api/admin/programme/halls', { name: `Cancel Hall ${N}` }, admin)).body;
    made.halls.push(hall.id);
    const day = (await call('GET', '/api/conference', null, null)).body.startDate;
    const ses = (await call('POST', '/api/admin/programme/sessions', { hallId: hall.id, date: day, start: '09:00', end: '10:00', title: `Cancel talk ${N}` }, admin)).body;
    made.sessions.push(ses.id);
    for (const [role, pos, gid] of [['speaker', 0, stays], ['speaker', 1, goes], ['chair', 0, goes]]) {
      await db.run('INSERT INTO programme_session_faculty (session_id, role, position, guest_id, name) VALUES (?, ?, ?, ?, NULL)', [ses.id, role, pos, gid]);
    }

    const me = await loginOtp('9000001001');
    const pub = (await call('GET', '/api/programme', null, me)).body.sessions.find((s) => s.id === ses.id);
    check('the programme names those still on the list', pub && pub.speakers === `Dr Stays ${N}`, pub);
    check('...and drops a cancelled speaker and chair', pub && !pub.speakers.includes(`Dr Goes ${N}`) && !pub.chairs, pub);
    const site = (await call('GET', `/website/programme?day=${day}`, null, null)).raw || '';
    check('...the website too', site.includes(`Dr Stays ${N}`) && !site.includes(`Dr Goes ${N}`));
    const ed = (await call('GET', '/api/admin/programme', null, admin)).body.sessions.find((s) => s.id === ses.id);
    const edGoes = ed && ed.people.speakers.find((p) => p.guestId === goes);
    check('the editor still lists them, marked cancelled, to remove', edGoes && edGoes.cancelled === true && ed.people.chairs[0].cancelled === true);
    const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
    check('...shown struck through as cancelled', /Cancelled on the faculty list: not shown in the programme/.test(js));

    const fac = (await call('GET', '/api/admin/reports/faculty?format=json', null, admin)).body.report.sections[0];
    const frow = fac.rows.find((r) => r[0] === `Dr Stays ${N}`);
    check('a typed-in faculty member\'s Institution shows on the Faculty report', frow && frow[fac.columns.indexOf('Institution')] === `Stay Institute ${N}`, frow);
    const put = await call('PUT', `/api/guests/${stays}`, { fields: { guest_institution: `Renamed Institute ${N}` } }, admin);
    check('...and can be edited on the faculty record', put.body.success === true
      && (await db.get('SELECT guest_institution FROM guests WHERE id = ?', [stays])).guest_institution === `Renamed Institute ${N}`, put.body);
  } finally {
    for (const id of made.sessions) { await db.run('DELETE FROM programme_session_faculty WHERE session_id = ?', [id]); await db.run('DELETE FROM programme_sessions WHERE id = ?', [id]); }
    for (const id of made.halls) await db.run('DELETE FROM halls WHERE id = ?', [id]);
    for (const id of made.guests) await db.run('DELETE FROM guests WHERE id = ?', [id]);
    db.close();
  }
  report();
})();
