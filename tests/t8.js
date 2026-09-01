const { call, check, report } = require('./harness');
;
// Unique per run -- these suites get re-run against the same DB copy, and a
// reused number/address collides with the previous run's fixture.
const N = String(Date.now()).slice(-6);
const P = (i) => '9' + N + String(i).padStart(3,'0');
const E = (tag) => `${tag}-${N}@example.com`;
const base={salutation:'Dr',name:'grp tester',age:'30',gender:'Male',designation:'Consultant',institute:'Test Hospital',pincode:'442102',state:'Maharashtra',district:'Wardha'};
(async()=>{
// Live duplicates were cleaned up; seed a throwaway ambiguous pair so the
// "refuse an address shared by two accounts" guard stays covered.
const AMBIG_EMAIL=`ambiguous-${N}@example.com`;
await new Promise((res,rej)=>{const s3=require('sqlite3').verbose(); const w=new s3.Database(process.argv[2]||'./conference.db');
  w.serialize(()=>{ w.run("INSERT INTO users (phone_number, phone, phone_verified, full_name, email, role, created_at) VALUES (?,?,1,'Amb A',?, 'DELEGATE', ?)",['9'+N+'901','+919'+N+'901',AMBIG_EMAIL,Date.now()]);
    w.run("INSERT INTO users (phone_number, phone, phone_verified, full_name, email, role, created_at) VALUES (?,?,1,'Amb B',?, 'DELEGATE', ?)",['9'+N+'902','+919'+N+'902',AMBIG_EMAIL,Date.now()],(e)=>{w.close(); e?rej(e):res();}); }); });

// Create an EMAIL-ONLY delegate to target
let r=await call('POST','/api/otp/request',{destination:E('grpmember')});
r=await call('POST','/api/auth/register',{...base,country:'United Kingdom',email:E('grpmember'),emailOtp:r.body.devOtp,password:'testpass123'});
check('email-only delegate created', r.body.success===true, r.body.error);
const emailOnlyKey=r.body.user.phone_number;
console.log('   (their account key is the synthetic', emailOnlyKey + ')');

// Admin session
r=await call('POST','/api/auth/login-otp',{identifier:'7440977777'});
r=await call('POST','/api/auth/login',{identifier:'7440977777',otp:r.body.devOtp});
const ac=r.cookie;

console.log('\n== PROMO CODE scoped to a delegate BY EMAIL ==');
r=await call('POST','/api/admin/discount-codes',{code:('EMAILSCOPE1'+N),discountType:'PERCENT',discountValue:50,scopeType:'INDIVIDUAL',scopeValue:E('grpmember')},ac);
check('created by email', r.body.success===true, r.body.error);
const codes=await call('GET','/api/admin/discount-codes',null,ac);
const list=Array.isArray(codes.body)?codes.body:(codes.body.codes||[]);
const made=list.find(c=>c.code===('EMAILSCOPE1'+N));
check('scope_value stored as the ACCOUNT KEY (not the email)', made && made.scope_value===emailOnlyKey, made && made.scope_value);

console.log('\n== That delegate can actually redeem it ==');
r=await call('POST','/api/auth/login-password',{identifier:E('grpmember'),password:'testpass123'});
const dc=r.cookie;
r=await call('POST','/api/discounts/validate',{code:('EMAILSCOPE1'+N),categoryKey:'faculty_mo'},dc);
check('code validates for the intended delegate', r.body.success===true, r.body.error);
// Derived from the fee the server itself quoted, not hardcoded: the base
// fee depends on which pricing phase today falls in, so pinning the
// early-bird number made this fail the moment early bird ended.
check(`50% off ${r.body.baseFee} = ${r.body.baseFee/2}`,
  r.body.finalFee===r.body.baseFee/2 && r.body.discountAmount===r.body.baseFee/2, r.body);

console.log('\n== And is refused for anyone else ==');
r=await call('POST','/api/auth/login-otp',{identifier:'7440977777'});
r=await call('POST','/api/auth/login',{identifier:'7440977777',otp:r.body.devOtp});
r=await call('POST','/api/discounts/validate',{code:('EMAILSCOPE1'+N),categoryKey:'faculty_mo'},r.cookie);
check('refused for a different account', r.body.success===false, r.body);

console.log('\n== Promo code scope errors ==');
r=await call('POST','/api/admin/discount-codes',{code:('NOSUCH1'+N),discountType:'PERCENT',discountValue:10,scopeType:'INDIVIDUAL',scopeValue:'ghost@nowhere.example'},ac);
check('unknown email -> 404', r.status===404, [r.status,r.body.error]);
r=await call('POST','/api/admin/discount-codes',{code:('AMBIG1'+N),discountType:'PERCENT',discountValue:10,scopeType:'INDIVIDUAL',scopeValue:AMBIG_EMAIL},ac);
check('ambiguous email -> 409', r.status===409, [r.status,r.body.error]);
r=await call('POST','/api/admin/discount-codes',{code:('BYPHONE1'+N),discountType:'PERCENT',discountValue:10,scopeType:'INDIVIDUAL',scopeValue:'7440977777'},ac);
check('still works by mobile (regression)', r.body.success===true, r.body.error);
report();
})();
