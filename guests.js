// Guest coordination: the pure parts -- which fields exist and who may edit
// them, validation, and everything worked out from the guest list (flags,
// schedules, vehicle and room tallies, the dashboard). No database here:
// server.js reads the rows and hands them in, so all of this can be tested
// without a server, and nothing derived is ever stored.
//
// A guest is a faculty member the conference looks after: one row per
// person. Usually linked to their portal account, which then supplies their
// name, designation, phone and email. A guest who has not signed up yet is
// added by name, with those details typed in (the guest_* fields), and linked
// to their account once they have one. Everything else -- travel, pickup,
// stay -- lives on the guest row either way.

// Who may edit what. Travel belongs to the Transport Coordinator, stay to the
// Accommodation Coordinator; the rest is shared by both.
const TRAVEL_FIELDS = [
  'transport_not_needed',
  'arrival_date', 'arrival_time', 'arrival_mode', 'arrival_number', 'arrival_point', 'pickup_vehicle', 'pickup_status',
  'departure_date', 'departure_time', 'departure_mode', 'departure_number', 'departure_point', 'drop_vehicle', 'drop_status',
  'transport_coordinator',
];
const STAY_FIELDS = ['stay_not_needed', 'accommodation', 'room_no', 'checkin_date', 'checkout_date', 'room_type', 'accommodation_coordinator'];
const GENERAL_FIELDS = ['special_needs', 'overall_status', 'remarks'];
// Who a guest without an account is. Ignored once linked: the account says.
const IDENTITY_FIELDS = ['guest_name', 'guest_designation', 'guest_phone', 'guest_email'];
const ALL_FIELDS = [...IDENTITY_FIELDS, ...TRAVEL_FIELDS, ...STAY_FIELDS, ...GENERAL_FIELDS];
const FIELD_PERMISSION = Object.fromEntries([
  ...IDENTITY_FIELDS.map((f) => [f, 'guests.edit']),
  ...TRAVEL_FIELDS.map((f) => [f, 'guests.travel']),
  ...STAY_FIELDS.map((f) => [f, 'guests.stay']),
  ...GENERAL_FIELDS.map((f) => [f, 'guests.edit']),
]);

// The travel details a Transport Coordinator is emailed about when somebody
// else changes them; the stay details likewise for accommodation. Who the
// coordinator is does not count as a change to the guest's travel.
const TRAVEL_NOTIFY_FIELDS = TRAVEL_FIELDS.filter((f) => f !== 'transport_coordinator');
const STAY_NOTIFY_FIELDS = STAY_FIELDS.filter((f) => f !== 'accommodation_coordinator');

const FIELD_LABELS = {
  guest_name: 'Name', guest_designation: 'Designation', guest_phone: 'Phone', guest_email: 'Email',
  transport_not_needed: 'Local transport not needed', stay_not_needed: 'Accommodation not needed',
  arrival_date: 'Arrival Date', arrival_time: 'Arrival Time', arrival_mode: 'Arrival Mode',
  arrival_number: 'Arrival Flight/Train No', arrival_point: 'Arrival Point',
  pickup_vehicle: 'Pickup Vehicle/Driver', pickup_status: 'Pickup Status',
  departure_date: 'Departure Date', departure_time: 'Departure Time', departure_mode: 'Departure Mode',
  departure_number: 'Departure Flight/Train No', departure_point: 'Departure Point',
  drop_vehicle: 'Drop Vehicle/Driver', drop_status: 'Drop Status',
  transport_coordinator: 'Transport Coordinator',
  accommodation: 'Accommodation', room_no: 'Room No', checkin_date: 'Check-in Date',
  checkout_date: 'Check-out Date', room_type: 'Room Type', accommodation_coordinator: 'Accommodation Coordinator',
  special_needs: 'Special Needs', overall_status: 'Overall Status', remarks: 'Remarks',
};

// Which admin-editable list each dropdown draws from. Arrival and departure
// share one list of modes and one of points, pickup and drop one of statuses.
const FIELD_LISTS = {
  arrival_mode: 'mode', departure_mode: 'mode',
  arrival_point: 'point', departure_point: 'point',
  pickup_status: 'transfer_status', drop_status: 'transfer_status',
  accommodation: 'accommodation', room_type: 'room_type', overall_status: 'overall_status',
};
const LIST_LABELS = {
  mode: 'Mode', point: 'Arrival / Departure Point', transfer_status: 'Pickup / Drop Status',
  accommodation: 'Accommodation', room_type: 'Room Type', overall_status: 'Overall Status',
};
const DEFAULT_LISTS = {
  mode: ['Flight', 'Train', 'Road', 'Other'],
  point: ['Nagpur Airport', 'Nagpur Railway Station', 'Wardha Railway Station', 'Sevagram Railway Station', 'Direct by Road', 'Other'],
  transfer_status: ['Pending', 'Assigned', 'Done', 'Not required'],
  accommodation: ['Yatri Nivas', 'MGIMS Guesthouse', 'Hindi University Guesthouse'],
  room_type: ['Single', 'Double', 'Triple', 'Suite'],
  overall_status: ['Invited', 'Confirmed', 'Arrived', 'Departed', 'Cancelled'],
};
const CANCELLED = 'Cancelled';
// Values the app's own rules read. They cannot be switched off or removed,
// or "Cancelled" guests would quietly start counting again.
const PROTECTED_VALUES = { overall_status: [CANCELLED] };

const DEFAULT_SETTINGS = { alertDays: 2, slotBounds: [6, 12, 18], clashMinutes: 60 };
const SLOT_NAMES = ['Night', 'Morning', 'Afternoon', 'Evening'];

// Longest a field may be. A typed-in designation is often the whole
// affiliation ("Professor & Head, Dept of ..., College, City").
const MAX_LENGTH = { special_needs: 1000, remarks: 1000, guest_designation: 300 };
// Yes/no: they make their own way, or their own stay.
const BOOL_FIELDS = new Set(['transport_not_needed', 'stay_not_needed']);
const truthy = (v) => v === true || v === 1 || ['1', 'true', 'on', 'yes'].includes(String(v).trim().toLowerCase());
// How a value reads in the activity log and an email.
const displayValue = (field, v) => (BOOL_FIELDS.has(field) ? (Number(v) ? 'Yes' : 'No') : (v == null || v === '' ? '—' : String(v)));
const DATE_FIELDS = new Set(['arrival_date', 'departure_date', 'checkin_date', 'checkout_date']);
const TIME_FIELDS = new Set(['arrival_time', 'departure_time']);
const COORDINATOR_FIELDS = new Set(['transport_coordinator', 'accommodation_coordinator']);

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
const blank = (v) => v == null || String(v).trim() === '';

// A real calendar date, not merely date-shaped: 2026-02-30 is refused.
function validDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}
// 24-hour HH:MM.
const validTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// "2026-11-20 14:30", or just the date when no time is set.
const joinDateTime = (date, time) => (date ? (time ? `${date} ${time}` : date) : '');
// Minutes on a common scale, for comparing two trips; null without a time.
const minutesAt = (date, time) => {
  if (!date || !time) return null;
  const [h, mi] = time.split(':').map(Number);
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d, h, mi) / 60000;
};

// Check and tidy the fields a request wants to change.
//
//   input       -- { field: value } from the client; only listed fields count
//   current     -- the guest as stored (for the check-in/check-out pair and
//                  for list values that have since been switched off)
//   lists       -- { listKey: [active values] }
//   coordinators -- { transport: Set(phone), accommodation: Set(phone) }
//
// Returns { values, errors }: values holds only the fields that were sent,
// tidied (blank -> null); errors names each problem in words a coordinator
// can act on.
function validateGuestFields(input, current = {}, lists = {}, coordinators = {}) {
  const values = {};
  const errors = [];
  for (const field of ALL_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input || {}, field)) continue;
    const raw = input[field];
    if (BOOL_FIELDS.has(field)) { values[field] = truthy(raw) ? 1 : 0; continue; }
    const v = blank(raw) ? null : String(raw).trim();
    const label = FIELD_LABELS[field];
    if (v != null && v.length > (MAX_LENGTH[field] || 120)) {
      errors.push(`${label} is too long.`);
      continue;
    }
    if (v != null && DATE_FIELDS.has(field) && !validDate(v)) { errors.push(`${label} is not a valid date.`); continue; }
    if (v != null && TIME_FIELDS.has(field) && !validTime(v)) { errors.push(`${label} must be 24-hour HH:MM, e.g. 14:30.`); continue; }
    // Saved without spaces; otherwise as typed (a leading + or 0 included).
    if (field === 'guest_phone' && v != null) {
      const compact = v.replace(/\s+/g, '');
      if (!(/^\+?[0-9][0-9()-]*$/.test(compact) && compact.replace(/\D/g, '').length >= 6 && compact.length <= 20)) {
        errors.push('Phone should be digits, with an optional leading +.'); continue;
      }
      values[field] = compact;
      continue;
    }
    if (v != null && field === 'guest_email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { errors.push('Email is not a valid address.'); continue; }
    if (v != null && FIELD_LISTS[field]) {
      const allowed = lists[FIELD_LISTS[field]] || [];
      // A value already on the guest stays acceptable after it is switched
      // off in the list, so editing something else does not fail on it.
      const match = allowed.find((a) => norm(a) === norm(v));
      if (!match && norm(v) !== norm(current[field])) { errors.push(`${label}: "${v}" is not on the list.`); continue; }
      values[field] = match || current[field];
      continue;
    }
    if (v != null && COORDINATOR_FIELDS.has(field)) {
      const pool = field === 'transport_coordinator' ? coordinators.transport : coordinators.accommodation;
      if (!pool || !pool.has(v)) { errors.push(`${label} must be a staff member who holds that role.`); continue; }
    }
    values[field] = v;
  }
  const merged = { ...current, ...values };
  // A time means nothing without its date.
  for (const [d, t] of [['arrival_date', 'arrival_time'], ['departure_date', 'departure_time']]) {
    if (!blank(merged[t]) && blank(merged[d]) && (d in values || t in values)) {
      errors.push(`${FIELD_LABELS[t]} needs ${FIELD_LABELS[d]} too.`);
    }
  }
  if (!blank(merged.checkin_date) && !blank(merged.checkout_date) && merged.checkout_date < merged.checkin_date
    && ('checkin_date' in values || 'checkout_date' in values)) {
    errors.push('Check-out Date cannot be before Check-in Date.');
  }
  return { values, errors };
}

// The fields a role may not change, among those a request would change.
function forbiddenChanges(values, current, mayEdit) {
  return changedFields(current, values, Object.keys(values)).map((c) => c.field).filter((f) => !mayEdit(FIELD_PERMISSION[f]));
}

// Field-by-field differences, for the activity log and the coordinator email.
function changedFields(before, values, fields = ALL_FIELDS) {
  const same = (f) => (BOOL_FIELDS.has(f) ? Number(before[f] || 0) === Number(values[f] || 0) : (before[f] || null) === (values[f] || null));
  return fields.filter((f) => f in values && !same(f))
    .map((f) => ({ field: f, label: FIELD_LABELS[f], from: before[f] || null, to: values[f] || null }));
}

function validateVehicle(body) {
  const errors = [];
  const label = blank(body.label) ? '' : String(body.label).trim();
  if (!label) errors.push('Enter the vehicle or driver label.');
  else if (label.length > 120) errors.push('The label is too long.');
  // Saved without spaces, like a guest's phone.
  const driverPhone = blank(body.driverPhone) ? null : String(body.driverPhone).replace(/\s+/g, '');
  if (driverPhone && !/^\+?[0-9][0-9-]{3,19}$/.test(driverPhone)) errors.push('Driver Phone should be digits, with an optional leading +.');
  let seats = null;
  if (!blank(body.seats)) {
    seats = Number(body.seats);
    if (!Number.isInteger(seats) || seats < 1 || seats > 99) errors.push('Seats must be a whole number from 1 to 99.');
  }
  return { values: { label, driver_phone: driverPhone, seats }, errors };
}

function validateRoom(body, lists = {}) {
  const errors = [];
  const accommodation = blank(body.accommodation) ? '' : String(body.accommodation).trim();
  const accMatch = (lists.accommodation || []).find((a) => norm(a) === norm(accommodation));
  if (!accommodation) errors.push('Choose the accommodation.');
  else if (!accMatch && !body.allowExisting) errors.push(`Accommodation: "${accommodation}" is not on the list.`);
  const roomNo = blank(body.roomNo) ? '' : String(body.roomNo).trim();
  if (!roomNo) errors.push('Enter the room number.');
  else if (roomNo.length > 40) errors.push('The room number is too long.');
  const roomType = blank(body.roomType) ? null : String(body.roomType).trim();
  const typeMatch = roomType ? (lists.room_type || []).find((a) => norm(a) === norm(roomType)) : null;
  if (roomType && !typeMatch && !body.allowExisting) errors.push(`Room Type: "${roomType}" is not on the list.`);
  const beds = Number(body.beds);
  if (blank(body.beds) || !Number.isInteger(beds) || beds < 1 || beds > 20) errors.push('Beds must be a whole number from 1 to 20.');
  return { values: { accommodation: accMatch || accommodation, room_no: roomNo, room_type: typeMatch || roomType, beds }, errors };
}

function validateSettings(body) {
  const errors = [];
  const alertDays = Number(body.alertDays);
  if (!Number.isInteger(alertDays) || alertDays < 0 || alertDays > 30) errors.push('The alert window must be a whole number of days from 0 to 30.');
  const clashMinutes = Number(body.clashMinutes);
  if (!Number.isInteger(clashMinutes) || clashMinutes < 1 || clashMinutes > 720) errors.push('The vehicle clash window must be a whole number of minutes from 1 to 720.');
  const slotBounds = Array.isArray(body.slotBounds) ? body.slotBounds.map(Number) : [];
  if (slotBounds.length !== 3 || !slotBounds.every((h) => Number.isInteger(h) && h >= 1 && h <= 23)
    || !(slotBounds[0] < slotBounds[1] && slotBounds[1] < slotBounds[2])) {
    errors.push('Time slots need three hours in order, each from 1 to 23 (e.g. 6, 12, 18).');
  }
  return { values: { alertDays, clashMinutes, slotBounds }, errors };
}

// Which named slot a 24-hour time falls in, given the three boundaries.
function slotOf(time, bounds) {
  const h = Number(String(time).slice(0, 2));
  if (h < bounds[0]) return 0;
  if (h < bounds[1]) return 1;
  if (h < bounds[2]) return 2;
  return 3;
}
function slotLabels(bounds) {
  const pad = (n) => String(n).padStart(2, '0');
  const edges = [0, ...bounds, 24];
  return SLOT_NAMES.map((name, i) => `${name} ${pad(edges[i])}-${pad(edges[i + 1])}`);
}

// Everything the Guests tab shows, from the rows as stored.
//
//   guests   -- rows with the account's name/designation/phone joined on,
//               plus `registered`
//   vehicles -- { id, label, driver_phone, seats }
//   rooms    -- { id, accommodation, room_no, room_type, beds }
//   lists    -- { listKey: [values in order] }, used to order the counts
//   settings -- { alertDays, slotBounds, clashMinutes }
//   today    -- the IST calendar date
function buildBoard({ guests = [], vehicles = [], rooms = [], lists = {}, settings = DEFAULT_SETTINGS, today }) {
  const ordered = [...guests].sort((a, b) => a.id - b.id);
  const isCancelled = (g) => norm(g.overall_status) === norm(CANCELLED);
  const live = ordered.filter((g) => !isCancelled(g));
  const windowEnd = addDays(today, settings.alertDays);
  const roomKey = (acc, no) => (blank(acc) || blank(no) ? null : `${norm(acc)}|${norm(no)}`);

  // Guests sharing a room (Accommodation + Room No), cancelled ones aside.
  const byRoom = new Map();
  for (const g of live) {
    const k = roomKey(g.accommodation, g.room_no);
    if (!k) continue;
    if (!byRoom.has(k)) byRoom.set(k, []);
    byRoom.get(k).push(g);
  }

  // Every timed trip a named vehicle makes, pickups and drops together -- a
  // car cannot be at the airport and the station at once.
  const vehicleByKey = new Map(vehicles.map((v) => [norm(v.label), v]));
  // Someone making their own way is not met, dropped, or driven.
  const needsTransport = (g) => !Number(g.transport_not_needed);
  const needsStay = (g) => !Number(g.stay_not_needed);
  const trips = [];
  for (const g of live.filter(needsTransport)) {
    if (!blank(g.pickup_vehicle)) {
      trips.push({ key: norm(g.pickup_vehicle), vehicle: g.pickup_vehicle, kind: 'Pickup', guestId: g.id, name: g.name,
        date: g.arrival_date, time: g.arrival_time, point: g.arrival_point, at: minutesAt(g.arrival_date, g.arrival_time) });
    }
    if (!blank(g.drop_vehicle)) {
      trips.push({ key: norm(g.drop_vehicle), vehicle: g.drop_vehicle, kind: 'Drop', guestId: g.id, name: g.name,
        date: g.departure_date, time: g.departure_time, point: g.departure_point, at: minutesAt(g.departure_date, g.departure_time) });
    }
  }
  const clashes = [];
  const byVehicle = new Map();
  for (const t of trips) {
    if (!byVehicle.has(t.key)) byVehicle.set(t.key, []);
    byVehicle.get(t.key).push(t);
  }
  for (const list of byVehicle.values()) {
    const timed = list.filter((t) => t.at != null).sort((a, b) => a.at - b.at);
    for (let i = 0; i < timed.length; i++) {
      for (let j = i + 1; j < timed.length && timed[j].at - timed[i].at <= settings.clashMinutes; j++) {
        clashes.push({ vehicle: timed[i].vehicle, minutesApart: timed[j].at - timed[i].at, a: timed[i], b: timed[j] });
      }
    }
  }
  const clashGuests = new Map();
  for (const c of clashes) {
    for (const [self, other] of [[c.a, c.b], [c.b, c.a]]) {
      if (!clashGuests.has(self.guestId)) clashGuests.set(self.guestId, []);
      clashGuests.get(self.guestId).push(`${self.kind} in ${c.vehicle} is ${c.minutesApart} min from ${other.name}'s ${other.kind.toLowerCase()} (${other.time})`);
    }
  }

  const rows = ordered.map((g, i) => {
    const cancelled = isCancelled(g);
    const k = roomKey(g.accommodation, g.room_no);
    const roommates = !cancelled && k ? byRoom.get(k).filter((o) => o.id !== g.id).map((o) => o.name) : [];
    const arrivingSoon = !cancelled && needsTransport(g) && !blank(g.arrival_date) && g.arrival_date >= today && g.arrival_date <= windowEnd;
    return {
      ...g,
      sr_no: i + 1,
      arrival_at: joinDateTime(g.arrival_date, g.arrival_time),
      departure_at: joinDateTime(g.departure_date, g.departure_time),
      cancelled,
      flags: {
        // Orange: arriving within the alert window, and nobody to meet them.
        pickupAlert: arrivingSoon && blank(g.pickup_vehicle),
        // Red: nowhere to stay.
        noAccommodation: !cancelled && needsStay(g) && !blank(g.name) && blank(g.accommodation),
        ownTransport: !needsTransport(g),
        ownStay: !needsStay(g),
        // Purple, a warning only: sharing can be intended.
        sharedRoom: roommates,
        vehicleClash: clashGuests.get(g.id) || [],
        notRegistered: !Number(g.registered),
        // Added by name, not yet linked to an account.
        notSignedUp: !g.linked,
      },
    };
  });

  const countBy = (list, field, order = []) => {
    const counts = new Map();
    for (const g of list) {
      const v = blank(g[field]) ? null : g[field];
      const k = v == null ? null : (order.find((o) => norm(o) === norm(v)) || v);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const out = order.filter((o) => counts.has(o)).map((o) => ({ value: o, count: counts.get(o) }));
    for (const [k, n] of counts) if (k != null && !order.includes(k)) out.push({ value: k, count: n });
    out.push({ value: null, count: counts.get(null) || 0 });   // "not set", always shown
    return out;
  };
  const tally = (list, keyOf) => {
    const m = new Map();
    for (const g of list) { const k = keyOf(g); if (k != null) m.set(k, (m.get(k) || 0) + 1); }
    return [...m].map(([value, count]) => ({ value, count }));
  };
  const labels = slotLabels(settings.slotBounds);
  const movement = (dateF, timeF, pointF) => {
    const dated = live.filter((g) => !blank(g[dateF]));
    const bySlot = labels.map((label, i) => ({
      value: label, count: dated.filter((g) => !blank(g[timeF]) && slotOf(g[timeF], settings.slotBounds) === i).length,
    }));
    bySlot.push({ value: null, count: dated.filter((g) => blank(g[timeF])).length });
    return {
      total: dated.length,
      byDate: tally(dated, (g) => g[dateF]).sort((a, b) => a.value.localeCompare(b.value)),
      byPoint: countBy(dated, pointF, lists.point || []).filter((r) => r.value != null || r.count),
      bySlot,
    };
  };

  // Rooms: who is in each, and how full it is.
  const roomRows = rooms.map((r) => {
    const occupants = byRoom.get(roomKey(r.accommodation, r.room_no)) || [];
    const n = occupants.length;
    const status = n === 0 ? 'Vacant' : n < r.beds ? 'Partly filled' : n === r.beds ? 'Full' : 'Over capacity';
    return { ...r, occupied: n, status, guests: occupants.map((g) => g.name) };
  });
  const listedRoomKeys = new Set(rooms.map((r) => roomKey(r.accommodation, r.room_no)));
  const unlistedRooms = [...byRoom.entries()].filter(([k]) => !listedRoomKeys.has(k))
    .map(([, gs]) => ({ accommodation: gs[0].accommodation, room_no: gs[0].room_no, guests: gs.map((g) => g.name) }));

  const vehicleRows = vehicles.map((v) => ({
    ...v,
    pickups: live.filter((g) => norm(g.pickup_vehicle) === norm(v.label)).length,
    drops: live.filter((g) => norm(g.drop_vehicle) === norm(v.label)).length,
  }));

  // Per accommodation: guests placed there against beds on the room list.
  const accNames = [...(lists.accommodation || [])];
  for (const n of [...rooms.map((r) => r.accommodation), ...live.map((g) => g.accommodation)]) {
    if (!blank(n) && !accNames.some((a) => norm(a) === norm(n))) accNames.push(n);
  }
  const perAccommodation = accNames.map((name) => {
    const assigned = live.filter((g) => norm(g.accommodation) === norm(name)).length;
    const beds = rooms.filter((r) => norm(r.accommodation) === norm(name)).reduce((s, r) => s + (Number(r.beds) || 0), 0);
    return { accommodation: name, assigned, beds, free: beds - assigned };
  });

  // Schedules: who to meet and who to see off, in order. Undated last; on a
  // date, untimed after the timed ones.
  const schedule = (dateF, timeF) => [...rows.filter((g) => !g.cancelled && needsTransport(g))].sort((a, b) => {
    if (blank(a[dateF]) !== blank(b[dateF])) return blank(a[dateF]) ? 1 : -1;
    if (a[dateF] !== b[dateF]) return String(a[dateF]).localeCompare(String(b[dateF]));
    if (blank(a[timeF]) !== blank(b[timeF])) return blank(a[timeF]) ? 1 : -1;
    return String(a[timeF] || '').localeCompare(String(b[timeF] || '')) || a.id - b.id;
  });
  const driverOf = (label) => { const v = vehicleByKey.get(norm(label)); return v ? v.driver_phone || null : null; };
  const pickups = schedule('arrival_date', 'arrival_time').map((g) => ({
    id: g.id, name: g.name, phone: g.phone, at: g.arrival_at, mode: g.arrival_mode, number: g.arrival_number,
    point: g.arrival_point, vehicle: g.pickup_vehicle, driverPhone: driverOf(g.pickup_vehicle), status: g.pickup_status,
    clash: g.flags.vehicleClash.filter((c) => c.startsWith('Pickup')), alert: g.flags.pickupAlert,
  }));
  const drops = schedule('departure_date', 'departure_time').map((g) => ({
    id: g.id, name: g.name, phone: g.phone, at: g.departure_at, mode: g.departure_mode, number: g.departure_number,
    point: g.departure_point, vehicle: g.drop_vehicle, driverPhone: driverOf(g.drop_vehicle), status: g.drop_status,
    clash: g.flags.vehicleClash.filter((c) => c.startsWith('Drop')),
  }));

  const soon = live.filter((g) => !blank(g.arrival_date) && g.arrival_date >= today && g.arrival_date <= windowEnd);
  const transported = live.filter(needsTransport);
  const dashboard = {
    listed: live.length,
    cancelled: ordered.length - live.length,
    total: ordered.length,
    // Every guest here, Cancelled included: it is one of the statuses.
    byOverallStatus: countBy(ordered, 'overall_status', lists.overall_status || []),
    // Pickups and drops only for those who need local transport.
    byPickupStatus: countBy(transported, 'pickup_status', lists.transfer_status || []),
    byDropStatus: countBy(transported, 'drop_status', lists.transfer_status || []),
    ownTransport: live.length - transported.length,
    ownStay: live.filter((g) => !needsStay(g)).length,
    alert: { days: settings.alertDays, from: today, to: windowEnd, arriving: soon.length,
      noVehicle: soon.filter((g) => needsTransport(g) && blank(g.pickup_vehicle)).length },
    noAccommodation: rows.filter((g) => g.flags.noAccommodation).length,
    notRegistered: live.filter((g) => !Number(g.registered)).length,
    notSignedUp: live.filter((g) => !g.linked).length,
    sharedRooms: [...byRoom.values()].filter((gs) => gs.length > 1).length,
    vehicleClashes: clashes.length,
    arrivals: movement('arrival_date', 'arrival_time', 'arrival_point'),
    departures: movement('departure_date', 'departure_time', 'departure_point'),
    perAccommodation,
  };

  return { guests: rows, vehicles: vehicleRows, rooms: roomRows, unlistedRooms, pickups, drops, clashes, dashboard, slotLabels: labels };
}

// The guest list as CSV, in the order of the record, then the derived
// columns. A cell that a spreadsheet would read as a formula (= + - @) is
// prefixed with an apostrophe -- which also keeps a phone's leading + and
// zeros as typed.
const CSV_COLUMNS = [
  ['Sr No', (g) => g.sr_no], ['Name', (g) => g.name], ['Designation', (g) => g.designation], ['Phone', (g) => g.phone],
  ['Email', (g) => g.email],
  ['Registration No', (g) => g.registration_number],
  ['Account', (g) => (!g.linked ? 'Not signed up' : Number(g.registered) ? 'Registered' : 'Signed up, not registered')],
  ...['arrival_date', 'arrival_time', 'arrival_mode', 'arrival_number', 'arrival_point', 'pickup_vehicle', 'pickup_status',
    'departure_date', 'departure_time', 'departure_mode', 'departure_number', 'departure_point', 'drop_vehicle', 'drop_status',
    'accommodation', 'room_no', 'checkin_date', 'checkout_date', 'room_type', 'special_needs']
    .map((f) => [FIELD_LABELS[f], (g) => g[f]]),
  ['Transport Coordinator', (g) => g.transport_coordinator_name], ['Accommodation Coordinator', (g) => g.accommodation_coordinator_name],
  ['Local transport needed', (g) => (Number(g.transport_not_needed) ? 'No' : 'Yes')],
  ['Accommodation needed', (g) => (Number(g.stay_not_needed) ? 'No' : 'Yes')],
  ['Overall Status', (g) => g.overall_status], ['Remarks', (g) => g.remarks],
  ['Arrival Date & Time', (g) => g.arrival_at], ['Departure Date & Time', (g) => g.departure_at],
  ['Warnings', (g) => [
    g.flags.pickupAlert ? 'Arriving soon, no pickup vehicle' : '',
    g.flags.noAccommodation ? 'No accommodation' : '',
    g.flags.sharedRoom.length ? `Shares room with ${g.flags.sharedRoom.join(', ')}` : '',
    ...g.flags.vehicleClash,
    g.flags.notSignedUp ? 'Not signed up' : g.flags.notRegistered ? 'Not registered' : '',
  ].filter(Boolean).join('; ')],
];
function guestsCsv(rows) {
  const cell = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [CSV_COLUMNS.map(([h]) => h), ...rows.map((g) => CSV_COLUMNS.map(([, f]) => f(g)))]
    .map((r) => r.map(cell).join(',')).join('\r\n');
}

// The guests table. phone_number is the linked account, NULL until linked
// (SQLite lets UNIQUE hold any number of NULLs).
const GUEST_TABLE_SQL = (name) => `
  CREATE TABLE IF NOT EXISTS ${name} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_number TEXT UNIQUE,
    guest_name TEXT, guest_designation TEXT, guest_phone TEXT, guest_email TEXT,
    arrival_date TEXT, arrival_time TEXT, arrival_mode TEXT, arrival_number TEXT, arrival_point TEXT,
    pickup_vehicle TEXT, pickup_status TEXT,
    departure_date TEXT, departure_time TEXT, departure_mode TEXT, departure_number TEXT, departure_point TEXT,
    drop_vehicle TEXT, drop_status TEXT,
    accommodation TEXT, room_no TEXT, checkin_date TEXT, checkout_date TEXT, room_type TEXT,
    special_needs TEXT, transport_coordinator TEXT, accommodation_coordinator TEXT, overall_status TEXT, remarks TEXT,
    created_at INTEGER NOT NULL, created_by TEXT, updated_at INTEGER, updated_by TEXT,
    linked_at INTEGER, linked_by TEXT,
    transport_not_needed INTEGER NOT NULL DEFAULT 0, stay_not_needed INTEGER NOT NULL DEFAULT 0
  )`;
// Columns added after the table first shipped, for a table already in the
// newer (nullable phone_number) shape.
const LATER_COLUMNS = [
  ['transport_not_needed', 'INTEGER NOT NULL DEFAULT 0'],
  ['stay_not_needed', 'INTEGER NOT NULL DEFAULT 0'],
];

// The first version of the table made phone_number NOT NULL -- every guest
// had to have an account. SQLite cannot drop a NOT NULL, so the table is
// rebuilt: same rows, same ids, one transaction. Run once at boot; a table
// already in the new shape is left alone. run/all are promise-returning
// wrappers over the database.
async function migrateGuestsTable(run, all) {
  const cols = await all('PRAGMA table_info(guests)');
  if (!cols.length) return 'absent';
  const phone = cols.find((c) => c.name === 'phone_number');
  if (phone && !phone.notnull) {
    const missing = LATER_COLUMNS.filter(([name]) => !cols.some((c) => c.name === name));
    for (const [name, type] of missing) await run(`ALTER TABLE guests ADD COLUMN ${name} ${type}`);
    return missing.length ? 'extended' : 'current';
  }
  const keep = cols.map((c) => c.name).join(', ');
  await run('BEGIN');
  try {
    await run('DROP TABLE IF EXISTS guests_rebuild');
    await run(GUEST_TABLE_SQL('guests_rebuild'));
    await run(`INSERT INTO guests_rebuild (${keep}) SELECT ${keep} FROM guests`);
    await run('DROP TABLE guests');
    await run('ALTER TABLE guests_rebuild RENAME TO guests');
    await run('COMMIT');
  } catch (err) {
    await run('ROLLBACK').catch(() => {});
    throw err;
  }
  return 'rebuilt';
}

module.exports = {
  GUEST_TABLE_SQL, migrateGuestsTable, IDENTITY_FIELDS, BOOL_FIELDS, displayValue,
  TRAVEL_FIELDS, STAY_FIELDS, GENERAL_FIELDS, ALL_FIELDS, FIELD_PERMISSION, FIELD_LABELS, FIELD_LISTS,
  TRAVEL_NOTIFY_FIELDS, STAY_NOTIFY_FIELDS,
  LIST_LABELS, DEFAULT_LISTS, PROTECTED_VALUES, CANCELLED, DEFAULT_SETTINGS, SLOT_NAMES,
  validDate, validTime, addDays, joinDateTime, slotOf, slotLabels,
  validateGuestFields, forbiddenChanges, changedFields, validateVehicle, validateRoom, validateSettings,
  buildBoard, guestsCsv,
};
