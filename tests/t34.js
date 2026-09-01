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
      : { groups:[{name:'Workshops',options:[1,2,3]},{name:'QI Practices',options:[1,2]}] }) }),
    console, Date, Math, JSON, Number, String,
  };
  vm.createContext(sandbox);
  const src=`
    ${grab('esc')} ${grab('formatFullDate')} ${grab('formatFullDateWithDay')} ${grab('istDateString')}
    ${grab('earlyBirdDeadline')} ${grab('buildEarlyBirdReminderBody')} ${grab('buildEarlyBirdExtensionBody')}
    ${js.slice(js.indexOf('const CUSTOM_REMINDER_TEMPLATES = {'), js.indexOf('\n};', js.indexOf('const CUSTOM_REMINDER_TEMPLATES = {'))+3)}
    CUSTOM_REMINDER_TEMPLATES;`;
  return vm.runInContext(src, sandbox);
}
const CONF={ name:'International Conference on Healthcare Quality & Patient Safety 2026', acronym:'FIXCON 2099',
  startDate:'2026-11-21', endDate:'2026-11-22', location:'Fixture Hall, Testville' };

(async()=>{
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
 check('both buttons are present',
   // The portal URL comes from the stubbed window above; the conference
// website is hardcoded in the template, so this asserts the real one.
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

 console.log('\n== Wired into the page ==');
 const html=(await call('GET','/admin',null,await (async()=>{
   let r = { cookie: await adminLogin() };
   return r.cookie; })())).raw;
 check('the picker is on the Custom Recipients card', html.includes('id="customreminder-template"'));
 check('it offers both templates',
   html.includes('value="early-bird-ending"') && html.includes('value="early-bird-extended"'));
 check('it sits above the subject field',
   html.indexOf('customreminder-template') < html.indexOf('customreminder-subject'));
 check('choosing one fills the fields', html.includes('applyCustomReminderTemplate(this.value)'));
 check('typed content is confirmed over, not silently replaced',
   /applyCustomReminderTemplate[\s\S]{0,900}hasContent[\s\S]{0,200}showConfirm/.test(js));
 check('the card seeds from the same registry',
   /const seed = CUSTOM_REMINDER_TEMPLATES\['early-bird-ending'\]/.test(js));

 report();
})();
