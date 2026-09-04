// loadDashboard() used to run three network round trips -- registration,
// abstract, and group status -- one after another, and only called
// navigateTo('dashboard-page') once all three had resolved. Two problems on
// a slow or flaky connection (see the login-password path, which shows a
// "Welcome back" toast, then calls loadDashboard() without awaiting it):
//   1. Perceived load time was the SUM of three round trips, not the
//      slowest one, since they ran in series.
//   2. If any single one of them rejected outright (a network failure, not
//      an HTTP error -- .catch(() => ({})) chained onto .json() doesn't
//      catch fetch() itself rejecting), the whole function threw and
//      navigateTo() never ran. Since the caller doesn't await
//      loadDashboard(), that became a silent unhandled rejection: the
//      delegate saw the welcome toast and then nothing -- stuck with no
//      page under it.
// The fix: call navigateTo('dashboard-page') immediately (the markup
// already ships neutral placeholder states -- "Checking...", "Not
// Submitted" -- for exactly this), then run the three fetches in parallel,
// each guarded so a failure just leaves its own section as shipped rather
// than taking the rest of the page down with it.
//
// currentDelegate is a top-level `let` in app.js, so it can't be poked from
// outside the vm sandbox after the fact (that just creates an unrelated
// stray property -- loadDashboard would still see the real binding as
// unset). The driver that sets it has to run as part of the SAME
// vm.runInContext script as app.js itself, so a plain assignment resolves
// to app.js's own binding.
const { check, report, appFile } = require('./harness');
const fs = require('fs');
const vm = require('vm');

const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');

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
    remove() {},
  });
  const doc = {
    getElementById: (id) => els[id] || (els[id] = el(id)),
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, createElement: () => el('c'),
    body: el('body'), documentElement: el('html'), readyState: 'loading', cookie: '',
  };
  return { els, doc };
}

const DELEGATE = { full_name: 'Test Delegate', phone_number: '9000000000', phone: '+919000000000', designation: 'Consultant', institution: 'Test Inst', role: 'DELEGATE' };

// Concatenates app.js with a driver that assigns the real currentDelegate
// binding (see the header comment) and pre-hides dashboard-page/auth-page
// the way the real markup does, so "no longer hidden" is a meaningful
// signal of navigateTo() actually having run rather than a stub default.
function loadApp(fetchImpl) {
  const { els, doc } = makeDom();
  doc.getElementById('dashboard-page').classList.add('hidden');
  doc.getElementById('auth-page').classList.add('hidden');
  const sandbox = {
    document: doc,
    window: {
      addEventListener() {}, location: { href: '', hash: '', pathname: '/', search: '' },
      matchMedia: () => ({ matches: false, addEventListener() {} }), history: { replaceState() {} },
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node' },
    fetch: fetchImpl,
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, URL, Intl, Date, Math, JSON,
    requestAnimationFrame: (f) => setTimeout(f, 0),
    Promise,
    __TEST_DELEGATE__: DELEGATE,
  };
  sandbox.window.document = doc; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(js + '\ncurrentDelegate = __TEST_DELEGATE__;\n', sandbox, { filename: 'app.js+driver' });
  return { sandbox, els, doc };
}

const GOOD = {
  '/api/registrations/me': { registration: null },
  '/api/abstracts/me': { abstract: null },
  '/api/groups/me': { group: null },
  '/api/groups/eligible-categories': { categories: [] },
};

function mkFetch(failOn) {
  return (url) => {
    const key = String(url).split('?')[0];
    if (key === failOn) return Promise.reject(new TypeError('Failed to fetch'));
    return Promise.resolve({ ok: true, status: 200, json: async () => (GOOD[key] || {}) });
  };
}

async function scenario(failOn) {
  const { sandbox, doc } = loadApp(mkFetch(failOn));
  let threw = null;
  try { await sandbox.loadDashboard(); } catch (e) { threw = e; }
  return { threw, hidden: doc.getElementById('dashboard-page').classList.contains('hidden') };
}

(async () => {
  console.log('\n== loadDashboard() reaches the dashboard even when one network call fails ==');
  const baseline = await scenario(null);
  check('baseline: nothing fails, no throw, dashboard becomes visible', !baseline.threw && !baseline.hidden);

  const regFails = await scenario('/api/registrations/me');
  check('registrations/me rejects outright: no throw, dashboard still becomes visible', !regFails.threw && !regFails.hidden, regFails.threw && regFails.threw.message);

  const groupsFails = await scenario('/api/groups/me');
  check('groups/me rejects outright: no throw, dashboard still becomes visible', !groupsFails.threw && !groupsFails.hidden, groupsFails.threw && groupsFails.threw.message);

  const abstractsFails = await scenario('/api/abstracts/me');
  check('abstracts/me rejects outright: no throw, dashboard still becomes visible', !abstractsFails.threw && !abstractsFails.hidden, abstractsFails.threw && abstractsFails.threw.message);

  console.log('\n== the dashboard appears before the network calls settle, not after ==');
  let resolveSlow;
  const slow = new Promise((r) => { resolveSlow = r; });
  const fetchImpl = (url) => {
    const key = String(url).split('?')[0];
    if (key === '/api/registrations/me') return slow.then(() => ({ ok: true, status: 200, json: async () => ({ registration: null }) }));
    return Promise.resolve({ ok: true, status: 200, json: async () => (GOOD[key] || {}) });
  };
  const { sandbox, doc } = loadApp(fetchImpl);
  const pending = sandbox.loadDashboard();
  await new Promise((r) => setTimeout(r, 20)); // let the synchronous part of loadDashboard run
  check('dashboard is already visible mid-flight, before the slow fetch resolves',
    !doc.getElementById('dashboard-page').classList.contains('hidden'));
  resolveSlow();
  await pending;
  check('dashboard is still visible once everything has resolved',
    !doc.getElementById('dashboard-page').classList.contains('hidden'));

  report();
})();
