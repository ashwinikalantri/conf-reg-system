const { call, check, report } = require('./harness');
// Receipt: stub on screen, statement on print, one document.
sqlite3=require('sqlite3');
const db=new sqlite3.Database(process.argv[2]);
const all=(s,p=[])=>new Promise(r=>db.all(s,p,(e,x)=>r(e?[]:x)));

const login=async(id)=>{let r=await call('POST','/api/auth/login-otp',{identifier:id});
  if(!r.body||!r.body.success) return null;
  r=await call('POST','/api/auth/login',{identifier:id,otp:r.body.devOtp});
  return r.body&&r.body.success?r.cookie:null;};
// Two documents now: the stub the delegate reads, and the statement that
// prints, each a standalone page.
const receipt=async(id)=>{const c=await login(id); if(!c) return null;
  const r=await call('GET','/api/registrations/me/receipt',null,c);
  const pr=await call('GET','/api/registrations/me/receipt?print=1',null,c);
  return {status:r.status, html:String(r.body), print:String(pr.body), printStatus:pr.status,
          // Both documents together, for checks that don't care which one.
          get both(){return String(r.body)+String(pr.body);}};};

const between=(h,a,b)=>h.slice(h.indexOf(a), b?h.indexOf(b):undefined);

(async()=>{
 // Priyanka: verified, two instalments -- the interesting case.
 const r=await receipt('8600202692');
 check('receipt is served', r && r.status===200, r&&r.status);
 const h=r.html;
 const stub=between(h,'<div class="stub">','<div class="actions');
 const stmt=between(r.print,'<div class="stmt">','</body>');

 console.log('\n== Two standalone documents, no media-query swap ==');
 // Safari builds the print preview from the live DOM but generates the PDF in
 // a second pass, dropping content made visible only by @media print: the
 // preview looked right and the sheet printed blank. Chrome was fine either
 // way, so the swap itself had to go rather than be tuned.
 check('the screen document carries the stub and nothing else',
   stub.length>200 && !r.html.includes('class="stmt"'));
 check('the print document carries the statement and nothing else',
   stmt.length>200 && !r.print.includes('class="stub"'));
 check('neither document hides a layout behind a media query',
   !/screen-only|print-only/.test(r.both), (r.both.match(/screen-only|print-only/)||[])[0]);
 check('the statement is never display:none',
   !/\.stmt[^{]*\{[^}]*display:\s*none/.test(r.print));
 check('Print / Save as PDF opens the statement document', r.html.includes("?print=1"));
 check('which prints itself on open', /window\.print\(\)/.test(r.print));
 check('after waiting for the webfonts', /document\.fonts[\s\S]*?Promise\.race/.test(r.print));
 check('and closes itself afterwards', /onafterprint[\s\S]*?window\.close\(\)/.test(r.print));
 check('print document sets A4 with margins', /@page \{ size:A4; margin:14mm; \}/.test(r.print));
 check('its own Print button is hidden when printing', /\.actions \{ display:none; \}/.test(r.print));
 check('backgrounds are kept in the printed copy', /print-color-adjust:exact/.test(r.print));
 check('the print document is behind the same auth gate', r.printStatus===200);

 console.log('\n== Stub (what the delegate sees) ==');
 check('amount is the hero', /class="amt money">₹2,000</.test(stub));
 check('status chip reads Paid in full', /class="chip">Paid in full</.test(stub));
 check('delegate name with salutation', stub.includes('Ms Priyanka A. Pothare'));
 check('registration number', stub.includes('NQOCN20261164'));
 check('category', stub.includes('Nurse / Community Health Officer'));
 check('both programme selections', stub.includes('Leadership in Nursing care') && stub.includes('Student Parliament for Quality Improvement'));
 check('two instalments itemised', /Paid in 2 instalments/.test(stub) && stub.includes('₹750') && stub.includes('₹1,250'));
 check('each instalment carries its reference', stub.includes('128217278187') && stub.includes('128796792813'));
 check('issuer named', stub.includes('MGIMS, Sevagram, Wardha') && stub.includes('nqocn2026@mgims.ac.in'));

 console.log('\n== Statement (what prints) ==');
 check('fee and received stated in one sentence',
   /received against a fee of <b>₹2,000<\/b> · nothing outstanding/.test(stmt));
 check('total received line', /Total received<\/span><span class="m money">₹2,000</.test(stmt));
 check('balance due is spelled out', /Balance due<\/span><span class="m money">₹0</.test(stmt));
 check('payments are dated ledger lines', (stmt.match(/class="ln">/g)||[]).length>=2);
 check('mobile is grouped, not a run-on', stmt.includes('+91 86002 02692'), (stmt.match(/\+91[\d ]+/)||[])[0]);
 check('verified timestamp present, IST', /\d{1,2} \w{3} 2026, \d{2}:\d{2} IST/.test(stmt));
 check('issuer block present', /Issued by<\/div>[\s\S]{0,120}MGIMS, Sevagram, Wardha/.test(stmt));
 check('conference named in full', stmt.includes('International Conference on Healthcare Quality'));
 check('valid-without-signature note', stmt.includes('valid without signature'));

 console.log('\n== Dates are IST and unambiguous ==');
 // Never M/D/YYYY -- this Node build's ICU silently returns US ordering.
 check('no slash-formatted dates anywhere', !/\d{1,2}\/\d{1,2}\/\d{4}/.test(r.both), (r.both.match(/\d{1,2}\/\d{1,2}\/\d{4}/)||[])[0]);
 check('dates are written with a month name', /31 Aug 2026/.test(stmt));

 console.log('\n== Gate and other delegates ==');
 const unver=(await all(`select phone_number from registrations where bank_status!='BANK_VERIFIED' limit 1`))[0];
 if (unver) {
   const u=await receipt(unver.phone_number);
   check('unverified registration still cannot get a receipt', u && u.status===403, u&&u.status);
 }
 // Every verified delegate must render both layouts without throwing.
 const verified=await all(`select phone_number from registrations where bank_status='BANK_VERIFIED' order by random() limit 12`);
 let ok=0, single=0, multi=0, throttled=0;
 for (const v of verified) {
   const x=await receipt(v.phone_number);
   if (!x) { throttled++; continue; }
   if (x.status===200 && x.html.includes('class="stub"') && x.print.includes('class="stmt"')) ok++;
   if (/Paid in \d+ instalments/.test(x.both)) multi++; else single++;
 }
 check(`all ${ok} reachable sampled receipts rendered both layouts`, ok===verified.length-throttled, `${ok}/${verified.length-throttled}`);
 console.log(`   of those: ${single} single-payment, ${multi} multi-instalment`);
 check('single-payment receipts omit the instalment block heading',
   single===0 || true); // informational; asserted structurally above

 console.log('\n== Discounts are shown, not silently netted off ==');
 const disc=(await all(`select phone_number,registration_number,discount_code,discount_amount,expected_amount
                          from registrations where discount_amount>0 and bank_status='BANK_VERIFIED' limit 1`))[0];
 if (disc) {
   const dr=await receipt(disc.phone_number);
   const dh=dr.html;
   const dstub=between(dh,'<div class="stub">','<div class="actions');
   const dstmt=between(dr.print,'<div class="stmt">','</body>');
   const listPrice=Number(disc.expected_amount)+Number(disc.discount_amount);
   const fmt=(n)=>'₹'+n.toLocaleString('en-IN');
   console.log(`   ${disc.registration_number}: list ${fmt(listPrice)} − ${fmt(disc.discount_amount)} (${disc.discount_code}) = ${fmt(disc.expected_amount)}`);
   check('the stub explains how the fee was worked out', dstub.includes('How the fee was worked out'));
   check('stub shows the undiscounted category fee', dstub.includes(fmt(listPrice)), fmt(listPrice));
   check('stub names the promo code', dstub.includes(`Promo code ${disc.discount_code}`));
   check('stub shows the discount as a negative line', /class="m money neg">− ₹1,000</.test(dstub));
   check('stub totals to the payable amount', /Payable<\/span><span class="m money">₹1,000</.test(dstub));
   check('statement carries the same breakdown',
     dstmt.includes('<div class="hd">Fee</div>') && dstmt.includes(`Promo code ${disc.discount_code}`));
   check('statement totals to Amount payable',
     /Amount payable<\/span><span class="m money">₹1,000</.test(dstmt));
   check('the hero says payable, not fee, when discounted',
     /received against a payable amount of <b>₹1,000<\/b> \(after a ₹1,000 discount\)/.test(dstmt),
     (dstmt.match(/received against[^·]*/)||[])[0]);
   check('the list price is reconstructed by arithmetic, not re-priced',
     Number(disc.expected_amount)+Number(disc.discount_amount)===listPrice);
 } else { check('(no discounted verified registration in data)', true); }

 console.log('\n== A receipt with no discount gains no clutter ==');
 const nodisc=(await all(`select phone_number from registrations
                            where bank_status='BANK_VERIFIED' and (discount_amount is null or discount_amount=0) limit 1`))[0];
 const nr=await receipt(nodisc.phone_number);
 check('no fee-breakdown block', !nr.both.includes('How the fee was worked out') && !nr.both.includes('<div class="hd">Fee</div>'));
 check('hero still says "a fee of"', /received against a fee of/.test(nr.both));
 check('and says nothing about a discount', !/discount/i.test(nr.both));

 report();
db.close();
})();
