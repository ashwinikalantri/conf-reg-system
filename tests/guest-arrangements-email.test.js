// The travel & stay email (owner, 20 Nov 2026): one faculty member's
// arrangements, sent only when someone presses Email on their row and then
// Send in the popup -- never by itself. Once sent, a badge; once their
// travel or stay changes after it, the badge says so.
const fs = require('fs');
const G = require('../guests');
const { call, check, report, adminLogin, openDb, appFile } = require('./harness');

(async () => {
  console.log('\n== What it says ==');
  const g = { name: 'Dr <b>Rao</b>', arrival_date: '2026-11-21', arrival_time: '14:05', arrival_mode: 'Flight', arrival_number: '6E 512', arrival_point: 'Nagpur Airport',
    pickup_vehicle: 'Kia Carens', pickup_driver: 'Ravi', pickup_status: 'Assigned', accommodation: 'Yatri Nivas', room_no: '12',
    departure_date: '2026-11-22', departure_time: '18:30', departure_point: 'Wardha Station', drop_status: 'Not required' };
  const mail = G.arrangementsEmail(g, { drivers: [{ name: 'Ravi', phone: '+919800011111' }], contacts: [{ role: 'travel', name: 'Tara', phone: '+919800022222' }], conference: 'NQOCN 2026' });
  const text = mail.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  check('a subject naming the conference', mail.subject === 'Your travel and stay for NQOCN 2026', mail.subject);
  check('arriving: the day, time, flight and place', /Saturday, 21 November, 2:05 PM/.test(text) && /Flight 6E 512 · at Nagpur Airport/.test(text), text);
  check('pickup: where, the car, the driver and their phone', /We will meet you at Nagpur Airport/.test(text) && /Car: Kia Carens/.test(text) && /Driver: Ravi , \+919800011111/.test(text)
    && /href="tel:\+919800011111"/.test(mail.body));
  check('staying: the place, room and nights', /Yatri Nivas , Room 12/.test(text) && /Check in Saturday, 21 November, check out Sunday, 22 November \(1 night\)/.test(text));
  check('a drop not needed says so, without the old details', /Not needed: you are making your own way\./.test(text) && !/Wardha Station/.test(text));
  check('whom to call', /Tara , who looks after your travel: \+919800022222/.test(text));
  check('names are escaped', /Dr &lt;b&gt;Rao&lt;\/b&gt;/.test(mail.body) && !/<b>Rao/.test(mail.body));
  const blankMail = G.arrangementsEmail({ name: 'Dr X' }).body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  check('nothing known yet: asks for it, and says the room is being arranged', /We do not have your arrival details yet/.test(blankMail) && /We do not have your departure details yet/.test(blankMail)
    && /Being arranged\. We will tell you where you are staying/.test(blankMail) && /please let the conference team know/.test(blankMail));
  check('own stay says so', /You are arranging your own stay/.test(G.arrangementsEmail({ name: 'Y', stay_not_needed: 1, accommodation: 'Yatri' }).body));
  check('a car with no driver: the car\'s own driver phone', /Driver: <a href="tel:0712/.test(G.arrangementsEmail({ name: 'Y', arrival_date: '2026-11-21', pickup_vehicle: 'Bolero' }, { vehicles: [{ label: 'Bolero', driver_phone: '0712 222' }] }).body));

  console.log('\n== Changed since ==');
  const p = G.arrangementsPrint(g);
  check('the same details, the same print', p === G.arrangementsPrint({ ...g }) && /^[0-9a-f]{8}$/.test(p));
  check('a new time is a change', p !== G.arrangementsPrint({ ...g, arrival_time: '15:00' }));
  check('a room is a change', p !== G.arrangementsPrint({ ...g, room_no: '14' }));
  check('a pickup marked Done is not', p === G.arrangementsPrint({ ...g, pickup_status: 'Done', overall_status: 'Arrived' }));
  check('a drop needed after all is', p !== G.arrangementsPrint({ ...g, drop_status: 'Pending' }));
  const lists = Object.fromEntries(Object.entries(G.DEFAULT_LISTS).map(([k, v]) => [k, [...v]]));
  const board = (x) => G.buildBoard({ guests: [{ id: 1, ...g, ...x }], lists, settings: G.DEFAULT_SETTINGS, today: '2026-11-20' }).guests[0];
  check('never sent: nothing on the board', board({}).arrangementsEmail === null);
  check('sent: when, by whom, not changed', JSON.stringify(board({ arrangements_sent_at: 5, arrangements_sent_by: 'Tara', arrangements_sent_print: p }).arrangementsEmail) === '{"at":5,"by":"Tara","changed":false}');
  check('...and changed once the details move', board({ arrangements_sent_at: 5, arrangements_sent_print: p, arrival_time: '16:00' }).arrangementsEmail.changed === true);

  console.log('\n== The button ==');
  const src = fs.readFileSync(appFile('server.js'), 'utf8');
  const admin = await adminLogin();
  const db = openDb();
  const N = String(Date.now()).slice(-6);
  let id = null;
  try {
    id = (await db.run("INSERT INTO guests (guest_name, overall_status, created_at) VALUES (?, 'Confirmed', ?)", [`Dr Mail ${N}`, Date.now()])).lastID;
    const press = (who) => call('POST', `/api/guests/${id}/arrangements-email`, {}, who);
    const none = await press(admin);
    check('no address: says so, holds nothing', none.status === 400 && /No email address/.test(none.body.error) && !none.headers['x-held-emails'], none.body);
    await db.run('UPDATE guests SET guest_email = ? WHERE id = ?', [`mail${N}@example.org`, id]);
    const off = await press(admin);
    check('email switched off here: says so', off.status === 400 && /Email is switched off/.test(off.body.error), off.body);
    await db.run("UPDATE guests SET overall_status = 'Cancelled' WHERE id = ?", [id]);
    check('cancelled: no email', (await press(admin)).status === 400);
    check('signed out: nothing', (await press(undefined)).status === 401);
    check('a missing person: not found', (await call('POST', '/api/guests/99999999/arrangements-email', {}, admin)).status === 404);
    check('held, never sent from the route, marked with its print', /holdEmailTo\(req, to, g\.name \|\| null, mail\.subject, emailWrap\(mail\.title, mail\.body\), `guest:\$\{g\.id\}:arrangements:\$\{guestLib\.arrangementsPrint\(g\)\}`\)/.test(src));
    check('an earlier one still waiting is dropped', /ref LIKE \?", \[Date\.now\(\), `guest:\$\{g\.id\}:arrangements:%`\]/.test(src));
    check('Send marks them emailed, with what it said', /guest:\(\\d\+\):arrangements:\(\[0-9a-f\]\{8\}\)\$/.test(src) && /arrangements_sent_print = \? WHERE id = \?/.test(src)
      && /await noteHeldEmailSent\(row, req\);/.test(src));
    const cols = (await db.all('PRAGMA table_info(guests)')).map((c) => c.name);
    check('the columns are there', ['arrangements_sent_at', 'arrangements_sent_by', 'arrangements_sent_print'].every((c) => cols.includes(c)));
  } finally {
    if (id) await db.run('DELETE FROM guests WHERE id = ?', [id]);
    db.close();
  }
  report();
})();
