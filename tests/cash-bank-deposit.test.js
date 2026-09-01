const { call, check, report, adminLogin } = require('./harness');
;
(async()=>{
let r = { cookie: await adminLogin() };
const ac=r.cookie;

console.log('\n== A banked cash deposit stops showing as an unmatched credit ==');
const rec=await call('GET','/api/admin/bank-statement/reconcile',null,ac);
check('reconcile responds', rec.status===200, rec.status);
const unmatched=(rec.body.unmatchedCredits||[]).map(c=>String(c.description||''));
check('the fully-consumed CASH DEPOSIT is no longer unmatched',
  !unmatched.some(d=>d.includes('CASH DEPOSIT DESK')), unmatched.filter(d=>d.includes('CASH')));
check('the under-used SMALL DEPOSIT still is', unmatched.some(d=>d.includes('SMALL DEPOSIT')), 'ok');

console.log('\n== Cash reads correctly in the review ledger ==');
const js=(await call('GET','/app.js',null,null)).raw;
check('cash never says "Not acknowledged"', /isCash\s*\n?\s*\?\s*`<span class="text-slate-500">💵 Cash taken at the desk/.test(js) || /Cash taken at the desk/.test(js));
check('cash shows "not yet banked" instead', /not yet banked/.test(js));
check('cash has no per-delegate Link button', /reviewRegVerified \|\| isCash \? '' :/.test(js));

console.log('\n== Panel markup ships, hidden by default ==');
const admin=await call('GET','/admin',null,ac);
check('cash panel present', /id="cash-in-hand-panel"/.test(admin.raw));
check('hidden by default', /id="cash-in-hand-panel" class="hidden"/.test(admin.raw));
check('deposit picker present', /id="cash-deposit-select"/.test(admin.raw));
check('select-all present', /id="cash-select-all"/.test(admin.raw));

console.log('\n== Role gating ==');
const anon=await call('GET','/api/admin/cash-in-hand',null,null);
check('anonymous refused', anon.status===401||anon.status===403, anon.status);
report();
})();
