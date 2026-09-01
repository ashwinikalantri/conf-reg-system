const { call, check, report } = require('./harness');
;
const base={salutation:'Dr',name:'banner tester',age:'30',gender:'Male',designation:'Consultant',institute:'Test Hospital',pincode:'442102',state:'Maharashtra',district:'Wardha'};
// Unique per run: these suites are run repeatedly against the same DB copy,
// and a reused address/number collides with the previous run's fixture.
const N = String(Date.now()).slice(-7);
const PH = '9' + N.slice(-9).padStart(9,'5');
const A1 = `added-later-${N}@example.com`;
const A2 = `corrected-${N}@example.com`;
(async()=>{
console.log('\n== Markup is actually served ==');
const portal=await call('GET','/',null,null);
check('dashboard has the verify-email banner', /id="verify-email-banner"/.test(portal.raw));
check('portal includes the verify-email modal', /id="modal-verify-email"/.test(portal.raw));
check('banner has a Verify Now button', /openVerifyEmailModal\(\)/.test(portal.raw));

// (The admin panel deliberately has NO own-account modals -- asserted in t11.)

console.log('\n== A delegate whose email is unverified can verify (or correct) it ==');
r=await call('POST','/api/otp/request',{destination:PH});
r=await call('POST','/api/auth/register',{...base, phone:PH, phoneOtp:r.body.devOtp, email:`fx-${PH}@example.com`, password:'testpass123'});
check('registered', r.body.success===true, r.body.error);
check('email recorded but unverified', !!r.body.user.email && r.body.user.email_verified===0, [r.body.user.email, r.body.user.email_verified]);
check('email_verified=0 (banner would show)', r.body.user.email_verified===0);
const dc=r.cookie;
r=await call('POST','/api/auth/verify-contact/request',{channel:'email',value:A1},dc);
check('can request a code for a brand-new address', r.body.success===true, r.body.error);
r=await call('POST','/api/auth/verify-contact/confirm',{channel:'email',value:A1,otp:r.body.devOtp},dc);
check('address added AND verified in one step', r.body.success===true, r.body.error);
check('email now set', r.body.user.email===A1, r.body.user.email);
check('email_verified=1 (banner clears)', r.body.user.email_verified===1);
r=await call('POST','/api/auth/login-otp',{identifier:A1});
check('and they can now sign in with it', r.body.success===true, r.body);

console.log('\n== Correcting a wrong address on file ==');
r=await call('POST','/api/auth/verify-contact/request',{channel:'email',value:A2},dc);
r=await call('POST','/api/auth/verify-contact/confirm',{channel:'email',value:A2,otp:r.body.devOtp},dc);
check('replaced with the corrected address', r.body.user.email===A2, r.body.user.email);
r=await call('POST','/api/auth/login-otp',{identifier:A1});
check('the old address no longer works', r.body.notRegistered===true || r.status>=400, [r.status,r.body]);

console.log('\n== Still cannot claim someone else\'s address ==');
r=await call('POST','/api/auth/verify-contact/request',{channel:'email',value:'ashwini@mgims.ac.in'},dc);
check('taken address -> 409', r.status===409, [r.status,r.body.error]);
report();
})();
