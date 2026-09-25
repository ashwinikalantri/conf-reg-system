// Two additions to discount codes.
//
// FEE-SETTING CODES (FIXED_FEE): instead of taking something off, the code
// sets the fee -- "₹1,000 for this delegate" whatever their category costs.
// It takes off whatever brings the fee to that value, so a value at or above
// the fee takes off nothing: a code never raises what someone pays. ₹0 is a
// complimentary registration.
//
// CODES FOR AN EMAIL WITH NO ACCOUNT YET: a personal code used to need an
// existing account (the admin's email was resolved to it on the spot, and an
// unknown address refused). Now it waits on the address and becomes that
// person's when an account VERIFIES it -- at email signup, or by verifying
// the email later. Verified, because anyone can type an address at signup:
// a code meant for someone must not go to whoever typed their email first.
const { call, check, report, adminLogin, loginPassword, openDb } = require('./harness');

const N = String(Date.now()).slice(-7);
const base = { salutation: 'Dr', name: 'Code Tester', age: '34', gender: 'Female', designation: 'Consultant',
  institute: 'Test Hospital', pincode: '442102', state: 'Maharashtra', district: 'Wardha' };

(async () => {
  const admin = await adminLogin();
  const db = openDb();
  const made = [];
  const create = async (body) => {
    const r = await call('POST', '/api/admin/discount-codes', body, admin);
    if (r.body.success) made.push(body.code);
    return r;
  };
  const codeRow = (code) => db.get('SELECT * FROM discount_codes WHERE code = ?', [code]);

  // A delegate who signs up with a verified email, as the portal does it.
  const signUpByEmail = async (email, name) => {
    const otp = await call('POST', '/api/otp/request', { destination: email });
    const r = await call('POST', '/api/auth/register',
      { ...base, name, country: 'United Kingdom', email, emailOtp: otp.body.devOtp, password: 'testpass123' });
    return { ok: r.body.success === true, key: r.body.user && r.body.user.phone_number, cookie: r.cookie, error: r.body.error };
  };

  // The dearest active category, so a ₹1,000 fee is genuinely a reduction.
  const cat = await db.get('SELECT category_key, label FROM fee_categories WHERE active = 1 ORDER BY early_fee DESC LIMIT 1');

  try {
    console.log('\n== A personal code can be issued to an email nobody has signed up with ==');
    const waitingFor = `pending-${N}@example.test`;
    const pend = await create({ code: `PEND${N}`, discountType: 'PERCENT', discountValue: 50, scopeType: 'INDIVIDUAL', scopeValue: waitingFor });
    check('it is created, not refused as before', pend.body.success === true, pend.body.error);
    check('...and the admin is told it is waiting on that address', pend.body.pendingEmail === waitingFor, pend.body);
    const stored = await codeRow(`PEND${N}`);
    check('it is held against the address, not an account', stored.pending_email === waitingFor && stored.scope_value === null, stored);
    const list = (await call('GET', '/api/admin/discount-codes', null, admin)).body.codes || [];
    check('the admin list shows what it is waiting on', (list.find((c) => c.code === `PEND${N}`) || {}).pending_email === waitingFor);
    const voucher = String((await call('GET', `/api/admin/discount-codes/${stored.id}/share`, null, admin)).body);
    check('the voucher tells the recipient to sign up with that address',
      voucher.includes(`Reserved for ${waitingFor}. Sign up with this email address to use it.`));
    const noPhone = await create({ code: `NOPH${N}`, discountType: 'PERCENT', discountValue: 10, scopeType: 'INDIVIDUAL', scopeValue: '9123' + N.slice(-6) });
    check('an unknown mobile number is still refused -- a number cannot be verified by someone who has not used it',
      noPhone.status === 404, [noPhone.status, noPhone.body.error]);

    console.log('\n== ...nobody else can use it ==');
    const other = await signUpByEmail(`other-${N}@example.test`, 'Someone Else');
    check('fixture: another delegate', other.ok, other.error);
    const stolen = await call('POST', '/api/discounts/validate', { code: `PEND${N}`, categoryKey: cat.category_key }, other.cookie);
    check('another delegate is refused', stolen.body.success === false && /not valid for your account/.test(stolen.body.error), stolen.body);
    check('...and it stays waiting', (await codeRow(`PEND${N}`)).pending_email === waitingFor);

    console.log('\n== ...and it becomes theirs when they sign up with it ==');
    const owner = await signUpByEmail(waitingFor, 'The Intended');
    check('fixture: they sign up with a verified email', owner.ok, owner.error);
    const bound = await codeRow(`PEND${N}`);
    check('the code now belongs to their account', bound.scope_value === owner.key && bound.pending_email === null, bound);
    const trail = await db.get("SELECT old_value, new_value FROM audit_log WHERE entity_type = 'discount_code' AND entity_id = ? AND action = 'DISCOUNT_CODE_BOUND'", [String(bound.id)]);
    check('...recorded in the activity log', !!trail && trail.old_value === waitingFor && trail.new_value === owner.key, trail);
    const redeemed = await call('POST', '/api/discounts/validate', { code: `PEND${N}`, categoryKey: cat.category_key }, owner.cookie);
    check('they can use it', redeemed.body.success === true && redeemed.body.discountAmount > 0, redeemed.body);
    const still = await call('POST', '/api/discounts/validate', { code: `PEND${N}`, categoryKey: cat.category_key }, other.cookie);
    check('...and it is still nobody else\'s', still.body.success === false);

    console.log('\n== An address held but not verified cannot claim it ==');
    // Anyone can put an address on an account; only proving it counts.
    const unverified = `unverified-${N}@example.test`;
    await create({ code: `PEND2${N}`, discountType: 'FLAT', discountValue: 500, scopeType: 'INDIVIDUAL', scopeValue: unverified });
    check('fixture: a second waiting code', !!(await codeRow(`PEND2${N}`)), null);
    const phone = '7' + N.padStart(9, '3');
    await call('POST', '/api/users', { phone, name: 'Holds It Unverified', email: unverified, role: 'DELEGATE' }, admin);
    const acct = await db.get('SELECT phone_number, email_verified FROM users WHERE phone_number = ?', [phone]);
    check('fixture: an account holding the address, not yet verified', !!acct && !acct.email_verified, acct);
    check('...creating it did not claim the code', (await codeRow(`PEND2${N}`)).pending_email === unverified);
    const reset = await call('POST', `/api/users/${phone}/reset-password`, {}, admin);
    const login = await call('POST', '/api/auth/login-password', { identifier: phone, password: reset.body.tempPassword });
    await call('POST', '/api/auth/set-password', { password: 'their-own-99' }, login.cookie);
    const early = await call('POST', '/api/discounts/validate', { code: `PEND2${N}`, categoryKey: cat.category_key }, login.cookie);
    check('trying to use it is refused', early.body.success === false, early.body);
    check('...with the reason, so they know what to do', /Verify your email address to use it/.test(early.body.error || ''), early.body.error);
    check('...and the code is still waiting', (await codeRow(`PEND2${N}`)).pending_email === unverified);

    const req = await call('POST', '/api/auth/verify-contact/request', { channel: 'email', value: unverified }, login.cookie);
    const conf = await call('POST', '/api/auth/verify-contact/confirm', { channel: 'email', value: unverified, otp: req.body.devOtp }, login.cookie);
    check('fixture: they verify the address', conf.body.success === true, conf.body.error);
    const claimed = await codeRow(`PEND2${N}`);
    check('verifying it claims the code', claimed.scope_value === phone && claimed.pending_email === null, claimed);
    const now = await call('POST', '/api/discounts/validate', { code: `PEND2${N}`, categoryKey: cat.category_key }, login.cookie);
    check('...and now it works', now.body.success === true && now.body.discountAmount === 500, now.body);

    console.log('\n== An address that already has an account is bound at once, as before ==');
    const known = await create({ code: `KNOWN${N}`, discountType: 'PERCENT', discountValue: 20, scopeType: 'INDIVIDUAL', scopeValue: `other-${N}@example.test` });
    check('no waiting for someone already signed up', known.body.success && !known.body.pendingEmail, known.body);
    check('...it is theirs immediately', (await codeRow(`KNOWN${N}`)).scope_value === other.key);

    console.log('\n== A code can set the fee instead of discounting it ==');
    const fix = await create({ code: `FIX${N}`, discountType: 'FIXED_FEE', discountValue: 1000, scopeType: 'GLOBAL' });
    check('a fee-setting code is created', fix.body.success === true, fix.body.error);
    const f1 = (await call('POST', '/api/discounts/validate', { code: `FIX${N}`, categoryKey: cat.category_key }, other.cookie)).body;
    check('fixture: the category costs more than ₹1,000', f1.baseFee > 1000, f1.baseFee);
    check('the fee comes out at exactly ₹1,000', f1.success && f1.finalFee === 1000, f1);
    check('...by taking off the difference', f1.discountAmount === f1.baseFee - 1000, f1.discountAmount);
    check('...and the portal is told what kind of code it is', f1.discountType === 'FIXED_FEE');

    const high = await create({ code: `FIXHI${N}`, discountType: 'FIXED_FEE', discountValue: f1.baseFee + 500, scopeType: 'GLOBAL' });
    const f2 = (await call('POST', '/api/discounts/validate', { code: `FIXHI${N}`, categoryKey: cat.category_key }, other.cookie)).body;
    check('a code set above the fee takes nothing off', high.body.success && f2.discountAmount === 0 && f2.finalFee === f2.baseFee, f2);
    check('...and never raises it', f2.finalFee <= f2.baseFee);

    const free = await create({ code: `FIX0${N}`, discountType: 'FIXED_FEE', discountValue: 0, scopeType: 'GLOBAL' });
    const f3 = (await call('POST', '/api/discounts/validate', { code: `FIX0${N}`, categoryKey: cat.category_key }, other.cookie)).body;
    check('₹0 is allowed, and makes the registration free', free.body.success && f3.finalFee === 0, [free.body.error, f3.finalFee]);
    const neg = await create({ code: `FIXNEG${N}`, discountType: 'FIXED_FEE', discountValue: -5, scopeType: 'GLOBAL' });
    check('a negative fee is refused', neg.status === 400 && /0 or more/.test(neg.body.error), neg.body.error);
    const zeroPct = await create({ code: `PCT0${N}`, discountType: 'PERCENT', discountValue: 0, scopeType: 'GLOBAL' });
    check('...while a discount of nothing is still refused', zeroPct.status === 400, zeroPct.body.error);

    const fixRow = await codeRow(`FIX${N}`);
    const fixVoucher = String((await call('GET', `/api/admin/discount-codes/${fixRow.id}/share`, null, admin)).body);
    check('the voucher says what it does', fixVoucher.includes('Fee set to ₹1,000'), (fixVoucher.match(/class="discount">[^<]*/) || [])[0]);
    const created = await db.get("SELECT new_value FROM audit_log WHERE entity_type = 'discount_code' AND entity_id = ? AND action = 'DISCOUNT_CODE_CREATE'", [String(fixRow.id)]);
    check('...and so does the activity log', !!created && created.new_value.includes('Fee set to ₹1,000'), created && created.new_value);
  } finally {
    for (const code of made) await db.run('DELETE FROM discount_codes WHERE code = ?', [code]);
  }
  db.close();
  report();
})();
