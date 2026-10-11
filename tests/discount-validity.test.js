// Extending a discount code's validity.
//
// A code's last date could only be set when it was created; after that the
// list offered Share, Activate/Deactivate and Delete -- so an expired code
// had to be re-issued under a new code, and everyone holding the old one told
// again. Now its validity can be changed (usually extended) in place.
//
//   * an expired code works again once extended, through the new last day;
//   * "no expiry" is allowed; a date already gone is not (Deactivate is how a
//     code is stopped now), nor is something that is not a date;
//   * extending does not quietly re-activate a deactivated code;
//   * a personal code applied for its owner comes back once extended;
//   * the change is in the activity log, and only code managers can make it.
const { call, check, report, ADMIN_PW, appFile, adminLogin, loginPassword, openDb } = require('./harness');
const fs = require('fs');
const vm = require('vm');

const N = String(Date.now()).slice(-7);
const ist = (days) => new Date(Date.now() + 5.5 * 3600e3 + days * 864e5).toISOString().slice(0, 10);
const base = { salutation: 'Dr', age: '36', gender: 'Female', designation: 'Consultant',
  institute: 'Test Hospital', pincode: '442102', state: 'Maharashtra', district: 'Wardha' };

(async () => {
  const admin = await adminLogin();
  const reviewer = await loginPassword('9000000003', ADMIN_PW);
  const db = openDb({ readOnly: true });
  const made = [];
  const issue = async (body) => { const r = await call('POST', '/api/admin/discount-codes', body, admin); if (r.body.success) made.push(body.code); return r; };
  const row = (code) => db.get('SELECT id, expires_at, active FROM discount_codes WHERE code = ?', [code]);
  const setValidity = (id, expiresAt, cookie = admin) => call('PUT', `/api/admin/discount-codes/${id}`, { expiresAt }, cookie);

  const email = `validity-${N}@example.test`;
  const otp = await call('POST', '/api/otp/request', { destination: email });
  const signed = await call('POST', '/api/auth/register', { ...base, name: `Valid ${N}`, country: 'United Kingdom', email, emailOtp: otp.body.devOtp, password: 'testpass123' });
  check('fixture: a delegate', signed.body.success === true, signed.body.error);
  const delegate = signed.cookie;
  const cat = await db.get('SELECT category_key FROM fee_categories WHERE active = 1 ORDER BY early_fee DESC LIMIT 1');
  const tryCode = (code) => call('POST', '/api/discounts/validate', { code, categoryKey: cat.category_key }, delegate);

  try {
    console.log('\n== An expired code works again once extended ==');
    await issue({ code: `OLD${N}`, discountType: 'PERCENT', discountValue: 20, scopeType: 'GLOBAL', expiresAt: ist(-3) });
    const old = await row(`OLD${N}`);
    const before = await tryCode(`OLD${N}`);
    check('fixture: the code has expired', before.body.success === false && /expired/.test(before.body.error), before.body);
    const extended = await setValidity(old.id, ist(10));
    check('it can be given a new last date', extended.body.success === true, extended.body.error);
    check('...stored as given', (await row(`OLD${N}`)).expires_at === ist(10));
    check('...and it works again', (await tryCode(`OLD${N}`)).body.success === true);
    const logged = await db.get("SELECT old_value, new_value FROM audit_log WHERE entity_type = 'discount_code' AND entity_id = ? AND action = 'DISCOUNT_CODE_UPDATE' ORDER BY id DESC LIMIT 1", [String(old.id)]);
    check('the change is in the activity log, old date and new',
      !!logged && logged.old_value.includes(`valid through ${ist(-3)}`) && logged.new_value.includes(`valid through ${ist(10)}`), logged);

    console.log('\n== Today, or no expiry at all ==');
    check('today is allowed -- a code works through its last day', (await setValidity(old.id, ist(0))).body.success === true);
    check('...and it still works today', (await tryCode(`OLD${N}`)).body.success === true);
    const open = await setValidity(old.id, '');
    check('it can be set to never expire', open.body.success === true && (await row(`OLD${N}`)).expires_at === null, open.body);
    const openLog = await db.get("SELECT new_value FROM audit_log WHERE entity_type = 'discount_code' AND entity_id = ? AND action = 'DISCOUNT_CODE_UPDATE' ORDER BY id DESC LIMIT 1", [String(old.id)]);
    check('...which the log says in words', openLog.new_value.includes('valid through no expiry'), openLog.new_value);

    console.log('\n== What it refuses ==');
    await setValidity(old.id, ist(5));
    const past = await setValidity(old.id, ist(-1));
    check('a date already gone', past.status === 400 && /deactivate it instead/.test(past.body.error), past.body);
    check('...leaving the code as it was', (await row(`OLD${N}`)).expires_at === ist(5));
    check('something that is not a date', (await setValidity(old.id, '15/10/2026')).status === 400);
    check('...nor an impossible one', (await setValidity(old.id, '2026-13-45')).status === 400);
    check('a role that cannot manage codes', (await setValidity(old.id, ist(20), reviewer)).status === 403);
    check('...and nothing changed', (await row(`OLD${N}`)).expires_at === ist(5));

    console.log('\n== Extending does not switch a code back on ==');
    await issue({ code: `OFF${N}`, discountType: 'PERCENT', discountValue: 15, scopeType: 'GLOBAL', expiresAt: ist(-1) });
    const off = await row(`OFF${N}`);
    await call('PUT', `/api/admin/discount-codes/${off.id}`, { active: false }, admin);
    await setValidity(off.id, ist(30));
    const offAfter = await row(`OFF${N}`);
    check('a deactivated code stays deactivated', offAfter.active === 0 && offAfter.expires_at === ist(30), offAfter);
    check('...and still cannot be used', (await tryCode(`OFF${N}`)).body.success === false);

    console.log('\n== A personal code applied for its owner comes back once extended ==');
    await issue({ code: `MINE${N}`, discountType: 'PERCENT', discountValue: 40, scopeType: 'INDIVIDUAL', scopeValue: email, expiresAt: ist(-2) });
    const mineRow = await row(`MINE${N}`);
    const gone = await call('GET', `/api/discounts/mine?categoryKey=${cat.category_key}`, null, delegate);
    check('expired, it is not applied for them', gone.body.code === null, gone.body);
    await setValidity(mineRow.id, ist(14));
    const back = await call('GET', `/api/discounts/mine?categoryKey=${cat.category_key}`, null, delegate);
    check('extended, it is applied again', back.body.code && back.body.code.code === `MINE${N}`, back.body);

    console.log('\n== The list and the dialog ==');
    const page = String((await call('GET', '/admin', null, admin)).body);
    check('the Change Validity dialog is on the admin page', page.includes('id="modal-discount-validity"') && page.includes('id="validity-date"'));
    const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
    var grab = (n) => { const i = js.indexOf(`function ${n}(`); return js.slice(i, js.indexOf('\n}', i) + 2); };
    check('the expiry column marks a code that has expired', />Expired<\/span>/.test(js) && /const expired = !!c\.expires_at && c\.expires_at < istDateString\(\);/.test(js));
    check('...offers to extend it, only to whoever may manage codes', /&& can\('discounts\.manage'\)/.test(js));
    check('saving sends the new date, or blank for no expiry', /JSON\.stringify\(\{ expiresAt: noExpiry \? '' : date \}\)/.test(js));

    // "+1 week" counts from whichever is later -- the code's current last
    // date or today -- or extending an expired code could leave it expired.
    const input = { value: '', disabled: true };
    const box = { checked: true };
    const sandbox = { document: { getElementById: (id) => (id === 'validity-date' ? input : box) }, Date };
    vm.createContext(sandbox);
    vm.runInContext(`${grab('istDateString')}\n${grab('extendDiscountValidityBy')}\nglobalThis.plus = extendDiscountValidityBy;`, sandbox);
    input.value = ist(-10); sandbox.plus(7);
    check('"+1 week" on an expired code counts from today', input.value === ist(7), input.value);
    input.value = ist(20); sandbox.plus(7);
    check('...and from the current last date when that is still ahead', input.value === ist(27), input.value);
    check('...and switches "No expiry" back off', box.checked === false && input.disabled === false);

    console.log('\n== A used code cannot be extended ==');
    // "Used": a personal code once its holder's registration carries it; a
    // shared code once it reaches its limit. A shared code with no limit is
    // never used up. A rejected registration does not hold a code.
    const w = openDb();
    const holds = async (code, status) => {
      const phone = '7' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
      await w.run(`INSERT INTO registrations (phone_number, delegate_name, category_key, category_label, bank_status, discount_code)
                   VALUES (?, 'Code Holder', ?, 'Fixture', ?, ?)`, [phone, cat.category_key, status, code]);
      return phone;
    };
    await issue({ code: `USEDP${N}`, discountType: 'PERCENT', discountValue: 30, scopeType: 'INDIVIDUAL', scopeValue: email, expiresAt: ist(-2) });
    const usedPersonal = await row(`USEDP${N}`);
    const holder = await holds(`USEDP${N}`, 'PENDING');
    const r1 = await setValidity(usedPersonal.id, ist(10));
    check('a personal code its holder has used: refused', r1.status === 409 && /already been used/.test(r1.body.error), r1.body);
    check('...and its date is untouched', (await row(`USEDP${N}`)).expires_at === ist(-2));
    await w.run("UPDATE registrations SET bank_status = 'REJECTED' WHERE phone_number = ?", [holder]);
    check('once that registration is rejected, it is unused again and can be extended',
      (await setValidity(usedPersonal.id, ist(10))).body.success === true);

    await issue({ code: `CAP${N}`, discountType: 'PERCENT', discountValue: 10, scopeType: 'GLOBAL', maxUses: 2, expiresAt: ist(-2) });
    const capped = await row(`CAP${N}`);
    await holds(`CAP${N}`, 'BANK_VERIFIED');
    check('a shared code with uses left can still be extended', (await setValidity(capped.id, ist(5))).body.success === true);
    await holds(`CAP${N}`, 'PENDING');
    const r2 = await setValidity(capped.id, ist(15));
    check('...but not once it has reached its limit', r2.status === 409, r2.body);

    await issue({ code: `ANY${N}`, discountType: 'PERCENT', discountValue: 5, scopeType: 'GLOBAL', expiresAt: ist(-2) });
    const unlimited = await row(`ANY${N}`);
    await holds(`ANY${N}`, 'BANK_VERIFIED');
    check('a shared code with no limit is never used up, so can be extended after use',
      (await setValidity(unlimited.id, ist(5))).body.success === true);
    check('switching a used code on or off is still allowed -- only its date is fixed',
      (await call('PUT', `/api/admin/discount-codes/${usedPersonal.id}`, { active: false }, admin)).body.success === true);
    await w.run("DELETE FROM registrations WHERE delegate_name = 'Code Holder'");
    w.close();

    console.log('\n== The list: Used instead of Expired, and Extend only where it applies ==');
    const cellSandbox = (mayManage) => {
      const sb = { can: () => mayManage, Date, Number, String };
      vm.createContext(sb);
      vm.runInContext(['esc', 'formatFullDate', 'istDateString', 'discountCodeUsedUp', 'discountExpiryCell']
        .map(grab).join('\n') + '\nglobalThis.cell = discountExpiryCell;', sb);
      return sb.cell;
    };
    const cell = cellSandbox(true);
    const usedExpired = cell({ id: 1, scope_type: 'INDIVIDUAL', applied_count: 1, expires_at: ist(-3) });
    check('a used personal code is tagged Used, not Expired', />Used</.test(usedExpired) && !/>Expired</.test(usedExpired));
    check('...and offers no Extend', !/Extend/.test(usedExpired));
    const usedValid = cell({ id: 2, scope_type: 'INDIVIDUAL', applied_count: 1, expires_at: ist(10) });
    check('a used code still in date is tagged Used too', />Used</.test(usedValid) && !/Extend/.test(usedValid));
    const cappedOut = cell({ id: 3, scope_type: 'GLOBAL', applied_count: 2, max_uses: 2, expires_at: ist(-1) });
    check('a shared code at its limit is Used', />Used</.test(cappedOut) && !/Extend/.test(cappedOut));
    const unusedExpired = cell({ id: 4, scope_type: 'INDIVIDUAL', applied_count: 0, expires_at: ist(-1) });
    check('an unused, expired code is Expired, with Extend', />Expired</.test(unusedExpired) && /Extend</.test(unusedExpired));
    const unusedValid = cell({ id: 5, scope_type: 'INDIVIDUAL', applied_count: 0, expires_at: ist(10) });
    check('an unused code still in date offers nothing to change', !/Extend|Change/.test(unusedValid) && !/>Expired</.test(unusedValid));
    const openShared = cell({ id: 6, scope_type: 'GLOBAL', applied_count: 9, max_uses: null, expires_at: ist(-1) });
    check('a shared code with no limit, used and expired, can still be extended', />Expired</.test(openShared) && /Extend</.test(openShared));
    const noRight = cellSandbox(false)({ id: 7, scope_type: 'INDIVIDUAL', applied_count: 0, expires_at: ist(-1) });
    check('without permission to manage codes, no Extend at all', />Expired</.test(noRight) && !/Extend/.test(noRight));
  } finally {
    const w = openDb();
    for (const code of made) await w.run('DELETE FROM discount_codes WHERE code = ?', [code]);
    w.close();
  }
  db.close();
  report();
})();
