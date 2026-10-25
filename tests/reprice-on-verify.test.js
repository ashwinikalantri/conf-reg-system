// A delegate who registers before verifying their email, then verifies it,
// gets the code that was waiting on it -- an email-domain code such as
// MGIMS2026, or a personal code issued to the address -- applied to a
// registration still being paid for.
//
//   * Only the category fee is discounted: a paid workshop's fee stays.
//   * Only PENDING and PARTIAL_PAYMENT are re-priced; a paid-in-full one is
//     left alone (lowering it would mean a refund).
//   * Never to a worse price than they already have.
const { call, check, report, appFile, adminLogin, openDb } = require('./harness');
const fs = require('fs');

const N = String(Date.now()).slice(-7);
const DOMAIN = `rp${N}.test`;
const base = { salutation: 'Dr', age: '35', gender: 'Female', designation: 'Resident', institute: 'Test College', pincode: '442102', state: 'Maharashtra', district: 'Wardha' };

(async () => {
  const admin = await adminLogin();
  const db = openDb();
  const cat = await db.get("SELECT category_key, label, early_fee, late_fee FROM fee_categories WHERE category_key = 'pg_doctor'");
  const paidOption = await db.get('SELECT id, group_id, fee FROM program_options WHERE fee > 0 LIMIT 1');
  const made = { codes: [`RP${N}`], regs: [] };
  const signUp = async (tag) => {
    const email = `${tag}-${N}@${DOMAIN}`;
    const otp = await call('POST', '/api/otp/request', { destination: email });
    const r = await call('POST', '/api/auth/register', { ...base, name: `Reprice ${tag} ${N}`, country: 'United Kingdom', email, emailOtp: otp.body.devOtp, password: 'testpass123' });
    const phone = r.body.user.phone_number;
    // As though they signed up with their mobile, the address unproven.
    await db.run('UPDATE users SET email_verified = 0 WHERE phone_number = ?', [phone]);
    return { phone, email, cookie: r.cookie };
  };
  const register = async (who, status, expected, extra = {}) => {
    const r = await db.run(`INSERT INTO registrations (phone_number, delegate_name, category_key, category_label, bank_status, expected_amount, registration_number, discount_code, discount_amount)
      VALUES (?, 'Reprice', ?, ?, ?, ?, ?, ?, ?)`, [who.phone, cat.category_key, cat.label, status, expected, `RP${N}${made.regs.length}`, extra.code || null, extra.discount || 0]);
    made.regs.push(r.lastID);
    return r.lastID;
  };
  const verify = async (who) => {
    const req = await call('POST', '/api/auth/verify-contact/request', { channel: 'email', value: who.email }, who.cookie);
    return (await call('POST', '/api/auth/verify-contact/confirm', { channel: 'email', value: who.email, otp: req.body.devOtp }, who.cookie)).body;
  };
  try {
    const code = await call('POST', '/api/admin/discount-codes', { code: `RP${N}`, discountType: 'FEE_TIER', feeTier: 'early', scopeType: 'DOMAIN', scopeValue: DOMAIN }, admin);
    check('fixture: an early-bird code for the domain', code.body.success === true, code.body);

    console.log('\n== Registered unverified, then verified ==');
    const a = await signUp('pending');
    const regA = await register(a, 'PENDING', cat.late_fee + paidOption.fee);
    await db.run('INSERT INTO registration_options (registration_id, group_id, option_id, is_faculty) VALUES (?, ?, ?, 0)', [regA, paidOption.group_id, paidOption.id]);
    const done = await verify(a);
    check('verifying says what it now costs', done.success && done.repriced && done.repriced.code === `RP${N}`
      && done.repriced.from === cat.late_fee + paidOption.fee && done.repriced.to === cat.early_fee + paidOption.fee, done);
    const rowA = await db.get('SELECT expected_amount, discount_code, discount_amount FROM registrations WHERE id = ?', [regA]);
    check('the registration takes the code: the category at the early-bird fee, the paid workshop as it was',
      rowA.discount_code === `RP${N}` && rowA.expected_amount === cat.early_fee + paidOption.fee && rowA.discount_amount === cat.late_fee - cat.early_fee, rowA);
    check('...on the record', !!(await db.get("SELECT 1 FROM audit_log WHERE action = 'FEE_REPRICED_CODE' AND entity_id = ?", [String(regA)])));

    console.log('\n== Not re-priced ==');
    const b = await signUp('paid');
    const regB = await register(b, 'BANK_VERIFIED', cat.late_fee);
    const doneB = await verify(b);
    check('paid in full: left alone', !doneB.repriced && (await db.get('SELECT expected_amount FROM registrations WHERE id = ?', [regB])).expected_amount === cat.late_fee);
    const c = await signUp('better');
    const regC = await register(c, 'PENDING', 100, { code: 'SOMEOTHER', discount: cat.late_fee - 100 });
    const doneC = await verify(c);
    check('already cheaper: left alone', !doneC.repriced && (await db.get('SELECT expected_amount, discount_code FROM registrations WHERE id = ?', [regC])).discount_code === 'SOMEOTHER');
    const d = await signUp('none');
    const doneD = await verify(d);
    check('not registered: nothing to re-price, verification as usual', doneD.success === true && !doneD.repriced);

    const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
    check('the delegate is told the new fee', /now applies: your fee is ₹\$\{inr\(data\.repriced\.to\)\}/.test(js));
  } finally {
    for (const id of made.regs) {
      await db.run('DELETE FROM registration_options WHERE registration_id = ?', [id]);
      await db.run('DELETE FROM registrations WHERE id = ?', [id]);
    }
    for (const c of made.codes) await db.run('DELETE FROM discount_codes WHERE code = ?', [c]);
  }
  db.close();
  report();
})();
