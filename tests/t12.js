const { call, check, report } = require('./harness');
;
(async()=>{
let r=await call('POST','/api/auth/login-otp',{identifier:'7440977777'});
r=await call('POST','/api/auth/login',{identifier:'7440977777',otp:r.body.devOtp});
const ac=r.cookie;
const admin=await call('GET','/admin',null,ac);
const js=await call('GET','/app.js',null,ac);
console.log('\n== Marks no longer rely on emoji colour ==');
check('accountMarks shipped', /function accountMarks/.test(js.raw));
const fn=js.raw.slice(js.raw.indexOf('function accountMarks'), js.raw.indexOf('function accountMarks')+1400);
check('no emoji in the marks', !/[\u{1F300}-\u{1FAFF}]/u.test(fn), (fn.match(/[\u{1F300}-\u{1FAFF}]/u)||[])[0]);
check('ON state has a filled background', /bg-emerald-500/.test(fn));
check('off state is hollow', /bg-white border-slate-200/.test(fn));
check('states differ by more than colour (border too)', /border-emerald-500/.test(fn) && /border-slate-200/.test(fn));
check('header carries the M/E/P legend', /\(M\/E\/P\)/.test(admin.raw));
check('header tooltip explains filled vs hollow', /Filled green means yes/.test(admin.raw));
report();
})();
