// Several elements ship a placeholder in the markup and have JS replace it
// once a fetch returns -- "Registration Portal" before the real conference
// name, "Checking..." on the status chip, a 0 in every metric card. On a
// fast connection that is a flicker. On the connection this app actually
// runs over it is a page confidently stating things that are not true.
//
// They now wear .skeleton: the placeholder keeps its size but is transparent
// under a shimmer, so nothing shifts when the real value lands.
//
// The risk this introduces is worse than the flicker it removes -- an
// element that never receives a value would shimmer forever, which reads as
// broken. So most of these are about the clearing, not the shimmer.
const { check, report, appFile } = require('./harness');
const fs = require('fs');
const vm = require('vm');

const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
const css = fs.readFileSync(appFile('public', 'styles.css'), 'utf8');

console.log('\n== The shimmer keeps the layout still ==');
check('.skeleton exists', /^\.skeleton\s*\{/m.test(css));
check('the placeholder text is hidden rather than removed, so it still sizes the box',
  /\.skeleton\s*\{[^}]*color:\s*transparent/m.test(css));
check('it animates', /animation:\s*skeleton-shimmer/.test(css) && /@keyframes skeleton-shimmer/.test(css));
check('it stops animating for prefers-reduced-motion',
  /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,80}\.skeleton\s*\{\s*animation:\s*none/.test(css));
check('children of a skeleton are hidden too, not floating over the shimmer',
  /\.skeleton \*\s*\{\s*visibility:\s*hidden/.test(css));

console.log('\n== The markup wears it where a placeholder would otherwise show ==');
const hero = fs.readFileSync(appFile('views', 'portal', 'partials', 'hero.ejs'), 'utf8');
const dash = fs.readFileSync(appFile('views', 'portal', 'sections', 'dashboard.ejs'), 'utf8');
const adminHdr = fs.readFileSync(appFile('views', 'admin', 'partials', 'header.ejs'), 'utf8');
const payments = fs.readFileSync(appFile('views', 'admin', 'sections', 'payments.ejs'), 'utf8');
check('the portal hero conference name', /id="conf-name-h1" class="skeleton/.test(hero));
check('the admin header conference name', /id="conf-name-h1"[^>]*class="skeleton/.test(adminHdr));
check('the delegate name', /id="user-display-name" class="skeleton/.test(dash));
check('the payment status chip', /id="payment-status-tag" class="skeleton/.test(dash));
check('all six payment metric cards',
  (payments.match(/<p id="metric-[a-z-]+" class="skeleton /g) || []).length === 6,
  (payments.match(/<p id="metric-[a-z-]+" class="skeleton /g) || []).length);

console.log('\n== setText clears it, so every value it sets stops on its own ==');
function sandboxWith(elements) {
  const els = {};
  const mk = (id) => (els[id] = els[id] || {
    id, textContent: '', innerHTML: '', innerText: '', value: '', checked: false, disabled: false,
    classList: {
      c: new Set(elements[id] || []),
      add(k) { this.c.add(k); }, remove(k) { this.c.delete(k); },
      toggle(k, on) { on ? this.c.add(k) : this.c.delete(k); }, contains(k) { return this.c.has(k); },
    },
    dataset: {}, style: {}, setAttribute() {}, getAttribute: () => null,
    appendChild() {}, remove() {}, addEventListener() {},
    querySelector: () => null, querySelectorAll: () => [], focus() {}, select() {},
  });
  Object.keys(elements).forEach(mk);
  const doc = {
    getElementById: (id) => mk(id),
    querySelector: () => null,
    // settleSkeletons sweeps the document for anything still shimmering.
    querySelectorAll: (sel) => (sel === '.skeleton'
      ? Object.values(els).filter((e) => e.classList.contains('skeleton')) : []),
    addEventListener() {}, createElement: () => mk('created'),
    body: mk('body'), documentElement: mk('html'), readyState: 'loading', cookie: '', title: '',
  };
  const sandbox = {
    document: doc,
    window: { addEventListener() {}, location: { href: '', hash: '', pathname: '/', search: '' },
      matchMedia: () => ({ matches: false, addEventListener() {} }), history: { replaceState() {} } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node' },
    fetch: () => Promise.reject(new Error('no network')),
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, URL, Intl, Date, Math, JSON, Promise,
    requestAnimationFrame: (f) => setTimeout(f, 0),
  };
  sandbox.window.document = doc; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(js, sandbox, { filename: 'app.js' });
  return { sandbox, els };
}

{
  const { sandbox, els } = sandboxWith({ 'metric-verified-count': ['skeleton'] });
  check('starts shimmering', els['metric-verified-count'].classList.contains('skeleton'));
  sandbox.setText('metric-verified-count', 42);
  check('setText writes the value', String(els['metric-verified-count'].textContent) === '42');
  check('...and stops the shimmer', !els['metric-verified-count'].classList.contains('skeleton'));
}

console.log('\n== Nothing is left shimmering after the load, even a failed one ==');
{
  // The important case: a value the response had nothing for. The skeleton
  // has to end anyway -- "not known yet" must not become permanent.
  const { sandbox, els } = sandboxWith({
    'conf-name-h1': ['skeleton'], 'user-display-name': ['skeleton'],
    'never-filled': ['skeleton'],
  });
  sandbox.settleSkeletons();
  check('a value nothing ever set is settled too', !els['never-filled'].classList.contains('skeleton'));
  check('...and so are the rest',
    !els['conf-name-h1'].classList.contains('skeleton') && !els['user-display-name'].classList.contains('skeleton'));
}
check('loadDashboard settles them once every section has had its turn',
  /settleSkeletons\(\);\s*\n\}/.test(js.slice(js.indexOf('async function loadDashboard'), js.indexOf('async function loadDashboard') + 2200)));
check('renderBackendPayments settles them too',
  js.slice(js.indexOf('async function renderBackendPayments')).slice(0, 6000).includes('settleSkeletons()'));

console.log('\n== The conference name clears its own, since it bypasses setText ==');
{
  const { sandbox, els } = sandboxWith({ 'conf-name-h1': ['skeleton'] });
  // conferenceInfo is a top-level `let`: setting it on the sandbox object
  // from out here would make an unrelated global, leaving the real binding
  // untouched. It has to be assigned from inside the same script.
  sandbox.__CONF__ = { name: 'ICHQPS 2026', acronym: 'NQOCN', location: 'Sevagram' };
  vm.runInContext('conferenceInfo = __CONF__; applyConferenceInfoToDom();', sandbox);
  check('the real name is written', els['conf-name-h1'].textContent.includes('ICHQPS 2026'), els['conf-name-h1'].textContent);
  check('...and the shimmer stops', !els['conf-name-h1'].classList.contains('skeleton'));
}

report();
