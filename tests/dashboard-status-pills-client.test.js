// Phase 04 of the portal UI plan: the dashboard's two status pills
// (payment-status-tag, abstract-status-tag) used to each carry their own ad
// hoc padding/border -- sometimes matching, sometimes not, across their five
// states. This drives the real app.js in a vm sandbox (same approach as the
// earlier phases' client tests) to check every state now renders the same
// pill shape, and that the balance-due summary still fills its three ids
// correctly now that it's tiles instead of an inline sentence.
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

function loadApp(js, fetchImpl) {
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
    fetch: fetchImpl || (() => Promise.reject(new Error('unexpected fetch'))),
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, URL, Intl, Date, Math, JSON,
    requestAnimationFrame: (f) => setTimeout(f, 0),
  };
  sandbox.window.document = doc; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(js, sandbox, { filename: 'app.js' });
  return { sandbox, els, doc };
}

// One canonical pill shape: this exact class list (modulo the semantic
// bg/text/border color) is what every state above should now produce.
const isCanonicalPill = (cls) => /\btext-xs\b/.test(cls) && /\bfont-bold\b/.test(cls)
  && /\bpx-2\.5\b/.test(cls) && /\bpy-1\b/.test(cls) && /\brounded-full\b/.test(cls) && /\bborder\b/.test(cls);

(async () => {
  const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');

  console.log('\n== payment-status-tag: one pill shape across every state ==');
  let loaded;
  try {
    loaded = loadApp(js);
  } catch (e) {
    check('app.js evaluates in the sandbox', false, e.message);
    return report();
  }
  check('app.js evaluates in the sandbox', true);

  const cases = [
    { name: 'no registration yet', reg: null, colorWord: 'amber' },
    { name: 'verified', reg: { bank_status: 'BANK_VERIFIED', registration_number: 'X1', selections: [] }, colorWord: 'emerald' },
    { name: 'rejected', reg: { bank_status: 'REJECTED', rejection_reason: 'WRONG_DETAILS' }, colorWord: 'rose' },
    { name: 'partial payment', reg: { bank_status: 'PARTIAL_PAYMENT', expected_amount: 5000, verified_total: 2000, remaining: 3000, pending_txn_count: 0 }, colorWord: 'orange' },
    { name: 'pending verification', reg: { bank_status: 'PENDING' }, colorWord: 'amber' },
    { name: 'flagged', reg: { bank_status: 'PENDING', is_flagged: true }, colorWord: 'amber' },
  ];
  for (const c of cases) {
    loaded.sandbox.applyRegistrationState(c.reg);
    const cls = loaded.els['payment-status-tag'].className;
    check(`${c.name}: canonical pill shape`, isCanonicalPill(cls), cls);
    check(`${c.name}: right semantic color`, cls.includes(c.colorWord), cls);
  }

  console.log('\n== The balance-due tiles still carry the right ids and values ==');
  loaded.sandbox.applyRegistrationState({ bank_status: 'PARTIAL_PAYMENT', expected_amount: 5000, verified_total: 2000, remaining: 3000, pending_txn_count: 0 });
  check('total fee tile', loaded.els['balance-fee'].innerText.includes('5,000') || loaded.els['balance-fee'].textContent.includes('5,000'),
    [loaded.els['balance-fee'].innerText, loaded.els['balance-fee'].textContent]);
  check('paid tile', loaded.els['balance-paid'].innerText.includes('2,000') || loaded.els['balance-paid'].textContent.includes('2,000'));
  check('balance due tile', loaded.els['balance-due'].innerText.includes('3,000') || loaded.els['balance-due'].textContent.includes('3,000'));
  check('balance banner is shown', !loaded.els['balance-banner'].classList.contains('hidden'));

  console.log('\n== abstract-status-tag: the same canonical pill shape ==');
  const abstractCases = [
    { name: 'not submitted', abstract: null, colorWord: 'slate' },
    { name: 'under review', abstract: { status: 'UNDER_REVIEW' }, colorWord: 'amber' },
    { name: 'accepted', abstract: { status: 'ACCEPTED' }, colorWord: 'emerald' },
    { name: 'rejected', abstract: { status: 'REJECTED' }, colorWord: 'rose' },
    { name: 'revision requested', abstract: { status: 'REVISION_REQUESTED', revision_note: 'fix intro' }, colorWord: 'orange' },
  ];
  for (const c of abstractCases) {
    const run = loadApp(js, () => Promise.resolve({ json: () => Promise.resolve({ abstract: c.abstract }) }));
    await run.sandbox.loadAbstractStatus();
    const cls = run.els['abstract-status-tag'].className;
    check(`${c.name}: canonical pill shape`, isCanonicalPill(cls), cls);
    check(`${c.name}: right semantic color`, cls.includes(c.colorWord), cls);
  }

  console.log('\n== Both pills now share the exact same shape ==');
  // Class ORDER is irrelevant to Tailwind/CSS -- compare as a set, not a
  // string, once colors are normalized out.
  const shapeSet = (cls) => cls.replace(/\b(amber|emerald|rose|orange|slate)-\d+\b/g, 'COLOR').split(/\s+/).filter(Boolean).sort().join(' ');
  const paymentShape = shapeSet(loaded.els['payment-status-tag'].className);
  const abstractRun = loadApp(js, () => Promise.resolve({ json: () => Promise.resolve({ abstract: { status: 'ACCEPTED' } }) }));
  await abstractRun.sandbox.loadAbstractStatus();
  const abstractShape = shapeSet(abstractRun.els['abstract-status-tag'].className);
  check('same set of structural classes once colors are normalized out', paymentShape === abstractShape, [paymentShape, abstractShape]);

  report();
})();
