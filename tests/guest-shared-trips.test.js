// Shared pickups and drops (owner, 20 Nov 2026): one car with one driver,
// at one place on one day, everyone within the sharing window of the trip's
// first -- the coordinators set the windows -- is one trip: one block on
// the schedule, a seat check, and no clash among its own people.
const fs = require('fs');
const { appFile, check, report } = require('./harness');
const G = require('../guests');

(async () => {
  const g = (id, name, time, extra = {}) => ({ id, name, overall_status: 'Confirmed', arrival_date: '2026-11-20', arrival_time: time,
    arrival_point: 'Nagpur Airport', pickup_vehicle: 'Carens', pickup_driver: 'Vedant', ...extra });
  const board = (guests, settings = {}) => G.buildBoard({ guests, vehicles: [{ id: 1, label: 'Carens', seats: 3 }], drivers: [{ id: 1, name: 'Vedant', phone: '9579032360' }],
    settings: { ...G.DEFAULT_SETTINGS, ...settings }, today: '2026-11-19' });
  const p = (b, n) => b.pickups.find((x) => x.name === n);

  console.log('\n== One trip ==');
  let b = board([g(1, 'A', '10:00'), g(2, 'B', '10:30'), g(3, 'C', '10:40')]);
  check('one car and driver, one place, within the window: one trip of three', p(b, 'A').trip && p(b, 'A').trip.size === 3 && p(b, 'C').trip.id === p(b, 'A').trip.id);
  check('...its span, and who with', p(b, 'A').trip.from === '10:00 am' && p(b, 'A').trip.to === '10:40 am' && p(b, 'B').trip.with.join() === 'A,C');
  check('...and no clash among them', b.pickups.every((x) => !x.clash.length) && b.clashes.length === 0);
  check('the person carries it too', b.guests.find((x) => x.name === 'A').flags.sharedPickup.size === 3 && b.dashboard.sharedTrips === 1);

  console.log('\n== Not one trip ==');
  b = board([g(1, 'A', '10:00'), g(2, 'B', '10:20', { pickup_driver: 'Nikhil' })]);
  check('the same car with another driver is another trip -- and a clash for the car', !p(b, 'A').trip && p(b, 'A').clash.length === 1 && /overlaps|min from/.test(p(b, 'A').clash[0]));
  let sent = null;
  try { sent = JSON.parse(JSON.stringify(b)); } catch (e) { sent = null; }
  check('the board, clashes and shared trips with it, can be sent to the page', !!sent && sent.clashes.length === b.clashes.length);
  b = board([g(1, 'A', '10:00'), g(2, 'B', '10:20', { arrival_point: 'Wardha Railway Station' })]);
  check('...so is another place', !p(b, 'A').trip && p(b, 'B').clash.length === 1);
  b = board([g(1, 'A', '10:00'), g(2, 'B', '10:50')]);
  check('...and a time beyond the window (45 min for pickups)', !p(b, 'A').trip);
  b = board([g(1, 'A', '10:00'), g(2, 'B', '10:50')], { pickupShareMinutes: 60 });
  check('the coordinators set the window', p(b, 'A').trip && p(b, 'A').trip.size === 2);
  b = board([g(1, 'A', '10:00'), g(2, 'B', '10:10')], { pickupShareMinutes: 0 });
  check('...0 turns sharing off', !p(b, 'A').trip && p(b, 'A').clash.length === 1);

  console.log('\n== Seats and drops ==');
  b = board([g(1, 'A', '10:00'), g(2, 'B', '10:05'), g(3, 'C', '10:10'), g(4, 'D', '10:15')]);
  check('more people than seats: over capacity', p(b, 'A').trip.overCapacity === true && p(b, 'A').trip.seats === 3 && b.dashboard.overCapacity === 1);
  const d = (id, name, time) => ({ id, name, overall_status: 'Confirmed', departure_date: '2026-11-22', departure_time: time,
    departure_point: 'Nagpur Airport', drop_vehicle: 'Carens', drop_driver: 'Vedant' });
  b = board([d(1, 'A', '17:00'), d(2, 'B', '17:55')]);
  check('drops share within their own window (60 min)', b.drops.find((x) => x.name === 'A').trip && b.drops.find((x) => x.name === 'A').trip.size === 2);
  check('the windows are settings, checked', G.validateSettings({ alertDays: 2, clashMinutes: 60, slotBounds: [6, 12, 18], pickupShareMinutes: 300 }).errors.length === 1
    && G.validateSettings({ alertDays: 2, clashMinutes: 60, slotBounds: [6, 12, 18], pickupShareMinutes: 30, dropShareMinutes: 0 }).errors.length === 0);

  console.log('\n== The screens ==');
  const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
  check('the Day plan shows a shared trip once, its people under it', /items\.push\(\{ trip: r\.trip, rows: rows\.filter\(\(x\) => x\.trip && x\.trip\.id === r\.trip\.id\) \}\)/.test(js)
    && /Shared \$\{isPick \? 'pickup' : 'drop'\} · \$\{esc\(it\.trip\.size\)\}/.test(js) && /' · over capacity' : ''\}<\/p>/.test(js));
  check('a person shows "Shared pickup · 3"', /`Shared \$\{what\} · \$\{t\.size\}\$\{t\.overCapacity \? ' · over capacity' : ''\}`/.test(js));
  check('the windows are in Settings', /name="pickupShareMinutes"/.test(js) && /name="dropShareMinutes"/.test(js));
  report();
})();
