const { call, check, report, appFile, adminLogin } = require('./harness');
// Ledger rows identify a payment by the bank statement's own description of
// the credit, not by the UTR the delegate typed in.
fs=require('fs');

const js=fs.readFileSync(appFile('public','app.js'),'utf8');
const grab=(n)=>{const i=js.indexOf('function '+n+'('); const j=js.indexOf('\n}', i); return js.slice(i, j+2);};
const grabConst=(n)=>{const i=js.indexOf('const '+n+' = {'); const j=js.indexOf('\n};', i); return js.slice(i, j+3);};
const row=new Function(`
  ${grab('esc')} ${grab('inr')} ${grab('fmtAuditTime')}
  ${grabConst('ADMIN_ICON_SVG')}
  ${grab('ICON')}
  let reviewRegVerified=false; let reviewStepOffset=0;
  const PAYMENT_MODE_LABELS = { UPI: 'UPI', NEFT_RTGS: 'NEFT/RTGS', CASH: 'Cash' };
  ${grab('reviewCheckMark')}
  ${grab('reviewTxnRowHtml')}
  return reviewTxnRowHtml;`)();

(async()=>{
 console.log("\n== The card: the delegate's claim beside the bank's line ==");
 const linked=row({id:1,amount:2000,verified_amount:750,txn_status:'VERIFIED',payment_mode:'UPI',
   utr_number:'128217278187',bank_txn_id:518,bank_txn_date:'2026-08-20',bank_txn_credit:750,
   bank_txn_description:'UPI/RRN 128217278187/UPI_PRIYANKA ANVIKAR POTHARE',submitted_at:Date.now(),has_screenshot:1});
 const saysCol=linked.slice(linked.indexOf('The delegate says'), linked.indexOf('The bank shows'));
 const bankCol=linked.slice(linked.indexOf('The bank shows'));
 check('the bank\'s own statement line is in the bank column', bankCol.includes('UPI_PRIYANKA ANVIKAR POTHARE'));
 check('the delegate-typed UTR is shown only as their claim, never as the bank\'s record', saysCol.includes('128217278187') && !/>\s*128217278187\s*</.test(bankCol));
 check('long descriptions truncate, the full text on hover', /truncate/.test(bankCol) && /title="UPI\/RRN 128217278187/.test(bankCol));
 check('the credit that arrived, and the step done', bankCol.includes('₹750') && /Done</.test(linked));
 check('the link line still carries its icon', linked.includes('<svg'));

 console.log('\n== Nothing linked yet ==');
 const unlinked=row({id:2,amount:1250,verified_amount:null,txn_status:'PENDING',payment_mode:'UPI',
   utr_number:'999888777666',bank_txn_id:null,bank_txn_description:null,submitted_at:Date.now(),has_screenshot:0});
 check('the bank column says so, and asks for the credit', /Not linked yet\. Pick the credit:/.test(unlinked) && /id="txn-candidates-2"/.test(unlinked));
 check('...the step is still to do', /To do</.test(unlinked));

 console.log('\n== Cash taken at the desk ==');
 const cash=row({id:3,amount:500,verified_amount:500,txn_status:'VERIFIED',payment_mode:'CASH',
   utr_number:null,bank_txn_id:null,bank_txn_description:null,submitted_at:Date.now(),has_screenshot:0,collected_by:'Desk A'});
 check('no em-dash placeholder where the UTR was', !/>—</.test(cash));
 check('says who took it, and that it is not yet banked', /₹500 in cash, taken by Desk A/.test(cash) && /Not yet banked/.test(cash));

 console.log('\n== The likely credits, best match first ==');
 const rank=new Function(`${grab('rankTxnCandidates')} return rankTxnCandidates;`)();
 const credits=[
   {id:1,remaining:1500,credit:1500,description:'UPI/RRN 555000111222/SOMEONE ELSE'},
   {id:2,remaining:1490,credit:1490,description:'UPI/RRN 999888777666/THE DELEGATE'},
   {id:3,remaining:1500,credit:1500,description:'NEFT XYZ 123'},
 ];
 const ranked=rank({amount:1500,utr_number:'999888777666'}, credits);
 check('their transaction ID in the bank\'s description comes first, even a few rupees off', ranked[0].id===2 && ranked[0].ref===true && ranked[0].amount===false);
 check('then the exact amounts, in the server\'s order', ranked[1].id===1 && ranked[2].id===3);
 const noRef=rank({amount:1500,utr_number:''}, credits);
 check('no transaction ID: exact amounts first, server order kept', noRef.map(c=>c.id).join()==='1,3,2');

 console.log('\n== The server actually sends the description ==');
 let r = { cookie: await adminLogin() };
 const regs=(await call('GET','/api/registrations',null,r.cookie)).body;
 const list=Array.isArray(regs)?regs:(regs.registrations||regs.payments||[]);
 const withTxns=list.filter(x=>(x.transactions||[]).some(t=>t.bank_txn_id!=null));
 check('registrations with linked payments exist in the live copy', withTxns.length>0, `${list.length} regs`);
 const linkedTxns=withTxns.flatMap(x=>x.transactions).filter(t=>t.bank_txn_id!=null);
 check('every linked payment carries bank_txn_description',
   linkedTxns.every(t=>t.bank_txn_description), `${linkedTxns.filter(t=>!t.bank_txn_description).length} missing of ${linkedTxns.length}`);
 const pri=list.find(x=>x.registration_number==='FIXCON20991002');
 if (pri) {
   const descs=(pri.transactions||[]).map(t=>t.bank_txn_description);
   console.log('   FIXCON20991002 rows now read:', JSON.stringify(descs));
   check('her two rows are told apart by their statement lines',
     descs.length===2 && descs[0]!==descs[1] && descs.every(Boolean));
 }
 report();
})();
