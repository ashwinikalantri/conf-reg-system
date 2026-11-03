// Volunteers are not delegates (3 Nov 2026). Someone registered in the
// Volunteer category: their badge says VOLUNTEER, the meal counter serves
// and counts them as Volunteer, the Front Desk card says Volunteer, the
// Conference badge report gives their Role, and Registered Delegates leaves
// them out. The Volunteers report lists them, and delegates holding a
// volunteer role, with their areas.
const fs = require('fs');
const { call, adminLogin, loginOtp, check, report, openDb, appFile } = require('./harness');

(async () => {
  const admin = await adminLogin();
  const db = await openDb();
  const N = Date.now() % 100000;
  const vol = await db.get(`SELECT u.phone_number, u.full_name FROM users u WHERE u.role = 'DELEGATE' AND u.phone_verified = 1
      AND NOT EXISTS (SELECT 1 FROM registrations r WHERE r.phone_number = u.phone_number) ORDER BY u.phone_number LIMIT 1`);
  const helper = await db.get(`SELECT u.phone_number, u.full_name FROM users u WHERE u.role = 'DELEGATE'
      AND EXISTS (SELECT 1 FROM registrations r WHERE r.phone_number = u.phone_number AND r.bank_status = 'BANK_VERIFIED')
      AND NOT EXISTS (SELECT 1 FROM user_roles x WHERE x.phone_number = u.phone_number) ORDER BY u.phone_number LIMIT 1`);
  check('fixture: an unregistered delegate and a registered one', !!vol && !!helper);
  const hadCat = await db.get("SELECT id FROM fee_categories WHERE category_key = 'volunteer'");
  let regId = null;
  try {
    if (!hadCat) await db.run(`INSERT INTO fee_categories (category_key, label, early_fee, regular_fee, late_fee, spot_fee, active, sort_order, staff_only)
      VALUES ('volunteer', 'Volunteer', 0, 0, 0, 0, 1, 99, 1)`);
    regId = (await db.run(`INSERT INTO registrations (phone_number, delegate_name, category_key, category_label, bank_status, expected_amount, paid_amount, registration_number, submitted_at, category_locked)
      VALUES (?, ?, 'volunteer', 'Volunteer', 'BANK_VERIFIED', 0, 0, ?, ?, 1)`, [vol.phone_number, vol.full_name, `VOL${N}`, Date.now()])).lastID;
    await call('PUT', `/api/users/${encodeURIComponent(helper.phone_number)}/roles`, { roles: ['VOLUNTEER_MEALS'] }, admin);

    console.log('\n== Their badge, the desk, the meal counter ==');
    const me = await loginOtp(vol.phone_number);
    const mine = (await call('GET', '/api/registrations/me', null, me)).body;
    const reg = mine.registration || mine;
    check('the portal is told they are a volunteer, for the badge', reg.is_volunteer === true, reg.is_volunteer);
    const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
    check('...and the badge says VOLUNTEER', /const role = reg\.is_faculty_member \? 'FACULTY' : reg\.is_volunteer \? 'VOLUNTEER' : 'DELEGATE';/.test(js));
    check('the Front Desk card says Volunteer', /deskCard\(reg && reg\.category_key === 'volunteer' \? 'Volunteer' : 'Delegate'/.test(js));
    const found = (await call('GET', `/api/meals/search?q=${encodeURIComponent(`VOL${N}`)}`, null, admin)).body;
    const person = (found.results || found.people || [])[0] || found.person;
    check('the meal counter serves them as Volunteer', person && person.kind === 'VOLUNTEER' && person.kindLabel === 'Volunteer' && person.eligible === true, found);
    const meals = (await call('GET', '/api/meals', null, admin)).body;
    check('...and counts the volunteers expected on their own', meals.expected && meals.expected.VOLUNTEER >= 1);

    console.log('\n== The reports ==');
    const del = (await call('GET', '/api/admin/reports/delegates?format=json', null, admin)).body.report.sections[0];
    check('Registered Delegates leaves them out', !del.rows.some((r) => r[0] === `VOL${N}`) && del.rows.length > 0);
    const badges = (await call('GET', '/api/admin/reports/badges?format=json', null, admin)).body.report.sections[0];
    const brow = badges.rows.find((r) => r[0] === `VOL${N}`);
    check('the Conference badge report gives their Role as Volunteer', brow && brow[badges.columns.indexOf('Role')] === 'Volunteer', brow);
    const vr = (await call('GET', '/api/admin/reports/volunteers?format=json', null, admin)).body.report;
    const vs = vr.sections[0];
    const at = (name) => vs.columns.indexOf(name);
    check('a Volunteers report', vr.title === 'Volunteers' && ['Name', 'Mobile', 'Email', 'Areas', 'Reg No', 'Registration', 'Faculty Assigned'].every((c) => at(c) >= 0), vs.columns);
    const vrow = vs.rows.find((r) => r[at('Reg No')] === `VOL${N}`);
    check('...with the Volunteer category registration', vrow && vrow[at('Registration')] === 'Volunteer · Confirmed', vrow);
    const hrow = vs.rows.find((r) => r[at('Email')] && r[0] && r[at('Areas')] === 'Meals' && r[at('Registration')].endsWith('· Confirmed') && !r[at('Registration')].startsWith('Volunteer'));
    check('...and a delegate who volunteers, with their area', !!hrow, vs.rows.slice(0, 5));
    check('...for whoever sees All accounts; not the front desk', (await call('GET', '/api/admin/reports/volunteers?format=json', null, await require('./harness').loginPassword('9000000006', require('./harness').ADMIN_PW))).status === 403);
    const view = fs.readFileSync(appFile('views', 'admin', 'sections', 'reports.ejs'), 'utf8');
    check('listed under People', /id="report-volunteers" data-report="volunteers"/.test(view) && /'report-volunteers': 'reports\.users'/.test(js));
  } finally {
    if (regId) await db.run('DELETE FROM registrations WHERE id = ?', [regId]);
    await db.run("DELETE FROM user_roles WHERE phone_number = ? AND role_key = 'VOLUNTEER_MEALS'", [helper.phone_number]);
    if (!hadCat) await db.run("DELETE FROM fee_categories WHERE category_key = 'volunteer'");
    db.close();
  }
  report();
})();
