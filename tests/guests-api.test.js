// Guest coordination through the server: who may do what, and that what the
// rules in guests.js say is what the API does.
//
//   * The two new roles exist and open the Guests tab; nobody else's does.
//   * A Transport Coordinator edits travel, not the stay; an Accommodation
//     Coordinator the reverse; both mark faculty and edit the shared fields;
//     neither removes a guest, deletes a vehicle or room, or touches the
//     dropdown lists and settings.
//   * Marking: delegates only, once each; someone not registered can be
//     marked and is flagged.
//   * The coordinator for a side is told of changes someone else makes.
//   * Validation reaches the client as a refusal, and nothing is half-saved.
//   * Masters: unique rooms and vehicles, a vehicle's new label follows it
//     onto its guests, list values in use or required cannot be removed.
//   * The Front Desk lookup knows who is faculty; the activity log shows it.
const { call, check, report, ADMIN_PW, adminLogin, loginPassword, openDb } = require('./harness');

const N = String(Date.now() % 100000000).padStart(8, '0');
const P = { tc: `81${N}`, ac: `82${N}`, reg: `83${N}`, unreg: `84${N}`, other: `85${N}` };

(async () => {
  const admin = await adminLogin();
  const db = openDb();
  const cat = await db.get('SELECT category_key, label FROM fee_categories WHERE active = 1 ORDER BY sort_order, id LIMIT 1');
  const signIn = async (phone) => {
    const r = await call('POST', `/api/users/${phone}/reset-password`, {}, admin);
    const l = await call('POST', '/api/auth/login-password', { identifier: phone, password: r.body.tempPassword });
    await call('POST', '/api/auth/set-password', { password: `own-${N}-pw` }, l.cookie);
    return l.cookie;
  };
  const mkUser = (phone, name, role) => call('POST', '/api/users', { phone, name, email: `ga-${phone}@example.test`, role, designation: 'Professor' }, admin);
  const put = (id, fields, c) => call('PUT', `/api/guests/${id}`, { fields }, c);
  const guestRow = (id) => db.get('SELECT * FROM guests WHERE id = ?', [id]);
  const ids = {};
  const made = { vehicles: [], rooms: [], lists: [] };

  try {
    console.log('\n== The roles ==');
    check('Transport Coordinator can be given to staff', (await mkUser(P.tc, 'Tara Transport', 'TRANSPORT_COORDINATOR')).body.success === true);
    check('Accommodation Coordinator too', (await mkUser(P.ac, 'Anil Accommodation', 'ACCOMMODATION_COORDINATOR')).body.success === true);
    const tc = await signIn(P.tc);
    const ac = await signIn(P.ac);
    const me = async (c) => (await call('GET', '/api/auth/me', null, c)).body;
    const tcMe = await me(tc);
    check('the transport coordinator opens the Guests tab, and nothing else',
      tcMe.sections && tcMe.sections.faculty === true && Object.entries(tcMe.sections).filter(([, v]) => v).length === 1, tcMe.sections);
    check('...holding view, shared edit and travel',
      ['guests.view', 'guests.edit', 'guests.travel'].every((k) => tcMe.permissions.includes(k)) && !tcMe.permissions.includes('guests.stay') && !tcMe.permissions.includes('guests.manage'));
    const acMe = await me(ac);
    check('the accommodation coordinator: view, shared edit and stay',
      ['guests.view', 'guests.edit', 'guests.stay'].every((k) => acMe.permissions.includes(k)) && !acMe.permissions.includes('guests.travel'));
    const desk = await loginPassword('9000000006', ADMIN_PW);
    const finance = await loginPassword('9000000002', ADMIN_PW);
    check('no other role sees guests', (await call('GET', '/api/guests', null, desk)).status === 403 && (await call('GET', '/api/guests', null, finance)).status === 403);
    check('nor anyone signed out', (await call('GET', '/api/guests')).status === 401);

    console.log('\n== Marking faculty ==');
    await mkUser(P.reg, 'Rekha Registered', 'DELEGATE');
    await mkUser(P.unreg, 'Uday Unregistered', 'DELEGATE');
    await mkUser(P.other, 'Omkar Other', 'DELEGATE');
    await db.run(`INSERT INTO registrations (phone_number, delegate_name, category_key, category_label, bank_status) VALUES (?, 'Rekha Registered', ?, ?, 'PENDING')`,
      [P.reg, cat.category_key, cat.label]);
    const found = (await call('GET', `/api/guests/candidates?q=${encodeURIComponent('Rekha Registered')}`, null, tc)).body.results || [];
    check('a coordinator can search delegates', found.some((r) => r.phone_number === P.reg && r.registered === true), found);
    check('...staff are offered too, labelled as staff', ((await call('GET', `/api/guests/candidates?q=Tara`, null, tc)).body.results || []).some((r) => r.phone_number === P.tc && r.staff === true));
    const m1 = await call('POST', '/api/guests', { phone: P.reg }, tc);
    check('the transport coordinator marks a registered delegate', m1.body.success === true && m1.body.registered === true, m1.body);
    const m2 = await call('POST', '/api/guests', { phone: P.unreg }, ac);
    check('the accommodation coordinator marks one not yet registered -- allowed, and said so', m2.body.success === true && m2.body.registered === false, m2.body);
    ids.reg = m1.body.id; ids.unreg = m2.body.id;
    check('a new guest starts as Invited', (await guestRow(ids.reg)).overall_status === 'Invited');
    check('marking twice is refused', (await call('POST', '/api/guests', { phone: P.reg }, tc)).status === 409);
    // An organiser who also speaks: a staff account can be faculty.
    const staffMark = await call('POST', '/api/guests', { phone: P.ac }, tc);
    check('a staff account can be marked as faculty', staffMark.body.success === true, staffMark.body);
    check('...an account that does not exist cannot', (await call('POST', '/api/guests', { phone: `00${N}` }, tc)).status === 404);
    check('the front desk cannot mark', (await call('POST', '/api/guests', { phone: P.other }, desk)).status === 403);
    const board = (await call('GET', '/api/guests', null, tc)).body;
    const g = (id) => board.guests.find((x) => x.id === id);
    check('the list carries their name, designation and phone from the account',
      g(ids.reg).name === 'Rekha Registered' && g(ids.reg).designation === 'Professor' && /\d{10}/.test(g(ids.reg).phone || ''), g(ids.reg));
    check('the unregistered one is flagged', g(ids.unreg).flags.notRegistered === true && g(ids.reg).flags.notRegistered === false);
    check('...and has nowhere to stay yet (red)', g(ids.reg).flags.noAccommodation === true);
    check('both coordinators are offered for their side',
      board.coordinators.transport.some((p) => p.phone === P.tc) && board.coordinators.accommodation.some((p) => p.phone === P.ac)
      && !board.coordinators.transport.some((p) => p.phone === P.ac));

    console.log('\n== The split ==');
    const t1 = await put(ids.reg, { arrival_date: '2026-11-20', arrival_time: '09:30', arrival_mode: 'Flight', arrival_number: '6E 123', arrival_point: 'Nagpur Airport', pickup_status: 'Pending' }, tc);
    check('the transport coordinator sets the arrival', t1.body.success === true && t1.body.changed === 6, t1.body);
    const t2 = await put(ids.reg, { accommodation: 'Yatri Nivas' }, tc);
    check('...but not the stay', t2.status === 403 && /Accommodation/.test(t2.body.error), [t2.status, t2.body.error]);
    const a1 = await put(ids.reg, { accommodation: 'Yatri Nivas', room_no: '101', checkin_date: '2026-11-20', checkout_date: '2026-11-22', room_type: 'Double' }, ac);
    check('the accommodation coordinator sets the stay', a1.body.success === true && a1.body.changed === 5, a1.body);
    const a2 = await put(ids.reg, { pickup_vehicle: 'Somebody' }, ac);
    check('...but not the pickup', a2.status === 403 && /Pickup Vehicle/.test(a2.body.error), [a2.status, a2.body.error]);
    check('both edit the shared fields', (await put(ids.reg, { overall_status: 'Confirmed', special_needs: 'Wheelchair' }, ac)).body.success === true
      && (await put(ids.reg, { remarks: 'Vegetarian' }, tc)).body.success === true);
    const mixed = await put(ids.reg, { remarks: 'Changed', accommodation: 'MGIMS Guesthouse' }, tc);
    check('a request mixing allowed and forbidden fields changes nothing', mixed.status === 403 && (await guestRow(ids.reg)).remarks === 'Vegetarian');
    check('the coordinators can be named only by their side',
      (await put(ids.reg, { transport_coordinator: P.tc }, tc)).body.success === true
      && (await put(ids.reg, { accommodation_coordinator: P.ac }, tc)).status === 403
      && (await put(ids.reg, { accommodation_coordinator: P.ac }, ac)).body.success === true);
    check('...and must hold that role', (await put(ids.reg, { transport_coordinator: P.ac }, tc)).status === 400);

    console.log('\n== Own stay ==');
    check('the transport coordinator cannot mark accommodation not needed', (await put(ids.unreg, { stay_not_needed: true }, tc)).status === 403);
    check('the accommodation coordinator can', (await put(ids.unreg, { stay_not_needed: true }, ac)).body.success === true);
    check('...and it is stored', (await guestRow(ids.unreg)).stay_not_needed === 1);
    const ownBoard = (await call('GET', '/api/guests', null, tc)).body;
    check('they are not short of a room', ownBoard.guests.find((x) => x.id === ids.unreg).flags.noAccommodation === false);
    // The reported error: unticking saved NULL into a NOT NULL column.
    const untick = await put(ids.unreg, { stay_not_needed: false }, ac);
    check('unticking saves, without a server error', untick.status === 200 && untick.body.success === true, [untick.status, untick.body]);
    check('...and it is unticked', (await guestRow(ids.unreg)).stay_not_needed === 0);
    const ownLog = await db.all("SELECT new_value FROM audit_log WHERE action = 'GUEST_UPDATED' AND entity_id = ? AND new_value LIKE 'Accommodation not needed%' ORDER BY id", [String(ids.unreg)]);
    check('the log reads Yes/No both ways', ownLog.length === 2 && /No → Yes/.test(ownLog[0].new_value) && /Yes → No/.test(ownLog[1].new_value), ownLog);
    const legacy = await put(ids.unreg, { transport_not_needed: true }, tc);
    check('"local transport not needed" is gone: sending it changes nothing', legacy.body.success === true && legacy.body.changed === 0);

    console.log('\n== Validation, through the API ==');
    const bad = await put(ids.reg, { departure_date: '2026-11-31', departure_time: '7pm' }, tc);
    check('a bad date and time are refused, each named', bad.status === 400 && /Departure Date is not a valid date/.test(bad.body.error) && /HH:MM/.test(bad.body.error), bad.body.error);
    const backwards = await put(ids.reg, { checkout_date: '2026-11-19' }, ac);
    check('check-out before check-in is refused', backwards.status === 400 && /Check-out/.test(backwards.body.error));
    check('nothing from a refused request is saved', (await guestRow(ids.reg)).checkout_date === '2026-11-22' && !(await guestRow(ids.reg)).departure_date);
    check('a value not on its list is refused', (await put(ids.reg, { arrival_point: 'Mars' }, tc)).status === 400);

    console.log('\n== The coordinator hears about changes made by others ==');
    const byAdmin = await put(ids.reg, { arrival_time: '10:00', room_no: '102' }, admin);
    check('an admin\'s change to travel and stay notifies both coordinators', JSON.stringify(byAdmin.body.notified) === '["travel","stay"]', byAdmin.body);
    const own = await put(ids.reg, { arrival_time: '10:30' }, tc);
    check('the coordinator\'s own change notifies nobody', own.body.success === true && own.body.notified.length === 0, own.body);
    const sharedOnly = await put(ids.reg, { remarks: 'Late check-in' }, ac);
    check('a change to shared fields is not travel or stay news', sharedOnly.body.notified.length === 0);
    check('no coordinator named, nobody told', (await put(ids.unreg, { arrival_date: '2026-11-21' }, admin)).body.notified.length === 0);

    console.log('\n== Vehicles ==');
    const v1 = await call('POST', '/api/guests/vehicles', { label: `Innova ${N}`, driverPhone: '+91 98220 00000', seats: 6 }, tc);
    check('the transport coordinator adds a vehicle', v1.body.success === true, v1.body);
    made.vehicles.push(v1.body.id);
    check('...not the accommodation coordinator', (await call('POST', '/api/guests/vehicles', { label: 'X' }, ac)).status === 403);
    check('a second with the same label is refused', (await call('POST', '/api/guests/vehicles', { label: `innova ${N}` }, tc)).status === 409);
    await put(ids.reg, { pickup_vehicle: `Innova ${N}` }, tc);
    const renamed = await call('PUT', `/api/guests/vehicles/${v1.body.id}`, { label: `Innova ${N} (Ramesh)`, seats: 6 }, tc);
    check('renaming a vehicle', renamed.body.success === true);
    check('...carries the new label onto its guests', (await guestRow(ids.reg)).pickup_vehicle === `Innova ${N} (Ramesh)`);
    const vb = (await call('GET', '/api/guests', null, tc)).body;
    check('...who are still counted against it', vb.vehicles.find((v) => v.id === v1.body.id).pickups === 1);
    check('a coordinator cannot delete a vehicle', (await call('DELETE', `/api/guests/vehicles/${v1.body.id}`, null, tc)).status === 403);

    console.log('\n== Rooms ==');
    const r1 = await call('POST', '/api/guests/rooms', { accommodation: 'Yatri Nivas', roomNo: `R${N}`, roomType: 'Double', beds: 2 }, ac);
    check('the accommodation coordinator adds a room', r1.body.success === true, r1.body);
    made.rooms.push(r1.body.id);
    check('...not the transport coordinator', (await call('POST', '/api/guests/rooms', { accommodation: 'Yatri Nivas', roomNo: 'Z', beds: 1 }, tc)).status === 403);
    check('the same room twice is refused', (await call('POST', '/api/guests/rooms', { accommodation: 'yatri nivas', roomNo: `r${N}`, beds: 1 }, ac)).status === 409);
    check('beds out of range are refused', (await call('POST', '/api/guests/rooms', { accommodation: 'Yatri Nivas', roomNo: `S${N}`, beds: 21 }, ac)).status === 400);
    await put(ids.reg, { room_no: `R${N}` }, ac);
    await put(ids.unreg, { accommodation: 'Yatri Nivas', room_no: `R${N}` }, ac);
    const rb = (await call('GET', '/api/guests', null, ac)).body;
    const theRoom = rb.rooms.find((r) => r.id === r1.body.id);
    check('the room shows who is in it, and Full', theRoom.occupied === 2 && theRoom.status === 'Full' && theRoom.guests.length === 2, theRoom);
    check('...and both guests carry the purple warning', rb.guests.find((x) => x.id === ids.reg).flags.sharedRoom.length === 1);

    console.log('\n== Rooms in bulk ==');
    const bulk = await call('POST', '/api/guests/rooms', { accommodation: 'MGIMS Guesthouse', roomNo: `B${N}-1 , B${N}-2`, beds: 1 }, ac);
    check('a list of rooms is added in one go', bulk.body.success === true && bulk.body.created.length === 2, bulk.body);
    const range = await call('POST', '/api/guests/rooms', { accommodation: 'MGIMS Guesthouse', roomNo: `Z${N.slice(-3)}1-Z${N.slice(-3)}5`, roomType: 'Double', beds: 2 }, ac);
    check('a range adds every room in it, with the same details', range.body.success === true && range.body.created.length === 5 && range.body.skipped.length === 0, range.body);
    const overlap = await call('POST', '/api/guests/rooms', { accommodation: 'MGIMS Guesthouse', roomNo: `Z${N.slice(-3)}4-Z${N.slice(-3)}7`, roomType: 'Double', beds: 2 }, ac);
    check('an overlapping range adds only the new rooms, and names the ones skipped', overlap.body.success === true
      && JSON.stringify(overlap.body.created) === JSON.stringify([`Z${N.slice(-3)}6`, `Z${N.slice(-3)}7`]) && overlap.body.skipped.length === 2, overlap.body);
    check('a range wholly on the list already is refused', (await call('POST', '/api/guests/rooms', { accommodation: 'MGIMS Guesthouse', roomNo: `Z${N.slice(-3)}1-Z${N.slice(-3)}3`, beds: 2 }, ac)).status === 409);
    const inDb = await db.all("SELECT room_type, beds FROM guest_rooms WHERE accommodation = 'MGIMS Guesthouse' AND room_no LIKE ?", [`Z${N.slice(-3)}%`]);
    check('...all seven stored with the details given', inDb.length === 7 && inDb.every((r) => r.room_type === 'Double' && r.beds === 2), inDb.length);
    check('beds out of range refuse the whole batch', (await call('POST', '/api/guests/rooms', { accommodation: 'MGIMS Guesthouse', roomNo: `Q${N}1-Q${N}3`, beds: 30 }, ac)).status === 400
      && !(await db.get('SELECT 1 FROM guest_rooms WHERE room_no LIKE ?', [`Q${N}%`])));
    const batchLog = await db.all("SELECT new_value FROM audit_log WHERE action = 'GUEST_ROOM_ADDED' AND new_value LIKE ?", [`%Z${N.slice(-3)}1%`]);
    check('a batch is one line in the activity log', batchLog.length === 1 && /5 rooms/.test(batchLog[0].new_value), batchLog);
    const oneRoom = await db.get("SELECT id FROM guest_rooms WHERE room_no = ?", [`Z${N.slice(-3)}1`]);
    check('editing stays one room at a time', (await call('PUT', `/api/guests/rooms/${oneRoom.id}`, { accommodation: 'MGIMS Guesthouse', roomNo: '1-3', beds: 2 }, ac)).status === 400);
    await db.run("DELETE FROM guest_rooms WHERE accommodation = 'MGIMS Guesthouse' AND (room_no LIKE ? OR room_no LIKE ?)", [`Z${N.slice(-3)}%`, `B${N}%`]);

    console.log('\n== Lists and settings: admin only ==');
    check('a coordinator cannot add a list value', (await call('POST', '/api/guests/lists', { listKey: 'mode', value: 'Bus' }, tc)).status === 403);
    check('...nor change settings', (await call('PUT', '/api/guests/settings', { alertDays: 3, clashMinutes: 60, slotBounds: [6, 12, 18] }, ac)).status === 403);
    check('...nor remove a guest', (await call('DELETE', `/api/guests/${ids.unreg}`, null, ac)).status === 403);
    const added = await call('POST', '/api/guests/lists', { listKey: 'mode', value: `Bus ${N}` }, admin);
    check('an admin adds a value', added.body.success === true);
    made.lists.push(added.body.id);
    check('...the same value twice is refused', (await call('POST', '/api/guests/lists', { listKey: 'mode', value: `bus ${N}` }, admin)).status === 409);
    const rows = (await call('GET', '/api/guests', null, admin)).body.listRows;
    const cancelled = rows.find((r) => r.list_key === 'overall_status' && r.value === 'Cancelled');
    check('"Cancelled" is required: it cannot be switched off', (await call('PUT', `/api/guests/lists/${cancelled.id}`, { active: false }, admin)).status === 400);
    check('...or removed', (await call('DELETE', `/api/guests/lists/${cancelled.id}`, null, admin)).status === 400);
    const yatri = rows.find((r) => r.list_key === 'accommodation' && r.value === 'Yatri Nivas');
    check('a value in use cannot be removed', (await call('DELETE', `/api/guests/lists/${yatri.id}`, null, admin)).status === 409);
    check('...but can be switched off, and then is not offered', (await call('PUT', `/api/guests/lists/${added.body.id}`, { active: false }, admin)).body.success === true
      && !(await call('GET', '/api/guests', null, admin)).body.lists.mode.includes(`Bus ${N}`));
    check('...or removed when unused', (await call('DELETE', `/api/guests/lists/${added.body.id}`, null, admin)).body.success === true);
    made.lists = [];
    const before = (await call('GET', '/api/guests', null, admin)).body.settings;
    check('settings refuse nonsense', (await call('PUT', '/api/guests/settings', { alertDays: -1, clashMinutes: 0, slotBounds: [18, 12, 6] }, admin)).status === 400);
    check('...and save sense', (await call('PUT', '/api/guests/settings', { alertDays: 3, clashMinutes: 45, slotBounds: [5, 12, 17] }, admin)).body.success === true);
    const after = (await call('GET', '/api/guests', null, admin)).body;
    check('...which the board then uses', after.settings.alertDays === 3 && after.slotLabels[0] === 'Night 12 AM–5 AM', after.slotLabels);
    await call('PUT', '/api/guests/settings', before, admin);

    console.log('\n== CSV, the Front Desk, the activity log ==');
    const csv = await call('GET', '/api/guests/export.csv', null, ac);
    check('a coordinator downloads the CSV', csv.status === 200 && /text\/csv/.test(csv.headers['content-type']) && csv.raw.includes('Rekha Registered'), csv.status);
    const deskView = (await call('GET', `/api/desk/delegate/${P.reg}`, null, admin)).body;
    check('the Front Desk lookup knows they are faculty', deskView.guest && deskView.guest.id === ids.reg, deskView.guest);
    check('...and someone who is not', (await call('GET', `/api/desk/delegate/${P.other}`, null, admin)).body.guest === null);
    const log = (await call('GET', '/api/admin/activity-log', null, admin)).body.master || [];
    check('marking, editing and masters are in the activity log',
      ['GUEST_ADDED', 'GUEST_UPDATED', 'GUEST_VEHICLE_ADDED', 'GUEST_ROOM_ADDED', 'GUEST_LIST_VALUE_ADDED', 'GUEST_SETTINGS_UPDATED'].every((a) => log.some((r) => r.action === a)));

    console.log('\n== Removing ==');
    const del = await call('DELETE', `/api/guests/${ids.unreg}`, null, admin);
    check('an admin removes a guest', del.body.success === true && !(await guestRow(ids.unreg)));
    const gone = await db.get("SELECT old_value FROM audit_log WHERE action = 'GUEST_REMOVED' AND entity_id = ?", [String(ids.unreg)]);
    check('...and the log keeps what was removed', gone && /Uday Unregistered/.test(gone.old_value) && /Arrival Date: 2026-11-21/.test(gone.old_value), gone);
  } finally {
    await db.run(`DELETE FROM guests WHERE phone_number IN (${Object.values(P).map(() => '?').join(',')})`, Object.values(P));
    for (const v of made.vehicles) await db.run('DELETE FROM guest_vehicles WHERE id = ?', [v]);
    for (const r of made.rooms) await db.run('DELETE FROM guest_rooms WHERE id = ?', [r]);
    for (const l of made.lists) await db.run('DELETE FROM guest_lists WHERE id = ?', [l]);
    await db.run(`DELETE FROM registrations WHERE phone_number IN (${Object.values(P).map(() => '?').join(',')})`, Object.values(P));
    await db.run(`DELETE FROM users WHERE phone_number IN (${Object.values(P).map(() => '?').join(',')})`, Object.values(P));
  }
  db.close();
  report();
})();
