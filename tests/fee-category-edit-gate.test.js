// Everything about a fee category is edited in #modal-fee-category, opened
// by one Edit action on the row. The table itself is read-only.
//
// It got there in two steps. Labels became editable and shipped as live text
// inputs in the row; that was too easy to change by accident, and the
// consequence is not cosmetic -- saving a renamed category rewrites
// registrations.category_label for every registration in it, which is what
// receipts and exports print. An inline "Edit name" toggle fixed the labels
// but left the fee inputs live and split editing across two idioms. Now
// there is one.
//
// What these check is that the read-only guarantee actually holds (no inputs
// in the rendered row at all) and that Delete cannot be offered for a
// category something references -- the server refuses that with a 409, and
// the button should say so rather than letting the press fail.
const { check, report, appFile } = require('./harness');
const fs = require('fs');
const vm = require('vm');

const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
const modal = fs.readFileSync(appFile('views', 'admin', 'modals', 'fee-category.ejs'), 'utf8');
const adminView = fs.readFileSync(appFile('views', 'admin.ejs'), 'utf8');

// --- the row, rendered by the real renderBackendFees --------------------
function renderRows(categories) {
  const els = {};
  const mk = (id) => (els[id] = els[id] || {
    id, innerHTML: '', textContent: '', innerText: '', value: '', checked: false, disabled: false,
    min: '', max: '', classList: { c: new Set(), add(k) { this.c.add(k); }, remove(k) { this.c.delete(k); },
      toggle(k, on) { on ? this.c.add(k) : this.c.delete(k); }, contains(k) { return this.c.has(k); } },
    addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], focus() {}, select() {},
    // showToast builds a real element, so the stub needs the DOM surface it
    // touches -- otherwise a toast fired by the code under test crashes the
    // run rather than failing a check.
    setAttribute() {}, getAttribute: () => null, appendChild() {}, removeChild() {}, remove() {},
    style: {}, dataset: {},
  });
  const doc = {
    getElementById: (id) => mk(id),
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, createElement: () => mk('c'),
    body: mk('body'), documentElement: mk('html'), readyState: 'loading', cookie: '',
  };
  const payload = {
    '/api/admin/fees': { categories, config: {}, phase: 'early' },
    '/api/conference': { startDate: '2026-11-18' },
  };
  const sandbox = {
    document: doc,
    window: { addEventListener() {}, location: { href: '', hash: '', pathname: '/', search: '' },
      matchMedia: () => ({ matches: false, addEventListener() {} }), history: { replaceState() {} } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node' },
    fetch: (url) => Promise.resolve({ ok: true, status: 200, json: async () => payload[String(url).split('?')[0]] || {} }),
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, URL, Intl, Date, Math, JSON, Promise,
    requestAnimationFrame: (f) => setTimeout(f, 0),
  };
  sandbox.window.document = doc; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(js, sandbox, { filename: 'app.js' });
  return { sandbox, els, doc };
}

const IN_USE = {
  id: 5, category_key: 'faculty_mo', label: 'Doctor', subtitle: 'Faculty and MOs',
  early_fee: 3000, regular_fee: 3500, late_fee: 4000, spot_fee: 4500,
  active: 1, requires_student_id: 0, registrations: 59, drifted: 11,
};
const UNUSED = {
  id: 6, category_key: 'brand_new', label: 'Brand New', subtitle: '',
  early_fee: 100, regular_fee: 200, late_fee: 300, spot_fee: 400,
  active: 0, requires_student_id: 1, registrations: 0, drifted: 0,
};

(async () => {
  const { sandbox, els, doc } = renderRows([IN_USE, UNUSED]);
  await sandbox.renderBackendFees();
  const rows = els['fee-table-body'].innerHTML;

  console.log('\n== The table is read-only ==');
  check('the rendered rows contain no input of any kind', !/<input/i.test(rows),
    (rows.match(/<input[^>]*>/g) || []).slice(0, 2).join(' '));
  check('...so none of the old inline edit classes survive',
    !/fee-label|fee-subtitle|fee-early|fee-regular|fee-late|fee-spot|fee-studentid/.test(rows));
  check('fees are shown as formatted amounts instead', /₹3,000/.test(rows), rows.slice(0, 300));
  check('the label and subtitle are shown as text', rows.includes('Doctor') && rows.includes('Faculty and MOs'));
  check('the immutable key is still shown', rows.includes('faculty_mo'));

  console.log('\n== One Edit action, on the right ==');
  check('each row has an Edit button carrying its id',
    /class="fee-edit[^"]*"[^>]*data-id="5"/.test(rows) && /data-id="6"/.test(rows), rows.slice(-400));
  check('the old Save / Deactivate / Delete row buttons are gone',
    !/fee-save|fee-toggle|fee-delete/.test(rows));
  check('drift is still surfaced on the row', rows.includes('on an older name'));

  console.log('\n== The modal covers every field, not just the label ==');
  for (const id of ['fc-label', 'fc-subtitle', 'fc-early', 'fc-regular', 'fc-late', 'fc-spot', 'fc-studentid', 'fc-active']) {
    check(`the modal has ${id}`, modal.includes(`id="${id}"`));
  }
  check('it is wired into the admin page', /include\('admin\/modals\/fee-category'\)/.test(adminView));
  check('the key is displayed but has no input', modal.includes('id="fc-key"') && !/id="fc-key"[^>]*<input/.test(modal));

  console.log('\n== Opening it fills every field from the row ==');
  sandbox.openFeeCategoryModal(5);
  check('label', els['fc-label'].value === 'Doctor', els['fc-label'].value);
  check('subtitle', els['fc-subtitle'].value === 'Faculty and MOs');
  check('all four fees', els['fc-early'].value === 3000 && els['fc-spot'].value === 4500);
  check('active reflects the row', els['fc-active'].checked === true);
  check('student-ID reflects the row', els['fc-studentid'].checked === false);
  check('the key is shown', els['fc-key'].textContent === 'faculty_mo', els['fc-key'].textContent);

  console.log('\n== Delete is refused for a category in use, and says why ==');
  check('the button is disabled', els['fc-delete-btn'].disabled === true);
  check('...and the reason names the count',
    /59 registrations use this category/.test(els['fc-delete-note'].textContent), els['fc-delete-note'].textContent);
  check('...and points at deactivating instead',
    /Untick Active/.test(els['fc-delete-note'].textContent));
  // Even called directly -- the button is not the only guard.
  let deleted = false;
  sandbox.showConfirm = () => { deleted = true; return Promise.resolve(true); };
  await sandbox.deleteFeeCategory(5);
  check('calling delete directly still refuses, without even confirming', deleted === false);

  console.log('\n== ...and offered for one nothing references ==');
  sandbox.openFeeCategoryModal(6);
  check('the button is enabled', els['fc-delete-btn'].disabled === false);
  check('...and says it can be deleted',
    /can be deleted/.test(els['fc-delete-note'].textContent), els['fc-delete-note'].textContent);
  check('an unused category reflects its own state', els['fc-active'].checked === false && els['fc-studentid'].checked === true);

  console.log('\n== Renaming states its blast radius before it happens ==');
  sandbox.openFeeCategoryModal(5);
  check('the note names how many registrations a rename would rewrite',
    /59 existing registrations/.test(els['fc-rename-note'].textContent), els['fc-rename-note'].textContent);
  check('...and is hidden when there is nothing to rewrite',
    (sandbox.openFeeCategoryModal(6), els['fc-rename-note'].classList.contains('hidden')));

  console.log('\n== Realign appears only when rows have drifted ==');
  sandbox.openFeeCategoryModal(5);
  check('shown for a drifted category', !els['fc-drift'].classList.contains('hidden'));
  check('...naming the count', /11 registrations/.test(els['fc-drift-msg'].textContent), els['fc-drift-msg'].textContent);
  sandbox.openFeeCategoryModal(6);
  check('hidden when nothing has drifted', els['fc-drift'].classList.contains('hidden'));

  console.log('\n== Realign quotes the SAVED label, never an unsaved edit ==');
  sandbox.openFeeCategoryModal(5);
  els['fc-label'].value = 'Not saved yet';
  let asked = '';
  sandbox.showConfirm = (msg) => { asked = msg; return Promise.resolve(false); };
  await sandbox.realignFeeCategory(5);
  check('the confirm quotes the stored label', asked.includes('Doctor'), asked);
  check('...not the unsaved text', !asked.includes('Not saved yet'), asked);

  report();
})();
