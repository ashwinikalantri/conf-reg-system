const { call, check, report, appFile, adminLogin } = require('./harness');
// Custom Recipients templates: both announcements available from one picker,
// each quoting the fee master's own early-bird date.
const fs=require('fs'), vm=require('vm');
const js=fs.readFileSync(appFile('public','app.js'),'utf8');
const grab=(n)=>{let i=js.indexOf('function '+n+'(');
  // Keep the `async` keyword when there is one, or the awaits inside become
  // a syntax error the moment the extracted function is evaluated.
  if (js.slice(i-6, i) === 'async ') i -= 6;
  const j=js.indexOf('\n}', i); return js.slice(i, j+2);};

// Run the template builders against a stubbed browser, with the fee master
// and program options served exactly as the real endpoints do.
function build(earlyUntil, conf) {
  const sandbox={
    conferenceInfo: conf,
    window:{ location:{ origin:'https://registration.mgims.ac.in' } },
    document:{ getElementById:()=>null },
    fetch:(url)=>Promise.resolve({ json:()=>Promise.resolve(
      url.includes('/api/fees') ? { earlyUntil }
      : url.includes('/api/groups/eligible-categories') ? { categories: OFFERS }
      : { groups:[{name:'Workshops',options:[1,2,3]},{name:'QI Practices',options:[1,2]}] }) }),
    console, Date, Math, JSON, Number, String,
  };
  vm.createContext(sandbox);
  const src=`
    ${grab('esc')} ${grab('inr')} ${grab('formatFullDate')} ${grab('formatFullDateWithDay')} ${grab('istDateString')}
    ${grab('earlyBirdDeadline')} ${grab('buildEarlyBirdReminderBody')} ${grab('buildEarlyBirdExtensionBody')}
    ${grab('buildAbstractExtensionBody')} ${grab('buildGroupDiscountBody')} ${grab('buildAbstractRegistrationMandatoryBody')}
    ${js.match(/const MGIMS_BOTTLE_DEADLINE = '[^']*';/)[0]} ${grab('buildMgimsRegisterBody')}
    ${js.match(/const steelButton = [\s\S]*?<\/p>`;/)[0]}
    ${js.match(/const reminderSignOff = [^\n]+/)[0]}
    ${grab('buildRegistrationReminderBody')} ${grab('buildBalanceDueBody')} ${grab('buildCodeHolderBody')} ${grab('buildVerifyEmailBody')} ${grab('buildCertificateReadyBody')}
    ${js.match(/const NOT_REGISTERED = [^\n]+/)[0]}
    ${js.slice(js.indexOf('const CUSTOM_REMINDER_TEMPLATES = {'), js.indexOf('\n};', js.indexOf('const CUSTOM_REMINDER_TEMPLATES = {'))+3)}
    CUSTOM_REMINDER_TEMPLATES;`;
  return vm.runInContext(src, sandbox);
}
const OFFERS=[{ category_key:'doctor', label:'Doctor', min_size:5, discount_type:'FLAT', discount_value:500 },
  { category_key:'nurse', label:'Nurse / Community Health Officer', min_size:6, discount_type:'PERCENT', discount_value:10 }];
const CONF={ name:'International Conference on Healthcare Quality & Patient Safety 2026', acronym:'FIXCON 2099',
  startDate:'2026-11-21', endDate:'2026-11-22', location:'Fixture Hall, Testville', abstractDeadline:'2026-09-30' };

(async()=>{
 console.log('\n== The MGIMS faculty template ==');
 const M=build('2026-09-05', CONF)['mgims-register'];
 check('it is registered under the picker', !!M);
 const mSubj=await M.subject();
 const mBody=await M.body();
 check('the subject names the date to register by', mSubj==='MGIMS Faculty: Register for FIXCON 2099 by 20 October 2026 — Early Bird Price and a Personalised Bottle', mSubj);
 check('it opens "Dear Colleague" -- the custom send fills in no names', /^<p>Dear Colleague,<\/p>/.test(mBody) && !/\{\{/.test(mBody));
 check('the bottle deadline, with its weekday', mBody.includes('Tuesday, 20 October 2026') && /personalised with your name/.test(mBody));
 check('...and that a later registration cannot have one customised', /not be possible to customise your bottle/.test(mBody));
 check('an @mgims.ac.in address, once verified, gets the Early Bird fee with no code', /@mgims\.ac\.in/.test(mBody) && /Early Bird fee/.test(mBody) && /no code to enter/i.test(mBody) && /Verify your email/.test(mBody));
 check('it carries the conference dates and venue, and a Register button',
   mBody.includes('21 November 2026') && mBody.includes('Fixture Hall, Testville') && mBody.includes('href="https://registration.mgims.ac.in"'));
 check('in the steel palette, not indigo', mBody.includes('#2f5673') && !/#4f46e5|#6366f1|indigo/i.test(mBody));

 console.log('\n== The extension template ==');
 const T=build('2026-09-05', CONF);
 check('it is registered under the picker', !!T['early-bird-extended']);
 const subj=await T['early-bird-extended'].subject();
 const body=await T['early-bird-extended'].body();
 console.log('   subject:', subj);
 check('the subject names the new date', subj==='Early Bird Registration for FIXCON 2099 Extended to 5 September 2026', subj);
 check('the deadline is shown with its weekday', body.includes('Saturday, 5 September 2026'), (body.match(/\w+day, \d+ \w+ \d{4}/)||[])[0]);
 check('it says the deadline moved', /extended/i.test(body));
 check('it reassures people who already registered', /already registered/i.test(body));
 check('it carries the conference dates and venue',
   body.includes('21 November 2026') && body.includes('Fixture Hall, Testville'));
 check('it lists the programme groups live', /<b>3<\/b> Workshops/.test(body) && /<b>2<\/b> QI Practices/.test(body));
 // The only real addresses left in the suite, and deliberately so: this
 // asserts the links the app puts in the email. The portal URL comes from the
 // window stubbed above; the conference website is hardcoded in the template,
 // so checking anything else would not be checking the template.
 check('both buttons are present',
   body.includes('https://registration.mgims.ac.in') && body.includes('https://nqocn2026.mgims.ac.in'));
 check('no fee table (per the standing instruction)', !/₹|Rs\.?\s*\d|early_fee/i.test(body));
 // Strip comments first: a date in a doc comment explaining the formatter is
 // fine, a date baked into the email copy is not.
 const code=js.split('\n').filter(l=>!/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
 check('no deadline date is hardcoded in the copy', !/5 September|2026-09-05/.test(code),
   (code.match(/.{0,60}(5 September|2026-09-05).{0,40}/)||[])[0]);

 console.log('\n== It follows the fee master, not the wording ==');
 const T2=build('2026-09-30', CONF);
 const b2=await T2['early-bird-extended'].body();
 const s2=await T2['early-bird-extended'].subject();
 check('a different cutoff changes the email', b2.includes('30 September 2026') && !b2.includes('5 September'), s2);
 const T3=build('', CONF);
 const b3=await T3['early-bird-extended'].body();
 check('no cutoff configured -> still coherent, just undated',
   /has been extended/i.test(b3) && !/undefined|null/.test(b3));

 console.log('\n== "Ends today" is only claimed when it is true ==');
 const today=new Date(Date.now()+5.5*3600*1000).toISOString().slice(0,10);
 check('on the cutoff date it says Ends Today',
   (await build(today, CONF)['early-bird-ending'].subject()).endsWith('Ends Today'));
 const notToday=await build('2026-12-25', CONF)['early-bird-ending'].subject();
 check('otherwise it names the date instead of claiming today',
   notToday.includes('Ends on 25 December 2026') && !/Today/.test(notToday), notToday);
 check('the old always-"Ends Today" subject is gone', !/Ends Today'\s*:\s*'Early Bird/.test(js));

 console.log('\n== The abstract-extension template ==');
 // For delegates who HAVE registered. Its date comes from the conference
 // settings (/api/conference -> abstractDeadline), the same value the portal
 // locks submission on, so the email cannot announce a date the portal would
 // refuse a submission on.
 const A=build('2026-09-05', CONF);
 check('it is registered under the picker', !!A['abstract-deadline-extended']);
 const aSubj=await A['abstract-deadline-extended'].subject();
 const aBody=await A['abstract-deadline-extended'].body();
 console.log('   subject:', aSubj);
 check('the subject names the new last date',
   aSubj==='Abstract Submission for FIXCON 2099 Extended to 30 September 2026', aSubj);
 check('the body shows it with its weekday', aBody.includes('Wednesday, 30 September 2026'),
   (aBody.match(/\w+day, \d+ \w+ \d{4}/)||[])[0]);
 check('it says submissions close at the end of that day, in IST', /end of this day \(IST\)/.test(aBody));
 check('it is addressed personally', aBody.includes('{{name}}'));
 check('it restates what an abstract must be', /400 words/.test(aBody) && /structured abstract/i.test(aBody));
 check('it reassures those who already submitted', /already submitted/i.test(aBody));
 check('...and tells those asked for corrections they can still resubmit', /resubmit/i.test(aBody));
 check('it does not quote the early-bird date by mistake', !aBody.includes('5 September 2026'));
 const aNone=await build('', { ...CONF, abstractDeadline:'' })['abstract-deadline-extended'].body();
 check('no deadline configured -> still coherent, just undated',
   /has been extended/i.test(aNone) && !/undefined|null/.test(aNone));
 // Both halves must follow the setting: a subject with the date written into
 // it would keep announcing the old one after the deadline moved again.
 const moved=build('', { ...CONF, abstractDeadline:'2026-10-15' })['abstract-deadline-extended'];
 const aMoved=await moved.body();
 const aMovedSubj=await moved.subject();
 check('changing the setting changes the body', aMoved.includes('15 October 2026') && !aMoved.includes('30 September'));
 check('...and the subject with it',
   aMovedSubj.includes('15 October 2026') && !aMovedSubj.includes('30 September'), aMovedSubj);

 console.log('\n== The group-discount template ==');
 // For people who signed up but never registered. The offers are the
 // group-discount rules in force, read the same way the portal's own picker
 // reads them.
 const G=build('2026-09-05', CONF);
 check('it is registered under the picker', !!G['group-discount']);
 const gSubj=await G['group-discount'].subject();
 const gBody=await G['group-discount'].body();
 console.log('   subject:', gSubj);
 check('the subject says what it is about', /group pays less/i.test(gSubj) && gSubj.includes('FIXCON 2099'), gSubj);
 check('it is addressed personally', gBody.includes('{{name}}'));
 check('it lists each live offer with its own minimum and amount',
   gBody.includes('Doctor') && gBody.includes('5+') && gBody.includes('₹500')
   && gBody.includes('Nurse / Community Health Officer') && gBody.includes('6+') && gBody.includes('10%'), gBody.slice(0, 400));
 check('the headline number is the smallest group that qualifies', /5 or more pays less/.test(gBody));
 check('it gives the order that matters: group first, then pay',
   /applied when you pay/.test(gBody) && /gather the group first/.test(gBody));
 check('it links to the how-to page rather than repeating it',
   gBody.includes('/help/group-registration'));
 check('...and to the portal to finish registering', gBody.includes('https://registration.mgims.ac.in'));
 // The builder reads OFFERS when its fetch resolves, so the list has to stay
 // empty until the body is actually built -- restoring it synchronously
 // refilled it before the template ever looked.
 const saved=OFFERS.slice();
 OFFERS.length=0;
 const gNone=await build('2026-09-05', CONF)['group-discount'].body();
 OFFERS.push(...saved);
 check('no rules configured -> no empty table, and nothing broken',
   !/<table/.test(gNone) && !/undefined|null/.test(gNone));

 console.log('\n== Wired into the page ==');
 const html=(await call('GET','/admin',null,await adminLogin())).raw;
 check('the composer has one template picker, above the subject', html.includes('id="rem-template"')
   && html.indexOf('id="rem-template"') < html.indexOf('id="rem-subject"'));
 check('choosing one fills the fields', html.includes('applyReminderTemplate(this.value)'));
 check('typed content is confirmed over, not silently replaced',
   /async function applyReminderTemplate[\s\S]{0,900}edited[\s\S]{0,200}showConfirm/.test(js));

 console.log('\n== Each template only where it fits ==');
 const R=require('../reminders');
 const TT=build('2026-09-05', CONF);
 for (const [key, tpl] of Object.entries(TT)) {
   const text=`${await tpl.subject()}\n${await tpl.body()}`;
   const used=R.placeholdersIn(text);
   const bad=tpl.audiences.filter((k)=>!R.AUDIENCE_BY_KEY[k] || used.some((p)=>!R.AUDIENCE_BY_KEY[k].placeholders.includes(p)));
   check(`"${tpl.label}" is offered only to audiences that can fill all of ${used.map((p)=>`{{${p}}}`).join(', ') || 'its text'}`, tpl.audiences.length>0 && bad.length===0, bad);
   const missing=tpl.audiences.filter((k)=>R.AUDIENCE_BY_KEY[k].required.some((p)=>!used.includes(p)));
   check(`...and carries what each of them requires`, missing.length===0, missing);
 }
 const defaults=js.slice(js.indexOf('const REMINDER_DEFAULT_TEMPLATE = {'), js.indexOf('};', js.indexOf('const REMINDER_DEFAULT_TEMPLATE = {')));
 const pairs=[...defaults.matchAll(/(\w+): '([\w-]+)'/g)].map((m)=>[m[1], m[2]]);
 check('every audience but the registered starts from a template', pairs.length===R.AUDIENCES.length-1 && !pairs.some(([k])=>k==='registered'), pairs);
 check('...one that is offered to it', pairs.every(([k, t])=>TT[t] && TT[t].audiences.includes(k)), pairs.filter(([k, t])=>!(TT[t] && TT[t].audiences.includes(k))));
 check('the MGIMS email can go to pasted addresses and to the domain audience', TT['mgims-register'].audiences.includes('paste') && TT['mgims-register'].audiences.includes('domain'));

 report();
})();
