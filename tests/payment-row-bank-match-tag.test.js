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
// It is now a one-state flag reading "Awaiting bank match", shown only while
// a claimed payment is still unreconciled. This drives the real
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
// the rejection is the outcome, and the row's status pill already says so.
const rowRejected = sandbox.paymentRowHtml({
  id: 3, delegate_name: 'Turned Down', phone_number: '9000000003',
  category_key: 'faculty_mo', category_label: 'Doctor',
  expected_amount: 3000, paid_amount: 3000, bank_status: 'REJECTED', rejection_reason: 'WRONG_DETAILS',
  utr_number: '333333333333', transactions: [{ id: 33, txn_status: 'REJECTED', bank_txn_id: null, amount: 3000 }],
});

console.log('\n== the tag says what it is for ==');
check('an unreconciled claim is tagged "Awaiting bank match"',
  rowWithPending.includes('Awaiting bank match'));
check('the old foreign-key wording is gone from the row',
  !/>\s*(Not linked|Linked)\s*</.test(rowWithPending) && !rowWithPending.includes('Not linked'),
  rowWithPending.slice(0, 200));

console.log('\n== it appears only while something is actually outstanding ==');
check('a verified registration carries no bank-match tag',
  !rowVerified.includes('Awaiting bank match'));
check('a rejected payment carries no bank-match tag',
  !rowRejected.includes('Awaiting bank match'));

console.log('\n== one state, not two ==');
// The unreachable positive branch is gone: there is no emerald/"linked"
// counterpart for this tag to render in any state.
check('no emerald "linked" counterpart survives in the row markup',
  !rowWithPending.includes('text-emerald-600') || !rowWithPending.includes('Linked'));
check('the tag keeps the amber tone that marks outstanding work',
  /text-\[10px\] text-amber-600 font-semibold[^>]*>[^<]*Awaiting bank match/.test(rowWithPending)
    || rowWithPending.includes('text-amber-600'));

console.log('\n== the Google Drive "Not linked" is a different thing and stays ==');
// renderDriveStatus reports whether a Google account is connected for
// backups. That is genuinely a link, and its wording is correct.
check('drive status still reports "Not linked"', js.includes("ICON('cross')}Not linked"));

report();
