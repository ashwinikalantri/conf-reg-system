// The public conference website, at /website. No sign-in; read only.
//
// What the portal already knows is read live, so it is never typed twice:
// the programme (sessions, halls, times, speakers and chairs), the workshops
// and QI practices with their seats and coordinators, the fees and their
// dates, the abstract deadline, the conference's name and dates, and the
// halls on the campus map. Everything else -- about, team, faculty, partners,
// hotels, travel -- is website-content.js.
//
// Only public facts: names and titles. No phone number, email or anything
// about a delegate is read here.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const content = require('./website-content');
const peopleLib = require('./programme-people');

const NAV = [
  ['programme', 'Programme'], ['workshops', 'Workshops'], ['registration', 'Registration'], ['abstracts', 'Abstracts'],
  ['faculty', 'Faculty'], ['team', 'Organising team'], ['visit', 'Getting here'], ['about', 'About'],
];
const PAGES = new Set(['', ...NAV.map(([k]) => k)]);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const parseDate = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || ''); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null; };
// "Saturday 21 November", "Sat 21 Nov", "21 November 2026".
const dayLong = (d) => { const x = parseDate(d); return x ? `${DAYS[x.getUTCDay()]} ${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]}` : ''; };
const dayShort = (d) => { const x = parseDate(d); return x ? `${DAYS[x.getUTCDay()].slice(0, 3)} ${x.getUTCDate()} ${MONTHS[x.getUTCMonth()].slice(0, 3)}` : ''; };
const dateLong = (d) => { const x = parseDate(d); return x ? `${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]} ${x.getUTCFullYear()}` : ''; };
const dateShort = (d) => { const x = parseDate(d); return x ? `${x.getUTCDate()} ${MONTHS[x.getUTCMonth()].slice(0, 3)}` : ''; };
// "09:30" -> { t: '9:30', ap: 'AM' }
const t12 = (hm) => {
  const [h, m] = String(hm || '0:0').split(':').map(Number);
  return { t: `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}`, ap: h < 12 ? 'AM' : 'PM' };
};
const time12 = (hm) => { const x = t12(hm); return `${x.t} ${x.ap}`; };
const timeRange = (s) => `${time12(s.start_time)} – ${time12(s.end_time)}`;
const rupees = (n) => (n == null ? '—' : `₹${Number(n).toLocaleString('en-IN')}`);
const nameOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

// A tea, lunch or dinner, or registration: a line between talks, not a card.
const isBreak = (s) => !s.label && /\b(break|lunch|tea|registration|dinner)\b/i.test(s.title || '');
// The same session in several halls (an award session), as one item.
function mergeHalls(sessions) {
  const byKey = new Map();
  for (const s of sessions) {
    const key = [s.session_date, s.start_time, s.end_time, s.label || '', s.title].join('|');
    if (!byKey.has(key)) byKey.set(key, { ...s, halls: [] });
    byKey.get(key).halls.push(s.hall);
  }
  return [...byKey.values()];
}
// Who a "chairs" line is, by the kind of session.
const chairLabel = (s) => (/award|presentation/i.test(`${s.label} ${s.title}`) ? 'Judges' : /panel/i.test(s.label || '') ? 'Moderator' : 'Chairs');

// Every name on a session, with their part in it.
function sessionNames(s) {
  const list = [];
  const add = (names, role) => names.forEach((n) => list.push({ name: n, role }));
  if (s.people) {
    add(s.people.speakers.map((x) => x.name), 'speaker');
    add(s.people.chairs.map((x) => x.name), 'chair');
  } else {
    add(peopleLib.splitLegacy(s.speakers), 'speaker');
    add(peopleLib.splitLegacy(s.chairs), 'chair');
  }
  return list;
}

module.exports = function mountWebsite(app, d) {
  // d: { dbAll, dbGet, CONFERENCE, programmeSessions, fetchProgramGroups,
  //      getFeeConfig, currentPhase, istDateString, abstractSubmissionOpen,
  //      formatConferenceDates }
  const cssVersion = (() => {
    try { return crypto.createHash('sha1').update(fs.readFileSync(path.join(__dirname, 'public', 'website', 'site.css'))).digest('hex').slice(0, 10); } catch (e) { return String(Date.now()); }
  })();

  async function common() {
    const C = d.CONFERENCE;
    const today = d.istDateString();
    const start = parseDate(C.startDate);
    const daysToGo = start ? Math.round((start - parseDate(today)) / 86400000) : null;
    return {
      nav: NAV,
      cssVersion,
      content,
      conf: {
        name: C.name || 'International Conference on Healthcare Quality & Patient Safety 2026',
        acronym: C.acronym || '',
        dates: d.formatConferenceDates(),
        startDate: C.startDate, endDate: C.endDate,
        location: C.location || '',
        daysToGo,
      },
    };
  }

  // The fee phase today, and how to say it.
  async function feeState() {
    const config = (await d.getFeeConfig()) || {};
    const phase = d.currentPhase(config);
    const phases = [
      { key: 'early', label: 'Early bird', until: config.early_until },
      { key: 'regular', label: 'Standard', until: config.regular_until },
      { key: 'late', label: 'Late', until: config.late_until },
      { key: 'spot', label: 'On the spot', until: null },
    ];
    const at = phases.findIndex((p) => p.key === phase);
    phases.forEach((p, i) => { p.state = i < at ? 'past' : i === at ? 'now' : 'later'; p.untilText = p.until ? `till ${dateShort(p.until)}` : 'at the venue'; });
    const now = phases[at];
    const note = phase === 'spot'
      ? 'Online registration has closed. Register on the spot at the venue.'
      : `The ${now.label.toLowerCase()} fee applies until ${dateShort(now.until)}.${phase === 'late' ? ' After that, register on the spot at the venue.' : ''}`;
    return { phase, phases, note };
  }

  async function sessions() {
    return (await d.programmeSessions()).filter((s) => s.title);
  }

  // --- the pages ---
  const builders = {
    async '' () {
      const all = await sessions();
      const C = d.CONFERENCE;
      // Workshops a delegate can choose: not those by invitation.
      const invited = new Set((await d.fetchProgramGroups({ activeOnly: true }))
        .filter((g) => Number(g.invite_only)).flatMap((g) => g.options.map((o) => o.id)));
      const confDays = [C.startDate, C.endDate].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i);
      const days = confDays.map((date, i) => {
        const items = mergeHalls(all.filter((s) => s.session_date === date));
        const talks = items.filter((s) => !isBreak(s));
        const workshops = talks.filter((s) => Number(s.workshop) === 1 && !invited.has(s.option_id));
        const visits = talks.filter((s) => /exposure/i.test(s.label || ''));
        const lines = [];
        if (workshops.length) {
          const first = workshops.reduce((a, b) => (a.start_time <= b.start_time ? a : b));
          lines.push({ t: time12(first.start_time), text: `${workshops.length} workshops begin across the campus` });
        }
        if (visits.length) {
          const first = visits.reduce((a, b) => (a.start_time <= b.start_time ? a : b));
          lines.push({ t: time12(first.start_time), text: `Exposure visits: ${visits.flatMap((v) => v.halls).join(', ')}` });
        }
        const firstSession = talks.find((s) => /^session\b/i.test(s.label || ''));
        if (firstSession) {
          const halls = [...new Set(talks.filter((s) => s.start_time === firstSession.start_time && /^session\b/i.test(s.label || '')).flatMap((s) => s.halls))];
          lines.push({ t: time12(firstSession.start_time), text: `Sessions in ${halls.join(' and ')}` });
        }
        for (const s of talks) {
          if ((!s.label && !Number(s.workshop)) || /oration|valedictory/i.test(s.label || '')) lines.push({ t: time12(s.start_time), text: `${s.title}${s.halls.length === 1 ? `, ${s.halls[0]}` : ''}` });
        }
        return {
          n: i + 1, date, label: dayLong(date),
          title: workshops.length ? 'Pre-conference workshops' : 'Scientific programme',
          blurb: workshops.length
            ? `${workshops.length} hands-on workshops across the MGIMS campus, in small groups, for the whole day.`
            : `${talks.length} sessions across ${new Set(talks.flatMap((s) => s.halls)).size} halls: talks, panels, the NQOCN Oration, award papers, orals and posters.`,
          lines: sortLines(lines).slice(0, 5),
          link: workshops.length ? '/website/workshops' : `/website/programme?day=${date}`,
          linkText: workshops.length ? 'All workshops' : 'Full programme',
        };
      });
      const pick = (re) => { const s = all.find((x) => re.test(x.label || '')); return s ? { ...s, when: `${dayLong(s.session_date)}, ${time12(s.start_time)}` } : null; };
      return { days, oration: pick(/oration/i), plenary: pick(/plenary/i), fee: await feeState() };
    },

    async programme(req) {
      const all = await sessions();
      const dates = [...new Set(all.map((s) => s.session_date))].sort();
      const today = d.istDateString();
      const asked = String(req.query.day || '');
      const day = dates.includes(asked) ? asked : dates.includes(today) ? today : (dates.includes(d.CONFERENCE.startDate) ? d.CONFERENCE.startDate : dates[0]);
      const ofDay = all.filter((s) => s.session_date === day);
      const hallNames = [...new Set(ofDay.filter((s) => !isBreak(s)).map((s) => s.hall))];
      const hall = hallNames.includes(String(req.query.hall || '')) ? String(req.query.hall) : '';
      const shown = mergeHalls(ofDay.filter((s) => !hall || isBreak(s) || s.hall === hall));
      const starts = [...new Set(shown.map((s) => s.start_time))].sort();
      const rows = [];
      for (const st of starts) {
        const at = shown.filter((s) => s.start_time === st);
        const talks = at.filter((s) => !isBreak(s));
        const breaks = at.filter(isBreak);
        if (talks.length) {
          rows.push({ kind: 'talks', time: t12(st), items: talks.map((s) => ({
            label: s.label || '', title: s.title, hall: s.halls.join(', '), when: timeRange(s),
            speakers: s.speakers || '', chairs: s.chairs || '', chairLabel: chairLabel(s),
          })) });
        }
        for (const b of breaks) rows.push({ kind: 'break', text: `${timeRange(b)} · ${b.title}${b.halls.length === 1 ? `, ${b.halls[0]}` : ''}` });
      }
      const link = (q) => `/website/programme?${new URLSearchParams(q).toString()}`;
      return {
        day, dayLabel: dayLong(day),
        days: dates.map((x) => ({ date: x, label: dayShort(x), href: link({ day: x }), current: x === day })),
        halls: [{ name: '', label: 'All halls' }, ...hallNames.map((n) => ({ name: n, label: n }))]
          .map((h) => ({ ...h, href: h.name ? link({ day, hall: h.name }) : link({ day }), current: h.name === hall })),
        rows,
      };
    },

    async workshops() {
      const all = await sessions();
      const groups = await d.fetchProgramGroups({ activeOnly: true });
      const option = (g, o) => {
        const ss = all.filter((s) => s.option_id === o.id).sort((a, b) => (a.session_date + a.start_time).localeCompare(b.session_date + b.start_time));
        const s = ss[0];
        const capacity = Number(o.capacity) || 0;
        const left = Math.max(0, capacity - (Number(o.enrolled) || 0));
        const extra = content.practices[o.id] || null;
        return {
          id: o.id, name: o.name, label: (s && s.label) || '',
          by: s ? (s.speakers || '') : '',
          where: s ? s.hall : '', when: s ? `${dayLong(s.session_date)}, ${timeRange(s)}` : '',
          seats: Number(g.invite_only) || !capacity ? '' : (left ? `${left} of ${capacity} seats left` : 'Full'),
          full: !Number(g.invite_only) && capacity > 0 && left === 0,
          about: extra ? extra.about : '', activities: extra ? extra.activities : [],
          sortKey: (s && s.label) || o.name,
          date: s ? s.session_date : '',
        };
      };
      const shaped = groups.filter((g) => g.options.length).map((g) => {
        const options = g.options.map((o) => option(g, o)).sort((a, b) => nameOrder.compare(a.sortKey, b.sortKey));
        const dates = [...new Set(options.map((o) => o.date).filter(Boolean))].sort();
        return {
          id: g.id, name: g.name, inviteOnly: !!Number(g.invite_only), workshop: !!g.takes_attendance,
          when: dates.map(dayLong).join(' and '), options,
        };
      });
      return { open: shaped.filter((g) => !g.inviteOnly), invited: shaped.filter((g) => g.inviteOnly) };
    },

    async registration() {
      const cats = await d.dbAll('SELECT label, early_fee, regular_fee, late_fee, spot_fee FROM fee_categories WHERE active = 1 ORDER BY sort_order, id');
      const fee = await feeState();
      const groupOffer = (await d.dbGet('SELECT COUNT(*) AS n FROM group_discount_rules WHERE active = 1')).n > 0;
      return {
        fee,
        rows: cats.map((c) => ({ label: c.label, fees: [c.early_fee, c.regular_fee, c.late_fee, c.spot_fee].map(rupees) })),
        groupOffer,
        abstract: abstractState(),
      };
    },

    async abstracts() {
      return { abstract: abstractState() };
    },

    async faculty() {
      const all = await sessions();
      const people = content.internationalFaculty.map((f) => {
        const key = peopleLib.normName(f.name);
        const theirs = [];
        for (const s of mergeHalls(all)) {
          for (const n of sessionNames(s)) {
            if (peopleLib.normName(n.name) !== key) continue;
            const part = n.role === 'chair' ? `${chairLabel(s).replace(/s$/, '')}: ` : '';
            theirs.push({ title: `${part}${s.title}`, when: `${dayLong(s.session_date)}, ${time12(s.start_time)} · ${s.halls.join(', ')}`, href: `/website/programme?day=${s.session_date}` });
          }
        }
        return { ...f, sessions: theirs.filter((x, i, a) => a.findIndex((y) => y.title === x.title && y.when === x.when) === i) };
      });
      return { people };
    },

    async team() { return {}; },

    async visit() {
      // Halls with a location, one pin per spot -- as on the portal's map.
      const halls = await d.dbAll('SELECT name, lat, lng, floor, building FROM halls WHERE active = 1 AND lat IS NOT NULL AND lng IS NOT NULL ORDER BY sort_order, id');
      const byPlace = new Map();
      for (const h of halls) {
        const key = `${Number(h.lat).toFixed(5)},${Number(h.lng).toFixed(5)}`;
        if (!byPlace.has(key)) byPlace.set(key, { lat: Number(h.lat), lng: Number(h.lng), name: h.building || h.name, halls: [] });
        byPlace.get(key).halls.push(h.floor ? `${h.name} (${h.floor})` : h.name);
      }
      const places = [...byPlace.values()].map((p, i) => ({ ...p, n: i + 1, list: p.halls.join(', ') }));
      return { places };
    },

    async about() { return {}; },
  };

  // Home lines in time order (AM before PM, then by clock).
  function sortLines(lines) {
    const mins = (t) => { const m = /^(\d+):(\d+) (AM|PM)$/.exec(t); if (!m) return 0; return ((Number(m[1]) % 12) + (m[3] === 'PM' ? 12 : 0)) * 60 + Number(m[2]); };
    return lines.sort((a, b) => mins(a.t) - mins(b.t));
  }

  function abstractState() {
    const deadline = d.CONFERENCE.abstractDeadline;
    return { deadline, deadlineText: deadline ? dateLong(deadline) : '', open: d.abstractSubmissionOpen() };
  }

  async function render(req, res, next, key) {
    try {
      const data = await builders[key](req);
      res.set('Cache-Control', 'public, max-age=60');
      res.render(`website/${key || 'home'}`, { ...(await common()), page: key, ...data });
    } catch (err) {
      next(err);
    }
  }

  app.get(['/website', '/website/'], (req, res, next) => render(req, res, next, ''));
  app.get('/website/:page', async (req, res, next) => {
    const key = String(req.params.page || '');
    if (PAGES.has(key) && key) return render(req, res, next, key);
    try {
      res.status(404).render('website/notfound', { ...(await common()), page: 'notfound' });
    } catch (err) {
      next(err);
    }
  });
};

module.exports.NAV = NAV;
