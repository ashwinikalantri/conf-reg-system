// Discount codes that set the fee to a TIER.
//
// "Set fee to ₹X" fixed one amount for everyone. What was wanted was a tier:
// "this delegate pays the Early Bird fee", even after early bird has closed.
// The amount is then the delegate's own category's fee at that tier -- the
// same code is ₹500 for one category and ₹3,000 for another -- looked up when
// the code is used.
//
//   * it charges the chosen tier, per category, and never raises a fee (a
//     tier at or above today's fee takes nothing off);
//   * a tier must be chosen, and must be a real one;
//   * it works everywhere a code is priced: the portal, applied for its owner,
//     the desk's live quote, and the registration itself;
//   * the form offers tiers, not a fixed rupee fee.
const { call, check, report, ADMIN, ADMIN_PW, appFile, adminLogin, loginPassword, openDb } = require('./harness');
const fs = require('fs');

const N = String(Date.now()).slice(-7);
const ist = (days) => new Date(Date.now() + 5.5 * 3600e3 + days * 864e5).toISOString().slice(0, 10);
const base = { salutation: 'Dr', age: '33', gender: 'Female', designation: 'Consultant',
  institute: 'Test Hospital', pincode: '442102', state: 'Maharashtra', district: 'Wardha' };

(async () => {
  const admin = await adminLogin();
  const desk = await loginPassword('9000000006', ADMIN_PW);
  const db = openDb();
  const made = [];
  const create = async (body) => { const r = await call('POST', '/api/admin/discount-codes', body, admin); if (r.body.success) made.push(body.code); return r; };
  const row = (code) => db.get('SELECT * FROM discount_codes WHERE code = ?', [code]);

  const cats = await db.all('SELECT category_key, early_fee, regular_fee, late_fee, spot_fee FROM fee_categories WHERE active = 1');
  const priced = cats.filter((c) => c.early_fee < c.regular_fee && c.regular_fee < c.late_fee);
  const X = priced[0];
  const Y = priced.find((c) => c.early_fee !== X.early_fee);
  check('fixture: two categories with different early-bird fees, each rising tier by tier', !!X && !!Y, priced.length);
  const cfg = await db.get('SELECT early_until, regular_until, late_until FROM fee_config WHERE id = 1');

  const email = `tier-${N}@example.test`;
  const otp = await call('POST', '/api/otp/request', { destination: email });
  const signed = await call('POST', '/api/auth/register', { ...base, name: `Tier ${N}`, country: 'United Kingdom', email, emailOtp: otp.body.devOtp, password: 'testpass123' });
  check('fixture: a delegate', signed.body.success === true, signed.body.error);
  const delegate = signed.cookie;
  const price = (code, categoryKey) => call('POST', '/api/discounts/validate', { code, categoryKey }, delegate).then((r) => r.body);

  try {
    console.log('\n== A tier code is created by naming the tier ==');
    const made1 = await create({ code: `TEARLY${N}`, discountType: 'FEE_TIER', feeTier: 'early', scopeType: 'GLOBAL' });
    check('an Early Bird code is created', made1.body.success === true, made1.body.error);
    const stored = await row(`TEARLY${N}`);
    check('...stored as a tier, with no amount of its own', stored.discount_type === 'FEE_TIER' && stored.fee_tier === 'early' && stored.discount_value === 0, stored);
    const noTier = await create({ code: `TNONE${N}`, discountType: 'FEE_TIER', scopeType: 'GLOBAL' });
    check('a tier code with no tier is refused', noTier.status === 400 && /fee tier/.test(noTier.body.error), noTier.body);
    const badTier = await create({ code: `TVIP${N}`, discountType: 'FEE_TIER', feeTier: 'vip', scopeType: 'GLOBAL' });
    check('...and so is one that is not a tier', badTier.status === 400, badTier.body);
    const voucher = String((await call('GET', `/api/admin/discount-codes/${stored.id}/share`, null, admin)).body);
    check('the voucher names the tier', voucher.includes('Pay the Early Bird fee'), (voucher.match(/class="discount">[^<]*/) || [])[0]);
    const log = await db.get("SELECT new_value FROM audit_log WHERE entity_type = 'discount_code' AND entity_id = ? AND action = 'DISCOUNT_CODE_CREATE'", [String(stored.id)]);
    check('...and so does the activity log', !!log && log.new_value.includes('Pay the Early Bird fee'), log && log.new_value);
    for (const [t, k] of [['regular', 'TREG'], ['late', 'TLATE'], ['spot', 'TSPOT']]) await create({ code: `${k}${N}`, discountType: 'FEE_TIER', feeTier: t, scopeType: 'GLOBAL' });

    console.log('\n== During early bird, the Early Bird tier is today\'s fee already ==');
    const during = await price(`TEARLY${N}`, X.category_key);
    check('it takes nothing off', during.success && during.discountAmount === 0 && during.finalFee === X.early_fee, during);

    console.log('\n== After early bird, it charges the early-bird fee -- per category ==');
    // Move the fixture's calendar into the Late period; restored below.
    await db.run('UPDATE fee_config SET early_until = ?, regular_until = ?, late_until = ? WHERE id = 1', [ist(-20), ist(-10), ist(30)]);
    const late = await price(`TEARLY${N}`, X.category_key);
    check('fixture: the fee is now the late fee', late.baseFee === X.late_fee, late.baseFee);
    check('an Early Bird code brings it down to the early-bird fee', late.finalFee === X.early_fee, late);
    check('...taking off exactly the difference', late.discountAmount === X.late_fee - X.early_fee, late.discountAmount);
    check('...and tells the portal which tier it is', late.discountType === 'FEE_TIER' && late.feeTier === 'early', late);
    const other = await price(`TEARLY${N}`, Y.category_key);
    check('the same code charges another category ITS early-bird fee', other.finalFee === Y.early_fee && other.finalFee !== late.finalFee, other);
    const reg = await price(`TREG${N}`, X.category_key);
    check('a Regular code charges the regular fee', reg.finalFee === X.regular_fee, reg);
    const same = await price(`TLATE${N}`, X.category_key);
    check('a Late code, in the late period, takes nothing off', same.discountAmount === 0, same);
    const higher = await price(`TSPOT${N}`, X.category_key);
    check('a Spot code never raises the fee', higher.discountAmount === 0 && higher.finalFee === X.late_fee, higher);

    console.log('\n== Wherever a code is priced ==');
    await create({ code: `TMINE${N}`, discountType: 'FEE_TIER', feeTier: 'early', scopeType: 'INDIVIDUAL', scopeValue: email });
    const mine = (await call('GET', `/api/discounts/mine?categoryKey=${X.category_key}`, null, delegate)).body;
    check('applied for its owner on their payment form', mine.code && mine.code.feeTier === 'early' && mine.code.finalFee === X.early_fee, mine);
    const quote = (await call('POST', '/api/desk/quote', { categoryKey: Y.category_key, phone: '8' + N.padStart(9, '2'), discountCode: `TEARLY${N}` }, desk)).body;
    check('priced live on the desk\'s walk-in form', quote.discountAmount === Y.late_fee - Y.early_fee, quote);
    const walkPhone = '8' + N.padStart(9, '3');
    const walk = await call('POST', '/api/admin/registrations', {
      phone: walkPhone, name: `Tier Walkin ${N}`, email: `tier-walk-${N}@example.test`, categoryKey: Y.category_key, optionIds: [],
      discountCode: `TEARLY${N}`, paymentMode: 'CASH', collectedBy: ADMIN, amount: Y.early_fee, idVerifiedByAdmin: true }, desk);
    check('a walk-in registered with it', walk.body.success === true, walk.body.error);
    const recorded = await db.get('SELECT expected_amount, bank_status FROM registrations WHERE phone_number = ?', [walkPhone]);
    check('...is charged the early-bird fee, and paid in full', recorded && recorded.expected_amount === Y.early_fee && recorded.bank_status === 'BANK_VERIFIED', recorded);

    console.log('\n== The form offers tiers, not a fixed fee ==');
    const view = fs.readFileSync(appFile('views', 'admin', 'sections', 'discount.ejs'), 'utf8');
    const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
    check('"Set fee to a tier" is offered', view.includes('<option value="FEE_TIER">Set fee to a tier</option>'));
    check('..."Set fee to ₹" is not', !view.includes('value="FIXED_FEE"'));
    check('...with the four tiers to choose from', ['early', 'regular', 'late', 'spot'].every((t) => view.includes(`<option value="${t}">`)));
    check('choosing it swaps the amount for the tier, and the amount stops being required',
      /input\.required = !tier;/.test(js) && /new-disc-tier-wrap'\)\.classList\.toggle\('hidden', !tier\)/.test(js));
    check('the tier is sent when the code is created', /feeTier: document\.getElementById\('new-disc-type'\)\.value === 'FEE_TIER'/.test(js));
    check('the type field runs both of its handlers -- a second onchange attribute is ignored',
      view.includes('onchange="updateDiscTypeHints(); updateDiscScopeHints()"') && !/onchange="[^"]*"\s+onchange=/.test(view));
  } finally {
    await db.run('UPDATE fee_config SET early_until = ?, regular_until = ?, late_until = ? WHERE id = 1', [cfg.early_until, cfg.regular_until, cfg.late_until]);
    for (const code of made) await db.run('DELETE FROM discount_codes WHERE code = ?', [code]);
  }
  check('the fixture\'s calendar is put back', (await db.get('SELECT early_until FROM fee_config WHERE id = 1')).early_until === cfg.early_until);
  db.close();
  report();
})();
