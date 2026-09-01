const { call, check, report, appFile, adminLogin } = require('./harness');
// Review modal restructure: flagged badge in the header, check marks in
// front of the fields they judge, two top-level sections.
fs=require('fs');
(async()=>{
 let r = { cookie: await adminLogin() };
 const h=(await call('GET','/admin',null,r.cookie)).body;
 const js=fs.readFileSync(appFile('public','app.js'),'utf8');

 console.log('\n== 1. Flagged badge ==');
 const iTitle=h.indexOf('id="review-title"'), iBadge=h.indexOf('id="review-flagged-note"'),
       iPane=h.indexOf('id="review-img-switcher"'), iCorr=h.indexOf('id="review-corrections"');
 check('flagged badge exists', iBadge>-1);
 check('it sits in the header, beside the title', iTitle>-1 && iTitle<iBadge && iBadge<iPane, `${iTitle}/${iBadge}/${iPane}`);
 check('it is no longer down in the body', !(iBadge>iCorr));
 const badgeTxt=h.slice(iBadge, h.indexOf('</div>',iBadge));
 check('the trailing explanation is gone', !/automated checks did not pass/.test(badgeTxt), badgeTxt.slice(-90));
 check('it still reads "Flagged for manual scrutiny"', /Flagged for manual scrutiny/.test(badgeTxt));
 check('it stays clear of the close button', /mr-7/.test(badgeTxt));
 check('it is hidden until the record is flagged', /id="review-flagged-note"[^>]*class="[^"]*\bhidden\b/.test(h));

 console.log('\n== 2. Check marks replace the pill row ==');
 check('the Automated Checks pill row is gone', h.indexOf('id="review-checks"')===-1 && !/Automated Checks<\/p>/.test(h));
 for (const f of ['amount','utr','mode']) check(`a mark sits in front of ${f}`, h.includes(`id="review-${f}-check"`));
 check('the mark precedes the value in the DOM', h.indexOf('id="review-amount-check"') < h.indexOf('id="review-amount"'));
 check('Date Submitted has no mark (nothing checks it)', !h.includes('id="review-date-check"'));
 // Behaviour of the mark itself.
 const mark=new Function(`${js.match(/function esc\([\s\S]*?\n}/)[0]}\n${js.match(/function reviewCheckMark\([\s\S]*?\n}/)[0]}\nreturn reviewCheckMark;`)();
 check('match -> tick', mark(1,'x').includes('✓') && mark(1,'x').includes('emerald'));
 check('mismatch -> cross', mark(0,'x').includes('✗') && mark(0,'x').includes('rose'));
 check('never checked -> dash, not a cross', mark(null,'x').includes('–') && !mark(null,'x').includes('✗'));
 check('glyphs differ, so colour is not the only signal', new Set([mark(1,'x'),mark(0,'x'),mark(null,'x')].map(v=>v.match(/>([^<]+)</)[1])).size===3);
 check('each mark carries a tooltip', ['✓','✗','–'].every((_,i)=>mark([1,0,null][i],'The amount').includes('title="The amount')));
 // Evaluate the real line from app.js rather than pattern-match it, so this
 // asserts the behaviour and not the spelling.
 const modeLine=js.split('\n').find(l=>l.includes("setHTML('review-mode-check'"));
 const modeMark=new Function('p','setHTML','reviewCheckMark', modeLine);
 const run=(mode)=>{let out;modeMark({payment_mode:mode,ocr_vpa_match:0},(id,v)=>{out=v},mark);return out;};
 check('NEFT/RTGS gets no Mode mark at all', run('NEFT_RTGS')==='', JSON.stringify(run('NEFT_RTGS')));
 check('UPI still gets its Mode mark', run('UPI').includes('✗'), JSON.stringify(run('UPI')));

 console.log('\n== 3. Two main sections ==');
 const secs=[...h.matchAll(/<h4 class="text-xs font-extrabold[^"]*">([^<]+)<\/h4>/g)].map(m=>m[1]);
 check('exactly two section headings', secs.length===2, JSON.stringify(secs));
 check('ID Verification comes first, Payment Verification second',
   secs[0]==='ID Verification' && secs[1]==='Payment Verification', JSON.stringify(secs));
 const iP=h.indexOf('>Payment Verification<'), iI=h.indexOf('>ID Verification<');
 check('the money detail lives under Payment Verification', iP < h.indexOf('id="review-txn-ledger"'));

 console.log('\n== 4. The "Before you can verify" box sits above both sections ==');
 const iStrip=h.indexOf('id="review-status-strip"');
 check('the strip is above ID Verification', iStrip>-1 && iStrip < iI, `${iStrip} vs ${iI}`);
 check('and therefore above Payment Verification too', iStrip < iP);
 check('but still below the delegate name', h.indexOf('id="review-name"') < iStrip);
 check('its gate list moved with it', h.indexOf('id="review-gate-list"') > iStrip && h.indexOf('id="review-gate-list"') < iI);
 check('fee/paid/balance moved with it too',
   [ 'review-strip-fee','review-strip-paid','review-strip-balance','review-strip-verdict' ]
     .every(id=>{const k=h.indexOf(`id="${id}"`); return k>iStrip && k<iI;}));
 check('it is no longer inside the Payment Verification section', !(iStrip>iP));
 check('the ID checkbox lives under ID Verification, above the money',
   iI < h.indexOf('id="review-idverify-checkbox"') && h.indexOf('id="review-idverify-checkbox"') < iP);
 check('ID Verification is a <section> that hides as a whole',
   /<section id="review-idverify-wrap" class="hidden/.test(h));
 check('...so non-student categories see no stray heading',
   h.indexOf('>ID Verification<') > h.indexOf('id="review-idverify-wrap"'));
 // The ID section closes before Payment Verification starts, so hiding the
 // former can never take the latter with it.
 const idBlock=h.slice(h.indexOf('id="review-idverify-wrap"'), iP);
 check('and Payment Verification, sitting outside that wrapper, always shows',
   idBlock.includes('</section>') && !idBlock.includes('>Payment Verification<'));
 check('Corrections stays outside both sections', h.indexOf('id="review-corrections"') > iP);
 report();
})();
