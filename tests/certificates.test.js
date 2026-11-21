// E-certificates: who qualifies for which, issuing, the delegate's download,
// corrections, withdrawal and the public verify page.
//
//   * MMC: completed (in on every day, out on the last), paid, a Doctor or
//     Medical PG, and a council number given. CONF: completed and paid.
//     WORKSHOP: signed in at it, paid, and its feedback given (17 Nov 2026).
//     An admin may include or exclude
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
  const madeHalls = [];
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
    check('lunch must be a time', (await put({ attendance: { lunchSplit: '1pm' } })).status === 400);
    check('...and the minutes before a session, 0 to 60', (await put({ attendance: { earlyMinutes: 90 } })).status === 400);
    check('...both are saved', (await put({ attendance: { lunchSplit: '13:30', earlyMinutes: 10 } })).body.success
      && (await call('GET', '/api/admin/certificates/settings', null, admin)).body.settings.attendance.lunchSplit === '13:30');
    await put({ attendance: { lunchSplit: '13:00', earlyMinutes: 15 } });
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
    // A programme of the test's own: a morning and an afternoon session, and
    // a workshop's.
    const hall = (await call('POST', '/api/admin/programme/halls', { name: `Cert Hall ${N}` }, admin)).body.id;
    madeHalls.push(hall);
    const wsOpt = await db.get("SELECT o.id, o.name FROM program_options o JOIN program_groups g ON g.id = o.group_id WHERE g.name = 'Workshops' AND o.active = 1 LIMIT 1");
    const day = '2099-03-02';
    const sess = async (b) => (await call('POST', '/api/admin/programme/sessions', { hallId: hall, date: day, counts: true, ...b }, admin)).body.id;
    const am = await sess({ start: '09:30', end: '10:00', title: `Morning ${N}` });
    const pm = await sess({ start: '14:30', end: '15:00', title: `Afternoon ${N}` });
    const wsSession = await sess({ date: '2099-03-01', start: '09:00', end: '16:30', title: `Workshop ${N}`, optionId: wsOpt.id });
    const dayKeys = [`s:${am}`, `s:${pm}`];
    const ws = { e: `ws:${wsOpt.id}`, optionId: wsOpt.id, key: `s:${wsSession}` };
    check('fixture: a morning, an afternoon and a workshop', !!(am && pm && wsSession));
    const attend = async (p, keys) => { for (const k of keys) await db.run("INSERT INTO attendance (phone_number, event_key, at, method) VALUES (?, ?, ?, 'MANUAL')", [p.phone, k, Date.now()]); };
    await attend(doctor, [...dayKeys, ws.key]);
    await attend(worker, dayKeys);
    // nocouncil attends no session at all: checked in is enough.
    await attend(partial, dayKeys.slice(0, 1));
    // The conference certificate asks for a check-in at the desk, not
    // session attendance (owner, 20 Nov 2026): three checked in, one not.
    await db.run('UPDATE registrations SET checked_in_at = ?, checked_in_by = ? WHERE id IN (?, ?, ?)', [Date.now(), 'Test desk', doctor.regId, worker.regId, nocouncil.regId]);
    await db.run('INSERT INTO registration_options (registration_id, group_id, option_id, is_faculty) VALUES (?, (SELECT group_id FROM program_options WHERE id = ?), ?, 0)', [worker.regId, ws.optionId, ws.optionId]);

    const cand = async () => (await call('GET', '/api/admin/certificates/candidates', null, admin)).body.people;
    let list = await cand();
    const of = (p) => list.find((x) => x.phone === p.phone);
    check('a doctor who completed, with a council number: MMC', of(doctor).conference.kind === 'MMC');
    check('a health worker who completed: participation', of(worker).conference.kind === 'CONF');
    // Every Doctor and Medical PG gets MMC (owner, 21 Nov 2026): no council number needed.
    check('a doctor without a council number: MMC all the same -- and no session attended, checked in is enough', of(nocouncil).conference.kind === 'MMC' && of(nocouncil).mmcCategory && !of(nocouncil).councilRegNo
      && of(nocouncil).attended.length === 0);
    console.log('\n== The settings page: live preview and who qualifies (20 Nov) ==');
    const sd = (await call('GET', '/api/admin/certificates/settings', null, admin)).body;
    check('each kind says how many qualify today, with their names for the preview', sd.due && sd.due.MMC.people.some((x) => x.phone === doctor.phone)
      && sd.due.CONF.people.some((x) => x.phone === worker.phone) && !sd.due.CONF.people.some((x) => x.phone === partial.phone) && typeof sd.due.JUDGE.count === 'number');
    const pv = await call('POST', '/api/admin/certificates/preview.pdf', { kind: 'MMC', draft: { title: 'Draft Title', body: 'x {{name}}', signatories: [] }, phone: doctor.phone }, admin);
    check('the live preview: a PDF of the wording on screen, for a real person, nothing saved', pv.status === 200 && /application\/pdf/.test(pv.headers['content-type'])
      && (pv.buf || Buffer.from(pv.raw || '')).slice(0, 4).toString() === '%PDF'
      && (await call('GET', '/api/admin/certificates/settings', null, admin)).body.templates.MMC.title !== 'Draft Title');
    check('...only for those who may change the wording', (await call('POST', '/api/admin/certificates/preview.pdf', { kind: 'MMC' }, desk)).status === 403);

    check('not checked in at the desk: not yet, saying so -- whatever sessions they attended', of(partial).conference.kind === null && /Not checked in at the registration desk/.test(of(partial).conference.whyNot), of(partial).conference.whyNot);
    // Feedback needed again since 21 Nov 2026 (it was attendance alone for a day).
    check('the workshop: present and paid, feedback not yet given -- not due, saying so', of(doctor).workshops.some((w) => w.e === ws.e && !w.eligible && w.whyNot === 'Feedback not given yet' && w.feedback === false));
    check('...not for one enrolled who was not there', of(worker).workshops.some((w) => w.e === ws.e && !w.eligible && /Not marked present/.test(w.whyNot)));

    console.log('\n== Workshop feedback ==');
    {
      const F = require('../workshop-feedback');
      check('three ratings, 1 to 5, are needed; suggestions are optional', !F.check({ relevance: 5, facilitation: 4, usefulness: 3 }).error
        && F.check({ relevance: 5, facilitation: 4, usefulness: 3 }).values.suggestions === null
        && /Quality of facilitation/.test(F.check({ relevance: 5, usefulness: 3 }).error)
        && !!F.check({ relevance: 6, facilitation: 4, usefulness: 3 }).error && !!F.check({ relevance: 2.5, facilitation: 4, usefulness: 3 }).error);
      const sum = F.summarise([{ relevance: 5, facilitation: 4, usefulness: 3 }, { relevance: 4, facilitation: 4, usefulness: 1 }]);
      check('...summed up per question: how many, the average, each rating', sum[0].n === 2 && sum[0].mean === 4.5 && sum[0].counts.join() === '0,0,0,1,1'
        && sum[2].mean === 2 && sum.map((q) => q.label).join('|') === 'Relevance of content|Quality of facilitation|Usefulness in your professional practice');
    }
    const me = async (p) => (await call('GET', '/api/attendance/me', null, p.cookie)).body;
    const mine0 = (await me(doctor)).workshops.find((w) => Number(w.optionId) === ws.optionId);
    const form = (await me(doctor)).feedbackForm;
    check('the delegate is asked for it once marked present', mine0 && mine0.present && mine0.feedbackAt === null
      && form.questions.length === 3 && form.scale.map((x) => x.label).join() === 'Poor,Fair,Good,Very good,Excellent', { mine0, form });
    const pending = async () => (await call('GET', '/api/admin/reminders/audiences/workshop_feedback/recipients', null, admin)).body.recipients || [];
    const waiting = (await pending()).find((x) => x.id === doctor.phone);
    check('...and is on the "Workshop feedback pending" list, with the workshop named', !!waiting && waiting.detail.includes(`CD${N}`));
    check('...but not one who was not there', !(await pending()).some((x) => x.id === worker.phone));
    const give = (p, b) => call('POST', '/api/attendance/me/workshop-feedback', { optionId: ws.optionId, ...b }, p.cookie);
    const absent = await give(worker, { relevance: 5, facilitation: 5, usefulness: 5 });
    check('someone not marked present cannot give it', absent.status === 400 && /marked present/.test(absent.body.error), absent.body);
    const half = await give(doctor, { relevance: 5, facilitation: 4 });
    check('every rating is needed', half.status === 400 && /Usefulness/.test(half.body.error), half.body);
    const given = await give(doctor, { relevance: 5, facilitation: 4, usefulness: 3, suggestions: '  More time for the hands-on part <b>please</b>  ' });
    check('three ratings and a suggestion are received', given.body.success === true, given.body);
    const twice = await give(doctor, { relevance: 1, facilitation: 1, usefulness: 1 });
    check('...once: it cannot be changed', twice.status === 409);
    const stored = await db.get('SELECT * FROM workshop_feedback WHERE phone_number = ? AND option_id = ?', [doctor.phone, ws.optionId]);
    check('...kept as given, the suggestion trimmed', stored.relevance === 5 && stored.usefulness === 3 && stored.suggestions === 'More time for the hands-on part <b>please</b>');
    check('the card goes, once given', !!(await me(doctor)).workshops.find((w) => Number(w.optionId) === ws.optionId).feedbackAt);
    check('...and they leave the pending list', !(await pending()).some((x) => x.id === doctor.phone));
    list = await cand();
    check('the workshop certificate due once the feedback is in', of(doctor).workshops.some((w) => w.e === ws.e && w.eligible && !w.whyNot && w.feedback === true));
    check('the front desk cannot read the feedback', (await call('GET', '/api/admin/reports/workshop-feedback?format=json', null, desk)).status === 403);
    const rep = (await call('GET', '/api/admin/reports/workshop-feedback?format=json', null, admin)).body.report;
    const ratings = rep.sections.find((x) => x.name.endsWith('present responded)') && x.rows.some((r) => r[1] > 0) && x.name.includes('1 of'));
    const responses = rep.sections.find((x) => x.name.endsWith(': responses') && x.rows.some((r) => r[0] === `CD${N}`));
    check('the report sums each workshop up', !!ratings && ratings.rows[0][0] === 'Relevance of content' && ratings.rows[0][2] === '5.0' && ratings.columns.includes('5 Excellent'), ratings);
    check('...and lists each response by registration number, never a name', !!responses && responses.columns[0] === 'Reg No'
      && responses.rows.some((r) => r[4] === 'More time for the hands-on part <b>please</b>')
      && !JSON.stringify(rep).includes(`Cert doc ${N}`), responses);
    const html = (await call('GET', '/api/admin/reports/workshop-feedback', null, admin)).raw;
    check('...with a suggestion shown as text, not markup', html.includes('&lt;b&gt;please&lt;/b&gt;') && !html.includes('<b>please</b>'));
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
    const certView = fs.readFileSync(appFile('views', 'admin', 'sections', 'certificates.ejs'), 'utf8');
    const setView = fs.readFileSync(appFile('views', 'admin', 'partials', 'certificate-settings.ejs'), 'utf8');
    const setup = fs.readFileSync(appFile('views', 'admin', 'sections', 'general.ejs'), 'utf8');
    const navTabs = fs.readFileSync(appFile('views', 'admin', 'partials', 'nav-tabs.ejs'), 'utf8');
    const adminHeader = fs.readFileSync(appFile('views', 'admin', 'partials', 'header.ejs'), 'utf8');
    check('Certificates are a page under Settings › Conference, their settings a card in Conference setup (1 Nov)',
      /<section id="section-certificates"/.test(certView) && /id="cert-list"/.test(certView) && /id="gs-card-certificates" class="hidden space-y-4"/.test(setView) && /id="cs-pane"/.test(setView) && /id="cs-rail-select"/.test(setView)
      && !navTabs.includes('certificates')
      && /id="settings-group-conference"[\s\S]*?id="settings-item-certificates" onclick="selectSettingsTab\('certificates'\)"[\s\S]*?id="settings-group-fees"/.test(adminHeader)
      && !adminHeader.includes('certsettings')
      && /id="gs-jump-certificates" data-target="gs-card-certificates"/.test(setup) && /include\('\.\.\/partials\/certificate-settings'\)/.test(setup)
      && /certsettings: 'general'/.test(js)
      && !/data-att-view|att-view-certificates|att-view-settings/.test(view));
    check('certificate settings alone opens Conference setup, showing only that card', require(appFile('permissions.js')).SECTION_PERMISSIONS.general.anyOf.includes('certificates.manage')
      && /const full = can\('system\.settings_view'\);[\s\S]{0,400}?card\.classList\.toggle\('hidden', !full\)[\s\S]{0,300}?if \(!full\) return;/.test(js));
    check('issuing asks first', /async function issueCertificates\(scope\) \{[\s\S]{0,200}await showConfirm\(/.test(js));
    check('the portal card offers each download', /\/api\/certificates\/mine\/\$\{encodeURIComponent\(m\.id\)\}\.pdf/.test(js));
  } finally {
    const phones = people.map((p) => p.phone);
    if (phones.length) {
      const q = phones.map(() => '?').join(',');
      await db.run(`DELETE FROM certificates WHERE phone_number IN (${q})`, phones);
      await db.run(`DELETE FROM certificate_overrides WHERE phone_number IN (${q})`, phones);
      await db.run(`DELETE FROM workshop_feedback WHERE phone_number IN (${q})`, phones);
      await db.run(`DELETE FROM attendance WHERE phone_number IN (${q})`, phones);
      await db.run(`DELETE FROM registration_options WHERE registration_id IN (${people.map(() => '?').join(',')})`, people.map((p) => p.regId));
      await db.run(`DELETE FROM registrations WHERE phone_number IN (${q})`, phones);
    }
    for (const id of addedSignatories) await db.run('DELETE FROM certificate_signatories WHERE id = ?', [id]);
    for (const id of madeHalls) {
      await db.run('DELETE FROM programme_sessions WHERE hall_id = ?', [id]);
      await db.run('DELETE FROM halls WHERE id = ?', [id]);
    }
    if (savedSettings) await db.run("UPDATE schema_meta SET value = ? WHERE key = 'certificate_settings'", [savedSettings.value]);
    else await db.run("DELETE FROM schema_meta WHERE key = 'certificate_settings'");
  }
  db.close();
  report();
})();
