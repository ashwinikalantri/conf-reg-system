// Admin panel redesign, phase 09 (Payments / register-delegate modal):
// #rd-partial-note existed in the markup from the start ("Amount is less
// than the fee due...") but nothing ever removed its `hidden` class -- the
// warning was permanently dead. The cash-amount field also had no oninput
// handler at all, so a deliberate partial amount an admin typed in got
// silently overwritten back to the full fee the moment they picked a
// program option afterward (updateRegisterDelegateFee()'s auto-fill only
// stops once dataset.auto is cleared, which nothing ever did). Drives the
// real functions in a vm sandbox -- app.js declares this state as top-level
// `let`, which (per the established pattern for these client tests) only
// stays in sync with the sandbox object when the driver is compiled as part
// of the same script, not poked in from outside afterward.
const { check, report, appFile } = require('./harness');
const fs = require('fs');
const vm = require('vm');

function makeDom() {
  const els = {};
  const el = (id) => ({
    id, innerText: '', innerHTML: '', textContent: '', className: '', value: '', style: {}, dataset: {},
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
    fetch: () => Promise.reject(new Error('CASH mode never fetches -- if this fires, the test drifted into BANK_TRANSFER')),
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

  console.log('\n== A fresh category fee auto-fills the cash field, note hidden ==');
  {
    const driver = `
      rdCategoriesCache = [{ key: 'DELEGATE', label: 'Delegate', fee: 5000 }];
      rdGroupsCache = [];
      rdMode = 'CASH';
      var __TEST__ = {};
    `;
    const { sandbox, doc } = loadApp(js, driver);
    doc.getElementById('rd-category').value = 'DELEGATE';
    const total = sandbox.updateRegisterDelegateFee();
    check('fee computed correctly', total === 5000, total);
    check('cash field auto-filled to the full fee', Number(doc.getElementById('rd-cash-amount').value) === 5000);
    check('partial note stays hidden when paid in full', doc.getElementById('rd-partial-note').classList.contains('hidden'));
  }

  console.log('\n== The admin types a smaller amount: the note now shows (this was dead before the fix) ==');
  {
    const driver = `
      rdCategoriesCache = [{ key: 'DELEGATE', label: 'Delegate', fee: 5000 }];
      rdGroupsCache = [];
      rdMode = 'CASH';
      var __TEST__ = {};
    `;
    const { sandbox, doc } = loadApp(js, driver);
    doc.getElementById('rd-category').value = 'DELEGATE';
    sandbox.updateRegisterDelegateFee();
    const cashInput = doc.getElementById('rd-cash-amount');
    cashInput.value = '2000';
    sandbox.onRegisterDelegateCashInput();
    check('partial note is now visible', !doc.getElementById('rd-partial-note').classList.contains('hidden'));
  }

  console.log('\n== Fixed bug #2: a manually-typed amount used to be silently overwritten on the next recompute ==');
  {
    const driver = `
      rdCategoriesCache = [{ key: 'DELEGATE', label: 'Delegate', fee: 5000 }];
      rdGroupsCache = [{ id: 1, name: 'Workshop', maxSelect: 1, required: false, options: [{ id: 11, name: 'W1', fee: 500, remaining: 10, full: false }] }];
      rdMode = 'CASH';
      var __TEST__ = {};
    `;
    const { sandbox, doc } = loadApp(js, driver);
    doc.getElementById('rd-category').value = 'DELEGATE';
    sandbox.updateRegisterDelegateFee(); // auto-fills 5000
    const cashInput = doc.getElementById('rd-cash-amount');
    cashInput.value = '2000';
    sandbox.onRegisterDelegateCashInput(); // admin's deliberate partial amount
    check('typed amount stuck after onRegisterDelegateCashInput', cashInput.value === '2000', cashInput.value);
    // Simulate picking a program option afterward -- collectRegisterDelegateOptionIds
    // reads real DOM checkboxes/selects, which this stub doesn't have, so the fee
    // recompute below only changes if the auto-fill logic (wrongly) fires again.
    sandbox.updateRegisterDelegateFee();
    check('the admin\'s typed amount survives a later fee recompute, not silently reset to the full fee',
      Number(cashInput.value) === 2000, cashInput.value);
    check('the partial note is still showing', !doc.getElementById('rd-partial-note').classList.contains('hidden'));
  }

  console.log('\n== Clearing back to the full amount hides the note again ==');
  {
    const driver = `
      rdCategoriesCache = [{ key: 'DELEGATE', label: 'Delegate', fee: 5000 }];
      rdGroupsCache = [];
      rdMode = 'CASH';
      var __TEST__ = {};
    `;
    const { sandbox, doc } = loadApp(js, driver);
    doc.getElementById('rd-category').value = 'DELEGATE';
    sandbox.updateRegisterDelegateFee();
    const cashInput = doc.getElementById('rd-cash-amount');
    cashInput.value = '2000';
    sandbox.onRegisterDelegateCashInput();
    check('note visible at 2000/5000', !doc.getElementById('rd-partial-note').classList.contains('hidden'));
    cashInput.value = '5000';
    sandbox.onRegisterDelegateCashInput();
    check('note hidden again once paid in full', doc.getElementById('rd-partial-note').classList.contains('hidden'));
  }

  console.log('\n== The note never shows in BANK_TRANSFER mode ==');
  {
    const driver = `
      rdCategoriesCache = [{ key: 'DELEGATE', label: 'Delegate', fee: 5000 }];
      rdGroupsCache = [];
      rdMode = 'BANK_TRANSFER';
      function loadRegisterDelegateBankCandidates() { return Promise.resolve(); }
      var __TEST__ = {};
    `;
    const { sandbox, doc } = loadApp(js, driver);
    doc.getElementById('rd-category').value = 'DELEGATE';
    doc.getElementById('rd-cash-amount').value = '2000'; // stale value from before switching modes
    sandbox.updateRegisterDelegateFee();
    check('partial note stays hidden -- it is a cash-only warning', doc.getElementById('rd-partial-note').classList.contains('hidden'));
  }

  report();
})();
