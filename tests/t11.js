const { call, check, report, ADMIN } = require('./harness');
;
const N=String(Date.now()).slice(-6);
(async()=>{
let r=await call('POST','/api/auth/login-otp',{identifier:ADMIN});
r=await call('POST','/api/auth/login',{identifier:ADMIN,otp:r.body.devOtp});
const ac=r.cookie;

console.log('\n== 1. Admin panel own-account items REMOVED ==');
const admin=await call('GET','/admin',null,ac);
check('no "Set My Password" menu item', !/Set My Password/.test(admin.raw));
check('no "Verify My Email" menu item', !/Verify My Email/.test(admin.raw));
check('no set-password modal', !/id="modal-set-password"/.test(admin.raw));
check('no verify-email modal', !/id="modal-verify-email"/.test(admin.raw));
check('no unverified dot', !/admin-email-unverified-dot/.test(admin.raw));
check('Users menu still intact', /<span>👤 Users<\/span>/.test(admin.raw));

console.log('\n== 2. Users page has the Account column ==');
check('Account header present', /title="M = mobile verified[^"]*">Account /.test(admin.raw), (admin.raw.match(/>Account[^<]*/)||[])[0]);

console.log('\n== 3. Delegate portal keeps its verify route ==');
const portal=await call('GET','/',null,null);
check('banner still there', /id="verify-email-banner"/.test(portal.raw));
check('verify modal still there', /id="modal-verify-email"/.test(portal.raw));
check('set-password modal still there', /id="modal-set-password"/.test(portal.raw));
check('address field can be disabled', /disabled:bg-slate-100/.test(portal.raw));
check('"Use a different address" affordance present', /Use a different address/.test(portal.raw));
check('unlock handler wired', /unlockVerifyEmailAddress\(\)/.test(portal.raw));

console.log('\n== 4. /api/users supplies what the icons need ==');
const users=await call('GET','/api/users',null,ac);
const list=users.body.users||[];
const sample=list[0]||{};
check('phone_verified present', 'phone_verified' in sample, Object.keys(sample).slice(0,20));
check('email_verified present', 'email_verified' in sample);
check('hasPassword present', 'hasPassword' in sample);
check('raw password_hash NOT leaked', !('password_hash' in sample));
const withPw=list.filter(u=>u.hasPassword).length;
const emailVer=list.filter(u=>u.email_verified).length;
const phoneVer=list.filter(u=>u.phone_verified).length;
console.log(`   across ${list.length} users: ${phoneVer} phone-verified, ${emailVer} email-verified, ${withPw} with a password`);
check('counts are plausible', phoneVer>0 && withPw>0);

console.log('\n== 5. Server still refuses a code issued to a DIFFERENT address ==');
r=await call('POST','/api/auth/verify-contact/request',{channel:'email',value:`lock-a-${N}@example.com`},ac);
const codeForA=r.body.devOtp;
check('code issued for A', !!codeForA);
r=await call('POST','/api/auth/verify-contact/confirm',{channel:'email',value:`lock-b-${N}@example.com`,otp:codeForA},ac);
check("A's code rejected for B (server-side backstop)", r.body.success!==true, r.body);
report();
})();
