// A category only staff may allot (Volunteer, 3 Nov 2026): set on the Fee
// Master; kept out of the delegate's own form and the website's fee table;
// refused from the delegate's own submission; offered to the desk and to
// Lock category, which then lets the delegate's own form go through.
const { call, adminLogin, loginOtp, loginPassword, ADMIN_PW, check, report, openDb, appFile } = require('./harness');
const fs = require('fs');

(async () => {
  const admin = await adminLogin();
  const desk = await loginPassword('9000000006', ADMIN_PW);
  const db = await openDb();
  const N = Date.now() % 100000;
  const key = `volunteer_t${N}`;
  let catId = null;
  let regId = null;
  const d = await db.get(`SELECT u.phone_number FROM users u WHERE u.role = 'DELEGATE' AND u.phone_verified = 1
      AND NOT EXISTS (SELECT 1 FROM registrations r WHERE r.phone_number = u.phone_number) ORDER BY u.phone_number LIMIT 1`);
  check('fixture: an unregistered delegate', !!d);
  try {
    console.log('\n== On the Fee Master ==');
    const made = await call('POST', '/api/admin/fees/categories', { categoryKey: key, label: `Volunteer ${N}`, earlyFee: 0, regularFee: 0, lateFee: 0, spotFee: 0, staffOnly: true }, admin);
    check('a category can be made staff-only', made.status === 200 && made.body.success, made.body);
    const master = (await call('GET', '/api/admin/fees', null, admin)).body.categories.find((c) => c.category_key === key);
    catId = master && master.id;
    check('...and the Fee Master says so', master && Number(master.staff_only) === 1);
    const audit = await db.get(`SELECT new_value FROM audit_log WHERE action = 'FEE_CATEGORY_CREATE' AND entity_id = ?`, [String(catId)]);
    check('...as does the activity log', audit && /allotted by staff only/.test(audit.new_value), audit);
    const plainEdit = await call('PUT', `/api/admin/fees/categories/${catId}`, { earlyFee: 0, regularFee: 0, lateFee: 0, spotFee: 0 }, admin);
    check('a fee edit that does not mention it leaves it staff-only', plainEdit.body.success
      && Number((await db.get('SELECT staff_only FROM fee_categories WHERE id = ?', [catId])).staff_only) === 1);

    console.log('\n== Who is offered it ==');
    const me = await loginOtp(d.phone_number);
    const mine = (await call('GET', '/api/fees', null, me)).body.categories;
    check('not a delegate', !mine.some((c) => c.key === key) && mine.length > 0);
    const desks = (await call('GET', '/api/fees', null, desk)).body.categories.find((c) => c.key === key);
    check('the registration desk is, marked staff-only', desks && desks.staffOnly === true);
    const site = (await call('GET', '/website/registration', null, null)).raw || '';
    check('not on the website\'s fee table', !site.includes(`Volunteer ${N}`) && /<table class="fees">/.test(site));
    const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
    check('the delegate\'s own form leaves it out even for staff', /\(data\.categories \|\| \[\]\)\.filter\(\(c\) => !c\.staffOnly\)\.map/.test(js));

    console.log('\n== A delegate cannot choose it ==');
    const chose = await call('POST', '/api/registrations', { categoryKey: key, acknowledged: true }, me);
    check('their own submission is refused', chose.status === 400 && /allotted by the registration desk/.test(chose.body.error), chose.body);
    check('...and nothing is written', !(await db.get('SELECT id FROM registrations WHERE phone_number = ?', [d.phone_number])));

    console.log('\n== Staff can allot it ==');
    regId = (await db.run(`INSERT INTO registrations (phone_number, delegate_name, category_key, category_label, bank_status, expected_amount, paid_amount, submitted_at)
      VALUES (?, 'Staff Only Test', 'doctor', 'Doctor', 'PENDING', 2000, 0, ?)`, [d.phone_number, Date.now()])).lastID;
    const locked = await call('PUT', `/api/registrations/${regId}/lock-category`, { categoryKey: key }, admin);
    check('Lock category gives it', locked.status === 200 && locked.body.success, locked.body);
    const row = await db.get('SELECT category_key, category_locked, expected_amount FROM registrations WHERE id = ?', [regId]);
    check('...at its fee, locked', row.category_key === key && row.category_locked === 1 && Number(row.expected_amount) === 0, row);
    const after = await call('POST', '/api/registrations', { categoryKey: 'doctor', acknowledged: true }, me);
    check('once the desk has locked it, the staff-only rule does not refuse the delegate', !/allotted by the registration desk/.test(String(after.body.error || '')), after.body);
  } finally {
    if (regId) await db.run('DELETE FROM payment_transactions WHERE registration_id = ?', [regId]);
    if (regId) await db.run('DELETE FROM registrations WHERE id = ?', [regId]);
    await db.run('DELETE FROM registrations WHERE phone_number = ? AND category_key = ?', [d.phone_number, key]);
    await db.run('DELETE FROM fee_categories WHERE category_key = ?', [key]);
    db.close();
  }
  report();
})();
