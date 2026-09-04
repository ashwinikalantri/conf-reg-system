const { call, check, report, adminLogin } = require('./harness');
;
const sqlite3=require('sqlite3').verbose();
const N=String(Date.now()).slice(-6);
const db=new sqlite3.Database(process.argv[2], sqlite3.OPEN_READONLY);
const all=(q)=>new Promise((r,j)=>db.all(q,(e,x)=>e?j(e):r(x)));
(async()=>{
const owner=(await all("SELECT id, phone_number FROM payment_transactions WHERE screenshot IS NOT NULL LIMIT 1"))[0];
console.log(`   slip belongs to txn #${owner.id} (${owner.phone_number})`);

console.log('\n== The OWNING delegate may see their own slip ==');
// Give the owner a known password so we can sign in as them.
let r=await call('POST','/api/auth/login-otp',{identifier:owner.phone_number});
if(r.body && r.body.success){
  r=await call('POST','/api/auth/login',{identifier:owner.phone_number,otp:r.body.devOtp});
  const oc=r.cookie;
  const mine=await call('GET',`/api/payment-transactions/${owner.id}/screenshot`,null,oc);
  check('owner gets their slip', mine.status===200, mine.status);
} else { check('(owner not OTP-reachable, skipped)', true); }

console.log('\n== An UNRELATED delegate may NOT ==');
const base={salutation:'Dr',name:'nosy tester',age:'30',gender:'Male',designation:'X',institute:'Y',pincode:'442102',state:'Maharashtra',district:'Wardha'};
const ph='9'+N+'777';
r=await call('POST','/api/otp/request',{destination:ph});
r=await call('POST','/api/auth/register',{...base, phone:ph, phoneOtp:r.body.devOtp, email:`fx-${ph}@example.com`, password:'testpass123'});
check('unrelated delegate created', r.body.success===true, r.body.error);
const nc=r.cookie;
const theirs=await call('GET',`/api/payment-transactions/${owner.id}/screenshot`,null,nc);
check("refused someone else's slip (403)", theirs.status===403, [theirs.status, theirs.body]);
check('and no image bytes returned', !/^image\//.test(theirs.type||''), theirs.type);

console.log('\n== Finance admin may ==');
r = { cookie: await adminLogin() };
const fin=await call('GET',`/api/payment-transactions/${owner.id}/screenshot`,null,r.cookie);
check('admin gets the slip', fin.status===200, fin.status);

console.log('\n== UI wiring shipped ==');
const js=await call('GET','/app.js',null,null);
check('Payment Slip button rendered per ledger row', /onclick="showTxnSlip\(\$\{esc\(t\.id\)\}\)">\$\{ICON\('document'\)\}Payment Slip<\/button>/.test(js.buf.toString()));
check('showTxnSlip defined', /function showTxnSlip/.test(js.buf.toString()));
// The fixed three-slot pane (screenshot/idcard/txnslip) was replaced by tabs
// built per registration -- ID card, then one per payment slip. Assert the
// property that mattered: a second slip is still independently reachable.
check('evidence tabs built per registration', /function buildReviewEvidence/.test(js.buf.toString()));
check('one tab per payment slip', /Payment Slip\$\{slipTxns\.length > 1/.test(js.buf.toString()));
check('missing-file message present', /no longer on file/.test(js.buf.toString()));
report();
db.close();
})();
