// E-certificates: who qualifies for which, issuing, the delegate's download,
// corrections, withdrawal and the public verify page.
//
//   * MMC: completed (in on every day, out on the last), paid, a Doctor or
//     Medical PG, and a council number given. CONF: completed and paid.
//     WORKSHOP: signed in at it (and paid). An admin may include or exclude
//     anyone, with a reason.
//   * Issuing numbers them per kind, once; issuing again adds only the new.
//   * The delegate downloads their own; their details lock once issued.
//   * Anyone can verify one by its code: valid, withdrawn, or not found.
const { call, check, report, ADMIN_PW, appFile, adminLogin, loginPassword, openDb } = require('./harness');
const fs = require('fs');

const N = String(Date.now()).slice(-7);
// A 1x1 transparent PNG, for a signature.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

(async () => {
  const admin = await adminLogin();
  const desk = await loginPassword('9000000006', ADMIN_PW);
  const reviewer = await loginPassword('9000000003', ADMIN_PW);
  const db = openDb();
  const savedSettings = await db.get("SELECT value FROM schema_meta WHERE key = 'certificate_settings'");
  const base = { salutation: 'Dr', age: '40', gender: 'Female', designation: 'Professor', institute: 'Test College', pincode: '442102', state: 'Maharashtra', district: 'Wardha' };
  const people = [];
  const signUp = async (tag, category, regNo) => {
    const email = `cert-${tag}-${N}@example.test`;
    const otp = await call('POST', '/api/otp/request', { destination: email });
    const r = await call('POST', '/api/auth/register', { ...base, name: `Cert ${tag} ${N}`, country: 'United Kingdom', email, emailOtp: otp.body.devOtp, password: 'testpass123' });
    const phone = r.body.user.phone_number;
    const reg = await db.run(`INSERT INTO registrations (phone_number, delegate_name, category_key, category_label, bank_status, registration_number)
      VALUES (?, ?, ?, ?, 'BANK_VERIFIED', ?)`, [phone, `Cert ${tag} ${N}`, category, category === 'faculty_mo' ? 'Doctor' : 'Frontline Health Worker', regNo]);
    const p = { tag, phone, cookie: r.cookie, regId: reg.lastID, email };
    people.push(p);
    return p;
  };
  const addedSignatories = [];
  try {
    console.log('\n== Settings ==');
    const s0 = (await call('GET', '/api/admin/certificates/settings', null, admin)).body;
    check('placeholder signatories to start with: chair, secretary, MMC observer',
      ['Organising Chairperson', 'Organising Secretary', 'MMC Observer'].every((d) => s0.signatories.some((s) => s.designation === d)));
    check('placeholder MMC details', /X/.test(s0.settings.mmc.accreditationNo) && s0.settings.mmc.points === 'X');
    check('MMC points for Doctors and Medical PGs', JSON.stringify(s0.settings.eligibleCategories) === '["faculty_mo","pg_doctor"]');
    const observer = s0.signatories.find((s) => s.designation === 'MMC Observer');
    check('the MMC observer signs the MMC certificate only', s0.templates.MMC.signatories.includes(observer.id)
      && !s0.templates.CONF.signatories.includes(observer.id) && !s0.templates.WORKSHOP.signatories.includes(observer.id));
    check('each kind has its wording', /\{\{council_reg_no\}\}/.test(s0.templates.MMC.body) && /\{\{mmc_points\}\}/.test(s0.templates.MMC.body)
      && /\{\{workshop\}\}/.test(s0.templates.WORKSHOP.body));
    const put = (b, who = admin) => call('PUT', '/api/admin/certificates/settings', b, who);
    check('hours must be times', (await put({ hours: { dayStart: '8am' } })).status === 400);
    check('...and an end after its start', (await put({ hours: { dayStart: '17:00', dayEnd: '08:00' } })).status === 400);
    const saved = await put({ mmc: { accreditationNo: `MMC/TEST/${N}`, points: '4' } });
    const s1 = (await call('GET', '/api/admin/certificates/settings', null, admin)).body;
    check('the MMC details are saved', saved.body.success === true && s1.settings.mmc.accreditationNo === `MMC/TEST/${N}` && s1.settings.mmc.points === '4');
    check('only certificate settings may change them', (await put({ mmc: { points: '9' } }, desk)).status === 403);

    const sig = await call('POST', '/api/admin/certificates/signatories', { name: `Dr Convenor ${N}`, designation: 'Workshop Convenor', signature: PNG }, admin);
    check('a signatory is added, with a signature', sig.body.success === true);
    addedSignatories.push(sig.body.id);
    check('a signature must be a PNG or JPEG', (await call('POST', '/api/admin/certificates/signatories', { name: 'X Y', designation: 'Z', signature: 'data:image/gif;base64,R0lGOD==' }, admin)).status === 400);
    const img = await call('GET', `/api/admin/certificates/signatories/${sig.body.id}/signature`, null, admin);
    check('...and its signature can be shown', img.status === 200);
    const tpl = await put({ templates: { WORKSHOP: { body: 'took part in **{{workshop}}**.', signatories: [sig.body.id] } } });
    const s2 = (await call('GET', '/api/admin/certificates/settings', null, admin)).body;
    check('a kind\'s wording and signatories are saved', tpl.body.success && s2.templates.WORKSHOP.body === 'took part in **{{workshop}}**.'
      && JSON.stringify(s2.templates.WORKSHOP.signatories) === `[${sig.body.id}]` && s2.templates.CONF.body === s0.templates.CONF.body);

    for (const kind of ['MMC', 'CONF', 'WORKSHOP']) {
      const pdf = await call('GET', `/api/admin/certificates/preview.pdf?kind=${kind}`, null, admin);
      check(`a ${kind} specimen is a PDF`, pdf.status === 200 && /application\/pdf/.test(pdf.headers['content-type']) && (pdf.buf || Buffer.from(pdf.raw || '')).slice(0, 4).toString() === '%PDF');
    }

    console.log('\n== Who qualifies ==');
    const doctor = await signUp('doc', 'faculty_mo', `CD${N}`);
    const worker = await signUp('chw', 'chw', `CW${N}`);
    const partial = await signUp('part', 'chw', `CP${N}`);
    const nocouncil = await signUp('nocn', 'faculty_mo', `CN${N}`);
    await db.run("UPDATE users SET council_name = 'Maharashtra Medical Council', council_reg_no = ? WHERE phone_number = ?", [`2010/01/${N}`, doctor.phone]);
    const events = (await call('GET', '/api/attendance/events', null, admin)).body.events;
    const dayKeys = events.filter((e) => e.scope === 'day').map((e) => e.e);
    const ws = events.find((e) => e.scope === 'workshop');
    check('fixture: two days, a sign-out, a workshop', dayKeys.length === 3 && !!ws, dayKeys);
    const attend = async (p, keys) => { for (const k of keys) await db.run("INSERT INTO attendance (phone_number, event_key, at, method) VALUES (?, ?, ?, 'MANUAL')", [p.phone, k, Date.now()]); };
    await attend(doctor, [...dayKeys, ws.e]);
    await attend(worker, dayKeys);
    await attend(nocouncil, dayKeys);
    await attend(partial, dayKeys.slice(0, 2));
    await db.run('INSERT INTO registration_options (registration_id, group_id, option_id, is_faculty) VALUES (?, (SELECT group_id FROM program_options WHERE id = ?), ?, 0)', [worker.regId, ws.optionId, ws.optionId]);

    const cand = async () => (await call('GET', '/api/admin/certificates/candidates', null, admin)).body.people;
    let list = await cand();
    const of = (p) => list.find((x) => x.phone === p.phone);
    check('a doctor who completed, with a council number: MMC', of(doctor).conference.kind === 'MMC');
    check('a health worker who completed: participation', of(worker).conference.kind === 'CONF');
    check('a doctor without a council number: participation, flagged', of(nocouncil).conference.kind === 'CONF' && of(nocouncil).mmcCategory && !of(nocouncil).councilRegNo);
    check('no sign-out: not yet, saying what is missing', of(partial).conference.kind === null && /Sign out/.test(of(partial).conference.whyNot));
    check('the workshop: due for the one who signed in', of(doctor).workshops.some((w) => w.e === ws.e && w.eligible));
    check('...not for one enrolled who did not', of(worker).workshops.some((w) => w.e === ws.e && !w.eligible && /Did not sign in/.test(w.whyNot)));
    await db.run("UPDATE registrations SET bank_status = 'PARTIAL_PAYMENT' WHERE id = ?", [worker.regId]);
    list = await cand();
    check('a balance still due: not yet', of(worker).conference.kind === null && /Payment/.test(of(worker).conference.whyNot));
    await db.run("UPDATE registrations SET bank_status = 'BANK_VERIFIED' WHERE id = ?", [worker.regId]);
    check('the desk cannot see who qualifies', (await call('GET', '/api/admin/certificates/candidates', null, desk)).status === 403
      && (await call('GET', '/api/admin/certificates/candidates', null, reviewer)).status === 403);

    console.log('\n== Overrides ==');
    const ov = (b) => call('POST', '/api/admin/certificates/override', b, admin);
    check('an override needs a reason', (await ov({ phone: partial.phone, scope: 'CONF', decision: 'INCLUDE' })).status === 400);
    await ov({ phone: partial.phone, scope: 'CONF', decision: 'INCLUDE', reason: 'Left early for an emergency; observer agreed' });
    await ov({ phone: worker.phone, scope: ws.e, decision: 'INCLUDE', reason: 'Signed the paper register' });
    list = await cand();
    check('included anyway: qualifies', of(partial).conference.kind === 'CONF' && of(partial).conference.override.decision === 'INCLUDE');
    check('...for a workshop too', of(worker).workshops.find((w) => w.e === ws.e).eligible === true);
    await ov({ phone: nocouncil.phone, scope: 'CONF', decision: 'EXCLUDE', reason: 'Duplicate account' });
    list = await cand();
    check('excluded: does not, with the reason', of(nocouncil).conference.kind === null && /Duplicate account/.test(of(nocouncil).conference.whyNot));

    console.log('\n== Issuing ==');
    const mine = new Set(people.map((p) => p.phone));
    const issue = (scope) => call('POST', '/api/admin/certificates/issue', { scope, phones: [...mine] }, admin);
    check('the desk cannot issue', (await call('POST', '/api/admin/certificates/issue', { scope: 'all' }, desk)).status === 403);
    const first = await issue('conference');
    check('the conference certificates are issued: one MMC, two participation', first.body.issued.MMC === 1 && first.body.issued.CONF === 2 && first.body.issued.WORKSHOP === 0, first.body);
    const again = await issue('conference');
    check('issuing again issues nothing twice', again.body.total === 0);
    const ws1 = await issue('workshops');
    check('the workshop certificates: the two due', ws1.body.issued.WORKSHOP === 2, ws1.body);
    const certs = await db.all(`SELECT * FROM certificates WHERE phone_number IN (${people.map(() => '?').join(',')}) ORDER BY id`, people.map((p) => p.phone));
    const dc = certs.find((c) => c.phone_number === doctor.phone && c.kind === 'MMC');
    check('numbered by kind', /\/MMC\/\d{4}$/.test(dc.cert_no) && certs.filter((c) => c.kind === 'CONF').every((c) => /\/P\/\d{4}$/.test(c.cert_no))
      && certs.filter((c) => c.kind === 'WORKSHOP').every((c) => /\/W\/\d{4}$/.test(c.cert_no)), certs.map((c) => c.cert_no));
    check('...each with its own verify code', new Set(certs.map((c) => c.verify_code)).size === certs.length && certs.every((c) => /^[A-Z2-9]{10}$/.test(c.verify_code)));
    check('the MMC one carries the council number, as it was', dc.council_reg_no === `2010/01/${N}` && dc.council_name === 'Maharashtra Medical Council');
    const prof = await db.get('SELECT salutation, full_name FROM users WHERE phone_number = ?', [doctor.phone]);
    check('the name is the one they would have printed: their salutation and name', dc.name === `${prof.salutation} ${prof.full_name}`, dc.name);
    const logged = await db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'CERTIFICATE_ISSUED' AND new_value LIKE ?", [`%${N}%`]);
    check('each is in the activity log', logged.n === certs.length);

    console.log('\n== The delegate ==');
    const myList = (await call('GET', '/api/certificates/mine', null, doctor.cookie)).body.certificates;
    check('they see their two', myList.length === 2 && myList.some((c) => c.kind === 'MMC') && myList.some((c) => /^Workshop: /.test(c.label)));
    const dl = await call('GET', `/api/certificates/mine/${dc.id}.pdf`, null, doctor.cookie);
    check('...and download one, as a PDF file', dl.status === 200 && /attachment/.test(dl.headers['content-disposition']) && /\.pdf"/.test(dl.headers['content-disposition']));
    check('nobody else can download it', (await call('GET', `/api/certificates/mine/${dc.id}.pdf`, null, worker.cookie)).status === 404);
    const lock = await call('PUT', '/api/attendance/me/certificate', { certificateName: 'Someone Else Entirely' }, doctor.cookie);
    check('once issued, their certificate details are locked', lock.status === 409 && /contact the organisers/.test(lock.body.error));
    check('...and their card says so', (await call('GET', '/api/attendance/me', null, doctor.cookie)).body.certificate.locked === true);
    const aud = (await call('GET', '/api/admin/reminders/audiences/certificates/recipients', null, admin)).body.recipients || [];
    check('the "Certificate issued" email reaches them', aud.some((r) => r.id === doctor.phone && r.detail.includes(dc.cert_no)));

    console.log('\n== Corrections and withdrawal ==');
    const fix = await call('PUT', `/api/admin/certificates/${dc.id}`, { name: `Dr Corrected Name ${N}` }, admin);
    const after = await db.get('SELECT name, cert_no, verify_code FROM certificates WHERE id = ?', [dc.id]);
    check('a name is corrected; the number and code stay', fix.body.success && after.name === `Dr Corrected Name ${N}` && after.cert_no === dc.cert_no && after.verify_code === dc.verify_code);
    const v = await call('GET', `/verify/${dc.verify_code}`);
    check('the verify page, open to anyone: valid, with the name and what it is for', v.status === 200 && /Valid certificate/.test(v.raw) && v.raw.includes(`Dr Corrected Name ${N}`) && /MMC points/.test(v.raw));
    check('...and nothing else about them', !v.raw.includes(doctor.email) && !v.raw.includes(doctor.phone));
    check('a withdrawal needs a reason', (await call('POST', `/api/admin/certificates/${dc.id}/revoke`, {}, admin)).status === 400);
    await call('POST', `/api/admin/certificates/${dc.id}/revoke`, { reason: 'Issued in error' }, admin);
    check('withdrawn: the verify page says so', /Withdrawn/.test((await call('GET', `/verify/${dc.verify_code}`)).raw));
    check('...and the delegate no longer has it', !(await call('GET', '/api/certificates/mine', null, doctor.cookie)).body.certificates.some((c) => c.id === dc.id));
    check('a code that is not one: not found', /Not found/.test((await call('GET', '/verify/NOSUCHCODE')).raw) && /Not found/.test((await call('GET', '/verify/x<script>')).raw));
    const reissue = await issue('conference');
    check('withdrawn, it can be issued again, with a new number', reissue.body.issued.MMC === 1
      && (await db.get("SELECT cert_no FROM certificates WHERE phone_number = ? AND kind = 'MMC' AND revoked_at IS NULL", [doctor.phone])).cert_no !== dc.cert_no);

    console.log('\n== The pages ==');
    const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
    const view = fs.readFileSync(appFile('views', 'admin', 'sections', 'attendance.ejs'), 'utf8');
    check('the tab has Attendance, Certificates and Certificate settings', ['data-att-view="attendance"', 'data-att-view="certificates"', 'data-att-view="settings"'].every((x) => view.includes(x)));
    check('issuing asks first', /async function issueCertificates\(scope\) \{[\s\S]{0,200}await showConfirm\(/.test(js));
    check('the portal card offers each download', /\/api\/certificates\/mine\/\$\{encodeURIComponent\(m\.id\)\}\.pdf/.test(js));
  } finally {
    const phones = people.map((p) => p.phone);
    if (phones.length) {
      const q = phones.map(() => '?').join(',');
      await db.run(`DELETE FROM certificates WHERE phone_number IN (${q})`, phones);
      await db.run(`DELETE FROM certificate_overrides WHERE phone_number IN (${q})`, phones);
      await db.run(`DELETE FROM attendance WHERE phone_number IN (${q})`, phones);
      await db.run(`DELETE FROM registration_options WHERE registration_id IN (${people.map(() => '?').join(',')})`, people.map((p) => p.regId));
      await db.run(`DELETE FROM registrations WHERE phone_number IN (${q})`, phones);
    }
    for (const id of addedSignatories) await db.run('DELETE FROM certificate_signatories WHERE id = ?', [id]);
    if (savedSettings) await db.run("UPDATE schema_meta SET value = ? WHERE key = 'certificate_settings'", [savedSettings.value]);
    else await db.run("DELETE FROM schema_meta WHERE key = 'certificate_settings'");
  }
  db.close();
  report();
})();
