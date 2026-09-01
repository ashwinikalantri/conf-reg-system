const { call, check, report } = require('./harness');
;
const sqlite3=require('sqlite3').verbose();
const db=new sqlite3.Database(process.argv[2], sqlite3.OPEN_READONLY);
const all=(q)=>new Promise((r,j)=>db.all(q,(e,x)=>e?j(e):r(x)));
async function receiptFor(phone){
  let r=await call('POST','/api/auth/login-otp',{identifier:phone});
  if(!r.body||!r.body.success) return null;
  r=await call('POST','/api/auth/login',{identifier:phone,otp:r.body.devOtp});
  if(!r.body.success) return null;
  // The receipt is now two standalone documents -- the stub the delegate
  // reads, and the statement at ?print=1 that prints. `raw` is both together,
  // so content checks don't need to care which one carries a given line.
  const screen=await call('GET','/api/registrations/me/receipt',null,r.cookie);
  const print =await call('GET','/api/registrations/me/receipt?print=1',null,r.cookie);
  // .raw is the response text; .body is null for HTML (it only parses JSON).
  return { status:screen.status, screen:screen.raw, print:print.raw,
           raw:screen.raw + print.raw };
}
(async()=>{
console.log('\n== Multi-payment receipt lists EVERY verified payment ==');
const multi=(await all("SELECT r.id, r.phone_number, r.expected_amount FROM registrations r JOIN payment_transactions pt ON pt.registration_id=r.id WHERE r.bank_status='BANK_VERIFIED' GROUP BY r.id HAVING SUM(pt.txn_status='VERIFIED')>1 LIMIT 1"))[0];
const txns=await all(`SELECT * FROM payment_transactions WHERE registration_id=${multi.id} AND txn_status='VERIFIED'`);
const rec=await receiptFor(multi.phone_number);
check('receipt served', rec && rec.status===200, rec&&rec.status);
// The receipt is now two layouts in one document (stub on screen, statement
// on print). The stub counts the instalments; the statement lists them as
// dated ledger lines. Both must account for every verified payment.
check(`stub says "Paid in ${txns.length} instalments"`,
  rec.raw.includes(`Paid in ${txns.length} instalments`), (rec.raw.match(/Paid in \d+ instalments/)||[])[0]);
const stmtBlock=rec.print;
check(`statement lists ${txns.length} ledger lines`,
  (stmtBlock.match(/<div class="ln">/g)||[]).length===txns.length,
  (stmtBlock.match(/<div class="ln">/g)||[]).length);
for(const t of txns){
  check(`lists UTR ${t.utr_number}`, rec.raw.includes(t.utr_number), t.utr_number);
}
const sum=txns.reduce((a,t)=>a+(t.verified_amount!=null?t.verified_amount:t.amount),0);
check(`Total Paid = ₹${sum.toLocaleString('en-IN')}`, rec.raw.includes(sum.toLocaleString('en-IN')), sum);
check('states received against the fee in one sentence',
  /received against a fee of <b>₹[\d,]+<\/b>/.test(rec.raw),
  (rec.raw.match(/received against a fee of[^·]*/)||[])[0]);
const over=sum-multi.expected_amount;
if(over>0) check('overpayment is called out', /more than the/.test(rec.raw), over);
else check('no spurious overpayment note', !/more than the/.test(rec.raw));

console.log('\n== Single-payment receipt reads naturally ==');
const one=(await all("SELECT r.phone_number FROM registrations r JOIN payment_transactions pt ON pt.registration_id=r.id WHERE r.bank_status='BANK_VERIFIED' GROUP BY r.id HAVING COUNT(*)=1 AND SUM(pt.txn_status='VERIFIED')=1 LIMIT 1"))[0];
const rec1=await receiptFor(one.phone_number);
check('receipt served', rec1 && rec1.status===200, rec1&&rec1.status);
// A single payment gets no instalment block at all -- there is nothing to
// break down, and "Paid in 1 instalment" would imply a missing second one.
check('single payment: no instalment breakdown', !/Paid in \d+ instalments/.test(rec1.raw));
check('single payment: the amount is still the hero', /class="amt money">₹[\d,]+</.test(rec1.raw));
check('no overpayment note on an exact payment', !/more than the/.test(rec1.raw));

console.log('\n== Rejected / pending payments are NOT on the receipt ==');
const withRej=(await all("SELECT r.phone_number, r.id FROM registrations r JOIN payment_transactions pt ON pt.registration_id=r.id WHERE r.bank_status='BANK_VERIFIED' AND pt.txn_status IN ('REJECTED','PENDING') GROUP BY r.id LIMIT 1"))[0];
if(withRej){
  const verCount=(await all(`SELECT COUNT(*) n FROM payment_transactions WHERE registration_id=${withRej.id} AND txn_status='VERIFIED'`))[0].n;
  const verSum=(await all(`SELECT COALESCE(SUM(COALESCE(verified_amount,amount)),0) s FROM payment_transactions WHERE registration_id=${withRej.id} AND txn_status='VERIFIED'`))[0].s;
  const allCount=(await all(`SELECT COUNT(*) n FROM payment_transactions WHERE registration_id=${withRej.id}`))[0].n;
  const rec2=await receiptFor(withRej.phone_number);
  check('receipt served', rec2 && rec2.status===200, rec2&&rec2.status);
  // Ledger lines in the printed statement -- one per verified payment.
  const rendered=(rec2.print.match(/<div class="ln">/g)||[]).length;
  check(`renders ${verCount} of ${allCount} payments (non-verified excluded)`, rendered===verCount, {rendered, verCount, allCount});
  check(`total is the verified sum only (₹${verSum})`, rec2.raw.includes(verSum.toLocaleString('en-IN')), verSum);
} else { check('(no such registration in data)', true); }

console.log('\n== Still gated on verification ==');
const unver=(await all("SELECT phone_number FROM registrations WHERE bank_status != 'BANK_VERIFIED' LIMIT 1"))[0];
const rec3=await receiptFor(unver.phone_number);
check('unverified registration cannot fetch a receipt', rec3 && rec3.status===403, rec3&&rec3.status);
const anon=await call('GET','/api/registrations/me/receipt',null,null);
check('anonymous refused', anon.status===401||anon.status===403, anon.status);

console.log('\n== Menu rename ==');
let r=await call('POST','/api/auth/login-otp',{identifier:'7440977777'});
r=await call('POST','/api/auth/login',{identifier:'7440977777',otp:r.body.devOtp});
const admin=await call('GET','/admin',null,r.cookie);
check('menu says "Users"', /<span>👤 Users<\/span>/.test(admin.raw));
check('no longer "Users and Roles"', !/Users and Roles/.test(admin.raw));
report();
db.close();
})();
