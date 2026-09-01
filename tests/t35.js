const { check, report, appFile } = require('./harness');
// The custom-send 24h cooldown is per ANNOUNCEMENT, not per address.
const fs=require('fs'), sqlite3=require('sqlite3');
const db=new sqlite3.Database(process.argv[2]);
const run=(s,p=[])=>new Promise((r,j)=>db.run(s,p,function(e){e?j(e):r(this)}));
const all=(s,p=[])=>new Promise((r,j)=>db.all(s,p,(e,x)=>e?j(e):r(x)));

// The exact query the endpoint runs, lifted from server.js so the test cannot
// drift from the implementation.
const src=fs.readFileSync(appFile('server.js'),'utf8');
// Specifically the CUSTOM_REMINDER_SENT lookup -- there is a similarly shaped
// one for the pending-signup card, whose cooldown is per person and
// deliberately unchanged. Sliced to the end of the template literal so the
// whole WHERE clause comes along, not just its first placeholder.
const _i=src.indexOf("WHERE entity_type = 'reminder_email' AND action = 'CUSTOM_REMINDER_SENT'");
const SQL=src.slice(src.lastIndexOf('SELECT DISTINCT entity_id FROM audit_log', _i), src.indexOf('`', _i));

const ENDS='Early Bird Registration for NQOCN 2026 Ends Today';
const EXT ='Early Bird Registration for NQOCN 2026 Extended to 5 September 2026';
const A='cooldown-a@example.com', B='cooldown-b@example.com';
const since=()=>Date.now()-24*60*60*1000;
const blockedFor=async(subject)=>(await all(SQL,[since(), subject.trim().toLowerCase()])).map(r=>r.entity_id);
const record=(addr,subject,when)=>run(
  `insert into audit_log (entity_type,entity_id,action,old_value,new_value,actor_phone,actor_name,actor_role,created_at)
   values ('reminder_email',?,'CUSTOM_REMINDER_SENT',null,?,'t35','t35','SUPER_ADMIN',?)`,[addr,subject,when]);

(async()=>{
 check('the endpoint scopes the lookup by subject', /LOWER\(TRIM\(COALESCE\(new_value/.test(SQL), SQL);

 await run(`delete from audit_log where actor_phone='t35'`);
 await record(A, ENDS, Date.now()-2*3600*1000);   // A got "ends today" 2h ago

 console.log('\n== A different announcement is not blocked ==');
 check('re-sending the SAME message to A is blocked', (await blockedFor(ENDS)).includes(A));
 check('sending the EXTENSION to A is allowed', !(await blockedFor(EXT)).includes(A),
   await blockedFor(EXT));
 check('B, who has had nothing, is never blocked',
   !(await blockedFor(ENDS)).includes(B) && !(await blockedFor(EXT)).includes(B));

 console.log('\n== Once the extension goes out, it throttles on its own ==');
 await record(A, EXT, Date.now()-60*1000);
 check('now the extension is blocked for A too', (await blockedFor(EXT)).includes(A));
 check('and the original still is', (await blockedFor(ENDS)).includes(A));

 console.log('\n== Matching is forgiving of spacing and case ==');
 check('same subject, different case, still blocked', (await blockedFor(EXT.toUpperCase())).includes(A));
 check('same subject with padding, still blocked', (await blockedFor('  '+EXT+'  ')).includes(A));
 check('a subject that merely starts the same is NOT blocked',
   !(await blockedFor(EXT+' (reminder)')).includes(A));

 console.log('\n== The window is still 24 hours ==');
 await run(`delete from audit_log where actor_phone='t35'`);
 await record(B, EXT, Date.now()-25*3600*1000);
 check('25h ago no longer blocks', !(await blockedFor(EXT)).includes(B));
 await record(B, EXT, Date.now()-23*3600*1000);
 check('23h ago still blocks', (await blockedFor(EXT)).includes(B));

 console.log('\n== The real backlog this was about ==');
 await run(`delete from audit_log where actor_phone='t35'`);
 const real=await all(`select distinct entity_id from audit_log
    where entity_type='reminder_email' and action='CUSTOM_REMINDER_SENT' and created_at >= ?`,[since()]);
 if (real.length) {
   const subjects=await all(`select distinct new_value from audit_log
      where entity_type='reminder_email' and action='CUSTOM_REMINDER_SENT' and created_at >= ?`,[since()]);
   const stillBlocked=await blockedFor(EXT);
   console.log(`   ${real.length} address(es) mailed in the last 24h, subject(s): ${JSON.stringify(subjects.map(s=>s.new_value))}`);
   check('none of them are blocked from the extension notice', stillBlocked.length===0, stillBlocked);
 } else check('(nothing sent in the last 24h in this copy)', true);

 // Leave no trace.
 await run(`delete from audit_log where actor_phone='t35'`);
 report();
db.close();
})().catch(e=>{console.error(e);process.exit(1);});
