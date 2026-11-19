// The delegate kit (owner, 19 Nov 2026): checking in asks whether the kit
// was given; if not, the desk records it later. Either way it is who and
// when, like the check-in itself, and a kit marked by mistake can be taken
// off the record.
const fs = require('fs');
const { call, check, report, ADMIN_PW, adminLogin, loginPassword, openDb, appFile } = require('./harness');

const DESK = '9000000006';         // Dez Counter, FRONT_DESK
const REVIEWER = '9000000003';     // Rae Reviewer -- holds no desk permission

(async () => {
  const admin = await adminLogin();
  const desk = await loginPassword(DESK, ADMIN_PW);
  const reviewer = await loginPassword(REVIEWER, ADMIN_PW);
  const db = openDb();
  // Two registered delegates, put back as they were at the end.
  const people = await db.all(`SELECT r.phone_number, r.checked_in_at, r.checked_in_by, r.kit_given_at, r.kit_given_by FROM registrations r
    WHERE r.phone_number IN ('9000001002', '9000001004') ORDER BY r.phone_number`);
  const [A, B] = people.map((p) => p.phone_number);
  try {
    check('two registered delegates to try it on', people.length === 2, people.length);
    await db.run(`UPDATE registrations SET checked_in_at = NULL, checked_in_by = NULL, kit_given_at = NULL, kit_given_by = NULL WHERE phone_number IN (?, ?)`, [A, B]);

    console.log('\n== Checked in with the kit ==');
    const withKit = (await call('POST', '/api/desk/checkin', { identifier: A, kit: true }, desk)).body;
    check('checking in, kit given: both recorded', withKit.success && withKit.kit === true, withKit);
    const recA = (await call('GET', `/api/desk/delegate/${A}`, null, desk)).body;
    check('...the record says who and when', recA.kit && recA.kit.by === 'Dez Counter' && Math.abs(recA.kit.at - Date.now()) < 60000, recA.kit);

    console.log('\n== Checked in without it, given later ==');
    const noKit = (await call('POST', '/api/desk/checkin', { identifier: B, kit: false }, desk)).body;
    check('checking in, kit not given: checked in, no kit', noKit.success && !noKit.kit
      && (await call('GET', `/api/desk/delegate/${B}`, null, desk)).body.kit === null);
    check('a role without desk.checkin cannot record a kit', (await call('POST', '/api/desk/kit', { identifier: B, given: true }, reviewer)).status === 403);
    const later = (await call('POST', '/api/desk/kit', { identifier: B, given: true }, admin)).body;
    check('the kit recorded later, by whoever gave it', later.success && typeof later.at === 'number'
      && (await call('GET', `/api/desk/delegate/${B}`, null, desk)).body.kit.at === later.at, later);
    const twice = (await call('POST', '/api/desk/kit', { identifier: B, given: true }, desk)).body;
    check('...a second time does not rewrite who or when', twice.already === true && twice.at === later.at);
    check('...and nor does checking in again with the kit', (await call('POST', '/api/desk/checkin', { identifier: B, kit: true }, desk)).body.kit === false
      && (await db.get('SELECT kit_given_at FROM registrations WHERE phone_number = ?', [B])).kit_given_at === later.at);

    const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
    console.log('\n== A mistake undone; not before check-in ==');
    const undo = (await call('POST', '/api/desk/kit', { identifier: B, given: false }, desk)).body;
    check('a kit marked by mistake comes off the record, and the log keeps it', undo.success
      && (await db.get('SELECT kit_given_at FROM registrations WHERE phone_number = ?', [B])).kit_given_at === null
      && !!(await db.get("SELECT 1 FROM audit_log WHERE action = 'DESK_KIT_UNDONE' AND entity_id = (SELECT CAST(id AS TEXT) FROM registrations WHERE phone_number = ?)", [B])));
    await db.run('UPDATE registrations SET checked_in_at = NULL, checked_in_by = NULL WHERE phone_number = ?', [B]);
    const early = await call('POST', '/api/desk/kit', { identifier: B, given: true }, desk);
    check('no kit before check-in (owner: only once check-in is done)', early.status === 409 && /Check them in first/.test(early.body.error || '')
      && (await db.get('SELECT kit_given_at FROM registrations WHERE phone_number = ?', [B])).kit_given_at === null);
    const src = fs.readFileSync(appFile('server.js'), 'utf8');
    check('checking in with the kit saves the check-in first, then the kit',
      /action: 'DESK_CHECKIN', oldValue: null, newValue: new Date\(now\)\.toISOString\(\),\n\s*\}\);\n\s*if \(kit\) await giveKit/.test(src));
    check('the desk offers Kit given only to someone checked in', /checkedIn && !kit && can\('desk\.checkin'\) \? big\('Kit given'/.test(js) && /if \(checkedIn && !kit\) \{/.test(js));

    console.log('\n== The screens ==');
    check('Check in asks first: "Was the delegate kit given?" Yes, or not yet', /function deskAskKit\(\)/.test(js) && /Was the delegate kit given\?/.test(js)
      && /deskCheckIn\(true\)[\s\S]{0,200}Yes, kit given/.test(js) && /deskCheckIn\(false\)[\s\S]{0,200}Not yet, check in only/.test(js)
      && /big\('Check in', 'deskAskKit\(\)', 'go'\)/.test(js));
    check('arrived without the kit: the next step is Kit given', /Kit not given yet\.`[\s\S]{0,160}big\('Kit given', 'deskKitGiven\(true\)', 'go'\)/.test(js));
    check('the checks row has a Kit cell', /\['Kit', kit \? \['ok', `Given/.test(js));
    check('the Overview counts kits given beside badges', /ov-day-kits/.test(fs.readFileSync(appFile('views', 'admin', 'sections', 'overview.ejs'), 'utf8')) && /summary\.kitsGiven/.test(js));
  } finally {
    for (const p of people) {
      await db.run('UPDATE registrations SET checked_in_at = ?, checked_in_by = ?, kit_given_at = ?, kit_given_by = ? WHERE phone_number = ?',
        [p.checked_in_at, p.checked_in_by, p.kit_given_at, p.kit_given_by, p.phone_number]);
    }
    db.close();
  }
  report();
})();
