// Phase 02 of the portal UI plan: the signup form is now a 5-step wizard
// (Name -> Contact -> Verify -> Details -> Address) instead of one long
// scroll. Every field still lives in the DOM the whole time -- the wizard
// only gates which step is VISIBLE -- so this test drives the real app.js
// in a vm sandbox (same approach as role-visibility-client.test.js) and
// checks step transitions, per-step validation gating, and that the final
// payload handleRegistration() builds is unaffected by step order.
const { check, report, appFile } = require('./harness');
const fs = require('fs');
const vm = require('vm');

// A minimal element/document, same shape other client-sandbox tests use.
function makeDom() {
  const els = {};
  const el = (id) => ({
    id, innerText: '', innerHTML: '', textContent: '', className: '', value: '', style: {}, dataset: {}, options: [],
    classList: {
      c: new Set(),
      add(k) { this.c.add(k); }, remove(k) { this.c.delete(k); },
      toggle(k, on) { on === undefined ? (this.c.has(k) ? this.c.delete(k) : this.c.add(k)) : (on ? this.c.add(k) : this.c.delete(k)); },
      contains(k) { return this.c.has(k); },
    },
    addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
    setAttribute() {}, getAttribute() { return null; }, focus() {}, click() {}, appendChild() {},
  });
  const doc = {
    getElementById: (id) => els[id] || (els[id] = el(id)),
    querySelector: () => el('q'), querySelectorAll: () => [],
    addEventListener() {}, createElement: () => el('c'),
    body: el('body'), documentElement: el('html'), readyState: 'loading', cookie: '',
  };
  return { els, doc };
}

function loadApp(js) {
  const { els, doc } = makeDom();
  const sandbox = {
    document: doc,
    window: {
      addEventListener() {}, location: { href: '', hash: '', pathname: '/', search: '' },
      matchMedia: () => ({ matches: false, addEventListener() {} }), history: { replaceState() {} },
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node' },
    fetch: () => Promise.reject(new Error('this test drives the sandbox directly, not through fetch')),
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, URL, Intl, Date, Math, JSON,
    requestAnimationFrame: (f) => setTimeout(f, 0),
  };
  sandbox.window.document = doc; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(js, sandbox, { filename: 'app.js' });
  return { sandbox, els, doc };
}

(async () => {
  const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');

  console.log('\n== The sandbox loads cleanly ==');
  let loaded;
  try {
    loaded = loadApp(js);
  } catch (e) {
    check('app.js evaluates in the sandbox', false, e.message);
    return report();
  }
  check('app.js evaluates in the sandbox', true);
  const { sandbox } = loaded;
  check('showSignupStep exists', typeof sandbox.showSignupStep === 'function');
  check('nextSignupStep exists', typeof sandbox.nextSignupStep === 'function');
  check('prevSignupStep exists', typeof sandbox.prevSignupStep === 'function');
  check('validateSignupStep exists', typeof sandbox.validateSignupStep === 'function');
  check('resetSignupWizard exists', typeof sandbox.resetSignupWizard === 'function');
  // getElementById lazily creates the stub element, so touch every id
  // through it (not the raw `els` map) before setting properties on it.
  const els = new Proxy({}, { get: (_, id) => loaded.doc.getElementById(id) });

  console.log('\n== Reset lands on step 1 ==');
  els['reg-name'].value = '';
  els['reg-country'].value = 'India';
  sandbox.resetSignupWizard();
  check('step 1 visible', !els['reg-step-1'].classList.contains('hidden'));
  check('steps 2-5 hidden', [2, 3, 4, 5].every((n) => els[`reg-step-${n}`].classList.contains('hidden')));
  check('back button hidden on step 1', els['reg-back-btn'].classList.contains('hidden'));
  check('next button visible on step 1', !els['reg-next-btn'].classList.contains('hidden'));
  check('submit hidden and disabled on step 1', els['reg-submit-btn'].classList.contains('hidden') && els['reg-submit-btn'].disabled);

  console.log('\n== Step 1 -> 2 gated on a name ==');
  sandbox.nextSignupStep();
  check('empty name blocks advance', els['reg-step-2'].classList.contains('hidden'));
  els['reg-name'].value = 'Dr Jane Doe';
  sandbox.nextSignupStep();
  check('a name advances to step 2', !els['reg-step-2'].classList.contains('hidden'));
  check('step 1 now hidden', els['reg-step-1'].classList.contains('hidden'));
  check('back button now visible', !els['reg-back-btn'].classList.contains('hidden'));

  console.log('\n== Step 2 -> 3 gated on India requiring a phone, same rule as handleRegistration ==');
  els['reg-phone'].value = '';
  els['reg-email'].value = 'jane@example.com';
  sandbox.nextSignupStep();
  check('India with no phone blocks advance to Verify', els['reg-step-3'].classList.contains('hidden'));
  els['reg-phone'].value = '9876543210';
  sandbox.nextSignupStep();
  check('valid India contact advances to Verify', !els['reg-step-3'].classList.contains('hidden'));
  check('recap mentions the phone and email just entered',
    els['reg-contact-recap'].textContent.includes('9876543210') && els['reg-contact-recap'].textContent.includes('jane@example.com'),
    els['reg-contact-recap'].textContent);

  console.log('\n== Step 3 -> 4 gated on at least one OTP entered ==');
  els['reg-otp'].value = '';
  els['reg-email-otp'].value = '';
  sandbox.nextSignupStep();
  check('no OTP entered blocks advance to Details', els['reg-step-4'].classList.contains('hidden'));
  els['reg-otp'].value = '123456';
  sandbox.nextSignupStep();
  check('an entered OTP advances to Details', !els['reg-step-4'].classList.contains('hidden'));

  console.log('\n== Step 4 -> 5 gated on age/gender/designation/institute/password ==');
  els['reg-age'].value = ''; els['reg-gender'].value = ''; els['reg-designation'].value = '';
  els['reg-institute'].value = ''; els['reg-password'].value = '';
  sandbox.nextSignupStep();
  check('empty Details block advance to Address', els['reg-step-5'].classList.contains('hidden'));
  els['reg-age'].value = '34'; els['reg-gender'].value = 'Female';
  els['reg-designation'].value = 'Consultant'; els['reg-institute'].value = 'City Hospital';
  els['reg-password'].value = 'short';
  sandbox.nextSignupStep();
  check('a too-short password still blocks advance', els['reg-step-5'].classList.contains('hidden'));
  els['reg-password'].value = 'longenoughpw';
  sandbox.nextSignupStep();
  check('a complete Details step reaches Address', !els['reg-step-5'].classList.contains('hidden'));
  check('next button hidden on the last step', els['reg-next-btn'].classList.contains('hidden'));
  check('submit visible and enabled on the last step',
    !els['reg-submit-btn'].classList.contains('hidden') && !els['reg-submit-btn'].disabled);

  console.log('\n== Back navigation retraces steps without re-validating ==');
  sandbox.prevSignupStep();
  check('back from step 5 returns to step 4', !els['reg-step-4'].classList.contains('hidden'));
  check('submit hidden again once off the last step', els['reg-submit-btn'].classList.contains('hidden') && els['reg-submit-btn'].disabled);

  console.log('\n== toggleAuth(\'register\') resets the wizard to step 1 ==');
  sandbox.showSignupStep(4);
  sandbox.toggleAuth('register');
  check('switching to signup resets to step 1', !els['reg-step-1'].classList.contains('hidden'));
  check('steps 2-5 hidden again after reset', [2, 3, 4, 5].every((n) => els[`reg-step-${n}`].classList.contains('hidden')));

  console.log('\n== A non-India delegate is not blocked on a missing phone ==');
  els['reg-country'].value = 'United Kingdom';
  sandbox.resetSignupWizard();
  els['reg-name'].value = 'Alex Smith';
  sandbox.nextSignupStep();
  check('reached Contact', !els['reg-step-2'].classList.contains('hidden'));
  els['reg-phone'].value = '';
  els['reg-email'].value = 'alex@example.co.uk';
  sandbox.nextSignupStep();
  check('no phone required outside India', !els['reg-step-3'].classList.contains('hidden'));

  report();
})();
