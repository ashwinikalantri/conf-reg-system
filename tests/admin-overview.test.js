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
const { check, report, appFile, openDb } = require('./harness');
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
function run({ sections, permissions, registrations, abstracts, statement, totals }) {
  const els = {};
  const asked = [];
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
    '/api/admin/finance-summary': totals,
  };
  const sandbox = {
    document: doc,
    window: { addEventListener() {}, location: { href: '', hash: '', pathname: '/', search: '' },
      matchMedia: () => ({ matches: false, addEventListener() {} }), history: { replaceState() {} } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node' },
    fetch: (url) => {
      asked.push(String(url).split('?')[0]);
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
  // myPermissions matters now that the two money figures are gated on
  // payments.view_totals rather than on seeing the Payments section.
  // Default: whoever sees payments also holds it, which is true of every
  // built-in role -- cases that need them apart pass `permissions`.
  sandbox.__PERMS__ = permissions || (sections.payments ? ['payments.view', 'payments.view_totals'] : []);
  vm.runInContext(js + '\nmySections = __SECTIONS__;\nmyPermissions = new Set(__PERMS__);\n',
    sandbox, { filename: 'app.js+driver' });
  return { sandbox, els, asked };
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
// What GET /api/admin/finance-summary returns for the REGS fixture above:
// 5,000 verified in total, and the one PARTIAL_PAYMENT delegate still owing
// 2,000 - 750 = 1,250.
const TOTALS = { success: true, collected: 5750, outstanding: 1250, owingCount: 1 };

(async () => {
  console.log('\n== The figures are the sections\' own arithmetic ==');
  const all = { payments: true, statement: true, abstracts: true };
  const { sandbox, els } = run({ sections: all, registrations: REGS, abstracts: ABS, statement: STMT, totals: TOTALS });
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
      totals: { success: true, collected: 1000, outstanding: 0, owingCount: 0 },
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
    const partial = run({ sections: all, registrations: REGS, abstracts: ABS, totals: TOTALS });
    let threw = null;
    try { await partial.sandbox.renderBackendOverview(); } catch (e) { threw = e; }
    check('no throw', !threw, threw && threw.message);
    check('the sections that did load still show', String(partial.els['ov-delegates'].textContent) === '4');
    check('nothing is left shimmering', !partial.els['ov-collected'].classList.contains('skeleton'));
  }

  console.log('\n== Conference-wide money is its own permission ==');
  // payments.view is operational -- working the approval queue. Total revenue
  // and total outstanding are a management figure, and a role may hold one
  // without the other. Crucially the totals now come from the server: the
  // Overview used to SUM /api/registrations in the browser, so hiding the
  // cards hid nothing from anyone who could open the Payments tab.
  check('the totals endpoint has its own key',
    perms.permissionForRoute('GET /api/admin/finance-summary') === 'payments.view_totals');
  check('...which is not payments.view',
    perms.permissionForRoute('GET /api/registrations') === 'payments.view');
  check('the finance roles hold it',
    ['SUPER_ADMIN', 'FINANCE_ADMIN', 'FINANCE_ACADEMIC'].every((r) => perms.roleCan(r, 'payments.view_totals')));
  check('...and the non-finance ones do not',
    ['ACADEMIC_REVIEWER', 'OPERATIONS'].every((r) => !perms.roleCan(r, 'payments.view_totals')));
  check('the client no longer sums registrations for the totals',
    !/const collected = all\.reduce/.test(js), 'client still derives collected');

  {
    // Someone who works payments but must not see conference-wide money.
    const opsOnly = run({ sections: { payments: true }, permissions: ['payments.view'],
      registrations: REGS });
    await opsOnly.sandbox.renderBackendOverview();
    const hidden = (id) => opsOnly.els[id].classList.contains('hidden');
    check('the two rupee cards are hidden without payments.view_totals',
      hidden('ov-card-collected') && hidden('ov-card-outstanding'));
    check('...while the headcounts still show', !hidden('overview-money'));
    check('...with the real numbers in them', String(opsOnly.els['ov-delegates'].textContent) === '4');
    // Stronger than checking the DOM: the figures are never even requested,
    // so there is nothing to reveal in devtools either.
    check('...and the totals endpoint is never called',
      !opsOnly.asked.includes('/api/admin/finance-summary'), opsOnly.asked);
  }
  {
    // The mirror: totals without row-level access, which is the role this
    // separation exists to make possible.
    const totalsOnly = run({ sections: { payments: true }, permissions: ['payments.view_totals'],
      totals: TOTALS });
    await totalsOnly.sandbox.renderBackendOverview();
    check('a totals-only role sees the money', totalsOnly.els['ov-collected'].textContent === '₹5,750',
      totalsOnly.els['ov-collected'].textContent);
    check('...and is not told a confirmed-registration count it cannot see',
      totalsOnly.els['ov-collected-sub'].textContent === '',
      totalsOnly.els['ov-collected-sub'].textContent);
  }

  console.log('\n== "Needs attention" belongs to whoever owns a queue in it ==');
  {
    const none = run({ sections: {}, permissions: [] });
    await none.sandbox.renderBackendOverview();
    check('the whole block is hidden with no relevant section',
      none.els['overview-attention'].classList.contains('hidden'));
    check('...so the all-clear line cannot claim anything either',
      none.els['overview-all-clear'].classList.contains('hidden'));
  }
  {
    // The line used to read "Nothing is waiting on a decision right now" to
    // everyone -- said to a reviewer while a payments queue they cannot see
    // piles up. It now names only what the reader can actually check.
    const quiet = { registrations: { registrations: [] }, abstracts: { abstracts: [] },
      statement: { summary: { unmatchedCredits: 0 } }, totals: { collected: 0, outstanding: 0, owingCount: 0 } };
    const rev = run({ sections: { abstracts: true }, permissions: ['abstracts.view'], ...quiet });
    await rev.sandbox.renderBackendOverview();
    const text = rev.els['overview-all-clear'].textContent;
    check('a reviewer is told only about abstracts', /abstracts/.test(text), text);
    check('...and not about registrations or the statement',
      !/registration|bank statement/.test(text), text);

    const fin = run({ sections: { payments: true, statement: true },
      permissions: ['payments.view', 'payments.view_totals', 'statement.view'], ...quiet });
    await fin.sandbox.renderBackendOverview();
    const finText = fin.els['overview-all-clear'].textContent;
    check('a finance admin is told about registrations and the statement',
      /registrations/.test(finText) && /bank statement/.test(finText), finText);
    check('...and not about abstracts', !/abstracts/.test(finText), finText);
  }

  console.log('\n== The split reaches databases seeded before it existed ==');
  // Roles are seeded once and never re-seeded, so a new catalogue key does
  // not reach roles already in a database. That is right for a genuinely new
  // permission and WRONG for one that splits an existing key: everyone with
  // payments.view could already see these totals, so without a backfill the
  // catalogue would grant it while the stored rows refused it -- which is
  // exactly what happened the first time this was run against a live
  // database (Finance Admin got a 403 for a figure it had always seen).
  {
    const db = openDb({ readOnly: true });
    const rows = await db.all(
      "SELECT role_key FROM role_permissions WHERE permission = 'payments.view_totals' ORDER BY role_key");
    const viewers = await db.all(
      `SELECT rp.role_key FROM role_permissions rp JOIN roles r ON r.key = rp.role_key
        WHERE rp.permission = 'payments.view' AND r.grants_all = 0 ORDER BY rp.role_key`);
    db.close();
    const got = rows.map((r) => r.role_key);
    const want = viewers.map((r) => r.role_key);
    check('every stored role holding payments.view also holds the totals key',
      want.every((r) => got.includes(r)), { want, got });
    check('...and it reached more than zero of them', got.length > 0, got);
    check('...without landing on a role that cannot see payments at all',
      got.every((r) => want.includes(r)), { want, got });
  }
  check('the backfill is declared, not ad hoc',
    /PERMISSION_BACKFILLS/.test(fs.readFileSync(appFile('server.js'), 'utf8')));

  report();
})();
