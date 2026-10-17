// Attendance: session by session, hall by hall.
//
// The programme is a set of halls and the sessions in them (see the
// programme_sessions table). Every hall has a QR code at its door; scanning
// it marks the delegate present at the session on in that hall at that
// moment -- or a volunteer at the door picks the hall and scans the
// delegate's badge. A session can be marked from a little before it starts
// (earlyMinutes) until it ends. Breaks, meals and registration do not take
// attendance (counts = 0).
//
// Certificates:
//   the conference -- on every main day (a day with conference sessions
//     that take attendance), present at a session before lunch and at one
//     after, where that day has sessions on both sides of lunch;
//   a workshop -- present at any of its sessions.
// A workshop session is one linked to a programme option in a group that
// takes attendance (the Workshops group); every other session that takes
// attendance is a conference session.
//
// Pure: no database, no clock of its own -- everything takes `now` (ms).

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DEFAULTS = { earlyMinutes: 15, lunchSplit: '13:00' };

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

function to12(hhmm) {
  const n = toMinutes(hhmm);
  if (n == null) return hhmm || '';
  const h = Math.floor(n / 60);
  return `${((h + 11) % 12) + 1}:${String(n % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (iso) => { const [, m, d] = String(iso || '').split('-'); return m ? `${Number(d)} ${SHORT_MONTHS[Number(m) - 1]}` : ''; };

// "21 - 22 Nov 2026", "30 Nov - 2 Dec 2026", "30 Dec 2026 - 2 Jan 2027",
// "21 Nov 2026" -- as the Faculty page writes a range (shortDateRange there).
function dateRange(from, to) {
  const part = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? { y: m[1], mon: SHORT_MONTHS[Number(m[2]) - 1], d: String(Number(m[3])) } : null; };
  const a = part(from);
  const b = part(to) || a;
  if (!a) return '';
  if (!to || from === to) return `${a.d} ${a.mon} ${a.y}`;
  if (a.y !== b.y) return `${a.d} ${a.mon} ${a.y} - ${b.d} ${b.mon} ${b.y}`;
  if (a.mon !== b.mon) return `${a.d} ${a.mon} - ${b.d} ${b.mon} ${b.y}`;
  return `${a.d} - ${b.d} ${b.mon} ${b.y}`;
}

const takesAttendance = (s) => Number(s.counts) === 1;

// Whether a session can be marked now: { open: true } or { open: false, reason }.
function sessionWindow(session, now, earlyMinutes = DEFAULTS.earlyMinutes) {
  if (!session) return { open: false, reason: 'No such session.' };
  if (!takesAttendance(session)) return { open: false, reason: `${session.title} does not take attendance.` };
  const { date, minutes } = istParts(now);
  const label = `${session.title} (${shortDate(session.session_date)}, ${to12(session.start_time)})`;
  if (date !== session.session_date) {
    return { open: false, reason: `${label} is ${date < session.session_date ? 'on another day' : 'over'}.` };
  }
  const start = toMinutes(session.start_time);
  const end = toMinutes(session.end_time);
  if (minutes < start - earlyMinutes) return { open: false, reason: `${label} opens for attendance at ${to12(fromMinutes(start - earlyMinutes))}.` };
  if (minutes > end) return { open: false, reason: `${label} is over.` };
  return { open: true };
}

// The session to mark in a hall now: one running (started, not ended), else
// one about to start (within earlyMinutes) -- only sessions that take
// attendance. Also the next one, to say when there is nothing now.
// sessions: that hall's, any day.
function currentSession(sessions, now, earlyMinutes = DEFAULTS.earlyMinutes) {
  const { date, minutes } = istParts(now);
  const today = sessions.filter((s) => s.session_date === date && takesAttendance(s))
    .sort((a, b) => toMinutes(a.start_time) - toMinutes(b.start_time));
  const running = today.filter((s) => toMinutes(s.start_time) <= minutes && minutes <= toMinutes(s.end_time));
  // Of two running (a session ending as the next begins), the later start.
  const session = running.length ? running[running.length - 1]
    : today.find((s) => toMinutes(s.start_time) - earlyMinutes <= minutes && minutes < toMinutes(s.start_time)) || null;
  const next = today.find((s) => toMinutes(s.start_time) > minutes && s !== session)
    || sessions.filter((s) => s.session_date > date && takesAttendance(s))
      .sort((a, b) => (a.session_date + a.start_time).localeCompare(b.session_date + b.start_time))[0] || null;
  return { session, next };
}

// Which sessions count towards the conference certificate: those that take
// attendance and are not a workshop's. isWorkshop(session) says which are.
function conferenceSessions(sessions, isWorkshop) {
  return sessions.filter((s) => takesAttendance(s) && !isWorkshop(s));
}

// Completing the conference. attended: the sessions the person was marked
// present at; sessions: every conference session (conferenceSessions()).
// For each day with conference sessions: present before lunch if that day
// has a session before lunch, and after lunch if it has one after.
function completion(attended, sessions, lunchSplit = DEFAULTS.lunchSplit) {
  const lunch = toMinutes(lunchSplit);
  const half = (s) => (toMinutes(s.start_time) < lunch ? 'before' : 'after');
  const ids = new Set(attended.map((s) => Number(s.id)));
  const days = [...new Set(sessions.map((s) => s.session_date))].sort();
  const parts = [];
  for (const date of days) {
    for (const h of ['before', 'after']) {
      const there = sessions.filter((s) => s.session_date === date && half(s) === h);
      if (!there.length) continue;
      const hit = there.find((s) => ids.has(Number(s.id))) || null;
      parts.push({ date, half: h, label: `${shortDate(date)}, ${h} lunch`, done: !!hit, session: hit });
    }
  }
  return { complete: parts.length > 0 && parts.every((p) => p.done), parts, missing: parts.filter((p) => !p.done).map((p) => p.label) };
}

module.exports = {
  IST_OFFSET_MS, DEFAULTS, toMinutes, fromMinutes, istParts, to12, shortDate, dateRange,
  takesAttendance, sessionWindow, currentSession, conferenceSessions, completion,
};
