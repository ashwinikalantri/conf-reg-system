const { call, check, report } = require('./harness');
;
// Unique per run -- these suites get re-run against the same DB copy, and a
// reused number/address collides with the previous run's fixture.
const N = String(Date.now()).slice(-6);
const P = (i) => '9' + N + String(i).padStart(3,'0');
const E = (tag) => `${tag}-${N}@example.com`;
const base={salutation:'Dr',name:'grp tester',age:'30',gender:'Male',designation:'Consultant',institute:'Test Hospital',pincode:'442102',state:'Maharashtra',district:'Wardha'};
async function mkEmailUser(email){
  let r=await call('POST','/api/otp/request',{destination:email});
  r=await call('POST','/api/auth/register',{...base,country:'United Kingdom',email,emailOtp:r.body.devOtp,password:'testpass123'});
  return r.body.user;
}
async function mkPhoneUser(phone){
  let r=await call('POST','/api/otp/request',{destination:phone});
  r=await call('POST','/api/auth/register',{...base,phone,phoneOtp:r.body.devOtp,email:`fx-${phone}@example.com`,password:'testpass123'});
  return r.body.user;
}
(async()=>{
const leader = await mkPhoneUser(P(1));
const emailMember = await mkEmailUser(E('member-by-email'));
const phoneMember = await mkPhoneUser(P(2));
check('fixtures created', !!leader && !!emailMember && !!phoneMember);

// A group can only be created for a category that HAS a group-discount rule.
// This used to rely on one already existing in the database, which made the
// suite fail the moment it ran against data where none did -- so it creates
// its own and removes it again at the end.
let admin=await call('POST','/api/auth/login-otp',{identifier:'7440977777'});
admin=await call('POST','/api/auth/login',{identifier:'7440977777',otp:admin.body.devOtp});
const ac=admin.cookie;
const preExisting=((await call('GET','/api/admin/group-rules',null,ac)).body.rules||[])
  .some((x)=>x.category_key==='faculty_mo');
if(!preExisting){
  const mk=await call('POST','/api/admin/group-rules',
    {categoryKey:'faculty_mo',minSize:2,discountType:'PERCENT',discountValue:10},ac);
  check('fixture: group-discount rule created for faculty_mo', mk.body.success===true, mk.body.error);
}

let r=await call('POST','/api/auth/login-password',{identifier:P(1),password:'testpass123'});
const lc=r.cookie;
r=await call('POST','/api/groups',{categoryKey:'faculty_mo',name:'Email Test Group'},lc);
check('group created', r.body.success===true, r.body.error);
const gid=(await call('GET','/api/groups/me',null,lc)).body.group.id;

console.log('\n== Add a member BY EMAIL ==');
r=await call('POST',`/api/groups/${gid}/members`,{identifier:E('member-by-email')},lc);
check('added by email', r.body.success===true, r.body.error);
let me=await call('GET','/api/groups/me',null,lc);
check('member stored under their account key',
  me.body.group.members.some(m=>m.phone===emailOnlyKeyOf(emailMember)), me.body.group.members.map(m=>m.phone));
function emailOnlyKeyOf(u){ return u.phone_number; }

console.log('\n== Add a member BY MOBILE (regression) ==');
r=await call('POST',`/api/groups/${gid}/members`,{identifier:P(2)},lc);
check('added by mobile', r.body.success===true, r.body.error);
me=await call('GET','/api/groups/me',null,lc);
check('group now has 3 (leader + 2)', me.body.group.members.length===3, me.body.group.members.length);

console.log('\n== Legacy field name still accepted ==');
const extra = await mkPhoneUser(P(3));
r=await call('POST',`/api/groups/${gid}/members`,{phone:P(3)},lc);
check('old {phone:...} body still works', r.body.success===true, r.body.error);

console.log('\n== Errors ==');
r=await call('POST',`/api/groups/${gid}/members`,{identifier:'ghost@nowhere.example'},lc);
check('unknown email -> 404', r.status===404, [r.status,r.body.error]);
await new Promise((res,rej)=>{const s3=require('sqlite3').verbose(); const w=new s3.Database(process.argv[2]||'./conference.db');
  w.serialize(()=>{ w.run("INSERT INTO users (phone_number, phone, phone_verified, full_name, email, role, created_at) VALUES (?,?,1,'Amb A',?, 'DELEGATE', ?)",['ambg1_'+N,'+919'+N+'801',`ambg-${N}@example.com`,Date.now()]);
    w.run("INSERT INTO users (phone_number, phone, phone_verified, full_name, email, role, created_at) VALUES (?,?,1,'Amb B',?, 'DELEGATE', ?)",['ambg2_'+N,'+919'+N+'802',`ambg-${N}@example.com`,Date.now()],(e)=>{w.close(); e?rej(e):res();}); }); });
r=await call('POST',`/api/groups/${gid}/members`,{identifier:`ambg-${N}@example.com`},lc);
check('ambiguous email -> 409', r.status===409, [r.status,r.body.error]);
r=await call('POST',`/api/groups/${gid}/members`,{identifier:E('member-by-email')},lc);
check('already in a group -> 409', r.status===409, [r.status,r.body.error]);
r=await call('POST',`/api/groups/${gid}/members`,{identifier:'garbage!!'},lc);
check('garbage -> 400', r.status===400, [r.status,r.body.error]);
// Remove the fixture rule, unless the database already had one.
if(!preExisting){
  const rules=(await call('GET','/api/admin/group-rules',null,ac)).body.rules||[];
  const mine=rules.find((x)=>x.category_key==='faculty_mo');
  if(mine) await call('DELETE',`/api/admin/group-rules/${mine.id}`,null,ac);
}
report();
})();
