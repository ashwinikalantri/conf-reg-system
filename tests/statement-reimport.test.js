// Re-importing a statement must not store one transaction twice.
//
// The bank's narration for a transaction is not stable between exports: a
// UPI credit can read "UPI/RRN .../payer/..." in one statement and a bare
// "By Transfer" in another, either way round. The importer fingerprinted rows
// including that narration, so each rewording was stored as a second
// transaction -- 14 phantom credits (Rs 29,000) in production, all sitting in
// Unmatched Credits looking exactly like money nobody had claimed, where one
// could be matched to a delegate who never paid.
//
// It now recognises the transaction itself: dates, branch, cheque number,
// amount and the running balance after it. What that must get right:
//   * a rewording is the same transaction, and the fuller narration wins --
//     applied to the stored row IN PLACE, so its links survive and a row that
//     was linked while it read "By Transfer" gains the reference;
//   * a fuller stored narration is never overwritten by "By Transfer";
//   * two copies with DIFFERENT references are two transactions (a credit, an
//     equal debit and an equal credit on the same day leave the balance where
//     it was, so the key alone cannot separate them);
//   * a row with no balance is only matched exactly, as before.
// And the one-off script that clears the pairs already stored.
const { HOST, PORT, call, check, report, ADMIN_PW, adminLogin, loginPassword, openDb, appFile } = require('./harness');
const http = require('http');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { execFileSync } = require('child_process');
const os = require('os');
const sqlite3 = require('sqlite3');

const HEADER = ['Post Date', 'Value Date', 'Branch Code', 'Cheque Number', 'Description', 'Debit', 'Credit', 'Balance'];
// One statement file, laid out as the bank exports it: metadata, the header
// row, the transactions, a trailer.
function statement(rows) {
  const aoa = [['Account Statement'], ['Account No: TEST'], [], HEADER,
    ...rows.map((r) => [r.date, r.date, '1234', '', r.desc, r.debit || '', r.credit || '', r.balance == null ? '' : r.balance]),
    [], ['End of statement']];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Statement');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
// Posted exactly as the admin screen does: a multipart form with one file.
function upload(buf, cookie) {
  return new Promise((resolve, reject) => {
    const boundary = `----t${Date.now()}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="statement.xlsx"\r\n`
        + 'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n'),
      buf, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const r = http.request({ host: HOST, port: PORT, path: '/api/admin/bank-statement/upload', method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length, Cookie: cookie } },
    (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => {
      let b = Buffer.concat(c).toString(); try { b = JSON.parse(b); } catch (e) { /* text */ }
      resolve({ status: res.statusCode, body: b }); }); });
    r.on('error', reject); r.write(body); r.end();
  });
}

const UPI = (rrn) => `UPI/RRN ${rrn}/TEST PAYER/test@upi/Payment`;

(async () => {
  const admin = await adminLogin();
  const db = openDb();
  const onDate = (d) => db.all('SELECT id, description, extracted_ref, is_non_registration FROM bank_statement_transactions WHERE post_date = ? ORDER BY id', [d]);
  const cleanup = async () => {
    const ids = (await db.all("SELECT id FROM bank_statement_transactions WHERE post_date LIKE '2099-%'")).map((r) => r.id);
    if (ids.length) await db.run(`DELETE FROM audit_log WHERE entity_type = 'bank_statement_transaction' AND entity_id IN (${ids.map(() => '?').join(',')})`, ids.map(String));
    await db.run("DELETE FROM bank_statement_transactions WHERE post_date LIKE '2099-%'");
  };
  await cleanup();

  try {
    console.log('\n== Only those who may import statements can ==');
    const desk = await loginPassword('9000000006', ADMIN_PW);
    const refused = await upload(statement([{ date: '01/01/2099', desc: 'By Transfer', credit: 100, balance: 9000100 }]), desk);
    check('the front desk is refused', refused.status === 403, refused.status);

    console.log('\n== "By Transfer" first, the full narration later: one transaction ==');
    const first = await upload(statement([{ date: '02/01/2099', desc: 'By Transfer', credit: 2000, balance: 9002000 }]), admin);
    check('the first upload stores it', first.body.imported === 1, first.body);
    const [before] = await onDate('2099-01-02');
    check('...with no reference yet, since "By Transfer" carries none', before && before.extracted_ref === null, before);
    // Marked, so there is something attached to the row that must survive.
    await call('PUT', `/api/admin/bank-statement/${before.id}/non-registration`, { value: true }, admin);

    const second = await upload(statement([{ date: '02/01/2099', desc: UPI('612345678901'), credit: 2000, balance: 9002000 }]), admin);
    check('the second upload stores nothing new', second.body.imported === 0, second.body);
    check('...says it filled in one description', second.body.narrationsFilled === 1, second.body.narrationsFilled);
    const after = await onDate('2099-01-02');
    check('there is still exactly one row for it', after.length === 1, after.length);
    check('...the same row, not a replacement, so anything linked to it stays linked', after[0].id === before.id);
    check('...now carrying the full narration', after[0].description === UPI('612345678901'), after[0].description);
    check('...and the reference auto-linking matches on', after[0].extracted_ref === '612345678901', after[0].extracted_ref);
    check('...with what was attached to it intact', after[0].is_non_registration === 1);
    const logged = await db.get("SELECT old_value, new_value FROM audit_log WHERE entity_type = 'bank_statement_transaction' AND entity_id = ? AND action = 'STATEMENT_NARRATION_FILLED'", [String(before.id)]);
    check('the change is in the activity log, old wording and new', !!logged && logged.old_value === 'By Transfer', logged);

    console.log('\n== The full narration first, "By Transfer" later: nothing is lost ==');
    await upload(statement([{ date: '03/01/2099', desc: UPI('612345678902'), credit: 750, balance: 9002750 }]), admin);
    const later = await upload(statement([{ date: '03/01/2099', desc: 'By Transfer', credit: 750, balance: 9002750 }]), admin);
    check('nothing new is stored', later.body.imported === 0 && later.body.narrationsFilled === 0, later.body);
    const kept = await onDate('2099-01-03');
    check('one row', kept.length === 1, kept.length);
    check('...still with the full narration and its reference',
      kept[0].description === UPI('612345678902') && kept[0].extracted_ref === '612345678902', kept[0]);

    console.log('\n== Different references are different transactions ==');
    // A credit, an equal debit and an equal credit on one day put the balance
    // back where it was -- only the references tell the two credits apart.
    await upload(statement([{ date: '04/01/2099', desc: UPI('612345678903'), credit: 500, balance: 9003250 }]), admin);
    const other = await upload(statement([{ date: '04/01/2099', desc: UPI('612345678904'), credit: 500, balance: 9003250 }]), admin);
    check('the second is stored as its own transaction', other.body.imported === 1, other.body);
    check('...so both are on file', (await onDate('2099-01-04')).length === 2);

    console.log('\n== An exact re-upload is still skipped ==');
    const again = await upload(statement([{ date: '03/01/2099', desc: UPI('612345678902'), credit: 750, balance: 9002750 }]), admin);
    check('nothing is stored or changed', again.body.imported === 0 && again.body.narrationsFilled === 0, again.body);

    console.log('\n== A row with no running balance is only matched exactly ==');
    // Without the balance two same-day credits of one amount are
    // indistinguishable, so merging them on the key could lose one.
    await upload(statement([{ date: '05/01/2099', desc: 'By Transfer', credit: 300, balance: null }]), admin);
    await upload(statement([{ date: '05/01/2099', desc: UPI('612345678905'), credit: 300, balance: null }]), admin);
    check('two differently-worded rows without a balance are both kept', (await onDate('2099-01-05')).length === 2);

    console.log('\n== The admin screen reports it ==');
    const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
    check('the upload result says how many descriptions were filled in',
      /data\.narrationsFilled \? `, filled in the bank's description for \$\{data\.narrationsFilled\}/.test(js));

    console.log('\n== The one-off repair clears the pairs already stored ==');
    // The state the old importer left: the same transaction twice.
    const ins = (date, desc, credit, balance, nonreg = 0, ref = null) => db.run(
      `INSERT INTO bank_statement_transactions (post_date, value_date, branch_code, cheque_number, description, credit, balance, extracted_ref, is_non_registration, dedupe_hash, source_file, imported_at)
       VALUES (?, ?, '1234', '', ?, ?, ?, ?, ?, ?, 'legacy', ?)`,
      [date, date, desc, credit, balance, ref, nonreg, `legacy-${date}-${desc}-${Math.random()}`, Date.now()]);
    // Linked (marked) copy reads "By Transfer"; the spare has the reference.
    await ins('2099-02-01', 'By Transfer', 1250, 9010000, 1);
    await ins('2099-02-01', UPI('612345678911'), 1250, 9010000, 0, '612345678911');
    // Neither referenced: the fuller one stays.
    await ins('2099-02-02', UPI('612345678912'), 1500, 9011500, 0, '612345678912');
    await ins('2099-02-02', 'By Transfer', 1500, 9011500);
    // Unsafe: both marked -- a person has to look.
    await ins('2099-02-03', 'By Transfer', 3000, 9014500, 1);
    await ins('2099-02-03', UPI('612345678913'), 3000, 9014500, 1, '612345678913');
    // Unsafe: different references, so different transactions.
    await ins('2099-02-04', UPI('612345678914'), 3500, 9018000, 0, '612345678914');
    await ins('2099-02-04', UPI('612345678915'), 3500, 9018000, 0, '612345678915');

    // Run against a snapshot, not the shared fixture: the repair scans the
    // whole database, and merging a fixture row here would change what the
    // files after this one see. VACUUM INTO copies everything committed.
    const copy = path.join(os.tmpdir(), `statement-merge-${process.pid}-${Date.now()}.db`);
    await db.run('VACUUM INTO ?', [copy]);
    const cdb = new sqlite3.Database(copy);
    const onCopy = (d) => new Promise((r, j) => cdb.all(
      'SELECT id, description, extracted_ref, is_non_registration FROM bank_statement_transactions WHERE post_date = ? ORDER BY id',
      [d], (e, x) => (e ? j(e) : r(x))));
    const script = appFile('scripts', 'merge-statement-duplicates.js');
    const dry = execFileSync('node', [script, `--db=${copy}`]).toString();
    check('a dry run changes nothing', (await onCopy('2099-02-01')).length === 2 && (await onCopy('2099-02-02')).length === 2, dry);
    check('...but says what it would do', /DRY RUN/.test(dry) && /to remove/.test(dry));
    check('...naming no payer: it prints types, not narrations', !/TEST PAYER|test@upi/.test(dry));

    const applied = execFileSync('node', [script, `--db=${copy}`, '--apply']).toString();
    const g1 = await onCopy('2099-02-01');
    check('the marked copy is kept, the spare removed', g1.length === 1 && g1[0].is_non_registration === 1, g1);
    check('...and the kept row takes the full narration and reference',
      g1[0].description === UPI('612345678911') && g1[0].extracted_ref === '612345678911', g1[0]);
    const g2 = await onCopy('2099-02-02');
    check('with nothing attached, the fuller copy is the one kept', g2.length === 1 && g2[0].extracted_ref === '612345678912', g2);
    check('two marked copies are left for a person to decide', (await onCopy('2099-02-03')).length === 2);
    check('...and so are two copies with different references', (await onCopy('2099-02-04')).length === 2);
    // Named by date and amount, not counted: the snapshot also holds the
    // fixture's own statement rows, which are not this file's to predict.
    const leftAlone = applied.slice(applied.indexOf('Left alone'));
    check('it reports each group it left alone, and why',
      /2099-02-03 CR ₹3000: more than one copy is linked or marked/.test(leftAlone)
      && /2099-02-04 CR ₹3500: copies carry different references/.test(leftAlone), leftAlone.slice(0, 300));
    const merges = await new Promise((r, j) => cdb.get(
      "SELECT COUNT(*) AS n, MIN(actor_phone) AS phone FROM audit_log WHERE action = 'STATEMENT_DUPLICATE_MERGED' AND actor_name = 'System (duplicate merge)'",
      (e, x) => (e ? j(e) : r(x))));
    check('each removal is in the activity log', merges.n >= 2, merges.n);
    check('...attributed to the system, as the server records its own actions', merges.phone === 'system', merges.phone);

    const rerun = execFileSync('node', [script, `--db=${copy}`, '--apply']).toString();
    check('run again, it finds nothing more to merge', /^0 group\(s\) merged/m.test(rerun), rerun.slice(-200));
    cdb.close();
    fs.unlinkSync(copy);
    check('the shared fixture was never touched by the repair',
      (await onDate('2099-02-01')).length === 2 && (await onDate('2099-02-03')).length === 2);
  } finally {
    await cleanup();
  }
  db.close();
  report();
})();
