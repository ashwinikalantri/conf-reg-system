// The approval row carried a Status column and up to seven stacked pills
// separated by <br>. Three things were wrong with it:
//
//   * Status restated the table you were already reading -- this screen has
//     four tables that already separate pending, balance-due, rejected and
//     verified.
//   * The bank and ID indicators were bare coloured text, not the pill shape
//     every other status in the panel uses.
//   * Both only ever showed a NEGATIVE. "Awaiting bank match" vanished once
//     matched, so a matched payment was indistinguishable from one nobody
//     had looked at; and the ID indicator rendered only for student
//     categories, so "no ID required" and "ID not checked" were both a blank
//     cell.
//
// Status is replaced by Registered -- when the delegate submitted their
// registration, which is NOT when they signed up -- and the two checks are
// chips with three honest states each: done, outstanding, not applicable.
const { check, report, appFile } = require('./harness');
const fs = require('fs');
const vm = require('vm');

const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
const view = fs.readFileSync(appFile('views', 'admin', 'sections', 'payments.ejs'), 'utf8');

function load() {
  const els = {};
  const mk = (id) => (els[id] = els[id] || {
    id, value: '', innerHTML: '', textContent: '',
    classList: { c: new Set(), add(k) { this.c.add(k); }, remove(k) { this.c.delete(k); },
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
    fetch: () => Promise.reject(new Error('no network')),
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, URL, Intl, Date, Math, JSON, Promise,
    requestAnimationFrame: (f) => setTimeout(f, 0),
  };
  sandbox.window.document = doc; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // reviewCategoryList is what isStudentCategory() reads, and it is a
  // top-level `let` -- so it has to be set inside the same script.
  vm.runInContext(`${js}\nmyPermissions = new Set(['payments.view', 'payments.decide']);\n`
    + "reviewCategoryList = [{ key: 'med_student', requiresStudentId: true }, "
    + "{ key: 'faculty_mo', requiresStudentId: false }];\n", sandbox, { filename: 'app.js+driver' });
  return sandbox;
}

const sandbox = load();
const AT = new Date(2026, 8, 4, 14, 20).getTime();          // 4 Sep 2026, 2:20 pm
const base = { id: 1, delegate_name: 'Asha Patil', category_label: 'Doctor', category_key: 'faculty_mo',
  expected_amount: 3000, paid_amount: 3000, verified_total: 0, submitted_at: AT, transactions: [] };
const strip = (h) => h.replace(/<!--[\s\S]*?-->/g, '');
const row = (over) => strip(sandbox.paymentRowHtml({ ...base, ...over }));
const desktopOf = (h) => h.slice(h.indexOf('hidden sm:table-cell'));
const mobileOf = (h) => h.slice(h.indexOf('block sm:hidden'), h.indexOf('hidden sm:table-cell'));

console.log('\n== Status is gone from every table on the screen ==');
check('no Status header remains', !/>Status</.test(view));
check('Registered took its place', (view.match(/>Registered</g) || []).length === 4,
  (view.match(/>Registered</g) || []).length);
check('Checks is a column too', (view.match(/>Checks</g) || []).length === 4);
check('no status pill is rendered any more', !/statusPill/.test(js));
check('the empty-state colspan matches the new column count',
  /colspan="5"[^>]*>\s*Nothing awaiting a decision/.test(js));

console.log('\n== Registered shows the registration time, not the signup time ==');
check('it reads from submitted_at, the registration timestamp', /fmtRegisteredAt\(p\.submitted_at\)/.test(js));
check('formatted as "4 Sep 2026, 2:20 pm"',
  sandbox.fmtRegisteredAt(AT) === '4 Sep 2026, 2:20 pm', sandbox.fmtRegisteredAt(AT));
check('midnight is 12:xx am, not 0:xx',
  sandbox.fmtRegisteredAt(new Date(2026, 8, 4, 0, 5).getTime()) === '4 Sep 2026, 12:05 am');
check('noon is 12:00 pm, not 0:00 pm',
  sandbox.fmtRegisteredAt(new Date(2026, 8, 4, 12, 0).getTime()) === '4 Sep 2026, 12:00 pm');
check('a missing timestamp is blank, not "Invalid Date"', sandbox.fmtRegisteredAt(null) === ''
  && sandbox.fmtRegisteredAt(undefined) === '');
// Built by hand rather than toLocaleString: this file runs in a browser with
// full ICU and its tests run in Node without it, so a locale call returns a
// different string in each and the test would not be testing what ships.
check('it does not depend on the runtime locale', !/toLocaleString/.test(
  js.slice(js.indexOf('function fmtRegisteredAt'), js.indexOf('function fmtAuditTime'))));
check('the row prints it', row({}).includes('4 Sep 2026, 2:20 pm'));
check('a row without one shows a dash rather than an empty column',
  desktopOf(row({ submitted_at: null })).includes('—'));

console.log('\n== The bank check finally has a positive state ==');
const unmatched = row({ bank_status: 'PENDING', transactions: [{ txn_status: 'PENDING', bank_txn_id: null }] });
check('an unmatched payment says so', unmatched.includes('Bank pending'));
const matched = row({ bank_status: 'BANK_VERIFIED', verified_total: 3000,
  transactions: [{ txn_status: 'VERIFIED', bank_txn_id: 9 }] });
check('a matched one says THAT, which it never could before', matched.includes('Bank matched'));
check('a rejected one claims neither', row({ bank_status: 'REJECTED', rejection_reason: 'WRONG_DETAILS' })
  .includes('Bank n/a'));
// The whole point of the positive state is that it is TRUE. "Matched" is
// asserted from a VERIFIED transaction, never inferred from "nothing is
// pending" -- a Rs0 registration covered entirely by a group or promo
// discount is confirmed outright and never gets a payment_transactions row
// (server.js, the isFree path), so it has an empty pending set having
// matched nothing at all.
check('a fully-discounted registration with no payment does not claim a match',
  !row({ expected_amount: 0, paid_amount: 0, bank_status: 'BANK_VERIFIED', transactions: [] })
    .includes('Bank matched'));
check('...it says n/a, the same as any other nothing-to-match row',
  row({ expected_amount: 0, paid_amount: 0, bank_status: 'BANK_VERIFIED', transactions: [] })
    .includes('Bank n/a'));
check('a row whose only transaction was rejected claims no match either',
  !row({ transactions: [{ txn_status: 'REJECTED' }] }).includes('Bank matched'));

// The ID chip first shipped with three states, the third being a grey "ID
// n/a" on every non-student row. That was wrong, and deliberately changed: a
// check that does not apply is not a state of that check. Carrying it on the
// majority of rows spends a column's worth of attention saying nothing, and
// makes the rows that DO need looking at harder to pick out. The chip now
// appears exactly when there is something outstanding or something done.
console.log('\n== The ID chip appears only where a card is actually required ==');
check('a student category with no card checked is pending',
  row({ category_key: 'med_student', id_verified: 0 }).includes('ID pending'));
check('a student category with a checked card is verified',
  row({ category_key: 'med_student', id_verified: 1 }).includes('ID verified'));
check('a category that needs no card gets no ID chip at all',
  !/ID (pending|verified|n\/a)/.test(row({ category_key: 'faculty_mo' })),
  (row({ category_key: 'faculty_mo' }).match(/ID [a-z/]+/gi) || []));
check('...and specifically not a grey "n/a" one',
  !row({ category_key: 'faculty_mo' }).includes('ID n/a'));
check('the phrase is gone from the source, not merely unreachable',
  !js.includes('ID n/a'));
// The bank chip is a different case and KEEPS its n/a: every registration has
// a payment question, so a blank there would read as "not looked at" rather
// than "does not apply".
check('the bank chip still says n/a, because every row has a money question',
  row({ bank_status: 'REJECTED' }).includes('Bank n/a'));

console.log('\n== Both checks wear the pill shape everything else uses ==');
const chips = row({ category_key: 'med_student', id_verified: 1 });
check('the chips are bordered, rounded pills',
  (chips.match(/text-\[10px\] font-bold px-2 py-0\.5 rounded-full border/g) || []).length >= 2);
check('...and none of the old bare coloured text survives',
  !/text-\[10px\] text-amber-600 font-semibold/.test(js) && !/text-\[10px\] text-emerald-600/.test(js));

console.log('\n== Exceptions read as notes about the person ==');
const flagged = row({ is_flagged: 1 });
check('Flagged is a chip', flagged.includes('Flagged'));
const rejected = row({ bank_status: 'REJECTED', rejection_reason: 'WRONG_DETAILS',
  rejection_note: 'UTR does not match any credit.' });
check('a rejection reason is a chip', /rounded-full[^"]*"[^>]*>[^<]*<svg[\s\S]*?<\/svg>Wrong/.test(rejected)
  || rejected.includes('Wrong payment details'));
check('...and the free-text note gets its own line, not a stretched pill',
  rejected.includes('UTR does not match any credit.')
  && /<p class="text-\[11px\] text-rose-700/.test(rejected));
const partial = row({ bank_status: 'PARTIAL_PAYMENT', verified_total: 750, expected_amount: 2000 });
check('a balance due is a chip with the arithmetic', partial.includes('₹1,250 due'));

console.log('\n== Both layouts carry the same facts ==');
const both = row({ category_key: 'med_student', id_verified: 0, is_flagged: 1,
  transactions: [{ txn_status: 'PENDING' }] });
const [m, d] = [mobileOf(both), desktopOf(both)];
check('the phone card exists', m.length > 100);
check('the desktop columns exist', d.length > 100);
for (const fact of ['Asha Patil', 'Bank pending', 'ID pending', 'Flagged', '4 Sep 2026, 2:20 pm']) {
  check(`both show "${fact}"`, m.includes(fact) && d.includes(fact));
}
check('the phone labels the date, since it has no column header to do it',
  /Registered \$\{esc\(registered\)\}|Registered /.test(m));
check('amounts line up as figures in both', (both.match(/tabular-nums/g) || []).length >= 2);

report();
