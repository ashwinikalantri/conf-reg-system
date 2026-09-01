const { call, check, report, ADMIN } = require('./harness');
;
(async()=>{
let r=await call('POST','/api/auth/login-otp',{identifier:ADMIN});
r=await call('POST','/api/auth/login',{identifier:ADMIN,otp:r.body.devOtp});
const ac=r.cookie;
console.log('\n== Admin surfaces survive an international delegate ==');
for (const [label,path] of [
  ['delegate map','/api/admin/delegate-locations'],
  ['registrations','/api/registrations'],
]) {
  const res=await call('GET',path,null,ac);
  check(`${label} responds 200`, res.status===200, res.status);
  check(`${label} leaks no synthetic key`, !/u_[0-9a-f]{18}/.test(res.raw), (res.raw.match(/u_[0-9a-f]{18}/)||[])[0]);
}
// /api/users legitimately carries the account key -- the admin client needs
// it to open a user -- so it's checked for responding, not for hiding it.
{ const res=await call('GET','/api/users',null,ac); check('users responds 200', res.status===200, res.status); }
for (const t of ['delegates','users','payments']) {
  const rep=await call('GET',`/api/admin/reports/${t}`,null,ac);
  check(`report ${t} renders`, rep.status===200, rep.status);
  check(`report ${t} leaks no synthetic key`, !/u_[0-9a-f]{18}/.test(rep.raw), (rep.raw.match(/u_[0-9a-f]{18}/)||[])[0]);
}
const csv=await call('GET','/api/admin/reports/users?format=csv',null,ac);
const hasCountryCol=/(^|,)Country(,|$)/m.test(csv.raw.split('\n')[0]||'');
check('Users report has a Country column', hasCountryCol, (csv.raw.split('\n')[0]||'').slice(0,160));
report();
})();
