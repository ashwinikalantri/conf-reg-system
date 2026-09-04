// Admin panel redesign, phase 08 (Users & Roles): a custom role created via
// the Role Editor was fully assignable everywhere -- Create Staff User,
// the detail panel's own role select, both already rebuilt from the live
// role catalogue (cachedRoleOptions) -- except the Users table's own Role
// FILTER, which stayed the static <option> list users.ejs ships as a
// pre-load fallback. A user holding a custom role was therefore impossible
// to filter to: "All roles" plus six hardcoded built-ins, forever. This
// drives populateUserFilterOptions() (called from renderBackendUsers())
// directly in a vm sandbox to confirm the filter now rebuilds from the same
// catalogue the other two role selects already used.
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

  console.log('\n== Before the role catalogue loads: the static fallback is left alone ==');
  {
    const driver = `cachedRoleOptions = []; cachedUsers = []; var __TEST__ = {};`;
    const { sandbox, doc } = loadApp(js, driver);
    const roleSel = doc.getElementById('user-filter-role');
    roleSel.innerHTML = '<option value="">All roles</option><option value="DELEGATE">Delegate</option>';
    sandbox.populateUserFilterOptions();
    check('untouched while cachedRoleOptions is empty', roleSel.innerHTML.includes('All roles</option><option value="DELEGATE">Delegate</option>'));
  }

  console.log('\n== Once the catalogue has loaded: rebuilt to include every role, custom ones included ==');
  {
    const driver = `
      cachedRoleOptions = [
        { key: 'FINANCE_ADMIN', label: 'Finance Admin' },
        { key: 'DESK_STAFF', label: 'Desk Staff' },
      ];
      cachedUsers = [];
      var __TEST__ = {};
    `;
    const { sandbox, doc } = loadApp(js, driver);
    const roleSel = doc.getElementById('user-filter-role');
    sandbox.populateUserFilterOptions();
    check('"All roles" default is still there', /<option value="">All roles<\/option>/.test(roleSel.innerHTML));
    check('Delegate is offered (not part of cachedRoleOptions, added separately)', /<option value="DELEGATE">Delegate<\/option>/.test(roleSel.innerHTML));
    check('a built-in role from the catalogue is offered', /<option value="FINANCE_ADMIN">Finance Admin<\/option>/.test(roleSel.innerHTML));
    check('the custom role is now filterable -- this is the actual fix', /<option value="DESK_STAFF">Desk Staff<\/option>/.test(roleSel.innerHTML));
  }

  console.log('\n== The current selection survives the rebuild ==');
  {
    const driver = `
      cachedRoleOptions = [{ key: 'DESK_STAFF', label: 'Desk Staff' }];
      cachedUsers = [];
      var __TEST__ = {};
    `;
    const { sandbox, doc } = loadApp(js, driver);
    const roleSel = doc.getElementById('user-filter-role');
    roleSel.value = 'DESK_STAFF';
    sandbox.populateUserFilterOptions();
    check('the previously-selected role is still selected after rebuilding', roleSel.value === 'DESK_STAFF', roleSel.value);
  }

  console.log('\n== renderRoleOptions() refreshes the Users table once the catalogue arrives ==');
  check('renderRoleOptions calls renderBackendUsers when the users table is present',
    /if \(document\.getElementById\('user-table-body'\)\) renderBackendUsers\(\);/.test(js));

  report();
})();
