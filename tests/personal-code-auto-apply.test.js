// A personal code is applied for the person it was issued to.
//
// Issuing someone a code (a discount, or a set fee) used to leave them to
// find it in an email and type it at the payment step. Now:
//   * on their own payment form, choosing a category applies their best valid
//     personal code for it (GET /api/discounts/mine) -- the one that takes the
//     most off -- and tells them if one is held back only because their email
//     is not verified;
//   * on the desk's walk-in form, linking their account fills their code in,
//     and the fee is priced live (POST /api/desk/quote) with the same rules
//     the registration applies. Before this the walk-in form showed, and
//     pre-filled as cash, the full category fee whatever code was entered,
//     while the registration recorded the discounted one.
const { call, check, report, ADMIN, ADMIN_PW, appFile, adminLogin, loginPassword, openDb } = require('./harness');
const fs = require('fs');

const N = String(Date.now()).slice(-7);
const base = { salutation: 'Dr', age: '39', gender: 'Male', designation: 'Consultant',
  institute: 'Test Hospital', pincode: '442102', state: 'Maharashtra', district: 'Wardha' };
const ymd = (days) => new Date(Date.now() + 5.5 * 3600e3 + days * 864e5).toISOString().slice(0, 10);

(async () => {
  const admin = await adminLogin();
  const desk = await loginPassword('9000000006', ADMIN_PW);
  const reviewer = await loginPassword('9000000003', ADMIN_PW);
  const db = openDb({ readOnly: true });
  const made = [];
  const issue = async (body) => {
    const r = await call('POST', '/api/admin/discount-codes', body, admin);
    if (r.body.success) made.push(body.code);
    return r;
  };
  const signUp = async (email, name) => {
    const otp = await call('POST', '/api/otp/request', { destination: email });
    const r = await call('POST', '/api/auth/register', { ...base, name, country: 'United Kingdom', email, emailOtp: otp.body.devOtp, password: 'testpass123' });
    return { key: r.body.user && r.body.user.phone_number, cookie: r.cookie, ok: r.body.success === true };
  };
  const cat = await db.get('SELECT category_key FROM fee_categories WHERE active = 1 ORDER BY early_fee DESC LIMIT 1');
  const mine = (cookie, k = cat.category_key) => call('GET', `/api/discounts/mine?categoryKey=${encodeURIComponent(k)}`, null, cookie);

  const aEmail = `auto-a-${N}@example.test`;
  const A = await signUp(aEmail, `Auto A ${N}`);
  const B = await signUp(`auto-b-${N}@example.test`, `Auto B ${N}`);
  check('fixture: two delegates who signed up with verified emails', A.ok && B.ok);

  try {
    console.log('\n== With no personal code, nothing is applied ==');
    const none = await mine(A.cookie);
    check('the answer is "none"', none.body.success === true && none.body.code === null && !none.body.needsVerification, none.body);

    console.log('\n== A code issued to them is applied without their typing it ==');
    await issue({ code: `ASET${N}`, discountType: 'FIXED_FEE', discountValue: 1000, scopeType: 'INDIVIDUAL', scopeValue: aEmail });
    const one = (await mine(A.cookie)).body;
    check('their set-fee code is found', one.code && one.code.code === `ASET${N}`, one);
    check('...priced for the category chosen', one.code && one.code.finalFee === 1000 && one.code.discountAmount === one.code.baseFee - 1000, one.code);
    check('...with what the form needs to show it', one.code && one.code.discountType === 'FIXED_FEE');

    console.log('\n== Of several, the one that takes the most off ==');
    // Issued by ACCOUNT KEY, which is what the admin picker sends. For someone
    // who signed up by email the key is synthetic ("u_..."), and it used to be
    // stripped to its digits and refused -- so they could not be picked at all.
    check('fixture: A signed up by email, so their account key is synthetic', /^u_/.test(A.key), A.key);
    const picked = await issue({ code: `A90${N}`, discountType: 'PERCENT', discountValue: 90, scopeType: 'INDIVIDUAL', scopeValue: A.key });
    check('a code can be issued to them by picking their account', picked.body.success === true, picked.body.error);
    check('...bound to that account, with no address to verify',
      (await db.get('SELECT scope_value, issued_email FROM discount_codes WHERE code = ?', [`A90${N}`])).scope_value === A.key);
    const two = (await mine(A.cookie)).body;
    check('the 90% code beats the ₹1,000 set fee on this category', two.code && two.code.code === `A90${N}`, two.code);
    const code90 = await db.get('SELECT id FROM discount_codes WHERE code = ?', [`A90${N}`]);
    await call('PUT', `/api/admin/discount-codes/${code90.id}`, { active: false }, admin);
    check('a deactivated code is not applied', (await mine(A.cookie)).body.code.code === `ASET${N}`);
    await issue({ code: `AOLD${N}`, discountType: 'PERCENT', discountValue: 99, scopeType: 'INDIVIDUAL', scopeValue: A.key, expiresAt: ymd(-2) });
    check('nor an expired one, however generous', (await mine(A.cookie)).body.code.code === `ASET${N}`);

    console.log('\n== ...and only ever their own ==');
    const theirs = (await mine(B.cookie)).body;
    check('another delegate is offered none of A\'s codes', theirs.code === null, theirs.code);
    const fee = one.code.baseFee;
    await issue({ code: `BHI${N}`, discountType: 'FIXED_FEE', discountValue: fee + 500, scopeType: 'INDIVIDUAL', scopeValue: B.key });
    check('a set fee above their category\'s fee takes nothing off, so is not applied', (await mine(B.cookie)).body.code === null);

    console.log('\n== Held back until their email is verified, and they are told ==');
    const cPhone = '6' + N.padStart(9, '7');
    const cEmail = `auto-c-${N}@example.test`;
    await call('POST', '/api/users', { phone: cPhone, name: `Auto C ${N}`, email: cEmail, role: 'DELEGATE' }, admin);
    await issue({ code: `CVER${N}`, discountType: 'PERCENT', discountValue: 25, scopeType: 'INDIVIDUAL', scopeValue: cEmail });
    const reset = await call('POST', `/api/users/${cPhone}/reset-password`, {}, admin);
    const cLogin = await call('POST', '/api/auth/login-password', { identifier: cPhone, password: reset.body.tempPassword });
    await call('POST', '/api/auth/set-password', { password: 'their-own-99' }, cLogin.cookie);
    const held = (await mine(cLogin.cookie)).body;
    check('nothing is applied', held.code === null, held);
    check('...and the form is told why', held.needsVerification === true);

    check('a category must be chosen', (await mine(A.cookie, 'no_such_category')).status === 400);
    check('it needs a signed-in delegate', (await call('GET', `/api/discounts/mine?categoryKey=${cat.category_key}`)).status === 401);

    console.log('\n== The walk-in form applies it too, and prices it live ==');
    const quote = (body, cookie = desk) => call('POST', '/api/desk/quote', { categoryKey: cat.category_key, ...body }, cookie);
    const q1 = (await quote({ accountKey: A.key })).body;
    check('linking their account brings in their own best code', q1.success && q1.code === `ASET${N}` && q1.auto === true, q1);
    check('...priced as the registration will price it', q1.discountAmount === fee - 1000, q1.discountAmount);
    await issue({ code: `EVERY${N}`, discountType: 'PERCENT', discountValue: 10, scopeType: 'GLOBAL' });
    const q2 = (await quote({ accountKey: A.key, discountCode: `EVERY${N}` })).body;
    check('a code the desk types is priced instead', q2.code === `EVERY${N}` && q2.auto === false && q2.discountAmount === Math.round(fee * 0.1), q2);
    const q3 = (await quote({ accountKey: A.key, discountCode: 'NOSUCHCODE' })).body;
    check('a bad code comes back with its reason and no discount', q3.discountAmount === 0 && /not valid/.test(q3.error || ''), q3);
    const q4 = (await quote({ phone: '9' + N.padStart(9, '1') })).body;
    check('someone new, no code: the category fee', q4.discountAmount === 0 && q4.baseFee === fee, q4);
    check('only a role that registers walk-ins may ask', (await quote({ accountKey: A.key }, reviewer)).status === 403);
    check('...and nobody signed out', (await call('POST', '/api/desk/quote', { categoryKey: cat.category_key })).status === 401);

    console.log('\n== What the desk is shown is what gets recorded ==');
    const done = await call('POST', '/api/admin/registrations', {
      accountKey: A.key, categoryKey: cat.category_key, optionIds: [], discountCode: q1.code,
      paymentMode: 'CASH', collectedBy: ADMIN, amount: fee - q1.discountAmount, idVerifiedByAdmin: true,
    }, desk);
    check('the walk-in is registered with their code', done.body.success === true, done.body.error);
    const reg = await db.get('SELECT expected_amount, discount_code, bank_status FROM registrations WHERE phone_number = ?', [A.key]);
    check('...at exactly the fee the form showed', reg && reg.expected_amount === fee - q1.discountAmount, reg);
    check('...under their code', reg && reg.discount_code === `ASET${N}`, reg && reg.discount_code);
    check('...and paid in full, not left owing or overpaid', reg && reg.bank_status === 'BANK_VERIFIED', reg && reg.bank_status);

    console.log('\n== Wired into both forms ==');
    const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
    check('choosing a category on the payment form applies their code',
      /if \(catKey && !appliedPromo\) autoApplyPersonalCode\(catKey\);/.test(js));
    check('removing it is their choice, and it is not put back', /function removeAppliedPromo\(\) \{[\s\S]{0,200}personalCodeState\.dismissed = true;/.test(js));
    check('...until the form is opened afresh', /async function openPaymentModal\(\) \{\n  personalCodeState = \{ dismissed: false, checked: \{\} \};/.test(js));
    check('the walk-in fee takes the priced discount off', /const total = Math\.max\(0, base - discount\) \+ optionsFee;/.test(js));
    check('...and one person\'s code is cleared when the form moves to another',
      /if \(rdPromoAuto\) \{\n    const promo = document\.getElementById\('rd-discount-code'\);\n    if \(promo\) promo\.value = '';/.test(js));
  } finally {
    const w = openDb();
    for (const code of made) await w.run('DELETE FROM discount_codes WHERE code = ?', [code]);
    w.close();
  }
  db.close();
  report();
})();
