const { call, check, report } = require('./harness');
;
const N=String(Date.now()).slice(-6);
const base={salutation:'Dr',name:'map tester',age:'40',gender:'Male',designation:'Consultant',institute:'X'};
(async()=>{
let r=await call('POST','/api/auth/login-otp',{identifier:'7440977777'});
r=await call('POST','/api/auth/login',{identifier:'7440977777',otp:r.body.devOtp});
const ac=r.cookie;

console.log('\n== Baseline before any international delegate ==');
let map=await call('GET','/api/admin/delegate-locations',null,ac);
check('endpoint responds', map.status===200, map.status);
check('international key present', Array.isArray(map.body.international), typeof map.body.international);
const before=(map.body.international||[]).reduce((n,c)=>n+c.registered+c.signedup,0);
const indiaBefore=(map.body.locations||[]).reduce((n,l)=>n+l.registered+l.signedup,0);

console.log('\n== Add two international delegates ==');
for (const [c,city] of [['United Kingdom','London'],['United Kingdom','Leeds'],['Japan','Osaka']]) {
  const mail=`map-${c.replace(/\s/g,'')}-${city}-${N}@example.com`;
  let o=await call('POST','/api/otp/request',{destination:mail});
  const res=await call('POST','/api/auth/register',{...base,country:c,email:mail,emailOtp:o.body.devOtp,password:'testpass123',district:city});
  if(!res.body.success) console.log('   (setup failed:',res.body.error,')');
}
map=await call('GET','/api/admin/delegate-locations',null,ac);
const intl=map.body.international||[];
const after=intl.reduce((n,c)=>n+c.registered+c.signedup,0);
check('international count rose by 3', after===before+3, {before, after});
const uk=intl.find(x=>x.country==='United Kingdom');
const jp=intl.find(x=>x.country==='Japan');
check('grouped per country — UK has 2', uk && (uk.registered+uk.signedup)>=2, uk);
check('grouped per country — Japan has 1', jp && (jp.registered+jp.signedup)>=1, jp);
check('they are signed-up, not registered', intl.every(c=>c.registered===0||c.signedup>0), intl);

console.log('\n== They do NOT pollute the Indian district data ==');
const indiaAfter=(map.body.locations||[]).reduce((n,l)=>n+l.registered+l.signedup,0);
check('Indian totals unchanged', indiaAfter===indiaBefore, {indiaBefore, indiaAfter});
check('no international row has a pincode key', !(map.body.locations||[]).some(l=>!l.pincode), 'ok');

console.log('\n== Panel markup is served ==');
const admin=await call('GET','/admin',null,ac);
check('international panel present', /id="delegate-map-international"/.test(admin.raw));
check('hidden by default', /id="delegate-map-international" class="hidden/.test(admin.raw));
const js=await call('GET','/app.js',null,null);
check('client reads locPayload.international', /locPayload\.international/.test(js.raw));
check('client hides the panel when empty', /intlBox\.classList\.toggle\('hidden', intl\.length === 0\)/.test(js.raw));
report();
})();
