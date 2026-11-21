// The home page while the conference is on (owner, 21 Nov 2026, from the
// canvas design "Live Conference Home"): on a conference day the hero says
// what is happening and what is next, then today at a glance (done, now,
// later), what is on right now and where, and tomorrow. All of it from the
// programme as it stands, at the moment the page is asked for.
//
// build(sessions, { days, now, isBreak }) -> null on any other day, else the
// page's model. sessions: programmeSessions() rows; days: the conference
// days, 'YYYY-MM-DD'; now: ms.

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const toMin = (hm) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(hm || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const clock = (min) => `${Math.floor(min / 60) % 12 || 12}:${String(min % 60).padStart(2, '0')}`;
const ampm = (min) => (min < 720 ? 'am' : 'pm');
const t12 = (min) => `${clock(min)} ${ampm(min)}`;
const span = (a, b) => (ampm(a) === ampm(b) ? `${clock(a)} – ${clock(b)} ${ampm(b)}` : `${t12(a)} – ${t12(b)}`);
const dayLabel = (iso) => { const d = new Date(`${iso}T00:00:00Z`); return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
// India time, whatever the server's clock zone.
const istParts = (now) => { const d = new Date(now + 330 * 60000); return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() }; };
const inText = (mins) => { const h = Math.floor(mins / 60); const m = mins % 60; return h ? `in ${h} h${m ? ` ${m} min` : ''}` : `in ${m} min`; };
const join = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const num = (s) => Number((/\d+/.exec(s.label || '') || [999])[0]);
const HIGHLIGHT = /plenary|oration|inaugur|valedict|closing|award/i;
const isVisit = (s) => /exposure|field visit/i.test(`${s.label || ''} ${s.hall || ''}`);
const placeOf = (hall) => String(hall || '').replace(/\s*\(field visit\)\s*$/i, '');

// One day's sessions, as { talks, breaks, workshopDay, workshops }.
function dayOf(sessions, date, isBreak) {
  const day = sessions.filter((s) => s.session_date === date && s.title)
    .map((s) => ({ ...s, a: toMin(s.start_time), b: toMin(s.end_time) })).filter((s) => s.a != null && s.b != null && s.b > s.a);
  const talks = day.filter((s) => !isBreak(s));
  const breaks = day.filter(isBreak);
  const halls = new Set(talks.map((s) => s.hall));
  const workshopDay = halls.size > 6;
  const workshops = workshopDay ? talks.filter((s) => Number(s.workshop) === 1 || /workshop|practice/i.test(s.label || '')).sort((x, y) => num(x) - num(y) || x.a - y.a) : [];
  return { talks, breaks, workshopDay, workshops };
}

// Meals and breaks served in more than one place, once.
function mergedBreaks(breaks) {
  const out = new Map();
  for (const b of breaks) {
    const k = `${b.a}|${b.b}|${b.title}`;
    if (!out.has(k)) out.set(k, { a: b.a, b: b.b, title: b.title, meal: Number(b.meal) === 1, halls: [] });
    out.get(k).halls.push(b.hall);
  }
  return [...out.values()].map((x) => ({ a: x.a, b: x.b, title: x.title, meal: x.meal, where: join([...new Set(x.halls)]) }));
}

// The day at a glance: meals and breaks, the workshops or the sessions as
// one line, field visits as one, and the big moments on their own.
function stripOf(day) {
  const items = mergedBreaks(day.breaks).map((x) => ({ a: x.a, b: x.b, title: x.title, where: x.where, meal: x.meal }));
  if (day.workshopDay) {
    const ws = day.workshops;
    if (ws.length) {
      const ends = ws.reduce((m, s) => m.set(s.b, (m.get(s.b) || 0) + 1), new Map());
      const usual = [...ends.entries()].sort((x, y) => y[1] - x[1])[0][0];
      items.push({ a: Math.min(...ws.map((s) => s.a)), b: Math.max(...ws.map((s) => s.b)), title: `Workshops, ${ws.length} in parallel`, where: `Across the campus, till ${t12(usual)}`, key: true });
    }
    for (const s of day.talks.filter((t) => !ws.includes(t))) items.push({ a: s.a, b: s.b, title: s.title, where: s.hall, key: true });
  } else {
    const visits = day.talks.filter(isVisit);
    const big = day.talks.filter((s) => !isVisit(s) && HIGHLIGHT.test(`${s.label || ''} ${s.title}`));
    const rest = day.talks.filter((s) => !visits.includes(s) && !big.includes(s));
    if (visits.length) items.push({ a: Math.min(...visits.map((s) => s.a)), b: Math.max(...visits.map((s) => s.b)), title: visits.length > 1 ? 'Field visits' : visits[0].title, where: join([...new Set(visits.map((s) => placeOf(s.hall)))]), key: true });
    if (rest.length) {
      const halls = [...new Set([...rest].sort((x, y) => (Number(x.hall_sort) || 999) - (Number(y.hall_sort) || 999)).map((s) => s.hall))];
      items.push({ a: Math.min(...rest.map((s) => s.a)), b: Math.max(...rest.map((s) => s.b)), title: halls.length > 1 ? `Sessions in ${halls.length} halls` : 'Sessions', where: join(halls), key: true });
    }
    const seen = new Set();
    for (const s of big) {
      const k = `${s.a}|${s.title}`;
      if (seen.has(k)) continue;
      seen.add(k);
      items.push({ a: s.a, b: s.b, title: s.title, where: join([...new Set(big.filter((x) => `${x.a}|${x.title}` === k).map((x) => x.hall))]), key: true });
    }
  }
  return items.sort((x, y) => x.a - y.a || x.b - y.b);
}

function build(sessions, { days, now, isBreak }) {
  const { date, min } = istParts(now);
  const confDays = [...new Set(days.filter(Boolean))].sort();
  const n = confDays.indexOf(date);
  if (n < 0) return null;
  const day = dayOf(sessions, date, isBreak);
  if (!day.talks.length && !day.breaks.length) return null;
  const state = (x) => (x.b <= min ? 'done' : x.a <= min ? 'now' : 'later');
  const strip = stripOf(day).map((x) => ({ ...x, state: state(x), time: t12(x.a), span: span(x.a, x.b) }));

  // What is on right now, and where.
  const running = day.talks.filter((s) => s.a <= min && min < s.b);
  const ws = running.filter((s) => day.workshops.includes(s));
  const usualWs = (() => { const m = day.workshops.reduce((acc, s) => acc.set(`${s.a}|${s.b}`, (acc.get(`${s.a}|${s.b}`) || 0) + 1), new Map()); const top = [...m.entries()].sort((x, y) => y[1] - x[1])[0]; return top ? top[0] : ''; })();
  let nowBlock;
  if (ws.length) {
    const [ua, ub] = usualWs.split('|').map(Number);
    nowBlock = { kind: 'workshops', heading: 'Happening now', note: `${ws.length === 1 ? 'One workshop' : `${ws.length} workshops`}, ${span(ua, ub)} unless noted. Find yours and its room.`,
      items: day.workshops.filter((s) => running.includes(s)).map((s) => ({ no: num(s) === 999 ? '' : num(s), title: s.title, where: s.hall, time: `${s.a}|${s.b}` === usualWs ? '' : span(s.a, s.b) })) };
  } else if (running.length) {
    nowBlock = { kind: 'halls', heading: 'Happening now', note: running.length === 1 ? 'On now.' : `In ${new Set(running.map((s) => s.hall)).size} places.`,
      items: running.sort((x, y) => (Number(x.hall_sort) || 999) - (Number(y.hall_sort) || 999) || x.a - y.a)
        .map((s) => ({ label: s.label || '', title: s.title, where: s.hall, speakers: s.speakers || '', time: `until ${t12(s.b)}` })) };
  } else {
    const later = day.talks.filter((s) => s.a > min);
    const first = later.length ? Math.min(...later.map((s) => s.a)) : null;
    nowBlock = first == null
      ? { kind: 'none', heading: n < confDays.length - 1 ? "Today's sessions are over" : 'The conference has ended', note: '', items: [] }
      : { kind: 'next', heading: `Coming up at ${t12(first)}`, note: 'Where to be.', items: later.filter((s) => s.a === first)
        .sort((x, y) => (Number(x.hall_sort) || 999) - (Number(y.hall_sort) || 999))
        .map((s) => ({ label: s.label || '', title: s.title, where: s.hall, speakers: s.speakers || '', time: span(s.a, s.b) })) };
  }

  // Next up: the next moments of the day (a meal only if nothing else).
  const ahead = strip.filter((x) => x.a > min);
  const nextOne = ahead.find((x) => x.key) || ahead[0] || null;
  const next = [];
  if (nextOne) next.push({ time: t12(nextOne.a), title: nextOne.title, where: nextOne.where, until: `until ${t12(nextOne.b)}`, in: inText(nextOne.a - min) });
  const after = ahead.filter((x) => x !== nextOne && x.a >= (nextOne ? nextOne.a : 0))[0];
  if (after) next.push({ time: t12(after.a), title: after.title, where: after.where });

  // Tomorrow, if there is one.
  const tomorrowDate = confDays[n + 1];
  const tomorrow = tomorrowDate ? (() => {
    const t = dayOf(sessions, tomorrowDate, isBreak);
    return { label: dayLabel(tomorrowDate), date: tomorrowDate, workshopDay: t.workshopDay,
      halls: new Set(t.talks.filter((s) => !isVisit(s)).map((s) => s.hall)).size,
      rows: stripOf(t).map((x) => ({ time: t12(x.a), title: x.title, where: x.where })) };
  })() : null;
  if (!next.length && tomorrow && tomorrow.rows.length) next.push({ time: tomorrow.rows[0].time, title: tomorrow.rows[0].title, where: tomorrow.rows[0].where, until: `Tomorrow, ${tomorrow.label}`, in: 'tomorrow' });

  // The headline and a line under it.
  const firstItem = strip[0];
  let headline;
  let lead;
  if (ws.length) {
    headline = 'The workshops are under way';
    lead = `${ws.length === 1 ? 'A pre-conference workshop is' : `${ws.length} pre-conference workshops are`} running across the MGIMS campus.`;
  } else if (running.length) {
    const halls = new Set(running.map((s) => s.hall)).size;
    headline = running.length === 1 && HIGHLIGHT.test(`${running[0].label || ''} ${running[0].title}`) ? `${running[0].title} is on now` : halls > 1 ? `Sessions are on in ${halls} halls` : 'A session is on now';
    lead = `Day ${n + 1} of ${confDays.length} is under way.`;
  } else if (firstItem && min < firstItem.a) {
    headline = `Day ${n + 1} begins at ${t12(firstItem.a)}`;
    lead = `${firstItem.title}${firstItem.where ? `, ${firstItem.where}` : ''}.`;
  } else if (nextOne) {
    headline = `Next: ${nextOne.title}`;
    lead = `At ${t12(nextOne.a)}${nextOne.where ? `, ${nextOne.where}` : ''}.`;
  } else if (tomorrow) {
    headline = `That's Day ${n + 1}. See you tomorrow`;
    lead = `Day ${n + 2} begins at ${tomorrow.rows[0] ? tomorrow.rows[0].time : 'the usual time'}.`;
  } else {
    headline = 'Thank you for joining us';
    lead = 'Certificates are issued in the delegate portal.';
  }
  if (nextOne && (ws.length || running.length)) lead += ` Next: ${nextOne.title}, ${t12(nextOne.a)}${nextOne.where ? `, ${nextOne.where}` : ''}.`;

  // Meals: the next one today, else tomorrow's first.
  const mealsToday = mergedBreaks(day.breaks).filter((x) => x.meal && x.b > min);
  const meal = mealsToday[0] ? `${mealsToday[0].title}, ${t12(mealsToday[0].a)}: ${mealsToday[0].where}.` : '';

  return {
    date, dayN: n + 1, dayCount: confDays.length, dayLabel: dayLabel(date), workshopDay: day.workshopDay,
    headline, lead, updated: t12(min), strip, now: nowBlock, next, tomorrow, meal, last: n === confDays.length - 1,
  };
}

module.exports = { build, istParts, stripOf };
