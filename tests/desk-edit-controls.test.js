// The desk's edit form started as nine free-text boxes. A counter is exactly
// where "Prof.", "Professor " and "professor" get typed at speed by different
// volunteers, and the homogenisation pass that had to clean up 125
// institutions afterwards is not an exercise worth repeating -- so every
// field that has a known set of answers now offers that set.
//
// The reuse matters as much as the constraint. Designation, institute and the
// PIN-code lookup all drive the SIGNUP form's own helpers, parameterised by an
// id prefix, rather than growing a second copy. The careful part of the
// pincode logic is its fallback -- an unrecognised PIN blocks, but a PIN we
// recognise and merely cannot NAME unlocks the two fields to be typed -- and
// that is precisely the part a duplicate would get subtly wrong.
const { call, check, report, ADMIN_PW, appFile, adminLogin, loginPassword, openDb } = require('./harness');
const fs = require('fs');
const vm = require('vm');

const DESK = '9000000006';         // Dez Counter, FRONT_DESK -- users.edit, no users.view
const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');

function harness(delegate, directory) {
  const els = {};
  const mk = (id) => (els[id] = els[id] || {
    id, value: '', innerHTML: '', textContent: '', readOnly: false, attrs: {},
    options: [],
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
  vm.runInContext(`${js}\ndeskDelegate = ${JSON.stringify(delegate)};\n`, sandbox, { filename: 'app.js+driver' });
  return { sandbox, els, sent };
}

const DIRECTORY = {
  designations: ['Assistant Professor', 'Junior Resident'],
  institutions: ['MGIMS Sevagram', 'AIIMS Nagpur'],
};
const DELEGATE = (over) => ({
  user: {
    phone_number: '9000001001', full_name: 'Asha Patil', email: 'asha@example.test',
    email_verified: 0, age: 41, gender: 'Female', designation: 'Junior Resident',
    institution: 'MGIMS Sevagram', pincode: '442102', state: 'Maharashtra', district: 'Wardha',
    ...(over || {}),
  },
  registration: { id: 5, category_key: 'faculty_mo', category_label: 'Doctor', expected_amount: 3000 },
  payment: { fee: 3000, netVerifiedTotal: 3000, remaining: 0, overpaid: 0 },
  selections: [], abstracts: [], checkedIn: null,
});
const tick = () => new Promise((r) => setTimeout(r, 10));

(async () => {
  const admin = await adminLogin();
  const desk = await loginPassword(DESK, ADMIN_PW);

  console.log('\n== 1. State and district are filled from the PIN code, not typed ==');
  const h = harness(DELEGATE(), DIRECTORY);
  h.sandbox.deskOpenEdit();
  await tick();
  const form = h.els['desk-edit-form'].innerHTML;
  check('the PIN code drives the lookup', /id="desk-edit-pincode"[^>]*oninput="fetchAddressDetails\(this\.value, 'desk-edit'\)"/.test(form),
    (form.match(/desk-edit-pincode[^>]*/) || [])[0]);
  check('state ships read-only', /id="desk-edit-state"[^>]*readonly/.test(form));
  check('district ships read-only', /id="desk-edit-district"[^>]*readonly/.test(form));
  check('...and look it, in the same muted way the signup form does',
    /id="desk-edit-state"[^>]*bg-slate-100/.test(form));
  check('there is a place to report what the PIN resolved to',
    form.includes('id="desk-edit-pincode-status"'));

  // The fallback is the whole reason this reuses the signup helper: a PIN we
  // cannot NAME must unlock the fields rather than stranding the desk.
  h.sandbox.setAddressFieldsEditable(true, 'desk-edit');
  check('an unnameable PIN unlocks the two fields rather than blocking',
    h.els['desk-edit-state'].readOnly === false && h.els['desk-edit-district'].readOnly === false);
  h.sandbox.setAddressFieldsEditable(false, 'desk-edit');
  check('...and they lock again once one resolves', h.els['desk-edit-state'].readOnly === true);
  check('the signup form is untouched by the desk driving it',
    h.els['reg-state'] === undefined || h.els['reg-state'].readOnly === false,
    h.els['reg-state'] && h.els['reg-state'].readOnly);

  console.log('\n== 2. Designation and institute are lists, with an Other escape ==');
  check('designation is a select', form.includes('id="desk-edit-designation-select"'));
  check('institute is a select', form.includes('id="desk-edit-institute-select"'));
  check('each keeps a hidden field, so the save path reads one value',
    /type="hidden" id="desk-edit-designation"/.test(form) && /type="hidden" id="desk-edit-institute"/.test(form));
  check('each has an Other box, shipped hidden',
    /id="desk-edit-designation-other"[^>]*class="hidden/.test(form)
    && /id="desk-edit-institute-other"[^>]*class="hidden/.test(form));
  check('the selects are wired to the shared helper, with the desk prefix',
    form.includes("onDirectorySelect('designation', 'desk-edit')"));
  const opts = h.els['desk-edit-institute-select'].innerHTML;
  check('the known institutions are offered', DIRECTORY.institutions.every((v) => opts.includes(v)), opts);
  check('...and Other is last, being the escape hatch not a suggestion',
    opts.lastIndexOf('__other__') > opts.lastIndexOf('AIIMS Nagpur'));

  console.log('\n== A value not on the list is preserved, not silently dropped ==');
  // Opening the form on somebody whose institution predates the list, and
  // saving it unchanged, must not erase it.
  const h2 = harness(DELEGATE({ institution: 'Some Older Hospital, Pune' }), DIRECTORY);
  h2.sandbox.deskOpenEdit();
  await tick();
  check('the select falls to Other', h2.els['desk-edit-institute-select'].value === '__other__',
    h2.els['desk-edit-institute-select'].value);
  check('...with the existing value carried into the box',
    h2.els['desk-edit-institute-other'].value === 'Some Older Hospital, Pune',
    h2.els['desk-edit-institute-other'].value);
  check('...and the hidden field still holds it',
    h2.els['desk-edit-institute'].value === 'Some Older Hospital, Pune',
    h2.els['desk-edit-institute'].value);

  console.log('\n== 3. Gender is a selection ==');
  check('gender is a select, not a text box', form.includes('id="desk-edit-gender"')
    && /<select id="desk-edit-gender"/.test(form));
  check('with the same three options the signup form offers',
    ['Male', 'Female', 'Other'].every((g) => form.includes(`<option value="${g}"`)));
  check('...and the delegate\'s own value preselected',
    /<option value="Female" selected>/.test(form), (form.match(/<option value="Female"[^>]*>/) || [])[0]);

  console.log('\n== 4. A verified address is not editable at the desk ==');
  const h3 = harness(DELEGATE({ email_verified: 1 }), DIRECTORY);
  h3.sandbox.deskOpenEdit();
  await tick();
  const vForm = h3.els['desk-edit-form'].innerHTML;
  check('no email input is rendered at all', !/id="desk-edit-email"/.test(vForm),
    (vForm.match(/desk-edit-email[^>]*/) || [])[0]);
  check('the address is still shown, so the desk can read it back',
    vForm.includes('asha@example.test'));
  check('...marked verified', vForm.includes('Verified'));
  check('...and saying why it cannot be changed', /cannot be changed/i.test(vForm));
  check('an unverified address IS editable', /id="desk-edit-email"/.test(form));

  console.log('\n== ...and the server refuses it, not just the form ==');
  // The form omitting a field is a convenience. The rule is the route.
  const mail = `verified-${Date.now() % 1000000}@example.test`;
  const asked = await call('POST', '/api/otp/request', { destination: mail });
  const made = await call('POST', '/api/auth/register', {
    salutation: 'Dr', name: 'Verified Person', age: '30', gender: 'Male',
    designation: 'X', institute: 'Y', pincode: '442102', state: 'Maharashtra', district: 'Wardha',
    country: 'United Kingdom', email: mail, emailOtp: asked.body.devOtp, password: 'testpass123',
  });
  const key = made.body.user.phone_number;
  check('fixture: an email-verified account exists', made.body.user.email_verified === 1, made.body.user);

  const deskTry = await call('PUT', `/api/users/${key}`, { email: `moved-${Date.now() % 1000000}@example.test` }, desk);
  check('the desk is refused', deskTry.status === 409, [deskTry.status, deskTry.body.error]);
  check('...told plainly why', /verified/i.test(deskTry.body.error || ''), deskTry.body.error);

  const db = openDb({ readOnly: true });
  const still = await db.get('SELECT email, email_verified FROM users WHERE phone_number = ?', [key]);
  check('...and nothing moved', still.email === mail && still.email_verified === 1, still);

  // Deliberately NOT absolute: changing it already drops verified standing,
  // so the delegate must re-prove the new address before it works for login.
  // That is the only correction path there is, and closing it for everybody
  // would make a wrong-but-verified address permanent.
  const adminTry = await call('PUT', `/api/users/${key}`, { email: `admin-moved-${Date.now() % 1000000}@example.test` }, admin);
  check('a full admin can still correct one', adminTry.status === 200 && adminTry.body.success,
    [adminTry.status, adminTry.body.error]);
  const moved = await db.get('SELECT email, email_verified FROM users WHERE phone_number = ?', [key]);
  check('...and it drops back to unverified, as it always did', moved.email_verified === 0, moved);

  // Re-verify before moving on. Not decoration: this account was created with
  // email as its only channel, so leaving it unverified leaves it with none at
  // all -- which phone-number-formats checks across every account, and would
  // otherwise fail there rather than here, pointing at nothing.
  const back = await call('POST', '/api/auth/login-password',
    { identifier: moved.email, password: 'testpass123' });
  const asMe = await call('POST', '/api/auth/verify-contact/request',
    { channel: 'email', value: moved.email }, back.cookie);
  const done = await call('POST', '/api/auth/verify-contact/confirm',
    { channel: 'email', value: moved.email, otp: asMe.body.devOtp }, back.cookie);
  check('...and the delegate can re-prove the new address, which is the point',
    done.body.user && done.body.user.email_verified === 1, done.body.error);

  console.log('\n== The desk can still edit everything else about them ==');
  const other = await call('PUT', `/api/users/${key}`, { designation: 'Senior Resident' }, desk);
  check('a non-email edit goes through', other.status === 200 && other.body.success, other.body.error);

  console.log('\n== 5. Correcting a category reports which way the money moved ==');
  const one = await call('GET', '/api/desk/delegate/9000001007', null, desk);   // med_student, Rs1500 paid
  const regId = one.body.registration.id;
  const up = await call('PUT', `/api/registrations/${regId}/lock-category`, { categoryKey: 'faculty_mo' }, desk);
  check('moving to a dearer category succeeds', up.status === 200 && up.body.success, up.body.error);
  check('...and reports the shortfall', up.body.remaining > 0, up.body.remaining);
  check('...with nothing refundable', !up.body.overpaid, up.body.overpaid);

  // The direction that used to go unreported: a correction DOWN leaves the
  // delegate overpaid, and a response that only ever spoke about shortfalls
  // meant nobody was told.
  const down = await call('PUT', `/api/registrations/${regId}/lock-category`, { categoryKey: 'med_student' }, desk);
  check('moving back to a cheaper one succeeds', down.status === 200 && down.body.success, down.body.error);
  check('...and the shortfall is gone', down.body.remaining === 0, down.body.remaining);
  check('...and it says what is now owed BACK', typeof down.body.overpaid === 'number', down.body.overpaid);
  check('...and what they have actually paid', typeof down.body.paid === 'number', down.body.paid);

  console.log('\n== An excess is a standing notice, not a disappearing toast ==');
  // deskDelegate is a top-level `let` in app.js, so it does not attach to the
  // sandbox object -- reading it back would be undefined. The card is called
  // with the same objects directly instead.
  const overpaidState = { ...DELEGATE(), payment: { fee: 1500, netVerifiedTotal: 3000, remaining: 0, overpaid: 1500 } };
  const h4 = harness(overpaidState, DIRECTORY);
  const card = h4.sandbox.deskMoneyCard(overpaidState.registration, overpaidState.payment);
  check('the payment card carries the refundable amount', /1,500 refundable/.test(card), card.slice(0, 200));
  check('...and says a cash refund is not the way to settle it',
    /no record/i.test(card) && /Payments/.test(card));
  // A refund must be backed by a real debit row from the imported statement
  // (POST /api/registrations/:id/refund), which is proof the money left the
  // account. Cash over a counter has no such proof.
  check('the desk is not given a refund button it could not honour',
    !/deskRefund|Record refund/.test(js));
  const noExcess = h4.sandbox.deskMoneyCard(overpaidState.registration,
    { fee: 3000, netVerifiedTotal: 3000, remaining: 0, overpaid: 0 });
  check('a settled registration shows no such notice', !/refundable/.test(noExcess));

  db.close();
  report();
})();
