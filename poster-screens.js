'use strict';
// E-posters on display screens (Step 4 of the abstracts desk, owner 19 Nov
// 2026): each poster has a screen and a place in that screen's running
// order; its time follows from the poster session's start (a programme
// session) and the minutes each poster gets. Pure logic -- the routes and
// tables are in server.js (POSTER SCREENS).

// The guidelines' 5 minutes to present and 2 for questions.
const DEFAULT_MINUTES = 7;
const MIN_MINUTES = 2;
const MAX_MINUTES = 30;

const toMin = (hm) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const to12 = (min) => {
  const h = Math.floor(min / 60) % 24;
  const m = String(min % 60).padStart(2, '0');
  return `${h % 12 || 12}:${m} ${h < 12 ? 'AM' : 'PM'}`;
};
const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
};
// "2026-11-22" -> "Sunday 22 November". Spelt out rather than left to
// toLocaleDateString, which a small-ICU Node words differently.
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dayText = (date) => {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

const cleanMinutes = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= MIN_MINUTES && n <= MAX_MINUTES ? n : null;
};

// The board: screens in order, each with its posters in running order and
// their times, and the posters not yet on a screen.
//   screens: [{ id, name, moderator, sort_order }]
//   slots:   [{ abstract_id, screen_id, position }]
//   posters: [{ id, ... }] -- the e-posters that take a screen
//   session: { date, start, end, ... } or null; minutes: per poster
function board({ screens, slots, posters, session, minutes }) {
  const byId = new Map(posters.map((p) => [Number(p.id), p]));
  const ordered = [...screens].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
  const start = session ? toMin(session.start) : null;
  const end = session ? toMin(session.end) : null;
  const placed = new Set();
  const out = ordered.map((s) => {
    const mine = slots.filter((x) => x.screen_id === s.id && byId.has(Number(x.abstract_id)))
      .sort((a, b) => a.position - b.position || a.abstract_id - b.abstract_id);
    const items = mine.map((x, i) => {
      placed.add(Number(x.abstract_id));
      const at = start == null ? null : start + i * minutes;
      return { ...byId.get(Number(x.abstract_id)), place: i + 1, startMin: at, time: at == null ? null : to12(at) };
    });
    const finish = start == null ? null : start + items.length * minutes;
    return {
      id: s.id, name: s.name, moderator: s.moderator || '', posters: items,
      endMin: finish, endTime: finish == null ? null : to12(finish),
      overrun: finish != null && end != null && items.length ? Math.max(0, finish - end) : 0,
    };
  });
  const unallotted = posters.filter((p) => !placed.has(Number(p.id)));
  return { screens: out, unallotted };
}

// Whether it all fits in the session, and what would make it.
function fit({ total, screens, minutes, session }) {
  const start = session ? toMin(session.start) : null;
  const end = session ? toMin(session.end) : null;
  if (start == null || end == null || end <= start || !total || !screens) return null;
  const span = end - start;
  const perScreen = Math.ceil(total / screens);
  const finish = start + perScreen * minutes;
  const fitsPerScreen = Math.floor(span / minutes);
  return {
    total, screens, minutes, perScreen,
    endTime: to12(finish), sessionEndTime: to12(end),
    overrun: Math.max(0, finish - end),
    screensNeeded: fitsPerScreen ? Math.ceil(total / fitsPerScreen) : null,
    minutesThatFit: Math.floor(span / perScreen),
  };
}

// Spread the posters not yet on a screen: each to the screen with fewest,
// the earlier screen on a tie, at the end of its order. Nothing already
// placed moves. counts: Map(screen id -> posters on it now).
function allotEvenly(screenIds, counts, abstractIds) {
  const n = new Map(screenIds.map((id) => [id, counts.get(id) || 0]));
  const out = [];
  for (const abstractId of abstractIds) {
    let best = null;
    for (const id of screenIds) if (best == null || n.get(id) < n.get(best)) best = id;
    if (best == null) break;
    out.push({ abstractId, screenId: best, position: n.get(best) });
    n.set(best, n.get(best) + 1);
  }
  return out;
}

// The line a presenter is told: "Screen 2 · Sunday 22 November · about
// 2:07 PM (2nd) · Hall B".
function placeLine(screen, poster, session) {
  return [screen.name, session && session.date ? dayText(session.date) : '',
    poster.time ? `about ${poster.time} (${ordinal(poster.place)})` : `${ordinal(poster.place)} in its order`,
    session && session.hall ? session.hall : ''].filter(Boolean).join(' · ');
}

module.exports = { DEFAULT_MINUTES, MIN_MINUTES, MAX_MINUTES, toMin, to12, ordinal, dayText, cleanMinutes, board, fit, allotEvenly, placeLine };
