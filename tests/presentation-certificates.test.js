// Presentation certificates (owner, 22 Nov 2026): Review Desk Step 6 marks
// each oral, e-poster and award paper Presented or Absent; once a kind is
// finalised, each presenting author marked Presented (and paid) gets a
// Certificate of Presentation -- except a prize winner, who gets the prize
// certificate only. Finalised marks are locked; a super admin may reopen a
// kind while none of its certificates is out.
const { call, check, report, ADMIN_PW, adminLogin, loginPassword, appFile, openDb } = require('./harness');
const fs = require('fs');

const N = String(Date.now()).slice(-6);

(async () => {
  const admin = await adminLogin();
  const desk = await loginPassword('9000000006', ADMIN_PW);
  const db = openDb();
  const phones = [];
  const ids = [];
  const finalisedBefore = await db.all('SELECT * FROM presentation_attendance_final');
  const marksBefore = new Set((await db.all('SELECT abstract_id FROM presentation_attendance')).map((m) => m.abstract_id));
  try {
    await db.run("DELETE FROM presentation_attendance_final WHERE format = 'ORAL'");
    // Two presenters, registered and paid, each with an accepted oral paper.
    const presenter = async (i) => {
      const email = `pres-${N}-${i}@example.test`;
      const otp = await call('POST', '/api/otp/request', { destination: email });
      const r = await call('POST', '/api/auth/register', { salutation: 'Dr', age: '35', gender: 'Female', designation: 'Lecturer', institute: 'Test College', pincode: '442102',
        state: 'Maharashtra', district: 'Wardha', name: `Presenter ${N} ${i}`, country: 'United Kingdom', email, emailOtp: otp.body.devOtp, password: 'testpass123' });
      const phone = r.body.user.phone_number;
      phones.push(phone);
      await db.run(`INSERT INTO registrations (phone_number, delegate_name, category_key, category_label, bank_status, registration_number)
        VALUES (?, ?, 'chw', 'Frontline Health Worker', 'BANK_VERIFIED', ?)`, [phone, `Presenter ${N} ${i}`, `PRS${N}${i}`]);
      const a = await db.run(`INSERT INTO abstracts (phone_number, author_name, format, title, text, word_count, status, allocation, decision_sent_at)
        VALUES (?, ?, 'Oral', ?, 'Body', 100, 'ACCEPTED', 'ORAL', ?)`, [phone, `Presenter ${N} ${i}`, `Paper ${N} ${i}`, Date.now()]);
      ids.push(a.lastID);
      return { phone, id: a.lastID };
    };
    const one = await presenter(1);
    const two = await presenter(2);
    const me = async (p) => (await call('GET', '/api/admin/certificates/candidates', null, admin)).body.people.find((x) => x.phone === p.phone);

    console.log('\n== Step 6 ==');
    const list = (await call('GET', '/api/admin/presentation-attendance?format=ORAL', null, admin)).body;
    const papers = list.groups.flatMap((g) => g.papers);
    check('the oral papers, in running order, each unmarked', list.success && papers.some((p) => p.id === one.id && p.presented === null) && list.counts.unmarked >= 2, list.counts);
    const c0 = (await me(one)).presentations[0];
    check('not finalised: the certificate is not yet due, and says why', c0 && !c0.eligible && c0.whyNot === 'Presentation attendance not finalised yet', c0);
    check('finalising waits for every paper to be marked', (await call('POST', '/api/admin/presentation-attendance/finalise', { format: 'ORAL' }, admin)).status === 400);
    check('the desk cannot mark', (await call('PUT', '/api/admin/presentation-attendance', { abstractId: one.id, presented: true }, desk)).status === 403);
    check('...a mark must be Presented or Absent', (await call('PUT', '/api/admin/presentation-attendance', { abstractId: one.id, presented: 'yes' }, admin)).status === 400);
    await call('PUT', '/api/admin/presentation-attendance', { abstractId: one.id, presented: true }, admin);
    await call('PUT', '/api/admin/presentation-attendance', { abstractId: two.id, presented: false }, admin);
    // Any other oral papers in the fixture: marked absent here, put back after.
    for (const p of papers) if (p.presented === null && !ids.includes(p.id)) await db.run('INSERT OR IGNORE INTO presentation_attendance (abstract_id, presented, marked_by, marked_at) VALUES (?, 0, ?, ?)', [p.id, 'test', Date.now()]);
    const marked = (await call('GET', '/api/admin/presentation-attendance?format=ORAL', null, admin)).body;
    check('marked: counted', marked.counts.unmarked === 0 && marked.counts.presented >= 1 && marked.counts.absent >= 1, marked.counts);
    const fin = await call('POST', '/api/admin/presentation-attendance/finalise', { format: 'ORAL' }, admin);
    check('finalised once every paper is marked', fin.body.success && !!(await db.get("SELECT 1 AS y FROM presentation_attendance_final WHERE format = 'ORAL'")), fin.body);
    check('...after which the marks are locked', (await call('PUT', '/api/admin/presentation-attendance', { abstractId: two.id, presented: true }, admin)).status === 409);

    console.log('\n== The certificates ==');
    const c1 = (await me(one)).presentations[0];
    check('presented: due', c1.eligible && !c1.whyNot && c1.label === 'Oral Paper Presentation', c1);
    check('absent: not, saying so', (await me(two)).presentations[0].whyNot === 'Marked absent');
    const prev = await call('GET', `/api/admin/certificates/person-preview.pdf?phone=${encodeURIComponent(one.phone)}&cert=PRESENTATION:${one.id}`, null, admin);
    check('a preview of theirs, and a specimen', prev.status === 200 && (await call('GET', '/api/admin/certificates/preview.pdf?kind=PRESENTATION', null, admin)).status === 200);
    const iss = await call('POST', '/api/admin/certificates/issue', { scope: 'presentations', phones: [one.phone, two.phone] }, admin);
    check('issued from a Presentations row: the one who presented only', iss.body.success && iss.body.issued.PRESENTATION === 1 && iss.body.total === 1, iss.body);
    const row = await db.get("SELECT * FROM certificates WHERE kind = 'PRESENTATION' AND phone_number = ?", [one.phone]);
    check('...numbered PS, naming the paper and the kind', row && /\/PS\/\d{4}$/.test(row.cert_no) && JSON.parse(row.detail).format === 'ORAL' && row.workshop_name === `Paper ${N} 1`, row);
    check('reopening is refused while its certificates are out', (await call('POST', '/api/admin/presentation-attendance/reopen', { format: 'ORAL' }, admin)).status === 409);
    check('...and never by anyone but a super admin', (await call('POST', '/api/admin/presentation-attendance/reopen', { format: 'ORAL' }, desk)).status === 403);
    const prize = await call('PUT', '/api/admin/prizes', { format: 'ORAL', rank: 3, abstractId: one.id }, admin);
    check('a paper whose presentation certificate is out cannot then win a prize until it is withdrawn', prize.status === 409 && /prize certificate only/.test(prize.body.error), prize.body);
    await call('POST', `/api/admin/certificates/${row.id}/revoke`, { reason: 'Test' }, admin);
    const re = await call('POST', '/api/admin/presentation-attendance/reopen', { format: 'ORAL' }, admin);
    check('withdrawn: a super admin can reopen', re.body.success, re.body);

    console.log('\n== Prize winners ==');
    const saved = await db.get("SELECT * FROM presentation_prizes WHERE format = 'ORAL' AND rank = 3");
    await db.run("DELETE FROM presentation_prizes WHERE format = 'ORAL' AND rank = 3");
    await call('PUT', '/api/admin/prizes', { format: 'ORAL', rank: 3, abstractId: one.id }, admin);
    check('a prize winner gets the prize certificate only: no presentation line', (await me(one)).presentations.length === 0 && (await me(one)).prizes.length === 1);
    await db.run("DELETE FROM presentation_prizes WHERE format = 'ORAL' AND rank = 3");
    if (saved) await db.run('INSERT INTO presentation_prizes (format, rank, abstract_id, set_by, set_at) VALUES (?, ?, ?, ?, ?)', [saved.format, saved.rank, saved.abstract_id, saved.set_by, saved.set_at]);

    const ejs = fs.readFileSync(appFile('views', 'admin', 'sections', 'abstracts.ejs'), 'utf8');
    const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
    check('the desk: Step 6 Attendance, Zenodo Step 7', /\['6', 'Attendance'\], \['7', 'Zenodo'\]/.test(ejs) && /id="abstracts-attendance-block" class="abs-panel" data-step="6"/.test(ejs));
    check('the Certificates page: a Presentations row, and its wording in settings', /\['presentations', 'Presentations', /.test(js) && /\['Presentations', \['PRESENTATION'\]\]/.test(js));
  } finally {
    for (const p of phones) {
      await db.run('DELETE FROM certificates WHERE phone_number = ?', [p]);
      await db.run('DELETE FROM registrations WHERE phone_number = ?', [p]);
    }
    for (const id of ids) await db.run('DELETE FROM abstracts WHERE id = ?', [id]);
    const after = await db.all('SELECT abstract_id FROM presentation_attendance');
    for (const m of after) if (!marksBefore.has(m.abstract_id)) await db.run('DELETE FROM presentation_attendance WHERE abstract_id = ?', [m.abstract_id]);
    await db.run('DELETE FROM presentation_attendance_final');
    for (const f of finalisedBefore) await db.run('INSERT INTO presentation_attendance_final (format, finalised_by, finalised_at) VALUES (?, ?, ?)', [f.format, f.finalised_by, f.finalised_at]);
    db.close();
  }
  report();
})();
