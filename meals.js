// Meals: the rules, kept apart from the routes (server.js, MEALS) so they
// can be tested on their own.
//
// A meal is a programme session ticked "meal". Meal sessions that start on
// the same day at the same time are ONE meal served at several counters
// (the workshop-day lunch on two lawns): a person is served once across all
// of them.
//
// Who is served (the organisers' decision, 31 Oct 2026): confirmed
// delegates, faculty (on the Faculty list, not cancelled, registered or
// not), and organisers and volunteers (staff accounts). A delegate whose
// registration is not confirmed is not -- the counter sends them to the
// registration desk, or serves them anyway with a reason that is kept.

const IST_MS = 5.5 * 3600 * 1000;
// Serving opens half an hour before a meal's start and runs two hours past
// its end (owner, 20 Nov 2026; it was an hour each side). In volunteer test
// mode a volunteer can serve any meal at any time: anyTime.
const OPEN_BEFORE_MIN = 30;
const OPEN_AFTER_MIN = 120;

const mealKeyOf = (s) => `${s.session_date} ${s.start_time}`;

// The meals, in time order: { key, date, start, end, title, counters }.
function groupMeals(sessions) {
  const byKey = new Map();
  for (const s of sessions) {
    if (Number(s.meal) !== 1) continue;
    const key = mealKeyOf(s);
    if (!byKey.has(key)) byKey.set(key, { key, date: s.session_date, start: s.start_time, end: s.end_time, title: s.title, counters: [] });
    const m = byKey.get(key);
    if (s.end_time > m.end) m.end = s.end_time;
    m.counters.push({ sessionId: s.id, hall: s.hall || '' });
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

const toMin = (hhmm) => { const [h, m] = String(hhmm || '0:0').split(':').map(Number); return h * 60 + m; };
function istNow(now = Date.now()) {
  const d = new Date(Number(now) + IST_MS);
  return { date: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

// Is it being served now? { open, over, soon } (and anyTime, in test mode).
function mealWindow(meal, now = Date.now(), { anyTime = false } = {}) {
  if (anyTime) return { open: true, over: false, soon: false, anyTime: true };
  const t = istNow(now);
  if (t.date !== meal.date) return { open: false, over: t.date > meal.date, soon: false };
  const from = toMin(meal.start) - OPEN_BEFORE_MIN;
  const to = toMin(meal.end) + OPEN_AFTER_MIN;
  return { open: t.minutes >= from && t.minutes <= to, over: t.minutes > to, soon: t.minutes < from };
}

// The meal to show a counter first: the one being served now, else the
// next one, else the last.
function currentMeal(meals, now = Date.now()) {
  return meals.find((m) => mealWindow(m, now).open)
    || meals.find((m) => !mealWindow(m, now).over)
    || meals[meals.length - 1] || null;
}

// Who someone is, for the counter, and whether they are served.
// facts: { staff, faculty (on the list, not cancelled), facultyCancelled,
//          regStatus (their registration's bank_status, or null) }
//          volunteer (registered in the Volunteer category) }
// -> { eligible, kind ('FACULTY' | 'ORGANISER' | 'VOLUNTEER' | 'DELEGATE' | null), reason }
// WALKIN: someone not signed up, served on the spot with their name taken
// down (owner, 20 Nov 2026).
const KIND_LABEL = { FACULTY: 'Faculty', ORGANISER: 'Organiser', VOLUNTEER: 'Volunteer', DELEGATE: 'Delegate', WALKIN: 'Walk-in' };
const NOT_CHECKED_IN = 'Not checked in yet: send them to the registration desk to check in first.';
function decide(facts) {
  // Everyone with a registration checks in at the registration desk first:
  // delegates (owner, 20 Nov 2026), and faculty and volunteers too (21 Nov).
  // Organisers are not asked; faculty with no registration to check in
  // (no account, or none made) are served as faculty. checkedIn undefined:
  // not asked (older callers), so not held against them.
  const notIn = facts.regStatus === 'BANK_VERIFIED' && facts.checkedIn === false && !facts.staff;
  if (facts.faculty) return notIn ? { eligible: false, kind: 'FACULTY', reason: NOT_CHECKED_IN } : { eligible: true, kind: 'FACULTY', reason: null };
  if (facts.staff) return { eligible: true, kind: 'ORGANISER', reason: null };
  if (notIn) return { eligible: false, kind: facts.volunteer ? 'VOLUNTEER' : 'DELEGATE', reason: NOT_CHECKED_IN };
  if (facts.regStatus === 'BANK_VERIFIED') return { eligible: true, kind: facts.volunteer ? 'VOLUNTEER' : 'DELEGATE', reason: null };
  const reason = facts.facultyCancelled ? 'Taken off the Faculty list (cancelled).'
    : facts.regStatus === 'PARTIAL_PAYMENT' ? 'Balance due: send them to the registration desk.'
      : facts.regStatus === 'PENDING' ? 'Payment not yet approved: send them to the registration desk.'
        : facts.regStatus === 'REJECTED' ? 'Registration rejected: send them to the registration desk.'
          : 'Not registered for the conference: send them to the registration desk.';
  return { eligible: false, kind: facts.regStatus ? (facts.volunteer ? 'VOLUNTEER' : 'DELEGATE') : null, reason };
}

// A meal pass's code: "MP" and ten letters or digits, no look-alikes.
const PASS_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newPassCode(randomBytes) {
  const bytes = randomBytes(10);
  let code = 'MP';
  for (let i = 0; i < 10; i++) code += PASS_ALPHABET[bytes[i] % PASS_ALPHABET.length];
  return code;
}
const PASS_RE = /^MP[A-Z2-9]{10}$/;

module.exports = { groupMeals, mealWindow, currentMeal, decide, newPassCode, PASS_RE, KIND_LABEL, istNow, OPEN_BEFORE_MIN, OPEN_AFTER_MIN };
