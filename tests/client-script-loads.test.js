const { check, report, appFile } = require('./harness');
// app.js must finish evaluating for a RETURNING delegate (one with a cached
// user in localStorage). Top-level code runs during evaluation, so a single
// temporal-dead-zone reference in it aborts the rest of the file: every
// const below stays uninitialised and the portal renders as raw HTML.
const fs=require('fs'), vm=require('vm'), path=require('path');
const src=fs.readFileSync(appFile('public','app.js'),'utf8');

// Minimal DOM/browser stubs -- enough for top-level evaluation only.
function makeSandbox(storedUser, {withDashboard=true}={}) {
  const el=()=>({ innerText:'', innerHTML:'', value:'', className:'', style:{}, dataset:{},
    classList:{add(){},remove(){},toggle(){},contains(){return false}},
    addEventListener(){}, removeEventListener(){}, appendChild(){}, querySelector(){return null},
    querySelectorAll(){return []}, setAttribute(){}, getAttribute(){return null}, focus(){}, click(){} });
  const store={};
  if (storedUser) store['nqocn_current_user']=JSON.stringify(storedUser);
  const doc={
    getElementById:(id)=> (id==='dashboard-page' && !withDashboard) ? null : el(),
    querySelector:()=>el(), querySelectorAll:()=>[], addEventListener(){}, removeEventListener(){},
    createElement:()=>el(), body:el(), documentElement:el(), readyState:'loading', cookie:'',
  };
  const sandbox={
    document:doc,
    window:{ addEventListener(){}, location:{ href:'', pathname:'/', search:'' }, matchMedia:()=>({matches:false,addEventListener(){}}) },
    localStorage:{ getItem:(k)=>k in store?store[k]:null, setItem:(k,v)=>{store[k]=String(v)}, removeItem:(k)=>{delete store[k]} },
    sessionStorage:{ getItem:()=>null, setItem(){}, removeItem(){} },
    navigator:{ userAgent:'node', clipboard:{ writeText:()=>Promise.resolve() } },
    fetch:()=>new Promise(()=>{}), console:{log(){},warn(){},error(){},info(){}},
    setTimeout, clearTimeout, setInterval, clearInterval, URL, Intl, Date, Math, JSON,
    requestAnimationFrame:(f)=>setTimeout(f,0),
  };
  sandbox.window.document=doc; sandbox.self=sandbox; sandbox.globalThis=sandbox;
  return sandbox;
}

// Constants declared at intervals down the file. If evaluation aborts part
// way, the ones after the abort point never initialise.
const LATE=['DEFAULT_PHONE_CC','E164_RE','INDIAN_E164_RE','isPhoneValue','EMAIL_RE',
            'SIGNUP_COUNTRIES','PAYMENT_MODE_LABELS','BANK_STATUS_LABELS','ROLE_LABELS'];
const probe=`(${JSON.stringify(LATE)}).map(function(n){ try { return [n, typeof eval(n)]; } catch(e){ return [n,'THROWS:'+e.message]; } })`;

function evaluate(storedUser, opts) {
  const sandbox=makeSandbox(storedUser, opts);
  vm.createContext(sandbox);
  let evalError=null;
  try { vm.runInContext(src, sandbox, {filename:'app.js'}); }
  catch (e) { evalError=e; }
  let probed=[];
  try { probed=vm.runInContext(probe, sandbox); } catch(e) { probed=[['<probe failed>', e.message]]; }
  return {evalError, probed, sandbox};
}

const delegate={ full_name:'Ms Two Payments', name:'Two Payments', salutation:'Ms',
  designation:'Assistant Professor', institution:'MGIMS', phone:'+919000001002',
  phone_number:'9000001002', email:'p@example.com', role:'DELEGATE' };

console.log('\n== A returning delegate (cached session) ==');
{
 const {evalError, probed}=evaluate(delegate);
 check('app.js evaluates without throwing', !evalError, evalError && evalError.message);
 const bad=probed.filter(([,t])=>t==='undefined'||String(t).startsWith('THROWS'));
 check('every top-level constant is initialised', bad.length===0, JSON.stringify(bad));
 probed.forEach(([n,t])=>{ if(t==='undefined'||String(t).startsWith('THROWS')) console.log('      ',n,'->',t); });
}

console.log('\n== An email-only delegate (no phone at all) ==');
{
 const {evalError, probed}=evaluate({...delegate, phone:null, phone_number:'u_0123456789abcdef01'});
 check('evaluates without throwing', !evalError, evalError && evalError.message);
 check('all constants initialised', probed.every(([,t])=>t!=='undefined'&&!String(t).startsWith('THROWS')),
   JSON.stringify(probed.filter(([,t])=>t==='undefined'||String(t).startsWith('THROWS'))));
}

console.log('\n== A first-time visitor (nothing cached) ==');
{
 const {evalError, probed}=evaluate(null);
 check('evaluates without throwing', !evalError, evalError && evalError.message);
 check('all constants initialised', probed.every(([,t])=>t!=='undefined'&&!String(t).startsWith('THROWS')));
}

console.log('\n== The admin page (no #dashboard-page, so no early paint) ==');
{
 const {evalError, probed}=evaluate(delegate, {withDashboard:false});
 check('evaluates without throwing', !evalError, evalError && evalError.message);
 check('all constants initialised', probed.every(([,t])=>t!=='undefined'&&!String(t).startsWith('THROWS')));
}

console.log('\n== The early paint cannot take the file down again ==');
{
 const guarded=/try \{\s*if \(currentDelegate && document\.getElementById\('dashboard-page'\)\)/.test(src);
 check('the optimistic paint is wrapped in try/catch', guarded);
 const iPhone=src.indexOf("const DEFAULT_PHONE_CC"), iPaint=src.indexOf("if (currentDelegate && document.getElementById('dashboard-page'))");
 check('and sits after the phone helpers it depends on', iPhone>-1 && iPaint>iPhone, `${iPhone} vs ${iPaint}`);
 const iIsPhone=src.indexOf('const isPhoneValue');
 check('after isPhoneValue too', iPaint>iIsPhone, `${iIsPhone} vs ${iPaint}`);
}

report();
