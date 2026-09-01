const { call, ADMIN } = require('./harness');
;
(async()=>{
let r=await call('POST','/api/auth/login-otp',{identifier:ADMIN});
r=await call('POST','/api/auth/login',{identifier:ADMIN,otp:r.body.devOtp});
const ac=r.cookie;
const rep=await call('GET','/api/admin/reports/users',null,ac);
console.log('report shape:', Object.keys(rep.body||{}), 'status', rep.status);
const sec=(rep.body.report||rep.body).sections[0];
const iMob=sec.columns.indexOf('Mobile'), iEmail=sec.columns.indexOf('Email'), iName=sec.columns.indexOf('Name');
const rows=sec.rows.filter(row=>String(row[iEmail]||'').includes('emailonly@example.com')||String(row[iEmail]||'').includes('dupe@example.com'));
console.log('Email-only accounts as they appear in the Users report:');
rows.forEach(row=>console.log('   Name=%j  Mobile=%j  Email=%j', row[iName], row[iMob], row[iEmail]));
console.log(rows.length? 'FOUND in report — Mobile blank, Email present.' : 'NOT FOUND (would be a bug)');
// And a normal phone account for contrast
const norm=sec.rows.find(row=>row[iMob]===ADMIN);
console.log('Contrast, a phone account: Name=%j Mobile=%j', norm&&norm[iName], norm&&norm[iMob]);
})();
