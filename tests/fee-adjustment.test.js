// Two ways what a delegate owes stops matching the price list.
//
// The first is a timing accident. Early-bird pricing closed on a date; a
// delegate paid before it and filled the form after. The money left their
// account at the cheaper price and only the paperwork is late -- but the fee
// is resolved at submission time, so they were charged the later phase, look
// short by the difference, and get chased for it. This happened on the live
// database the day the feature was asked for.
//
// The second is discretion: a discrepancy somebody decides to settle in the
// delegate's favour. It has no evidence behind it by definition, so it takes
// a reason in writing.
//
// The distinction the design turns on: in EARLY_PHASE mode the caller sends
// no amount at all. The server re-derives it from the bank credit's date, so
// a favourable number cannot be posted in and what the screen showed cannot
// drift from what gets written. DISCRETIONARY is the opposite -- an amount
// and a sentence, both from a person, both recorded.
const { call, check, report, ADMIN_PW, adminLogin, loginPassword, openDb } = require('./harness');

const DESK = '9000000006';       // FRONT_DESK -- holds payments.revise, NOT this
const FINANCE = '9000000002';    // FINANCE_ADMIN -- holds payments.revise, NOT this
const REVIEWER = '9000000003';

(async () => {
  const admin = await adminLogin();
  const desk = await loginPassword(DESK, ADMIN_PW);
  const finance = await loginPassword(FINANCE, ADMIN_PW);
  const reviewer = await loginPassword(REVIEWER, ADMIN_PW);
  const db = openDb();

  const cfg = await db.get('SELECT * FROM fee_config WHERE id = 1');
  check('fixture: pricing phases are configured', !!(cfg && cfg.early_until), cfg);

  // A delegate charged the REGULAR price whose money arrived while EARLY was
  // still in force -- the live scenario, reproduced from the fixture's own
  // phase dates rather than hardcoded ones.
  const cat = await db.get("SELECT * FROM fee_categories WHERE category_key = 'faculty_mo'");
  check('fixture: early is cheaper than regular', cat.early_fee < cat.regular_fee,
    [cat.early_fee, cat.regular_fee]);
  // Built here rather than borrowed. The first version of this file reshaped
  // an existing faculty registration -- its fee, its submission date, its
  // status and its payment rows -- and broke two other files that read the
  // same fixture: the front desk could no longer print its receipt, and the
  // receipt test lost the sentence it checks. The suite shares one database,
  // so a test that mutates a shared row is a test that breaks its neighbours.
  const stamp = Date.now();
  const phone = `95${String(stamp % 100000000).padStart(8, '0')}`;
  const dayAfter = new Date(new Date(cfg.early_until).getTime() + 86400000).toISOString().slice(0, 10);
  await db.run(
    `INSERT INTO users (phone_number, full_name, email, role, created_at, phone_verified)
     VALUES (?, 'Early Bird Payer', ?, 'DELEGATE', ?, 1)`,
    [phone, `eb-${stamp}@example.test`, stamp]);
  const inserted = await db.run(
    `INSERT INTO registrations
       (phone_number, delegate_name, category_key, category_label, expected_amount, paid_amount,
        utr_number, bank_status, submitted_at, fee_adjustment, registration_number)
     VALUES (?, 'Early Bird Payer', 'faculty_mo', ?, ?, ?, ?, 'PENDING', ?, 0, ?)`,
    [phone, cat.label, cat.regular_fee, cat.early_fee, `EBUTR${stamp}`,
      new Date(`${dayAfter}T06:00:00Z`).getTime(), `EBTEST${stamp % 100000}`]);
  const reg = await db.get('SELECT * FROM registrations WHERE id = ?', [inserted.lastID]);
  check('fixture: a registration charged at the regular price', reg.expected_amount === cat.regular_fee,
    reg && reg.expected_amount);

  // dedupe_hash is UNIQUE NOT NULL -- the import path derives it from the row
  // so the same statement line cannot be imported twice. A test row needs one
  // too, and a unique one, since this file may run against a database another
  // file has already touched.
  const credit = await db.run(
    `INSERT INTO bank_statement_transactions
       (post_date, credit, description, extracted_ref, dedupe_hash, imported_at, imported_by)
     VALUES (?, ?, 'EARLY BIRD PAYMENT', ?, ?, ?, 'fee-adjustment test')`,
    [cfg.early_until, cat.early_fee, `EARLY${stamp}`, `fee-adj-${stamp}`, stamp]);
  await db.run(
    `INSERT INTO payment_transactions
       (registration_id, phone_number, amount, verified_amount, utr_number, payment_mode,
        txn_status, bank_txn_id, submitted_at)
     VALUES (?, ?, ?, ?, ?, 'UPI', 'VERIFIED', ?, ?)`,
    [reg.id, phone, cat.early_fee, cat.early_fee, `EBUTR${stamp}`, credit.lastID, stamp]);

  console.log('\n== The discrepancy is detected, and offered rather than applied ==');
  const list = await call('GET', '/api/registrations', null, admin);
  const row = (list.body.registrations || list.body).find((r) => r.id === reg.id);
  check('the registration carries a proposal', !!row.early_phase_benefit, row.early_phase_benefit);
  const b = row.early_phase_benefit;
  check('...naming the date the money actually arrived', b.paidOn === cfg.early_until, b.paidOn);
  check('...the phase it was paid in', b.toPhase === 'early', b.toPhase);
  check('...and what they were charged instead', b.fromPhase !== 'early', b.fromPhase);
  check('...with the saving being the difference between the two prices',
    b.saving === cat.regular_fee - cat.early_fee, b.saving);
  // Detection must not move money on its own.
  const untouched = await db.get('SELECT expected_amount, fee_adjustment FROM registrations WHERE id = ?', [reg.id]);
  check('nothing has been changed by merely looking', untouched.expected_amount === cat.regular_fee
    && !untouched.fee_adjustment, untouched);

  console.log('\n== Only a role granted the key may act on it ==');
  for (const [who, cookie] of [['the front desk', desk], ['Finance Admin', finance], ['a reviewer', reviewer]]) {
    const r = await call('POST', `/api/registrations/${reg.id}/fee-adjustment`, { mode: 'EARLY_PHASE' }, cookie);
    check(`${who} is refused`, r.status === 403, r.status);
  }
  // The desk and Finance both hold payments.revise, which re-prices a
  // registration when the CATEGORY changes. Writing off a fee is a different
  // act and deliberately a different key.
  const stillRevise = await call('PUT', `/api/registrations/${reg.id}/lock-category`,
    { categoryKey: 'faculty_mo' }, finance);
  check('...though Finance can still re-price by category, as before',
    stillRevise.status === 200, stillRevise.status);
  // That call re-set the fee to today's phase; put the scenario back.
  await db.run('UPDATE registrations SET expected_amount = ? WHERE id = ?', [cat.regular_fee, reg.id]);

  console.log('\n== Honouring it re-derives the figure from the evidence ==');
  const honoured = await call('POST', `/api/registrations/${reg.id}/fee-adjustment`,
    { mode: 'EARLY_PHASE', newAmount: 1 }, admin);   // newAmount is ignored on purpose
  check('it succeeds', honoured.status === 200 && honoured.body.success, honoured.body.error);
  check('...and the fee is the early price, NOT the amount the caller sent',
    honoured.body.expectedAmount === cat.early_fee, honoured.body.expectedAmount);
  check('...the adjustment is the difference',
    honoured.body.adjustment === cat.regular_fee - cat.early_fee, honoured.body.adjustment);
  check('...recorded as evidenced rather than discretionary',
    honoured.body.basis === 'EARLY_PHASE', honoured.body.basis);
  check('...with a reason that carries the evidence, not a summary of it',
    honoured.body.reason.includes(cfg.early_until) && /early/.test(honoured.body.reason),
    honoured.body.reason);

  const after = await db.get(
    'SELECT expected_amount, fee_adjustment, fee_adjustment_reason, fee_adjustment_basis, fee_adjustment_by, fee_adjustment_at FROM registrations WHERE id = ?',
    [reg.id]);
  check('the row explains itself afterwards', after.fee_adjustment > 0 && !!after.fee_adjustment_reason,
    after);
  check('...naming who did it and when', !!after.fee_adjustment_by && after.fee_adjustment_at > 0, after);
  check('...and expected_amount is the figure everything downstream reads',
    after.expected_amount === cat.early_fee, after.expected_amount);

  console.log('\n== It is audited ==');
  const entry = await db.get(
    "SELECT action, old_value, new_value FROM audit_log WHERE entity_type = 'registration' AND entity_id = ? AND action = 'FEE_ADJUSTED_EARLY_PHASE' ORDER BY id DESC LIMIT 1",
    [reg.id]);
  check('the adjustment is in the log', !!entry, entry);
  check('...with what it was before and after', !!entry && /\d/.test(entry.old_value || '')
    && /\d/.test(entry.new_value || ''), entry);

  console.log('\n== Offered once, not repeatedly ==');
  const again = await call('GET', '/api/registrations', null, admin);
  const row2 = (again.body.registrations || again.body).find((r) => r.id === reg.id);
  check('the proposal is withdrawn once settled', !row2.early_phase_benefit, row2.early_phase_benefit);
  const twice = await call('POST', `/api/registrations/${reg.id}/fee-adjustment`, { mode: 'EARLY_PHASE' }, admin);
  check('...and applying it a second time is refused', twice.status === 409, [twice.status, twice.body.error]);

  console.log('\n== A registration with no bank credit is offered nothing ==');
  // The bank statement is what this app treats as proof everywhere else. A
  // delegate's own claim about when they paid is not evidence.
  // Read-only: this one is only looked at, never written to, so borrowing a
  // shared row is safe here in a way it was not above.
  const unlinked = await db.get(
    "SELECT r.id FROM registrations r JOIN payment_transactions pt ON pt.registration_id = r.id WHERE pt.bank_txn_id IS NULL AND r.id != ? LIMIT 1",
    [reg.id]);
  if (unlinked) {
    const r3 = (again.body.registrations || again.body).find((r) => r.id === unlinked.id);
    check('no proposal without a linked credit', !r3 || !r3.early_phase_benefit,
      r3 && r3.early_phase_benefit);
    const refused = await call('POST', `/api/registrations/${unlinked.id}/fee-adjustment`, { mode: 'EARLY_PHASE' }, admin);
    check('...and the route refuses to invent one', refused.status === 409, refused.status);
  }

  console.log('\n== A discretionary discount needs a reason and cannot go up ==');
  const phone2 = `94${String((stamp + 1) % 100000000).padStart(8, '0')}`;
  await db.run(
    `INSERT INTO users (phone_number, full_name, email, role, created_at, phone_verified)
     VALUES (?, 'Discretion Target', ?, 'DELEGATE', ?, 1)`,
    [phone2, `dt-${stamp}@example.test`, stamp]);
  const ins2 = await db.run(
    `INSERT INTO registrations
       (phone_number, delegate_name, category_key, category_label, expected_amount, paid_amount,
        utr_number, bank_status, submitted_at, fee_adjustment, registration_number)
     VALUES (?, 'Discretion Target', 'faculty_mo', ?, ?, ?, ?, 'PENDING', ?, 0, ?)`,
    [phone2, cat.label, cat.regular_fee, cat.regular_fee, `DTUTR${stamp}`, stamp,
      `DTTEST${stamp % 100000}`]);
  const target = await db.get('SELECT * FROM registrations WHERE id = ?', [ins2.lastID]);
  check('fixture: an unadjusted registration exists', !!target && !target.fee_adjustment,
    target && target.id);
  const noReason = await call('POST', `/api/registrations/${target.id}/fee-adjustment`,
    { mode: 'DISCRETIONARY', newAmount: Math.max(0, target.expected_amount - 500) }, admin);
  check('no reason is refused', noReason.status === 400, [noReason.status, noReason.body.error]);
  const thinReason = await call('POST', `/api/registrations/${target.id}/fee-adjustment`,
    { mode: 'DISCRETIONARY', newAmount: Math.max(0, target.expected_amount - 500), reason: 'ok' }, admin);
  check('...and so is a keystroke pretending to be one', thinReason.status === 400, thinReason.body.error);
  const upward = await call('POST', `/api/registrations/${target.id}/fee-adjustment`,
    { mode: 'DISCRETIONARY', newAmount: target.expected_amount + 500, reason: 'Trying to charge them more' }, admin);
  check('this cannot be used to charge somebody MORE', upward.status === 400, [upward.status, upward.body.error]);
  const noop = await call('POST', `/api/registrations/${target.id}/fee-adjustment`,
    { mode: 'DISCRETIONARY', newAmount: target.expected_amount, reason: 'No change at all here' }, admin);
  check('...nor to record an adjustment that changes nothing', noop.status === 409, noop.status);

  const given = await call('POST', `/api/registrations/${target.id}/fee-adjustment`, {
    mode: 'DISCRETIONARY', newAmount: Math.max(0, target.expected_amount - 500),
    reason: 'Paid the workshop fee twice at the desk; settling the difference here.',
  }, admin);
  check('a proper one goes through', given.status === 200 && given.body.success, given.body.error);
  check('...recorded as discretionary', given.body.basis === 'DISCRETIONARY', given.body.basis);
  const gRow = await db.get('SELECT fee_adjustment_reason, fee_adjustment_basis FROM registrations WHERE id = ?', [target.id]);
  check('...with the reason stored on the registration itself, not only the log',
    /workshop fee twice/.test(gRow.fee_adjustment_reason || ''), gRow.fee_adjustment_reason);
  const gEntry = await db.get(
    "SELECT new_value FROM audit_log WHERE entity_type = 'registration' AND entity_id = ? AND action = 'FEE_ADJUSTED_DISCRETIONARY' ORDER BY id DESC LIMIT 1",
    [target.id]);
  check('...and in the log with the reason attached', !!gEntry && /workshop fee twice/.test(gEntry.new_value || ''),
    gEntry && gEntry.new_value);

  console.log('\n== An unknown mode does nothing ==');
  const bogus = await call('POST', `/api/registrations/${reg.id}/fee-adjustment`,
    { mode: 'FREE_FOR_ALL', newAmount: 0 }, admin);
  check('refused', bogus.status === 400, bogus.status);

  db.close();
  report();
})();
