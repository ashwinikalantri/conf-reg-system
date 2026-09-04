// Admin panel redesign, phase 11 (Abstracts): both cards lists rendered every
// matching abstract in raw fetch order, with no separation between "still
// needs a decision" and "already decided" -- Step 1's own description says
// the task is "Accept or reject each submission", so as a conference's
// submissions grow, the ones actually needing that decision get buried among
// ones that don't. renderBackendAbstracts() now sorts pending-first (Step 1)
// and unassigned-first (Step 2) while preserving each group's relative
// order. Drives the real function in a vm sandbox with a stub fetch.
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
    fetch: fetchImpl,
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, URL, Intl, Date, Math, JSON,
    requestAnimationFrame: (f) => setTimeout(f, 0),
  };
  sandbox.window.document = doc; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(js, sandbox, { filename: 'app.js' });
  return { sandbox, els, doc };
}

// Pulls the ordered list of titles out of the rendered card HTML -- each
// card's title is the first <h4> from abstractCardHeader().
const titlesInOrder = (html) => [...html.matchAll(/<h4 class="font-bold text-slate-800">([^<]+)<\/h4>/g)].map((m) => m[1]);

(async () => {
  const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');

  console.log('\n== Step 1 (Approval): pending abstracts sort before decided ones ==');
  {
    const abstracts = [
      { id: 1, title: 'Already Accepted', author_name: 'A', format: 'Oral', status: 'ACCEPTED' },
      { id: 2, title: 'Still Pending One', author_name: 'B', format: 'Poster', status: 'UNDER_REVIEW' },
      { id: 3, title: 'Already Rejected', author_name: 'C', format: 'Oral', status: 'REJECTED' },
      { id: 4, title: 'Still Pending Two', author_name: 'D', format: 'Poster', status: 'UNDER_REVIEW' },
    ];
    const fetchImpl = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ abstracts }) });
    const { sandbox, doc } = loadApp(js, fetchImpl);
    await sandbox.renderBackendAbstracts();
    const order = titlesInOrder(doc.getElementById('abstracts-approval-container').innerHTML);
    check('all four cards rendered', order.length === 4, order);
    check('both pending abstracts come first', order.slice(0, 2).sort().join(',') === 'Still Pending One,Still Pending Two', order);
    check('decided ones follow', order.slice(2).sort().join(',') === 'Already Accepted,Already Rejected', order);
    check('within the pending group, original (submission) order is preserved',
      order[0] === 'Still Pending One' && order[1] === 'Still Pending Two', order);
    check('within the decided group, original order is preserved',
      order[2] === 'Already Accepted' && order[3] === 'Already Rejected', order);
  }

  console.log('\n== Step 2 (Assignment): unassigned approved abstracts sort before assigned ones ==');
  {
    const abstracts = [
      { id: 1, title: 'Already Assigned Oral', author_name: 'A', format: 'Oral', status: 'ACCEPTED', allocation: 'ORAL' },
      { id: 2, title: 'Needs Assignment One', author_name: 'B', format: 'Poster', status: 'ACCEPTED' },
      { id: 3, title: 'Not Approved Yet', author_name: 'C', format: 'Oral', status: 'UNDER_REVIEW' },
      { id: 4, title: 'Needs Assignment Two', author_name: 'D', format: 'Poster', status: 'ACCEPTED' },
      { id: 5, title: 'Already Assigned Poster', author_name: 'E', format: 'Poster', status: 'ACCEPTED', allocation: 'POSTER' },
    ];
    const fetchImpl = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ abstracts }) });
    const { sandbox, doc } = loadApp(js, fetchImpl);
    await sandbox.renderBackendAbstracts();
    const order = titlesInOrder(doc.getElementById('abstracts-assignment-container').innerHTML);
    check('only the 4 ACCEPTED abstracts appear (not-yet-approved excluded)', order.length === 4, order);
    check('does not include the not-yet-approved one', !order.includes('Not Approved Yet'), order);
    check('unassigned ones come first, in original order',
      order[0] === 'Needs Assignment One' && order[1] === 'Needs Assignment Two', order);
    check('already-assigned ones follow, in original order',
      order[2] === 'Already Assigned Oral' && order[3] === 'Already Assigned Poster', order);
  }

  console.log('\n== No abstracts needing action: no crash, empty-state messages intact ==');
  {
    const fetchImpl = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ abstracts: [] }) });
    const { sandbox, doc } = loadApp(js, fetchImpl);
    await sandbox.renderBackendAbstracts();
    check('approval container shows the empty message', /No abstracts submitted yet/.test(doc.getElementById('abstracts-approval-container').innerHTML));
  }

  report();
})();
