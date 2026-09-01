// The statement page only ever walked CREDITS. Debits were imported and then
// shown nowhere -- they surfaced only inside one registration's refund
// picker, so a bank charge or an unrecorded transfer out was money gone with
// no view that admitted it. The reconcile payload now carries them, split by
// whether the app can explain them.
const { call, check, report, adminLogin, appFile } = require('./harness');
const fs = require('fs');

(async () => {
  const cookie = await adminLogin();
  const rec = await call('GET', '/api/admin/bank-statement/reconcile', null, cookie);
  const debits = rec.body.debits || [];
  const s = rec.body.summary || {};

  console.log('\n== Debits are in the payload ==');
  debits.forEach((d) => console.log(`   #${d.id} ${d.post_date} ₹${d.debit} ${d.description} -> ${d.refund ? `refund to ${d.refund.registrationNumber}` : 'unexplained'}`));
  check('the reconcile payload carries debits', Array.isArray(rec.body.debits), typeof rec.body.debits);
  check('both fixture debits are there', debits.length === 2, debits.length);
  check('every row is really a debit', debits.every((d) => Number(d.debit) > 0), debits.map((d) => d.debit));
  check('no credit leaked into the debit list', debits.every((d) => !d.credit), debits.map((d) => d.credit));

  console.log('\n== A refund names its delegate ==');
  const refunded = debits.filter((d) => d.refund);
  const plain = debits.filter((d) => !d.refund);
  check('exactly one debit is a recorded refund', refunded.length === 1, refunded.length);
  check('exactly one debit is unexplained', plain.length === 1, plain.length);
  const r = refunded[0];
  check('the refund carries its registration number', !!(r && r.refund.registrationNumber), r && r.refund);
  check('the refund carries the delegate name', r && r.refund.delegateName === 'Over Paid', r && r.refund.delegateName);
  check('the refund carries its amount', r && Number(r.refund.amount) === 1000, r && r.refund.amount);
  check('the refund carries its note', r && r.refund.note === 'Excess fee returned', r && r.refund.note);
  check('the unexplained debit has no refund block', plain[0] && plain[0].refund === null, plain[0] && plain[0].refund);

  console.log('\n== The summary agrees with the rows ==');
  const total = debits.reduce((sum, d) => sum + Number(d.debit), 0);
  const refundTotal = refunded.reduce((sum, d) => sum + Number(d.debit), 0);
  check('summary.debits counts the rows', s.debits === debits.length, [s.debits, debits.length]);
  check('summary.debitTotal sums them', Math.abs(s.debitTotal - total) < 0.01, [s.debitTotal, total]);
  check('summary.refundedDebits counts the refunds', s.refundedDebits === refunded.length, [s.refundedDebits, refunded.length]);
  check('summary.refundedDebitTotal sums the refunds', Math.abs(s.refundedDebitTotal - refundTotal) < 0.01, [s.refundedDebitTotal, refundTotal]);
  check('summary.unexplainedDebits counts the rest', s.unexplainedDebits === plain.length, [s.unexplainedDebits, plain.length]);

  console.log('\n== Debits stay out of the credit-side reconciliation ==');
  const ids = new Set(debits.map((d) => d.id));
  check('no debit appears as an unmatched credit', (rec.body.unmatchedCredits || []).every((c) => !ids.has(c.id)));
  check('no debit appears as a matched credit', (rec.body.matched || []).every((m) => !ids.has(m.transaction.id)));
  check('no debit appears as non-registration', (rec.body.nonRegistrationCredits || []).every((c) => !ids.has(c.id)));

  console.log('\n== The page has somewhere to render them ==');
  const view = fs.readFileSync(appFile('views', 'admin', 'sections', 'statement.ejs'), 'utf8');
  check('the statement page has a debits panel', view.includes('id="debits-panel"'));
  check('and a body for the rows', view.includes('id="rec-debits-body"'));
  const client = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
  check('the client renders them', client.includes('function renderDebits'));
  check('and is called from the reconciliation load', /renderDebits\(data\.debits/.test(client));

  report();
})();
