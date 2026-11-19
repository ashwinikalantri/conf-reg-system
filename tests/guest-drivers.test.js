// Vehicles and drivers apart (owner, 19 Nov 2026): one car may be driven by
// different drivers, so each pickup and drop names its vehicle and its
// driver; drivers are a list of their own; a clash is a car or a driver in
// two places at once.
const fs = require('fs');
const { call, adminLogin, appFile, check, report, openDb } = require('./harness');
const G = require('../guests');

(async () => {
  console.log('\n== The rules ==');
  check('each pickup and drop has a driver, a travel field the transport volunteer may set too',
    G.TRAVEL_FIELDS.includes('pickup_driver') && G.TRAVEL_FIELDS.includes('drop_driver')
    && G.VOLUNTEER_FIELDS.transport.includes('pickup_driver') && G.FIELD_LABELS.pickup_driver === 'Pickup Driver' && G.FIELD_LABELS.pickup_vehicle === 'Pickup Vehicle');
  check('...set aside with the rest when the transfer is not required', G.LEG_DETAILS.pickup_status.includes('pickup_driver') && G.LEG_DETAILS.drop_status.includes('drop_driver'));
  check('a driver needs a name; a phone, if given, is digits', G.validateDriver({ name: '' }).errors.length === 1
    && G.validateDriver({ name: 'Vedant', phone: 'abc' }).errors.length === 1 && G.validateDriver({ name: ' Vedant ', phone: '95790 32360' }).values.phone === '9579032360');
  const g = (id, name, extra) => ({ id, name, overall_status: 'Confirmed', ...extra });
  const board = G.buildBoard({
    guests: [
      g(1, 'A', { arrival_date: '2026-11-20', arrival_time: '10:00', pickup_vehicle: 'Carens', pickup_driver: 'Vedant' }),
      g(2, 'B', { arrival_date: '2026-11-20', arrival_time: '10:30', pickup_vehicle: 'Scorpio', pickup_driver: 'Vedant' }),
      g(3, 'C', { arrival_date: '2026-11-20', arrival_time: '18:00', pickup_vehicle: 'Carens', pickup_driver: 'Nikhil' }),
      g(4, 'D', { arrival_date: '2026-11-21', arrival_time: '09:00', pickup_vehicle: 'Old Car' }),
    ],
    vehicles: [{ id: 1, label: 'Carens', seats: 6 }, { id: 2, label: 'Scorpio', seats: 6 }, { id: 3, label: 'Old Car', driver_phone: '1111111111' }],
    drivers: [{ id: 1, name: 'Vedant', phone: '9579032360' }, { id: 2, name: 'Nikhil', phone: '7030964983' }],
    settings: G.DEFAULT_SETTINGS, today: '2026-11-19',
  });
  const p = (name) => board.pickups.find((x) => x.name === name);
  check('one car, different drivers: no clash hours apart', !p('C').clash.length);
  check('one driver in two cars 30 min apart: a clash, named for the driver', p('A').clash.length === 1 && /with driver Vedant is 30 min from B's pickup/.test(p('A').clash[0]), p('A').clash);
  check('the schedule shows the driver and their phone', p('C').driver === 'Nikhil' && p('C').driverPhone === '7030964983');
  check('a trip with no driver chosen falls back to the phone kept on its vehicle', p('D').driver === null && p('D').driverPhone === '1111111111');
  check('each driver counts their pickups and drops', board.drivers.find((d) => d.name === 'Vedant').pickups === 2);
  check('the CSV has the driver beside the vehicle', /Pickup Vehicle,Pickup Driver,Pickup Status/.test(G.guestsCsv(board.guests).split('\r\n')[0]));

  console.log('\n== The list ==');
  const admin = await adminLogin();
  const db = openDb();
  const made = [];
  let guestId = null;
  try {
    const add = await call('POST', '/api/guests/drivers', { name: 'Test Driver', phone: '98765 43210' }, admin);
    made.push(add.body.id);
    check('a driver is added', add.body.success && add.body.id);
    check('...once: the same name again is refused', (await call('POST', '/api/guests/drivers', { name: 'test driver' }, admin)).status === 409);
    const r = await db.run(`INSERT INTO guests (guest_name, pickup_driver, drop_driver, overall_status, created_at) VALUES ('Driver Test Guest', 'Test Driver', 'Test Driver', 'Confirmed', ?)`, [Date.now()]);
    guestId = r.lastID;
    await call('PUT', `/api/guests/drivers/${add.body.id}`, { name: 'Test Driver Two', phone: '9876543210' }, admin);
    const row = await db.get('SELECT pickup_driver, drop_driver FROM guests WHERE id = ?', [guestId]);
    check('renaming a driver renames them on every trip', row.pickup_driver === 'Test Driver Two' && row.drop_driver === 'Test Driver Two', row);
    const list = (await call('GET', '/api/guests', null, admin)).body;
    check('the board carries the drivers, with their trips counted', list.drivers.some((d) => d.name === 'Test Driver Two' && d.phone === '9876543210' && d.pickups === 1 && d.drops === 1));
    check('a driver is deleted; their trips keep the name', (await call('DELETE', `/api/guests/drivers/${add.body.id}`, null, admin)).body.success
      && (await db.get('SELECT pickup_driver FROM guests WHERE id = ?', [guestId])).pickup_driver === 'Test Driver Two');
    made.length = 0;
  } finally {
    for (const id of made) await db.run('DELETE FROM guest_drivers WHERE id = ?', [id]);
    if (guestId) await db.run('DELETE FROM guests WHERE id = ?', [guestId]);
    db.close();
  }

  console.log('\n== The screens ==');
  const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
  check('the editor has a Driver beside each Vehicle, chosen from the list or typed', /field\('pickup_driver', 'Pickup Driver', input\('pickup_driver', 'text', pickupOk, 'list="guest-driver-options"/.test(js)
    && /field\('drop_driver', 'Drop Driver'/.test(js) && /<datalist id="guest-driver-options">/.test(js));
  check('the Vehicles & drivers tab lists both, each with add, edit and delete', /<form id="guest-driver-form" onsubmit="saveGuestDriver\(event\)"/.test(js) && /function deleteGuestDriver\(id\)/.test(js)
    && /Vehicles &amp; drivers<\/button>/.test(fs.readFileSync(appFile('views', 'admin', 'sections', 'guests.ejs'), 'utf8')));
  check('trips show the driver after the car', /driver \? `Driver: \$\{esc\(driver\)\}` : ''/.test(js) && /r\.driver \? `Driver: \$\{esc\(r\.driver\)\}` : ''/.test(js));
  report();
})();
