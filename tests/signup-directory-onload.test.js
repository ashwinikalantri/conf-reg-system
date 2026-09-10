// Signup's designation and institute dropdowns were empty in production for
// five days, and typing into "Other" could not get past "Designation is
// required". New signups stopped almost completely.
//
// The cause: loadDirectorySuggestions was registered with
//   document.addEventListener('DOMContentLoaded', loadDirectorySuggestions)
// and later gained an id-prefix parameter, `prefix = 'reg'`. A listener is
// called with the Event as its first argument, and a default only applies to
// an argument that is undefined -- so prefix became the Event, the lookup
// searched for "[object Event]-designation-select", and the guard returned
// without a word. That same function is what attaches the Other box's input
// listener, so typed text never reached the hidden field the form reads.
//
// signup-directory-dropdown.test.js passed throughout, because it calls the
// function directly and never goes through the listener. This file drives the
// page the way a browser does: it fires the registered DOMContentLoaded
// listener with an Event, then types into Other.
const { check, report, appFile } = require('./harness');
const fs = require('fs');
const vm = require('vm');

const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
const DIRECTORY = {
  designations: ['Assistant Professor', 'Junior Resident'],
  institutions: ['Mahatma Gandhi Institute of Medical Sciences, Sevagram', 'AIIMS, Nagpur'],
};

// Elements that persist and keep their listeners, so a DOMContentLoaded and
// an 'input' can be fired at them like a browser would.
function page() {
  const els = {};
  const docListeners = {};
  const mk = (id) => (els[id] = els[id] || {
    id, value: '', innerHTML: '', textContent: '', readOnly: false, attrs: {}, options: [],
    listeners: {},
    classList: { c: new Set(/-other$/.test(id) ? ['hidden'] : []),
      add(k) { this.c.add(k); }, remove(k) { this.c.delete(k); },
      toggle(k, on) { on ? this.c.add(k) : this.c.delete(k); }, contains(k) { return this.c.has(k); } },
    dataset: {}, style: {}, focus() {}, select() {},
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    appendChild() {}, remove() {}, querySelector: () => null, querySelectorAll: () => [],
  });
  const doc = {
    getElementById: mk, querySelector: () => null, querySelectorAll: () => [],
    addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
    createElement: () => mk('c'), body: mk('b'), documentElement: mk('h'),
    readyState: 'loading', cookie: '',
  };
  const sandbox = {
    document: doc,
    window: { addEventListener() {}, location: { href: '', hash: '', pathname: '/', search: '' },
      matchMedia: () => ({ matches: false, addEventListener() {} }), history: { replaceState() {} } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node' },
    fetch: (url) => Promise.resolve({ ok: true,
      json: async () => (String(url).includes('/api/directory/suggestions') ? DIRECTORY : {}) }),
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, URL, Intl, Date, Math, JSON, Promise,
    requestAnimationFrame: (f) => setTimeout(f, 0),
  };
  sandbox.window.document = doc; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // The signup form's controls exist before the script runs, as on the page.
  ['reg-designation-select', 'reg-designation-other', 'reg-designation',
    'reg-institute-select', 'reg-institute-other', 'reg-institute'].forEach(mk);
  vm.runInContext(js, sandbox, { filename: 'app.js' });
  return { sandbox, els, docListeners };
}

// What a browser passes a DOMContentLoaded listener. Deliberately not
// undefined: that is the whole bug.
const EVENT = { type: 'DOMContentLoaded', target: {}, preventDefault() {}, stopPropagation() {} };
const settle = () => new Promise((r) => setTimeout(r, 20));

(async () => {
  const { sandbox, els, docListeners } = page();

  console.log('\n== The page loads the lists itself, on DOMContentLoaded ==');
  const onReady = docListeners.DOMContentLoaded || [];
  check('a DOMContentLoaded listener is registered', onReady.length > 0, onReady.length);
  // Fire every one exactly as a browser would: with an Event. Other
  // listeners may want a fuller DOM than this stub; they are not under test.
  for (const fn of onReady) { try { await fn(EVENT); } catch (e) { /* not under test */ } }
  await settle();

  const desig = els['reg-designation-select'].innerHTML;
  const inst = els['reg-institute-select'].innerHTML;
  check('the designation list is filled, not just its placeholder',
    DIRECTORY.designations.every((v) => desig.includes(v)), desig.slice(0, 160));
  check('the institute list is filled', DIRECTORY.institutions.every((v) => inst.includes(v)),
    inst.slice(0, 160));
  check('...with Other still offered last', inst.lastIndexOf('__other__') > inst.lastIndexOf('AIIMS, Nagpur'));

  console.log('\n== Picking from the list reaches the field the form submits ==');
  els['reg-designation-select'].value = 'Junior Resident';
  sandbox.onDirectorySelect('designation');
  check('a listed designation fills the hidden field',
    els['reg-designation'].value === 'Junior Resident', els['reg-designation'].value);

  console.log('\n== Typing into Other also reaches it -- the reported failure ==');
  els['reg-institute-select'].value = '__other__';
  sandbox.onDirectorySelect('institute');
  check('choosing Other opens the box', !els['reg-institute-other'].classList.contains('hidden'));
  const typed = els['reg-institute-other'];
  typed.value = 'District Hospital, Wardha';
  // The input listener that loadDirectorySuggestions attaches. If the loader
  // never ran, there is nothing here -- which is what stranded people.
  const inputHandlers = typed.listeners.input || [];
  check('the Other box has an input listener at all', inputHandlers.length > 0, inputHandlers.length);
  inputHandlers.forEach((fn) => fn({ type: 'input', target: typed }));
  check('what is typed reaches the hidden field the form validates',
    els['reg-institute'].value === 'District Hospital, Wardha', els['reg-institute'].value);

  console.log('\n== The loader cannot be broken the same way again ==');
  // Called with an Event directly, as a careless future caller might.
  const again = page();
  await again.sandbox.loadDirectorySuggestions(EVENT);
  await settle();
  check('handed an Event, it still fills the signup form',
    DIRECTORY.designations.every((v) => again.els['reg-designation-select'].innerHTML.includes(v)),
    again.els['reg-designation-select'].innerHTML.slice(0, 120));
  check('the listener is registered wrapped, not by reference',
    !/addEventListener\('DOMContentLoaded',\s*loadDirectorySuggestions\s*\)/.test(js));

  report();
})();
