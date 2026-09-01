const { call, check, report, ADMIN } = require('./harness');
;
const sqlite3=require('sqlite3').verbose();
const N=String(Date.now()).slice(-6);
const db=new sqlite3.Database(process.argv[2], sqlite3.OPEN_READONLY);
const one=(q)=>new Promise((r,j)=>db.get(q,(e,x)=>e?j(e):r(x)));
(async()=>{
let r=await call('POST','/api/auth/login-otp',{identifier:ADMIN});
r=await call('POST','/api/auth/login',{identifier:ADMIN,otp:r.body.devOtp});
const ac=r.cookie;
const base={salutation:'Dr',name:'edit target',age:'30',gender:'Male',designation:'X',institute:'Y',pincode:'442102',state:'Maharashtra',district:'Wardha'};
const mail=`edit-${N}@example.com`;
r=await call('POST','/api/otp/request',{destination:mail});
r=await call('POST','/api/auth/register',{...base,country:'United Kingdom',email:mail,emailOtp:r.body.devOtp,password:'testpass123'});
const key=r.body.user.phone_number;
check('fixture: email-verified account', r.body.user.email_verified===1, r.body.user);

console.log('\n== Admin cannot re-create a duplicate address ==');
const victim=await one("SELECT email FROM users WHERE email IS NOT NULL AND email!='' AND phone_number!='"+key+"' LIMIT 1");
r=await call('PUT',`/api/users/${key}`,{email:victim.email},ac);
check("someone else's address -> 409", r.status===409, [r.status,r.body&&r.body.error]);
r=await call('PUT',`/api/users/${key}`,{email:victim.email.toUpperCase()},ac);
check('and case cannot sidestep it -> 409', r.status===409, [r.status,r.body&&r.body.error]);

console.log('\n== Changing the address drops verified standing ==');
const newMail=`changed-${N}@example.com`;
r=await call('PUT',`/api/users/${key}`,{email:newMail},ac);
check('change accepted', r.body.success===true, r.body);
let row=await one(`SELECT email, email_verified FROM users WHERE phone_number='${key}'`);
check('stored normalised', row.email===newMail, row.email);
check('email_verified reset to 0', row.email_verified===0, row.email_verified);
r=await call('POST','/api/auth/login-otp',{identifier:newMail});
check('new address cannot receive a login OTP yet', r.status===403, [r.status,r.body&&r.body.error]);

console.log('\n== Unrelated edits leave verification alone ==');
r=await call('POST','/api/auth/login-password',{identifier:newMail,password:'testpass123'});
const dc=r.cookie;
r=await call('POST','/api/auth/verify-contact/request',{channel:'email',value:newMail},dc);
r=await call('POST','/api/auth/verify-contact/confirm',{channel:'email',value:newMail,otp:r.body.devOtp},dc);
check('re-verified', r.body.user && r.body.user.email_verified===1, r.body.error);
r=await call('PUT',`/api/users/${key}`,{designation:'Senior Consultant'},ac);
check('designation edit ok', r.body.success===true, r.body);
row=await one(`SELECT email_verified, designation FROM users WHERE phone_number='${key}'`);
check('still verified after an unrelated edit', row.email_verified===1, row.email_verified);
check('designation actually changed', row.designation==='Senior Consultant', row.designation);

console.log('\n== Re-saving the SAME address is not a change ==');
r=await call('PUT',`/api/users/${key}`,{email:newMail.toUpperCase()},ac);
row=await one(`SELECT email_verified FROM users WHERE phone_number='${key}'`);
check('same address, different case, stays verified', row.email_verified===1, row.email_verified);

console.log('\n== Garbage rejected ==');
r=await call('PUT',`/api/users/${key}`,{email:'not-an-email'},ac);
check('invalid address -> 400', r.status===400, [r.status,r.body&&r.body.error]);
report();
db.close();
})();
