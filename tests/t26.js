const { call, check, report, adminLogin } = require('./harness');
;
(async()=>{
let r = { cookie: await adminLogin() };
const rec=await call('GET','/api/admin/bank-statement/reconcile',null,r.cookie);
const hers=(rec.body.matched||[]).filter(m=>m.registration_number==='FIXCON20991002');

console.log('\n== FIXCON20991002 in the statement view ==');
hers.forEach(m=>console.log(`   credit #${m.transaction.id} ${m.transaction.post_date} ₹${m.transaction.credit} -> her portion ₹${m.linkedAmount} | amountOk=${m.amountOk}`));
check('both her credits appear', hers.length===2, hers.length);
// By amount, not row id: the ids were whatever production happened to
// assign, which means nothing in a fixture.
const c518=hers.find(m=>Number(m.transaction.credit)===750);
const c2158=hers.find(m=>Number(m.transaction.credit)===1250);
check('₹750 credit shows ₹750 allocated to her (was ₹2,000)', c518 && Number(c518.linkedAmount)===750, c518&&c518.linkedAmount);
check('₹750 credit is no longer flagged as a mismatch', c518 && c518.amountOk===true, c518&&c518.amountOk);
check('₹1,250 credit shows ₹1,250', c2158 && Number(c2158.linkedAmount)===1250, c2158&&c2158.linkedAmount);
check('₹1,250 credit reconciles', c2158 && c2158.amountOk===true, c2158&&c2158.amountOk);
const total=hers.reduce((s,m)=>s+Number(m.linkedAmount),0);
check('her two portions sum to the ₹2,000 fee', total===2000, total);
check('neither renders as a partial "of" split', hers.every(m=>Number(m.linkedAmount)===Number(m.transaction.credit)), hers.map(m=>[m.linkedAmount,m.transaction.credit]));

console.log('\n== No credit is now misreported anywhere ==');
const bad=(rec.body.matched||[]).filter(m=>Number(m.linkedAmount)>Number(m.transaction.credit));
check('no delegate portion exceeds its credit', bad.length===0, bad.map(m=>[m.registration_number,m.linkedAmount,m.transaction.credit]));
const mism=(rec.body.matched||[]).filter(m=>!m.amountOk);
console.log(`   credits still flagged as mismatched: ${mism.length}`);
mism.forEach(m=>console.log(`     #${m.transaction.id} ₹${m.transaction.credit} vs ₹${m.linkedAmount} (${m.registration_number})`));
check('summary counts agree with the rows', rec.body.summary.amountMismatches===mism.length, [rec.body.summary.amountMismatches, mism.length]);
report();
})();
