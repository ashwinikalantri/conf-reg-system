const { call, check, report, ADMIN } = require('./harness');
;
// Unique per run -- these suites get re-run against the same DB copy, and a
// reused number/address collides with the previous run's fixture.
const N = String(Date.now()).slice(-6);
const P = (i) => '9' + N + String(i).padStart(3,'0');
const E = (tag) => `${tag}-${N}@example.com`;
(async()=>{
let r=await call('POST','/api/auth/login-otp',{identifier:ADMIN});
r=await call('POST','/api/auth/login',{identifier:ADMIN,otp:r.body.devOtp});
const ac=r.cookie;

console.log('\n== Admin-created staff account ==');
r=await call('POST','/api/users',{name:'Staff Tester',phone:P(1),email:`fx-${P(1)}@example.com`,role:'OPERATIONS',designation:'Coordinator',institute:'MGIMS'},ac);
check('staff created', r.body.success===true, r.body.error);
r=await call('POST','/api/auth/login-otp',{identifier:P(1)});
check('can receive login OTP (phone_verified=1)', r.body.success===true, r.body);
r=await call('POST','/api/auth/login',{identifier:P(1),otp:r.body.devOtp});
check('staff can actually log in', r.body.success===true, r.body.error);
check('role preserved', r.body.user.role==='OPERATIONS', r.body.user.role);

console.log('\n== Walk-in registration (admin desk) ==');
r=await call('POST','/api/admin/registrations',{phone:P(2),name:'Walkin Tester',email:`fx-${P(2)}@example.com`,categoryKey:'chw',optionIds:[],paymentMode:'CASH',amount:200},ac);
check('walk-in registered', r.body.success===true, r.body.error);
check('temp password issued', !!r.body.tempPassword, r.body.tempPassword);
const tmp=r.body.tempPassword;
r=await call('POST','/api/auth/login-password',{identifier:P(2),password:tmp});
check('walk-in delegate can log in with temp password', r.body.success===true, r.body.error);
r=await call('POST','/api/auth/login-otp',{identifier:P(2)});
check('walk-in delegate can also use OTP', r.body.success===true, r.body);
report();
})();
