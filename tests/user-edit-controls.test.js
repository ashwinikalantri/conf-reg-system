// The Users panel's edit form was ten free-text boxes, including the two that
// are not descriptions of a person at all: the mobile number and the email
// address. Those are the channels the system reaches somebody through and,
// once verified, how they prove who they are -- so a verified address sat in
// a plain box beside an age, with nothing saying it had been proved and
// nothing warning that editing it silently withdraws that proof.
//
// Contact is now its own section with per-channel Edit and a verified pill.
// The rest of the form offers the sets it should: designation and institute
// from the directory, gender from the same three the signup form uses, and
// state and district filled from the PIN code rather than typed.
//
// It drives the SIGNUP form's helpers through their id prefix rather than
// growing a third copy of them -- signup, the front desk and this panel now
// share one implementation of the pincode fallback and the Other escape.
const { call, check, report, ADMIN_PW, appFile, adminLogin, loginPassword, openDb } = require('./harness');
const fs = require('fs');
const vm = require('vm');

const DESK = '9000000006';   // FRONT_DESK: users.edit but NOT users.view
const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');

function harness(user, directory, perms) {
  const els = {};
  const mk = (id) => (els[id] = els[id] || {
    id, value: '', innerHTML: '', textContent: '', readOnly: false, attrs: {}, options: [],
    classList: { c: new Set(/-other$/.test(id) ? ['hidden'] : []),
      add(k) { this.c.add(k); }, remove(k) { this.c.delete(k); },
      toggle(k, on) { on ? this.c.add(k) : this.c.delete(k); }, contains(k) { return this.c.has(k); } },
    dataset: {}, style: {}, focus() {}, select() {},
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
    appendChild() {}, remove() {}, addEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
  });
  const doc = {
    getElementById: mk, querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, createElement: () => mk('c'),
    body: mk('b'), documentElement: mk('h'), readyState: 'loading', cookie: '',
  };
  const sent = [];
  const sandbox = {
    document: doc,
    window: { addEventListener() {}, location: { href: '', hash: '', pathname: '/', search: '' },
      matchMedia: () => ({ matches: false, addEventListener() {} }), history: { replaceState() {} } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node' },
    fetch: (url, opts) => {
      sent.push({ url, opts });
      if (String(url).includes('/api/directory/suggestions')) {
        return Promise.resolve({ ok: true, json: async () => directory });
      }
      return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
    },
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, URL, Intl, Date, Math, JSON, Promise,
    requestAnimationFrame: (f) => setTimeout(f, 0),
  };
  sandbox.window.document = doc; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // myPermissions, userDetailPhone and userDetailData are top-level `let`s, so
  // they only take a value from inside the same script.
  vm.runInContext(`${js}
    myPermissions = new Set(${JSON.stringify(perms || ['users.view', 'users.edit'])});
    userDetailPhone = ${JSON.stringify(user.phone_number)};
    userDetailData = { user: ${JSON.stringify(user)}, registration: null, payment: null, selections: [], signup_at: null };
  `, sandbox, { filename: 'app.js+driver' });
  return { sandbox, els, sent };
}

const DIRECTORY = {
  designations: ['Assistant Professor', 'Junior Resident'],
  institutions: ['MGIMS Sevagram', 'AIIMS, Nagpur'],
};
const USER = (over) => ({
  phone_number: '9000009901', full_name: 'Asha Patil', salutation: 'Dr',
  email: 'asha@example.test', email_verified: 0, phone: '+919000009901', phone_verified: 0,
  age: 41, gender: 'Female', designation: 'Junior Resident', institution: 'MGIMS Sevagram',
  pincode: '442102', state: 'Maharashtra', district: 'Wardha', role: 'DELEGATE', ...(over || {}),
});
const tick = () => new Promise((r) => setTimeout(r, 10));
// Eight digits, so a two-character prefix plus N is exactly the ten a valid
// Indian mobile needs. Padded, so a small remainder cannot quietly produce a
// nine-digit number and fail these assertions for a reason unrelated to them.
const N = String(Date.now() % 100000000).padStart(8, '0');

(async () => {
  const admin = await adminLogin();
  const desk = await loginPassword(DESK, ADMIN_PW);

  console.log('\n== 1. State and district come from the PIN code ==');
  const h = harness(USER(), DIRECTORY);
  const form = h.sandbox.userDetailEditForm(USER());
  check('the PIN drives the lookup, with this form\'s prefix',
    /id="ude-pincode"[^>]*oninput="fetchAddressDetails\(this\.value, 'ude'\)"/.test(form),
    (form.match(/id="ude-pincode"[^>]*/) || [])[0]);
  check('state is read-only', /id="ude-state"[^>]*readonly/.test(form));
  check('district is read-only', /id="ude-district"[^>]*readonly/.test(form));
  check('there is somewhere to say what the PIN resolved to', form.includes('id="ude-pincode-status"'));
  h.sandbox.setAddressFieldsEditable(true, 'ude');
  check('a PIN we cannot NAME unlocks them rather than stranding the edit',
    h.els['ude-state'].readOnly === false && h.els['ude-district'].readOnly === false);
  h.sandbox.setAddressFieldsEditable(false, 'ude');
  check('...and they lock again when one resolves', h.els['ude-state'].readOnly === true);

  console.log('\n== ...and only a real PIN code is accepted, by the server ==');
  // The form talking to a lookup is a convenience; this is the rule. Before
  // this, signup refused an unknown PIN and an edit could put one straight
  // back.
  const bad = await call('PUT', '/api/users/9000001001', { pincode: '999999' }, admin);
  check('an unrecognised PIN is refused', bad.status === 400, [bad.status, bad.body.error]);
  check('...by name', /not a PIN code we recognise/.test(bad.body.error || ''), bad.body.error);
  const malformed = await call('PUT', '/api/users/9000001001', { pincode: '12' }, admin);
  check('a malformed one too', malformed.status === 400, malformed.status);
  const good = await call('PUT', '/api/users/9000001001', { pincode: '442102' }, admin);
  check('a real one goes through', good.status === 200 && good.body.success, good.body.error);

  console.log('\n== 2. Gender is a selection ==');
  check('it is a select', /<select id="ude-gender"/.test(form));
  check('with the three the signup form offers',
    ['Male', 'Female', 'Other'].every((g) => form.includes(`<option value="${g}"`)));
  check('...and this person\'s preselected', /<option value="Female" selected>/.test(form));

  console.log('\n== 3. Contact is its own section, with proof and its own Edit ==');
  check('email is NOT in the demography form any more', !/id="ude-email"/.test(form),
    (form.match(/ude-email[^"]*/) || [])[0]);
  check('nor is the phone number', !/id="ude-phone"/.test(form));

  const verified = harness(USER({ email_verified: 1, phone_verified: 1 }), DIRECTORY);
  verified.sandbox.renderUserDetail();
  const panel = verified.els['user-detail-body'].innerHTML;
  check('the panel shows both channels', /Phone/.test(panel) && /Email/.test(panel));
  check('a verified channel says so', (panel.match(/Verified/g) || []).length >= 2,
    (panel.match(/Verified/g) || []).length);
  check('each carries its own Edit', (panel.match(/startContactEdit\('(phone|email)'\)/g) || []).length === 2,
    panel.match(/startContactEdit\('[a-z]+'\)/g));

  const unproven = harness(USER({ email_verified: 0, phone_verified: 0 }), DIRECTORY);
  unproven.sandbox.renderUserDetail();
  const panel2 = unproven.els['user-detail-body'].innerHTML;
  check('an unproven channel says THAT, rather than nothing',
    (panel2.match(/Not verified/g) || []).length === 2, (panel2.match(/Not verified/g) || []).length);
  check('...and is not passed off as verified', !/>Verified</.test(panel2));

  console.log('\n== Editing a verified channel warns before it withdraws the proof ==');
  const editing = harness(USER({ email_verified: 1 }), DIRECTORY);
  editing.sandbox.startContactEdit('email');
  const editPanel = editing.els['user-detail-body'].innerHTML;
  check('the field opens', /id="uc-email"/.test(editPanel));
  check('...saying what changing it costs',
    /withdraws that/.test(editPanel) && /prove the new one/.test(editPanel),
    editPanel.slice(editPanel.indexOf('uc-email'), editPanel.indexOf('uc-email') + 400));
  const editingPlain = harness(USER({ email_verified: 0 }), DIRECTORY);
  editingPlain.sandbox.startContactEdit('email');
  check('an unverified one warns about nothing',
    !/withdraws that/.test(editingPlain.els['user-detail-body'].innerHTML));

  console.log('\n== Without users.edit there is no Edit at all ==');
  const readOnly = harness(USER(), DIRECTORY, ['users.view']);
  readOnly.sandbox.renderUserDetail();
  check('no contact Edit is offered',
    !/startContactEdit/.test(readOnly.els['user-detail-body'].innerHTML));

  console.log('\n== 4. Designation and institute are lists with an Other escape ==');
  check('designation is a select', form.includes('id="ude-designation-select"'));
  check('institute is a select', form.includes('id="ude-institute-select"'));
  check('each keeps a hidden field, so the save reads one value',
    /type="hidden" id="ude-designation"/.test(form) && /type="hidden" id="ude-institute"/.test(form));
  check('each has an Other box, shipped hidden',
    /id="ude-designation-other"[^>]*class="hidden/.test(form)
    && /id="ude-institute-other"[^>]*class="hidden/.test(form));
  check('wired to the shared helper with this form\'s prefix',
    form.includes("onDirectorySelect('designation', 'ude')"));

  const h3 = harness(USER(), DIRECTORY);
  h3.sandbox.renderUserDetail();
  h3.sandbox.toggleUserDetailEdit();
  await tick();
  check('the known institutions are offered',
    DIRECTORY.institutions.every((v) => h3.els['ude-institute-select'].innerHTML.includes(v)),
    h3.els['ude-institute-select'].innerHTML);

  console.log('\n== A value predating the directory is preserved, not erased ==');
  const h4 = harness(USER({ institution: 'Some Older Hospital, Pune' }), DIRECTORY);
  h4.sandbox.renderUserDetail();
  h4.sandbox.toggleUserDetailEdit();
  await tick();
  check('the select falls to Other', h4.els['ude-institute-select'].value === '__other__',
    h4.els['ude-institute-select'].value);
  check('...with the value carried into the box',
    h4.els['ude-institute-other'].value === 'Some Older Hospital, Pune');
  check('...and the hidden field still holding it',
    h4.els['ude-institute'].value === 'Some Older Hospital, Pune');

  console.log('\n== The mobile number is editable as a CHANNEL, never as the key ==');
  // users.phone is how we reach somebody; users.phone_number is what the
  // registration, the payments and the audit trail all join on.
  const made = await call('POST', '/api/users', {
    phone: `97${N}`, name: 'Channel Test', email: `ch-${N}@example.test`, role: 'DELEGATE',
  }, admin);
  const key = made.body && made.body.user ? made.body.user.phone_number : `97${N}`;
  check('fixture account exists', made.status === 200 || made.status === 201, [made.status, made.body.error]);

  // Writable: the verified-standing cases below have to SET phone_verified
  // before they can prove it is respected. A read-only handle drops those
  // writes silently, which makes the guard look like it fired when it never
  // had a verified number to refuse.
  const db = openDb();
  const moved = await call('PUT', `/api/users/${key}`, { phone: `98${N}` }, admin);
  check('the channel can be changed', moved.status === 200 && moved.body.success, moved.body.error);
  const after = await db.get('SELECT phone_number, phone, phone_verified FROM users WHERE phone_number = ?', [key]);
  check('...the account key is untouched', after.phone_number === key, after.phone_number);
  check('...the channel is stored in E.164, so the login lookup matches one spelling',
    after.phone === `+9198${N}`, after.phone);

  const clash = await call('PUT', `/api/users/${key}`, { phone: '9000001001' }, admin);
  check('a number another account already uses is refused', clash.status === 409, [clash.status, clash.body.error]);
  const nonsense = await call('PUT', `/api/users/${key}`, { phone: 'not-a-number' }, admin);
  check('and so is a number that is not one', nonsense.status === 400, nonsense.status);

  console.log('\n== Changing a channel withdraws its verified standing ==');
  await db.run('UPDATE users SET phone_verified = 1 WHERE phone_number = ?', [key]);
  const armed = await db.get('SELECT phone_verified FROM users WHERE phone_number = ?', [key]);
  check('fixture: the number is verified before the change', armed.phone_verified === 1, armed);
  const reMoved = await call('PUT', `/api/users/${key}`, { phone: `96${N}` }, admin);
  check('an admin may still do it', reMoved.status === 200 && reMoved.body.success, reMoved.body.error);
  const now = await db.get('SELECT phone_verified FROM users WHERE phone_number = ?', [key]);
  check('...and the number is unproven again until they read a code sent to it',
    now.phone_verified === 0, now.phone_verified);

  console.log('\n== ...but not at the front desk ==');
  await db.run('UPDATE users SET phone_verified = 1 WHERE phone_number = ?', [key]);
  const armed2 = await db.get('SELECT phone_verified FROM users WHERE phone_number = ?', [key]);
  check('fixture: verified again before the desk tries', armed2.phone_verified === 1, armed2);
  const deskTry = await call('PUT', `/api/users/${key}`, { phone: `95${N}` }, desk);
  check('the desk is refused', deskTry.status === 409, [deskTry.status, deskTry.body.error]);
  check('...told why', /verified/i.test(deskTry.body.error || ''), deskTry.body.error);
  const untouched = await db.get('SELECT phone, phone_verified FROM users WHERE phone_number = ?', [key]);
  check('...and nothing moved', untouched.phone_verified === 1, untouched);
  const deskOther = await call('PUT', `/api/users/${key}`, { designation: 'Senior Resident' }, desk);
  check('the desk can still edit everything else', deskOther.status === 200 && deskOther.body.success,
    deskOther.body.error);

  db.close();
  report();
})();
