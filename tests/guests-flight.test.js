// Flight look-up on the Faculty tab.
//
// A transport coordinator types a flight number and date; the flight data
// service (AeroDataBox) answers with the scheduled times; the coordinator
// checks and uses them. What must hold:
//
//   * flight numbers are read as airlines print them, and a train number is
//     not mistaken for one;
//   * the reply is read for the leg that matters -- arriving at, or leaving,
//     Nagpur -- in either field naming the service has used, and a reply that
//     cannot be read gives nothing rather than something wrong;
//   * without a key it says so; only those who may edit travel can ask;
//   * an answer is kept and reused, so the free allowance is not spent twice.
//
// The test server never reaches the real service: a dummy key is set and the
// answer is placed in the cache the route reads first.
const { call, check, report, ADMIN_PW, appFile, adminLogin, loginPassword, openDb } = require('./harness');
const fs = require('fs');
const G = require('../guests');

// The shape AeroDataBox returns for a flight number on a date (a list of
// legs), in its current field naming.
const twoLegs = [
  { number: '6E 5172', status: 'Expected', airline: { name: 'IndiGo', iata: '6E' },
    departure: { airport: { iata: 'BOM', name: 'Mumbai', municipalityName: 'Mumbai' }, scheduledTime: { utc: '2026-11-20 01:30Z', local: '2026-11-20 07:00+05:30' } },
    arrival: { airport: { iata: 'NAG', name: 'Nagpur', municipalityName: 'Nagpur' }, scheduledTime: { utc: '2026-11-20 02:55Z', local: '2026-11-20 08:25+05:30' } } },
  { number: '6E 5172', status: 'Expected', airline: { name: 'IndiGo', iata: '6E' },
    departure: { airport: { iata: 'NAG', name: 'Nagpur' }, scheduledTime: { local: '2026-11-20 09:05+05:30' } },
    arrival: { airport: { iata: 'CCU', name: 'Kolkata' }, scheduledTime: { local: '2026-11-20 11:10+05:30' } } },
];
// The older naming, and an overnight arrival.
const older = { number: 'AI 629', airline: { name: 'Air India' },
  departure: { airport: { iata: 'DEL', shortName: 'Delhi' }, scheduledTimeLocal: '2026-11-19 22:40+05:30' },
  arrival: { airport: { iata: 'NAG', shortName: 'Nagpur' }, scheduledTimeLocal: '2026-11-20 00:30+05:30' } };

(async () => {
  console.log('\n== Flight numbers ==');
  check('as airlines print them, any spacing or case', ['6E 123', '6e123', 'G8-101', 'AI 629', 'IGO6125'].every((n) => !!G.normaliseFlightNumber(n)));
  check('...stored without spaces, upper case', G.normaliseFlightNumber('6e 123') === '6E123');
  check('a five-digit train number is not a flight', G.normaliseFlightNumber('12951') === null);
  check('nor is free text', G.normaliseFlightNumber('by road') === null && G.normaliseFlightNumber('') === null);

  console.log('\n== Reading the reply ==');
  const meet = G.readFlightLookup(twoLegs, 'arrival', 'Nagpur Airport');
  check('every leg is listed', meet.flights.length === 2 && meet.flights[0].from.iata === 'BOM');
  check('meeting them: the leg landing at Nagpur, its arrival time', meet.suggestion && meet.suggestion.time === '08:25' && meet.suggestion.date === '2026-11-20', meet.suggestion);
  check('...with Nagpur Airport as the point, and Flight as the mode', meet.suggestion.point === 'Nagpur Airport' && meet.suggestion.mode === 'Flight');
  const seeOff = G.readFlightLookup(twoLegs, 'departure', 'Nagpur Airport');
  check('seeing them off: the leg leaving Nagpur, its departure time', seeOff.suggestion && seeOff.suggestion.time === '09:05', seeOff.suggestion);
  const old = G.readFlightLookup(older, 'arrival', 'Nagpur Airport');
  check('the older field names are read too', old.suggestion && old.suggestion.time === '00:30' && old.flights[0].from.name === 'Delhi', old.suggestion);
  check('...an overnight flight lands on the next day', old.suggestion.date === '2026-11-20' && old.flights[0].departs.date === '2026-11-19');
  check('no point is suggested where the point list has no Nagpur airport', G.readFlightLookup(older, 'arrival', null).suggestion.point === null);
  const elsewhere = G.readFlightLookup([twoLegs[1], { ...twoLegs[1], arrival: { airport: { iata: 'BLR' }, scheduledTime: { local: '2026-11-20 12:00+05:30' } } }], 'arrival', 'Nagpur Airport');
  check('several legs, none landing at Nagpur: no guess', elsewhere.flights.length === 2 && elsewhere.suggestion === null);
  check('a reply it cannot read gives nothing, not something wrong', G.readFlightLookup({ unexpected: true }, 'arrival').flights.length === 0
    && G.readFlightLookup(null, 'arrival').suggestion === null && G.readFlightLookup([{ number: 'X1' }], 'arrival').flights.length === 0);

  console.log('\n== The route ==');
  const admin = await adminLogin();
  const db = openDb();
  const reviewer = await loginPassword('9000000003', ADMIN_PW);
  const desk = await loginPassword('9000000006', ADMIN_PW);
  const ask = (q, c = admin) => call('GET', `/api/guests/flight?${q}`, null, c);
  const none = await ask('number=6E5172&date=2026-11-20&leg=arrival');
  const configured = (await call('GET', '/api/guests', null, admin)).body.flightLookup;
  if (!configured) {
    check('without a key it says how to set one up', none.status === 503 && none.body.code === 'NOT_CONFIGURED' && /Settings/.test(none.body.error), none.body);
  }
  check('only those who may edit travel can ask', (await ask('number=6E5172&date=2026-11-20', reviewer)).status === 403
    && (await ask('number=6E5172&date=2026-11-20', desk)).status === 403);
  check('nor anyone signed out', (await call('GET', '/api/guests/flight?number=6E5172&date=2026-11-20')).status === 401);

  // A dummy key, so the route proceeds; the answer is pre-placed in its cache,
  // so no request leaves the test.
  const key = await call('PUT', '/api/admin/general-settings', { flights: { apiKey: 'test-key-not-real' } }, admin);
  check('a Super Admin sets the key in Settings', key.body.success === true, key.body);
  const settings = (await call('GET', '/api/admin/general-settings', null, admin)).body;
  check('...which then reports a key is set, and never the key', settings.flights.hasApiKey === true && !JSON.stringify(settings).includes('test-key-not-real'));
  check('the Faculty tab is told look-up is on', (await call('GET', '/api/guests', null, admin)).body.flightLookup === true);
  const now = Date.now();
  await db.run('INSERT OR REPLACE INTO flight_lookups (lookup_key, fetched_at, http_status, body) VALUES (?, ?, 200, ?)', ['6E5172|2026-11-20|arrival', now, JSON.stringify(twoLegs)]);
  await db.run('INSERT OR REPLACE INTO flight_lookups (lookup_key, fetched_at, http_status, body) VALUES (?, ?, 204, NULL)', ['AI999|2026-11-20|arrival', now]);
  await db.run('INSERT OR REPLACE INTO flight_lookups (lookup_key, fetched_at, http_status, body) VALUES (?, ?, 200, ?)', ['UK888|2026-11-20|arrival', now, '<html>not json</html>']);

  check('a flight number that is not one is refused', (await ask('number=12951&date=2026-11-20')).status === 400);
  check('a missing date is refused', (await ask('number=6E5172&date=')).status === 400);
  const found = await ask('number=6e%205172&date=2026-11-20&leg=arrival');
  check('a known flight comes back, read for Nagpur', found.body.success === true && found.body.suggestion && found.body.suggestion.time === '08:25'
    && found.body.suggestion.point === 'Nagpur Airport', found.body);
  check('...from the stored answer, not a new request', found.body.flights.length === 2);
  const missing = await ask('number=AI999&date=2026-11-20&leg=arrival');
  check('a flight the service does not know is said plainly', missing.body.success === true && missing.body.flights.length === 0 && /No flight AI999/.test(missing.body.message));
  const garbled = await ask('number=UK888&date=2026-11-20&leg=arrival');
  check('a reply that cannot be read says so, and suggests nothing', garbled.body.flights.length === 0 && garbled.body.suggestion === null && /could not be read/.test(garbled.body.message));
  await db.run("DELETE FROM flight_lookups WHERE lookup_key IN ('6E5172|2026-11-20|arrival', 'AI999|2026-11-20|arrival', 'UK888|2026-11-20|arrival')");

  console.log('\n== The editor ==');
  const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
  check('Fetch appears only with a key, and only for those who edit travel', /const canFetch = travel && guestData\.flightLookup;/.test(js));
  check('using a result fills the form, it does not save', /function useGuestFlight\(leg\) \{[\s\S]*?Filled in\. Save to keep it\./.test(js) && !/function useGuestFlight[\s\S]*?fetch\(`\/api\/guests\/\$\{/.test(js.slice(js.indexOf('function useGuestFlight'), js.indexOf('async function saveGuest'))));
  check('the key field is a password field in Settings', /id="gs-flights-apikey" type="password"/.test(fs.readFileSync(appFile('views', 'admin', 'sections', 'general.ejs'), 'utf8')));

  db.close();
  report();
})();
