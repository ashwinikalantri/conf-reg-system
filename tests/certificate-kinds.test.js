// The certificates, as the owner listed them (20 Nov 2026): delegates with
// MMC points, with Nursing points, or neither; workshop participants and
// workshop faculty; and from the programme, one per role naming the
// sessions -- speaker, judge, chairperson, moderator (apart from
// chairperson), panelist. No attendance for the roles; the Faculty
// certificate stays. Nursing waits until its details are set.
const { call, check, report, adminLogin, openDb } = require('./harness');

(async () => {
  const admin = await adminLogin();
  const db = openDb();
  const savedSettings = await db.get("SELECT value FROM schema_meta WHERE key = 'certificate_settings'");
  const made = { sessions: [], guests: [], hall: null, roster: null, override: null };
  try {
    const N = String(Date.now()).slice(-6);
    made.hall = (await call('POST', '/api/admin/programme/halls', { name: `Cert hall ${N}` }, admin)).body.id;
    const ws = await db.get(`SELECT o.id FROM program_options o JOIN program_groups g ON g.id = o.group_id WHERE g.name LIKE '%orkshop%' AND o.active = 1 ORDER BY o.id LIMIT 1`);
    const session = async (b) => {
      const id = (await call('POST', '/api/admin/programme/sessions', { hallId: made.hall, date: '2026-11-22', counts: true, ...b }, admin)).body.id;
      made.sessions.push(id);
      return id;
    };
    const talk = await session({ start: '09:00', end: '09:30', label: 'Session 1', title: `Test Talk ${N}` });
    const talk2 = await session({ start: '11:00', end: '11:30', label: 'Session 2', title: `Second Talk ${N}` });
    const panel = await session({ start: '10:00', end: '10:45', label: 'Panel Discussion 1', title: `Test Panel ${N}` });
    const award = await session({ start: '15:00', end: '15:30', label: 'Award Session', title: `Award Paper Presentation ${N}` });
    const wsSession = await session({ start: '08:00', end: '08:45', title: 'Workshop session', optionId: ws.id });
    const guest = async (name) => {
      const id = (await db.run("INSERT INTO guests (guest_name, overall_status, created_at) VALUES (?, 'Confirmed', ?)", [name, Date.now()])).lastID;
      made.guests.push(id);
      return id;
    };
    const A = await guest(`Dr Alpha ${N}`);
    const B = await guest(`Dr Beta ${N}`);
    const role = (session_id, r, guest_id, position = 0) => db.run('INSERT INTO programme_session_faculty (session_id, role, position, guest_id) VALUES (?, ?, ?, ?)', [session_id, r, position, guest_id]);
    await role(talk, 'speaker', A); await role(talk2, 'speaker', A); await role(panel, 'speaker', A); await role(award, 'chair', A);
    await role(talk, 'chair', B); await role(panel, 'chair', B); await role(wsSession, 'speaker', B);
    // A registered delegate on the workshop's roster as faculty.
    const rosterReg = await db.get(`SELECT r.id, r.phone_number FROM registrations r WHERE r.bank_status = 'BANK_VERIFIED'
      AND NOT EXISTS (SELECT 1 FROM registration_options x WHERE x.registration_id = r.id AND x.option_id = ?) ORDER BY r.id LIMIT 1`, [ws.id]);
    const wsGroup = await db.get('SELECT group_id FROM program_options WHERE id = ?', [ws.id]);
    await db.run('INSERT INTO registration_options (registration_id, group_id, option_id, is_faculty) VALUES (?, ?, ?, 1)', [rosterReg.id, wsGroup.group_id, ws.id]);
    made.roster = { reg: rosterReg.id, option: ws.id };

    console.log('\n== Who gets which ==');
    let people = (await call('GET', '/api/admin/certificates/candidates', null, admin)).body.people;
    const of = (key) => people.find((p) => p.phone === key);
    const a = of(`faculty-${A}`);
    const b = of(`faculty-${B}`);
    const kinds = (p) => p.roles.map((r) => r.kind).join();
    check('a speaker in two talks: one Speaker certificate naming both, in order', a.roles.find((r) => r.kind === 'SPEAKER').sessions.join('|') === `Test Talk ${N}|Second Talk ${N}`);
    check('...a panel\'s speaker is a Panelist; a judged session\'s chair a Judge', kinds(a) === 'SPEAKER,JUDGE,PANELIST', kinds(a));
    check('a chair is a Chairperson; a panel\'s chair a Moderator, apart', kinds(b) === 'CHAIR,MODERATOR', kinds(b));
    check('a workshop\'s facilitator in the programme is its Workshop faculty, not a speaker', b.workshopFaculty.length === 1 && b.workshopFaculty[0].optionId === ws.id && !b.roles.some((r) => r.sessions.includes('Workshop session')));
    check('...and so is one on its roster as faculty', of(rosterReg.phone_number).workshopFaculty.some((w) => w.optionId === ws.id));
    check('no attendance needed for any of them', a.roles.every((r) => r.eligible) && b.workshopFaculty[0].eligible);
    check('the Faculty certificate stays', !!a.faculty && a.faculty.eligible);

    console.log('\n== Withholding one ==');
    check('a role cannot be included by hand -- it comes from the programme', (await call('POST', '/api/admin/certificates/override', { phone: `faculty-${A}`, scope: 'role:SPEAKER', decision: 'INCLUDE', reason: 'x' }, admin)).status === 400);
    const ex = await call('POST', '/api/admin/certificates/override', { phone: `faculty-${A}`, scope: 'role:JUDGE', decision: 'EXCLUDE', reason: 'Did not come' }, admin);
    check('...but can be withheld, with a reason', ex.body.success, ex.body);

    console.log('\n== Issuing ==');
    const issued = (await call('POST', '/api/admin/certificates/issue', { scope: 'roles', phones: [`faculty-${A}`, `faculty-${B}`] }, admin)).body;
    check('the roles are issued, the withheld one not', issued.success && issued.issued.SPEAKER === 1 && issued.issued.PANELIST === 1 && issued.issued.JUDGE === 0
      && issued.issued.CHAIR === 1 && issued.issued.MODERATOR === 1, issued.issued);
    const wf = (await call('POST', '/api/admin/certificates/issue', { scope: 'workshop_faculty', phones: [`faculty-${B}`] }, admin)).body;
    check('workshop faculty issued', wf.success && wf.issued.WORKSHOP_FACULTY === 1, wf.issued);
    const rows = await db.all("SELECT kind, cert_no, detail, workshop_name FROM certificates WHERE phone_number IN (?, ?) ORDER BY id", [`faculty-${A}`, `faculty-${B}`]);
    const sp = rows.find((r) => r.kind === 'SPEAKER');
    check('each numbered in its own series', /\/S\/\d{4}$/.test(sp.cert_no) && /\/PN\/\d{4}$/.test(rows.find((r) => r.kind === 'PANELIST').cert_no)
      && /\/MO\/\d{4}$/.test(rows.find((r) => r.kind === 'MODERATOR').cert_no) && /\/WF\/\d{4}$/.test(rows.find((r) => r.kind === 'WORKSHOP_FACULTY').cert_no), rows.map((r) => r.cert_no));
    check('the Speaker certificate names its sessions as issued', sp.detail === `**“Test Talk ${N}”** and **“Second Talk ${N}”**`, sp.detail);
    const id = (await db.get('SELECT id FROM certificates WHERE cert_no = ?', [sp.cert_no])).id;
    const pdf = await call('GET', `/api/admin/certificates/${id}.pdf`, null, admin);
    check('it draws', pdf.status === 200 && /application\/pdf/.test(pdf.headers['content-type']));
    people = (await call('GET', '/api/admin/certificates/candidates', null, admin)).body.people;
    check('once issued, it shows as issued', people.find((p) => p.phone === `faculty-${A}`).roles.find((r) => r.kind === 'SPEAKER').issued);

    console.log('\n== Nursing points ==');
    const nurse = await db.get(`SELECT r.phone_number FROM registrations r JOIN users u ON u.phone_number = r.phone_number
      WHERE r.category_key IN ('nursing_pg', 'nurse_cho') AND r.bank_status = 'BANK_VERIFIED' ORDER BY r.id LIMIT 1`);
    await call('POST', '/api/admin/certificates/override', { phone: nurse.phone_number, scope: 'CONF', decision: 'INCLUDE', reason: 'Test' }, admin);
    made.override = nurse.phone_number;
    const conf = async () => (await call('GET', '/api/admin/certificates/candidates', null, admin)).body.people.find((p) => p.phone === nurse.phone_number).conference;
    let c = await conf();
    check('a nurse waits for the Nursing details -- not given participation meanwhile', c.kind === null && /Nursing points details/.test(c.whyNot || ''), c);
    const set = await call('PUT', '/api/admin/certificates/settings', { nursing: { accreditationNo: 'MNC/CNE/TEST', points: '2' } }, admin);
    c = await conf();
    check('once set, their certificate is the Nursing one', set.body.success && c.kind === 'NURSING', c);
    const s = (await call('GET', '/api/admin/certificates/settings', null, admin)).body;
    check('settings: the council, number, points and categories', s.settings.nursing.councilLabel === 'Maharashtra Nursing Council' && s.settings.nursing.points === '2'
      && s.settings.nursing.categories.includes('nurse_cho') && !!s.templates.NURSING && /\{\{nursing_points\}\}/.test(s.templates.NURSING.body));
    check('every type has its wording to edit', ['MMC', 'NURSING', 'CONF', 'WORKSHOP', 'WORKSHOP_FACULTY', 'FACULTY', 'SPEAKER', 'JUDGE', 'CHAIR', 'MODERATOR', 'PANELIST'].every((k) => s.templates[k] && s.kinds[k]));
    const spec = await call('GET', '/api/admin/certificates/preview.pdf?kind=MODERATOR', null, admin);
    check('...and a specimen of each', spec.status === 200 && /application\/pdf/.test(spec.headers['content-type']));
  } finally {
    await db.run(`DELETE FROM certificates WHERE phone_number LIKE 'faculty-%' AND guest_id IN (${made.guests.map(() => '?').join(',') || 'NULL'})`, made.guests);
    for (const g of made.guests) await db.run('DELETE FROM certificates WHERE phone_number = ?', [`faculty-${g}`]);
    await db.run("DELETE FROM certificate_overrides WHERE reason IN ('Did not come', 'Test')");
    if (made.sessions.length) {
      await db.run(`DELETE FROM programme_session_faculty WHERE session_id IN (${made.sessions.map(() => '?').join(',')})`, made.sessions);
      await db.run(`DELETE FROM programme_sessions WHERE id IN (${made.sessions.map(() => '?').join(',')})`, made.sessions);
    }
    if (made.hall) await db.run('DELETE FROM halls WHERE id = ?', [made.hall]);
    for (const g of made.guests) await db.run('DELETE FROM guests WHERE id = ?', [g]);
    if (made.roster) await db.run('DELETE FROM registration_options WHERE registration_id = ? AND option_id = ?', [made.roster.reg, made.roster.option]);
    if (savedSettings) await db.run("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('certificate_settings', ?)", [savedSettings.value]);
    else await db.run("DELETE FROM schema_meta WHERE key = 'certificate_settings'");
    db.close();
  }
  report();
})();
