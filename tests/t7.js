const { call, check, report } = require('./harness');
;
const sqlite3=require('sqlite3').verbose();
const db=new sqlite3.Database(process.argv[2], sqlite3.OPEN_READONLY);
const all=(q)=>new Promise((r,j)=>db.all(q,(e,x)=>e?j(e):r(x)));
(async()=>{
console.log('\n== Sample of 8 REAL pre-existing accounts can still log in by phone OTP ==');
const users = await all("SELECT phone_number, full_name, password_hash FROM users WHERE phone_number GLOB '[0-9]*' AND phone_number NOT IN ('9222200011','9222200022') ORDER BY RANDOM() LIMIT 8");
for (const u of users) {
  let r = await call('POST','/api/auth/login-otp',{identifier:u.phone_number});
  if(!r.body.success){ check(`${u.phone_number} OTP issue`, false, r.body); continue; }
  r = await call('POST','/api/auth/login',{identifier:u.phone_number, otp:r.body.devOtp});
  check(`${u.phone_number} (${(u.full_name||'').slice(0,22)})`, r.body.success===true, r.body.error);
}

console.log('\n== OTP attempt limit still enforced ==');
let r = await call('POST','/api/auth/login-otp',{identifier:users[0].phone_number});
for (let i=0;i<5;i++) await call('POST','/api/auth/login',{identifier:users[0].phone_number, otp:'000000'});
r = await call('POST','/api/auth/login',{identifier:users[0].phone_number, otp:'000000'});
check('locked out after repeated wrong codes', /Too many|request a new/i.test(r.body.error||''), r.body.error);

console.log('\n== OTP resend throttle still enforced ==');
await call('POST','/api/otp/request',{destination:'9333300011'});
r = await call('POST','/api/otp/request',{destination:'9333300011'});
check('rapid resend throttled (429)', r.status===429, [r.status, r.body.error]);

console.log('\n== Password login: wrong password does not leak account existence ==');
// Fresh identifiers each run: the wrong-password lockout is keyed by
// identifier and lives 15 minutes in memory, so reusing fixed ones makes
// this pass once and then 429 on every re-run.
const ST=String(Date.now()).slice(-6);
const REAL=`pwreal-${ST}@example.com`;
const pwbase={salutation:'Dr',name:'pw probe',age:'30',gender:'Male',designation:'X',institute:'Y',pincode:'442102',state:'Maharashtra',district:'Wardha'};
let mk=await call('POST','/api/otp/request',{destination:REAL});
await call('POST','/api/auth/register',{...pwbase,email:REAL,emailOtp:mk.body.devOtp,password:'testpass123'});
r = await call('POST','/api/auth/login-password',{identifier:REAL, password:'definitely-wrong'});
const e1=r.body.error;
r = await call('POST','/api/auth/login-password',{identifier:`nobody-${ST}@nowhere.example`, password:'definitely-wrong'});
check('identical error for real vs unknown account', e1===r.body.error, [e1, r.body.error]);

console.log('\n== Ambiguous email + password also gives the generic error ==');
// The live duplicates were cleaned up, so seed a throwaway pair -- the
// guard is still live code and worth covering.
const AMBE=`ambpw-${ST}@example.com`;
await new Promise((res,rej)=>{const s3=require('sqlite3').verbose(); const w=new s3.Database(process.argv[2]);
  w.serialize(()=>{ w.run("INSERT INTO users (phone_number, phone, phone_verified, full_name, email, role, created_at) VALUES (?,?,1,'AmbPw A',?,'DELEGATE',?)",['ambpw1_'+ST,'+919'+ST+'701',AMBE,Date.now()]);
    w.run("INSERT INTO users (phone_number, phone, phone_verified, full_name, email, role, created_at) VALUES (?,?,1,'AmbPw B',?,'DELEGATE',?)",['ambpw2_'+ST,'+919'+ST+'702',AMBE,Date.now()],(e)=>{w.close(); e?rej(e):res();}); }); });
r = await call('POST','/api/auth/login-password',{identifier:AMBE, password:'whatever'});
check('no ambiguity leak via password path', r.status===401, [r.status, r.body.error]);
await new Promise((res)=>{const s3=require('sqlite3').verbose(); const w=new s3.Database(process.argv[2]);
  w.run("DELETE FROM users WHERE phone_number IN (?,?)",['ambpw1_'+ST,'ambpw2_'+ST],()=>{w.close();res();});});
report();
db.close();
})();
