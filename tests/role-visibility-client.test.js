// Phase 3: the browser draws the admin panel from the same permission set the
// server enforces, rather than re-deriving four booleans from a role name.
//
// This test does not lift snippets out of app.js and re-implement the DOM --
// it loads the WHOLE file into a vm sandbox with a stubbed document, drives
// it with the REAL /api/auth/me payload for each of the five roles (fetched
// from the running seeded server, the same way a browser would), and reads
// back real classList state off real elements. It is the closest thing to
// clicking through the panel five times that a Node process can do, and it
// is what actually would have caught the two mistakes found by hand while
// building this phase: a stale call site still naming the deleted
// rolesFor(), and the section-visibility fixture drifting from the real
// client instead of being checked against it.
const { call, check, report, loginPassword, ADMIN_PW, appFile } = require('./harness');
const fs = require('fs');
const vm = require('vm');

const STAFF = {
  SUPER_ADMIN: '9000000001',
  FINANCE_ADMIN: '9000000002',
  ACADEMIC_REVIEWER: '9000000003',
  OPERATIONS: '9000000004',
  FINANCE_ACADEMIC: '9000000005',
};

// Every element applyRoleVisibility()/allowedBackendTabs() touch, so a role's
// full visible surface can be read back after driving the real code.
const ELEMENT_IDS = [
  'nav-tab-payments', 'nav-tab-statement', 'nav-tab-abstracts', 'nav-tab-reports',
  'register-delegate-btn', 'settings-menu-btn',
  'settings-item-programs', 'settings-item-fees', 'settings-item-general',
  'settings-item-discount', 'settings-item-activity',
  'settings-item-reminders', 'settings-item-groupdiscount', 'settings-item-users', 'settings-item-roles',
  'report-delegates', 'report-delegate-programs', 'report-payments',
  'report-workshops', 'report-abstracts',
];

// Expected outcome per role, decided explicitly during this phase (not
// inferred): 'discount' and 'groupdiscount' are now visible to whichever role
// holds discounts.view/discounts.group_view, matching what the server has
// always enforced -- the same resolution as the Reminders drift, made by the
// same reasoning, confirmed with the user before this test was written.
const EXPECTED_VISIBLE = {
  SUPER_ADMIN: ['nav-tab-payments', 'nav-tab-statement', 'nav-tab-abstracts', 'nav-tab-reports',
    'register-delegate-btn', 'settings-menu-btn', 'settings-item-programs', 'settings-item-fees',
    'settings-item-general', 'settings-item-discount', 'settings-item-activity',
    'settings-item-reminders', 'settings-item-groupdiscount', 'settings-item-users', 'settings-item-roles',
    'report-delegates', 'report-delegate-programs', 'report-payments', 'report-workshops', 'report-abstracts'],
  FINANCE_ADMIN: ['nav-tab-payments', 'nav-tab-statement', 'nav-tab-reports',
    'register-delegate-btn', 'settings-menu-btn', 'settings-item-discount',
    'settings-item-reminders', 'settings-item-groupdiscount',
    'report-delegates', 'report-delegate-programs', 'report-payments', 'report-workshops'],
  ACADEMIC_REVIEWER: ['nav-tab-abstracts', 'nav-tab-reports', 'report-abstracts'],
  FINANCE_ACADEMIC: ['nav-tab-payments', 'nav-tab-statement', 'nav-tab-abstracts', 'nav-tab-reports',
    'register-delegate-btn', 'settings-menu-btn', 'settings-item-discount',
    'settings-item-reminders', 'settings-item-groupdiscount',
    'report-delegates', 'report-delegate-programs', 'report-payments', 'report-workshops', 'report-abstracts'],
  OPERATIONS: ['nav-tab-reports', 'settings-menu-btn', 'settings-item-users',
    'report-delegates', 'report-delegate-programs', 'report-payments', 'report-workshops', 'report-abstracts'],
};

// A minimal element/document, same shape tests/dashboard-first-paint.test.js
// already established for driving app.js in a sandbox.
function makeDom() {
  const els = {};
  const el = (id) => ({
    id, innerText: '', innerHTML: '', className: '', value: '', style: {}, dataset: {},
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

// `driverSrc`, if given, is appended to app.js and compiled as ONE script.
// That matters: app.js declares its role state with top-level `let`, and a
// top-level `let` in a vm script does NOT become a property of the sandbox
// object the way a top-level `function` does (verified directly -- assigning
// sandbox.myPermissions from OUTSIDE the script silently creates an unrelated
// global property, while every function that closed over the original
// binding keeps seeing its original value). Driving the sandbox has to mean
// running code that shares app.js's own lexical scope, not poking at it from
// outside -- which is exactly the distinction this phase's rewrite depends
// on getting right, so the test has to get it right too. The driver reads
// results back out through `var __TEST__`, which -- unlike `let` -- does
// attach to the sandbox object.
function loadApp(js, driverSrc) {
  const { els, doc } = makeDom();
  const sandbox = {
    document: doc,
    window: {
      addEventListener() {}, location: { href: '', hash: '', pathname: '/admin', search: '' },
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
  // NOT wrapped in a function: driverSrc has to reassign app.js's own
  // top-level `let myPermissions`/`mySections` bindings, which only works
  // from code sharing that exact lexical scope. Plain assignment, never
  // `let`/`const` again (that would be a duplicate-declaration SyntaxError
  // against app.js's own).
  vm.runInContext(js + (driverSrc ? `\n${driverSrc}\n` : ''), sandbox, { filename: 'app.js' });
  return { sandbox, els };
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
  check('can() exists', typeof loaded.sandbox.can === 'function');
  check('canSee() exists', typeof loaded.sandbox.canSee === 'function');
  check('applyRoleVisibility() takes no argument now',
    /function applyRoleVisibility\(\) \{/.test(js));
  check('rolesFor is gone', !/function rolesFor\(/.test(js));
  check('no call site still passes a role into applyRoleVisibility or allowedBackendTabs',
    !/applyRoleVisibility\(activeAdminUser/.test(js) && !/allowedBackendTabs\(\{/.test(js)
    && !/allowedBackendTabs\(rolesFor/.test(js));

  console.log('\n== Every role\'s real /api/auth/me payload drives real DOM state ==');
  for (const [role, phone] of Object.entries(STAFF)) {
    const cookie = await loginPassword(phone, ADMIN_PW);
    check(`${role} signs in`, !!cookie);
    if (!cookie) continue;
    const me = await call('GET', '/api/auth/me', null, cookie);
    check(`${role}'s /me responds`, me.status === 200, me.status);
    check(`${role}'s /me carries permissions and sections`,
      Array.isArray(me.body.permissions) && me.body.sections && typeof me.body.sections === 'object',
      me.body);

    const driver = `myPermissions = new Set(${JSON.stringify(me.body.permissions)});
      mySections = ${JSON.stringify(me.body.sections)};
      applyRoleVisibility();`;
    const { sandbox, els } = loadApp(js, driver);

    const visible = ELEMENT_IDS.filter((id) => !els[id].classList.contains('hidden'));
    const want = EXPECTED_VISIBLE[role].slice().sort();
    const got = visible.slice().sort();
    const missing = want.filter((id) => !got.includes(id));
    const extra = got.filter((id) => !want.includes(id));
    check(`${role} sees exactly the right elements`,
      missing.length === 0 && extra.length === 0,
      { missing, extra });

    const allowed = sandbox.allowedBackendTabs();
    const wantTabs = Object.keys(me.body.sections).filter((k) => me.body.sections[k]).sort();
    check(`${role}'s allowedBackendTabs() matches the server's sections`,
      JSON.stringify(allowed.slice().sort()) === JSON.stringify(wantTabs),
      { allowed, wantTabs });
  }

  console.log('\n== The two decided drifts resolved by construction ==');
  const financeCookie = await loginPassword(STAFF.FINANCE_ADMIN, ADMIN_PW);
  const financeMe = await call('GET', '/api/auth/me', null, financeCookie);
  check('Finance may view reminders', financeMe.body.sections.reminders === true);
  check('...but the permission set does not include sending one',
    !financeMe.body.permissions.includes('comms.reminders_send'));
  check('Finance now sees Discount Codes too (decided in this phase, matching server truth)',
    financeMe.body.sections.discount === true);

  const financeDriver = `myPermissions = new Set(${JSON.stringify(financeMe.body.permissions)});
    mySections = ${JSON.stringify(financeMe.body.sections)};
    applyRoleVisibility();`;
  const { els: financeEls } = loadApp(js, financeDriver);
  check('...and the Reminders menu item is genuinely visible in the DOM',
    !financeEls['settings-item-reminders'].classList.contains('hidden'));

  console.log('\n== A delegate gets nothing ==');
  const { openDb } = require('./harness');
  const db = openDb({ readOnly: true });
  const delegate = await db.get("SELECT phone_number FROM users WHERE role = 'DELEGATE' AND password_hash IS NOT NULL LIMIT 1");
  db.close();
  if (delegate) {
    const dCookie = await loginPassword(delegate.phone_number, 'harness-delegate-pw');
    if (dCookie) {
      const dMe = await call('GET', '/api/auth/me', null, dCookie);
      check('a delegate gets an empty permission set', (dMe.body.permissions || []).length === 0, dMe.body.permissions);
      check('and every section closed', Object.values(dMe.body.sections || {}).every((v) => v === false),
        dMe.body.sections);
    }
  }

  report();
})();
