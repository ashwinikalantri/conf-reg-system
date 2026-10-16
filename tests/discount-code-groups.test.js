// The discount code list in three collapsible groups: Unused, Expired, Used.
//
// Which group a code is in follows the rules the tags already use:
//   * Used -- a personal code its holder's registration carries, or a shared
//     code at its usage limit. Used wins over Expired: a used code has nothing
//     left to extend, whatever its date.
//   * Expired -- unused, and past its last date (the ones with Extend).
//   * Unused -- everything still available, including a shared code with uses
//     left.
// Each group collapses; the choice is remembered per browser, and Used starts
// collapsed as history.
const { check, report, appFile } = require('./harness');
const fs = require('fs');
const vm = require('vm');

const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
const ist = (days) => new Date(Date.now() + 5.5 * 3600e3 + days * 864e5).toISOString().slice(0, 10);

// app.js run whole, with just enough of a browser for it to load.
function load(store) {
  const el = () => ({ value: '', innerHTML: '', textContent: '', style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, setAttribute() {}, getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [] });
  const sandbox = {
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
      createElement: el, body: el(), documentElement: el(), readyState: 'loading', cookie: '' },
    window: { addEventListener() {}, location: { href: '', hash: '', pathname: '/', search: '' },
      matchMedia: () => ({ matches: false, addEventListener() {} }), history: { replaceState() {} } },
    localStorage: store,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node' }, fetch: () => Promise.reject(new Error('no network')),
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval, URL, Intl, Date, Math, JSON, Promise,
    requestAnimationFrame: () => 0,
  };
  sandbox.window.document = sandbox.document; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${js}\n globalThis.__g = { discountCodeTableHtml, discountCodeGroup, toggleDiscGroup, discGroupOpen };`, sandbox);
  return sandbox;
}
const memory = (initial = {}) => { const m = new Map(Object.entries(initial)); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };

const CODES = [
  { id: 1, code: 'FRESH', discount_type: 'PERCENT', discount_value: 10, scope_type: 'INDIVIDUAL', scope_value: '9000000101', applied_count: 0, expires_at: ist(20), active: 1 },
  { id: 2, code: 'SHARED', discount_type: 'PERCENT', discount_value: 5, scope_type: 'GLOBAL', applied_count: 3, max_uses: null, expires_at: null, active: 1 },
  { id: 3, code: 'LAPSED', discount_type: 'FLAT', discount_value: 500, scope_type: 'INDIVIDUAL', scope_value: '9000000102', applied_count: 0, expires_at: ist(-2), active: 1 },
  { id: 4, code: 'TAKEN', discount_type: 'FEE_TIER', fee_tier: 'early', discount_value: 0, scope_type: 'INDIVIDUAL', scope_value: '9000000103', applied_count: 1, expires_at: ist(-5), active: 1 },
  { id: 5, code: 'CAPPED', discount_type: 'PERCENT', discount_value: 15, scope_type: 'GLOBAL', applied_count: 2, max_uses: 2, expires_at: ist(30), active: 1 },
  // Switched off: by an admin while unused and in date; after use; and
  // automatically when its holder registered without it.
  { id: 6, code: 'PAUSED', discount_type: 'PERCENT', discount_value: 25, scope_type: 'INDIVIDUAL', scope_value: '9000000104', applied_count: 0, expires_at: ist(15), active: 0 },
  { id: 7, code: 'USEDOFF', discount_type: 'PERCENT', discount_value: 25, scope_type: 'INDIVIDUAL', scope_value: '9000000105', applied_count: 1, expires_at: ist(15), active: 0 },
  { id: 8, code: 'RETIRED', discount_type: 'PERCENT', discount_value: 10, scope_type: 'INDIVIDUAL', scope_value: '9000000106', applied_count: 0, holder_registered: 1, expires_at: ist(15), active: 0 },
  { id: 9, code: 'OFFLAPSED', discount_type: 'PERCENT', discount_value: 10, scope_type: 'INDIVIDUAL', scope_value: '9000000107', applied_count: 0, expires_at: ist(-3), active: 0 },
];
const rowsOf = (html, group) => (html.match(new RegExp(`<tr data-disc-group="${group}" class="([^"]*)">[\\s\\S]*?<\\/tr>`, 'g')) || []);
const codesIn = (html, group) => rowsOf(html, group).map((r) => (r.match(/font-mono font-bold text-slate-800">([^<]+)</) || [])[1]).filter(Boolean);
const label = (k) => k;

console.log('\n== Each code is in the right group ==');
const sb = load(memory());
const html = sb.__g.discountCodeTableHtml(CODES, label);
check('Unused: a fresh personal code, and a shared code with uses left', JSON.stringify(codesIn(html, 'unused')) === '["FRESH","SHARED"]', codesIn(html, 'unused'));
check('Expired: an unused code past its date', JSON.stringify(codesIn(html, 'expired')) === '["LAPSED"]', codesIn(html, 'expired'));
check('Used: a used personal code -- even past its date -- and a shared code at its limit',
  JSON.stringify(codesIn(html, 'used')) === '["TAKEN","CAPPED"]', codesIn(html, 'used'));
check('Deactivated: every switched-off code, whatever else is true of it',
  JSON.stringify(codesIn(html, 'deactivated')) === '["PAUSED","USEDOFF","RETIRED","OFFLAPSED"]', codesIn(html, 'deactivated'));
check('...so none of them appears under Unused, Expired or Used',
  ['PAUSED', 'USEDOFF', 'RETIRED', 'OFFLAPSED'].every((c) => !codesIn(html, 'unused').includes(c) && !codesIn(html, 'expired').includes(c) && !codesIn(html, 'used').includes(c)));
check('every code appears exactly once', ['FRESH', 'SHARED', 'LAPSED', 'TAKEN', 'CAPPED', 'PAUSED', 'USEDOFF', 'RETIRED', 'OFFLAPSED']
  .every((c) => (html.match(new RegExp(`>${c}<`, 'g')) || []).length === 1));
const tagOf = (code) => { const r = (html.match(new RegExp(`<tr data-disc-group="[^"]+" class="[^"]*">(?:(?!</tr>)[\\s\\S])*>${code}<[\\s\\S]*?</tr>`)) || [])[0] || ''; return r; };
check('a code switched off when its holder registered says so', />Holder registered</.test(tagOf('RETIRED')));
check('one an admin switched off is tagged Deactivated', />Deactivated</.test(tagOf('PAUSED')));
check('a used code that was later switched off still reads Used', />Used</.test(tagOf('USEDOFF')));
check('a switched-off code that has expired offers no Extend -- it would do nothing until activated',
  !/Extend</.test(tagOf('OFFLAPSED')));

console.log('\n== Each group has a header with its count, in a sensible order ==');
const heads = [...html.matchAll(/id="disc-group-head-(\w+)"[\s\S]*?uppercase tracking-wide">(\w+)<\/span>\s*<span[^>]*>(\d+)<\/span>/g)].map((m) => [m[1], m[2], Number(m[3])]);
check('Unused, then Expired, then Used, then Deactivated', JSON.stringify(heads.map((h) => h[0])) === '["unused","expired","used","deactivated"]', heads);
check('...each with its count', JSON.stringify(heads.map((h) => h[2])) === '[2,1,2,4]', heads);
check('the headers are buttons, so the keyboard can open them', (html.match(/<button type="button" id="disc-group-head-/g) || []).length === 4);

console.log('\n== Unused and Expired start open; Used starts collapsed ==');
check('Unused rows are showing', rowsOf(html, 'unused').every((r) => !/class="hidden/.test(r)));
check('Expired rows are showing -- they may need extending', rowsOf(html, 'expired').every((r) => !/class="hidden/.test(r)));
check('Used rows are collapsed', rowsOf(html, 'used').every((r) => /class="hidden/.test(r)));
check('Deactivated rows are collapsed too -- history, like Used', rowsOf(html, 'deactivated').every((r) => /class="hidden/.test(r)));
check('...and each header says whether it is open',
  /id="disc-group-head-unused"[^>]*aria-expanded="true"/.test(html) && /id="disc-group-head-used"[^>]*aria-expanded="false"/.test(html));

console.log('\n== Collapsing a group, and remembering it ==');
const store = memory();
const sb2 = load(store);
const fakeRows = [{ classList: { hidden: false, toggle(c, on) { this.hidden = on; } } }, { classList: { hidden: false, toggle(c, on) { this.hidden = on; } } }];
const head = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, querySelector: () => ({ style: {} }) };
sb2.document.querySelectorAll = (sel) => (sel === '[data-disc-group="unused"]' ? fakeRows : []);
sb2.document.getElementById = (id) => (id === 'disc-group-head-unused' ? head : null);
sb2.__g.toggleDiscGroup('unused');
check('collapsing hides that group\'s rows', fakeRows.every((r) => r.classList.hidden === true));
check('...says so on its header', head.attrs['aria-expanded'] === 'false');
check('...and is remembered', store.getItem('nqocn_disc_group_unused') === '0');
sb2.__g.toggleDiscGroup('unused');
check('opening it again shows them', fakeRows.every((r) => r.classList.hidden === false) && store.getItem('nqocn_disc_group_unused') === '1');
const sb3 = load(memory({ nqocn_disc_group_used: '1', nqocn_disc_group_unused: '0' }));
const remembered = sb3.__g.discountCodeTableHtml(CODES, label);
check('a remembered choice beats the default: Used opened earlier stays open', rowsOf(remembered, 'used').every((r) => !/class="hidden/.test(r)));
check('...and Unused collapsed earlier stays collapsed', rowsOf(remembered, 'unused').every((r) => /class="hidden/.test(r)));

console.log('\n== It still works where the browser refuses storage ==');
// A browser blocking site data throws on any storage access -- it used to
// throw as app.js loaded, taking the whole page down with it.
const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
let sb4 = null;
try { sb4 = load(blocked); } catch (e) { sb4 = null; }
check('app.js itself loads with storage blocked -- the whole panel used to fail here', !!sb4);
if (!sb4) { report(); process.exit(0); }
let html4 = null;
try { html4 = sb4.__g.discountCodeTableHtml(CODES, label); } catch (e) { html4 = null; }
check('the list still renders, with the defaults', !!html4 && rowsOf(html4, 'used').every((r) => /class="hidden/.test(r)));
let threw = false;
try { sb4.__g.toggleDiscGroup('used'); } catch (e) { threw = true; }
check('...and a header can still be clicked', !threw);

console.log('\n== Empty groups and an empty list ==');
const onlyFresh = sb.__g.discountCodeTableHtml([CODES[0]], label);
check('a group with nothing in it says so', /No expired codes\./.test(onlyFresh) && /No used codes\./.test(onlyFresh));
check('...and still shows its header, with 0', /id="disc-group-head-expired"[\s\S]*?>0<\/span>/.test(onlyFresh));
check('no codes at all: one plain message, no empty groups', sb.__g.discountCodeTableHtml([], label).includes('No discount codes yet.')
  && !sb.__g.discountCodeTableHtml([], label).includes('disc-group-head'));

console.log('\n== Deactivate, never Delete ==');
const allRows = ['unused', 'expired', 'used', 'deactivated'].flatMap((g) => rowsOf(html, g));
check('no row offers Delete', allRows.length === 9 && allRows.every((r) => !/>Delete</.test(r) && !/deleteDiscountCode/.test(r)));
check('every row offers Deactivate or Activate', allRows.every((r) => /toggleDiscountCode\(/.test(r) && />(Deactivate|Activate)</.test(r)));
check('the delete handler is gone from the page', !/function deleteDiscountCode\(/.test(js));

report();
