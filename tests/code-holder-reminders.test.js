// Reminding people of a personal code they have not used.
//
// The audience is everyone holding a personal code they could still use:
// active, not used, in date, and not already registered (a registration made
// without the code cannot take it afterwards). A code still waiting on an
// address nobody has signed up with counts, written to at that address. One
// email per address, naming all of that person's codes.
const { call, check, report, ADMIN_PW, appFile, adminLogin, loginPassword, openDb } = require('./harness');
const fs = require('fs');
const vm = require('vm');

const N = String(Date.now()).slice(-7);
const ist = (days) => new Date(Date.now() + 5.5 * 3600e3 + days * 864e5).toISOString().slice(0, 10);
const base = { salutation: 'Dr', age: '38', gender: 'Female', designation: 'Consultant',
  institute: 'Test Hospital', pincode: '442102', state: 'Maharashtra', district: 'Wardha' };

(async () => {
  const admin = await adminLogin();
  const db = openDb();
  const made = [];
  const issue = async (body) => { const r = await call('POST', '/api/admin/discount-codes', body, admin); if (r.body.success) made.push(body.code); return r; };
  const signUp = async (email, name) => {
    const otp = await call('POST', '/api/otp/request', { destination: email });
    const r = await call('POST', '/api/auth/register', { ...base, name, country: 'United Kingdom', email, emailOtp: otp.body.devOtp, password: 'testpass123' });
    return r.body.user && r.body.user.phone_number;
  };
  const cat = await db.get('SELECT category_key, label FROM fee_categories WHERE active = 1 LIMIT 1');
  const holdsRegistration = (phone, code) => db.run(
    `INSERT INTO registrations (phone_number, delegate_name, category_key, category_label, bank_status, discount_code)
     VALUES (?, 'Holder', ?, ?, 'PENDING', ?)`, [phone, cat.category_key, cat.label, code]);
  const used = []; // registrations made here, removed at the end

  const aMail = `holder-a-${N}@example.test`;
  const bMail = `holder-b-${N}@example.test`;
  const cMail = `holder-c-${N}@example.test`;
  const dMail = `holder-d-${N}@example.test`;
  const wMail = `holder-w-${N}@example.test`;
  const A = await signUp(aMail, `Holder A ${N}`);
  const B = await signUp(bMail, `Holder B ${N}`);
  const C = await signUp(cMail, `Holder C ${N}`);
  const D = await signUp(dMail, `Holder D ${N}`);
  check('fixture: four delegates who signed up', !!(A && B && C && D));

  try {
    await issue({ code: `HA1${N}`, discountType: 'FEE_TIER', feeTier: 'early', scopeType: 'INDIVIDUAL', scopeValue: aMail, expiresAt: ist(10) });
    await issue({ code: `HA2${N}`, discountType: 'PERCENT', discountValue: 20, scopeType: 'INDIVIDUAL', scopeValue: A, expiresAt: ist(20) });
    await issue({ code: `HA3${N}`, discountType: 'PERCENT', discountValue: 90, scopeType: 'INDIVIDUAL', scopeValue: A, expiresAt: ist(-1) });
    await issue({ code: `HB${N}`, discountType: 'PERCENT', discountValue: 10, scopeType: 'INDIVIDUAL', scopeValue: B });
    const hb = await db.get('SELECT id FROM discount_codes WHERE code = ?', [`HB${N}`]);
    await call('PUT', `/api/admin/discount-codes/${hb.id}`, { active: false }, admin);
    await issue({ code: `HC${N}`, discountType: 'PERCENT', discountValue: 10, scopeType: 'INDIVIDUAL', scopeValue: C });
    await holdsRegistration(C, `HC${N}`); used.push(C);
    await issue({ code: `HD${N}`, discountType: 'PERCENT', discountValue: 10, scopeType: 'INDIVIDUAL', scopeValue: D });
    await holdsRegistration(D, null); used.push(D);
    await issue({ code: `HW${N}`, discountType: 'FEE_TIER', feeTier: 'regular', scopeType: 'INDIVIDUAL', scopeValue: wMail, expiresAt: ist(5) });
    await issue({ code: `HALL${N}`, discountType: 'PERCENT', discountValue: 5, scopeType: 'GLOBAL' });

    console.log('\n== Who is on the list ==');
    const list = await call('GET', '/api/admin/reminders/code-holders', null, admin);
    check('the list responds', list.status === 200, list.status);
    const people = list.body.recipients || [];
    const find = (mail) => people.find((p) => p.email === mail);
    const a = find(aMail);
    check('someone with unused codes is on it', !!a, people.map((p) => p.email));
    check('...once, though they hold two', people.filter((p) => p.email === aMail).length === 1);
    check('...with both of the codes they can still use', !!a && JSON.stringify(a.codes.map((c) => c.code).sort()) === JSON.stringify([`HA1${N}`, `HA2${N}`].sort()), a && a.codes);
    check('...but not their expired one', !!a && !a.codes.some((c) => c.code === `HA3${N}`));
    check('...each code saying what it gives', !!a && a.codes.some((c) => c.discount === 'Pay the Early Bird fee') && a.codes.some((c) => c.discount === '20% off'), a && a.codes);
    check('...and greeted by name', !!a && a.name === `Dr Holder A ${N}`, a && a.name);
    const w = find(wMail);
    check('someone not yet signed up is on it, at the address the code was issued to', !!w && w.waiting === true && w.name === null, w);
    check('a holder whose only code is deactivated is not', !find(bMail));
    check('nor one whose code has been used', !find(cMail));
    check('nor one who has already registered without it', !find(dMail));
    check('a shared code is nobody\'s to be reminded of', !people.some((p) => p.codes.some((c) => c.code === `HALL${N}`)));

    console.log('\n== Who may see and send ==');
    const desk = await loginPassword('9000000006', ADMIN_PW);
    check('the front desk cannot see the list', (await call('GET', '/api/admin/reminders/code-holders', null, desk)).status === 403);
    check('...nor send to it', (await call('POST', '/api/admin/reminders/code-holders/send', { subject: 's', bodyHtml: '{{codes}}', emails: [aMail] }, desk)).status === 403);
    check('...nor anyone signed out', (await call('GET', '/api/admin/reminders/code-holders')).status === 401);

    console.log('\n== A send must carry each person\'s codes ==');
    const noCodes = await call('POST', '/api/admin/reminders/code-holders/send', { subject: 'Hi', bodyHtml: '<p>Dear {{name}}</p>', emails: [aMail] }, admin);
    check('an email without {{codes}} is refused -- nobody would learn their code', noCodes.status === 400 && /\{\{codes\}\}/.test(noCodes.body.error), noCodes.body);
    const noTestCodes = await call('POST', '/api/admin/reminders/code-holders/test-send', { subject: 'Hi', bodyHtml: '<p>x</p>' }, admin);
    check('...the test send too', noTestCodes.status === 400 && /\{\{codes\}\}/.test(noTestCodes.body.error));
    const noSubject = await call('POST', '/api/admin/reminders/code-holders/send', { bodyHtml: '{{codes}}', emails: [aMail] }, admin);
    check('no subject, no send', noSubject.status === 400 && /Subject/.test(noSubject.body.error));
    const noEmail = await call('POST', '/api/admin/reminders/code-holders/send', { subject: 'Hi', bodyHtml: '{{codes}}', emails: [aMail] }, admin);
    check('with email switched off it says so, rather than claiming to have sent', noEmail.status === 400 && /Email is not configured/.test(noEmail.body.error), noEmail.body);

    console.log('\n== What each person receives ==');
    // The server's own builder, run here: email is off in the fixture.
    const src = fs.readFileSync(appFile('server.js'), 'utf8');
    const grab = (n) => { const i = src.indexOf(`function ${n}(`); return src.slice(i, src.indexOf('\n}', i) + 2); };
    const months = (src.match(/const LONG_MONTHS = \[[^\]]+\];/) || [])[0];
    const sb = {};
    vm.createContext(sb);
    vm.runInContext(`${grab('escapeHtml')}\n${months}\n${grab('formatFullDayDate')}\n${grab('codeHolderCodesHtml')}\n${grab('renderCodeHolderEmail')}\nglobalThis.render = renderCodeHolderEmail;`, sb);
    const body = '<p>Dear {{name}},</p>{{codes}}';
    const forA = sb.render(body, { name: 'Dr <b>Ada</b>', codes: [
      { code: 'HA1X', discount: 'Pay the Early Bird fee', validUntil: '2026-10-15', waiting: false },
      { code: 'HA2X', discount: '20% off', validUntil: null, waiting: false }] });
    check('their name goes in, escaped', forA.includes('Dear Dr &lt;b&gt;Ada&lt;/b&gt;,'), forA.slice(0, 60));
    check('each of their codes gets its own block', (forA.match(/font-family:ui-monospace/g) || []).length === 2 && forA.includes('HA1X') && forA.includes('HA2X'));
    check('...saying what it gives', forA.includes('Pay the Early Bird fee') && forA.includes('20% off'));
    check('...and its last date, weekday included', forA.includes('Valid through Thursday, 15 October 2026'), forA);
    check('...or that it does not expire', forA.includes('No expiry date'));
    check('...with no sign-up note for someone who already has an account', !forA.includes('Sign up with this email address'));
    const forW = sb.render(body, { name: null, codes: [{ code: 'HWX', discount: 'Pay the Regular fee', validUntil: '2026-10-20', waiting: true }] });
    check('someone not yet signed up is greeted without a name', forW.includes('Dear Colleague,'));
    check('...and told to sign up with this address to use it', forW.includes('Sign up with this email address to use it'));

    console.log('\n== The card ==');
    const view = fs.readFileSync(appFile('views', 'admin', 'sections', 'reminders.ejs'), 'utf8');
    const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
    check('Reminders has an "Unused Personal Codes" card', view.includes('Unused Personal Codes') && view.includes('id="codeholders-list"'));
    check('its ready-made email carries {{codes}}', /function codeHolderDefaultBody\(\)[\s\S]{0,400}\{\{codes\}\}/.test(js));
    check('sending without {{codes}} is stopped before it reaches the server too', /if \(!bodyHtml\.includes\('\{\{codes\}\}'\)\)/.test(js));
    check('...and asks before sending', /showConfirm\(`Send this reminder to \$\{emails\.length\}/.test(js));
  } finally {
    for (const phone of used) await db.run('DELETE FROM registrations WHERE phone_number = ?', [phone]);
    for (const code of made) await db.run('DELETE FROM discount_codes WHERE code = ?', [code]);
  }
  db.close();
  report();
})();
