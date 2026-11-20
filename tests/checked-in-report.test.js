// The Checked-in delegates report (owner, 20 Nov 2026): everyone checked in
// at the Front Desk, when and by whom, and whether their kit was given --
// names and registration only, for the volunteers too.
const fs = require('fs');
const { call, check, report, adminLogin, loginOtp, openDb, appFile } = require('./harness');

(async () => {
  const admin = await adminLogin();
  const db = openDb();
  const N = String(Date.now()).slice(-6);
  const vPhone = `96${N}22`;
  const regs = await db.all("SELECT id, registration_number, checked_in_at, checked_in_by, kit_given_at, kit_given_by FROM registrations WHERE COALESCE(bank_status, '') != 'REJECTED' AND registration_number IS NOT NULL LIMIT 3");
  try {
    const now = Date.now();
    await db.run('UPDATE registrations SET checked_in_at = ?, checked_in_by = ?, kit_given_at = ?, kit_given_by = ? WHERE id = ?', [now - 60000, 'Desk A', now - 50000, 'Desk B', regs[0].id]);
    await db.run('UPDATE registrations SET checked_in_at = ?, checked_in_by = ?, kit_given_at = NULL, kit_given_by = NULL WHERE id = ?', [now, 'Desk C', regs[1].id]);
    await db.run('UPDATE registrations SET checked_in_at = NULL, kit_given_at = NULL WHERE id = ?', [regs[2].id]);
    const r = await call('GET', '/api/admin/reports/checked-in?format=json', null, admin);
    const sec = r.body.report && r.body.report.sections[0];
    check('the report: who, when, by whom, the kit', r.body.success && JSON.stringify(sec.columns) === JSON.stringify(['Reg No', 'Name', 'Role', 'Category', 'Institution', 'Checked in', 'Checked in by', 'Kit given', 'Kit given by']), r.body);
    const row = (no) => sec.rows.find((x) => x[0] === no);
    check('checked in with the kit: Yes, when, by whom', row(regs[0].registration_number) && /^Yes, /.test(row(regs[0].registration_number)[7]) && row(regs[0].registration_number)[8] === 'Desk B'
      && row(regs[0].registration_number)[6] === 'Desk A');
    check('checked in, no kit yet: No', row(regs[1].registration_number) && row(regs[1].registration_number)[7] === 'No');
    check('not checked in: not on it', !row(regs[2].registration_number));
    check('latest first; the heading counts them and the kits', sec.rows[0][0] === regs[1].registration_number && /checked in · \d+ kits? given · \d+ still to give/.test(sec.name), sec.name);
    check('no mobile or email in it', !sec.columns.some((c) => /mobile|phone|email/i.test(c)));
    await db.run("INSERT INTO users (phone_number, full_name, role, created_at, phone_verified) VALUES (?, ?, 'DELEGATE', ?, 1)", [vPhone, `Meal Volunteer ${N}`, Date.now()]);
    await db.run("INSERT INTO user_roles (phone_number, role_key) VALUES (?, 'VOLUNTEER_MEALS')", [vPhone]);
    const vol = await loginOtp(vPhone);
    check('a volunteer opens it', (await call('GET', '/api/admin/reports/checked-in?format=json', null, vol)).body.success === true);
    check('...and no other report', (await call('GET', '/api/admin/reports/delegates?format=json', null, vol)).status === 403);
    const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
    check('in the Reports list for them; their own screen stays their home page', /'report-checked-in': 'reports\.checked_in'/.test(js)
      && /canSee\('reports'\) && !\(can\('reports\.checked_in'\)/.test(js));
  } finally {
    for (const g of regs) {
      await db.run('UPDATE registrations SET checked_in_at = ?, checked_in_by = ?, kit_given_at = ?, kit_given_by = ? WHERE id = ?', [g.checked_in_at, g.checked_in_by, g.kit_given_at, g.kit_given_by, g.id]);
    }
    await db.run('DELETE FROM user_roles WHERE phone_number = ?', [vPhone]);
    await db.run('DELETE FROM users WHERE phone_number = ?', [vPhone]);
    db.close();
  }
  report();
})();
