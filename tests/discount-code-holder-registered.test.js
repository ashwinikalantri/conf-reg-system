// A personal code is deactivated once its holder registers without it.
//
// A registration cannot take a code afterwards, so a personal code its holder
// did not use is spent the moment they register -- yet it went on reading
// "Unused", in the list, the reminder audience and every count. Now it is
// deactivated as the registration is made (and by a sweep at start-up for
// anything registered before this). The code they DID use stays active: a
// rejected registration is validated again on resubmission, and an inactive
// code would be refused.
const { call, check, report, ADMIN, ADMIN_PW, appFile, adminLogin, loginPassword, openDb } = require('./harness');
const fs = require('fs');
const vm = require('vm');

const N = String(Date.now()).slice(-7);
const base = { salutation: 'Dr', age: '35', gender: 'Female', designation: 'Consultant',
  institute: 'Test Hospital', pincode: '442102', state: 'Maharashtra', district: 'Wardha' };

(async () => {
  const admin = await adminLogin();
  const desk = await loginPassword('9000000006', ADMIN_PW);
  const db = openDb();
  const made = [];
  const issue = async (body) => { const r = await call('POST', '/api/admin/discount-codes', body, admin); if (r.body.success) made.push(body.code); return r; };
  const row = (code) => db.get('SELECT id, active FROM discount_codes WHERE code = ?', [code]);
  const signUp = async (email, name) => {
    const otp = await call('POST', '/api/otp/request', { destination: email });
    const r = await call('POST', '/api/auth/register', { ...base, name, country: 'United Kingdom', email, emailOtp: otp.body.devOtp, password: 'testpass123' });
    return { key: r.body.user && r.body.user.phone_number, cookie: r.cookie };
  };
  const aMail = `retire-a-${N}@example.test`;
  const A = await signUp(aMail, `Retire A ${N}`);
  const B = await signUp(`retire-b-${N}@example.test`, `Retire B ${N}`);
  const C = await signUp(`retire-c-${N}@example.test`, `Retire C ${N}`);
  check('fixture: three delegates', !!(A.key && B.key && C.key));

  try {
    await issue({ code: `AUSE${N}`, discountType: 'PERCENT', discountValue: 100, scopeType: 'INDIVIDUAL', scopeValue: A.key });
    await issue({ code: `ASPARE${N}`, discountType: 'PERCENT', discountValue: 10, scopeType: 'INDIVIDUAL', scopeValue: A.key });
    await issue({ code: `ATIER${N}`, discountType: 'FEE_TIER', feeTier: 'early', scopeType: 'INDIVIDUAL', scopeValue: aMail });
    await issue({ code: `BSPARE${N}`, discountType: 'PERCENT', discountValue: 10, scopeType: 'INDIVIDUAL', scopeValue: B.key });
    await issue({ code: `CKEEP${N}`, discountType: 'PERCENT', discountValue: 10, scopeType: 'INDIVIDUAL', scopeValue: C.key });

    console.log('\n== A delegate registers, using one of their codes ==');
    const reg = await call('POST', '/api/registrations', { categoryKey: 'chw', optionIds: [], discountCode: `AUSE${N}`, acknowledged: true, paymentMode: 'UPI' }, A.cookie);
    check('fixture: they register, free with their 100% code', reg.body.success === true && reg.body.expectedAmount === 0, reg.body);
    check('the code they used stays active -- it is checked again on any resubmission', (await row(`AUSE${N}`)).active === 1);
    check('their other personal code is deactivated', (await row(`ASPARE${N}`)).active === 0);
    check('...and so is a tier code issued to their email', (await row(`ATIER${N}`)).active === 0);
    const spare = await row(`ASPARE${N}`);
    const logged = await db.get("SELECT new_value, actor_phone, actor_role FROM audit_log WHERE entity_type = 'discount_code' AND entity_id = ? AND action = 'DISCOUNT_CODE_DEACTIVATED'", [String(spare.id)]);
    check('each is in the activity log, with the reason', !!logged && /holder registered without it/.test(logged.new_value), logged);
    check('...credited to the system, not to the delegate who registered', !!logged && logged.actor_phone === 'system' && logged.actor_role === 'SYSTEM', logged);
    check('someone else\'s code is untouched', (await row(`CKEEP${N}`)).active === 1);

    console.log('\n== The desk registers someone, with no code at all ==');
    const walk = await call('POST', '/api/admin/registrations', { accountKey: B.key, categoryKey: 'chw', optionIds: [],
      paymentMode: 'CASH', collectedBy: ADMIN, amount: 200, idVerifiedByAdmin: true }, desk);
    check('fixture: the walk-in is registered', walk.body.success === true, walk.body.error);
    check('their unused personal code is deactivated too', (await row(`BSPARE${N}`)).active === 0);
    check('...and still nobody else\'s', (await row(`CKEEP${N}`)).active === 1);

    console.log('\n== In the list ==');
    const codes = (await call('GET', '/api/admin/discount-codes', null, admin)).body.codes || [];
    const spareRow = codes.find((c) => c.code === `ASPARE${N}`);
    check('the list knows its holder has registered', spareRow && Number(spareRow.holder_registered) === 1, spareRow);
    check('...but a code whose holder has not, does not say so', Number((codes.find((c) => c.code === `CKEEP${N}`) || {}).holder_registered) === 0);
    const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
    const grab = (n) => { const i = js.indexOf(`function ${n}(`); return js.slice(i, js.indexOf('\n}', i) + 2); };
    const sb = { can: () => true, Date, Number };
    vm.createContext(sb);
    vm.runInContext(['esc', 'formatFullDate', 'istDateString', 'discountCodeUsedUp', 'discountExpiryCell'].map(grab).join('\n')
      + '\nglobalThis.cell = discountExpiryCell; globalThis.usedUp = discountCodeUsedUp;', sb);
    check('it counts as done, so it sits with the Used codes', sb.usedUp(spareRow) === true);
    const cellHtml = sb.cell(spareRow);
    check('...tagged "Holder registered", not "Used"', />Holder registered</.test(cellHtml) && !/>Used</.test(cellHtml), cellHtml);
    check('...with nothing to extend', !/Extend/.test(cellHtml));
    const usedHtml = sb.cell(codes.find((c) => c.code === `AUSE${N}`));
    check('the code they used still reads "Used"', />Used</.test(usedHtml) && !/Holder registered/.test(usedHtml));

    console.log('\n== It cannot be extended, but an admin can still switch it back on ==');
    const ext = await call('PUT', `/api/admin/discount-codes/${spare.id}`, { expiresAt: '2099-12-31' }, admin);
    check('changing its validity is refused', ext.status === 409, ext.body);
    const on = await call('PUT', `/api/admin/discount-codes/${spare.id}`, { active: true }, admin);
    check('activating it again is still an admin\'s call', on.body.success === true && (await row(`ASPARE${N}`)).active === 1);

    console.log('\n== Registered before this existed ==');
    const src = fs.readFileSync(appFile('server.js'), 'utf8');
    check('a sweep at every start applies the same rule to everyone already registered',
      /\.then\(\(\) => retireCodesOfRegisteredHoldersOnBoot\(\)\.catch/.test(src));
    check('...skipping rejected registrations', /SELECT phone_number, discount_code FROM registrations WHERE bank_status != 'REJECTED'/.test(src));
    check('every path that creates a registration applies it', (src.match(/await retireHolderCodesOnRegistration\(phone, discountCodeApplied\);/g) || []).length === 3);
  } finally {
    for (const p of [A.key, B.key]) {
      const r = await db.get('SELECT id FROM registrations WHERE phone_number = ?', [p]);
      if (r) {
        await db.run('DELETE FROM payment_transactions WHERE registration_id = ?', [r.id]);
        await db.run('DELETE FROM registration_selections WHERE registration_id = ?', [r.id]).catch(() => {});
        await db.run('DELETE FROM registrations WHERE id = ?', [r.id]);
      }
    }
    for (const code of made) await db.run('DELETE FROM discount_codes WHERE code = ?', [code]);
  }
  db.close();
  report();
})();
