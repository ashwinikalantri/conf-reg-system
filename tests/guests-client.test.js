// The Guests tab as drawn: app.js run whole, fed a board computed by
// guests.js from real-shaped rows, with just enough of a page to draw into.
//
// What a coordinator sees: the status colours (Cancelled struck through),
// the orange/red row tints and the purple chip, sorting and filtering, the
// editor enabling only the sections the role may edit, the schedules, rooms,
// vehicles and dashboard, and the admin-only pieces staying hidden.
const { check, report, appFile } = require('./harness');
const fs = require('fs');
const vm = require('vm');
const G = require('../guests');

const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
const ejs = fs.readFileSync(appFile('views', 'admin', 'sections', 'guests.ejs'), 'utf8');

function load(perms) {
  const els = new Map();
  const classList = (el) => ({
    _s: new Set(['hidden']),
    add(...c) { c.forEach((x) => this._s.add(x)); }, remove(...c) { c.forEach((x) => this._s.delete(x)); },
    toggle(c, on) { const want = on === undefined ? !this._s.has(c) : !!on; if (want) this._s.add(c); else this._s.delete(c); return want; },
    contains(c) { return this._s.has(c); },
  });
  const el = (id) => {
    if (!els.has(id)) {
      const e = { id, value: '', innerHTML: '', textContent: '', dataset: {}, style: {}, disabled: false, checked: false,
        setAttribute() {}, getAttribute: () => null, addEventListener() {}, focus() {}, querySelectorAll: () => [], querySelector: () => null };
      e.classList = classList(e);
      els.set(id, e);
    }
    return els.get(id);
  };
  const sandbox = {
    document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
      createElement: () => el(`tmp${Math.random()}`), body: el('body'), documentElement: el('html'), readyState: 'loading', cookie: '' },
    window: { addEventListener() {}, location: { href: '', hash: '', pathname: '/admin', search: '', origin: 'https://x' },
      matchMedia: () => ({ matches: false, addEventListener() {} }), history: { replaceState() {} } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node' }, fetch: () => Promise.reject(new Error('no network')),
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval, URL, Intl, Date, Math, JSON, Promise, requestAnimationFrame: () => 0,
  };
  sandbox.window.document = sandbox.document; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${js}
    myPermissions = new Set(${JSON.stringify(perms)});
    globalThis.__set = (d) => { guestData = d; };
    globalThis.__g = { renderGuestList, renderGuestDashboard, renderGuestSchedule, renderGuestVehicles, renderGuestRooms,
      renderGuestSettings, openGuestEditor, fillGuestFilters, sortGuests, switchGuestView };`, sandbox);
  return { sb: sandbox, el };
}

let id = 0;
const lists = Object.fromEntries(Object.entries(G.DEFAULT_LISTS).map(([k, v]) => [k, [...v]]));
const g = (name, f = {}) => ({ id: ++id, name, phone: '+919800000001', designation: 'Professor', registered: 1, linked: true, ...f });
const rows = [
  g('Alpha Arriving', { arrival_date: '2026-11-20', arrival_time: '09:00', accommodation: 'Yatri Nivas', room_no: '1', overall_status: 'Confirmed' }),
  g('Bravo Homeless', { arrival_date: '2026-11-25', overall_status: 'Invited', pickup_vehicle: 'Car A', arrival_time: '08:00' }),
  g('Charlie Cancelled', { overall_status: 'Cancelled' }),
  g('Delta Roommate', { accommodation: 'Yatri Nivas', room_no: '1', overall_status: 'Arrived', registered: 0, departure_date: '2026-11-22', departure_time: '18:30', drop_vehicle: 'Car A' }),
  g('Echo Typed', { linked: false, registered: 0, guest_name: 'Echo Typed', guest_phone: '+910712000', overall_status: 'Invited', accommodation: 'MGIMS Guesthouse',
    possible_account: { phone_number: '9811111111', name: 'Echo Account', taken: false } }),
];
const settings = { alertDays: 2, slotBounds: [6, 12, 18], clashMinutes: 60 };
const board = G.buildBoard({ guests: rows, vehicles: [{ id: 1, label: 'Car A', driver_phone: '0712', seats: 4 }],
  rooms: [{ id: 1, accommodation: 'Yatri Nivas', room_no: '1', room_type: 'Double', beds: 2 }], lists, settings, today: '2026-11-19' });
const data = {
  ...board, lists, settings, today: '2026-11-19', listLabels: G.LIST_LABELS,
  coordinators: { transport: [{ phone: 'T1', name: 'Tara' }], accommodation: [{ phone: 'A1', name: 'Anil' }] },
  listRows: Object.entries(lists).flatMap(([k, vs]) => vs.map((v, i) => ({ id: `${k}${i}`, list_key: k, value: v, sort_order: i, active: 1, inUse: 0, protected: v === 'Cancelled' }))),
};

console.log('\n== The list ==');
const { sb, el } = load(['guests.view', 'guests.edit', 'guests.travel']);
sb.__set(data);
sb.__g.fillGuestFilters();
sb.__g.renderGuestList();
const body = el('guests-tbody').innerHTML;
const rowOf = (name) => (body.split('<tr').find((r) => r.includes(`>${name}<`)) || '');
check('every guest is listed', ['Alpha Arriving', 'Bravo Homeless', 'Charlie Cancelled', 'Delta Roommate', 'Echo Typed'].every((n) => body.includes(`>${n}<`)));
check('Invited yellow, Confirmed green, Arrived blue', /bg-amber-100[^"]*">Invited</.test(body) && /bg-emerald-100[^"]*">Confirmed</.test(body) && /bg-blue-100[^"]*">Arrived</.test(body));
check('Cancelled red with strikethrough', /bg-rose-100 text-rose-800 border-rose-300 line-through">Cancelled</.test(body));
check('orange row: arriving within the window, no vehicle', /class="bg-orange-50 /.test(rowOf('Alpha Arriving')));
check('red row: no accommodation', /class="bg-rose-50 /.test(rowOf('Bravo Homeless')));
check('the cancelled guest is neither, and struck through', !/bg-rose-50|bg-orange-50/.test(rowOf('Charlie Cancelled')) && /line-through">Charlie Cancelled/.test(rowOf('Charlie Cancelled')));
check('purple chip on both roommates', /bg-violet-100[^>]*>Shares room/.test(rowOf('Alpha Arriving')) && /bg-violet-100[^>]*>Shares room/.test(rowOf('Delta Roommate')));
check('not registered is flagged', />Not registered</.test(rowOf('Delta Roommate')) && !/>Not registered</.test(rowOf('Alpha Arriving')));
check('arrival shows date and time together, 12-hour', />20 November 2026, 9:00 AM</.test(rowOf('Alpha Arriving')));
check('a coordinator gets Edit', />Edit</.test(rowOf('Alpha Arriving')));
check('the Faculty column has a fixed width, and a long designation is cut to two lines with the rest on hover',
  /<div class="w-56 break-words">/.test(rowOf('Alpha Arriving')) && /class="text-xs text-slate-500 line-clamp-2" title="Professor">Professor</.test(rowOf('Alpha Arriving')));
check('a guest without an account says so, not "Not registered"', />Not signed up</.test(rowOf('Echo Typed')) && !/>Not registered</.test(rowOf('Echo Typed')));

el('guests-filter-flag').value = 'noAccommodation';
sb.__g.renderGuestList();
check('filtering by a flag', el('guests-tbody').innerHTML.includes('>Bravo Homeless<') && !el('guests-tbody').innerHTML.includes('>Alpha Arriving<'));
el('guests-filter-flag').value = '';
el('guests-filter-status').value = '__live';
sb.__g.renderGuestList();
check('"All but Cancelled" hides Cancelled', !el('guests-tbody').innerHTML.includes('>Charlie Cancelled<'));
el('guests-filter-status').value = '';
el('guests-search').value = 'delta';
sb.__g.renderGuestList();
check('search', el('guests-tbody').innerHTML.includes('>Delta Roommate<') && !el('guests-tbody').innerHTML.includes('>Bravo Homeless<'));
el('guests-search').value = '';
sb.__g.sortGuests('name');
sb.__g.sortGuests('name');
const order = [...el('guests-tbody').innerHTML.matchAll(/font-semibold[^>]*>([A-Z][a-z]+ [A-Za-z]+)</g)].map((m) => m[1]);
check('sorting by stay puts room 2 before room 10', /accommodation: \(g\) => [^\n]*\.replace\(\/\\d\+\/g, \(d\) => d\.padStart\(10, '0'\)\)/.test(js));
check('sorting by name, then reversed', order[0] === 'Echo Typed' && order[order.length - 1] === 'Alpha Arriving', order);
check('the header shows the sort', /Faculty ▼/.test(el('guests-thead').innerHTML));

console.log('\n== The editor follows the role ==');
sb.__g.openGuestEditor(rows[0].id);
const form = el('guest-edit-body').innerHTML;
// The attribute, not the disabled: style variants in the class list.
const disabled = (name) => new RegExp(`name="${name}"[^>]*\\sdisabled(?=[\\s>])`).test(form);
check('a transport coordinator edits arrival and departure', !disabled('arrival_date') && !disabled('drop_vehicle'));
check('...not the stay', disabled('accommodation') && disabled('room_no') && disabled('accommodation_coordinator'));
check('...and the shared fields', !disabled('overall_status') && !disabled('remarks'));
check('time is a 12-hour box over a hidden 24-hour value', /<input type="hidden" name="arrival_time" value="09:00"/.test(form)
  && /data-time12="arrival_time" value="9:00 AM"[^>]*oninput="onTime12Input\(this\)" onblur="onTime12Blur\(this\)"/.test(form));
check('the vehicle field suggests vehicles but takes free text', /name="pickup_vehicle" type="text"[^>]*list="guest-vehicle-options"/.test(form) && /<option value="Car A">/.test(form));
check('no Remove for a coordinator', el('guest-remove-btn').classList.contains('hidden'));
check('there is no "local transport not needed" tick-box', !/transport_not_needed/.test(form));
check('"accommodation not needed" is not the transport coordinator\'s', /type="checkbox" name="stay_not_needed"[^>]*\sdisabled/.test(form));
check('the flight number field is named after the mode', /data-number-for="arrival"><span data-number-label[^>]*>Flight\/Train No</.test(form)
  && /name="arrival_mode"[^>]*onchange="syncGuestModeFields\('arrival'\)"/.test(form));
check('a tick-box is saved as ticked or not, not as its label', /fields\[el\.name\] = el\.type === 'checkbox' \? el\.checked : el\.value/.test(js));
const stay = load(['guests.view', 'guests.edit', 'guests.stay']);
stay.sb.__set(data);
stay.sb.__g.openGuestEditor(rows[0].id);
const sform = stay.el('guest-edit-body').innerHTML;
const sDisabled = (name) => new RegExp(`name="${name}"[^>]*\\sdisabled(?=[\\s>])`).test(sform);
check('an accommodation coordinator: the reverse', !sDisabled('accommodation') && !sDisabled('room_no') && sDisabled('arrival_date') && sDisabled('pickup_vehicle'));
const adminView = load(['guests.view', 'guests.edit', 'guests.travel', 'guests.stay', 'guests.manage']);
adminView.sb.__set(data);
adminView.sb.__g.openGuestEditor(rows[0].id);
check('an admin can remove', !adminView.el('guest-remove-btn').classList.contains('hidden'));
sb.__g.openGuestEditor(rows[4].id);
const uform = el('guest-edit-body').innerHTML;
check('a guest without an account: who they are is editable', /name="guest_name" type="text" value="Echo Typed"(?![^>]*\sdisabled(?=[\s>]))/.test(uform) && /name="guest_phone" type="text" value="\+910712000"/.test(uform));
check('...with the matching account offered to link', /Link to Echo Account</.test(uform) && /linkGuest\(\d+, '9811111111'\)/.test(uform));
check('...and a search to find another', /id="guest-link-search"/.test(uform));
check('...and the header says they are not signed up', /Not signed up yet/.test(el('guest-edit-who').textContent));
sb.__g.openGuestEditor(rows[0].id);
check('a linked guest has none of that', !/name="guest_name"/.test(el('guest-edit-body').innerHTML) && !/guest-link-search/.test(el('guest-edit-body').innerHTML));
check('...but can be unlinked, if the account is someone else\'s', /onclick="unlinkGuest\(\d+\)"[^>]*>Unlink from this account</.test(el('guest-edit-body').innerHTML));
check('a guest not linked has no Unlink', !/unlinkGuest/.test(uform));
const roView = load(['guests.view']);
roView.sb.__set(data);
roView.sb.__g.openGuestEditor(rows[0].id);
check('...nor does someone who may not link', !/unlinkGuest/.test(roView.el('guest-edit-body').innerHTML));

console.log('\n== The other views ==');
sb.__g.renderGuestSchedule('pickups');
const pick = el('guests-view-pickups').innerHTML;
check('pickups in arrival order, Cancelled out', pick.indexOf('Alpha Arriving') < pick.indexOf('Bravo Homeless') && !pick.includes('Charlie Cancelled'));
check('...with the driver\'s phone from the vehicle list', pick.includes('>0712<'));
sb.__g.renderGuestSchedule('drops');
check('drops list departures, 12-hour', el('guests-view-drops').innerHTML.includes('22 November 2026, 6:30 PM'));
sb.__g.renderGuestRooms();
const roomsHtml = el('guests-view-rooms').innerHTML;
check('rooms: occupied, Full, and who', /Full</.test(roomsHtml) && roomsHtml.includes('Alpha Arriving, Delta Roommate'));
check('a transport coordinator gets no room form', !roomsHtml.includes('guest-room-form'));
sb.__g.renderGuestVehicles();
check('vehicles: the form for a transport coordinator, no Delete', el('guests-view-vehicles').innerHTML.includes('guest-vehicle-form') && !/>Delete</.test(el('guests-view-vehicles').innerHTML));
sb.__g.renderGuestDashboard();
const dash = el('guests-view-dashboard').innerHTML;
check('dashboard: guests listed, cancelled left out', />4</.test(dash) && /1 cancelled not counted/.test(dash));
check('...and how many are not signed up', /1 not signed up/.test(dash));
check('...arrivals in the window, with how many lack a vehicle', /1 with no pickup vehicle/.test(dash));
check('...counts include "Not set"', /Not set/.test(dash));
check('...time slots by name, 12-hour', /Morning 6 AM–12 PM/.test(dash) && /Evening 6 PM–12 AM/.test(dash));
check('...beds per accommodation', /Yatri Nivas/.test(dash));
adminView.sb.__g.renderGuestSettings();
const settingsHtml = adminView.el('guests-view-settings').innerHTML;
check('lists: "Cancelled" cannot be switched off or removed', /Cancelled <span class="text-\[10px\] text-slate-400">\(required\)<\/span>/.test(settingsHtml));
check('the settings show the slot boundaries', /value="6"/.test(settingsHtml) && /value="18"/.test(settingsHtml));

console.log('\n== Reading a typed time ==');
const tsb = { String, Number };
vm.createContext(tsb);
const grabT = (n) => { const i = js.indexOf(`function ${n}(`); return js.slice(i, js.indexOf('\n}', i) + 2); };
vm.runInContext([grabT('parseTime12'), grabT('guestTime12')].join('\n') + '\nglobalThis.p = parseTime12; globalThis.t12 = guestTime12;', tsb);
const as24 = (t) => tsb.p(t).hhmm;
check('9:30 pm, 930p, 9.30 P.M. and 21:30 are all 9:30 PM', ['9:30 pm', '930p', '9.30 P.M.', '21:30', '2130'].every((t) => as24(t) === '21:30'));
check('9am, 12am, 12:15 pm', as24('9am') === '09:00' && as24('12am') === '00:00' && as24('12:15 pm') === '12:15');
check('a leading zero means 24-hour already', as24('0930') === '09:30' && as24('09:30') === '09:30');
check('9:30 with no AM or PM is asked about, not guessed', tsb.p('9:30').ambiguous === true && tsb.p('12').ambiguous === true);
check('nonsense is refused', ['25:00', '9:75 am', '13pm', 'soon'].every((t) => tsb.p(t).invalid === true));
check('shown as 9:30 PM', tsb.t12('21:30') === '9:30 PM' && tsb.t12('00:05') === '12:05 AM');
check('a time that could not be read stops the save', /const bad = \[\.\.\.form\.querySelectorAll\('\[data-time12\]'\)\]\.find/.test(js));

console.log('\n== Nights ==');
const nsb = { String, Math, Date };
vm.createContext(nsb);
vm.runInContext([grabT('guestNights')].join('\n') + `\nconst nightsLabel = ${js.match(/const nightsLabel = ([^;]+);/)[1]};\nglobalThis.n = guestNights; globalThis.l = nightsLabel;`, nsb);
check('nights in the form, as the dates change', nsb.n('2026-11-20', '2026-11-23') === 3 && nsb.l(3) === '3 nights' && nsb.l(1) === '1 night' && nsb.l(0) === 'Same day, no night');
check('...worked out again whenever either date changes', /name="checkin_date"[^>]*onchange="syncGuestNights\(\)"/.test(el('guest-edit-body').innerHTML)
  && /name="checkout_date"[^>]*onchange="syncGuestNights\(\)"/.test(el('guest-edit-body').innerHTML));
check('the rooms form takes a range', /name="roomNo" required maxlength="400" placeholder="101, or 1-10, or 101-105, 110"/.test(js));

console.log('\n== Accommodation not needed ==');
const stayRow = data.guests.find((x) => x.name === 'Alpha Arriving');
stayRow.stay_not_needed = 1;
stay.sb.__set(data);
stay.sb.__g.openGuestEditor(stayRow.id);
const sh = stay.el('guest-edit-body').innerHTML;
check('ticked: the stay details are hidden', /id="guest-stay-fields" class="hidden /.test(sh));
check('...kept, with a note saying unticking brings them back', /id="guest-stay-note" class=" col-span-full/.test(sh) && /return if you untick this/.test(sh));
check('ticking or unticking shows or hides them at once', /name="stay_not_needed"[^>]*onchange="syncGuestStayFields\(\)"/.test(sh));
stayRow.stay_not_needed = 0;
stay.sb.__g.openGuestEditor(stayRow.id);
check('unticked: the stay details are asked for', /id="guest-stay-fields" class="col-span-full/.test(stay.el('guest-edit-body').innerHTML));

console.log('\n== Institute and district filters ==');
const placeOf = { 'Alpha Arriving': ['MGIMS, Sevagram', 'Wardha', 'Maharashtra'], 'Bravo Homeless': ['mgims,  sevagram', 'Wardha', 'Maharashtra'],
  'Charlie Cancelled': ['AIIMS, Nagpur', 'Aurangabad', 'Bihar'], 'Delta Roommate': ['GMC Aurangabad', 'Aurangabad', 'Maharashtra'] };
data.guests.forEach((x) => { const p = placeOf[x.name] || [null, null, null]; [x.institution, x.district, x.state] = p; });
sb.__set(data);
sb.__g.fillGuestFilters();
const instOpts = el('guests-filter-institution').innerHTML;
const distOpts = el('guests-filter-district').innerHTML;
check('the institute filter lists each institute once, with how many, case and spacing aside', /<option value="">Any institute<\/option>/.test(instOpts)
  && /<option value="mgims, sevagram">MGIMS, Sevagram \(2\)<\/option>/.test(instOpts) && (instOpts.match(/sevagram/gi) || []).length === 2, instOpts);
check('...and those with none recorded (not signed up)', /<option value="__none">Institute not recorded \(1\)<\/option>/.test(instOpts));
check('the district filter keeps districts of the same name in different states apart', /value="aurangabad\|bihar">Aurangabad, Bihar \(1\)/.test(distOpts)
  && /value="aurangabad\|maharashtra">Aurangabad, Maharashtra \(1\)/.test(distOpts) && /Wardha, Maharashtra \(2\)/.test(distOpts), distOpts);
const listed = () => ['Alpha Arriving', 'Bravo Homeless', 'Charlie Cancelled', 'Delta Roommate', 'Echo Typed'].filter((n) => el('guests-tbody').innerHTML.includes(`>${n}<`));
el('guests-filter-institution').value = 'mgims, sevagram';
sb.__g.renderGuestList();
check('filtering by institute', listed().join() === 'Alpha Arriving,Bravo Homeless', listed());
el('guests-filter-institution').value = '';
el('guests-filter-district').value = 'aurangabad|maharashtra';
sb.__g.renderGuestList();
check('filtering by district', listed().join() === 'Delta Roommate', listed());
el('guests-filter-district').value = '__none';
sb.__g.renderGuestList();
check('...or by none recorded', listed().join() === 'Echo Typed', listed());
el('guests-filter-district').value = '';
sb.__g.renderGuestList();
check('the server sends district and state with each faculty member', /u\.institution, u\.district, u\.state/.test(fs.readFileSync(appFile('server.js'), 'utf8')));

console.log('\n== Pickup or drop not required ==');
const legRow = data.guests.find((x) => x.name === 'Alpha Arriving');
Object.assign(legRow, { pickup_status: 'Not required', arrival_mode: 'Flight', arrival_point: 'Nagpur Airport', pickup_vehicle: 'Car A' });
sb.__set(data);
sb.__g.openGuestEditor(legRow.id);
const lh = el('guest-edit-body').innerHTML;
check('pickup not required: date, time and status asked for', /name="arrival_date"/.test(lh) && /name="arrival_time"/.test(lh) && /name="pickup_status"/.test(lh));
check('...mode, number, point and vehicle hidden', /id="guest-arrival-details" class="hidden col-span-full/.test(lh)
  && ['arrival_mode', 'arrival_number', 'arrival_point', 'pickup_vehicle'].every((f) => lh.indexOf(`name="${f}"`) > lh.indexOf('id="guest-arrival-details"')));
check('...with a note, which says what was entered earlier is kept', /id="guest-arrival-note" class="col-span-full[^"]*">Pickup not required: only the date and time are needed\. Details entered earlier are kept/.test(lh));
check('...changing the status shows or hides them at once', /name="pickup_status"[^>]*onchange="syncGuestTransferFields\('arrival'\)"/.test(lh)
  && /name="drop_status"[^>]*onchange="syncGuestTransferFields\('departure'\)"/.test(lh));
check('the drop is asked for in full while it is required', /id="guest-departure-details" class="col-span-full/.test(lh) && /id="guest-departure-note" class="hidden /.test(lh));
sb.__g.renderGuestList();
const lrow = (el('guests-tbody').innerHTML.split('<tr').find((r) => r.includes('>Alpha Arriving<')) || '');
check('the list shows the arrival time and "Not required", not the set-aside details', />20 November 2026, 9:00 AM</.test(lrow) && />Not required</.test(lrow)
  && !/Nagpur Airport|>Car A</.test(lrow));
sb.__set({ ...data, pickups: [{ id: legRow.id, name: 'Alpha Arriving', at: '2026-11-20 09:00', status: 'Not required', clash: [], alert: false }] });
sb.__g.renderGuestSchedule('pickups');
check('the pickup schedule shows a dash, not "No vehicle"', !/No vehicle|>None</.test(el('guests-view-pickups').innerHTML));
Object.assign(legRow, { pickup_status: null, arrival_mode: null, arrival_point: null, pickup_vehicle: null });
sb.__set(data);

console.log('\n== Checking a flight by hand ==');
const fsb = { String, encodeURIComponent };
vm.createContext(fsb);
const grabFn = (n) => { const i = js.indexOf(`function ${n}(`); return js.slice(i, js.indexOf('\n}', i) + 2); };
vm.runInContext([grabFn('esc'), grabFn('formatFullDate'), grabFn('flightNumberOf'), grabFn('flightCheckUrl'), grabFn('flightNumberLink')].join('\n')
  + '\nglobalThis.url = flightCheckUrl; globalThis.link = flightNumberLink;', fsb);
check('Google: the flight number and the day', fsb.url('google', '6e 5172', '2026-11-20') === 'https://www.google.com/search?q=6E5172%20flight%2020%20November%202026');
check('Flightradar24: the flight\'s page', fsb.url('fr24', 'AI-629', '2026-11-20') === 'https://www.flightradar24.com/data/flights/ai629');
check('a train number gets no link', fsb.url('google', '12951', '2026-11-20') === null && !/<a /.test(fsb.link('12951', '2026-11-20')));
check('in a schedule the flight number is a link that opens in a new tab', /<a href="https:\/\/www\.google\.com\/search\?q=6E5172[^"]*" target="_blank" rel="noopener"[^>]*>6E 5172<\/a>/.test(fsb.link('6E 5172', '2026-11-20')));
sb.__g.openGuestEditor(rows[0].id);
check('the editor offers Check flight for arrival and departure, without a key', /openFlightCheck\('arrival', 'google'\)/.test(el('guest-edit-body').innerHTML)
  && /openFlightCheck\('departure', 'fr24'\)/.test(el('guest-edit-body').innerHTML) && !/fetchGuestFlight/.test(el('guest-edit-body').innerHTML));
check('...even to someone who may only look', /openFlightCheck\('arrival', 'google'\)/.test((() => { stay.sb.__g.openGuestEditor(rows[0].id); return stay.el('guest-edit-body').innerHTML; })()));

console.log('\n== Volunteers and the Front Desk ==');
check('the dropdowns are Transport Volunteer and Accommodation Volunteer', />Transport Volunteer</.test(adminView.el('guest-edit-body').innerHTML)
  && />Accommodation Volunteer</.test(adminView.el('guest-edit-body').innerHTML));
const mineBefore = el('guests-filter-flag').value;
el('guests-filter-flag').value = 'mine';
vm.runInContext("activeAdminUser = { phone_number: 'A1' };", sb);
data.guests.forEach((x) => { x.accommodation_coordinator = x.name === 'Bravo Homeless' ? 'A1' : null; });
sb.__g.renderGuestList();
check('"Assigned to me" shows a volunteer their own faculty', el('guests-tbody').innerHTML.includes('>Bravo Homeless<') && !el('guests-tbody').innerHTML.includes('>Alpha Arriving<'));
el('guests-filter-flag').value = mineBefore;
const dsb = { String, Number, Date, Math };
vm.createContext(dsb);
vm.runInContext(['let canKeys = [];', 'function can(k) { return canKeys.includes(k); }', `const deskBtn = ${js.match(/const deskBtn = (\(label, onclick, tone\) => \{[\s\S]*?\n\};)/)[1]}`, grabT('esc'), grabT('formatFullDate'), js.match(/const SHORT_MONTHS = [^\n]+/)[0], grabT('shortDateRange'), grabT('guestTime12'), grabT('guestWhen'), grabT('guestNights'), grabT('transferNotRequired'), grabT('guestLegHtml'), grabT('guestStayHtml'), grabT('deskCard'), grabT('deskFacultyCard')].join('\n')
  + `\nconst nightsLabel = ${js.match(/const nightsLabel = ([^;]+);/)[1]};\nglobalThis.card = deskFacultyCard;`, dsb);
const dcard = dsb.card({ arrival_date: '2026-11-20', arrival_time: '21:30', arrival_mode: 'Flight', arrival_number: '6E 123', pickup_vehicle: 'Car A',
  accommodation: 'Yatri Nivas', room_no: '7', checkin_date: '2026-11-20', checkout_date: '2026-11-22', transport_volunteer: 'Tara' });
check('the Front Desk shows a faculty member\'s travel and stay', /Faculty — travel &amp; stay|Faculty — travel & stay/.test(dcard)
  && /20 November 2026, 9:30 PM<\/p><p class="text-xs text-slate-500">Flight · 6E 123/.test(dcard) && /Yatri Nivas · 7/.test(dcard) && /2 nights/.test(dcard) && /Tara/.test(dcard));
check('...and nothing when there is nothing to show', dsb.card({ id: 1 }) === '' && dsb.card(null) === '');
const dcardOwn = dsb.card({ arrival_date: '2026-11-20', arrival_time: '21:30', arrival_mode: 'Flight', arrival_number: '6E 123', pickup_vehicle: 'Car A', pickup_status: 'Not required' });
check('...and for a pickup not required, the time and "Not required" only', /9:30 PM<\/p><p class="text-xs mt-0\.5 text-slate-500">Not required/.test(dcardOwn) && !/6E 123|Car A/.test(dcardOwn));
check('...placed after the delegate card', /deskWhoCard\(user, reg, checkedIn, guest\),\n\s*deskFacultyCard\(guest\),/.test(js));
vm.runInContext("canKeys = ['guests.view', 'guests.travel'];", dsb);
check('a coordinator gets Travel & stay on the desk, even before details exist', /deskOpenFaculty\(5\)[^>]*>Travel &amp; stay</.test(dsb.card({ id: 5 })) || /deskOpenFaculty\(5\)[^>]*>Travel & stay</.test(dsb.card({ id: 5 })));
check('...and the empty card says so', /No travel or stay details yet/.test(dsb.card({ id: 5 })));
vm.runInContext("canKeys = ['guests.view'];", dsb);
check('someone who may only look gets View record', /deskOpenFaculty\(5\)[^>]*>View record</.test(dsb.card({ id: 5 })));

console.log('\n== On a phone ==');
el('guests-filter-flag').value = ''; el('guests-filter-status').value = ''; el('guests-search').value = '';
sb.__g.renderGuestList();
const cardsHtml = el('guests-cards').innerHTML;
check('the list is also drawn as cards, one per person', ['Alpha Arriving', 'Bravo Homeless', 'Charlie Cancelled', 'Delta Roommate', 'Echo Typed'].every((n) => cardsHtml.includes(`>${n}<`))
  && (cardsHtml.match(/<article /g) || []).length === 5);
check('...red and orange as a coloured edge', /border-l-rose-400[^>]*>[\s\S]*?Bravo Homeless/.test(cardsHtml) && /border-l-orange-400[^>]*>[\s\S]*?Alpha Arriving/.test(cardsHtml));
check('...with a phone to tap and call', /<a href="tel:\+919800000001"/.test(cardsHtml));
check('...and a full-width Edit button', /class="mt-3 w-full h-10[^"]*"[^>]*>Edit</.test(cardsHtml) || /onclick="openGuestEditor\(\d+\)" class="mt-3 w-full h-10/.test(cardsHtml));
const ejsAll = ejs;
check('cards on a phone, the table from tablet up', /id="guests-cards" class="md:hidden/.test(ejsAll) && /class="hidden md:block bg-white rounded-2xl[^"]*overflow-x-auto">\s*<table class="w-full text-sm min-w-\[72rem\]">/.test(ejsAll));
check('a Sort select stands in for the column headers', /id="guests-sort-mobile" onchange="setGuestSort\(this\.value\)"/.test(ejsAll));
check('the tabs are one row that swipes', /id="guests-subnav" role="tablist" class="flex gap-1\.5 overflow-x-auto sm:flex-wrap/.test(ejsAll) && /guest-subtab shrink-0 whitespace-nowrap/.test(ejsAll));
check('the colour key folds away on a phone', /<details class="md:hidden mb-3">\s*<summary[^>]*>Colour key<\/summary>\s*<div id="guests-legend-mobile"/.test(ejsAll)
  && el('guests-legend-mobile').innerHTML.includes('Red: no accommodation'));
sb.__g.renderGuestSchedule('pickups');
check('pickups as cards too, phones to tap', /<article [^>]*>[\s\S]*?Alpha Arriving/.test(el('guests-view-pickups').innerHTML) && /href="tel:\+919800000001"/.test(el('guests-view-pickups').innerHTML));
sb.__g.renderGuestRooms();
check('rooms as cards: beds used of beds', /Yatri Nivas · 1<\/p>/.test(el('guests-view-rooms').innerHTML) && /2 of 2 beds/.test(el('guests-view-rooms').innerHTML));
sb.__g.renderGuestVehicles();
check('vehicles as cards', /<article [^>]*>\s*<p class="font-semibold text-slate-800">Car A<\/p>/.test(el('guests-view-vehicles').innerHTML));
const modal = fs.readFileSync(appFile('views', 'admin', 'modals', 'guest-edit.ejs'), 'utf8');
check('the editor is full-screen on a phone, Save always in view', /id="modal-guest-edit" class="hidden fixed inset-0[^"]*items-stretch sm:items-center p-0 sm:p-4/.test(modal)
  && /h-full sm:h-auto/.test(modal) && /overflow-y-auto flex-1 min-h-0/.test(modal));
sb.__g.openGuestEditor(rows[0].id);
check('...its fields in one column on a phone', /grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3/.test(el('guest-edit-body').innerHTML) && !/col-span-2 sm:col-span-4/.test(el('guest-edit-body').innerHTML));

console.log('\n== Whatever is entered is shown ==');
const psb = { String, Number, Date, Math };
vm.createContext(psb);
vm.runInContext([grabT('esc'), grabT('formatFullDate'), js.match(/const SHORT_MONTHS = [^\n]+/)[0], grabT('shortDateRange'), grabT('guestTime12'), grabT('guestWhen'), grabT('guestNights'), grabT('transferNotRequired'), grabT('guestLegHtml'), grabT('guestStayHtml')].join('\n')
  + `\nconst nightsLabel = ${js.match(/const nightsLabel = ([^;]+);/)[1]};\nglobalThis.leg = guestLegHtml; globalThis.stayOf = guestStayHtml; globalThis.range = shortDateRange;`, psb);
const datesOnly = psb.stayOf({ checkin_date: '2026-11-20', checkout_date: '2026-11-22' });
check('stay dates with no guesthouse yet are shown, with the nights', /20 - 22 Nov 2026 · 2 nights/.test(datesOnly) && !/Not set/.test(datesOnly), datesOnly);
check('a stay range is written short: "20 - 23 Nov 2026"', psb.range('2026-11-20', '2026-11-23') === '20 - 23 Nov 2026');
check('...across months, each month named once', psb.range('2026-11-30', '2026-12-02') === '30 Nov - 2 Dec 2026');
check('...across years, each year too', psb.range('2026-12-30', '2027-01-02') === '30 Dec 2026 - 2 Jan 2027');
check('...and one day as one date', psb.range('2026-11-20', '2026-11-20') === '20 Nov 2026');
check('one date alone is shown too', /From 20 November 2026/.test(psb.stayOf({ checkin_date: '2026-11-20' })) && /Until 22 November 2026/.test(psb.stayOf({ checkout_date: '2026-11-22' })));
check('a room type alone, a room number alone', /Double/.test(psb.stayOf({ room_type: 'Double' })) && /Room 7/.test(psb.stayOf({ room_no: '7' })));
check('nothing entered gives nothing (the list says Not set)', psb.stayOf({}) === '' && psb.leg() === '');
check('arranging their own stay says so, not the details kept from before', /Arranging their own stay/.test(psb.stayOf({ stay_not_needed: 1, accommodation: 'Yatri Nivas' }))
  && !/Yatri/.test(psb.stayOf({ stay_not_needed: 1, accommodation: 'Yatri Nivas' })));
const partLeg = psb.leg(null, null, 'Flight', '6E 123', null, null, 'Pending');
check('a flight number or status with no date yet is shown', /Flight · 6E 123/.test(partLeg) && /Pending/.test(partLeg) && !/No vehicle/.test(partLeg));
check('"No vehicle" only once there is a date to meet', /No vehicle/.test(psb.leg('2026-11-20')));
sb.__g.renderGuestList();
check('the list uses the same, table and cards', /guestStayHtml\(g\) \|\| notSet/.test(js) && /\$\{guestStayHtml\(g\) \|\| '<p class="text-xs text-slate-400 pt-0\.5">Not set<\/p>'\}/.test(js));

console.log('\n== Wiring ==');
check('Lists & Settings is hidden until shown to an admin', /id="guests-settings-tab" class="guest-subtab hidden/.test(ejs));
check('the tab is a main tab, #faculty in the address, opened by guests.view', /const MAIN_TABS = \[[^\]]*'faculty'/.test(js)
  && /tabFaculty\.classList\.toggle\('hidden', !canSee\('faculty'\)\)/.test(js) && !/MAIN_TABS = \[[^\]]*'guests'/.test(js));
check('coordinators land on it', /: canSee\('faculty'\) \? 'faculty'/.test(js));
check('an old #guests link still opens it', /return tab === 'guests' \? 'faculty' : tab;/.test(js) && /const hashTab = tabFromHash\(\);/.test(js));
check('the tab and section are named faculty', /id="nav-tab-faculty" onclick="switchBackendTab\('faculty'\)"/.test(fs.readFileSync(appFile('views', 'admin', 'partials', 'nav-tabs.ejs'), 'utf8'))
  && /<section id="section-faculty"/.test(ejs));
check('no import option', !/import/i.test(ejs));

report();
