// Designation and institute were free-text inputs with a <datalist>. A
// datalist suggests but never obliges, so people typed instead of picking
// and the same place arrived 19 different ways -- "MGIMS Sevagram",
// "MGIMS Sevagram ", "MGIMS Sevagram .", "Mahatma Gandhi Institute Of
// Medical Sciences Sewagram" -- between them 41% of the conference.
//
// They are dropdowns now, with an "Other" option so nobody genuinely new is
// locked out. The <select> and the Other box are presentation: the value
// everything downstream reads still comes from a hidden input of the
// original id, which is why handleRegister and validateSignupStep did not
// have to change.
//
// Separately, server.js tidies both fields on every write, so the mechanical
// variants cannot come back through the admin edit screen either.
const { call, check, report, appFile } = require('./harness');
const fs = require('fs');
const vm = require('vm');

const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
const authViewRaw = fs.readFileSync(appFile('views', 'portal', 'sections', 'auth.ejs'), 'utf8');
// Comments stripped: the markup carries a note explaining why the datalist
// was replaced, and naming the thing you removed should not read as still
// having it. Same reason the email-palette check strips comments.
const authView = authViewRaw.replace(/<!--[\s\S]*?-->/g, '');
const serverSrc = fs.readFileSync(appFile('server.js'), 'utf8');

function harness(data) {
  const els = {};
  const mk = (id) => (els[id] = els[id] || {
    id, value: '', innerHTML: '', textContent: '',
    // The real markup ships the Other box with class="hidden"; the stub has
    // to start the same way or "is it hidden?" tests nothing.
    classList: { c: new Set(/-other$/.test(id) ? ['hidden'] : []),
      add(k) { this.c.add(k); }, remove(k) { this.c.delete(k); },
      toggle(k, on) { on ? this.c.add(k) : this.c.delete(k); }, contains(k) { return this.c.has(k); } },
    dataset: {}, style: {}, focus() {}, select() {}, setAttribute() {}, getAttribute: () => null,
    appendChild() {}, remove() {}, addEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
  });
  const doc = {
    getElementById: mk, querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, createElement: () => mk('c'),
    body: mk('b'), documentElement: mk('h'), readyState: 'loading', cookie: '',
  };
  const sandbox = {
    document: doc,
    window: { addEventListener() {}, location: { href: '', hash: '', pathname: '/', search: '' },
      matchMedia: () => ({ matches: false, addEventListener() {} }), history: { replaceState() {} } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node' },
    fetch: () => Promise.resolve({ ok: true, json: async () => data }),
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, URL, Intl, Date, Math, JSON, Promise,
    requestAnimationFrame: (f) => setTimeout(f, 0),
  };
  sandbox.window.document = doc; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(js, sandbox, { filename: 'app.js' });
  ['reg-designation-select', 'reg-designation-other', 'reg-designation',
    'reg-institute-select', 'reg-institute-other', 'reg-institute'].forEach(mk);
  return { sandbox, els };
}

const DATA = {
  designations: ['Assistant Professor', 'Junior Resident', 'Student'],
  institutions: ['MGIMS Sevagram', 'Kasturba Nursing College, Sevagram', 'AIIMS, Nagpur'],
};

(async () => {
  console.log('\n== The form offers a list, not a blank box ==');
  check('designation is a select', /id="reg-designation-select"[^>]*<\/select>|id="reg-designation-select"/.test(authView));
  check('institute is a select', /id="reg-institute-select"/.test(authView));
  check('each keeps a hidden field of the original id, so nothing downstream changed',
    /type="hidden" id="reg-designation"/.test(authView) && /type="hidden" id="reg-institute"/.test(authView));
  check('the free-text datalists are gone', !/datalist/.test(authView));
  check('the Other boxes ship hidden',
    /id="reg-designation-other"[^>]*class="hidden/.test(authView)
    && /id="reg-institute-other"[^>]*class="hidden/.test(authView));

  console.log('\n== Suggestions are ordered by how many people gave them ==');
  // In a list of 125 institutions, the one 41% belong to should not be
  // somewhere in the M's.
  check('the endpoint orders by count', /ORDER BY n DESC, designation/.test(serverSrc)
    && /ORDER BY n DESC, institution/.test(serverSrc));
  const live = await call('GET', '/api/directory/suggestions');
  check('it answers without a session (signup happens before one exists)', live.status === 200, live.status);
  check('...with both lists', Array.isArray(live.body.designations) && Array.isArray(live.body.institutions));

  console.log('\n== Picking from the list fills the field everything reads ==');
  const { sandbox, els } = harness(DATA);
  await sandbox.loadDirectorySuggestions();
  const opts = els['reg-institute-select'].innerHTML;
  check('every known value is offered', DATA.institutions.every((v) => opts.includes(v)));
  check('the commonest comes first',
    opts.indexOf('MGIMS Sevagram') < opts.indexOf('AIIMS, Nagpur'));
  check('Other is last, being the escape hatch not a suggestion',
    opts.lastIndexOf('__other__') > opts.lastIndexOf('AIIMS, Nagpur'));
  check('the Other box stays hidden while there is a list',
    els['reg-institute-other'].classList.contains('hidden'));

  els['reg-institute-select'].value = 'MGIMS Sevagram';
  sandbox.onDirectorySelect('institute');
  check('choosing one sets the hidden field', els['reg-institute'].value === 'MGIMS Sevagram',
    els['reg-institute'].value);
  check('...and leaves the Other box shut', els['reg-institute-other'].classList.contains('hidden'));

  console.log('\n== "Other" still lets anyone in ==');
  els['reg-institute-select'].value = '__other__';
  sandbox.onDirectorySelect('institute');
  check('the box opens', !els['reg-institute-other'].classList.contains('hidden'));
  els['reg-institute-other'].value = '  Some New Hospital, Pune  ';
  sandbox.onDirectorySelect('institute');
  check('what is typed reaches the hidden field, trimmed',
    els['reg-institute'].value === 'Some New Hospital, Pune', els['reg-institute'].value);

  els['reg-institute-select'].value = 'AIIMS, Nagpur';
  sandbox.onDirectorySelect('institute');
  check('switching back to a listed value wins', els['reg-institute'].value === 'AIIMS, Nagpur');
  check('...and clears what was typed, so it cannot be resubmitted later',
    els['reg-institute-other'].value === '', els['reg-institute-other'].value);

  console.log('\n== A conference with nothing on file yet is not a dead end ==');
  {
    const fresh = harness({ designations: [], institutions: [] });
    await fresh.sandbox.loadDirectorySuggestions();
    check('the select opens on Other', fresh.els['reg-institute-select'].value === '__other__');
    check('...with the box already showing',
      !fresh.els['reg-institute-other'].classList.contains('hidden'));
  }

  console.log('\n== The server tidies both fields on every write ==');
  // Otherwise an admin correcting a name through Users & Roles puts the
  // trailing spaces straight back.
  check('there is one helper, not a rule per call site', /function tidyFreeText\(/.test(serverSrc));
  check('it normalises spacing and trailing punctuation',
    /replace\(\/\\s\+\/g, ' '\)\.trim\(\)\.replace\(\/\[\.,;:\\s\]\+\$\/, ''\)/.test(serverSrc));
  check('it does NOT touch case, which would make MGIMS into Mgims',
    !/toLowerCase|toUpperCase|titleCase/.test(
      serverSrc.slice(serverSrc.indexOf('function tidyFreeText('), serverSrc.indexOf('function tidyFreeText(') + 400)));
  check('signup uses it', /tidyFreeText\(designation\), tidyFreeText\(institute\)/.test(serverSrc));
  check('the admin edit screen uses it too', /TIDY_FIELDS\.has\(f\) \? tidyFreeText/.test(serverSrc));

  report();
})();
