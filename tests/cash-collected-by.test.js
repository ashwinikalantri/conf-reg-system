// Cash has no bank credit behind it and never will. Before this, the only
// trace of who was answerable for it was payment_transactions.reviewed_by --
// which records whose account was signed in. At a conference desk one laptop
// is worked by several volunteers across a shift, so that column answers
// "which login was open", not "who is holding the money", and those are
// different people often enough to matter when the float is handed over.
//
// collected_by is therefore a SEPARATE column, not a rename, and it is
// enforced by the server rather than merely collected by a form: a dropdown
// nobody validates is decoration, since any client can post any string,
// including the name of somebody who has never worked a desk.
const { call, check, report, ADMIN, ADMIN_PW, adminLogin, loginPassword, openDb } = require('./harness');

const DESK = '9000000006';         // Dez Counter, FRONT_DESK
const REVIEWER = '9000000003';     // Rae Reviewer, ACADEMIC_REVIEWER -- takes no money
// 10 digits exactly: '98' + one index digit + a 7-digit suffix. Padded, so a
// small remainder cannot silently produce a 9-digit number the signup route
// rejects -- which would make every assertion below pass or fail for a reason
// that has nothing to do with cash.
const N = String(Date.now() % 10000000).padStart(7, '0');
const P = (i) => `98${i}${N}`;

(async () => {
  const admin = await adminLogin();
  const desk = await loginPassword(DESK, ADMIN_PW);

  console.log('\n== Cash cannot be taken anonymously ==');
  const anon = await call('POST', '/api/admin/registrations', {
    phone: P(1), name: 'No Collector', email: `nc-${N}@example.test`,
    categoryKey: 'chw', optionIds: [], paymentMode: 'CASH', amount: 200,
  }, admin);
  check('a walk-in with no collector is refused', anon.status === 400, anon.status);
  check('...and says what is missing', /Record who collected the cash/.test(anon.body.error || ''),
    anon.body.error);

  console.log('\n== Nor attributed to somebody who cannot take it ==');
  // The test is "may this person take cash", not "are they staff". An academic
  // reviewer holds neither cash-creating permission.
  const wrong = await call('POST', '/api/admin/registrations', {
    phone: P(2), name: 'Wrong Collector', email: `wc-${N}@example.test`,
    categoryKey: 'chw', optionIds: [], paymentMode: 'CASH', amount: 200, collectedBy: REVIEWER,
  }, admin);
  check('a reviewer cannot be named as the collector', wrong.status === 400, wrong.status);
  check('...for the right reason', /authorised to take it/.test(wrong.body.error || ''), wrong.body.error);
  const invented = await call('POST', '/api/admin/registrations', {
    phone: P(3), name: 'Invented', email: `iv-${N}@example.test`,
    categoryKey: 'chw', optionIds: [], paymentMode: 'CASH', amount: 200, collectedBy: 'Somebody Made Up',
  }, admin);
  check('nor can a name that belongs to nobody', invented.status === 400, invented.status);

  console.log('\n== A real collector is recorded, distinctly from the login ==');
  const ok = await call('POST', '/api/admin/registrations', {
    phone: P(4), name: 'Cash Walkin', email: `cw-${N}@example.test`,
    categoryKey: 'chw', optionIds: [], paymentMode: 'CASH', amount: 200, collectedBy: DESK,
  }, admin);
  check('the walk-in registers', ok.status === 200 && ok.body.success, ok.body.error);

  // openDb returns a promise-based wrapper, not a raw sqlite3 handle.
  const db = openDb({ readOnly: true });
  const get = (q, p = []) => db.get(q, p);
  const txn = await get(
    'SELECT reviewed_by, collected_by, payment_mode FROM payment_transactions WHERE registration_id = ?',
    [ok.body.registrationId]);
  check('the cash row names the collector', txn.collected_by === 'Dez Counter', txn.collected_by);
  // The whole point: the signed-in admin is NOT the person who took the cash,
  // and the row says both things.
  check('...separately from whose login was open', txn.reviewed_by !== txn.collected_by,
    { reviewed_by: txn.reviewed_by, collected_by: txn.collected_by });
  // Not asserted by name: each test file signs in as its own account from the
  // seeded admin pool, so the operator's name varies by run. What must hold is
  // that it records SOMEBODY, and somebody other than the collector.
  check('...and reviewed_by still records the operator',
    typeof txn.reviewed_by === 'string' && txn.reviewed_by.length > 0, txn.reviewed_by);

  console.log('\n== A bank transfer needs no collector, because there is a credit ==');
  // The requirement is scoped to CASH deliberately: a bank payment is already
  // answerable to a statement row.
  const bankish = await call('POST', '/api/admin/registrations', {
    phone: P(5), name: 'Bank Walkin', email: `bw-${N}@example.test`,
    categoryKey: 'chw', optionIds: [], paymentMode: 'BANK_TRANSFER', linkLater: true,
    amount: 200, utrNumber: `9${N}00001`,
  }, admin);
  check('it goes through with no collector named', bankish.status === 200 && bankish.body.success,
    bankish.body.error);
  const bankTxn = await get('SELECT collected_by FROM payment_transactions WHERE registration_id = ?',
    [bankish.body.registrationId]);
  check('...and stores none', !bankTxn.collected_by, bankTxn.collected_by);

  console.log('\n== Collecting a balance in cash, at the counter ==');
  // The existing admin-add-payment route cannot do this: it starts from a
  // bank credit, so it has nothing to offer somebody putting notes down.
  const part = await call('POST', '/api/admin/registrations', {
    phone: P(6), name: 'Part Paid', email: `pp-${N}@example.test`,
    categoryKey: 'nurse_cho', optionIds: [], paymentMode: 'CASH', amount: 500, collectedBy: DESK,
  }, admin);
  check('a part-paid walk-in exists', part.status === 200 && part.body.success, part.body.error);

  const before = await call('GET', `/api/desk/delegate/${P(6)}`, null, desk);
  // getPaymentSummary's outstanding figure is `remaining`; there is no
  // `balance` field on it.
  const owed = before.body.payment.remaining;
  check('they owe a balance', owed > 0, owed);

  const noCollector = await call('POST', '/api/desk/collect-cash',
    { identifier: P(6), amount: 100 }, desk);
  check('collecting it without a collector is refused', noCollector.status === 400, noCollector.status);

  const took = await call('POST', '/api/desk/collect-cash',
    { identifier: P(6), amount: owed, collectedBy: DESK }, desk);
  check('with one, the cash is recorded', took.status === 200 && took.body.success, took.body.error);
  check('...and the balance closes', took.body.payment.remaining <= 0.5, took.body.payment.remaining);

  const settled = await get('SELECT bank_status FROM registrations WHERE phone_number = ?', [P(6)]);
  check('...and a fully-paid registration is settled', settled.bank_status === 'BANK_VERIFIED',
    settled.bank_status);

  console.log('\n== Part of a balance is progress, not a status change ==');
  const part2 = await call('POST', '/api/admin/registrations', {
    phone: P(7), name: 'Still Owing', email: `so-${N}@example.test`,
    categoryKey: 'nurse_cho', optionIds: [], paymentMode: 'CASH', amount: 500, collectedBy: DESK,
  }, admin);
  const partial = await call('POST', '/api/desk/collect-cash',
    { identifier: P(7), amount: 100, collectedBy: DESK }, desk);
  check('a part payment is accepted', partial.status === 200 && partial.body.success, partial.body.error);
  check('...and leaves a balance outstanding', partial.body.payment.remaining > 0, partial.body.payment.remaining);
  const notSettled = await get('SELECT bank_status FROM registrations WHERE id = ?', [part2.body.registrationId]);
  check('...without pretending the registration is settled', notSettled.bank_status !== 'BANK_VERIFIED',
    notSettled.bank_status);

  console.log('\n== The float a collector must hand over is their own ==');
  const mine = await call('GET', '/api/desk/cash-in-hand', null, desk);
  check('the desk sees a float', mine.status === 200 && mine.body.total > 0, mine.body.total);
  check('...credited to them, not to whoever was logged in',
    mine.body.transactions.every((t) => t.collected_by === 'Dez Counter'),
    mine.body.transactions.map((t) => t.collected_by).slice(0, 5));
  const adminFloat = await call('GET', '/api/desk/cash-in-hand', null, admin);
  check('another collector does not see it as theirs',
    !adminFloat.body.transactions.some((t) => t.collected_by === 'Dez Counter'),
    adminFloat.body.count);

  console.log('\n== The conference-wide cash screen shows both names ==');
  const all = await call('GET', '/api/admin/cash-in-hand', null, admin);
  const row = (all.body.transactions || []).find((t) => t.collected_by === 'Dez Counter');
  check('the banking screen carries the collector', !!row, all.body.count);
  check('...alongside the operator, so a hand-over can be traced',
    !!row && !!row.reviewed_by, row && { by: row.collected_by, op: row.reviewed_by });

  db.close();
  report();
})();
