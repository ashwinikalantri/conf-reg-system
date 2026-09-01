const { call, check, report, appFile, dataDir } = require('./harness');
// "Back up now" queues a request the backup cron picks up. The app never runs
// the backup itself -- the Drive credential is deliberately not in here.
fs=require('fs'), path=require('path'), sqlite3=require('sqlite3');
const db=new sqlite3.Database(process.argv[2]);
const get=(s,p=[])=>new Promise(r=>db.get(s,p,(e,x)=>r(x)));
const login=async(id)=>{let r=await call('POST','/api/auth/login-otp',{identifier:id});
  if(!r.body||!r.body.success) return null;
  r=await call('POST','/api/auth/login',{identifier:id,otp:r.body.devOtp});
  return r.body&&r.body.success?r.cookie:null;};

// Where the server puts the handshake files: beside the database it opened.
const DIR=dataDir();
const REQ=path.join(DIR,'.backup-request.json');
const STAT=path.join(DIR,'.backup-status.json');
const rm=(f)=>{try{fs.unlinkSync(f)}catch{}};

(async()=>{
 rm(REQ); rm(STAT);
 const admin=await login('7440977777');

 console.log('\n== Only a super admin can see or queue backups ==');
 const anon=await call('GET','/api/admin/backup/status',null,null);
 check('anonymous is refused', anon.status===401||anon.status===403, anon.status);
 const anonPost=await call('POST','/api/admin/backup/request',{},null);
 check('anonymous cannot queue one', anonPost.status===401||anonPost.status===403, anonPost.status);
 const delegate=await login('8600202692');
 if (delegate) {
   check('a delegate is refused', (await call('GET','/api/admin/backup/status',null,delegate)).status===403);
   check('a delegate cannot queue one', (await call('POST','/api/admin/backup/request',{},delegate)).status===403);
 } else check('(delegate login throttled)', true);

 console.log('\n== Nothing queued to begin with ==');
 let st=await call('GET','/api/admin/backup/status',null,admin);
 check('status is readable', st.status===200 && st.body.success, st.body);
 check('nothing pending', st.body.pending===false, st.body);
 check('and no last-backup record yet in this copy', st.body.last===null, st.body.last);

 console.log('\n== Queueing a backup ==');
 const before=Date.now();
 const req=await call('POST','/api/admin/backup/request',{},admin);
 check('the request is accepted', req.status===200 && req.body.success, req.body);
 check('a request file is written where the backup script looks', fs.existsSync(REQ), REQ);
 const written=JSON.parse(fs.readFileSync(REQ,'utf8'));
 check('it records who asked', !!written.requestedBy, written);
 check('and when', written.requestedAt>=before && written.requestedAt<=Date.now(), written);
 st=await call('GET','/api/admin/backup/status',null,admin);
 check('status now reports it as pending', st.body.pending===true);
 check('and echoes the request back', st.body.request && st.body.request.requestedBy===written.requestedBy);

 console.log('\n== A second click does not queue a second backup ==');
 const dup=await call('POST','/api/admin/backup/request',{},admin);
 check('it is refused with an explanation', dup.status===409 && /already queued/i.test(dup.body.error||''), dup.body);
 check('the original request is untouched',
   JSON.parse(fs.readFileSync(REQ,'utf8')).requestedAt===written.requestedAt);

 console.log('\n== It is written to the audit trail ==');
 const row=await get(`select action,new_value,actor_name from audit_log
                        where entity_type='backup' order by id desc limit 1`);
 check('a BACKUP_REQUESTED entry exists', row && row.action==='BACKUP_REQUESTED', row);
 check('attributed to the admin who clicked', row && !!row.actor_name, row);

 console.log('\n== Reporting a finished backup ==');
 rm(REQ);
 fs.writeFileSync(STAT, JSON.stringify({ finishedAt: Date.now(), timestamp:'20260901-121857',
   kind:'manual', uploadedToDrive:true, databaseBytes:684032, requestedBy:'Dr Ashwini Kalantri' }));
 st=await call('GET','/api/admin/backup/status',null,admin);
 check('the panel can read the last run', st.body.last && st.body.last.timestamp==='20260901-121857', st.body.last);
 check('including whether Drive got it', st.body.last.uploadedToDrive===true);
 check('and it is no longer pending', st.body.pending===false);

 console.log('\n== The app never runs the backup itself ==');
 const src=fs.readFileSync(appFile('server.js'),'utf8');
 check('no shelling out to the backup script', !/backup\.sh/.test(src.replace(/^\s*\/\/.*$/gm,'')));
 check('no docker socket use', !/docker\.sock|dockerode/.test(src));
 // The app mentions rclone in a comment and in the error text that tells an
 // admin what to paste; what matters is that it never invokes it or touches
 // its config, which is what these two assert.
 check('the app never reads or writes an rclone config', !/rclone\.conf/.test(src));
 // The capability gate is the import, not the word "exec" -- server.js is full
 // of RegExp.exec calls that have nothing to do with running processes.
 check('and cannot run any process at all',
   !/require\(['"]child_process['"]\)|from ['"]child_process['"]/.test(src));

 console.log('\n== app.js is fingerprinted so a deploy actually reaches people ==');
 // Cloudflare caches /app.js for four hours whatever the origin says, so an
 // unversioned URL meant a deploy sat invisible behind the edge and the
 // browser cache. The hash in the URL makes each build a new resource.
 const adminHtml=(await call('GET','/admin',null,admin)).raw;
 const portalHtml=(await call('GET','/',null,null)).raw;
 const m=adminHtml.match(/src="app\.js\?v=([a-f0-9]+)"/);
 check('the admin page requests a versioned app.js', !!m, (adminHtml.match(/src="app\.js[^"]*"/)||[])[0]);
 check('so does the portal', /src="app\.js\?v=[a-f0-9]+"/.test(portalHtml),
   (portalHtml.match(/src="app\.js[^"]*"/)||[])[0]);
 check('both pages ask for the same build',
   m && portalHtml.includes(`app.js?v=${m[1]}`), m && m[1]);
 const expected=require('crypto').createHash('sha1')
   .update(fs.readFileSync(appFile('public','app.js'))).digest('hex').slice(0,10);
 check('and the version is the file\'s own hash', m && m[1]===expected, {got:m&&m[1], expected});
 check('the file is still served at its plain path', (await call('GET','/app.js',null,null)).status===200);

 rm(REQ); rm(STAT);
 report();
db.close();
})();
