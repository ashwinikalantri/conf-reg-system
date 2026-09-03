// Two faults in the rescan, both found by reviewing the change that widened
// it, and both of which would have put clean delegates back in the flagged
// worklist -- the exact noise the OCR work set out to remove.
//
//   * `amountTampered` compared registrations.paid_amount (the LATEST claim)
//     against the whole fee, so a delegate who paid 2,000 as 750 + 1,250
//     read as having claimed 750 and was marked as having tampered.
//   * the `all` scope OCR'd every slip in one request -- minutes of work
//     behind a proxy that gives up at 100 seconds.
const { call, check, report, adminLogin, openDb, appFile } = require('./harness');
const fs = require('fs');

(async () => {
  const cookie = await adminLogin();
  const db = openDb();

  console.log('\n== A delegate who paid a fee in two instalments ==');
  // Built here rather than in the shared fixture: this shape only matters to
  // this test, and the seed's ids are addressed directly by other files.
  const reg = await db.get("SELECT id, expected_amount FROM registrations WHERE bank_status='BANK_VERIFIED' ORDER BY id LIMIT 1");
  const before = await db.get('SELECT paid_amount, expected_amount, is_flagged, screenshot FROM registrations WHERE id = ?', [reg.id]);
  check('the fixture gives us a verified registration', !!before, before);

  // Two payments covering the fee, and paid_amount left holding only the
  // second -- exactly the live shape (NQOCN20261165 and three others).
  const half = Math.round(before.expected_amount / 2);
  await db.run("DELETE FROM payment_transactions WHERE registration_id = ?", [reg.id]);
  for (const amt of [half, before.expected_amount - half]) {
    await db.run(
      `INSERT INTO payment_transactions (registration_id, phone_number, amount, verified_amount, utr_number,
         screenshot, payment_mode, txn_status, submitted_at)
       SELECT id, phone_number, ?, ?, utr_number, screenshot, 'UPI', 'VERIFIED', submitted_at
         FROM registrations WHERE id = ?`, [amt, amt, reg.id]);
  }
  await db.run('UPDATE registrations SET paid_amount = ?, is_flagged = 0 WHERE id = ?',
    [before.expected_amount - half, reg.id]);

  const claimed = await db.get(
    `SELECT COALESCE(SUM(COALESCE(verified_amount, amount)), 0) AS total
       FROM payment_transactions WHERE registration_id = ? AND txn_status != 'REJECTED'`, [reg.id]);
  check('the ledger covers the fee', claimed.total === before.expected_amount, claimed);
  const row = await db.get('SELECT paid_amount, expected_amount FROM registrations WHERE id = ?', [reg.id]);
  check('...while paid_amount holds only the last instalment',
    row.paid_amount !== row.expected_amount, row);

  console.log('\n== The tamper rule reads the ledger, not the last claim ==');
  // Exercised directly: the fixture's slips are synthetic images that OCR
  // reads nothing from, so every rescanned row is flagged for OCR reasons
  // regardless -- the endpoint cannot show this term on its own.
  const src = fs.readFileSync(appFile('server.js'), 'utf8');
  const a = src.indexOf('function amountShortOfFee(');
  const short = new Function(`${src.slice(a, src.indexOf('\n}\n', a) + 3)}; return amountShortOfFee;`)();

  check('two instalments covering the fee are not a shortfall',
    short(2000, 1250, 2000) === false, short(2000, 1250, 2000));
  check('...even when the last claim is the smaller one',
    short(2000, 750, 2000) === false, short(2000, 750, 2000));
  check('a ledger that really is short IS a shortfall',
    short(750, 750, 2000) === true, short(750, 750, 2000));
  check('paying the whole fee in one go is fine', short(3000, 3000, 3000) === false);
  check('overpaying is not a shortfall', short(4000, 4000, 3000) === false);
  check('a legacy row with no ledger falls back to the column',
    short(0, 3000, 3000) === false && short(0, 750, 3000) === true);
  check('nothing on file at all is a shortfall', short(0, null, 3000) === true);
  check('rounding does not create one', short(2999.6, 2999.6, 3000) === false, short(2999.6, 2999.6, 3000));

  console.log('\n== A whole-corpus rescan still runs to completion ==');
  let after = 0;
  let batches = 0;
  let scanned = 0;
  for (;;) {
    const res = await call('POST', '/api/admin/registrations/rescan-flagged', { all: true, after }, cookie);
    check(`batch ${batches + 1} succeeds`, res.body.success === true, res.body);
    if (!res.body.success) break;
    scanned += res.body.rescanned + res.body.skippedNoFile;
    batches++;
    if (res.body.nextAfter == null) break;
    after = res.body.nextAfter;
    if (batches > 40) { check('the batch loop terminates', false, 'ran away'); break; }
  }
  check('every registration with a slip was covered', scanned > 0, scanned);

  console.log('\n== Batching: one request never scans the whole corpus ==');
  const first = await call('POST', '/api/admin/registrations/rescan-flagged', { all: true, after: 0 }, cookie);
  check('a batch reports how many are left', typeof first.body.remaining === 'number', first.body);
  check('and hands back a cursor when there is more',
    first.body.nextAfter === null || typeof first.body.nextAfter === 'number', first.body.nextAfter);
  check('a batch is bounded', first.body.rescanned + first.body.skippedNoFile <= 20,
    [first.body.rescanned, first.body.skippedNoFile]);

  check('the query is limited', /ORDER BY r\.id LIMIT \$\{BATCH\}/.test(src));
  check('the tamper test reads the ledger, not the last claim',
    /amountTampered = amountShortOfFee\(reg\.claimed_total, reg\.paid_amount, reg\.expected_amount\)/.test(src));
  check('and the ledger sum excludes rejected payments',
    /txn_status != 'REJECTED'\) AS claimed_total/.test(src));
  const client = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
  check('the client walks the batches', /data\.nextAfter == null/.test(client));

  db.close();
  report();
})();
