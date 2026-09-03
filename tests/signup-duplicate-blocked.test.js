// A signup can no longer reuse a phone or email already on another account
// -- not even the account's own owner re-registering to "update" it. That
// self-reclaim exception used to be allowed (an OTP-proven match on your
// own existing channel silently updated your profile instead of creating a
// new one); it's gone now, on purpose, by explicit decision: a phone/email
// already on file refuses the signup outright, unconditionally. This checks
// both halves of that -- the new POST /api/auth/check-contact pre-check the
// wizard's Contact step calls, and that POST /api/auth/register itself
// stays the real, unconditional gate (including against its OWN prior
// owner, which is the behaviour that actually changed).
const { call, check, report } = require('./harness');

const N = String(Date.now()).slice(-6);
const base = { salutation: 'Dr', name: 'dup tester', age: '31', gender: 'Male',
  designation: 'Consultant', institute: 'Test Hospital', country: 'India',
  pincode: '442102', state: 'Maharashtra', district: 'Wardha' };

(async () => {
  const phone = `9${N}211`;
  const email = `dupguard-${N}@example.com`;

  console.log('\n== A first signup succeeds and owns both channels ==');
  let r = await call('POST', '/api/otp/request', { destination: phone });
  const firstPhoneOtp = r.body.devOtp;
  r = await call('POST', '/api/otp/request', { destination: email });
  const firstEmailOtp = r.body.devOtp;
  r = await call('POST', '/api/auth/register', { ...base, phone, phoneOtp: firstPhoneOtp, email, emailOtp: firstEmailOtp, password: 'testpass123' });
  check('first signup succeeds', r.body.success === true, r.body.error);
  const originalKey = r.body.user.phone_number;

  console.log('\n== check-contact reports both as taken ==');
  r = await call('POST', '/api/auth/check-contact', { phone, email });
  check('endpoint responds', r.status === 200, r.status);
  check('phone reported taken', r.body.phoneTaken === true, r.body);
  check('email reported taken', r.body.emailTaken === true, r.body);

  console.log('\n== check-contact reports a fresh phone/email as free ==');
  r = await call('POST', '/api/auth/check-contact', { phone: `9${N}222`, email: `fresh-${N}@example.com` });
  check('phone reported free', r.body.phoneTaken === false, r.body);
  check('email reported free', r.body.emailTaken === false, r.body);

  console.log('\n== A stranger cannot register with either taken value ==');
  r = await call('POST', '/api/otp/request', { destination: `9${N}233` });
  const strangerPhoneOtp = r.body.devOtp;
  r = await call('POST', '/api/auth/register', { ...base, phone: `9${N}233`, phoneOtp: strangerPhoneOtp, email, password: 'testpass123' });
  check('reusing the taken email -> 409', r.status === 409 && /already exists/i.test(r.body.error || ''), [r.status, r.body.error]);

  r = await call('POST', '/api/otp/request', { destination: `stranger-${N}@example.com` });
  const strangerEmailOtp = r.body.devOtp;
  r = await call('POST', '/api/auth/register', { ...base, phone, email: `stranger-${N}@example.com`, emailOtp: strangerEmailOtp, password: 'testpass123' });
  check('reusing the taken phone -> 409', r.status === 409 && /already exists/i.test(r.body.error || ''), [r.status, r.body.error]);

  console.log('\n== The prior owner ALSO cannot re-register with their own, already-proven channel ==');
  // Deliberately the behaviour that changed: proving ownership via a real
  // OTP for your OWN existing phone/email used to update the account in
  // place ("re-register to update your profile"). It now refuses outright,
  // no exception -- by explicit decision, since there was no way to tell
  // this apart from someone else colliding with it by accident.
  r = await call('POST', '/api/otp/request', { destination: phone });
  const ownPhoneOtp = r.body.devOtp;
  r = await call('POST', '/api/auth/register', { ...base, name: 'dup tester renamed', phone, phoneOtp: ownPhoneOtp, email: `unrelated-${N}@example.com`, password: 'testpass123' });
  check('own phone, freshly OTP-proven -> still 409', r.status === 409 && /mobile number already exists/i.test(r.body.error || ''), [r.status, r.body.error]);

  r = await call('POST', '/api/otp/request', { destination: email });
  const ownEmailOtp = r.body.devOtp;
  r = await call('POST', '/api/auth/register', { ...base, phone: `9${N}244`, email, emailOtp: ownEmailOtp, password: 'testpass123' });
  check('own email, freshly OTP-proven -> still 409', r.status === 409 && /email address already exists/i.test(r.body.error || ''), [r.status, r.body.error]);

  console.log('\n== The original account is untouched by all of the above ==');
  r = await call('POST', '/api/auth/login-password', { identifier: email, password: 'testpass123' });
  check('original password still works', r.body.success === true, r.body.error);
  check('still the same account key', r.body.user.phone_number === originalKey, r.body.user.phone_number);
  check('name was never overwritten by the rejected attempts', r.body.user.full_name === 'Dup Tester', r.body.user.full_name);

  console.log('\n== The wizard\'s client-side gate calls the same check ==');
  const fs = require('fs');
  const path = require('path');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  check('checkSignupContactAvailable exists', /async function checkSignupContactAvailable\(\)/.test(js));
  check('the Contact step gate calls it', /return await checkSignupContactAvailable\(\)/.test(js));
  check('it calls the new endpoint', /fetch\('\/api\/auth\/check-contact'/.test(js));

  report();
})();
