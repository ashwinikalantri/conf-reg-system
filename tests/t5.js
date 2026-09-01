const { call, ADMIN } = require('./harness');
;
(async()=>{
let r=await call('POST','/api/auth/login-otp',{identifier:ADMIN});
r=await call('POST','/api/auth/login',{identifier:ADMIN,otp:r.body.devOtp});
const ac=r.cookie;
const rep=await call('GET','/api/admin/reports/users?format=csv',null,ac);
const lines=rep.raw.split('\n');
console.log('HEADER:', lines[0]);
console.log('\n-- email-only accounts as exported --');
lines.filter(l=>/emailonly@example\.com|dupe@example\.com/.test(l)).forEach(l=>console.log('  ',l));
console.log('\n-- a normal phone account, for contrast --');
lines.filter(l=>/9000000001/.test(l)).slice(0,1).forEach(l=>console.log('  ',l));
console.log('\nSynthetic keys anywhere in the export?', /u_[0-9a-f]{18}/.test(rep.raw) ? 'YES (BUG)' : 'no');
})();
