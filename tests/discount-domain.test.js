// An email-domain discount code (e.g. everyone at mgims.ac.in).
//
//   * It is for anyone whose email address is at the domain AND verified --
//     typing an address onto an account proves nothing; verifying it does.
//   * It is applied by itself on the payment form, like a personal code; it
//     is not spent by one delegate's use.
//   * The domain is accepted however it is typed ("@MGIMS.ac.in") and
//     stored bare; a value that is not a domain is refused.
//   * The MGIMS reminder template is offered on the Custom Recipients card.
const { call, check, report, appFile, adminLogin, openDb } = require('./harness');
const fs = require('fs');

const N = String(Date.now()).slice(-7);
const DOMAIN = `dom${N}.test`;
const base = { salutation: 'Dr', age: '40', gender: 'Male', designation: 'Professor',
  institute: 'Test College', pincode: '442102', state: 'Maharashtra', district: 'Wardha' };

(async () => {
  const admin = await adminLogin();
  const db = openDb();
  const made = [];
  const create = async (body) => { const r = await call('POST', '/api/admin/discount-codes', body, admin); if (r.body.success) made.push(body.code); return r; };
  const signUp = async (email, name) => {
    const otp = await call('POST', '/api/otp/request', { destination: email });
    const r = await call('POST', '/api/auth/register', { ...base, name, country: 'United Kingdom', email, emailOtp: otp.body.devOtp, password: 'testpass123' });
    return { key: r.body.user && r.body.user.phone_number, cookie: r.cookie };
  };
  const inside = await signUp(`faculty-${N}@${DOMAIN}`, `Domain In ${N}`);
  const unverified = await signUp(`faculty2-${N}@${DOMAIN}`, `Domain Unv ${N}`);
  const outside = await signUp(`outsider-${N}@example.test`, `Domain Out ${N}`);
  const lookalike = await signUp(`faculty-${N}@x${DOMAIN}`, `Domain Look ${N}`);
  check('fixture: four delegates', !!(inside.key && unverified.key && outside.key && lookalike.key));
  await db.run('UPDATE users SET email_verified = 0 WHERE phone_number = ?', [unverified.key]);

  try {
    console.log('\n== Making one ==');
    const made1 = await create({ code: `DOM${N}`, discountType: 'PERCENT', discountValue: 100, scopeType: 'DOMAIN', scopeValue: `@${DOMAIN.toUpperCase()}` });
    check('a Super Admin makes a domain code', made1.body.success === true, made1.body);
    const row = await db.get('SELECT scope_type, scope_value FROM discount_codes WHERE code = ?', [`DOM${N}`]);
    check('...the domain stored bare and lower-case, however typed', row.scope_type === 'DOMAIN' && row.scope_value === DOMAIN, row);
    for (const bad of ['', 'mgims', 'not a domain', 'a@b.com']) {
      const r = await create({ code: `DBAD${N}${bad.length}`, discountType: 'PERCENT', discountValue: 10, scopeType: 'DOMAIN', scopeValue: bad });
      check(`"${bad}" is refused as a domain`, r.body.success !== true && /email domain/.test(r.body.error || ''), r.body);
    }

    console.log('\n== Who may use it ==');
    const price = (who) => call('POST', '/api/discounts/validate', { code: `DOM${N}`, categoryKey: 'chw' }, who.cookie).then((r) => r.body);
    const ok = await price(inside);
    check('a verified address at the domain: accepted', ok.success === true && ok.discountAmount > 0, ok);
    const unv = await price(unverified);
    check('an address at the domain, not verified: asked to verify', unv.success === false && /Verify your email address/.test(unv.error), unv);
    const out = await price(outside);
    check('an address elsewhere: refused, naming the domain', out.success === false && out.error.includes(`@${DOMAIN} email addresses only`), out);
    check('...and a lookalike domain is elsewhere', (await price(lookalike)).success === false);

    console.log('\n== Applied by itself ==');
    const mine = (who) => call('GET', '/api/discounts/mine?categoryKey=chw', null, who.cookie).then((r) => r.body);
    const auto = await mine(inside);
    check('the payment form applies it, saying it is for their domain', auto.code && auto.code.code === `DOM${N}` && auto.code.scopeType === 'DOMAIN' && auto.code.domain === DOMAIN, auto);
    const waits = await mine(unverified);
    check('unverified: nothing applied, and told verifying will unlock a discount', !waits.code && waits.needsVerification === true, waits);
    check('elsewhere: nothing applied, nothing promised', !(await mine(outside)).code && !(await mine(outside)).needsVerification);

    const reg = await call('POST', '/api/registrations', { categoryKey: 'chw', optionIds: [], discountCode: `DOM${N}`, acknowledged: true, paymentMode: 'UPI' }, inside.cookie);
    check('they register with it (free, so no payment proof is needed here)', reg.body.success === true && reg.body.expectedAmount === 0, reg.body);
    const after = await db.get('SELECT active FROM discount_codes WHERE code = ?', [`DOM${N}`]);
    check('...and it stays active for the rest of the domain', after.active === 1);
    const listed = ((await call('GET', '/api/admin/discount-codes', null, admin)).body.codes || []).find((c) => c.code === `DOM${N}`);
    check('...not counted as one person\'s code their registration spent', listed && Number(listed.holder_registered) === 0, listed);

    console.log('\n== In the admin ==');
    const view = fs.readFileSync(appFile('views', 'admin', 'sections', 'discount.ejs'), 'utf8');
    const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
    check('"Email domain" is a scope to choose', view.includes('<option value="DOMAIN">Email domain</option>') && view.includes('id="new-disc-scope-domain"'));
    check('the list says whose it is', js.includes("c.scope_type === 'DOMAIN' ? `Email domain: @${esc(c.scope_value)}"));
    check('the MGIMS reminder is offered for pasted addresses and for the email-domain audience',
      /'mgims-register': \{\n\s*label: [^\n]+\n\s*audiences: \[\.\.\.NOT_REGISTERED, 'paste'\],/.test(js) && /const NOT_REGISTERED = \[[^\]]*'domain'/.test(js));
    const tpl = js.slice(js.indexOf('async function buildMgimsRegisterBody'), js.indexOf('\n}', js.indexOf('async function buildMgimsRegisterBody')));
    check('...addressed to a colleague, with no placeholder the custom send would leave in', /Dear Colleague/.test(tpl) && !/\{\{/.test(tpl));
    check('...with the bottle deadline, the @mgims.ac.in email and verifying it', /MGIMS_BOTTLE_DEADLINE/.test(tpl) && /@mgims\.ac\.in/.test(tpl) && /Verify your email/.test(tpl)
      && /const MGIMS_BOTTLE_DEADLINE = '2026-10-20';/.test(js));
  } finally {
    // Other tests expect every account to have a verified channel.
    await db.run('UPDATE users SET email_verified = 1 WHERE phone_number = ?', [unverified.key]);
    for (const code of made) await db.run('DELETE FROM discount_codes WHERE code = ?', [code]);
  }
  db.close();
  report();
})();
