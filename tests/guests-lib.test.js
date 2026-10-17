// Guest coordination: the rules in guests.js, without a server.
//
// Validation (dates, 24-hour times, check-out after check-in, beds 1-20, list
// values), the derived date-and-time, each flag and the cases it must NOT
// fire for (Cancelled guests above all), vehicle clashes and their window,
// room status, the dashboard's counts including "not set", time slots with
// moved boundaries, the schedules' order, and the CSV.
const { check, report } = require('./harness');
const G = require('../guests');

const today = '2026-11-19';
const lists = Object.fromEntries(Object.entries(G.DEFAULT_LISTS).map(([k, v]) => [k, [...v]]));
const coordinators = { transport: new Set(['T1']), accommodation: new Set(['A1']) };
const v = (input, current = {}) => G.validateGuestFields(input, current, lists, coordinators);

console.log('\n== Validation ==');
check('a real date passes', v({ arrival_date: '2026-11-20' }).errors.length === 0);
check('an impossible date is refused', v({ arrival_date: '2026-02-30' }).errors.some((e) => /Arrival Date is not a valid date/.test(e)));
check('a non-date is refused', v({ checkin_date: '20/11/2026' }).errors.length === 1);
check('24-hour time passes', v({ arrival_date: '2026-11-20', arrival_time: '23:59' }).errors.length === 0);
check('12-hour or out-of-range time is refused', ['2:30 PM', '24:00', '9:5', '12:60'].every((t) => v({ arrival_date: '2026-11-20', arrival_time: t }).errors.some((e) => /HH:MM/.test(e))));
check('a time without its date is refused', v({ departure_time: '10:00' }).errors.some((e) => /needs Departure Date/.test(e)));
check('...but is fine once the date is already stored', v({ departure_time: '10:00' }, { departure_date: '2026-11-22' }).errors.length === 0);
check('check-out before check-in is refused', v({ checkin_date: '2026-11-21', checkout_date: '2026-11-20' }).errors.some((e) => /Check-out Date cannot be before/.test(e)));
check('...also against the stored check-in', v({ checkout_date: '2026-11-19' }, { checkin_date: '2026-11-20' }).errors.length === 1);
check('same-day check-out is allowed', v({ checkin_date: '2026-11-20', checkout_date: '2026-11-20' }).errors.length === 0);
check('a dropdown value must be on its list', v({ arrival_mode: 'Helicopter' }).errors.some((e) => /not on the list/.test(e)));
check('...matched without regard to case, stored as listed', v({ arrival_mode: 'flight' }).values.arrival_mode === 'Flight');
check('a value switched off since stays acceptable on that guest', v({ arrival_mode: 'Bus' }, { arrival_mode: 'Bus' }).errors.length === 0);
check('the coordinator must hold the role', v({ transport_coordinator: 'X9' }).errors.length === 1 && v({ transport_coordinator: 'T1' }).errors.length === 0);
check('...and a transport coordinator is not an accommodation one', v({ accommodation_coordinator: 'T1' }).errors.length === 1);
check('blank becomes null, text is trimmed', v({ remarks: '   ', room_no: ' 12 ' }).values.remarks === null && v({ room_no: ' 12 ' }).values.room_no === '12');
check('fields not sent are not touched', !('remarks' in v({ room_no: '1' }).values));
check('a phone-like value keeps its leading zero and +', v({ arrival_number: '+0123' }).values.arrival_number === '+0123');

console.log('\n== Who may change what ==');
const cur = { arrival_date: null, accommodation: null, remarks: 'x' };
const onlyTravel = (p) => p === 'guests.travel' || p === 'guests.edit';
check('a transport coordinator may change travel', G.forbiddenChanges({ arrival_date: '2026-11-20' }, cur, onlyTravel).length === 0);
check('...not the stay', JSON.stringify(G.forbiddenChanges({ accommodation: 'Yatri Nivas' }, cur, onlyTravel)) === '["accommodation"]');
check('...though sending it back unchanged is not a change', G.forbiddenChanges({ remarks: 'x', accommodation: null }, cur, () => false).length === 0);
check('every field belongs to exactly one permission', G.ALL_FIELDS.every((f) => ['guests.travel', 'guests.stay', 'guests.edit'].includes(G.FIELD_PERMISSION[f])));

console.log('\n== Masters ==');
check('beds must be 1-20, whole', [0, 21, 2.5, '', 'two'].every((b) => G.validateRoom({ accommodation: 'Yatri Nivas', roomNo: '1', beds: b }, lists).errors.some((e) => /Beds/.test(e))));
check('...1 and 20 are fine', [1, 20].every((b) => G.validateRoom({ accommodation: 'Yatri Nivas', roomNo: '1', beds: b }, lists).errors.length === 0));
check('a room needs an accommodation on the list', G.validateRoom({ accommodation: 'Hotel Elsewhere', roomNo: '1', beds: 2 }, lists).errors.length === 1);
check('a vehicle needs a label', G.validateVehicle({ label: ' ' }).errors.length === 1);
check('seats are a whole number', G.validateVehicle({ label: 'Car', seats: '4.5' }).errors.length === 1 && G.validateVehicle({ label: 'Car', seats: '4' }).values.seats === 4);
check('settings: slots must be three rising hours', G.validateSettings({ alertDays: 2, clashMinutes: 60, slotBounds: [12, 6, 18] }).errors.length === 1
  && G.validateSettings({ alertDays: 2, clashMinutes: 60, slotBounds: [5, 11, 17] }).errors.length === 0);

console.log('\n== The board ==');
let id = 0;
const guest = (name, f = {}) => ({ id: ++id, name, phone: '+919800000000', registered: 1, ...f });
const guests = [
  guest('Soon NoCar', { arrival_date: '2026-11-20', arrival_time: '09:00', arrival_point: 'Nagpur Airport', accommodation: 'Yatri Nivas', room_no: '101', overall_status: 'Confirmed', pickup_status: 'Pending' }),
  guest('Soon WithCar', { arrival_date: '2026-11-20', arrival_time: '09:30', pickup_vehicle: 'Innova 1', accommodation: 'Yatri Nivas', room_no: '101', overall_status: 'Confirmed', pickup_status: 'Assigned' }),
  guest('Later', { arrival_date: '2026-11-25', accommodation: 'MGIMS Guesthouse', room_no: '7', overall_status: 'Invited' }),
  guest('Homeless', { arrival_date: '2026-11-20', arrival_time: '10:15', pickup_vehicle: 'innova 1 ', overall_status: 'Invited' }),
  guest('Gone', { arrival_date: '2026-11-20', arrival_time: '09:10', pickup_vehicle: 'Innova 1', accommodation: 'Yatri Nivas', room_no: '101', overall_status: 'Cancelled' }),
  guest('Unset', { registered: 0, departure_date: '2026-11-22', departure_time: '19:00', drop_vehicle: 'Innova 1', accommodation: 'MGIMS Guesthouse', room_no: '8' }),
];
const vehicles = [{ id: 1, label: 'Innova 1', driver_phone: '09822000000', seats: 6 }, { id: 2, label: 'Spare', seats: 4 }];
const rooms = [
  { id: 1, accommodation: 'Yatri Nivas', room_no: '101', room_type: 'Double', beds: 2 },
  { id: 2, accommodation: 'MGIMS Guesthouse', room_no: '7', room_type: 'Single', beds: 2 },
  { id: 3, accommodation: 'Yatri Nivas', room_no: '102', beds: 1 },
  { id: 4, accommodation: 'mgims guesthouse', room_no: '8', beds: 1 },
];
const settings = { alertDays: 2, slotBounds: [6, 12, 18], clashMinutes: 60 };
const b = G.buildBoard({ guests, vehicles, rooms, lists, settings, today });
const by = (n) => b.guests.find((g) => g.name === n);

check('Sr No follows the order guests were added', b.guests.map((g) => g.sr_no).join() === '1,2,3,4,5,6');
check('Arrival Date & Time joins date and time', by('Soon NoCar').arrival_at === '2026-11-20 09:00');
check('...or is just the date when no time is set', by('Later').arrival_at === '2026-11-25');
check('...and empty without a date', by('Unset').arrival_at === '' && by('Unset').departure_at === '2026-11-22 19:00');

check('orange: arriving within the window, no vehicle', by('Soon NoCar').flags.pickupAlert === true);
check('...not with a vehicle', by('Soon WithCar').flags.pickupAlert === false);
check('...not beyond the window', by('Later').flags.pickupAlert === false);
check('...not when Cancelled', by('Gone').flags.pickupAlert === false);
const wider = G.buildBoard({ guests, vehicles, rooms, lists, settings: { ...settings, alertDays: 6 }, today });
check('...and the window is the setting', wider.guests.find((g) => g.name === 'Later').flags.pickupAlert === true);

check('red: no accommodation', by('Homeless').flags.noAccommodation === true && by('Later').flags.noAccommodation === false);
const goneHomeless = G.buildBoard({ guests: [guest('X', { overall_status: 'Cancelled' })], vehicles, rooms, lists, settings, today });
check('...not when Cancelled', goneHomeless.guests[0].flags.noAccommodation === false);

check('purple: two guests in one room are told who with', JSON.stringify(by('Soon NoCar').flags.sharedRoom) === '["Soon WithCar"]');
check('...a Cancelled guest in that room does not count', !by('Soon NoCar').flags.sharedRoom.includes('Gone') && by('Gone').flags.sharedRoom.length === 0);
check('...nor does a room on its own', by('Later').flags.sharedRoom.length === 0);

check('a vehicle on two pickups within the window clashes, flagged on both', by('Homeless').flags.vehicleClash.length === 1
  && by('Soon WithCar').flags.vehicleClash.length === 1, by('Homeless').flags.vehicleClash);
check('...matched without regard to case or spaces', /Innova 1|innova 1/.test(by('Homeless').flags.vehicleClash[0]));
check('...the Cancelled guest\'s pickup is not a trip', b.clashes.every((c) => c.a.name !== 'Gone' && c.b.name !== 'Gone'));
check('...45 minutes apart is one clash at the default 60', b.clashes.length === 1 && b.clashes[0].minutesApart === 45, b.clashes.map((c) => c.minutesApart));
const tight = G.buildBoard({ guests, vehicles, rooms, lists, settings: { ...settings, clashMinutes: 30 }, today });
check('...and none at a 30-minute window', tight.clashes.length === 0);
check('...exactly the window apart still counts', G.buildBoard({ guests: [
  guest('P', { arrival_date: '2026-11-20', arrival_time: '08:00', pickup_vehicle: 'V' }),
  guest('Q', { departure_date: '2026-11-20', departure_time: '09:00', drop_vehicle: 'V' })], settings, today, lists }).clashes.length === 1);

console.log('\n== Rooms and vehicles ==');
const room = (acc, no) => b.rooms.find((r) => r.accommodation === acc && r.room_no === no);
check('two in a double: Full', room('Yatri Nivas', '101').status === 'Full' && room('Yatri Nivas', '101').occupied === 2);
check('...the cancelled third is not counted', !room('Yatri Nivas', '101').guests.includes('Gone'));
check('one in a double: Partly filled', room('MGIMS Guesthouse', '7').status === 'Partly filled');
check('nobody: Vacant', room('Yatri Nivas', '102').status === 'Vacant');
check('room matching ignores case', room('mgims guesthouse', '8').occupied === 1);
const over = G.buildBoard({ guests: [guest('A', { accommodation: 'Yatri Nivas', room_no: '102' }), guest('B', { accommodation: 'Yatri Nivas', room_no: '102' })], rooms, lists, settings, today });
check('two in a single: Over capacity', over.rooms.find((r) => r.room_no === '102').status === 'Over capacity');
check('a room in use but not on the list is reported', G.buildBoard({ guests: [guest('Z', { accommodation: 'Yatri Nivas', room_no: '999' })], rooms, lists, settings, today }).unlistedRooms.length === 1);
const innova = b.vehicles.find((x) => x.label === 'Innova 1');
check('a vehicle counts its non-cancelled pickups and drops', innova.pickups === 2 && innova.drops === 1, innova);

console.log('\n== Dashboard ==');
const d = b.dashboard;
check('guests listed leave out Cancelled', d.listed === 5 && d.cancelled === 1);
const count = (rows, value) => (rows.find((r) => r.value === value) || {}).count;
check('Overall Status counts every guest, Cancelled and "not set" included',
  count(d.byOverallStatus, 'Confirmed') === 2 && count(d.byOverallStatus, 'Invited') === 2
  && count(d.byOverallStatus, 'Cancelled') === 1 && count(d.byOverallStatus, null) === 1);
check('Pickup Status counts "not set" too', count(d.byPickupStatus, 'Pending') === 1 && count(d.byPickupStatus, null) === 3);
check('Drop Status shows "not set" even when nothing has one', count(d.byDropStatus, null) === 5);
check('the alert window: arrivals and those with no vehicle', d.alert.arriving === 3 && d.alert.noVehicle === 1, d.alert);
check('guests with no accommodation', d.noAccommodation === 1);
check('faculty not registered', d.notRegistered === 1);
check('arrivals per date', JSON.stringify(d.arrivals.byDate) === JSON.stringify([
  { value: '2026-11-20', count: 3 }, { value: '2026-11-25', count: 1 }]), d.arrivals.byDate);
check('arrivals per point, with "not set"', count(d.arrivals.byPoint, 'Nagpur Airport') === 1 && count(d.arrivals.byPoint, null) === 3);
check('arrivals per slot: all morning, one undated-time', count(d.arrivals.bySlot, 'Morning 06-12') === 3 && count(d.arrivals.bySlot, null) === 1, d.arrivals.bySlot);
check('departures per slot: evening', count(d.departures.bySlot, 'Evening 18-24') === 1);
const moved = G.buildBoard({ guests, rooms, lists, settings: { ...settings, slotBounds: [9, 12, 18] }, today });
check('moving a slot boundary moves the guests', count(moved.dashboard.arrivals.bySlot, 'Night 00-09') === 0
  && count(moved.dashboard.arrivals.bySlot, 'Morning 09-12') === 3, moved.dashboard.arrivals.bySlot);
check('...09:00 is Morning, not Night, at a 9 o\'clock boundary', G.slotOf('09:00', [9, 12, 18]) === 1 && G.slotOf('08:59', [9, 12, 18]) === 0);
const acc = (n) => d.perAccommodation.find((r) => r.accommodation === n);
check('per accommodation: guests, beds listed, beds free', acc('Yatri Nivas').assigned === 2 && acc('Yatri Nivas').beds === 3 && acc('Yatri Nivas').free === 1, acc('Yatri Nivas'));
check('...including one with no rooms listed yet', acc('Hindi University Guesthouse').beds === 0 && acc('Hindi University Guesthouse').assigned === 0);

console.log('\n== Schedules ==');
check('pickups in arrival order, untimed after timed, undated last, Cancelled out',
  b.pickups.map((p) => p.name).join(' > ') === 'Soon NoCar > Soon WithCar > Homeless > Later > Unset', b.pickups.map((p) => p.name));
check('...a date with no time comes after the timed ones on that date', G.buildBoard({ guests: [
  guest('Untimed', { arrival_date: '2026-11-20' }), guest('Timed', { arrival_date: '2026-11-20', arrival_time: '23:00' })], lists, settings, today })
  .pickups.map((p) => p.name).join() === 'Timed,Untimed');
check('a pickup shows the driver\'s phone from the vehicle list', b.pickups.find((p) => p.name === 'Soon WithCar').driverPhone === '09822000000');
check('drops in departure order', b.drops[0].name === 'Unset');

console.log('\n== CSV ==');
const csv = G.guestsCsv(b.guests).split('\r\n');
check('a header row, in the record\'s order', csv[0].startsWith('Sr No,Name,Designation,Phone,'));
check('...with the derived date-time columns', /Arrival Date & Time,Departure Date & Time/.test(csv[0]));
check('a leading + is kept, guarded from formula reading', csv[1].includes(",'+919800000000,"));
check('a leading zero is kept as text', G.guestsCsv([{ ...b.guests[0], phone: '09822000000' }]).includes(',09822000000,'));
check('a value that would run as a formula is neutralised', G.guestsCsv([{ ...b.guests[0], remarks: '=HYPERLINK("x")' }]).includes(`"'=HYPERLINK(""x"")"`));
check('warnings are spelled out', /No accommodation/.test(csv[4]));

console.log('\n== Guests without an account ==');
check('a typed phone keeps its + and leading zero', v({ guest_phone: '+91 0712 230 0000' }).values.guest_phone === '+91 0712 230 0000');
check('...and must look like a phone', v({ guest_phone: 'call me' }).errors.length === 1 && v({ guest_phone: '12' }).errors.length === 1);
check('a typed-in designation can be a whole affiliation, up to 300 characters', v({ guest_designation: 'x'.repeat(300) }).errors.length === 0
  && v({ guest_designation: 'x'.repeat(301) }).errors.length === 1 && v({ arrival_number: 'x'.repeat(121) }).errors.length === 1);
check('an email must be one', v({ guest_email: 'not-an-email' }).errors.length === 1 && v({ guest_email: 'a@b.in' }).errors.length === 0);
check('who they are is shared work (guests.edit)', G.IDENTITY_FIELDS.every((f) => G.FIELD_PERMISSION[f] === 'guests.edit'));
const unl = G.buildBoard({ guests: [{ id: 1, name: 'Typed In', linked: false, registered: 0 }, { id: 2, name: 'Has Account', linked: true, registered: 0 }], lists, settings, today });
check('not signed up is its own flag', unl.guests[0].flags.notSignedUp === true && unl.guests[1].flags.notSignedUp === false);
check('...and both count as not registered', unl.dashboard.notRegistered === 2 && unl.dashboard.notSignedUp === 1);
const csvU = G.guestsCsv(unl.guests);
check('the CSV says which', csvU.includes('Not signed up') && csvU.includes('Signed up, not registered'));

console.log('\n== The table migration ==');
const sqlite3 = require('sqlite3');
const os = require('os');
const path = require('path');
const fs = require('fs');
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guests-mig-')), 't.db');
const tdb = new sqlite3.Database(file);
const run = (q, p = []) => new Promise((ok, no) => tdb.run(q, p, function (e) { e ? no(e) : ok(this); }));
const all = (q, p = []) => new Promise((ok, no) => tdb.all(q, p, (e, r) => (e ? no(e) : ok(r))));
(async () => {
  check('no table yet: nothing to do', (await G.migrateGuestsTable(run, all)) === 'absent');
  // The first version: every guest had to have an account.
  await run(`CREATE TABLE guests (id INTEGER PRIMARY KEY AUTOINCREMENT, phone_number TEXT NOT NULL UNIQUE,
    arrival_date TEXT, room_no TEXT, overall_status TEXT, created_at INTEGER NOT NULL, created_by TEXT, updated_at INTEGER, updated_by TEXT)`);
  await run("INSERT INTO guests (id, phone_number, arrival_date, room_no, overall_status, created_at) VALUES (4, '9800000001', '2026-11-20', '101', 'Invited', 1)");
  await run("INSERT INTO guests (id, phone_number, overall_status, created_at) VALUES (9, '9800000002', 'Confirmed', 2)");
  check('the old table is rebuilt', (await G.migrateGuestsTable(run, all)) === 'rebuilt');
  const rows = await all('SELECT id, phone_number, arrival_date, room_no, overall_status FROM guests ORDER BY id');
  check('...every row kept, with its id and details', JSON.stringify(rows) === JSON.stringify([
    { id: 4, phone_number: '9800000001', arrival_date: '2026-11-20', room_no: '101', overall_status: 'Invited' },
    { id: 9, phone_number: '9800000002', arrival_date: null, room_no: null, overall_status: 'Confirmed' }]), rows);
  await run("INSERT INTO guests (guest_name, created_at) VALUES ('No Account A', 3)");
  await run("INSERT INTO guests (guest_name, created_at) VALUES ('No Account B', 3)");
  check('guests without an account can now be added, more than one', (await all('SELECT COUNT(*) AS n FROM guests WHERE phone_number IS NULL'))[0].n === 2);
  check('...new ids continue after the old ones', (await all("SELECT id FROM guests WHERE guest_name = 'No Account A'"))[0].id === 10);
  let dupe = false;
  try { await run("INSERT INTO guests (phone_number, created_at) VALUES ('9800000001', 5)"); } catch (e) { dupe = /UNIQUE/.test(e.message); }
  check('...and an account still cannot be on the list twice', dupe);
  check('running it again leaves the table alone', (await G.migrateGuestsTable(run, all)) === 'current');
  check('no rebuild table is left behind', (await all("SELECT name FROM sqlite_master WHERE name = 'guests_rebuild'")).length === 0);
  tdb.close();
  report();
})();
