// Correcting a delegate's name from the admin panel reaches their
// registration: the registration keeps its own copy of the name (taken when
// they registered), and that copy is what the badge, the receipt and the
// reports print.
//
//   * A title the old copy carried is kept when the account has none.
//   * Editing anything else leaves the copy alone.
const { call, check, report, adminLogin, openDb } = require('./harness');

const N = String(Date.now()).slice(-7);

(async () => {
  const admin = await adminLogin();
  const db = openDb();
  const made = [];
  const signUp = async (tag, salutation) => {
    const email = `name-${tag}-${N}@example.test`;
    const otp = await call('POST', '/api/otp/request', { destination: email });
    const r = await call('POST', '/api/auth/register', { salutation, age: '40', gender: 'Female', designation: 'Professor', institute: 'Test College', pincode: '442102', state: 'Maharashtra', district: 'Wardha', name: `Old Name ${tag} ${N}`, country: 'United Kingdom', email, emailOtp: otp.body.devOtp, password: 'testpass123' });
    return r.body.user.phone_number;
  };
  // With the account's own number, as a real registration has (the server's
  // start-up backfill would otherwise rewrite it mid-test).
  const register = async (phone, copy) => {
    const own = (await db.get('SELECT registration_number FROM users WHERE phone_number = ?', [phone])).registration_number;
    const r = await db.run(`INSERT INTO registrations (phone_number, delegate_name, category_key, category_label, bank_status, expected_amount, registration_number, submitted_at)
      VALUES (?, ?, 'pg_doctor', 'Medical Student (PG)', 'BANK_VERIFIED', 3000, ?, ?)`, [phone, copy, own || `NS${N}${made.length}`, Date.now()]);
    made.push(r.lastID);
    return r.lastID;
  };
  const copyOf = async (id) => (await db.get('SELECT delegate_name FROM registrations WHERE id = ?', [id])).delegate_name;
  try {
    const a = await signUp('a', 'Dr');
    const regA = await register(a, `Old Name a ${N}`);
    const res = await call('PUT', `/api/users/${a}`, { full_name: `  New  Name ${N} ` }, admin);
    check('the edit saves', res.body.success === true, res.body);
    check('the registration takes the corrected name', await copyOf(regA) === `New Name ${N}`, await copyOf(regA));
    check('...on the record', !!(await db.get("SELECT 1 FROM audit_log WHERE action = 'NAME_CHANGED' AND entity_id = ?", [String(regA)])));
    const rep = (await call('GET', '/api/admin/reports/payments?format=json', null, admin)).body.report;
    const regNo = (await db.get('SELECT registration_number FROM registrations WHERE id = ?', [regA])).registration_number;
    const row = rep.sections[0].rows.find((r) => r[0] === regNo);
    check('the reports print it', row && row[1].includes(`New Name ${N}`) && !row[1].includes('Old Name'), row && row[1]);

    await call('PUT', `/api/users/${a}`, { designation: 'Professor and Head' }, admin);
    check('editing something else leaves the name alone', await copyOf(regA) === `New Name ${N}`);

    const b = await signUp('b', '');
    await db.run('UPDATE users SET salutation = NULL WHERE phone_number = ?', [b]);
    const regB = await register(b, `Dr Old Name b ${N}`);
    await call('PUT', `/api/users/${b}`, { full_name: `Fixed Name ${N}` }, admin);
    check('a title in the old copy is kept when the account has none', await copyOf(regB) === `Dr Fixed Name ${N}`, await copyOf(regB));
  } finally {
    for (const id of made) await db.run('DELETE FROM registrations WHERE id = ?', [id]);
  }
  db.close();
  report();
})();
