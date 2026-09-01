const { call, check, report, appFile } = require('./harness');
// The dashboard's first paint must never show a status that is about to be
// corrected. The markup ships a neutral chip; the server embeds the
// delegate's own registration so the correct status is there before any fetch.
fs=require('fs'), vm=require('vm'), sqlite3=require('sqlite3');
const db=new sqlite3.Database(process.argv[2]);
const get=(s,p=[])=>new Promise(r=>db.get(s,p,(e,x)=>r(x)));
const login=async(id)=>{let r=await call('POST','/api/auth/login-otp',{identifier:id});
  if(!r.body||!r.body.success) return null;
  r=await call('POST','/api/auth/login',{identifier:id,otp:r.body.devOtp});
  return r.body&&r.body.success?r.cookie:null;};
const bootOf=(html)=>{const m=html.match(/window\.__BOOTSTRAP_REG__ = ([\s\S]*?);\n/); return m?{raw:m[1],val:JSON.parse(m[1])}:null;};

(async()=>{
 console.log('\n== The markup never ships a real status ==');
 const anon=(await call('GET','/',null,null)).raw;
 check('the chip is neutral, not "Registration Pending"',
   /id="payment-status-tag"[^>]*slate[^>]*>\s*Checking/.test(anon) && !/id="payment-status-tag"[\s\S]{0,200}Registration Pending/.test(anon));
 check('the Register & Pay action starts hidden', /id="payment-action-area"[^>]*\bhidden\b/.test(anon));
 check('anonymous visitors get no embedded registration', !/window\.__BOOTSTRAP_REG__ =/.test(anon));

 console.log('\n== A logged-in delegate gets the real status in the HTML ==');
 const v=await get(`select phone_number,registration_number,bank_status from registrations where bank_status='BANK_VERIFIED' limit 1`);
 const c=await login(v.phone_number);
 const page=await call('GET','/',null,c);
 const boot=bootOf(page.raw);
 check('the registration is embedded', !!boot);
 check('with the real status', boot && boot.val.bank_status===v.bank_status, boot&&boot.val.bank_status);
 check('and the real registration number', boot && boot.val.registration_number===v.registration_number);
 check('carrying what the dashboard needs',
   boot && ['bank_status','registration_number','expected_amount','verified_total','remaining','pending_txn_count','selections']
     .every(k=>k in boot.val), boot && Object.keys(boot.val));
 check('personalised HTML is never shared-cacheable', page.headers['cache-control']==='private, no-store', page.headers['cache-control']);
 check('the payload cannot close the script tag early', boot && !boot.raw.includes('<'));

 console.log('\n== It matches what the fetch would return ==');
 const api=(await call('GET','/api/registrations/me',null,c)).body.registration;
 check('embedded copy equals the API copy', JSON.stringify(boot.val)===JSON.stringify(api));

 console.log('\n== Signed up but not registered ==');
 const u=await get(`select u.phone_number from users u where u.phone_number not like 'u_%'
                      and not exists(select 1 from registrations r where r.phone_number=u.phone_number) limit 1`);
 if (u) {
   const c2=await login(u.phone_number);
   if (c2) {
     const b2=bootOf((await call('GET','/',null,c2)).raw);
     check('embedded as null, not omitted', b2 && b2.val===null, b2&&b2.raw);
   } else check('(could not log in that user -- throttled)', true);
 } else check('(no such user in data)', true);

 console.log('\n== The client applies it before any network call ==');
 const js=fs.readFileSync(appFile('public','app.js'),'utf8');
 check('applyRegistrationState is its own function', /function applyRegistrationState\(reg\)/.test(js));
 check('loadDashboard delegates to it', /applyRegistrationState\(regData\.registration\)/.test(js));
 check('the bootstrap is applied at the very bottom of the file',
   js.lastIndexOf('applyRegistrationState(window.__BOOTSTRAP_REG__)') > js.length - 1200);
 check('guarded, so it can never abort the script', /try \{[\s\S]{0,400}applyRegistrationState\(window\.__BOOTSTRAP_REG__\)[\s\S]{0,300}catch/.test(js));

 // Run it for real: does the chip end up correct with NO fetch?
 const el=(id)=>({id, innerText:'', innerHTML:'', className:'', value:'', style:{}, dataset:{},
   classList:{c:new Set(),add(k){this.c.add(k)},remove(k){this.c.delete(k)},toggle(k,on){on===undefined?(this.c.has(k)?this.c.delete(k):this.c.add(k)):(on?this.c.add(k):this.c.delete(k))},contains(k){return this.c.has(k)}},
   addEventListener(){}, querySelector(){return null}, querySelectorAll(){return []}, setAttribute(){}, getAttribute(){return null}, focus(){}, click(){}, appendChild(){}});
 const els={};
 const doc={ getElementById:(id)=>els[id]||(els[id]=el(id)), querySelector:()=>el('q'), querySelectorAll:()=>[],
   addEventListener(){}, createElement:()=>el('c'), body:el('body'), documentElement:el('html'), readyState:'loading', cookie:'' };
 const sandbox={ document:doc, window:{ __BOOTSTRAP_REG__:boot.val, addEventListener(){}, location:{href:'',pathname:'/',search:''}, matchMedia:()=>({matches:false,addEventListener(){}}) },
   localStorage:{ getItem:()=>null, setItem(){}, removeItem(){} }, sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}},
   navigator:{userAgent:'node'}, fetch:()=>{ throw new Error('the first paint must not need the network'); },
   console:{log(){},warn(){},error(){},info(){}}, setTimeout, clearTimeout, setInterval, clearInterval, URL, Intl, Date, Math, JSON,
   requestAnimationFrame:(f)=>setTimeout(f,0) };
 sandbox.window.document=doc; sandbox.self=sandbox; sandbox.globalThis=sandbox;
 vm.createContext(sandbox);
 let threw=null; try { vm.runInContext(js, sandbox, {filename:'app.js'}); } catch(e){ threw=e; }
 check('app.js still evaluates cleanly with a bootstrap present', !threw, threw&&threw.message);
 const chip=els['payment-status-tag'];
 check('the chip reads Confirmed with no fetch having happened',
   chip && /Registration Confirmed/.test(chip.innerText), chip&&chip.innerText);
 check('it is styled as confirmed, not pending', chip && /emerald/.test(chip.className), chip&&chip.className);
 check('the Register & Pay action is hidden for a confirmed delegate',
   els['payment-action-area'] && els['payment-action-area'].classList.contains('hidden'));

 report();
db.close();
})();
