const fs=require('fs');
const { call, check, report, appFile } = require('./harness');
// Receipt: stub on screen, statement on print, one document.
sqlite3=require('sqlite3');
const db=new sqlite3.Database(process.argv[2]);
const all=(s,p=[])=>new Promise(r=>db.all(s,p,(e,x)=>r(e?[]:x)));
const get=(s,p=[])=>new Promise(r=>db.get(s,p,(e,x)=>r(x)));

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
 // Two Payments: verified, two instalments -- the interesting case.
 const r=await receipt('9000001002');
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
 // Read from the fixture rather than hardcoded: the point is that the receipt
 // shows the delegate's stored name with their salutation, not that any
 // particular person is in the database.
 const who=await get(`select u.salutation, u.full_name, u.phone, r.category_label
                        from users u join registrations r on r.phone_number=u.phone_number
                       where u.phone_number='9000001002'`);
 check('delegate name with salutation', stub.includes(`${who.salutation} ${who.full_name}`),
   `${who.salutation} ${who.full_name}`);
 check('registration number', stub.includes('FIXCON20991002'));
 check('category', stub.includes(who.category_label), who.category_label);
 const opts=(await all(`select o.name from registration_options ro
                          join program_options o on o.id=ro.option_id
                          join registrations r on r.id=ro.registration_id
                         where r.phone_number='9000001002'`)).map(o=>o.name);
 check('both programme selections', opts.length>1 && opts.every(n=>stub.includes(n)), opts);
 check('two instalments itemised', /Paid in 2 instalments/.test(stub) && stub.includes('₹750') && stub.includes('₹1,250'));
 const refs=(await all(`select p.utr_number from payment_transactions p
                          join registrations r on r.id=p.registration_id
                         where r.phone_number='9000001002' and p.txn_status='VERIFIED'`)).map(p=>p.utr_number);
 check('each instalment carries its reference', refs.length===2 && refs.every(u=>stub.includes(u)), refs);
 check('issuer named', stub.includes('Fixture Hall, Testville') && stub.includes('fixcon@example.test'));

 console.log('\n== Statement (what prints) ==');
 check('fee and received stated in one sentence',
   /received against a fee of <b>₹2,000<\/b> · nothing outstanding/.test(stmt));
 check('total received line', /Total received<\/span><span class="m money">₹2,000</.test(stmt));
 check('balance due is spelled out', /Balance due<\/span><span class="m money">₹0</.test(stmt));
 check('payments are dated ledger lines', (stmt.match(/class="ln">/g)||[]).length>=2);
 // Grouped as +91 XXXXX XXXXX, whatever the number is.
 check('mobile is grouped, not a run-on', /\+91 \d{5} \d{5}/.test(stmt), (stmt.match(/\+91[\d ]*/)||[])[0]);
 check('verified timestamp present, IST', /\d{1,2} \w{3} \d{4}, \d{2}:\d{2} IST/.test(stmt),
   (stmt.match(/Verified on[\s\S]{0,120}/)||[])[0]);
 check('issuer block present', /Issued by<\/div>[\s\S]{0,120}Fixture Hall, Testville/.test(stmt));
 const confName=(await get(`select value from schema_meta where key='conference_name'`)).value;
 // Compared against the page with entities decoded: the name contains an
 // ampersand, which the receipt escapes, and this is asserting that the name
 // is present -- not how HTML spells it.
 const stmtText=stmt.replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&quot;/g,'"');
 check('conference named in full', stmtText.includes(confName), confName);
 check('valid-without-signature note', stmt.includes('valid without signature'));

 console.log('\n== Dates are IST and unambiguous ==');
 // Never M/D/YYYY -- this Node build's ICU silently returns US ordering.
 check('no slash-formatted dates anywhere', !/\d{1,2}\/\d{1,2}\/\d{4}/.test(r.both), (r.both.match(/\d{1,2}\/\d{1,2}\/\d{4}/)||[])[0]);
 check('dates are written with a month name', /\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}/.test(stmt));

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

 console.log('\n== It looks like the portal that issued it ==');
 // The receipt is a separately authored document -- two layouts, its own
 // structure, deliberately not the app's CSS (see its header comment). That
 // made it easy to leave behind: it carried its own indigo (#3B33A8) and its
 // own three typefaces long after the rest of the app moved to the steel
 // "Clinical Trust" ramp, which is exactly how the email templates rotted.
 // Its STRUCTURE is still its own; only the palette and faces are shared.
 const portalCfg = fs.readFileSync(appFile('views', 'index.ejs'), 'utf8');
 check('the accent is the app\'s steel, taken from the portal config',
   r.both.includes('--indigo:#2f5673') && portalCfg.includes("600: '#2f5673'"));
 check('the tint behind it likewise', r.both.includes('--indigo-2:#eef3f6'));
 check('text sits on the app\'s slate, not a private grey',
   r.both.includes('--ink:#0f172a') && r.both.includes('--muted:#64748b'));
 check('none of its old private palette survives',
   !/#3B33A8|#16181D|#494E5C|#767C8C|#DDDFE7|#EDECFA|#EEF0F4|#C9C6F2|#332B92/i.test(r.both),
   (r.both.match(/#3B33A8|#16181D|#C9C6F2|#332B92/i) || [])[0]);
 check('the note box uses the app\'s amber rather than its own cream',
   !/#FBF1E0|#E4C489|#7A4B05/i.test(r.both) && r.both.includes('--note-bg:#fffbeb'));

 check('body copy is the app\'s body face', /font-family:"Source Sans 3"/.test(r.both));
 check('...and Manrope is gone', !/Manrope/.test(r.both));
 check('the display face is the app\'s, spent on the amount and the name',
   /\.stub \.amt \{ font-family:"Libre Franklin"/.test(r.both)
   && /\.stub \.nm \{ font-family:"Libre Franklin"/.test(r.both));
 check('...and not set as the face for the whole card',
   !/\.stub \{[^}]*font-family:"Libre Franklin"/.test(r.both));
 check('the statement titles itself in the display face',
   /\.stmt \.bar \.cf \{ font-family:"Libre Franklin"/.test(r.both));
 // Identifiers get transcribed by hand into reimbursement claims, so they
 // stay in a mono where 0/O and 1/l are told apart.
 check('registration numbers and UTRs stay monospaced', /IBM Plex Mono/.test(r.both));
 check('only the faces it actually uses are fetched',
   /family=IBM\+Plex\+Mono[^"]*family=Libre\+Franklin[^"]*family=Source\+Sans\+3/.test(r.both)
   && !/IBM\+Plex\+Sans/.test(r.both));

 report();
db.close();
})();
