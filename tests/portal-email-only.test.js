const { call, check, report, ADMIN } = require('./harness');
(async()=>{
// Log in the email-only delegate
// Self-contained: creates its own email-only (international) delegate
// rather than depending on a fixture another suite happens to leave behind.
const T3=String(Date.now()).slice(-6);
const MAIL3=`emailonly-${T3}@example.com`;
const b3={salutation:'Dr',name:'email only',age:'30',gender:'Male',designation:'X',institute:'Y'};
let mk=await call('POST','/api/otp/request',{destination:MAIL3});
await call('POST','/api/auth/register',{...b3,country:'United Kingdom',email:MAIL3,emailOtp:mk.body.devOtp,password:'testpass123',district:'London'});
let r = await call('POST','/api/auth/login-password', {identifier:MAIL3, password:'testpass123'});
check('email-only delegate logs in', r.body.success===true, r.body.error);
const dc = r.cookie;

console.log('\n== Email-only delegate uses the rest of the portal ==');
r = await call('GET','/api/auth/me', null, dc);
check('/api/auth/me works', r.body.success===true, r.body);
r = await call('GET','/api/fees', null, dc);
check('/api/fees works', Array.isArray(r.body.categories), r.status);
r = await call('GET','/api/program-options', null, dc);
check('/api/program-options works', Array.isArray(r.body.groups), r.status);

// Submit a free (fully-discounted) registration is hard; use admin path instead.
// Log in as super admin and check the reports render.
r = await call('POST','/api/auth/login-otp', {identifier:ADMIN});
const otp = r.body.devOtp;
r = await call('POST','/api/auth/login', {identifier:ADMIN, otp});
const ac = r.cookie;
check('admin logged in', r.body.success===true, r.body.error);

console.log('\n== Reports must not print a synthetic key as a mobile number ==');
for (const t of ['delegates','payments','users']) {
  const rep = await call('GET', `/api/admin/reports/${t}`, null, ac);
  const txt = JSON.stringify(rep.body);
  check(`report "${t}" renders`, rep.status===200, rep.status);
  check(`report "${t}" leaks no u_ key`, !/u_[0-9a-f]{18}/.test(txt), (txt.match(/u_[0-9a-f]{18}/)||[])[0]);
}
report();
})();
