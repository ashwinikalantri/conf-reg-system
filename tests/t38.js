const { call, check, report, appFile, dataDir, ADMIN } = require('./harness');
// "Connect Google Drive": the app runs the OAuth flow itself, because rclone's
// loopback redirect cannot reach a server from someone else's browser.
fs=require('fs'), path=require('path'), sqlite3=require('sqlite3');
const db=new sqlite3.Database(process.argv[2]);
const get=(s,p=[])=>new Promise(r=>db.get(s,p,(e,x)=>r(x)));
const login=async(id)=>{let r=await call('POST','/api/auth/login-otp',{identifier:id});
  if(!r.body||!r.body.success) return null;
  r=await call('POST','/api/auth/login',{identifier:id,otp:r.body.devOtp});
  return r.body&&r.body.success?r.cookie:null;};
const DIR=dataDir();
const F_LINK=path.join(DIR,'.drive-link-request.json');
const rm=(f)=>{try{fs.unlinkSync(f)}catch{}};

(async()=>{
 rm(F_LINK);
 const admin=await login(ADMIN);

 console.log('\n== Access ==');
 for (const p of ['/api/admin/backup/drive-oauth/start','/api/admin/backup/drive-callback','/api/admin/backup/drive-oauth/config']) {
   const r=await call(p.endsWith('config')?'POST':'GET',p,{},null);
   check(`anonymous cannot reach ${p.split('/').pop()}`, [401,403].includes(r.status), r.status);
 }

 console.log('\n== Before an OAuth client exists ==');
 const st0=await call('GET','/api/admin/backup/status',null,admin);
 const oauth0=st0.body.driveOauth;
 check('status reports whether sign-in is set up', oauth0 && typeof oauth0.configured==='boolean', oauth0);
 check('and gives the redirect URI to register',
   /^https?:\/\/.+\/api\/admin\/backup\/drive-callback$/.test(oauth0.redirectUri||''), oauth0.redirectUri);
 check('the secret is never sent to the browser', !/client_secret|clientSecret/i.test(st0.raw), st0.raw.slice(0,200));
 if (!oauth0.configured) {
   const s=await call('GET','/api/admin/backup/drive-oauth/start',null,admin);
   check('starting sign-in without a client explains itself', s.status===400 && /not set up/i.test(s.raw), s.status);
 } else check('(an OAuth client is already configured here)', true);

 console.log('\n== Saving the OAuth client ==');
 const bad=await call('POST','/api/admin/backup/drive-oauth/config',{clientId:'x'},admin);
 check('both halves are required', bad.status===400, bad.body);
 const nl=await call('POST','/api/admin/backup/drive-oauth/config',{clientId:'a\nb',clientSecret:'c'},admin);
 check('a line break cannot be smuggled into .env', nl.status===400, nl.body);
 const ok=await call('POST','/api/admin/backup/drive-oauth/config',
   {clientId:'test-client.apps.googleusercontent.com',clientSecret:'GOCSPX-test-secret'},admin);
 check('a valid pair is accepted', ok.status===200 && ok.body.success, ok.body);
 const audit=await get(`select action,new_value from audit_log where entity_id='google-drive' order by id desc limit 1`);
 check('recorded in the audit trail', audit && audit.action==='DRIVE_OAUTH_CLIENT_SET', audit);
 check('without the secret in it', audit && !/GOCSPX/.test(audit.new_value||''), audit);
 const envTxt=fs.readFileSync(path.join(DIR,'.env'),'utf8');
 check('stored in .env, not the database', /DRIVE_CLIENT_SECRET=GOCSPX-test-secret/.test(envTxt));
 const inDb=await get(`select value from schema_meta where value like '%GOCSPX%'`);
 check('the database has no copy of it', !inDb, inDb);

 console.log('\n== Starting the sign-in ==');
 const start=await call('GET','/api/admin/backup/drive-oauth/start',null,admin);
 check('redirects to Google', start.status===302 && /^https:\/\/accounts\.google\.com\/o\/oauth2\/auth/.test(start.location||''), start.status);
 const u=new URL(start.location);
 check('asking for Drive access', u.searchParams.get('scope')==='https://www.googleapis.com/auth/drive');
 check('with our own client', u.searchParams.get('client_id')==='test-client.apps.googleusercontent.com');
 check('and our own redirect URI', /\/api\/admin\/backup\/drive-callback$/.test(u.searchParams.get('redirect_uri')||''));
 // Without these Google returns no refresh token on a repeat authorisation,
 // and backups would stop working an hour later.
 check('offline access, so a refresh token comes back', u.searchParams.get('access_type')==='offline');
 check('and prompt=consent, so it comes back every time', u.searchParams.get('prompt')==='consent');
 check('carrying a state value', (u.searchParams.get('state')||'').length>=16);

 console.log('\n== The callback will not accept a forged return ==');
 const forged=await call('GET','/api/admin/backup/drive-callback?code=abc&state=not-the-one',null,admin);
 check('a mismatched state is refused', forged.status===400 && /expired/i.test(forged.raw), forged.status);
 check('and nothing is written', !fs.existsSync(F_LINK));
 const denied=await call('GET','/api/admin/backup/drive-callback?error=access_denied&state=x',null,admin);
 check('a refusal at Google is reported, not swallowed',
   denied.status===400 && /not connected/i.test(denied.raw) && /access_denied/.test(denied.raw));
 check('still nothing written', !fs.existsSync(F_LINK));

 console.log('\n== Why this exists at all ==');
 const src=fs.readFileSync(appFile('server.js'),'utf8');
 check('the reason is written down next to the code', /hardcoded to http:\/\/127\.0\.0\.1:53682/.test(src));
 check('the paste-a-token route still works too', /drive-link'/.test(src));
 // The callback is a cross-site top-level GET; it only sees the session
 // because the cookie is lax. Strict would 403 with no obvious cause.
 check('the session cookie is lax, which the callback depends on', /sameSite: 'lax'/.test(src));
 check('and that dependency is written down', /Tightening\n\/\/ that to 'strict'|sameSite:'lax' -- lax sends cookies/.test(src));

 rm(F_LINK);
 report();
db.close();
})();
