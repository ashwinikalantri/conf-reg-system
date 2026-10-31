// The admin panel after the design review of 29 Oct 2026:
//
//   * Registration › Approval: the counts are the filters. Awaiting decision
//     is the worklist (an empty one says "All caught up"), with balance due
//     and rejected below it as "Still needs a hand"; each other count shows
//     just its own list; Verified goes to Reports for whoever may not
//     un-approve.
//   * Overview: faculty cards (no room, pickup not decided, not signed up)
//     that open the Faculty tab filtered; on the conference days a Now band,
//     each hall open for attendance and how many are marked, a quiet door
//     flagged.
//   * One primary colour (navy), numbers bold not black, sentence-case
//     labels on the Overview, and the top tabs one row that scrolls.
const { check, report, appFile } = require('./harness');
const fs = require('fs');
const vm = require('vm');
const glob = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? glob(`${dir}/${d.name}`) : [`${dir}/${d.name}`]));

const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
const payments = fs.readFileSync(appFile('views', 'admin', 'sections', 'payments.ejs'), 'utf8');
const overview = fs.readFileSync(appFile('views', 'admin', 'sections', 'overview.ejs'), 'utf8');
const tabs = fs.readFileSync(appFile('views', 'admin', 'partials', 'nav-tabs.ejs'), 'utf8');

function load(perms) {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) {
      const s = new Set(['hidden']);
      const attrs = {};
      els.set(id, { id, value: '', innerHTML: '', textContent: '', className: '', open: false, dataset: {}, style: {},
        classList: { add: (...c) => c.forEach((x) => s.add(x)), remove: (...c) => c.forEach((x) => s.delete(x)),
          toggle: (c, on) => { const w = on === undefined ? !s.has(c) : !!on; if (w) s.add(c); else s.delete(c); return w; }, contains: (c) => s.has(c) },
        setAttribute: (k, v) => { attrs[k] = String(v); }, getAttribute: (k) => attrs[k] ?? null,
        addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] });
    }
    return els.get(id);
  };
  const sb = {
    document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
      createElement: () => el(`tmp${Math.random()}`), body: el('body'), documentElement: el('html'), readyState: 'loading', cookie: '' },
    window: { addEventListener() {}, location: { href: '', hash: '', pathname: '/admin', search: '', origin: 'https://x' },
      matchMedia: () => ({ matches: false, addEventListener() {} }), history: { replaceState() {} }, scrollTo() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node' }, fetch: () => Promise.reject(new Error('no network')),
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval, URL, Intl, Date, Math, JSON, Promise, requestAnimationFrame: () => 0,
  };
  sb.window.document = sb.document; sb.self = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(`${js}
    myPermissions = new Set(${JSON.stringify(perms)});
    globalThis.__tabs = [];
    switchBackendTab = (t) => globalThis.__tabs.push(t);
    globalThis.__counts = (c) => { paymentCounts = c; };
    globalThis.__f = { setPaymentFilter, applyPaymentFilter, renderOverviewNow, openFacultyFlag };
    globalThis.__flag = () => pendingGuestFlag;`, sb);
  return { sb, el };
}

console.log('\n== Registration › Approval ==');
check('the five tiles are gone; the counts are filters', !/lg:grid-cols-5/.test(payments)
  && ['pending', 'balance', 'rejected', 'verified'].every((k) => new RegExp(`id="pay-filter-${k}" onclick="setPaymentFilter\\('${k}'\\)"`).test(payments))
  && /Awaiting decision · <span id="metric-pending-count"/.test(payments) && /<span id="metric-total-amount"[^>]*>₹0<\/span> cleared/.test(payments));
check('an empty worklist says "All caught up"', /All caught up<\/p>\s*<p class="text-sm text-slate-500">Nothing awaiting a decision/.test(js));
{
  const { sb, el } = load(['payments.view']);
  sb.__counts({ pending: 0, balance: 1, rejected: 1, verified: 363, canUnapprove: false });
  sb.__f.applyPaymentFilter();
  check('awaiting decision: the worklist, then "Still needs a hand" with balance due and rejected', !el('pay-main').classList.contains('hidden')
    && !el('pay-needs-hand').classList.contains('hidden') && !el('balance-section').classList.contains('hidden') && !el('rejected-section').classList.contains('hidden')
    && el('verified-section').classList.contains('hidden'));
  check('...the selected count navy, the two needing a hand in rose', /bg-navy border-navy text-white/.test(el('pay-filter-pending').className)
    && /border-rose-200 text-rose-800/.test(el('pay-filter-balance').className) && /border-slate-300/.test(el('pay-filter-verified').className));
  sb.__f.setPaymentFilter('balance');
  check('balance due: just that list, opened', el('pay-main').classList.contains('hidden') && !el('balance-section').classList.contains('hidden')
    && el('balance-section').open === true && el('rejected-section').classList.contains('hidden') && el('pay-needs-hand').classList.contains('hidden'));
  sb.__counts({ pending: 2, balance: 0, rejected: 1, verified: 363, canUnapprove: false });
  sb.__f.setPaymentFilter('balance');
  check('...and none: says so', !el('pay-filter-empty').classList.contains('hidden') && el('pay-filter-empty').textContent === 'No one has a balance due.');
  sb.__f.setPaymentFilter('verified');
  check('verified, for someone who may not un-approve: Reports', sb.__tabs.includes('reports'));
}
{
  const { sb, el } = load(['payments.view', 'payments.unapprove']);
  sb.__counts({ pending: 0, balance: 0, rejected: 0, verified: 5, canUnapprove: true });
  sb.__f.setPaymentFilter('verified');
  check('...for someone who may: the verified list, opened', !el('verified-section').classList.contains('hidden') && el('verified-section').open === true && el('pay-main').classList.contains('hidden'));
}

console.log('\n== Overview ==');
check('faculty cards, each opening the Faculty tab filtered', /id="ov-q-rooms" onclick="openFacultyFlag\('noAccommodation'\)"/.test(overview)
  && /id="ov-q-pickups"/.test(overview) && /id="ov-q-signup" onclick="openFacultyFlag\('notSignedUp'\)"/.test(overview)
  && /const seesFaculty = can\('guests\.view'\);/.test(js) && /seesFaculty \? getJson\('\/api\/guests'\)/.test(js));
check('...the filter is applied when the Faculty tab draws', /if \(pendingGuestFlag !== null\) \{\s*const flagSel = document\.getElementById\('guests-filter-flag'\);/.test(js));
{
  const { sb } = load(['guests.view']);
  sb.__f.openFacultyFlag('noAccommodation');
  check('...e.g. faculty needing a room', sb.__flag() === 'noAccommodation' && sb.__tabs.includes('faculty'));
}
check('labels in sentence case, numbers bold not black', !/uppercase/.test(overview) && !/font-black/.test(overview));
{
  const { sb, el } = load(['attendance.view']);
  const ist = new Date(Date.now() + 5.5 * 3600e3);
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const nowMin = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  sb.__f.renderOverviewNow({ sessions: [
    { hall: 'Main Auditorium', title: 'Quality as a Strategy', start: hhmm(Math.max(0, nowMin - 30)), end: hhmm(Math.min(1439, nowMin + 30)), present: 41, enrolled: null, window: { open: true } },
    { hall: 'Hall B', title: 'Community Health Workers', start: hhmm(Math.max(0, nowMin - 20)), end: hhmm(Math.min(1439, nowMin + 40)), present: 0, enrolled: null, window: { open: true } },
    { hall: 'Hall A', title: 'Later talk', start: '23:58', end: '23:59', present: 0, enrolled: null, window: { open: false } },
  ] });
  const html = el('overview-now-halls').innerHTML;
  check('on the day: each hall open for attendance, how many marked', !el('overview-now').classList.contains('hidden') && /Main Auditorium · until/.test(html) && /41 <span[^>]*>marked present/.test(html));
  check('...a door with nobody marked after ten minutes is flagged', /border-amber-300 bg-amber-50[\s\S]*?Hall B[\s\S]*?No one marked yet: check the door volunteer/.test(html));
  check('...sessions not open are left out', !/Later talk/.test(html));
  sb.__f.renderOverviewNow({ sessions: [] });
  check('...and with none open, no band', el('overview-now').classList.contains('hidden'));
}

console.log('\n== Across the panel ==');
const adminViews = glob(appFile('views', 'admin')).filter((f) => f.endsWith('.ejs')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
check('one primary colour: navy, not steel or slate', !/bg-indigo-600 hover:bg-indigo-700|bg-slate-700 hover:bg-slate-800|bg-slate-800 hover:bg-slate-900/.test(adminViews + js)
  && (adminViews.match(/bg-navy hover:bg-indigo-700/g) || []).length > 40);
check('numbers bold, never black', !/font-black/.test(adminViews + js));
check('the desks: links in the bar from 1200px, the ☰ panel\'s first rows below it', /<nav id="nav-tabs" aria-label="Desks">/.test(tabs)
  && /@media \(min-width: 1200px\) \{[\s\S]*?#nav-tabs \{ flex-direction: row;/.test(fs.readFileSync(appFile('public', 'styles.css'), 'utf8'))
  && (tabs.match(/class="cbar-link( hidden)?">/g) || []).length === 6);
report();
