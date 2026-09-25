#!/usr/bin/env node
// One-off repair: merge bank statement rows that are the same transaction
// stored twice under different wording.
//
// The bank's narration for a transaction varies between exports -- a UPI
// credit can read "UPI/RRN 6123.../..." in one statement and a bare
// "By Transfer" in another -- and the importer used to fingerprint rows
// including that narration, so each rewording became a second row. The
// importer now recognises the transaction instead (findSameStatementTransaction
// in server.js); this clears the pairs it created before that.
//
//   node scripts/merge-statement-duplicates.js            # dry run: report only
//   node scripts/merge-statement-duplicates.js --apply    # make the changes
//
// For each group of rows with the same dates, branch, cheque number, amount
// and running balance:
//   * the row something points at (a payment, registration or refund link,
//     or a "not a registration" mark) is kept; if none does, the one with the
//     fuller narration is, else the oldest;
//   * if the kept row reads "By Transfer" and a copy has the full narration,
//     the narration and its reference are copied onto it;
//   * every other copy -- which nothing points at, by construction -- is
//     deleted, and the merge is written to the activity log.
// A group is left alone, and reported, when it cannot be merged safely: two
// copies both referenced, or copies carrying different references (which
// makes them different transactions after all).
//
// Prints ids, description types and amounts only: narrations carry payers'
// names and UPI IDs.
const path = require('path');
const sqlite3 = require('sqlite3');

const APPLY = process.argv.includes('--apply');
const dbPathArg = process.argv.find((a) => a.startsWith('--db='));
const DB_PATH = dbPathArg ? dbPathArg.slice(5) : path.join(__dirname, '..', 'conference.db');

const PLACEHOLDER = /^(by|to)\s+transfer$/i;
const isPlaceholder = (d) => PLACEHOLDER.test(String(d || '').trim());
const kind = (d) => (isPlaceholder(d) ? String(d).trim() : `${String(d || '').trim().split(/[/\s]/)[0].toUpperCase() || '(blank)'}/…`);

const db = new sqlite3.Database(DB_PATH, APPLY ? sqlite3.OPEN_READWRITE : sqlite3.OPEN_READONLY);
const all = (q, p = []) => new Promise((r, j) => db.all(q, p, (e, x) => (e ? j(e) : r(x))));
const run = (q, p = []) => new Promise((r, j) => db.run(q, p, function (e) { return e ? j(e) : r(this); }));

// actor_phone is NOT NULL; 'system' is the server's own convention for an
// action no admin performed (see writeAuditRow in server.js).
async function audit(entityId, action, oldValue, newValue) {
  await run(`INSERT INTO audit_log (entity_type, entity_id, action, old_value, new_value, actor_phone, actor_name, actor_role, created_at)
             VALUES ('bank_statement_transaction', ?, ?, ?, ?, 'system', 'System (duplicate merge)', 'SYSTEM', ?)`,
  [String(entityId), action, oldValue, newValue, Date.now()]);
}

(async () => {
  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} against ${DB_PATH}\n`);
  const groups = await all(`
    SELECT post_date, value_date, branch_code, cheque_number, debit, credit, balance, GROUP_CONCAT(id) AS ids
      FROM bank_statement_transactions
     WHERE balance IS NOT NULL
     GROUP BY post_date, value_date, branch_code, cheque_number, debit, credit, balance
    HAVING COUNT(*) > 1
     ORDER BY post_date`);

  let merged = 0; let removed = 0; let filled = 0; let removedCredit = 0; const skipped = [];
  if (APPLY) await run('BEGIN');
  try {
    for (const g of groups) {
      const members = await all(`
        SELECT b.id, b.description, b.extracted_ref, b.is_non_registration,
               (SELECT COUNT(*) FROM payment_transactions p WHERE p.bank_txn_id = b.id)
             + (SELECT COUNT(*) FROM registrations r WHERE r.bank_txn_id = b.id)
             + (SELECT COUNT(*) FROM payment_refunds f WHERE f.bank_txn_id = b.id) AS links
          FROM bank_statement_transactions b WHERE b.id IN (${g.ids}) ORDER BY b.id`);
      const amount = g.credit ? `CR ₹${g.credit}` : `DR ₹${g.debit}`;
      const refs = new Set(members.map((m) => m.extracted_ref).filter(Boolean));
      if (refs.size > 1) { skipped.push(`${g.post_date} ${amount}: copies carry different references -- separate transactions`); continue; }
      const referenced = members.filter((m) => m.links > 0 || m.is_non_registration);
      if (referenced.length > 1) { skipped.push(`${g.post_date} ${amount}: more than one copy is linked or marked -- needs a person`); continue; }

      const fullest = members.find((m) => !isPlaceholder(m.description) && m.extracted_ref)
        || members.find((m) => !isPlaceholder(m.description));
      const keeper = referenced[0] || fullest || members[0];
      const spares = members.filter((m) => m.id !== keeper.id);
      const fill = isPlaceholder(keeper.description) && fullest && fullest.id !== keeper.id;

      console.log(`  ${g.post_date}  ${amount}  keep #${keeper.id} (${kind(keeper.description)}${keeper.links ? ', linked' : ''})`
        + `${fill ? ` ← takes the narration of #${fullest.id}` : ''}  remove ${spares.map((m) => `#${m.id} (${kind(m.description)})`).join(', ')}`);

      if (APPLY) {
        if (fill) {
          await run('UPDATE bank_statement_transactions SET description = ?, extracted_ref = ? WHERE id = ?',
            [fullest.description, fullest.extracted_ref, keeper.id]);
          await audit(keeper.id, 'STATEMENT_NARRATION_FILLED', keeper.description, fullest.description);
        }
        for (const m of spares) {
          await run('DELETE FROM bank_statement_transactions WHERE id = ?', [m.id]);
          await audit(keeper.id, 'STATEMENT_DUPLICATE_MERGED', `#${m.id}`, `kept #${keeper.id}`);
        }
      }
      merged++; removed += spares.length; if (fill) filled++;
      removedCredit += spares.length * (g.credit || 0);
    }
    if (APPLY) await run('COMMIT');
  } catch (err) {
    if (APPLY) await run('ROLLBACK').catch(() => {});
    throw err;
  }

  console.log(`\n${merged} group(s) ${APPLY ? 'merged' : 'to merge'}: ${removed} duplicate row(s) ${APPLY ? 'removed' : 'to remove'} (₹${removedCredit} of phantom credit), `
    + `${filled} narration(s) ${APPLY ? 'filled in' : 'to fill in'} on a linked row.`);
  if (skipped.length) { console.log(`\nLeft alone (${skipped.length}):`); skipped.forEach((s) => console.log(`  ${s}`)); }
  db.close();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
