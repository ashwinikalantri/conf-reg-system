// The desk search box originally only worked on submit: type a name, wait,
// read an error if it was not exact enough. At a counter that is backwards --
// the delegate is standing there while you type -- so it offers people as you
// go.
//
// GET /api/desk/search is deliberately a different endpoint from
// GET /api/desk/delegate/:identifier. They answer different questions: the
// lookup RESOLVES (given what this person produced, who are they), the search
// OFFERS (given a few characters, who might you mean). Folding them together
// would mean either the lookup guessing on partial input, or the suggestions
// inheriting its "exactly one match" rule and showing nothing until the
// answer was already certain -- which is precisely when suggestions stop
// being useful.
const { call, check, report, ADMIN_PW, appFile, adminLogin, loginPassword } = require('./harness');
const fs = require('fs');
const vm = require('vm');

const DESK = '9000000006';         // Dez Counter, FRONT_DESK
const REVIEWER = '9000000003';     // Rae Reviewer -- no desk permission
const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');

// A sandbox that drives the real type-ahead functions. fetch is a stub whose
// responses can be delayed and inspected, which is the only way to test the
// out-of-order case honestly.
function harness() {
  const els = {};
  const mk = (id) => (els[id] = els[id] || {
    id, value: '', innerHTML: '', textContent: '',
    attrs: {},
    classList: { c: new Set(id === 'desk-suggestions' ? ['hidden'] : []),
      add(k) { this.c.add(k); }, remove(k) { this.c.delete(k); },
      toggle(k, on) { on ? this.c.add(k) : this.c.delete(k); }, contains(k) { return this.c.has(k); } },
    dataset: {}, style: {}, focus() {}, select() {},
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
    appendChild() {}, remove() {}, addEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
  });
  const doc = {
    getElementById: mk, querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, createElement: () => mk('c'),
    body: mk('b'), documentElement: mk('h'), readyState: 'loading', cookie: '',
  };
  const calls = [];
  let responder = () => ({ success: true, results: [] });
  const sandbox = {
    document: doc,
    window: { addEventListener() {}, location: { href: '', hash: '', pathname: '/', search: '' },
      matchMedia: () => ({ matches: false, addEventListener() {} }), history: { replaceState() {} } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node' },
    fetch: (url) => { calls.push(url); return Promise.resolve({ ok: true, json: async () => responder(url) }); },
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, URL, Intl, Date, Math, JSON, Promise,
    requestAnimationFrame: (f) => setTimeout(f, 0),
  };
  sandbox.window.document = doc; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(js, sandbox, { filename: 'app.js' });
  ['desk-search', 'desk-suggestions'].forEach(mk);
  return { sandbox, els, calls, setResponder: (f) => { responder = f; } };
}

const person = (n, over) => ({
  phone_number: `90000010${String(n).padStart(2, '0')}`, full_name: `Person ${n}`,
  registration_number: `REG${n}`, category_label: 'Doctor', checked_in: false, ...over,
});
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const desk = await loginPassword(DESK, ADMIN_PW);
  const reviewer = await loginPassword(REVIEWER, ADMIN_PW);
  await adminLogin();

  console.log('\n== The endpoint offers people on partial input ==');
  const byName = await call('GET', '/api/desk/search?q=Payment', null, desk);
  check('a partial name returns matches', byName.status === 200 && byName.body.results.length > 0,
    byName.body.results && byName.body.results.length);
  check('...each carrying what tells two people apart',
    byName.body.results.every((r) => r.phone_number && r.full_name),
    byName.body.results[0]);
  check('...including whether they have already arrived',
    byName.body.results.every((r) => Object.prototype.hasOwnProperty.call(r, 'checked_in')));

  const byPhone = await call('GET', '/api/desk/search?q=900000100', null, desk);
  check('a partial mobile number matches', byPhone.body.results.length > 0, byPhone.body.results.length);
  const byEmail = await call('GET', '/api/desk/search?q=one.payment', null, desk);
  check('a partial email matches', byEmail.body.results.length > 0, byEmail.body.results.length);
  const one = await call('GET', '/api/desk/delegate/9000001001', null, desk);
  const regNo = one.body.registration.registration_number;
  const byReg = await call('GET', `/api/desk/search?q=${encodeURIComponent(regNo.slice(0, -2))}`, null, desk);
  check('a partial registration number matches', byReg.body.results.length > 0, byReg.body.results.length);
  check('...case-insensitively, since it is read off a phone and retyped',
    (await call('GET', `/api/desk/search?q=${encodeURIComponent(regNo.toLowerCase())}`, null, desk))
      .body.results.length > 0);

  console.log('\n== It declines to dump the delegate list ==');
  // One character matches a large share of a conference. The server refuses
  // rather than trusting the client to hold back.
  const single = await call('GET', '/api/desk/search?q=a', null, desk);
  check('a single character returns nothing', single.status === 200 && single.body.results.length === 0,
    single.body.results.length);
  const empty = await call('GET', '/api/desk/search?q=', null, desk);
  check('an empty query returns nothing', empty.body.results.length === 0);
  const broad = await call('GET', '/api/desk/search?q=an', null, desk);
  check('and even a broad match is capped', broad.body.results.length <= 8, broad.body.results.length);

  console.log('\n== A LIKE wildcard is data, not syntax ==');
  // Unescaped, '%' matches everybody -- the whole user table through a search
  // box. It has to be treated as a literal character somebody typed.
  const pct = await call('GET', '/api/desk/search?q=%25%25', null, desk);
  check('a bare % matches nobody rather than everybody',
    pct.status === 200 && pct.body.results.length === 0, pct.body.results.length);
  const underscore = await call('GET', '/api/desk/search?q=__', null, desk);
  check('nor does _ act as a single-character wildcard',
    underscore.body.results.length === 0, underscore.body.results.length);

  console.log('\n== The likeliest person comes first ==');
  // Somebody whose name STARTS with what was typed is far more likely to be
  // the one at the counter than somebody who merely contains it.
  const pre = await call('GET', '/api/desk/search?q=One', null, desk);
  check('a prefix match outranks a mere substring match',
    pre.body.results.length > 0 && /^One/i.test(pre.body.results[0].full_name),
    pre.body.results.map((r) => r.full_name));

  console.log('\n== It is desk-only, like everything else on this surface ==');
  const refused = await call('GET', '/api/desk/search?q=Payment', null, reviewer);
  check('a role without desk.view is refused', refused.status === 403, refused.status);
  const anon = await call('GET', '/api/desk/search?q=Payment');
  check('and an anonymous caller gets nowhere', anon.status === 401, anon.status);

  console.log('\n== Typing is one request per pause, not one per letter ==');
  const h = harness();
  h.setResponder(() => ({ success: true, results: [person(1)] }));
  h.els['desk-search'].value = 'Ash';
  h.sandbox.deskSuggest();
  h.els['desk-search'].value = 'Ashw';
  h.sandbox.deskSuggest();
  h.els['desk-search'].value = 'Ashwi';
  h.sandbox.deskSuggest();
  check('three keystrokes in quick succession fire nothing yet', h.calls.length === 0, h.calls.length);
  await tick(300);
  check('...and one request once typing pauses', h.calls.length === 1, h.calls);
  check('...for the final text, not the first', /q=Ashwi(&|$)/.test(h.calls[0]), h.calls[0]);

  console.log('\n== Under two characters, nothing is asked at all ==');
  const h2 = harness();
  h2.els['desk-search'].value = 'A';
  h2.sandbox.deskSuggest();
  await tick(300);
  check('one character sends no request', h2.calls.length === 0, h2.calls);
  check('...and the list stays shut',
    h2.els['desk-suggestions'].classList.contains('hidden'));

  console.log('\n== A slow answer to an old keystroke cannot overwrite a new one ==');
  // The failure: "As" is slow, "Ashwin" is fast, the stale reply lands second
  // and replaces a correct list with the wrong people -- who the desk then
  // clicks, because they were on screen.
  const h3 = harness();
  let release;
  const held = new Promise((r) => { release = r; });
  h3.setResponder((url) => (/q=As(&|$)/.test(url)
    ? held.then(() => ({ success: true, results: [person(9, { full_name: 'STALE Person' })] }))
    : { success: true, results: [person(1, { full_name: 'FRESH Person' })] }));
  h3.els['desk-search'].value = 'As';
  const stale = h3.sandbox.deskSuggestFetch('As');  // NOT awaited: still in flight
  h3.els['desk-search'].value = 'Ashwin';
  await h3.sandbox.deskSuggestFetch('Ashwin');      // resolves immediately
  check('the newer list is showing', h3.els['desk-suggestions'].innerHTML.includes('FRESH Person'));
  release();
  await stale;
  await tick(20);
  check('and the late stale reply is discarded',
    !h3.els['desk-suggestions'].innerHTML.includes('STALE Person'),
    h3.els['desk-suggestions'].innerHTML.slice(0, 120));
  check('...leaving the newer one in place',
    h3.els['desk-suggestions'].innerHTML.includes('FRESH Person'));

  console.log('\n== The keyboard alone is enough ==');
  const h4 = harness();
  h4.setResponder(() => ({ success: true, results: [person(1), person(2), person(3)] }));
  await h4.sandbox.deskSuggestFetch('Per');
  check('the list opens', !h4.els['desk-suggestions'].classList.contains('hidden'));
  check('with nothing preselected, so Enter still submits a typed number',
    !h4.els['desk-suggestions'].innerHTML.includes('aria-selected="true"'));

  const key = (k) => { let d = false; h4.sandbox.deskSuggestKey({ key: k, preventDefault() { d = true; } }); return d; };
  key('ArrowDown');
  check('down highlights the first', h4.els['desk-suggestions'].innerHTML.includes('id="desk-suggestion-0" aria-selected="true"'),
    h4.els['desk-suggestions'].innerHTML.match(/aria-selected="true"/g));
  key('ArrowDown');
  check('again highlights the second', h4.els['desk-suggestions'].innerHTML.includes('id="desk-suggestion-1" aria-selected="true"'));
  key('ArrowUp');
  check('up goes back', h4.els['desk-suggestions'].innerHTML.includes('id="desk-suggestion-0" aria-selected="true"'));
  key('ArrowUp');
  check('and up from the top wraps to the bottom rather than sticking',
    h4.els['desk-suggestions'].innerHTML.includes('id="desk-suggestion-2" aria-selected="true"'));
  check('arrow keys stop the caret moving in the box', key('ArrowDown') === true);

  key('Escape');
  check('Escape shuts the list', h4.els['desk-suggestions'].classList.contains('hidden'));
  check('...and marks it closed for a screen reader',
    h4.els['desk-search'].getAttribute('aria-expanded') === 'false');

  console.log('\n== Enter only steals the form when something is highlighted ==');
  const h5 = harness();
  h5.setResponder(() => ({ success: true, results: [person(1), person(2)] }));
  await h5.sandbox.deskSuggestFetch('Per');
  let prevented = false;
  h5.sandbox.deskSuggestKey({ key: 'Enter', preventDefault() { prevented = true; } });
  check('with no selection, Enter falls through to the form',
    prevented === false);
  h5.sandbox.deskSuggestKey({ key: 'ArrowDown', preventDefault() {} });
  h5.sandbox.deskSuggestKey({ key: 'Enter', preventDefault() { prevented = true; } });
  check('with a selection, Enter takes it instead', prevented === true);
  check('...and puts the account key in the box, not the typed name',
    h5.els['desk-search'].value === person(1).phone_number, h5.els['desk-search'].value);

  console.log('\n== Nobody matching is said out loud ==');
  // Silence would look like the search had not run. The desk needs to know
  // this person is genuinely not on file, which is the cue to register them.
  const h6 = harness();
  h6.setResponder(() => ({ success: true, results: [] }));
  await h6.sandbox.deskSuggestFetch('Nobody');
  check('an empty result still opens the list',
    !h6.els['desk-suggestions'].classList.contains('hidden'));
  check('...saying so, and what to do about it',
    /Nobody matching/.test(h6.els['desk-suggestions'].innerHTML)
    && /walk-in/.test(h6.els['desk-suggestions'].innerHTML),
    h6.els['desk-suggestions'].innerHTML);

  console.log('\n== A name from the list cannot inject markup ==');
  const h7 = harness();
  h7.setResponder(() => ({ success: true, results: [person(1, { full_name: '<img src=x onerror=alert(1)>' })] }));
  await h7.sandbox.deskSuggestFetch('img');
  check('the tag is escaped, not rendered',
    !h7.els['desk-suggestions'].innerHTML.includes('<img src=x')
    && h7.els['desk-suggestions'].innerHTML.includes('&lt;img'),
    h7.els['desk-suggestions'].innerHTML.slice(0, 160));

  report();
})();
