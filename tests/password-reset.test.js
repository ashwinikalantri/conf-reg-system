// A delegate at the counter who cannot get into their account is the
// commonest thing a front desk has to fix, and until now there was no way to
// fix it: staff could change what an account said, but not who could get into
// it. Resetting hands out a ONE-TIME password.
//
// Three properties carry the weight here, and each is a way this could be
// built wrongly:
//
//   * The value comes back exactly once and is never recoverable. It is
//     stored as a scrypt hash and deliberately kept out of the audit log --
//     a log that records the new password would be worse than no log.
//   * A member of staff must never end up holding a credential that keeps
//     working. The reset raises password_reset_required, and the portal will
//     not let the delegate past the set-password prompt until they choose
//     their own.
//   * Only the delegate choosing a password satisfies it. Staff resetting a
//     second time issues another temporary one; it cannot clear the
//     requirement.
const { call, check, report, ADMIN_PW, appFile, adminLogin, loginPassword, openDb } = require('./harness');
const fs = require('fs');
const vm = require('vm');

const DESK = '9000000006';      // FRONT_DESK -- holds users.reset_password
const REVIEWER = '9000000003';  // ACADEMIC_REVIEWER -- holds nothing of the sort
const OPS = '9000000004';       // OPERATIONS -- sees Users, but was not granted this
const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
const N = String(Date.now() % 100000000).padStart(8, '0');

// app.js reads localStorage and the DOM as it loads, so a bare sandbox throws
// before any of it is defined. This is the same minimal stub the other
// client-side tests use, plus a collector the prompt stubs push into.
function promptSandbox(collected) {
  const el = () => ({ id: '', value: '', innerHTML: '', textContent: '', style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, setAttribute() {}, getAttribute: () => null,
    focus() {}, appendChild() {}, remove() {}, querySelector: () => null, querySelectorAll: () => [] });
  const doc = { getElementById: () => el(), querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, createElement: el, body: el(), documentElement: el(),
    readyState: 'loading', cookie: '' };
  const sandbox = {
    document: doc,
    window: { addEventListener() {}, location: { href: '', hash: '', pathname: '/', search: '' },
      matchMedia: () => ({ matches: false, addEventListener() {} }), history: { replaceState() {} } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node' },
    fetch: () => Promise.reject(new Error('no network')),
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, URL, Intl, Date, Math, JSON, Promise,
    requestAnimationFrame: (f) => setTimeout(f, 0),
    __o: collected,
  };
  sandbox.window.document = doc; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

(async () => {
  const admin = await adminLogin();
  const desk = await loginPassword(DESK, ADMIN_PW);
  const reviewer = await loginPassword(REVIEWER, ADMIN_PW);
  const ops = await loginPassword(OPS, ADMIN_PW);
  const db = openDb();

  // A delegate with a password they know, so "the old one stops working" is
  // something this file can actually demonstrate rather than assume.
  const phone = `96${N}`;
  const made = await call('POST', '/api/users', {
    phone, name: 'Reset Target', email: `rt-${N}@example.test`, role: 'DELEGATE',
  }, admin);
  check('fixture: a delegate exists', made.status === 200 || made.status === 201,
    [made.status, made.body.error]);
  const key = made.body.user ? made.body.user.phone_number : phone;
  await db.run("UPDATE users SET phone_verified = 1 WHERE phone_number = ?", [key]);

  console.log('\n== Who may hand out a credential ==');
  const byReviewer = await call('POST', `/api/users/${key}/reset-password`, {}, reviewer);
  check('an academic reviewer cannot', byReviewer.status === 403, byReviewer.status);
  // Operations can open Users & Roles and change somebody's role, but was
  // deliberately not granted this: seeing an account is not the same as being
  // able to get into it.
  const byOps = await call('POST', `/api/users/${key}/reset-password`, {}, ops);
  check('nor can Operations, which can see Users but was not granted it', byOps.status === 403, byOps.status);
  const anon = await call('POST', `/api/users/${key}/reset-password`, {});
  check('nor an anonymous caller', anon.status === 401, anon.status);
  const missing = await call('POST', '/api/users/9999999999/reset-password', {}, desk);
  check('an unknown account is a 404, not a crash', missing.status === 404, missing.status);

  console.log('\n== The desk resets, and is given the value exactly once ==');
  const before = await db.get('SELECT password_hash, password_reset_required FROM users WHERE phone_number = ?', [key]);
  const reset = await call('POST', `/api/users/${key}/reset-password`, {}, desk);
  check('the reset succeeds', reset.status === 200 && reset.body.success, reset.body.error);
  check('...returning a one-time password', typeof reset.body.tempPassword === 'string'
    && reset.body.tempPassword.length >= 8, reset.body.tempPassword);
  check('...and naming who it is for, so the desk can read it back',
    reset.body.name === 'Reset Target', reset.body.name);
  // Read out loud or written on paper, so the alphabet excludes the glyphs
  // that get confused doing exactly that.
  check('the value avoids characters that are misread aloud or on paper',
    !/[01OIl]/.test(reset.body.tempPassword), reset.body.tempPassword);

  const after = await db.get('SELECT password_hash, password_reset_required FROM users WHERE phone_number = ?', [key]);
  check('the stored password actually changed', after.password_hash !== before.password_hash);
  check('...and is not the value in plaintext',
    !String(after.password_hash).includes(reset.body.tempPassword), String(after.password_hash).slice(0, 40));
  check('the account is flagged as owing a password', after.password_reset_required === 1,
    after.password_reset_required);

  console.log('\n== It is audited, without recording the password ==');
  const entry = await db.get(
    "SELECT action, new_value, actor_name FROM audit_log WHERE entity_type = 'user' AND entity_id = ? AND action = 'PASSWORD_RESET' ORDER BY id DESC LIMIT 1",
    [key]);
  check('the reset is in the log', !!entry, entry);
  check('...attributed to whoever did it', !!entry && !!entry.actor_name, entry && entry.actor_name);
  // A log that recorded the new password would be worse than no log at all.
  check('...and the log does NOT contain the password',
    !!entry && !String(entry.new_value || '').includes(reset.body.tempPassword), entry && entry.new_value);
  const anywhere = await db.get(
    "SELECT COUNT(*) AS n FROM audit_log WHERE new_value LIKE ? OR old_value LIKE ?",
    [`%${reset.body.tempPassword}%`, `%${reset.body.tempPassword}%`]);
  check('...nor does any other row of it', anywhere.n === 0, anywhere.n);

  console.log('\n== The delegate can sign in with it, and only with it ==');
  const withTemp = await call('POST', '/api/auth/login-password',
    { identifier: key, password: reset.body.tempPassword });
  check('the one-time password works', withTemp.body.success === true, withTemp.body.error);
  const cookie = withTemp.cookie;
  const withOld = await call('POST', '/api/auth/login-password', { identifier: key, password: 'testpass123' });
  check('...and whatever they had before does not', withOld.body.success !== true, withOld.body);

  console.log('\n== ...and is then made to choose their own ==');
  const me = await call('GET', '/api/auth/me', null, cookie);
  check('the session reports the requirement', me.body.user.password_reset_required === 1,
    me.body.user.password_reset_required);

  // Only the delegate setting one clears it. A second staff reset issues
  // another temporary password -- it must not count as satisfying the first.
  const second = await call('POST', `/api/users/${key}/reset-password`, {}, desk);
  check('a second staff reset still leaves the requirement standing',
    second.body.success === true, second.body.error);
  const stillOwed = await db.get('SELECT password_reset_required FROM users WHERE phone_number = ?', [key]);
  check('...it is not something staff can clear for them', stillOwed.password_reset_required === 1,
    stillOwed.password_reset_required);

  const relogin = await call('POST', '/api/auth/login-password',
    { identifier: key, password: second.body.tempPassword });
  check('the newer one-time password works', relogin.body.success === true, relogin.body.error);
  const older = await call('POST', '/api/auth/login-password',
    { identifier: key, password: reset.body.tempPassword });
  check('...and the first one has stopped working', older.body.success !== true, older.body);

  const chose = await call('POST', '/api/auth/set-password', { password: 'their-own-choice-99' }, relogin.cookie);
  check('the delegate can set their own', chose.body.success === true, chose.body.error);
  const settled = await db.get('SELECT password_reset_required FROM users WHERE phone_number = ?', [key]);
  check('...and that is what clears the requirement', settled.password_reset_required === 0,
    settled.password_reset_required);
  const meAfter = await call('GET', '/api/auth/me', null, relogin.cookie);
  check('...as the session agrees', !meAfter.body.user.password_reset_required);
  const withOwn = await call('POST', '/api/auth/login-password',
    { identifier: key, password: 'their-own-choice-99' });
  check('their own password now signs them in', withOwn.body.success === true, withOwn.body.error);
  const tempGone = await call('POST', '/api/auth/login-password',
    { identifier: key, password: second.body.tempPassword });
  check('...and the temporary one is dead, so no member of staff still holds a way in',
    tempGone.body.success !== true, tempGone.body);

  console.log('\n== The portal will not let a reset account past the prompt ==');
  // The server flag is only half of it; this is the half the delegate meets.
  // currentDelegate is a top-level `let`, so it only takes a value from
  // inside the same script; the two prompt functions are stubbed there for
  // the same reason.
  const opened = [];
  const sandbox = promptSandbox(opened);
  vm.runInContext(`${js}
    currentDelegate = { role: 'DELEGATE', hasPassword: true, password_reset_required: 1, email_verified: 1 };
    openSetPasswordModal = (mandatory, reason) => { globalThis.__o.push([mandatory, reason]); };
    promptVerifyEmailIfNeeded = () => { globalThis.__o.push(['email']); };
    runPostLoginPrompts();
  `, sandbox, { filename: 'app.js+driver' });
  check('a reset account is sent straight to the password prompt',
    opened.length > 0 && opened[0][0] === true, opened);
  check('...told it was a reset, not asked as though they never had one',
    opened.length > 0 && opened[0][1] === 'reset', opened[0]);
  check('...and is not offered the email prompt instead',
    !opened.some((o) => o[0] === 'email'), opened);

  console.log('\n== An account that simply never had one is asked differently ==');
  const opened2 = [];
  const sb2 = promptSandbox(opened2);
  vm.runInContext(`${js}
    currentDelegate = { role: 'DELEGATE', hasPassword: false, password_reset_required: 0, email_verified: 1 };
    openSetPasswordModal = (mandatory, reason) => { globalThis.__o.push([mandatory, reason]); };
    promptVerifyEmailIfNeeded = () => { globalThis.__o.push(['email']); };
    runPostLoginPrompts();
  `, sb2, { filename: 'app.js+driver' });
  check('still mandatory', opened2.length > 0 && opened2[0][0] === true, opened2);
  check('...but not described as a reset', opened2.length > 0 && opened2[0][1] === undefined, opened2[0]);

  console.log('\n== The button is only where the permission is ==');
  check('the desk offers it behind users.reset_password',
    /can\('users\.reset_password'\)[\s\S]{0,200}resetUserPassword/.test(js));
  check('the Users panel offers it behind the same key',
    (js.match(/can\('users\.reset_password'\)/g) || []).length >= 2,
    (js.match(/can\('users\.reset_password'\)/g) || []).length);
  check('the one-time value is shown in a panel that waits, not a toast that slides away',
    /function showTempPassword/.test(js) && /modal-temp-password/.test(js));
  check('...and the confirm says the current password stops working',
    /stops working immediately/.test(js));

  db.close();
  report();
})();
