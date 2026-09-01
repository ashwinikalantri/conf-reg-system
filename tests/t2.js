const { call, check, report } = require('./harness');
// Same adapter as t.js: this file's client always sent a body and never
// returned a null one.
const req = async (path, body, cookie) => {
  const r = await call('POST', path, body || {}, cookie);
  return { status: r.status, body: (r.body && typeof r.body === 'object') ? r.body : {}, cookie: r.cookie };
};
// Unique per run: fixed fixtures collide with the previous run's rows and
// trip the password lockout, which are not the things this suite tests.
const T2 = String(Date.now()).slice(-6);
const base = {salutation:'Dr', name:'test user', age:'30', gender:'Male', designation:'Consultant', institute:'Test Hospital', pincode:'442102', state:'Maharashtra', district:'Wardha'};

(async()=>{
console.log('\n== A. EMAIL-ONLY signup (no phone) -- international only ==');
let r = await req('/api/otp/request', {destination:`emailonly-${T2}@example.com`});
check('email OTP issued', r.body.success===true, r.body);
const eo = r.body.devOtp;
r = await req('/api/auth/register', {...base, country:'United Kingdom', email:`emailonly-${T2}@example.com`, emailOtp:eo, password:'testpass123'});
check('registered', r.body.success===true, r.body.error);
const u = r.body.user || {};
check('synthetic user key (not a phone)', /^u_[0-9a-f]{18}$/.test(u.phone_number||''), u.phone_number);
check('phone column NULL', u.phone===null, u.phone);
check('email_verified=1', u.email_verified===1, u.email_verified);
check('phone_verified=0', u.phone_verified===0, u.phone_verified);
check('hasPassword', u.hasPassword===true, u.hasPassword);
check('got a registration number', !!u.registration_number, u.registration_number);

console.log('\n== B. Email-only account can log in by email, and by password ==');
r = await req('/api/auth/login-otp', {identifier:`emailonly-${T2}@example.com`});
check('email OTP login allowed', r.body.success===true, r.body);
r = await req('/api/auth/login', {identifier:`emailonly-${T2}@example.com`, otp:r.body.devOtp});
check('OTP login works', r.body.success===true, r.body.error);
r = await req('/api/auth/login-password', {identifier:`emailonly-${T2}@example.com`, password:'testpass123'});
check('password login by email works', r.body.success===true, r.body.error);

console.log('\n== C. PHONE-ONLY signup (no email) ==');
r = await req('/api/otp/request', {destination:('9'+T2+'011')});
const po = r.body.devOtp;
r = await req('/api/auth/register', {...base, phone:('9'+T2+'011'), phoneOtp:po, email:`fx-${('9'+T2+'011')}@example.com`, password:'testpass123'});
check('registered', r.body.success===true, r.body.error);
check('key IS the phone', r.body.user.phone_number===('9'+T2+'011'), r.body.user.phone_number);
check('phone_verified=1', r.body.user.phone_verified===1);
check('email_verified=0', r.body.user.email_verified===0);

console.log('\n== D. BOTH channels, only one verified ==');
r = await req('/api/otp/request', {destination:('9'+T2+'022')});
r = await req('/api/auth/register', {...base, phone:('9'+T2+'022'), phoneOtp:r.body.devOtp, email:`both-${T2}@example.com`, password:'testpass123'});
check('registered with unverified email on file', r.body.success===true, r.body.error);
check('phone verified', r.body.user.phone_verified===1);
check('email stored but unverified', r.body.user.email===`both-${T2}@example.com` && r.body.user.email_verified===0, r.body.user.email_verified);
r = await req('/api/auth/login-otp', {identifier:`both-${T2}@example.com`});
check('unverified email cannot receive login OTP', r.status===403, r.status);

console.log('\n== E. Rejections ==');
r = await req('/api/auth/register', {...base, phone:('9'+T2+'033'), email:'fx-9111100033@example.com', password:'testpass123'});
check('no OTP at all -> 400', r.status===400 && /Verify your mobile/i.test(r.body.error||''), r.body.error);
r = await req('/api/otp/request', {destination:('9'+T2+'044')});
r = await req('/api/auth/register', {...base, phone:('9'+T2+'044'), email:'fx-9111100044@example.com', phoneOtp:r.body.devOtp, password:'short'});
check('short password -> 400', r.status===400 && /8 characters/.test(r.body.error||''), r.body.error);
r = await req('/api/otp/request', {destination:('9'+T2+'055')});
r = await req('/api/auth/register', {...base, phone:('9'+T2+'055'), phoneOtp:r.body.devOtp});
check('no password -> 400', r.status===400, r.body.error);
r = await req('/api/auth/register', {...base, password:'testpass123'});
check('neither phone nor email -> 400', r.status===400, r.body.error);
// Phone is optional ONLY for international delegates: an Indian signup
// must supply one, since it's their SMS channel and their account key.
r = await req('/api/otp/request', {destination:`india-nophone-${T2}@example.com`});
r = await req('/api/auth/register', {...base, country:'India', email:`india-nophone-${T2}@example.com`, emailOtp:r.body.devOtp, password:'testpass123'});
check('email-only under India -> refused', r.status===400 && /mobile number is required/i.test(r.body.error||''), [r.status, r.body.error]);

console.log('\n== F. Duplicate email / phone blocked at signup ==');
r = await req('/api/otp/request', {destination:`dupe-${T2}@example.com`});
let dupOtp = r.body.devOtp;
r = await req('/api/auth/register', {...base, country:'United Kingdom', email:`dupe-${T2}@example.com`, emailOtp:dupOtp, password:'testpass123'});
check('first signup ok', r.body.success===true, r.body.error);
r = await req('/api/otp/request', {destination:('9'+T2+'066')});
r = await req('/api/auth/register', {...base, phone:('9'+T2+'066'), phoneOtp:r.body.devOtp, email:`dupe-${T2}@example.com`, password:'testpass123'});
check('reusing that email -> 409', r.status===409 && /already exists/i.test(r.body.error||''), [r.status, r.body.error]);
r = await req('/api/otp/request', {destination:('9'+T2+'077')});
r = await req('/api/auth/register', {...base, phone:('9'+T2+'077'), phoneOtp:r.body.devOtp, email:`x-${T2}@example.com`, password:'testpass123'});
check('different email ok', r.body.success===true, r.body.error);
report();
})();
