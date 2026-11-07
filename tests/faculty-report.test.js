// The Faculty report (3 Nov 2026): the Faculty tab's list in Reports, one
// detail to a column, for whoever sees that tab; on A3 as a PDF, since it is
// wide.
const fs = require('fs');
const { call, adminLogin, loginPassword, ADMIN_PW, check, report, openDb, appFile } = require('./harness');

(async () => {
  const admin = await adminLogin();
  const desk = await loginPassword('9000000006', ADMIN_PW);
  const db = await openDb();
  const N = Date.now() % 100000;
  const made = [];
  try {
    // Two faculty typed in by name: one travelling and staying, one cancelled.
    const add = async (name, extra) => {
      const cols = { guest_name: name, created_at: Date.now(), ...extra };
      const r = await db.run(`INSERT INTO guests (${Object.keys(cols).join(', ')}) VALUES (${Object.keys(cols).map(() => '?').join(', ')})`, Object.values(cols));
      made.push(r.lastID);
    };
    await add(`Aaa Faculty ${N}`, { guest_designation: 'Professor', guest_phone: '+919812345678', guest_email: `fac${N}@example.test`,
      arrival_date: '2026-11-20', arrival_time: '21:30', arrival_mode: 'Flight', arrival_number: '6E 123', arrival_point: 'Nagpur airport',
      pickup_vehicle: 'Car 1', pickup_status: 'Confirmed', departure_date: '2026-11-22', departure_time: '16:00', drop_status: 'Not required',
      drop_vehicle: 'Car 9', accommodation: 'Guest House', room_no: '12', room_type: 'Double', checkin_date: '2026-11-20', checkout_date: '2026-11-22',
      special_needs: 'Vegetarian', overall_status: 'Confirmed' });
    await add(`Aab Faculty ${N}`, { accommodation: 'Guest House', room_no: '12', checkin_date: '2026-11-20', checkout_date: '2026-11-22', overall_status: 'Confirmed' });
    await add(`Aaa Cancelled ${N}`, { overall_status: 'Cancelled' });

    const rep = (await call('GET', '/api/admin/reports/faculty?format=json', null, admin)).body.report;
    const sec = rep.sections[0];
    const col = (name) => sec.columns.indexOf(name);
    check('named Faculty, one detail to a column', rep.title === 'Faculty' && ['Name', 'Designation', 'Institution', 'Mobile', 'Email', 'Reg No', 'Registration', 'Sessions',
      'Arrival', 'Arrival By', 'Arrival Point', 'Pickup', 'Departure', 'Departure By', 'Departure Point', 'Drop', 'Stay', 'Stay Dates', 'Sharing With',
      'Volunteers', 'Special Needs', 'Status'].every((c) => col(c) >= 0), sec.columns);
    const all = (await db.get('SELECT COUNT(*) AS n FROM guests')).n;
    check('every faculty member, cancelled ones too', sec.rows.length === all, [sec.rows.length, all]);
    const row = sec.rows.find((r) => r[0] === `Aaa Faculty ${N}`);
    check('who they are, typed in', row && row[col('Designation')] === 'Professor' && row[col('Email')] === `fac${N}@example.test` && row[col('Registration')] === 'Not signed up');
    check('how they come: when, by what, where, and the pickup', row[col('Arrival')] === '20 Nov 2026 09:30 pm' && row[col('Arrival By')] === 'Flight · 6E 123'
      && row[col('Arrival Point')] === 'Nagpur airport' && row[col('Pickup')] === 'Car 1 · Confirmed', [row[col('Arrival')], row[col('Arrival By')], row[col('Pickup')]]);
    check('...a drop not required says so, with no vehicle', row[col('Drop')] === 'Not required');
    check('where they stay, the dates and nights, and who with', row[col('Stay')] === 'Guest House · Room 12 · Double' && /^20 - 22 Nov 2026 · 2 nights$/.test(row[col('Stay Dates')])
      && row[col('Sharing With')] === `Aab Faculty ${N}`, [row[col('Stay')], row[col('Stay Dates')], row[col('Sharing With')]]);
    check('...special needs and status', row[col('Special Needs')] === 'Vegetarian' && row[col('Status')] === 'Confirmed');
    const names = sec.rows.map((r) => r[0]);
    check('cancelled ones come last', names.indexOf(`Aaa Cancelled ${N}`) > names.indexOf(`Aab Faculty ${N}`));

    const csv = await call('GET', '/api/admin/reports/faculty?format=csv', null, admin);
    check('the CSV has each detail in its own column', csv.status === 200 && csv.raw.split('\r\n')[0].startsWith('Name,Designation,Institution,Mobile,Email,Reg No,Registration,Sessions,Arrival,Arrival By'));
    const pdf = await call('GET', '/api/admin/reports/faculty?format=pdf', null, admin);
    check('the PDF is A3 landscape, for its many columns', pdf.status === 200 && /\/MediaBox \[0 0 1190\.5\d* 841\.8\d*\]/.test(String(pdf.raw)), String(pdf.raw).match(/\/MediaBox \[[^\]]*\]/));
    const narrow = await call('GET', '/api/admin/reports/badges?format=pdf', null, admin);
    check('...a narrow report stays A4', /\/MediaBox \[0 0 841\.8\d* 595\.2\d*\]/.test(String(narrow.raw)));
    check('the front desk, which does not see the Faculty tab, may not', (await call('GET', '/api/admin/reports/faculty?format=json', null, desk)).status === 403);
    const view = fs.readFileSync(appFile('views', 'admin', 'sections', 'reports.ejs'), 'utf8');
    check('listed under People', /id="report-faculty" data-report="faculty" onclick="openReport\('faculty'\)"/.test(view)
      && /'report-faculty': 'guests\.view'/.test(fs.readFileSync(appFile('public', 'app.js'), 'utf8')));
  } finally {
    for (const id of made) await db.run('DELETE FROM guests WHERE id = ?', [id]);
    db.close();
  }
  report();
})();
