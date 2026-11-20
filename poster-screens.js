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

// The board: for each poster session (owner, 19 Nov 2026: two on 22 Nov,
// at 12 PM and 2 PM), every screen with its posters in running order and
// their times; then the posters not yet on a screen. The same screens serve
// each session; a poster has one place, in one session on one screen.
//   screens:  [{ id, name, moderator, sort_order }]
//   slots:    [{ abstract_id, session_id, screen_id, position }]
//   posters:  [{ id, ... }] -- the e-posters that take a screen
//   sessions: [{ id, date, start, end, ... }]; minutes: per poster
function board({ screens, slots, posters, sessions, minutes }) {
  const byId = new Map(posters.map((p) => [Number(p.id), p]));
  const ordered = [...screens].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
  const placed = new Set();
  const out = sessions.map((session) => {
    const start = toMin(session.start);
    const end = toMin(session.end);
    return {
      ...session,
      screens: ordered.map((s) => {
        const mine = slots.filter((x) => x.screen_id === s.id && Number(x.session_id) === Number(session.id) && byId.has(Number(x.abstract_id)))
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
      }),
    };
  });
  const unallotted = posters.filter((p) => !placed.has(Number(p.id)));
  return { sessions: out, unallotted };
}

// Whether every poster fits in the sessions, shared evenly over each
// session's screens, and what would make it fit.
function fit({ total, screens, minutes, sessions }) {
  const spans = (sessions || []).map((x) => ({ start: toMin(x.start), end: toMin(x.end) })).filter((x) => x.start != null && x.end > x.start);
  if (!spans.length || !total || !screens) return null;
  const lanes = spans.length * screens;
  const perScreen = Math.ceil(total / lanes);
  const overrun = Math.max(...spans.map((x) => Math.max(0, perScreen * minutes - (x.end - x.start))));
  const perScreenFits = spans.reduce((n, x) => n + Math.floor((x.end - x.start) / minutes), 0);
  return {
    total, screens, sessions: spans.length, minutes, perScreen, overrun,
    screensNeeded: perScreenFits ? Math.ceil(total / perScreenFits) : null,
    minutesThatFit: Math.min(...spans.map((x) => Math.floor((x.end - x.start) / perScreen))),
  };
}

// Spread the posters not yet on a screen: each to the lane (a screen in a
// session) with fewest, the earlier on a tie, at the end of its order.
// Nothing already placed moves. counts: Map(lane -> posters on it now).
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

// Where each e-poster's file goes in the Google Drive copy (owner, 20 Nov
// 2026): a folder per poster session, numbered in time order so they sort
// as they run, a folder per screen in it; a poster not on a screen yet in
// its own folder. In a screen's folder each file starts with its place in
// the running order (owner, 20 Nov 2026: 01_<file>), so they list in the
// order they are shown; the file itself keeps its name. Keyed by file name:
// { folder, name }; the host script stages the tree.
const NOT_PLACED_FOLDER = 'Not on a screen yet';
const folderName = (s) => String(s == null ? '' : s).replace(/[/\\]+/g, '-').replace(/\s+/g, ' ').trim() || '-';
function driveFolders({ sessions, unallotted }) {
  const out = {};
  sessions.forEach((session, i) => {
    const sessionFolder = folderName(`${i + 1}. ${[session.day, session.startTime, session.hall].filter(Boolean).join(', ')}`);
    for (const screen of session.screens) {
      screen.posters.forEach((p, i) => {
        if (p.file && p.file.fileName) out[p.file.fileName] = { folder: `${sessionFolder}/${folderName(screen.name)}`, name: `${String(p.place || i + 1).padStart(2, '0')}_${p.file.fileName}` };
      });
    }
  });
  for (const p of unallotted) if (p.file && p.file.fileName) out[p.file.fileName] = { folder: NOT_PLACED_FOLDER, name: p.file.fileName };
  return out;
}

module.exports = { DEFAULT_MINUTES, MIN_MINUTES, MAX_MINUTES, toMin, to12, ordinal, dayText, cleanMinutes, board, fit, allotEvenly, placeLine,
  driveFolders, NOT_PLACED_FOLDER };
