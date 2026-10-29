const { call, check, report, ADMIN, adminLogin, openDb } = require('./harness');
// A banked cash deposit stops showing as an unmatched credit; an unused one
// still does. The test makes its own walk-ins and deposits (it used to read
// the ones cash-at-desk.test.js leaves behind, so it failed when run alone)
// and removes them at the end.
const N = String(Date.now()).slice(-6);
const P = (i) => `8${N}${String(i).padStart(3, '0')}`;
(async()=>{
let r = { cookie: await adminLogin() };
const ac=r.cookie;
const db = openDb();
const made = { regs: [], phones: [], hashes: [] };
const unmatchedNow = async () => ((await call('GET','/api/admin/bank-statement/reconcile',null,ac)).body.unmatchedCredits || []).map(c=>String(c.description||''));
const addCredit = async (desc, credit, hash) => {
  await db.run(`INSERT INTO bank_statement_transactions (post_date, value_date, branch_code, cheque_number, description, debit, credit, balance, extracted_ref, dedupe_hash, source_file, imported_at, imported_by, is_non_registration)
    VALUES ('2026-09-01','2026-09-01','TEST','',?,NULL,?,100000,NULL,?,'test.xls',?,'Test',0)`, [desc, credit, hash, Date.now()]);
  made.hashes.push(hash);
  return (await db.get('SELECT id FROM bank_statement_transactions WHERE dedupe_hash = ?', [hash])).id;
};
try {
console.log('\n== Its own cash walk-ins and deposits ==');
for (let i=1;i<=2;i++){
  const res=await call('POST','/api/admin/registrations',{phone:P(i),name:`Deposit Walkin ${i}`,email:`deposit${i}-${N}@example.com`,
    categoryKey:'chw',optionIds:[],paymentMode:'CASH',collectedBy:ADMIN,amount:200},ac);
  made.phones.push(P(i));
  if (res.body.registrationId) made.regs.push(res.body.registrationId);
}
check('two cash walk-ins registered', made.regs.length===2, made.regs);
const txnIds=(await db.all(`SELECT id FROM payment_transactions WHERE registration_id IN (${made.regs.map(()=>'?').join(',')})`, made.regs)).map(t=>t.id);
const desk=`CASH DEPOSIT DESK ${N}`;
const small=`SMALL DEPOSIT ${N}`;
const deskId=await addCredit(desk, 400, `cbdesk${N}`);
await addCredit(small, 100, `cbsmall${N}`);
check('before banking, the desk deposit is an unmatched credit', (await unmatchedNow()).includes(desk));

console.log('\n== A banked cash deposit stops showing as an unmatched credit ==');
const dep=await call('POST','/api/admin/cash-deposit',{bankTxnId:deskId,txnIds},ac);
check('the two cash payments are banked against it', dep.body.success===true && dep.body.depositRemaining===0, dep.body);
const unmatched=await unmatchedNow();
check('the fully-consumed CASH DEPOSIT is no longer unmatched', !unmatched.includes(desk), unmatched.filter(d=>d.includes('CASH')));
check('the unused SMALL DEPOSIT still is', unmatched.includes(small));

console.log('\n== Cash reads correctly in the review ledger ==');
const js=(await call('GET','/app.js',null,null)).raw;
const cashRow=js.slice(js.indexOf('function reviewTxnRowHtml('), js.indexOf('\n}', js.indexOf('function reviewTxnRowHtml(')));
check('cash never says "Not acknowledged"', !/Not acknowledged/.test(cashRow) && /in cash\$\{t\.collected_by \?/.test(cashRow));
check('...its bank side says it is not yet banked', /Not yet banked — reconciled from the Bank Statement tab/.test(cashRow));
check('cash shows "not yet banked" instead', /not yet banked/.test(js));
check('cash has no per-delegate Link button', /reviewRegVerified \|\| isCash \? '' :/.test(js));

console.log('\n== Panel markup ships, hidden by default ==');
const admin=await call('GET','/admin',null,ac);
check('cash panel present', /id="cash-in-hand-panel"/.test(admin.raw));
check('hidden by default', /id="cash-in-hand-panel" class="hidden"/.test(admin.raw));
check('deposit picker present', /id="cash-deposit-select"/.test(admin.raw));
check('select-all present', /id="cash-select-all"/.test(admin.raw));

console.log('\n== Role gating ==');
const anon=await call('GET','/api/admin/cash-in-hand',null,null);
check('anonymous refused', anon.status===401||anon.status===403, anon.status);
} finally {
  if (made.regs.length) {
    const q = made.regs.map(() => '?').join(',');
    await db.run(`DELETE FROM payment_transactions WHERE registration_id IN (${q})`, made.regs);
    await db.run(`DELETE FROM registration_options WHERE registration_id IN (${q})`, made.regs);
    await db.run(`DELETE FROM registrations WHERE id IN (${q})`, made.regs);
  }
  for (const ph of made.phones) { await db.run('DELETE FROM user_roles WHERE phone_number = ?', [ph]); await db.run('DELETE FROM users WHERE phone_number = ?', [ph]); }
  for (const h of made.hashes) await db.run('DELETE FROM bank_statement_transactions WHERE dedupe_hash = ?', [h]);
  db.close();
}
report();
})();
