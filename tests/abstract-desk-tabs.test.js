// The Review Desk redesign (19 Nov 2026): the five steps as tabs with their
// counts, one shown at a time, opening on the first with work in it; one
// search across every step; "Waiting on you", each count a way into its
// step; Presentations a table on a laptop and cards on a phone.
const fs = require('fs');
const vm = require('vm');
const { call, adminLogin, appFile, check, report } = require('./harness');

// A small DOM, enough for the desk's own code to run.
function makeDoc() {
  const els = {};
  const classList = () => {
    const c = new Set();
    return { c, add: (...k) => k.forEach((x) => c.add(x)), remove: (...k) => k.forEach((x) => c.delete(x)), contains: (k) => c.has(k),
      toggle(k, on) { const v = on === undefined ? !c.has(k) : on; if (v) c.add(k); else c.delete(k); return v; } };
  };
  const el = (id, extra = {}) => {
    const attrs = {};
    const e = { id, innerHTML: '', textContent: '', value: '', style: {}, dataset: {}, classList: classList(), className: '',
      setAttribute: (k, v) => { attrs[k] = String(v); }, getAttribute: (k) => attrs[k], querySelector: () => null, scrollIntoView() {}, ...extra };
    return e;
  };
  const panels = ['1', '2', '3', '4', '5', '6'].map((n) => { const p = el(`panel-${n}`); p.dataset.step = n; return p; });
  panels[4].classList.add('hidden');                     // Prizes, not loaded
  panels[5].classList.add('hidden');                     // Zenodo, switched off
  const doc = {
    getElementById: (id) => { if (!els[id]) els[id] = el(id); return els[id]; },
    querySelector: (sel) => { const m = /data-step="(\d)"/.exec(sel); return m ? panels[Number(m[1]) - 1] : null; },
    querySelectorAll: (sel) => (/abs-panel/.test(sel) ? panels : []),
    addEventListener() {}, body: el('body'), documentElement: el('html'),
  };
  return { doc, els, panels };
}

(async () => {
  const admin = await adminLogin();
  const html = (await call('GET', '/admin', null, admin)).raw;
  const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');

  console.log('\n== The page ==');
  const tabs = [...html.matchAll(/id="abs-tab-(\d)"[^>]*onclick="showAbstractStep\('(\d)', true\)"[\s\S]*?<span class="abs-tab-n text-slate-400">\d<\/span>([^<]+)</g)].map((m) => `${m[1]}${m[3]}`);
  check('six steps as tabs, in order (Step 4 Running order since 20 Nov; Step 5 Prizes since 22 Nov)', tabs.join() === '1Approval,2Assignment,3Presentations,4Running order,5Prizes,6Zenodo', tabs);
  check('...that stay in reach while scrolling', /<nav id="abs-tabs" class="sticky top-0/.test(html));
  check('each step a panel the tabs show one at a time', ['approval', 'assignment', 'presentations', 'screens', 'prizes', 'zenodo'].every((b, i) => new RegExp(`id="abstracts-${b}-block" class="[^"]*abs-panel[^"]*" data-step="${i + 1}"`).test(html)));
  check('one search for every step', /id="abs-search" type="search"[^>]*oninput="setAbstractSearch\(this\.value\)"/.test(html) && /title, author, Reg No, #id/.test(html));
  check('"Waiting on you" above the tabs', html.indexOf('Waiting on you') < html.indexOf('id="abs-tabs"') && /id="abs-waiting"/.test(html));
  check('no folds left', !/abs-step group|<details class="abs-step/.test(html) && !/rememberAbstractStep|restoreAbstractSteps/.test(js));

  console.log('\n== Opening, counting, searching ==');
  const { doc, els, panels } = makeDoc();
  const store = {};
  const abstracts = [
    { id: 1, title: 'Partograph completion', author_name: 'Asha Patil', format: 'Poster', status: 'UNDER_REVIEW', reg_no: 'NQOCN20261001' },
    { id: 2, title: 'Hand hygiene', author_name: 'Rohan Mehta', format: 'Paper', status: 'ACCEPTED' },
    { id: 3, title: 'Sepsis bundle', author_name: 'Sneha Kulkarni', format: 'Poster', status: 'ACCEPTED', allocation: 'POSTER', decision_sent_at: 1 },
  ];
  const sb = {
    document: doc, window: { addEventListener() {}, location: { href: '', hash: '', pathname: '/', search: '' }, matchMedia: () => ({ matches: false, addEventListener() {} }), history: { replaceState() {} } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    navigator: { userAgent: 'node' }, console: { log() {}, warn() {}, error() {}, info() {} },
    fetch: (url) => Promise.resolve({ ok: true, json: () => Promise.resolve(/\/api\/abstracts$/.test(url) ? { abstracts } : { success: false }) }),
    setTimeout, clearTimeout, setInterval, clearInterval, URL, Intl, Date, Math, JSON, requestAnimationFrame: (f) => setTimeout(f, 0),
  };
  sb.window.document = doc; sb.self = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(js, sb, { filename: 'app.js' });
  vm.runInContext("myPermissions = new Set(['abstracts.view', 'abstracts.review', 'abstracts.assign'])", sb);
  await sb.renderBackendAbstracts();
  const shown = () => panels.filter((p) => p.style.display !== 'none' && !p.classList.contains('hidden')).map((p) => p.dataset.step).join();
  check('it opens on the first step with work: Approval, with one to review', vm.runInContext('absStep', sb) === '1' && shown() === '1', [vm.runInContext('absStep', sb), shown()]);
  check('...the tab counts what waits there', /1 to review/.test(els['abs-tab-count-1'].textContent) && /1 to assign/.test(els['abs-tab-count-2'].textContent));
  check('"Waiting on you" says it, each a way into its step', /<b[^>]*>1<\/b> to review →/.test(els['abs-waiting'].innerHTML) && /showAbstractStep\('2', true\)/.test(els['abs-waiting'].innerHTML));
  check('a switched-off step has no tab', els['abs-tab-6'].classList.contains('hidden') && els['abs-tab-5'].classList.contains('hidden'));
  sb.showAbstractStep('3', true);
  check('a tab chosen is shown alone, and remembered for this browser tab', shown() === '3' && store.nqocn_abs_step === '3');
  sb.setAbstractSearch('rohan');
  await new Promise((r) => setTimeout(r, 0));
  check('a search with nothing in the step shown moves to the step that has it', vm.runInContext('absStep', sb) === '2'
    && /Hand hygiene/.test(els['abstracts-assignment-container'].innerHTML) && els['abs-tab-count-2'].textContent === '1 found', [vm.runInContext('absStep', sb), els['abs-tab-count-2'].textContent]);
  sb.setAbstractSearch('#1');
  await new Promise((r) => setTimeout(r, 0));
  check('...a #id finds that abstract', /Partograph completion/.test(els['abstracts-approval-container'].innerHTML) && !/Hand hygiene/.test(els['abstracts-assignment-container'].innerHTML));
  sb.setAbstractSearch('NQOCN20261001');
  await new Promise((r) => setTimeout(r, 0));
  check('...and so does a registration number', /Partograph completion/.test(els['abstracts-approval-container'].innerHTML));
  check('Approval is compact rows in one list', /class="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100 overflow-hidden">\s*<div class="abs-row/.test(els['abstracts-approval-container'].innerHTML));

  console.log('\n== Presentations ==');
  check('a table on a laptop with fixed columns, cards on a phone', /lg:grid lg:grid-cols-\[3\.5rem_minmax\(0,1fr\)_7\.5rem_13rem_8rem_11rem\]/.test(js)
    && /<span>#<\/span><span>Abstract · presenter<\/span><span>Format<\/span><span>File<\/span><span>Email<\/span>/.test(js));
  check('...filtered by Not received, and by Not emailed', /\['AWAITING', 'Not received'\]/.test(js) && /\['NOT_EMAILED', 'Not emailed'\]/.test(js));
  check('the poster screens keep their order when searching: the rest are dimmed', /absSearch && !posterHit\(p\) \? 'opacity-30' : ''/.test(js));
  report();
})();
