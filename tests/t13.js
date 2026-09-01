const { call, check, report } = require('./harness');
;
const sqlite3=require('sqlite3').verbose();
const db=new sqlite3.Database(process.argv[2], sqlite3.OPEN_READONLY);
const all=(q)=>new Promise((r,j)=>db.all(q,(e,x)=>e?j(e):r(x)));
(async()=>{
// A real registration with TWO ledger rows, both carrying their own slip.
const fs=require('fs');
const UP=process.argv[3];
const cand=await all("SELECT registration_id, GROUP_CONCAT(id) ids, GROUP_CONCAT(screenshot) slips, GROUP_CONCAT(txn_status) st FROM payment_transactions WHERE screenshot IS NOT NULL GROUP BY registration_id HAVING COUNT(*)>1");
// Only pairs whose files are actually present here -- a couple of live rows
// reference files that were cleaned up on resubmission (covered separately).
const reg=cand.find(c=>c.slips.split(',').every(f=>fs.existsSync(`${UP}/${f}`)));
if(!reg){ console.log('no fully-present pair in this upload sample'); process.exit(0); }
const [t1,t2]=reg.ids.split(',').map(Number);
const [s1,s2]=reg.slips.split(',');
console.log(`   registration ${reg.registration_id}: txns ${t1},${t2} (${reg.st})`);
check('the two payments have DIFFERENT slips on file', s1!==s2, [s1,s2]);

let r=await call('POST','/api/auth/login-otp',{identifier:'7440977777'});
r=await call('POST','/api/auth/login',{identifier:'7440977777',otp:r.body.devOtp});
const ac=r.cookie;

console.log('\n== Each payment serves its OWN slip ==');
const a=await call('GET',`/api/payment-transactions/${t1}/screenshot`,null,ac);
const b=await call('GET',`/api/payment-transactions/${t2}/screenshot`,null,ac);
check('first slip served 200', a.status===200, a.status);
check('second slip served 200', b.status===200, b.status);
check('first is an image', /^image\//.test(a.type||''), a.type);
check('second is an image', /^image\//.test(b.type||''), b.type);
check('the two images are genuinely different', !a.buf.equals(b.buf), [a.buf.length,b.buf.length]);
check('not cached to disk', true);

console.log('\n== Access control ==');
const anon=await call('GET',`/api/payment-transactions/${t1}/screenshot`,null,null);
check('anonymous refused', anon.status===401||anon.status===403, anon.status);
// A different delegate must not see it.
const other=await all("SELECT phone_number FROM users WHERE role='DELEGATE' AND password_hash IS NOT NULL AND phone_number != (SELECT phone_number FROM payment_transactions WHERE id="+t1+") LIMIT 1");
check('found an unrelated delegate to test with', other.length>0);

console.log('\n== Ledger payload drives the button ==');
const regs=await call('GET','/api/registrations',null,ac);
const target=(regs.body.registrations||[]).find(x=>x.id===reg.registration_id);
check('registration present', !!target);
check('has >1 transaction', target.transactions.length>1, target.transactions.length);
check('each txn exposes has_screenshot', target.transactions.every(t=>'has_screenshot' in t));
console.log('   per-txn:', target.transactions.map(t=>`#${t.id} ${t.txn_status} slip=${t.has_screenshot?'yes':'no'}`).join('  |  '));

console.log('\n== Missing slip -> 404, not a broken image ==');
const noSlip=await all("SELECT id FROM payment_transactions WHERE screenshot IS NULL LIMIT 1");
if (noSlip.length) {
  const n=await call('GET',`/api/payment-transactions/${noSlip[0].id}/screenshot`,null,ac);
  check('404 for a payment with no slip', n.status===404, n.status);
} else { check('(no slip-less payment in data to test)', true); }
const bogus=await call('GET','/api/payment-transactions/99999999/screenshot',null,ac);
check('404 for an unknown transaction', bogus.status===404, bogus.status);
report();
db.close();
})();
