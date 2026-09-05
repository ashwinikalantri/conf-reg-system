const { call, check, report, ADMIN, adminLogin } = require('./harness');
;
const sqlite3=require('sqlite3').verbose();
const N=String(Date.now()).slice(-6);
const P=(i)=>'9'+N+String(i).padStart(3,'0');
const E=(t)=>`${t}-${N}@example.com`;
const db=new sqlite3.Database(process.argv[2], sqlite3.OPEN_READONLY);
const one=(q)=>new Promise((r,j)=>db.get(q,(e,x)=>e?j(e):r(x)));
const base={salutation:'Dr',name:'email required',age:'30',gender:'Male',designation:'X',institute:'Y',pincode:'442102',state:'Maharashtra',district:'Wardha'};
(async()=>{
console.log('\n== SIGNUP now requires an email ==');
let r=await call('POST','/api/otp/request',{destination:P(1)});
r=await call('POST','/api/auth/register',{...base,phone:P(1),phoneOtp:r.body.devOtp,password:'testpass123'});
check('phone-only signup refused', r.status===400 && /email address is required/i.test(r.body.error||''), [r.status,r.body&&r.body.error]);
r=await call('POST','/api/otp/request',{destination:P(2)});
r=await call('POST','/api/auth/register',{...base,phone:P(2),phoneOtp:r.body.devOtp,email:'bogus',password:'testpass123'});
check('malformed email refused', r.status===400 && /valid email/i.test(r.body.error||''), [r.status,r.body&&r.body.error]);
r=await call('POST','/api/otp/request',{destination:P(3)});
r=await call('POST','/api/auth/register',{...base,phone:P(3),phoneOtp:r.body.devOtp,email:E('ok'),password:'testpass123'});
check('phone verified + email recorded unverified = accepted', r.body.success===true, r.body.error);
check('  email stored', r.body.user.email===E('ok'), r.body.user.email);
check('  email_verified 0 (verification stays optional)', r.body.user.email_verified===0, r.body.user.email_verified);
check('  phone_verified 1', r.body.user.phone_verified===1);
r=await call('POST','/api/otp/request',{destination:E('only')});
r=await call('POST','/api/auth/register',{...base,country:'United Kingdom',email:E('only'),emailOtp:r.body.devOtp,password:'testpass123'});
check('email-only signup still works (international)', r.body.success===true, r.body.error);

console.log('\n== ADMIN create-user requires an email ==');
r = { cookie: await adminLogin() };
const ac=r.cookie;
r=await call('POST','/api/users',{name:'No Email Staff',phone:P(4),role:'OPERATIONS',designation:'C',institute:'M'},ac);
check('no email refused', r.status===400 && /email address is required/i.test(r.body.error||''), [r.status,r.body&&r.body.error]);
r=await call('POST','/api/users',{name:'Staff',phone:P(5),email:'nope',role:'OPERATIONS',designation:'C',institute:'M'},ac);
check('malformed refused', r.status===400, [r.status,r.body&&r.body.error]);
const taken=await one("SELECT email FROM users WHERE email IS NOT NULL AND email!='' LIMIT 1");
r=await call('POST','/api/users',{name:'Staff',phone:P(6),email:taken.email,role:'OPERATIONS',designation:'C',institute:'M'},ac);
check('duplicate address refused (409)', r.status===409, [r.status,r.body&&r.body.error]);
r=await call('POST','/api/users',{name:'Good Staff',phone:P(7),email:E('staff'),role:'OPERATIONS',designation:'C',institute:'M'},ac);
check('valid create accepted', r.body.success===true, r.body.error);
let row=await one(`SELECT email, email_verified FROM users WHERE phone_number='${P(7)}'`);
check('  email recorded', row.email===E('staff'), row.email);
check('  and NOT auto-verified', row.email_verified===0, row.email_verified);

console.log('\n== WALK-IN registration requires an email for a new delegate ==');
r=await call('POST','/api/admin/registrations',{phone:P(8),name:'Walkin NoMail',categoryKey:'chw',optionIds:[],paymentMode:'CASH',collectedBy:ADMIN,amount:200},ac);
check('no email refused', r.status===400 && /email address is required/i.test(r.body.error||''), [r.status,r.body&&r.body.error]);
r=await call('POST','/api/admin/registrations',{phone:P(9),name:'Walkin',email:E('walkin'),categoryKey:'chw',optionIds:[],paymentMode:'CASH',collectedBy:ADMIN,amount:200},ac);
check('with email accepted', r.body.success===true, r.body.error);
row=await one(`SELECT email, email_verified FROM users WHERE phone_number='${P(9)}'`);
check('  email recorded', row.email===E('walkin'), row.email);
check('  not auto-verified', row.email_verified===0, row.email_verified);

console.log('\n== Existing account reuses its address (no need to retype) ==');
// P(7) already exists with an email; register them as a walk-in with no email field.
r=await call('POST','/api/admin/registrations',{phone:P(7),name:'Good Staff',categoryKey:'chw',optionIds:[],paymentMode:'CASH',collectedBy:ADMIN,amount:200},ac);
check('accepted, reusing the stored address', r.body.success===true, r.body.error);
report();
db.close();
})();
