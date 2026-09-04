// The admin panel opened straight into Registration Approval, so the first
// screen was a worklist rather than a picture. There is now an Overview tab
// first in the bar, carrying one figure per section and the delegate map
// (moved here from Payments, where it sat under an unrelated worklist).
//
// Two properties matter more than the numbers themselves:
//
//   * It must not become a second source of truth. Every figure comes from
//     the same endpoint the owning section uses -- the unmatched-credit
//     count in particular is taken from that endpoint's own `summary`
//     rather than recomputed, since its reconciliation handles split
//     credits and non-registration markings.
//   * It must not leak across roles. A card is shown only to someone who
//     can open the section behind it; the endpoints would 403 anyway, but
//     an empty box a reviewer cannot explain or act on is its own problem.
const { check, report, appFile } = require('./harness');
const fs = require('fs');
const vm = require('vm');
const perms = require('../permissions');

const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
const overview = fs.readFileSync(appFile('views', 'admin', 'sections', 'overview.ejs'), 'utf8');
const payments = fs.readFileSync(appFile('views', 'admin', 'sections', 'payments.ejs'), 'utf8');
const navTabs = fs.readFileSync(appFile('views', 'admin', 'partials', 'nav-tabs.ejs'), 'utf8');
const adminView = fs.readFileSync(appFile('views', 'admin.ejs'), 'utf8');

console.log('\n== It is the first tab, and it is wired in ==');
check('the section is included', /include\('admin\/sections\/overview'\)/.test(adminView));
check('...before payments',
  adminView.indexOf("admin/sections/overview") < adminView.indexOf("admin/sections/payments"));
check('the nav tab exists', /id="nav-tab-overview"/.test(navTabs));
check('...and is first in the bar',
  navTabs.indexOf('nav-tab-overview') < navTabs.indexOf('nav-tab-payments'));
check('overview leads MAIN_TABS', /const MAIN_TABS = \['overview',/.test(js));
check('switching to it renders it and the map',
  /if \(tab === 'overview'\) \{ renderBackendOverview\(\); renderDelegateMap\(\); \}/.test(js));

console.log('\n== The map moved rather than being duplicated ==');
check('the map markup now lives in overview', /id="delegate-map"/.test(overview));
check('...and no longer in payments', !/id="delegate-map"/.test(payments));
check('its controls came with it',
  /delegate-map-btn-registered/.test(overview) && /delegate-map-international/.test(overview));
check('payments no longer renders the map on switch',
  !/if \(tab === 'payments'\)[^\n]*renderDelegateMap/.test(js));

console.log('\n== A role only sees cards for sections it can open ==');
check('a section rule exists for overview', !!perms.SECTION_PERMISSIONS.overview);
check('...and it is anyOf, not a permission of its own',
  Array.isArray(perms.SECTION_PERMISSIONS.overview.anyOf), perms.SECTION_PERMISSIONS.overview);
check('an academic reviewer, who sees abstracts, gets the tab',
  perms.roleSeesSection('ACADEMIC_REVIEWER', 'overview'));
check('a finance admin, who sees payments, gets it too',
  perms.roleSeesSection('FINANCE_ADMIN', 'overview'));
check('operations, which sees none of the summarised sections, does not',
  !perms.roleSeesSection('OPERATIONS', 'overview'));
check('it introduces no new permission key',
  perms.SECTION_PERMISSIONS.overview.anyOf.every((k) => perms.PERMISSION_KEYS.includes(k)));

// --- drive the real render ------------------------------------------------
function run({ sections, registrations, abstracts, statement }) {
  const els = {};
  const mk = (id) => (els[id] = els[id] || {
    id, textContent: '', innerHTML: '', innerText: '', value: '',
    classList: { c: new Set(), add(k) { this.c.add(k); }, remove(k) { this.c.delete(k); },
      toggle(k, on) { on ? this.c.add(k) : this.c.delete(k); }, contains(k) { return this.c.has(k); } },
    dataset: {}, style: {}, setAttribute() {}, getAttribute: () => null,
    appendChild() {}, remove() {}, addEventListener() {},
    querySelector: () => null, querySelectorAll: () => [], focus() {}, select() {},
  });
  const doc = {
    getElementById: (id) => mk(id),
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, createElement: () => mk('created'),
    body: mk('body'), documentElement: mk('html'), readyState: 'loading', cookie: '', title: '',
  };
  const routes = {
    '/api/registrations': registrations,
    '/api/abstracts': abstracts,
    '/api/admin/bank-statement/reconcile': statement,
  };
  const sandbox = {
    document: doc,
    window: { addEventListener() {}, location: { href: '', hash: '', pathname: '/', search: '' },
      matchMedia: () => ({ matches: false, addEventListener() {} }), history: { replaceState() {} } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node' },
    fetch: (url) => {
      const body = routes[String(url).split('?')[0]];
      // Undefined here means the role could not read it -- a 403, exactly
      // what the server would send.
      if (body === undefined) return Promise.resolve({ ok: false, status: 403, json: async () => ({}) });
      return Promise.resolve({ ok: true, status: 200, json: async () => body });
    },
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, URL, Intl, Date, Math, JSON, Promise,
    requestAnimationFrame: (f) => setTimeout(f, 0),
  };
  sandbox.window.document = doc; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // mySections is a top-level `let`, so it has to be assigned from inside
  // the same script -- setting it on the sandbox would make a stray global.
  sandbox.__SECTIONS__ = sections;
  vm.runInContext(js + '\nmySections = __SECTIONS__;\n', sandbox, { filename: 'app.js+driver' });
  return { sandbox, els };
}

const REGS = { registrations: [
  { bank_status: 'BANK_VERIFIED', verified_total: 3000, expected_amount: 3000, paid_amount: 3000 },
  { bank_status: 'BANK_VERIFIED', verified_total: 2000, expected_amount: 2000, paid_amount: 2000 },
  { bank_status: 'PENDING', verified_total: 0, expected_amount: 3000, paid_amount: 3000 },
  { bank_status: 'PARTIAL_PAYMENT', verified_total: 750, expected_amount: 2000, paid_amount: 2000 },
] };
const ABS = { abstracts: [
  { status: 'UNDER_REVIEW' }, { status: 'UNDER_REVIEW' }, { status: 'ACCEPTED' },
] };
const STMT = { summary: { unmatchedCredits: 4 } };

(async () => {
  console.log('\n== The figures are the sections\' own arithmetic ==');
  const all = { payments: true, statement: true, abstracts: true };
  const { sandbox, els } = run({ sections: all, registrations: REGS, abstracts: ABS, statement: STMT });
  await sandbox.renderBackendOverview();

  check('collected sums the VERIFIED totals only', els['ov-collected'].textContent === '₹5,750',
    els['ov-collected'].textContent);
  check('delegates counts every submission', String(els['ov-delegates'].textContent) === '4');
  check('confirmed counts the verified', String(els['ov-confirmed'].textContent) === '2');
  check('awaiting approval excludes balance-due', String(els['ov-pending'].textContent) === '1',
    els['ov-pending'].textContent);
  check('outstanding is what the partial delegate still owes', els['ov-outstanding'].textContent === '₹1,250',
    els['ov-outstanding'].textContent);
  check('unmatched credits come from the endpoint summary, not recomputed',
    String(els['ov-unmatched'].textContent) === '4');
  check('abstracts shows those under review', String(els['ov-abstracts'].textContent) === '2');
  check('...with the totals beside it', /3 submitted · 1 accepted/.test(els['ov-abstracts-sub'].textContent),
    els['ov-abstracts-sub'].textContent);

  console.log('\n== A queue card appears only when it has something in it ==');
  check('awaiting approval is shown', !els['ov-q-payments'].classList.contains('hidden'));
  check('balance due is shown', !els['ov-q-balance'].classList.contains('hidden'));
  check('unmatched credits is shown', !els['ov-q-statement'].classList.contains('hidden'));
  check('the all-clear line is hidden while work is waiting',
    els['overview-all-clear'].classList.contains('hidden'));

  {
    const quiet = run({ sections: all, statement: { summary: { unmatchedCredits: 0 } },
      abstracts: { abstracts: [] },
      registrations: { registrations: [{ bank_status: 'BANK_VERIFIED', verified_total: 1000, expected_amount: 1000, paid_amount: 1000 }] } });
    await quiet.sandbox.renderBackendOverview();
    check('with nothing outstanding, every queue card is hidden',
      ['ov-q-payments', 'ov-q-balance', 'ov-q-statement', 'ov-q-abstracts']
        .every((id) => quiet.els[id].classList.contains('hidden')));
    check('...and the all-clear line is shown instead',
      !quiet.els['overview-all-clear'].classList.contains('hidden'));
  }

  console.log('\n== It shows a role only what that role could open anyway ==');
  {
    // An academic reviewer: abstracts only. The other endpoints are not even
    // called, and their cards stay hidden.
    const rev = run({ sections: { abstracts: true }, abstracts: ABS });
    await rev.sandbox.renderBackendOverview();
    check('the abstract queue is shown', !rev.els['ov-q-abstracts'].classList.contains('hidden'));
    check('the money block is hidden', rev.els['overview-money'].classList.contains('hidden'));
    check('the payment queue is hidden', rev.els['ov-q-payments'].classList.contains('hidden'));
    check('the statement queue is hidden', rev.els['ov-q-statement'].classList.contains('hidden'));
  }

  console.log('\n== A section that fails or 403s does not take the page down ==');
  {
    // statement omitted entirely -> the stub answers 403, as the server would.
    const partial = run({ sections: all, registrations: REGS, abstracts: ABS });
    let threw = null;
    try { await partial.sandbox.renderBackendOverview(); } catch (e) { threw = e; }
    check('no throw', !threw, threw && threw.message);
    check('the sections that did load still show', String(partial.els['ov-delegates'].textContent) === '4');
    check('nothing is left shimmering', !partial.els['ov-collected'].classList.contains('skeleton'));
  }

  report();
})();
