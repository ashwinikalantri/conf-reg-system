const { call, check, report, appFile } = require('./harness');
// Ledger rows identify a payment by the bank statement's own description of
// the credit, not by the UTR the delegate typed in.
fs=require('fs');

const js=fs.readFileSync(appFile('public','app.js'),'utf8');
const grab=(n)=>{const i=js.indexOf('function '+n+'('); const j=js.indexOf('\n}', i); return js.slice(i, j+2);};
const row=new Function(`
  ${grab('esc')} ${grab('inr')} ${grab('fmtAuditTime')}
  let reviewRegVerified=false;
  ${grab('reviewTxnRowHtml')}
  return reviewTxnRowHtml;`)();

(async()=>{
 console.log('\n== The row identifies the payment by the statement line ==');
 const linked=row({id:1,amount:2000,verified_amount:750,txn_status:'VERIFIED',payment_mode:'UPI',
   utr_number:'128217278187',bank_txn_id:518,bank_txn_date:'2026-08-20',bank_txn_credit:750,
   bank_txn_description:'UPI/RRN 128217278187/UPI_PRIYANKA ANVIKAR POTHARE',submitted_at:Date.now(),has_screenshot:1});
 check('the statement description is shown', linked.includes('UPI_PRIYANKA ANVIKAR POTHARE'));
 check('the delegate-typed UTR is not shown on its own',
   !/>\s*128217278187\s*</.test(linked), (linked.match(/>[^<]*128217278187[^<]*</)||[''])[0]);
 check('the description sits where the UTR used to, at the head of the row',
   linked.indexOf('UPI_PRIYANKA') < linked.indexOf('₹750'));
 check('long descriptions truncate rather than shove the amount off',
   /truncate/.test(linked) && /min-w-0/.test(linked));
 check('the full text is available on hover', /title="UPI\/RRN 128217278187/.test(linked));
 check('amount and status stay put', linked.includes('₹750') && linked.includes('VERIFIED'));
 check('the link line still shows the credit', linked.includes('🔗'));

 console.log('\n== Nothing linked yet -> no statement line to show ==');
 const unlinked=row({id:2,amount:1250,verified_amount:null,txn_status:'PENDING',payment_mode:'UPI',
   utr_number:'999888777666',bank_txn_id:null,bank_txn_description:null,submitted_at:Date.now(),has_screenshot:0});
 check('says so plainly', unlinked.includes('Not yet in the statement'));
 check('does not fall back to the delegate UTR', !unlinked.includes('999888777666'));
 check('still offers Link & acknowledge', unlinked.includes('Link &amp; acknowledge'));

 console.log('\n== Cash taken at the desk ==');
 const cash=row({id:3,amount:500,verified_amount:500,txn_status:'VERIFIED',payment_mode:'CASH',
   utr_number:null,bank_txn_id:null,bank_txn_description:null,submitted_at:Date.now(),has_screenshot:0});
 check('no em-dash placeholder where the UTR was', !/>—</.test(cash));
 check('shows the not-yet-banked state', cash.includes('not yet banked'));

 console.log('\n== The server actually sends the description ==');
 let r=await call('POST','/api/auth/login-otp',{identifier:'7440977777'});
 r=await call('POST','/api/auth/login',{identifier:'7440977777',otp:r.body.devOtp});
 const regs=(await call('GET','/api/registrations',null,r.cookie)).body;
 const list=Array.isArray(regs)?regs:(regs.registrations||regs.payments||[]);
 const withTxns=list.filter(x=>(x.transactions||[]).some(t=>t.bank_txn_id!=null));
 check('registrations with linked payments exist in the live copy', withTxns.length>0, `${list.length} regs`);
 const linkedTxns=withTxns.flatMap(x=>x.transactions).filter(t=>t.bank_txn_id!=null);
 check('every linked payment carries bank_txn_description',
   linkedTxns.every(t=>t.bank_txn_description), `${linkedTxns.filter(t=>!t.bank_txn_description).length} missing of ${linkedTxns.length}`);
 const pri=list.find(x=>x.registration_number==='NQOCN20261164');
 if (pri) {
   const descs=(pri.transactions||[]).map(t=>t.bank_txn_description);
   console.log('   NQOCN20261164 rows now read:', JSON.stringify(descs));
   check('her two rows are told apart by their statement lines',
     descs.length===2 && descs[0]!==descs[1] && descs.every(Boolean));
 }
 report();
})();
