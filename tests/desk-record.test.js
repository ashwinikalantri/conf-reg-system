// The Front Desk record, redesigned (18 Nov 2026): the next step and four
// checks across the top; the conference days (present before and after
// lunch, meals served, what the certificate still needs); each workshop
// with whether they were present and gave feedback; a presenter's file;
// and Mark present, the door volunteer's own scan, from the desk. The
// presentation format is shown there but never changed (owner).
const fs = require('fs');
const { call, adminLogin, loginPassword, ADMIN_PW, appFile, check, report, openDb } = require('./harness');

const DESK = '9000000006';         // Dez Counter, FRONT_DESK
const PERSON = '9000001001';       // One Payment, registered and paid

const IST = 5.5 * 3600e3;
const hhmm = (ms) => new Date(ms + IST).toISOString().slice(11, 16);

(async () => {
  const db = openDb();
  const admin = await adminLogin();
  const desk = await loginPassword(DESK, ADMIN_PW);
  let hallId = null;
  let sessionId = null;
  let checkedBefore = null;
  try {
    console.log('\n== What the desk is told ==');
    const before = (await call('GET', `/api/desk/delegate/${PERSON}`, null, desk)).body;
    check('the record is found', before.success && before.user && before.registration, before.error);
    const cd = before.conferenceDays;
    check('it carries the conference days, the certificate and the workshops',
      cd && Array.isArray(cd.days) && Array.isArray(cd.missing) && Array.isArray(cd.workshops) && 'certificate' in cd, cd);
    check('...and the presentation last date', before.presentationDue && 'dueText' in before.presentationDue && 'open' in before.presentationDue);
    check('each abstract says whether its file has come', (before.abstracts || []).every((a) => 'file_uploaded_at' in a && 'decision_sent_at' in a));

    console.log('\n== Marking them present from the desk ==');
    const now = Date.now();
    const today = new Date(now + IST).toISOString().slice(0, 10);
    const start = Math.max(new Date(`${today}T00:00:00+05:30`).getTime(), now - 30 * 60e3);
    const end = Math.min(new Date(`${today}T23:59:00+05:30`).getTime(), now + 30 * 60e3);
    hallId = (await call('POST', '/api/admin/programme/halls', { name: `Desk test hall ${now}` }, admin)).body.id;
    sessionId = (await call('POST', '/api/admin/programme/sessions',
      { hallId, date: today, start: hhmm(start), end: hhmm(end), title: 'Desk test session', counts: true }, admin)).body.id;
    check('a session taking attendance now', !!hallId && !!sessionId);
    const halls = (await call('GET', '/api/attendance/halls', null, desk)).body.halls || [];
    check('the desk sees it on now, to pick', halls.some((h) => h.id === hallId && h.now && h.now.id === sessionId));
    // Checked in at the desk first (owner, 20 Nov 2026); put back after.
    checkedBefore = await db.get('SELECT id, checked_in_at, checked_in_by FROM registrations WHERE phone_number = ?', [PERSON]);
    if (checkedBefore) await db.run('UPDATE registrations SET checked_in_at = COALESCE(checked_in_at, ?), checked_in_by = COALESCE(checked_in_by, ?) WHERE id = ?', [Date.now(), 'Test desk', checkedBefore.id]);
    const marked = await call('POST', '/api/attendance/scan', { hallId, identifier: PERSON }, desk);
    check('the desk marks them present there', marked.status === 200 && marked.body.success && marked.body.session.id === sessionId, marked.body);
    const again = await call('POST', '/api/attendance/scan', { hallId, identifier: PERSON }, desk);
    check('...and a second time only says so', again.body.success && again.body.already === true, again.body);
    const after = (await call('GET', `/api/desk/delegate/${PERSON}`, null, desk)).body.conferenceDays;
    const day = after.days.find((x) => x.date === today);
    const part = day && day.parts.find((p) => p.done && p.session === 'Desk test session');
    check('the record now shows it, with the time and hall', part && part.at && /^Desk test hall/.test(part.hall), day);

    console.log('\n== The screen ==');
    const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
    check('one next step, with its buttons, under the name', /function deskNextStep\(d\)/.test(js) && /const step = deskNextStep\(d\);/.test(js));
    check('Mark present goes through the door scan', /async function deskMarkPresent\(hallId, reason\)[\s\S]*?fetch\('\/api\/attendance\/scan'/.test(js));
    check('...offered to a role that may mark attendance', /can\('attendance\.mark'\) \? deskBtn\('Mark present', 'deskOpenMarkPresent\(\)'/.test(js));
    check('Recent lookups live in this tab only, and go on sign-out',
      /storageSet\('session', DESK_RECENT_KEY/.test(js) && /storageRemove\('session', 'nqocn_desk_recent'\)/.test(js));
    check('the desk never changes a presentation format', !/deskAllotAbstract|abstracts\/\$\{encodeURIComponent\(id\)\}\/allocation[\s\S]{0,40}deskReload/.test(js));
  } finally {
    if (sessionId) {
      await db.run('DELETE FROM attendance WHERE event_key = ?', [`s:${sessionId}`]);
      await db.run('DELETE FROM programme_sessions WHERE id = ?', [sessionId]);
    }
    if (hallId) await db.run('DELETE FROM halls WHERE id = ?', [hallId]);
    if (checkedBefore) await db.run('UPDATE registrations SET checked_in_at = ?, checked_in_by = ? WHERE id = ?', [checkedBefore.checked_in_at, checkedBefore.checked_in_by, checkedBefore.id]);
    db.close();
  }
  report();
})();
