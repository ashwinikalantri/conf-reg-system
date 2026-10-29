const { check, report, appFile } = require('./harness');
// Evidence pane: one tab per payment slip, labelled Payment Slip N, ID card
// first; and the slip button in each ledger row.
const fs=require('fs');
const js=fs.readFileSync(appFile('public','app.js'),'utf8');
const grab=(n)=>{const i=js.indexOf('function '+n+'('); const j=js.indexOf('\n}', i); return js.slice(i, j+2);};
const grabConst=(n)=>{const i=js.indexOf('const '+n+' = {'); const j=js.indexOf('\n};', i); return js.slice(i, j+3);};
// Tab labels and the ledger row now carry an SVG icon (see ADMIN_ICON_SVG/
// ICON in app.js) instead of a literal emoji -- pull both in wherever a
// function that calls ICON() is isolated below.
const iconSrc = `${grabConst('ADMIN_ICON_SVG')}\n${grab('ICON')}`;

// Minimal DOM so buildReviewEvidence/setReviewImage can run headless.
function harness(){
  const els={};
  const mk=(id)=>els[id]||(els[id]={id,className:'',textContent:'',innerHTML:'',src:'',href:'',
    classList:{c:new Set(),toggle(k,on){on?this.c.add(k):this.c.delete(k)},add(k){this.c.add(k)},
    remove(k){this.c.delete(k)},contains(k){return this.c.has(k)}}});
  ['review-screenshot','review-img-empty','review-img-open-link','review-img-loading','review-img-switcher',
   'review-img-solo-label','review-img-tabs','review-img-switcher-hint','review-img-zoom-btn','review-img-box']
   .forEach(mk);
  const ctx={document:{getElementById:(id)=>els[id]||null}, URL:{createObjectURL:()=>'blob:x',revokeObjectURL(){}},
    fetch:()=>new Promise(()=>{}), encodeURIComponent, console};
  const src=`
    ${grab('esc')}
    ${iconSrc}
    let reviewImageUrls={},reviewImageBlobUrls={},reviewImageTabs=[],reviewImageZoomed=false,reviewImageWhich='';
    ${grab('buildReviewEvidence')} ${grab('prefetchReviewImages')} ${grab('fetchReviewImage')}
    ${grab('setReviewImage')} ${grab('applyReviewImageZoom')} ${grab('showTxnSlip')}
    return {buildReviewEvidence,setReviewImage,showTxnSlip,
            state:()=>({tabs:reviewImageTabs,urls:reviewImageUrls,which:reviewImageWhich})};`;
  const fn=new Function('document','URL','fetch','encodeURIComponent',src);
  return {api:fn(ctx.document,ctx.URL,ctx.fetch,encodeURIComponent), els};
}
const labels=(h)=>[...h.matchAll(/>([^<>]*Payment Slip[^<>]*|[^<>]*ID Card[^<>]*)</g)].map(m=>m[1].trim());

console.log('\n== 4. Slip labels ==');
{
 const {api,els}=harness();
 api.buildReviewEvidence({id:9,has_id_card:0,has_screenshot:1,
   transactions:[{id:154,has_screenshot:1}]});
 const tabs=api.state().tabs;
 check('a lone slip is labelled "Payment Slip", not "Screenshot"',
   tabs.length===1 && tabs[0].label.includes('Payment Slip') && !tabs[0].label.includes('Screenshot'),
   JSON.stringify(tabs.map(t=>t.label)));
 check('it is not numbered when there is only one', !/Payment Slip \d/.test(tabs[0].label), tabs[0].label);
 check('a single document shows a plain label, not a tab strip',
   els['review-img-solo-label'].innerHTML.includes('Payment Slip') &&
   els['review-img-switcher'].classList.contains('hidden'));
}
{
 const {api,els}=harness();
 api.buildReviewEvidence({id:9,has_id_card:0,has_screenshot:1,
   transactions:[{id:154,has_screenshot:1},{id:159,has_screenshot:1},{id:160,has_screenshot:1}]});
 const L=api.state().tabs.map(t=>t.label);
 check('multiple slips are numbered 1..N',
   L.some(x=>x.includes('Payment Slip 1'))&&L.some(x=>x.includes('Payment Slip 2'))&&L.some(x=>x.includes('Payment Slip 3')),
   JSON.stringify(L));
 check('numbered in ledger order (oldest first)',
   L[0].includes('1')&&L[1].includes('2')&&L[2].includes('3'), JSON.stringify(L));
 console.log('   tab strip renders:', JSON.stringify(labels(els['review-img-tabs'].innerHTML)));
}

console.log('\n== 3. One tab per slip, each its own document ==');
{
 const {api,els}=harness();
 api.buildReviewEvidence({id:168,has_id_card:0,has_screenshot:1,
   transactions:[{id:154,has_screenshot:1},{id:159,has_screenshot:1}]});
 const {tabs,urls}=api.state();
 check('two payments -> two tabs', tabs.length===2, JSON.stringify(tabs.map(t=>t.label)));
 check('each points at its OWN payment endpoint',
   urls[tabs[0].key].includes('/payment-transactions/154/') && urls[tabs[1].key].includes('/payment-transactions/159/'),
   JSON.stringify(urls));
 check('both are reachable at once (no single reused slot)',
   new Set(Object.values(urls)).size===2);
 api.showTxnSlip(159);
 check('the ledger button jumps to that payment\'s own tab', api.state().which==='slip159', api.state().which);
 check('...and the pane is showing that payment\'s slip',
   els['review-screenshot'].src.includes('/payment-transactions/159/'), els['review-screenshot'].src);
 api.showTxnSlip(154);
 check('switching back shows the other one', els['review-screenshot'].src.includes('/payment-transactions/154/'));
 check('tab strip marks the active one', /bg-white text-slate-900/.test(els['review-img-tabs'].innerHTML));
}

console.log('\n== 2. ID card comes first ==');
{
 const {api,els}=harness();
 api.buildReviewEvidence({id:1,has_id_card:1,has_screenshot:1,
   transactions:[{id:11,has_screenshot:1},{id:12,has_screenshot:1}]});
 const {tabs,which}=api.state();
 check('ID Card is the first tab', tabs[0].label.includes('ID Card'), JSON.stringify(tabs.map(t=>t.label)));
 check('and is selected on open', which==='idcard', which);
 check('slips follow it', tabs[1].label.includes('Payment Slip 1') && tabs[2].label.includes('Payment Slip 2'));
 const tabHtml=()=>els['review-img-tabs'].innerHTML;
 const tabOf=(key)=>tabHtml().split('<button').find(b=>b.includes(`setReviewImage('${key}')`))||'';
 check('on open: the ID card Seen, the slips Not opened', /· Seen/.test(tabOf('idcard')) && /· Not opened/.test(tabOf('slip11')) && /· Not opened/.test(tabOf('slip12')));
 api.setReviewImage('slip12');
 api.setReviewImage('idcard');
 check('a slip once opened stays Seen; one never opened says so', /· Seen/.test(tabOf('slip12')) && /· Not opened/.test(tabOf('slip11')));
 check('no pulsing nudge any more', !/animate-pulse/.test(tabHtml()));
}
{
 const {api}=harness();
 api.buildReviewEvidence({id:2,has_id_card:0,has_screenshot:0,transactions:[{id:21,has_screenshot:1}]});
 check('no ID card -> the slip is simply first', api.state().which==='slip21', api.state().which);
}
{
 const {api,els}=harness();
 api.buildReviewEvidence({id:3,has_id_card:0,has_screenshot:0,transactions:[]});
 check('no documents at all -> no tabs, no crash', api.state().tabs.length===0);
 check('and it says so', !els['review-img-empty'].classList.contains('hidden'));
}
{
 const {api}=harness();
 api.buildReviewEvidence({id:4,has_id_card:0,has_screenshot:1,transactions:[{id:41,has_screenshot:0}]});
 check('legacy row with no per-payment slip falls back to the registration screenshot',
   api.state().tabs.length===1 && api.state().urls.screenshot.includes('/registrations/4/screenshot'),
   JSON.stringify(api.state().urls));
}

console.log('\n== 1. The payment card\'s slip button ==');
{
 const row=new Function(`${grab('esc')} ${grab('inr')} ${grab('fmtAuditTime')} ${iconSrc}
   let reviewRegVerified=false; let reviewStepOffset=0; const PAYMENT_MODE_LABELS={UPI:'UPI'};
   ${grab('reviewCheckMark')} ${grab('reviewTxnRowHtml')} return reviewTxnRowHtml;`)();
 const withSlip=row({id:154,amount:2000,verified_amount:750,txn_status:'VERIFIED',payment_mode:'UPI',
   bank_txn_id:518,bank_txn_date:'2026-08-20',bank_txn_credit:750,
   bank_txn_description:'UPI/RRN 128217278187/UPI_PRIYANKA',submitted_at:Date.now(),has_screenshot:1});
 check('it is a real button, "View slip"', /<button type="button"[^>]*onclick="showTxnSlip\(154\)">View slip<\/button>/.test(withSlip));
 check('outlined in navy, a real target (36px)', /h-9 px-3 rounded-lg border border-navy text-navy/.test(withSlip));
 check('not an underlined link', !/hover:underline[^"]*"[^>]*onclick="showTxnSlip/.test(withSlip));
 check('it opens that payment, by id', withSlip.includes('showTxnSlip(154)'));
 const noSlip=row({id:2,amount:100,txn_status:'PENDING',payment_mode:'UPI',bank_txn_id:null,
   submitted_at:Date.now(),has_screenshot:0});
 check('no slip on file -> no button offered', !/<button[^>]*showTxnSlip/.test(noSlip));
 check('...it says so instead', noSlip.includes('No slip on file'));
}

console.log('\n== 0. Tab labels reach the page as markup, not as escaped source ==');
// The ID Card and Payment Slip tabs rendered the raw text "<svg viewBox=..."
// inside the button instead of an icon and a word. The label was built as
// ICON(...) + 'ID Card' -- one string mixing our markup with display text --
// and then went through two sinks that both treat their input as text:
// esc(label) for the tab strip, and textContent for the single-document
// label. Every check that existed here asked whether the label *contained*
// "Payment Slip", which an escaped blob still does, so the whole section
// passed while the pane was unreadable. These assert on the rendered form.
{
 const {api,els}=harness();
 api.buildReviewEvidence({id:77,has_id_card:1,has_screenshot:0,
   transactions:[{id:88,has_screenshot:1}]});
 const strip=els['review-img-tabs'].innerHTML;
 check('the tab strip carries real <svg>, not escaped source',
   strip.includes('<svg') && !strip.includes('&lt;svg'), strip.slice(0,120));
 check('and still shows both words',
   strip.includes('ID Card') && strip.includes('Payment Slip'));
 // The invariant that keeps it that way: icon and label stay separate, so
 // neither sink has to choose between escaping the text and rendering the
 // icon. A label that carries markup again is the bug coming back.
 const tabs=api.state().tabs;
 check('icon and label are separate fields',
   tabs.every(t=>typeof t.icon==='string' && t.icon.includes('<svg') && typeof t.label==='string'),
   JSON.stringify(tabs.map(t=>({icon:(t.icon||'').slice(0,5),label:t.label}))));
 check('the label half is plain text, with no markup in it',
   tabs.every(t=>!t.label.includes('<')), JSON.stringify(tabs.map(t=>t.label)));
}
{
 const {api,els}=harness();
 api.buildReviewEvidence({id:78,has_id_card:0,has_screenshot:0,
   transactions:[{id:89,has_screenshot:1}]});
 const solo=els['review-img-solo-label'].innerHTML;
 check('the single-document label carries real <svg> too',
   solo.includes('<svg') && !solo.includes('&lt;svg'), solo.slice(0,120));
 check('...and its word', solo.includes('Payment Slip'));
}
report();
