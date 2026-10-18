// A Doctor's or Medical PG's Medical Council registration.
//
//   * The registration form asks for it -- the council from the National
//     Medical Commission's list of state medical councils, and the number --
//     for the categories that earn MMC points, and only those.
//   * It is optional there (without it, the participation certificate),
//     and given once: after that the form and the
//     dashboard show it, and the delegate cannot change it; the organisers
//     can, from the user's record or the desk.
const { call, check, report, ADMIN_PW, appFile, adminLogin, loginPassword, openDb } = require('./harness');
const fs = require('fs');
const C = require('../councils');

const N = String(Date.now()).slice(-7);

(async () => {
  console.log('\n== The list ==');
  check('the state medical councils, as the NMC lists them, and the NMC', C.MEDICAL_COUNCILS.length === 31
    && ['Maharashtra Medical Council', 'Travancore Cochin Medical Council, Trivandrum', 'Orissa Council of Medical Registration', 'National Medical Commission'].every((x) => C.MEDICAL_COUNCILS.includes(x)));
  check('a council not on it is refused', /from the list/.test(C.councilError('Mars Medical Council', '123')));
  check('the number: letters, digits, / . -', C.councilError('Maharashtra Medical Council', '2012/03/1234') === null && !!C.councilError('Maharashtra Medical Council', 'a<b'));
  check('...tidied: no spaces, upper case', C.cleanRegNo(' mmc 2012/03 ') === 'MMC2012/03');
  check('both are needed', !!C.councilError('', '123') && !!C.councilError('Maharashtra Medical Council', ''));

  const admin = await adminLogin();
  const desk = await loginPassword('9000000006', ADMIN_PW);
  const db = openDb();
  const email = `council-${N}@example.test`;
  const otp = await call('POST', '/api/otp/request', { destination: email });
  const signed = await call('POST', '/api/auth/register', { salutation: 'Dr', age: '40', gender: 'Male', designation: 'Consultant', institute: 'Test Hospital', pincode: '442102', state: 'Maharashtra', district: 'Wardha', name: `Council Doctor ${N}`, country: 'United Kingdom', email, emailOtp: otp.body.devOtp, password: 'testpass123' });
  const me = signed.cookie;
  const phone = signed.body.user.phone_number;
  try {
    console.log('\n== The registration form ==');
    const fees = (await call('GET', '/api/fees', null, me)).body;
    check('the form is given the list', Array.isArray(fees.medicalCouncils) && fees.medicalCouncils.length === 31);
    const cat = (k) => fees.categories.find((c) => c.key === k);
    check('it asks a Doctor and a Medical PG', cat('faculty_mo').asksCouncilNumber === true && cat('pg_doctor').asksCouncilNumber === true);
    check('...and nobody else', ['chw', 'nursing_ug', 'med_student', 'nurse_cho'].every((k) => cat(k).asksCouncilNumber === false));
    const submit = (extra) => call('POST', '/api/registrations', { categoryKey: 'faculty_mo', optionIds: [], acknowledged: true, paymentMode: 'UPI', ...extra }, me);
    const none = await submit({});
    check('a Doctor may leave it out: the form moves on', !/Medical Council/.test(none.body.error || ''), none.body);
    check('...and nothing is saved', !(await db.get('SELECT council_reg_no FROM users WHERE phone_number = ?', [phone])).council_reg_no);
    const half = await submit({ councilRegNo: '2015/04/5678' });
    check('given, it needs both the council and the number', /Medical Council/.test(half.body.error || ''), half.body);
    const wrong = await submit({ councilName: 'Some Other Council', councilRegNo: '123' });
    check('...as is one with a council not on the list', /from the list/.test(wrong.body.error || ''));
    const right = await submit({ councilName: 'Maharashtra Medical Council', councilRegNo: ' 2015/04/5678 ' });
    check('with it, the form moves on (to the payment it still lacks)', right.body.success === false && !/Medical Council/.test(right.body.error || ''), right.body);
    const u = await db.get('SELECT council_name, council_reg_no FROM users WHERE phone_number = ?', [phone]);
    check('...and it is saved on their account, tidied', u.council_name === 'Maharashtra Medical Council' && u.council_reg_no === '2015/04/5678', u);
    const again = await submit({});
    check('once given, it is not asked again', !/Medical Council/.test(again.body.error || ''));
    check('...nor replaced by a resubmission', (await submit({ councilName: 'Delhi Medical Council', councilRegNo: '999' })) && (await db.get('SELECT council_reg_no FROM users WHERE phone_number = ?', [phone])).council_reg_no === '2015/04/5678');
    check('a non-doctor category is not asked', !/Medical Council/.test((await call('POST', '/api/registrations', { categoryKey: 'chw', optionIds: [], acknowledged: true, paymentMode: 'UPI' }, me)).body.error || ''));

    console.log('\n== The dashboard ==');
    const regId = (await db.run("INSERT INTO registrations (phone_number, delegate_name, category_key, category_label, bank_status) VALUES (?, ?, 'faculty_mo', 'Doctor', 'BANK_VERIFIED')", [phone, `Council Doctor ${N}`])).lastID;
    const card = (await call('GET', '/api/attendance/me', null, me)).body.certificate;
    check('the panel has it, to show', card.councilName === 'Maharashtra Medical Council' && card.councilRegNo === '2015/04/5678' && card.councils.length === 31);
    await call('PUT', '/api/attendance/me/certificate', { certificateName: `Dr Council Doctor ${N}`, councilName: 'Delhi Medical Council', councilRegNo: '1111' }, me);
    const after = await db.get('SELECT certificate_name, council_name, council_reg_no FROM users WHERE phone_number = ?', [phone]);
    check('the delegate cannot change it; their name still can', after.council_reg_no === '2015/04/5678' && after.council_name === 'Maharashtra Medical Council' && after.certificate_name === `Dr Council Doctor ${N}`);

    console.log('\n== The organisers ==');
    const bad = await call('PUT', `/api/users/${encodeURIComponent(phone)}`, { council_name: 'Nowhere Council', council_reg_no: '1' }, admin);
    check('a correction must be from the list too', bad.status === 400);
    const fix = await call('PUT', `/api/users/${encodeURIComponent(phone)}`, { council_name: 'Delhi Medical Council', council_reg_no: 'dmc 4321' }, desk);
    check('the desk (or an admin) can correct it', fix.body.success === true
      && (await db.get('SELECT council_reg_no FROM users WHERE phone_number = ?', [phone])).council_reg_no === 'DMC4321');
    await db.run('DELETE FROM registrations WHERE id = ?', [regId]);

    console.log('\n== The pages ==');
    const form = fs.readFileSync(appFile('views', 'portal', 'modals', 'registration-payment.ejs'), 'utf8');
    const dash = fs.readFileSync(appFile('views', 'portal', 'sections', 'dashboard.ejs'), 'utf8');
    const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
    check('the form: the council and the number, or what was given', ['id="council-block"', 'id="payment-council"', 'id="payment-council-no"', 'id="council-saved"'].every((x) => form.includes(x)));
    check('...marked optional', /Medical Council registration <span class="text-sky-700">\(optional\)<\/span>/.test(form));
    check('the panel: shown once given, not an input', dash.includes('id="cert-council-saved"') && /setText\('cert-council-saved-text'/.test(js));
    check('the councils are a list to choose from, not typed', /<select id="cert-council"/.test(dash) && !dash.includes('cert-council-list'));
    check('the user record and the desk can correct it', /id="ude-council_name"/.test(js) && /id="desk-edit-council_name"/.test(js));
  } finally {
    await db.run('DELETE FROM registrations WHERE phone_number = ?', [phone]);
  }
  db.close();
  report();
})();
