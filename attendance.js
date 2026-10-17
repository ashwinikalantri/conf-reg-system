// Attendance: what can be signed into, when, and what counts as completing.
//
// An "event" is one thing a person signs into, named by a short key:
//   day1:IN, day2:IN, ...  -- signing in on a conference day;
//   dayN:OUT               -- signing out at the close of the LAST day;
//   ws:<optionId>:IN       -- signing in at a workshop (a programme option in
//                             a group that takes attendance, with a date set).
// Completing the conference = signed in on every day AND signed out on the
// last. A workshop certificate needs that workshop's sign-in.
//
// Each event has a window (IST, on its own date) inside which it can be
// recorded by a scan or by self sign-in; an attendance manager can still
// record one outside it, with a reason. Self sign-in reads a short-lived,
// signed token from a QR code shown on a screen at the venue, so a photo of
// the code passed around stops working within minutes.
//
// Pure: no database, no clock of its own -- everything takes `now` (ms).
const crypto = require('crypto');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DEFAULT_HOURS = {
  dayStart: '08:00', dayEnd: '17:00',
  signInEarlyMinutes: 60,              // sign-in opens an hour before the day starts
  signOutFrom: '15:00', signOutUntil: '18:00',
  workshopEarlyMinutes: 30,            // a workshop opens half an hour before it starts
};
const TOKEN_STEP_MS = 30 * 1000;       // the screen's QR changes every 30 seconds
const TOKEN_LIFETIME_STEPS = 10;       // a code is accepted for 5 minutes

const toMinutes = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const fromMinutes = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

// The IST date and minute-of-day of an instant.
function istParts(now) {
  const d = new Date(now + IST_OFFSET_MS);
  return { date: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (iso) => { const [, m, d] = iso.split('-'); return `${Number(d)} ${SHORT_MONTHS[Number(m) - 1]}`; };

// The conference days, from its first date to its last (at most 7).
function conferenceDays(startDate, endDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || '')) return [];
  const last = /^\d{4}-\d{2}-\d{2}$/.test(endDate || '') && endDate >= startDate ? endDate : startDate;
  const days = [];
  for (let d = startDate, i = 1; d <= last && i <= 7; d = addDays(d, 1), i++) days.push({ key: `day${i}`, n: i, date: d });
  return days;
}

// Every event, in order: each day's sign-in, the last day's sign-out, then
// each workshop that has a date. workshops: [{ id, name, session_date,
// start_time, end_time }].
function buildEvents({ startDate, endDate, workshops = [], hours = {} }) {
  const h = { ...DEFAULT_HOURS, ...hours };
  const days = conferenceDays(startDate, endDate);
  const events = [];
  for (const d of days) {
    events.push({
      e: `${d.key}:IN`, kind: 'IN', scope: 'day', day: d.key, date: d.date,
      label: `Day ${d.n} · Sign in`, longLabel: `Day ${d.n} (${shortDate(d.date)}) · Sign in`,
      from: fromMinutes(Math.max(0, toMinutes(h.dayStart) - Number(h.signInEarlyMinutes || 0))), until: h.dayEnd,
    });
  }
  if (days.length) {
    const d = days[days.length - 1];
    events.push({
      e: `${d.key}:OUT`, kind: 'OUT', scope: 'day', day: d.key, date: d.date,
      label: `Day ${d.n} · Sign out`, longLabel: `Day ${d.n} (${shortDate(d.date)}) · Sign out at the close`,
      from: h.signOutFrom, until: h.signOutUntil,
    });
  }
  for (const w of workshops) {
    const start = toMinutes(w.start_time);
    const end = toMinutes(w.end_time);
    const dated = /^\d{4}-\d{2}-\d{2}$/.test(w.session_date || '');
    events.push({
      e: `ws:${w.id}:IN`, kind: 'IN', scope: 'workshop', optionId: Number(w.id), name: w.name,
      date: dated ? w.session_date : null,
      label: w.name, longLabel: `${w.name}${dated ? ` (${shortDate(w.session_date)})` : ''} · Sign in`,
      from: dated && start != null ? fromMinutes(Math.max(0, start - Number(h.workshopEarlyMinutes || 0))) : null,
      until: dated && end != null ? w.end_time : null,
    });
  }
  return events;
}

// Whether an event can be recorded now by a scan or a self sign-in.
// { open: true } or { open: false, reason }.
function windowStatus(event, now) {
  if (!event) return { open: false, reason: 'Nothing to sign into.' };
  if (!event.date) return { open: false, reason: `"${event.name || event.label}" has no date yet -- set it in Programs.` };
  const { date, minutes } = istParts(now);
  if (date !== event.date) {
    return { open: false, reason: `${event.longLabel} is on ${shortDate(event.date)}${date < event.date ? '' : ', which has passed'}.` };
  }
  const from = toMinutes(event.from);
  const until = toMinutes(event.until);
  if (from != null && minutes < from) return { open: false, reason: `${event.longLabel} opens at ${to12(event.from)}.` };
  if (until != null && minutes > until) return { open: false, reason: `${event.longLabel} closed at ${to12(event.until)}.` };
  return { open: true };
}

function to12(hhmm) {
  const n = toMinutes(hhmm);
  if (n == null) return hhmm || '';
  const h = Math.floor(n / 60);
  const m = n % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

// --- Self sign-in tokens ----------------------------------------------------
// "<event>.<step>.<signature>": the event it signs into, the 30-second step it
// was made in, and an HMAC of both. Accepted for TOKEN_LIFETIME_STEPS steps.
const sign = (secret, payload) => crypto.createHmac('sha256', secret).update(payload).digest('base64url').slice(0, 22);

function makeToken(secret, e, now) {
  const step = Math.floor(now / TOKEN_STEP_MS);
  const payload = `${e}.${step}`;
  return `${payload}.${sign(secret, payload)}`;
}

// The event a token signs into, or { error } -- tampered, or too old.
function readToken(secret, token, now) {
  const m = /^((?:day\d+:(?:IN|OUT))|(?:ws:\d+:IN))\.(\d+)\.([A-Za-z0-9_-]{22})$/.exec(String(token || ''));
  if (!m) return { error: 'That sign-in code is not one of ours.' };
  const [, e, stepStr, sig] = m;
  const expected = sign(secret, `${e}.${stepStr}`);
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return { error: 'That sign-in code is not one of ours.' };
  const age = Math.floor(now / TOKEN_STEP_MS) - Number(stepStr);
  if (age < 0 || age >= TOKEN_LIFETIME_STEPS) return { error: 'That sign-in code has expired. Scan the code on the screen again.' };
  return { e };
}

// --- Completion -------------------------------------------------------------
// rows: one person's attendance [{ event_key }]. Completed = in on every day
// and out on the last; `missing` names what is not there.
function completion(rows, events) {
  const have = new Set(rows.map((r) => r.event_key));
  const needed = events.filter((ev) => ev.scope === 'day');
  const missing = needed.filter((ev) => !have.has(ev.e)).map((ev) => ev.label);
  return { complete: needed.length > 0 && missing.length === 0, missing };
}

module.exports = {
  DEFAULT_HOURS, TOKEN_STEP_MS, TOKEN_LIFETIME_STEPS, IST_OFFSET_MS,
  toMinutes, fromMinutes, istParts, conferenceDays, buildEvents, windowStatus, to12,
  makeToken, readToken, completion, shortDate,
};
