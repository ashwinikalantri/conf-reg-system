// The review window, redesigned (19 Nov 2026): the abstract's text first,
// its authors, registration and history beside it; Previous / Next through
// the list it was opened from; the decision fixed at the foot -- Approve &
// next first, Reject only under More and asking first.
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
  const panels = ['1', '2', '3', '4', '5'].map((n) => { const p = el(`panel-${n}`); p.dataset.step = n; return p; });
  panels[4].classList.add('hidden');                     // Zenodo, switched off
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
  const modal = html.slice(html.indexOf('id="modal-abstract-review"'), html.indexOf('id="abstract-review-modal-actions"') + 200);

  console.log('\n== The window ==');
  check('full screen on a phone, wide on a laptop', /id="modal-abstract-review" class="hidden fixed inset-0[^"]*sm:items-center sm:p-4/.test(html) && /max-w-5xl sm:rounded-2xl[^"]*h-full sm:h-\[90vh\]/.test(modal));
  check('Previous and Next, with where it is in the list', /id="abstract-review-prev" onclick="stepAbstractReview\(-1\)"/.test(modal) && /id="abstract-review-next" onclick="stepAbstractReview\(1\)"/.test(modal) && /id="abstract-review-position"/.test(modal));
  check('the text first, the details in a strip beside it', modal.indexOf('id="abstract-review-modal-body"') < modal.indexOf('id="abstract-review-side"') && /lg:grid-cols-\[minmax\(0,1fr\)_17rem\]/.test(modal));
  check('the decision at the foot, below the corrections boxes', modal.indexOf('id="abstract-revision-box"') < modal.indexOf('id="abstract-review-modal-actions"'));

  console.log('\n== Walking the list ==');
  const { doc, els } = makeDoc();
  const abstracts = [
    { id: 1, title: 'First', author_name: 'A', format: 'Poster', status: 'UNDER_REVIEW', background: '<b>Why</b> it matters' },
    { id: 2, title: 'Second', author_name: 'B', format: 'Paper', status: 'UNDER_REVIEW', text: 'An old one-box abstract <script>' },
    { id: 3, title: 'Third', author_name: 'C', format: 'Poster', status: 'UNDER_REVIEW', author_registered: 1, reg_no: 'NQOCN20261003' },
  ];
  const puts = [];
  const sb = {
    document: doc, window: { addEventListener() {}, location: { href: '', hash: '', pathname: '/', search: '' }, matchMedia: () => ({ matches: false, addEventListener() {} }), history: { replaceState() {} } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node' }, console: { log() {}, warn() {}, error() {}, info() {} },
    fetch: (url, opts) => {
      const m = /\/api\/abstracts\/(\d+)\/status/.exec(url);
      if (m) { const body = JSON.parse(opts.body); puts.push(`${m[1]}:${body.status}`); abstracts.find((a) => String(a.id) === m[1]).status = body.status; return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) }); }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(/\/api\/abstracts$/.test(url) ? { abstracts } : { success: false }) });
    },
    setTimeout, clearTimeout, setInterval, clearInterval, URL, Intl, Date, Math, JSON, requestAnimationFrame: (f) => setTimeout(f, 0),
  };
  sb.window.document = doc; sb.self = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(js, sb, { filename: 'app.js' });
  // As the reviewers have it: approved abstracts leave Approval for Assignment.
  vm.runInContext("myPermissions = new Set(['abstracts.view', 'abstracts.review', 'abstracts.assign']); showToast = function () {};", sb);
  await sb.renderBackendAbstracts();
  sb.openAbstractReview(1);
  const actions = () => els['abstract-review-modal-actions'].innerHTML;
  check('opened from Approval, it says where it is', els['abstract-review-position'].textContent === 'Approval · 1 of 3' && els['abstract-review-prev'].disabled === true && els['abstract-review-next'].disabled === false, els['abstract-review-position'].textContent);
  check('Approve & next comes first, then Approve and Send back', /Approve &amp; next[\s\S]*>Approve<[\s\S]*Send back for corrections/.test(actions()));
  check('Reject only under More, asking first', !/>Reject<\/button>/.test(actions()) && /id="abstract-review-more"[\s\S]*Reject… <span class="text-slate-500">\(asks first\)/.test(actions())
    && /status === 'REJECTED' && !\(await showConfirm\(/.test(js));
  check('the sections as written, in readable type', /<b>Why<\/b> it matters/.test(els['abstract-review-modal-body'].innerHTML) && /text-\[15px\] leading-relaxed/.test(els['abstract-review-modal-body'].innerHTML));
  sb.stepAbstractReview(1);
  check('Next goes to the next in the list', els['abstract-review-modal-actions'].dataset.id === 2 || els['abstract-review-modal-actions'].dataset.id === '2');
  check('an abstract written as one box shows it, escaped', /An old one-box abstract &lt;script&gt;/.test(els['abstract-review-modal-body'].innerHTML));
  await sb.decideAbstract('ACCEPTED', true);
  check('Approve & next: approved, and on to the next, counted afresh', puts.join() === '2:ACCEPTED' && String(els['abstract-review-modal-actions'].dataset.id) === '3'
    && els['abstract-review-position'].textContent === 'Approval · 2 of 2', [puts, els['abstract-review-position'].textContent]);
  check('the strip: registered, with the Reg No', /Registered · <span class="tabular-nums">NQOCN20261003<\/span>/.test(els['abstract-review-side'].innerHTML));
  check('at the end of the list, plain Approve leads', !/Approve &amp; next/.test(actions()) && /bg-emerald-600[^"]*"[^>]*>Approve<|onclick="decideAbstract\('ACCEPTED'\)" class="[^"]*bg-emerald-600/.test(actions()));
  vm.runInContext("myPermissions = new Set(['abstracts.view'])", sb);
  sb.openAbstractReview(3);
  check('a role that may only read sees no decisions', /deciding is for a reviewer/.test(actions()) && !/decideAbstract/.test(actions()));
  check('← and → step through, unless typing', /e\.key === 'ArrowLeft'\) stepAbstractReview\(-1\)/.test(js) && /\^\(INPUT\|TEXTAREA\|SELECT\)\$/.test(js));
  report();
})();
