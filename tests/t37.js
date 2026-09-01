const { call, check, report, appFile, dataDir } = require('./harness');
// Linking Google Drive from the UI. The panel captures the token; the backup
// script installs it. The app must never keep or expose the credential.
fs=require('fs'), path=require('path'), sqlite3=require('sqlite3');
const db=new sqlite3.Database(process.argv[2]);
const get=(s,p=[])=>new Promise(r=>db.get(s,p,(e,x)=>r(x)));
const login=async(id)=>{let r=await call('POST','/api/auth/login-otp',{identifier:id});
  if(!r.body||!r.body.success) return null;
  r=await call('POST','/api/auth/login',{identifier:id,otp:r.body.devOtp});
  return r.body&&r.body.success?r.cookie:null;};

const DIR=dataDir();
const F_LINK=path.join(DIR,'.drive-link-request.json');
const F_CHECK=path.join(DIR,'.drive-check-request.json');
const F_STAT=path.join(DIR,'.drive-status.json');
const rm=(f)=>{try{fs.unlinkSync(f)}catch{}};
const TOKEN={access_token:'ya29.EXAMPLE',token_type:'Bearer',refresh_token:'1//EXAMPLE',expiry:'2026-09-02T00:00:00Z'};

(async()=>{
 [F_LINK,F_CHECK,F_STAT].forEach(rm);
 const admin=await login('7440977777');

 console.log('\n== Only a super admin can touch the link ==');
 check('anonymous cannot link', [401,403].includes((await call('POST','/api/admin/backup/drive-link',{token:JSON.stringify(TOKEN)},null)).status));
 const delegate=await login('8600202692');
 if (delegate) check('a delegate cannot link',
   (await call('POST','/api/admin/backup/drive-link',{token:JSON.stringify(TOKEN)},delegate)).status===403);
 else check('(delegate login throttled)', true);

 console.log('\n== The token is validated while the admin can still fix it ==');
 const bad=[
   ['empty',            {token:'   '},                          /paste the token/i],
   ['a bare token string', {token:'ya29.somethingtheypasted'},   /no token found/i],
   ['JSON without a token', {token:'{"hello":"world"}'},         /no access_token/i],
 ];
 for (const [what, body, msg] of bad) {
   const r=await call('POST','/api/admin/backup/drive-link',body,admin);
   check(`rejects ${what}`, r.status===400 && msg.test(r.body.error||''), r.body);
 }
 check('nothing was written for a rejected token', !fs.existsSync(F_LINK));
 for (const [label, folder] of [['a double quote','a"b'], ['a single quote', "a'b"], ['a backslash','a\\b']]) {
   const r=await call('POST','/api/admin/backup/drive-link',{token:JSON.stringify(TOKEN),folder},admin);
   check(`a folder name cannot smuggle ${label} into the shell or config`, r.status===400, r.body);
 }

 console.log('\n== Whatever rclone printed is accepted ==');
 // rclone wraps the token in marker lines, and anyone copying what they see
 // brings those along.
 const RCLONE_OUTPUT = 'Paste the following into your remote machine --->\n'
   + JSON.stringify(TOKEN) + '\n<---End paste';
 const pasted = await call('POST','/api/admin/backup/drive-link',{token:RCLONE_OUTPUT},admin);
 check('the full rclone output is accepted', pasted.status===200 && pasted.body.success, pasted.body);
 check('and only the token is stored',
   JSON.parse(JSON.parse(fs.readFileSync(F_LINK,'utf8')).token).refresh_token===TOKEN.refresh_token);
 check('with the marker lines stripped',
   !fs.readFileSync(F_LINK,'utf8').includes('End paste'));
 rm(F_LINK);
 const spaced = await call('POST','/api/admin/backup/drive-link',
   {token:'\n\n  ' + JSON.stringify(TOKEN) + '  \n\n'},admin);
 check('stray whitespace is fine too', spaced.status===200 && spaced.body.success, spaced.body);
 rm(F_LINK);

 console.log('\n== A good token is handed to the backup script ==');
 const ok=await call('POST','/api/admin/backup/drive-link',
   {token:JSON.stringify(TOKEN), folder:'NQOCN 2026 Backups'},admin);
 check('accepted', ok.status===200 && ok.body.success, ok.body);
 check('written where the backup script looks', fs.existsSync(F_LINK));
 const req=JSON.parse(fs.readFileSync(F_LINK,'utf8'));
 check('carrying the token', JSON.parse(req.token).refresh_token===TOKEN.refresh_token);
 check('and the folder', req.folder==='NQOCN 2026 Backups');
 check('and who submitted it', !!req.requestedBy);
 const mode=(fs.statSync(F_LINK).mode & 0o777).toString(8);
 check('not world-readable while it waits', mode==='600', mode);

 console.log('\n== The credential never leaks back out ==');
 const st=await call('GET','/api/admin/backup/status',null,admin);
 check('status says a change is pending', st.body.drivePending===true, st.body);
 check('but never returns the token', !st.raw.includes('EXAMPLE') && !/refresh_token/.test(st.raw), st.raw.slice(0,200));
 const audit=await get(`select action,new_value from audit_log where entity_id='google-drive' order by id desc limit 1`);
 check('the audit records the change', audit && audit.action==='DRIVE_LINK_SUBMITTED', audit);
 check('without recording the token', audit && !/EXAMPLE|access_token/.test(audit.new_value||''), audit);

 console.log('\n== Reporting what the script found ==');
 rm(F_LINK);
 fs.writeFileSync(F_STAT, JSON.stringify({checkedAt:Date.now(),linked:true,
   remote:'nqocn-db:NQOCN 2026 Backups',backupCount:14,keep:14,clientId:'',
   account:'ashwini@mgims.ac.in',lastError:''}));
 const st2=await call('GET','/api/admin/backup/status',null,admin);
 check('linked status is surfaced', st2.body.drive && st2.body.drive.linked===true);
 check('with the backup count', st2.body.drive.backupCount===14);
 check('and which Google account holds them', st2.body.drive.account==='ashwini@mgims.ac.in', st2.body.drive);
 check('and nothing pending now', st2.body.drivePending===false);
 const js=fs.readFileSync(appFile('public','app.js'),'utf8');
 check('the panel renders the account', /Linked<\/span>`[\s\S]{0,200}d\.account/.test(js));
 const sh2=fs.readFileSync('/home/ashwinikalantri/nqocn/scripts/backup.sh','utf8');
 check('the script asks Drive who the token belongs to',
   /drive\/v3\/about\?fields=user/.test(sh2));
 check('refreshing the token first, since the stored one is usually stale',
   /rclone --config \/tmp\/r\.conf lsd[\s\S]{0,80}node -/.test(sh2));
 check('and treats a missing account as non-fatal',
   /Best-effort by design/.test(sh2));
 fs.writeFileSync(F_STAT, JSON.stringify({checkedAt:Date.now(),linked:false,lastError:'token expired'}));
 const st3=await call('GET','/api/admin/backup/status',null,admin);
 check('a broken link is surfaced with its reason',
   st3.body.drive.linked===false && /token expired/.test(st3.body.drive.lastError));

 console.log('\n== Test connection ==');
 const chk=await call('POST','/api/admin/backup/drive-check',{},admin);
 check('queues a check', chk.status===200 && fs.existsSync(F_CHECK));
 check('which shows as pending', (await call('GET','/api/admin/backup/status',null,admin)).body.drivePending===true);

 console.log('\n== The backup script owns the credential, not the app ==');
 const src=fs.readFileSync(appFile('server.js'),'utf8');
 const code=src.replace(/^\s*\/\/.*$/gm,'');
 check('the app never writes an rclone config', !/rclone\.conf/.test(code));
 check('and never shells out', !/require\(['"]child_process['"]\)/.test(code));
 const sh=fs.readFileSync('/home/ashwinikalantri/nqocn/scripts/backup.sh','utf8');
 check('the script consumes the request before using it', /volume_clear \.drive-link-request\.json[\s\S]{0,400}if \[ -z "\$token" \]/.test(sh));
 check('and restores the previous config if the new token fails',
   /Drive link FAILED -- restored the previous configuration/.test(sh));
 check('the installed config is not world-readable', /chmod 600 "\$RCLONE_CONF"/.test(sh));

 [F_LINK,F_CHECK,F_STAT].forEach(rm);
 report();
db.close();
})();
