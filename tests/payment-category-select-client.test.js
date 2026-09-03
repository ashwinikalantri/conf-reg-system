// Phase 03 of the portal UI plan: the payment modal's category picker used
// to be a hand-built <button>+panel pair shadowing a hidden <select> (so it
// could get keyboard/mobile support the custom widget never had, and drop
// the dead JS that kept the two in sync). This drives the real app.js in a
// vm sandbox (same approach as the signup wizard test) to check the native
// select drives calculateFee()/applyCategoryLock() correctly and that the
// old custom-dropdown functions are actually gone, not just unreferenced.
const { check, report, appFile } = require('./harness');
const fs = require('fs');
const vm = require('vm');

function makeDom() {
  const els = {};
  const el = (id) => ({
    id, innerText: '', innerHTML: '', textContent: '', className: '', value: '', style: {}, dataset: {},
    disabled: false, options: [],
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
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, createElement: () => el('c'),
    body: el('body'), documentElement: el('html'), readyState: 'loading', cookie: '',
  };
  return { els, doc };
}

// Driver code runs appended to app.js's own script text (not wrapped in a
// function) so it can reassign app.js's top-level `let feeCategories` /
// `currentRegistration` bindings directly -- a vm sandbox property set from
// outside creates an unrelated global instead (established while building
// role-visibility-client.test.js). Results come back through `var __TEST__`,
// which -- unlike `let` -- does attach to the sandbox object.
function loadApp(js, driverSrc) {
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
  vm.runInContext(js + (driverSrc ? `\n${driverSrc}\n` : ''), sandbox, { filename: 'app.js' });
  return { sandbox, els, doc };
}

(async () => {
  const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');

  console.log('\n== The old custom-dropdown functions are gone, not just unreferenced ==');
  let loaded;
  try {
    loaded = loadApp(js);
  } catch (e) {
    check('app.js evaluates in the sandbox', false, e.message);
    return report();
  }
  check('app.js evaluates in the sandbox', true);
  check('selectCategory is gone', typeof loaded.sandbox.selectCategory === 'undefined');
  check('toggleCategoryDropdown is gone', typeof loaded.sandbox.toggleCategoryDropdown === 'undefined');
  check('renderCategoryDropdown is gone', typeof loaded.sandbox.renderCategoryDropdown === 'undefined');
  check('setCategoryDropdownLabel is gone', typeof loaded.sandbox.setCategoryDropdownLabel === 'undefined');
  check('calculateFee still exists', typeof loaded.sandbox.calculateFee === 'function');
  check('applyCategoryLock still exists', typeof loaded.sandbox.applyCategoryLock === 'function');
  check('no leftover reference to the deleted markup', !/category-dropdown/.test(js));

  console.log('\n== The native select drives calculateFee() directly (no dropdown JS in the way) ==');
  const driver = `
    feeCategories = { DELEGATE: { key: 'DELEGATE', label: 'Delegate', fee: 5000, requiresStudentId: false } };
    var __TEST__ = {};
  `;
  const { sandbox, doc } = loadApp(js, driver);
  const sel = doc.getElementById('payment-category');
  sel.value = 'DELEGATE';
  sandbox.calculateFee();
  const feeDisplay = doc.getElementById('calculated-fee-display');
  const enteredAmount = doc.getElementById('entered-amount');
  check('calculateFee reads the plain select\'s value', feeDisplay.innerText.includes('5,000') || feeDisplay.innerText.includes('5000'), feeDisplay.innerText);
  check('entered-amount is set from the category fee', Number(enteredAmount.value) === 5000, enteredAmount.value);

  console.log('\n== applyCategoryLock() sets and disables the plain select directly ==');
  const driver2 = `
    feeCategories = { STUDENT: { key: 'STUDENT', label: 'Student', fee: 1000, requiresStudentId: true } };
    currentRegistration = { category_locked: true, category_key: 'STUDENT', category_label: 'Student' };
    var __TEST__ = {};
  `;
  const locked = loadApp(js, driver2);
  locked.sandbox.applyCategoryLock();
  const lockedSel = locked.doc.getElementById('payment-category');
  check('locked category is pre-selected', lockedSel.value === 'STUDENT', lockedSel.value);
  check('the select itself is disabled', lockedSel.disabled === true);
  check('fee ran for the locked category', Number(locked.doc.getElementById('entered-amount').value) === 1000);

  console.log('\n== An unlocked delegate keeps the select enabled ==');
  const driver3 = `
    feeCategories = {};
    currentRegistration = { category_locked: false };
    var __TEST__ = {};
  `;
  const unlocked = loadApp(js, driver3);
  unlocked.sandbox.applyCategoryLock();
  check('the select is not disabled', unlocked.doc.getElementById('payment-category').disabled === false);

  report();
})();
