// The Day plan's server side (owner, 20 Nov 2026): statuses that follow
// from what was done -- a car chosen makes the pickup Assigned, the car
// taken away Pending, a pickup Done makes them Arrived, a drop Done
// Departed; checking in at their accommodation, which makes them Arrived
// too; and each driver's own link to their trips, which can be reset.
const G = require('../guests');
const { call, check, report, adminLogin, openDb } = require('./harness');

(async () => {
  console.log('\n== Statuses that follow ==');
  const lists = Object.fromEntries(Object.entries(G.DEFAULT_LISTS).map(([k, v]) => [k, [...v]]));
  const auto = (current, values) => G.autoStatusValues(current, values, lists);
  check('a car chosen: Pending becomes Assigned', auto({ pickup_status: 'Pending' }, { pickup_vehicle: 'Bolero' }).pickup_status === 'Assigned');
  check('...and no status at all too', auto({}, { drop_vehicle: 'Bolero' }).drop_status === 'Assigned');
  check('the car taken away: Assigned becomes Pending', auto({ pickup_vehicle: 'Bolero', pickup_status: 'Assigned' }, { pickup_vehicle: null }).pickup_status === 'Pending');
  check('a status set in the same request wins', !('pickup_status' in auto({ pickup_status: 'Pending' }, { pickup_vehicle: 'Bolero', pickup_status: 'Done' })));
  check('a car changed on a pickup already Done leaves it Done', !('pickup_status' in auto({ pickup_vehicle: 'Ciaz', pickup_status: 'Done' }, { pickup_vehicle: 'Bolero' })));
  check('pickup Done: Arrived', auto({ overall_status: 'Confirmed', pickup_status: 'Assigned' }, { pickup_status: 'Done' }).overall_status === 'Arrived');
  check('drop Done: Departed', auto({ overall_status: 'Arrived', drop_status: 'Assigned' }, { drop_status: 'Done' }).overall_status === 'Departed');
  check('never over Cancelled', !('overall_status' in auto({ overall_status: 'Cancelled' }, { pickup_status: 'Done' }))
    && !('overall_status' in auto({ overall_status: 'Cancelled' }, { drop_status: 'Done' })));
  check('...nor Arrived over Departed', !('overall_status' in auto({ overall_status: 'Departed' }, { pickup_status: 'Done' })));
  check('an overall status set by hand wins', !('overall_status' in auto({ overall_status: 'Confirmed' }, { pickup_status: 'Done', overall_status: 'Invited' })));
  check('a value switched off its list is not set', !('pickup_status' in G.autoStatusValues({}, { pickup_vehicle: 'X' }, { ...lists, transfer_status: ['Pending', 'Done'] })));
  const b = G.buildBoard({ guests: [
    { id: 1, name: 'A', phone: '+911', arrival_date: '2026-11-21', arrival_time: '09:00', arrival_point: 'Nagpur Airport', arrival_mode: 'Flight', arrival_number: '6E 1', pickup_vehicle: 'Car', pickup_driver: 'Ravi' },
    { id: 2, name: 'B', arrival_date: '2026-11-21', arrival_time: '09:20', arrival_point: 'Nagpur Airport', pickup_vehicle: 'Car', pickup_driver: 'Ravi' },
  ], vehicles: [{ id: 1, label: 'Car', seats: 4 }], drivers: [{ id: 1, name: 'Ravi' }], lists, settings: G.DEFAULT_SETTINGS, today: '2026-11-20' });
  const trip = b.trips.find((t) => t.shared);
  check('the board lists trips: kind, day, place, car, driver, span, seats, people', trip && trip.kind === 'Pickup' && trip.date === '2026-11-21' && trip.from === '09:00' && trip.to === '09:20'
    && trip.drivers.join() === 'Ravi' && trip.seats === 4 && trip.people.map((p) => p.name).join() === 'A,B' && trip.people[0].number === '6E 1' && trip.people[0].phone === '+911', trip);
  check('...as plain data', JSON.parse(JSON.stringify(b)).trips.length === b.trips.length);

  const admin = await adminLogin();
  const db = openDb();
  const N = String(Date.now()).slice(-6);
  const made = { guest: null, driver: null };
  try {
    console.log('\n== Through the server ==');
    made.guest = (await db.run("INSERT INTO guests (guest_name, guest_phone, overall_status, pickup_status, arrival_date, arrival_time, arrival_point, created_at) VALUES (?, '+919800012345', 'Confirmed', 'Pending', '2026-11-21', '10:00', 'Nagpur Airport', ?)",
      [`Dr Day ${N}`, Date.now()])).lastID;
    const row = () => db.get('SELECT * FROM guests WHERE id = ?', [made.guest]);
    const put = (fields) => call('PUT', `/api/guests/${made.guest}`, { fields }, admin);
    await put({ pickup_vehicle: `Car ${N}` });
    check('choosing a car makes the pickup Assigned', (await row()).pickup_status === 'Assigned');
    await put({ pickup_status: 'Done' });
    check('marking it picked up makes them Arrived', (await row()).overall_status === 'Arrived');
    const log = await db.get("SELECT new_value FROM audit_log WHERE entity_type = 'guest' AND entity_id = ? ORDER BY id DESC LIMIT 1", [String(made.guest)]);
    check('...and the activity log says so', /Overall Status: Confirmed → Arrived/.test(log.new_value), log);

    console.log('\n== Checking in ==');
    check('no room yet: no check-in', (await call('POST', `/api/guests/${made.guest}/checkin`, {}, admin)).status === 400);
    await db.run("UPDATE guests SET overall_status = 'Confirmed' WHERE id = ?", [made.guest]);
    await put({ accommodation: 'Yatri Nivas' });
    const ci = await call('POST', `/api/guests/${made.guest}/checkin`, {}, admin);
    const r1 = await row();
    check('checked in: when and by whom', ci.body.success && !!r1.checked_in_at && !!r1.checked_in_by);
    check('...and they are Arrived', r1.overall_status === 'Arrived');
    check('again: nothing changes', (await call('POST', `/api/guests/${made.guest}/checkin`, {}, admin)).body.changed === 0);
    const un = await call('POST', `/api/guests/${made.guest}/checkin`, { undo: true }, admin);
    check('taken back', un.body.success && !(await row()).checked_in_at);
    check('the board sends it to the page', (await call('GET', '/api/guests', null, admin)).body.guests.some((g) => g.id === made.guest && 'checked_in_at' in g));

    console.log('\n== A driver\'s own link ==');
    made.driver = (await call('POST', '/api/guests/drivers', { name: `Ravi ${N}`, phone: '9800054321' }, admin)).body.id;
    await put({ pickup_status: 'Assigned', pickup_driver: `Ravi ${N}`, arrival_date: '2099-01-02' });
    const l1 = await call('POST', `/api/guests/drivers/${made.driver}/link`, {}, admin);
    check('a link is made on first asking, on the conference\'s own address', l1.body.success && /^https:\/\/nqocn2026\.mgims\.ac\.in\/driver\/[A-Za-z0-9_-]{20,}$/.test(l1.body.url), l1.body);
    const l2 = await call('POST', `/api/guests/drivers/${made.driver}/link`, {}, admin);
    check('...and the same link after', l2.body.url === l1.body.url);
    const page = await call('GET', new URL(l1.body.url).pathname);
    check('the link opens their trips: who, where, the phone to call', page.status === 200 && page.raw.includes(`Dr Day ${N}`) && /Pick up from Nagpur Airport/.test(page.raw)
      && /href="tel:\+919800012345"/.test(page.raw));
    check('...never indexed, never cached', /noindex/.test(page.headers['x-robots-tag'] || '') && /no-store/.test(page.headers['cache-control'] || ''));
    const reset = await call('POST', `/api/guests/drivers/${made.driver}/link`, { reset: true }, admin);
    check('Reset makes a new link', reset.body.url !== l1.body.url);
    check('...and the old one stops working', (await call('GET', new URL(l1.body.url).pathname)).status === 404);
    check('a made-up link finds nothing', (await call('GET', '/driver/abcdefghijklmnopqrstu')).status === 404);
    check('only someone who looks after transport can make one', (await call('POST', `/api/guests/drivers/${made.driver}/link`, {})).status === 401
      || (await call('POST', `/api/guests/drivers/${made.driver}/link`, {})).status === 403);
  } finally {
    if (made.guest) await db.run('DELETE FROM guests WHERE id = ?', [made.guest]);
    if (made.driver) await db.run('DELETE FROM guest_drivers WHERE id = ?', [made.driver]);
    db.close();
  }
  report();
})();
