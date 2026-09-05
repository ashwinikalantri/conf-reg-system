// The payments worklist used to tag a row "Linked" / "Not linked" according
// to whether every PENDING payment_transaction carried a bank_txn_id. Both
// halves of that were wrong:
//
//   * The positive half was unreachable. Every path that sets bank_txn_id
//     either sets txn_status = 'VERIFIED' in the same UPDATE (PUT
//     /api/payment-transactions/:txnId/link, and the reconcile paths) or
//     rejects anything not already VERIFIED (the cash-deposit link). So a
//     PENDING transaction never carries a bank credit, and the emerald
//     "Linked" state could never render. Confirmed against every
//     payment_transactions row on file: PENDING and REJECTED rows had no
//     bank credit, all 202 VERIFIED rows had one, and nothing was both
//     PENDING and linked.
//   * "Linked" named the foreign key rather than the thing the finance desk
//     needs to know, which is that this delegate's money has not yet been
//     found in the bank statement.
//
// It became a one-state flag reading "Awaiting bank match", shown only while
// a claimed payment was still unreconciled.
//
// SUPERSEDED, in part, by the Checks-column overhaul (payment-row-redesign):
// the tag is now one of a matched pair of chips that always show their state,
// so the row can say "Bank matched" as well as "Bank pending". The premise
// above -- that a positive state was unreachable -- was true of the OLD
// condition, which read the bank_txn_id of PENDING transactions and so could
// never be satisfied. The new one reads txn_status = 'VERIFIED', which is
// exactly what linking sets, so the positive is both reachable and true.
//
// What this file still guards, and payment-row-redesign does not: that the
// foreign-key wording never comes back to this row, and that the unrelated
// Google Drive "Not linked" is left alone. This drives the real
// paymentRowHtml() in a vm sandbox, the same way the other client-side
// render tests do.
const { check, report, appFile } = require('./harness');
const fs = require('fs');
const vm = require('vm');

const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');

function loadApp() {
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
    setAttribute() {}, getAttribute() { return null; }, focus() {}, click() {}, appendChild() {}, remove() {},
  });
  const doc = {
    getElementById: (id) => els[id] || (els[id] = el(id)),
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, createElement: () => el('c'),
    body: el('body'), documentElement: el('html'), readyState: 'loading', cookie: '',
  };
  const sandbox = {
    document: doc,
    window: {
      addEventListener() {}, location: { href: '', hash: '', pathname: '/', search: '' },
      matchMedia: () => ({ matches: false, addEventListener() {} }), history: { replaceState() {} },
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node' },
    fetch: () => Promise.reject(new Error('no network in this test')),
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, URL, Intl, Date, Math, JSON,
    requestAnimationFrame: (f) => setTimeout(f, 0), Promise,
  };
  sandbox.window.document = doc; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(js, sandbox, { filename: 'app.js' });
  return sandbox;
}

const sandbox = loadApp();

// A registration with one payment the delegate has claimed but which nobody
// has matched to a bank credit yet -- the state the tag exists to mark.
const rowWithPending = sandbox.paymentRowHtml({
  id: 1, delegate_name: 'Pending Claim', phone_number: '9000000001',
  category_key: 'faculty_mo', category_label: 'Doctor',
  expected_amount: 3000, paid_amount: 3000, bank_status: 'PENDING',
  utr_number: '111111111111', transactions: [{ id: 11, txn_status: 'PENDING', bank_txn_id: null, amount: 3000 }],
});

// The same registration once the payment has been verified against a credit.
const rowVerified = sandbox.paymentRowHtml({
  id: 2, delegate_name: 'All Settled', phone_number: '9000000002',
  category_key: 'faculty_mo', category_label: 'Doctor',
  expected_amount: 3000, paid_amount: 3000, verified_total: 3000, bank_status: 'BANK_VERIFIED',
  utr_number: '222222222222', transactions: [{ id: 22, txn_status: 'VERIFIED', bank_txn_id: 99, amount: 3000, verified_amount: 3000 }],
});

// A rejected payment: also not linked, but it is not awaiting anything --
// the rejection is the outcome, and the row says so with its own chip.
const rowRejected = sandbox.paymentRowHtml({
  id: 3, delegate_name: 'Turned Down', phone_number: '9000000003',
  category_key: 'faculty_mo', category_label: 'Doctor',
  expected_amount: 3000, paid_amount: 3000, bank_status: 'REJECTED', rejection_reason: 'WRONG_DETAILS',
  utr_number: '333333333333', transactions: [{ id: 33, txn_status: 'REJECTED', bank_txn_id: null, amount: 3000 }],
});

console.log('\n== the tag says what it is for, not what the column is called ==');
check('an unreconciled claim is marked outstanding', rowWithPending.includes('Bank pending'));
check('the old foreign-key wording is gone from the row',
  !/>\s*(Not linked|Linked)\s*</.test(rowWithPending) && !rowWithPending.includes('Not linked'),
  rowWithPending.slice(0, 200));

console.log('\n== outstanding means outstanding ==');
check('a verified registration is not marked outstanding', !rowVerified.includes('Bank pending'));
check('a rejected payment is not marked outstanding', !rowRejected.includes('Bank pending'));
check('the outstanding state keeps the amber tone that marks work to do',
  /bg-amber-100 text-amber-800 border-amber-300"><svg[\s\S]*?<\/svg>Bank pending/.test(rowWithPending));

console.log('\n== the positive state is now real, where before it was unreachable ==');
// The old condition asked whether PENDING transactions carried a bank
// credit -- which no code path ever produces. This one asks whether a
// VERIFIED transaction exists, which is precisely what linking creates.
check('a verified registration says so', rowVerified.includes('Bank matched'));
check('...in the emerald tone reserved for settled things',
  /bg-emerald-100 text-emerald-800 border-emerald-300"><svg[\s\S]*?<\/svg>Bank matched/.test(rowVerified));
check('a rejected one still claims no match', rowRejected.includes('Bank n/a')
  && !rowRejected.includes('Bank matched'));

console.log('\n== the Google Drive "Not linked" is a different thing and stays ==');
// renderDriveStatus reports whether a Google account is connected for
// backups. That is genuinely a link, and its wording is correct.
check('drive status still reports "Not linked"', js.includes("ICON('cross')}Not linked"));

report();
