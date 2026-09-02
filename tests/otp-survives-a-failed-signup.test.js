// A delegate reported "Mobile OTP: Please request an OTP first" with both
// codes filled in and both plainly sent. Two causes, and the message was a
// third problem on top of them:
//
//   * the signup form burned the phone code BEFORE looking at the email one,
//     so any later failure destroyed a good verification;
//   * codes lasted five minutes, which is a login-shaped number on a form
//     that asks for two codes and then a page of personal details;
//   * and once the row was gone, the next attempt claimed they had never
//     requested a code -- the one thing that had not happened.
const { call, check, report, openDb, appFile } = require('./harness');
const fs = require('fs');

const N = String(Date.now()).slice(-6);
const base = { salutation: 'Dr', name: 'otp survivor', age: '45', gender: 'Male',
  designation: 'Professor', institute: 'Test Institute', country: 'India',
  pincode: '442102', state: 'Maharashtra', district: 'Wardha' };

(async () => {
  const db = openDb();
  const phone = `9${N}077`;
  const email = `otp-survivor-${N}@example.com`;

  console.log('\n== Both codes are requested, as the delegate did ==');
  const pReq = await call('POST', '/api/otp/request', { destination: phone });
  const eReq = await call('POST', '/api/otp/request', { destination: email });
  check('mobile code issued', pReq.body.success === true, pReq.body);
  check('email code issued', eReq.body.success === true, eReq.body);
  const phoneOtp = pReq.body.devOtp;
  const emailOtp = eReq.body.devOtp;

  console.log('\n== A submit that fails on the EMAIL code ==');
  const bad = await call('POST', '/api/auth/register',
    { ...base, phone, phoneOtp, email, emailOtp: '000000', password: 'testpass123' });
  check('the attempt is rejected', bad.body.success !== true, bad.body);
  check('and it says so about the email code', /Email OTP/.test(bad.body.error || ''), bad.body.error);

  // The heart of it: the phone code must still be there afterwards.
  const stillThere = await db.get('SELECT destination FROM otp_codes WHERE destination LIKE ?', [`%${N}077`]);
  check('the mobile code SURVIVES the failed attempt', !!stillThere, stillThere);

  console.log('\n== The retry, with the right email code, now works ==');
  const good = await call('POST', '/api/auth/register',
    { ...base, phone, phoneOtp, email, emailOtp, password: 'testpass123' });
  check('the delegate gets in on the second try', good.body.success === true, good.body.error);
  check('...without being told to request an OTP first',
    !/request an OTP first/i.test(good.body.error || ''), good.body.error);

  console.log('\n== Once it succeeds, both codes are spent ==');
  const left = await db.all('SELECT destination FROM otp_codes WHERE destination LIKE ? OR destination = ?',
    [`%${N}077`, email]);
  check('no code is left usable', left.length === 0, left);
  // Replaying the same codes must not work.
  const replay = await call('POST', '/api/auth/register',
    { ...base, phone, phoneOtp, email: `replay-${N}@example.com`, password: 'testpass123' });
  check('the spent mobile code cannot be replayed', replay.body.success !== true, replay.body);

  console.log('\n== The wording no longer asserts what did not happen ==');
  const never = await call('POST', '/api/auth/register',
    { ...base, phone: `9${N}088`, phoneOtp: '123456', email: `never-${N}@example.com`, password: 'testpass123' });
  check('an unknown code is rejected', never.body.success !== true, never.body);
  check('and is not described as "you never asked"',
    !/request an OTP first/i.test(never.body.error || ''), never.body.error);
  check('it says the code is no longer valid', /no longer valid/i.test(never.body.error || ''), never.body.error);

  console.log('\n== A code lasts long enough to fill the form in ==');
  const src = fs.readFileSync(appFile('server.js'), 'utf8');
  const ttl = /const OTP_TTL_MS = (\d+) \* 60 \* 1000;/.exec(src);
  check('the TTL is at least 15 minutes', ttl && Number(ttl[1]) >= 15, ttl && ttl[1]);
  check('expiry no longer deletes the row',
    !/expires_at\) \{\s*\n\s*await dbRun\('DELETE FROM otp_codes/.test(src));
  check('verify and burn are separate', /async function verifyOtp\(/.test(src) && /async function burnOtp\(/.test(src));
  check('signup verifies rather than consumes', /const c = await verifyOtp\(phoneVal, phoneCode\)/.test(src));
  check('and burns only after the account is written',
    /if \(phoneOk\) await burnOtp\(phoneVal\);\s*\n\s*if \(emailOk\) await burnOtp\(emailVal\);/.test(src));

  db.close();
  report();
})();
