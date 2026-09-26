// Registering a walk-in against the account they already have.
//
// Desk staff register delegates in person. When the delegate had already
// signed up, the only way to reach their account was to type a mobile number
// that happened to equal its key -- so a delegate who signed up by EMAIL
// (whose account has no phone) could never be reached, and got a second
// account. Now staff find them ("Already signed up?") and register against
// their account directly.
//
//   * the search finds people with an account and no registration -- not the
//     registered, not staff -- and is open to whoever may register walk-ins;
//   * registering against the account creates no second account and keeps
//     the account's own name and email;
//   * someone already registered, an unknown account and a staff account are
//     refused;
//   * typing a number for someone new still works as before.
const { call, check, report, ADMIN, ADMIN_PW, appFile, adminLogin, loginPassword, openDb } = require('./harness');
const fs = require('fs');

const N = String(Date.now()).slice(-7);
const base = { salutation: 'Dr', age: '41', gender: 'Female', designation: 'Nursing Officer',
  institute: 'Test Hospital', pincode: '442102', state: 'Maharashtra', district: 'Wardha' };

(async () => {
  const admin = await adminLogin();
  const desk = await loginPassword('9000000006', ADMIN_PW);       // FRONT_DESK: holds payments.desk_register
  const reviewer = await loginPassword('9000000003', ADMIN_PW);   // ACADEMIC_REVIEWER: does not
  const db = openDb({ readOnly: true });
  const walkIn = (body, cookie = desk) => call('POST', '/api/admin/registrations',
    { categoryKey: 'chw', optionIds: [], paymentMode: 'CASH', collectedBy: ADMIN, amount: 200, idVerifiedByAdmin: true, ...body }, cookie);

  // Someone who signed up by EMAIL, the case typing a number could never reach.
  const email = `walkin-${N}@example.test`;
  const otp = await call('POST', '/api/otp/request', { destination: email });
  const signed = await call('POST', '/api/auth/register',
    { ...base, name: `Signed Up ${N}`, country: 'United Kingdom', email, emailOtp: otp.body.devOtp, password: 'testpass123' });
  check('fixture: a delegate who signed up by email', signed.body.success === true, signed.body.error);
  const key = signed.body.user.phone_number;

  console.log('\n== "Already signed up?" finds them ==');
  const byEmail = await call('GET', `/api/desk/signups?q=${encodeURIComponent(email)}`, null, desk);
  check('the front desk may search', byEmail.status === 200, byEmail.status);
  check('...and finds them by email', (byEmail.body.results || []).some((r) => r.phone_number === key), byEmail.body);
  const byName = await call('GET', `/api/desk/signups?q=${encodeURIComponent('Signed Up ' + N)}`, null, desk);
  check('...or by name', (byName.body.results || []).some((r) => r.phone_number === key));
  const hit = (byEmail.body.results || []).find((r) => r.phone_number === key) || {};
  check('each result carries what the form shows', hit.full_name === `Signed Up ${N}` && hit.email === email && 'institution' in hit, hit);
  check('one letter is not enough to list anyone', ((await call('GET', '/api/desk/signups?q=a', null, desk)).body.results || []).length === 0);
  const registered = await db.get('SELECT r.phone_number, u.full_name FROM registrations r JOIN users u ON u.phone_number = r.phone_number LIMIT 1');
  const regSearch = await call('GET', `/api/desk/signups?q=${encodeURIComponent(registered.full_name)}`, null, desk);
  check('someone already registered is not offered', !(regSearch.body.results || []).some((r) => r.phone_number === registered.phone_number));
  const staff = await call('GET', '/api/desk/signups?q=Dez%20Counter', null, desk);
  check('nor is a staff account', !(staff.body.results || []).some((r) => r.phone_number === '9000000006'));
  check('a role that cannot register walk-ins cannot search', (await call('GET', '/api/desk/signups?q=Signed', null, reviewer)).status === 403);
  check('nor can anyone signed out', (await call('GET', '/api/desk/signups?q=Signed')).status === 401);

  console.log('\n== ...and registers them against the account they have ==');
  const usersBefore = (await db.get('SELECT COUNT(*) AS n FROM users')).n;
  const done = await walkIn({ accountKey: key });
  check('the walk-in is registered', done.body.success === true, done.body.error);
  const reg = await db.get('SELECT delegate_name, phone_number, payment_mode FROM registrations WHERE phone_number = ?', [key]);
  check('...on their existing account', !!reg && reg.phone_number === key, reg);
  check('...under the name they signed up with', reg && reg.delegate_name.includes(`Signed Up ${N}`), reg && reg.delegate_name);
  check('no second account was created', (await db.get('SELECT COUNT(*) AS n FROM users')).n === usersBefore);
  const acct = await db.get('SELECT email FROM users WHERE phone_number = ?', [key]);
  check('...and their account keeps its own email', acct.email === email, acct.email);
  const after = await call('GET', `/api/desk/signups?q=${encodeURIComponent(email)}`, null, desk);
  check('once registered, the search stops offering them', !(after.body.results || []).some((r) => r.phone_number === key));

  console.log('\n== What it refuses ==');
  const twice = await walkIn({ accountKey: key });
  check('registering them a second time', twice.status === 409 && /already has a registration/.test(twice.body.error), twice.body);
  const ghost = await walkIn({ accountKey: 'u_nobody_' + N });
  check('an account that does not exist', ghost.status === 404 && /could not be found/.test(ghost.body.error), ghost.body);
  const staffLink = await walkIn({ accountKey: '9000000003' });
  check('a staff account', staffLink.status === 404, staffLink.body);
  const byReviewer = await walkIn({ accountKey: key }, reviewer);
  check('a role that may not register walk-ins', byReviewer.status === 403, byReviewer.status);

  console.log('\n== Someone new is still registered by typing their details ==');
  const newPhone = '8' + N.padStart(9, '6');
  const fresh = await walkIn({ phone: newPhone, name: `New Walkin ${N}`, email: `new-walkin-${N}@example.test` });
  check('a brand-new walk-in still works', fresh.body.success === true, fresh.body.error);
  check('...creating their account', !!(await db.get('SELECT 1 FROM users WHERE phone_number = ?', [newPhone])));
  const badPhone = await walkIn({ phone: '12345', name: 'Nobody', email: `x-${N}@example.test` });
  check('...and a bad number is still refused when nobody is linked', badPhone.status === 400, badPhone.body);

  console.log('\n== The form and the Front Desk ==');
  const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
  const modal = fs.readFileSync(appFile('views', 'admin', 'modals', 'register-delegate.ejs'), 'utf8');
  check('the form offers "Already signed up?" before the details', modal.indexOf('id="rd-link-search"') > 0
    && modal.indexOf('id="rd-link-search"') < modal.indexOf('id="rd-phone"'));
  check('it searches the new endpoint', /fetch\(`\/api\/desk\/signups\?q=/.test(js));
  check('linking sends the account, not typed details', /rdLinkedAccount \? \{ accountKey: rdLinkedAccount\.phone_number \}/.test(js));
  check('linking hides the details and makes them optional, so the form can still submit',
    /for \(const id of \['rd-phone', 'rd-name'\]\) document\.getElementById\(id\)\.required = false;/.test(js));
  check('opening the form clears any earlier link', /function resetRegisterDelegateForm\(\) \{\n  unlinkRegisterDelegateAccount\(\);/.test(js));
  check('the desk card for a signed-up, unregistered person offers to register them',
    /canRegister \? deskBtn\('Register this delegate', 'registerDeskDelegate\(\)', 'primary'\)/.test(js));
  check('...only to someone who may', /const canRegister = can\('payments\.desk_register'\);/.test(js));

  db.close();
  report();
})();
