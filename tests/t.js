const { BASE, call, check, report } = require('./harness');
const B = BASE;
// Kept as a thin adapter rather than switching the call sites: this file's
// client always sent a JSON body (`body||{}`) and turned a non-JSON response
// into {}, and some assertions read .body without checking. Preserving that
// keeps this conversion behaviour-neutral.
const fetchJson = async (path, body, cookie) => {
  const r = await call('POST', path, body || {}, cookie);
  return { status: r.status, body: (r.body && typeof r.body === 'object') ? r.body : {}, cookie: r.cookie };
};
const req = fetchJson;
const sqlite3=require('sqlite3').verbose();
const db=new sqlite3.Database(process.argv[2], sqlite3.OPEN_READONLY);
const one=(q)=>new Promise((r,j)=>db.get(q,(e,x)=>e?j(e):r(x)));
(async()=>{
// Chosen from live data rather than hardcoded: real users have since
// verified their addresses, so a fixed account no longer reliably has an
// unverified one to test against.
const SUBJ = await one("SELECT phone_number, email FROM users WHERE email_verified = 0 AND email IS NOT NULL AND email != '' AND phone_number GLOB '[0-9]*' AND (SELECT COUNT(*) FROM users u2 WHERE LOWER(u2.email)=LOWER(users.email))=1 LIMIT 1");
const PHONE = SUBJ.phone_number, MAIL = SUBJ.email;
console.log(`   (subject: ${PHONE} / ${MAIL})`);
console.log('\n== 1. Existing user: phone OTP login (phone IS verified) ==');
let r = await req('/api/auth/login-otp', {identifier:PHONE});
check('login-otp accepted', r.body.success===true, r.body);
check('channel is sms', r.body.channel==='sms', r.body.channel);
const otp = r.body.devOtp;
r = await req('/api/auth/login', {identifier:PHONE, otp});
check('login succeeds', r.body.success===true, r.body.error);
check('phone_verified surfaced =1', r.body.user && r.body.user.phone_verified===1, r.body.user&&r.body.user.phone_verified);
check('email_verified surfaced =0', r.body.user && r.body.user.email_verified===0, r.body.user&&r.body.user.email_verified);
const adminCookie = r.cookie;

console.log('\n== 2. Same user by EMAIL (email NOT verified) -> must be refused ==');
r = await req('/api/auth/login-otp', {identifier:MAIL});
check('refused with 403', r.status===403, r.status);
check('explains email unverified', /not been verified/i.test(r.body.error||''), r.body.error);

console.log('\n== 3. Verify email via session, then email login works ==');
r = await req('/api/auth/verify-contact/request', {channel:'email', value:MAIL}, adminCookie);
check('verify code issued', r.body.success===true, r.body);
const vcode = r.body.devOtp;
r = await req('/api/auth/verify-contact/confirm', {channel:'email', value:MAIL, otp:vcode}, adminCookie);
check('email confirmed', r.body.success===true, r.body.error);
check('email_verified now 1', r.body.user && r.body.user.email_verified===1, r.body.user&&r.body.user.email_verified);
r = await req('/api/auth/login-otp', {identifier:MAIL});
check('email OTP login now allowed', r.body.success===true, r.body);
check('channel is email', r.body.channel==='email', r.body.channel);
const eotp = r.body.devOtp;
r = await req('/api/auth/login', {identifier:MAIL.toUpperCase(), otp:eotp});
check('login by email (case-insensitive)', r.body.success===true, r.body.error);

console.log('\n== 4. Ambiguous email (2 accounts share it) ==');
// The live duplicates were cleaned up, so this seeds its own pair directly
// in the DB copy -- the guard is still live code and worth covering.
const STAMP=String(Date.now()).slice(-6);
const AMB = `ambiguous-${STAMP}@example.com`;
const AMBK1=`amb1_${STAMP}`, AMBK2=`amb2_${STAMP}`;
await new Promise((res,rej)=>{const w=new sqlite3.Database(process.argv[2]);
  w.serialize(()=>{ w.run("INSERT INTO users (phone_number, phone, phone_verified, full_name, email, role, created_at) VALUES (?,?,1,'Amb One',?,'DELEGATE',?)",[AMBK1,'+91'+AMBK1.replace(/\D/g,'').slice(-10),AMB,Date.now()]);
    w.run("INSERT INTO users (phone_number, phone, phone_verified, full_name, email, role, created_at) VALUES (?,?,1,'Amb Two',?,'DELEGATE',?)",[AMBK2,'+91'+AMBK2.replace(/\D/g,'').slice(-10),AMB,Date.now()],(e)=>{w.close(); e?rej(e):res();}); }); });
r = await req('/api/auth/login-otp', {identifier:AMB});
check('refused with 409', r.status===409, r.status);
check('tells them to use mobile', /mobile number/i.test(r.body.error||''), r.body.error);

console.log('\n== 5. Unknown identifier -> notRegistered ==');
r = await req('/api/auth/login-otp', {identifier:'nobody@nowhere.example'});
check('notRegistered flag', r.body.notRegistered===true, r.body);
r = await req('/api/auth/login-otp', {identifier:'9999900001'});
check('notRegistered for unknown phone', r.body.notRegistered===true, r.body);

console.log('\n== 6. Garbage identifier ==');
r = await req('/api/auth/login-otp', {identifier:'not-an-identifier'});
check('rejected 400', r.status===400, r.status);
report();
// Remove the seeded pair so it can't skew other suites' random samples.
await new Promise((res)=>{const w=new sqlite3.Database(process.argv[2]);
  w.run("DELETE FROM users WHERE phone_number IN (?,?)",[AMBK1,AMBK2],()=>{w.close();res();});});
db.close();
})();
