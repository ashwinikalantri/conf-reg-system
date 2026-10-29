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
 // Behaviour of the mark itself. Match/mismatch now render as an SVG
 // icon (see ADMIN_ICON_SVG/ICON in app.js) rather than a literal ✓/✗
 // character -- pull those in too, so the isolated eval has what
 // reviewCheckMark now calls.
 const grabConst=(n)=>{const i=js.indexOf('const '+n+' = {'); const j=js.indexOf('\n};', i); return js.slice(i, j+3);};
 const mark=new Function(`${grabConst('ADMIN_ICON_SVG')}\n${js.match(/function ICON\([\s\S]*?\n}/)[0]}\n${js.match(/function esc\([\s\S]*?\n}/)[0]}\n${js.match(/function reviewCheckMark\([\s\S]*?\n}/)[0]}\nreturn reviewCheckMark;`)();
 check('match -> check icon', mark(1,'x').includes('<svg') && mark(1,'x').includes('emerald'));
 check('mismatch -> cross icon', mark(0,'x').includes('<svg') && mark(0,'x').includes('rose'));
 check('never checked -> dash, not an icon', mark(null,'x').includes('–') && !mark(null,'x').includes('<svg'));
 // Colour is not the only signal: the null case never renders an icon at
 // all, and match/mismatch use genuinely different SVG paths, not just a
 // different fill -- so this still holds even reading the mark in
 // grayscale or through a screen reader that skips styling.
 check('the three states render visually different marks, not just by colour',
   !mark(null,'x').includes('<svg') &&
   mark(1,'x').match(/<svg[\s\S]*?<\/svg>/)[0] !== mark(0,'x').match(/<svg[\s\S]*?<\/svg>/)[0]);
 check('each mark carries a tooltip', ['✓','✗','–'].every((_,i)=>mark([1,0,null][i],'The amount').includes('title="The amount')));
 // Evaluate the real line from app.js rather than pattern-match it, so this
 // asserts the behaviour and not the spelling.
 const modeLine=js.split('\n').find(l=>l.includes("setHTML('review-mode-check'"));
 const modeMark=new Function('p','setHTML','reviewCheckMark', modeLine);
 const run=(mode)=>{let out;modeMark({payment_mode:mode,ocr_vpa_match:0},(id,v)=>{out=v},mark);return out;};
 check('NEFT/RTGS gets no Mode mark at all', run('NEFT_RTGS')==='', JSON.stringify(run('NEFT_RTGS')));
 check('UPI still gets its Mode mark', run('UPI').includes('<svg') && run('UPI').includes('rose'), JSON.stringify(run('UPI')));

 console.log('\n== 3. The review as steps ==');
 const iI=h.indexOf('id="review-idverify-wrap"'), iP=h.indexOf('id="review-payment-progress"');
 check('the student ID step comes first, the payments after', iI>-1 && iP>iI);
 check('the ID step is a <section> that hides as a whole (non-student categories)', /<section id="review-idverify-wrap" class="hidden/.test(h)
   && h.indexOf('id="review-idverify-checkbox"') > iI && h.indexOf('id="review-idverify-checkbox"') < iP);
 const idBlock=h.slice(iI, iP);
 check('...and closes before the payments, so hiding it never hides them', idBlock.includes('</section>'));
 check('each payment is a step card: what the delegate says beside what the bank shows',
   /The delegate says/.test(js) && /The bank shows/.test(js) && /Payment \$\{esc\(i \+ 1\)\} · ₹/.test(js));
 check('the step badge numbers payments after the ID step', /const n = reviewStepOffset \+ i \+ 1;/.test(js) && /reviewStepOffset = isStudent \? 1 : 0;/.test(js));
 check('an unlinked payment loads its likely credits in its own card', /<div id="txn-candidates-\$\{esc\(t\.id\)\}"/.test(js)
   && /txns\.filter\(\(t\) => t\.txn_status === 'PENDING' && t\.bank_txn_id == null && t\.payment_mode !== 'CASH'\)\.forEach\(\(t\) => toggleTxnCandidates\(t\.id\)\)/.test(js));
 check('...best match first: the reference in the description, then the amount', /function rankTxnCandidates\(/.test(js) && /Best match: amount and reference/.test(js));

 console.log('\n== 4. What is owed up top; what is left beside the buttons ==');
 const iStrip=h.indexOf('id="review-status-strip"');
 check('fee, paid and balance sit above the steps', iStrip>-1 && iStrip<iI
   && ['review-strip-fee','review-strip-paid','review-strip-balance'].every(id=>{const k=h.indexOf(`id="${id}"`); return k>iStrip && k<iI;}));
 check('the status pill is in the header, beside who this is', h.indexOf('id="review-strip-verdict"') < h.indexOf('id="review-img-switcher"')
   && h.indexOf('id="review-name"') < h.indexOf('id="review-strip-verdict"'));
 const iFoot=h.indexOf('id="review-gate-list"');
 check('what is still left sits in the footer, beside Accept', iFoot > h.indexOf('id="review-corrections"') && iFoot < h.indexOf('id="review-accept-btn"'));
 check('...said in words, or "Ready to verify"', /step\$\{left\.length === 1 \? '' : 's'\} left: \$\{left\.join\(' · '\)\}/.test(js) && /'Ready to verify'/.test(js));
 check('the rare actions are under More, shown only when they apply', /<details id="review-more" class="hidden/.test(h)
   && h.indexOf('id="review-revise-btn"') > h.indexOf('id="review-more"') && h.indexOf('id="review-unapprove-btn"') > h.indexOf('id="review-more"'));
 check('Accept & verify is navy; Reject outlined in rose', /id="review-accept-btn"[^>]*bg-navy/.test(h) && /id="review-reject-btn"[^>]*border-rose-300 text-rose-700/.test(h));
 check('the close button is a real, labelled 44px button', /onclick="closeModal\('modal-review'\)" aria-label="Close" class="shrink-0 w-11 h-11/.test(h));
 const modal=h.slice(h.indexOf('id="modal-review"'), h.indexOf('id="review-accept-btn"'));
 check('no 10px capitals left in the modal', !/text-\[10px\][^"]*uppercase|uppercase[^"]*text-\[10px\]/.test(modal));
 check('Corrections stays below the payments', h.indexOf('id="review-corrections"') > iP);
 report();
})();
