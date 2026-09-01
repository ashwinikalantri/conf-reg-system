const { call, check, report, adminLogin } = require('./harness');
;
const sqlite3=require('sqlite3').verbose();
const N=String(Date.now()).slice(-6);
const P=(i)=>'9'+N+String(i).padStart(3,'0');
const db=new sqlite3.Database(process.argv[2]);
const run=(q,p=[])=>new Promise((r,j)=>db.run(q,p,function(e){e?j(e):r(this);}));
const one=(q,p=[])=>new Promise((r,j)=>db.get(q,p,(e,x)=>e?j(e):r(x)));
(async()=>{
let r = { cookie: await adminLogin() };
const ac=r.cookie;

console.log('\n== Three cash walk-ins at the desk ==');
const ids=[];
for (let i=1;i<=3;i++){
  const res=await call('POST','/api/admin/registrations',{phone:P(i),name:`Cash Walkin ${i}`,email:`cash${i}-${N}@example.com`,
    categoryKey:'chw',optionIds:[],paymentMode:'CASH',amount:200},ac);
  if(!res.body.success){ console.log('   setup failed:',res.body.error); }
  ids.push(res.body.registrationId);
}
check('three cash registrations created', ids.every(Boolean), ids);

let cash=await call('GET','/api/admin/cash-in-hand',null,ac);
check('all three appear as unbanked cash', cash.body.count>=3, cash.body.count);
check('total is the sum', cash.body.total>=600, cash.body.total);
const mine=cash.body.transactions.filter(t=>ids.includes(t.registration_id));
check('rows carry delegate + reg no', mine.every(t=>t.delegate_name && t.registration_number), mine[0]);
const txnIds=mine.map(t=>t.id);

console.log('\n== Cash is VERIFIED but unbanked -- it counts toward the fee already ==');
const reg=await one('SELECT bank_status FROM registrations WHERE id=?',[ids[0]]);
check('registration already BANK_VERIFIED', reg.bank_status==='BANK_VERIFIED', reg.bank_status);
const t0=await one('SELECT txn_status, verified_amount, bank_txn_id FROM payment_transactions WHERE id=?',[txnIds[0]]);
check('txn VERIFIED with no bank link', t0.txn_status==='VERIFIED' && t0.bank_txn_id===null, t0);

console.log('\n== One bulk deposit covering all three ==');
await run(`INSERT INTO bank_statement_transactions (post_date, value_date, branch_code, cheque_number, description, debit, credit, balance, extracted_ref, dedupe_hash, source_file, imported_at, imported_by, is_non_registration)
  VALUES ('2026-09-01','2026-09-01','TEST','','CASH DEPOSIT DESK',NULL,600,100000,NULL,'cashdep${N}','test.xls',?,'Test',0)`,[Date.now()]);
const dep=await one("SELECT id FROM bank_statement_transactions WHERE dedupe_hash='cashdep${N}'".replace('${N}',N));
r=await call('POST','/api/admin/cash-deposit',{bankTxnId:dep.id,txnIds},ac);
check('batch linked', r.body.success===true, r.body.error);
check('all three linked', r.body.linked===3, r.body.linked);
check('total reported', r.body.total===600, r.body.total);
check('deposit fully accounted', r.body.depositRemaining===0, r.body.depositRemaining);

console.log('\n== verified_amount is NOT touched (the delegate still paid in full) ==');
const after=await one('SELECT txn_status, verified_amount, bank_txn_id FROM payment_transactions WHERE id=?',[txnIds[0]]);
check('still VERIFIED', after.txn_status==='VERIFIED', after.txn_status);
check('verified_amount unchanged at 200', after.verified_amount===200, after.verified_amount);
check('now linked to the deposit', after.bank_txn_id===dep.id, after.bank_txn_id);

console.log('\n== They leave the unbanked list ==');
cash=await call('GET','/api/admin/cash-in-hand',null,ac);
check('no longer listed', !cash.body.transactions.some(t=>txnIds.includes(t.id)), cash.body.count);

console.log('\n== A deposit too small is refused ==');
for (let i=4;i<=5;i++){
  await call('POST','/api/admin/registrations',{phone:P(i),name:`Cash Walkin ${i}`,email:`cash${i}-${N}@example.com`,
    categoryKey:'chw',optionIds:[],paymentMode:'CASH',amount:200},ac);
}
cash=await call('GET','/api/admin/cash-in-hand',null,ac);
const two=cash.body.transactions.slice(0,2).map(t=>t.id);
await run(`INSERT INTO bank_statement_transactions (post_date, value_date, branch_code, cheque_number, description, debit, credit, balance, extracted_ref, dedupe_hash, source_file, imported_at, imported_by, is_non_registration)
  VALUES ('2026-09-02','2026-09-02','TEST','','SMALL DEPOSIT',NULL,100,100000,NULL,'small${N}','test.xls',?,'Test',0)`,[Date.now()]);
const small=await one("SELECT id FROM bank_statement_transactions WHERE dedupe_hash='small${N}'".replace('${N}',N));
r=await call('POST','/api/admin/cash-deposit',{bankTxnId:small.id,txnIds:two},ac);
check('over-allocation refused (409)', r.status===409 && /still unallocated/.test(r.body.error||''), [r.status,r.body&&r.body.error]);

console.log('\n== Guards ==');
r=await call('POST','/api/admin/cash-deposit',{bankTxnId:dep.id,txnIds},ac);
check('re-linking already-banked cash refused', r.status===409, [r.status,r.body&&r.body.error]);
r=await call('POST','/api/admin/cash-deposit',{bankTxnId:dep.id,txnIds:[]},ac);
check('empty selection refused', r.status===400, r.status);
r=await call('POST','/api/admin/cash-deposit',{txnIds:two},ac);
check('no deposit chosen refused', r.status===400, r.status);
r=await call('POST','/api/admin/cash-deposit',{bankTxnId:99999999,txnIds:two},ac);
check('unknown deposit -> 404', r.status===404, r.status);

console.log('\n== Unlink returns cash to the drawer, still verified ==');
r=await call('POST','/api/admin/cash-deposit/unlink',{txnIds:[txnIds[0]]},ac);
check('unlinked', r.body.success===true, r.body.error);
const back=await one('SELECT txn_status, verified_amount, bank_txn_id FROM payment_transactions WHERE id=?',[txnIds[0]]);
check('bank link cleared', back.bank_txn_id===null, back.bank_txn_id);
check('still VERIFIED at full amount', back.txn_status==='VERIFIED' && back.verified_amount===200, back);
report();
db.close();
})();
