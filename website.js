// The public conference website, at /website. No sign-in; read only.
//
// What the portal already knows is read live, so it is never typed twice:
// the programme (sessions, halls, times, speakers and chairs), the workshops
// and QI practices with their seats and coordinators, the fees and their
// dates, the abstract deadline, and the conference's name and dates.
// Everything else -- about, team, faculty, partners,
// hotels, travel -- is website-content.js.
//
// Only public facts: names and titles. No phone number, email or anything
// about a delegate is read here.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const content = require('./website-content');
const peopleLib = require('./programme-people');
const presentationsLib = require('./presentations');
const liveLib = require('./website-live');

// The menu: three groups that open to their pages, and two plain links.
// [page, label, what it is] -- the last shown in the desktop drop-downs.
const MENU = [
  { label: 'Programme', items: [
    ['programme', 'Programme', 'Day by day, by hall: every session, speaker and chair'],
    ['workshops', 'Workshops and QI in practice', 'Pre-conference workshops, seats left, and the exposure visits'],
  ] },
  { label: 'Registration', items: [
    ['registration', 'Registration and fees', 'The fee table, and which fee applies today'],
    ['abstracts', 'Abstract guidelines', 'Eligibility, review, awards and presentation rules'],
    ['presentations', 'Presentation guidelines', 'E-posters and papers: the templates, the rules and the upload'],
    ['sample-abstract', 'Sample abstract', 'A model structured abstract, to follow its format'],
  ] },
  { label: 'People', items: [
    ['faculty', 'International faculty', 'Who is coming, and when they speak'],
    ['team', 'Organising team', 'Patrons, committees and secretaries'],
  ] },
  { key: 'visit', label: 'Getting here' },
  { key: 'about', label: 'About' },
];
const PAGES = new Set(['', ...MENU.flatMap((m) => (m.items ? m.items.map(([k]) => k) : [m.key]))]);

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

// A breakfast, tea, lunch or dinner, or registration: a line between talks,
// not a card. "Breakfast" is named: \bbreak\b does not match it. A session
// ticked as a meal is one whatever its label (the 21 Nov breakfast was
// labelled "Breakfast").
const isBreak = (s) => Number(s.meal) === 1 || (!s.label && /\b(break|breakfast|lunch|tea|registration|dinner)\b/i.test(s.title || ''));
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
  // Cancelled faculty are not on the programme.
  if (s.people) {
    add(s.people.speakers.filter((x) => !x.cancelled).map((x) => x.name), 'speaker');
    add(s.people.chairs.filter((x) => !x.cancelled).map((x) => x.name), 'chair');
  } else {
    add(peopleLib.splitLegacy(s.speakers), 'speaker');
    add(peopleLib.splitLegacy(s.chairs), 'chair');
  }
  return list;
}

// The site is served twice: at /website on any address, and at the root of
// its own address (`host`, nqocn2026.mgims.ac.in). That address carries the
// delegate portal too, at /portal, with its /admin, /api and /help as ever;
// the old address (registration.mgims.ac.in) sends everything here
// (redirectOldHosts).
const hostOf = (req) => String(req.headers.host || '').split(':')[0].toLowerCase();

// The earlier site's pages on that address (an ASP.NET site), each to its
// page here, so old links and search results still land somewhere useful.
const OLD_PAGES = {
  'index.aspx': '/', 'orgteam.aspx': '/team', 'internationalfaculty.aspx': '/faculty',
  'abstarct_instructions.aspx': '/abstracts', 'fees.aspx': '/registration', 'accommodationoption.aspx': '/visit',
  'workshops.aspx': '/workshops', 'qipractice.aspx': '/workshops', 'gettinghere.aspx': '/visit',
  'scientificprogrammeday1.aspx': '/programme?day=2026-11-21', 'scientificprogrammeday2.aspx': '/programme?day=2026-11-22',
  'aboutmgims.aspx': '/about', 'aboutnqocn.aspx': '/about',
};

module.exports = function mountWebsite(app, d, { host = '' } = {}) {
  // d: { dbAll, dbGet, CONFERENCE, programmeSessions, fetchProgramGroups,
  //      getFeeConfig, currentPhase, istDateString, abstractSubmissionOpen,
  //      formatConferenceDates }
  const cssVersion = (() => {
    try { return crypto.createHash('sha1').update(fs.readFileSync(path.join(__dirname, 'public', 'website', 'site.css'))).digest('hex').slice(0, 10); } catch (e) { return String(Date.now()); }
  })();

  // ctx: { base, portal, path } -- where the pages are, where the portal is,
  // and this page's own path.
  async function common(ctx) {
    const C = d.CONFERENCE;
    const today = d.istDateString();
    const start = parseDate(C.startDate);
    const daysToGo = start ? Math.round((start - parseDate(today)) / 86400000) : null;
    return {
      menu: MENU,
      base: ctx.base,
      home: ctx.base || '/',
      // The delegate portal: Sign in and Register.
      portal: ctx.portal,
      // The one address search engines should list, when the site has its own.
      canonical: host ? `https://${host}${ctx.path}` : '',
      // Images and the stylesheet: public/website, wherever the pages are.
      assets: '/website',
      cssVersion,
      content,
      conf: {
        name: C.name || 'International Conference on Healthcare Quality & Patient Safety 2026',
        acronym: C.acronym || '',
        dates: d.formatConferenceDates(),
        startDate: C.startDate, endDate: C.endDate,
        location: C.location || '',
        daysToGo,
        // The day after the last day (owner, 22 Nov 2026): the site thanks
        // people rather than asking them to register.
        over: !!C.endDate && today > C.endDate,
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
      // The last fee is not only at the venue: online registration stays
      // open, at the same fee (owner, 3 Nov 2026).
      { key: 'spot', label: config.late_until ? `After ${dateShort(config.late_until)}` : 'Final', until: null },
    ];
    const at = phases.findIndex((p) => p.key === phase);
    phases.forEach((p, i) => { p.state = i < at ? 'past' : i === at ? 'now' : 'later'; p.untilText = p.until ? `till ${dateShort(p.until)}` : 'online or at the venue'; });
    const now = phases[at];
    const note = phase === 'spot'
      ? 'Registration is open, online or at the venue, at the fee in the last column.'
      : `The ${now.label.toLowerCase()} fee applies until ${dateShort(now.until)}.${phase === 'late' ? ' After that, the last column applies, online or at the venue.' : ''}`;
    return { phase, phases, note };
  }

  async function sessions() {
    return (await d.programmeSessions()).filter((s) => s.title);
  }

  // One day's programme, time by time: the talks starting together, then
  // the breaks. hall narrows the talks to one hall.
  function programmeRows(ofDay, hall = '') {
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
    return rows;
  }

  // One day by hall (owner, 20 Nov 2026: "show programme by Hall and
  // time"): the breaks and meals first, then each hall, in the halls' own
  // order, with its sessions in time order.
  function programmeByHall(ofDay, label) {
    const breaks = ofDay.filter(isBreak).sort((a, b) => a.start_time.localeCompare(b.start_time));
    const seen = new Set();
    const breakLines = [];
    for (const b of breaks) {
      const key = `${b.start_time}|${b.end_time}|${b.title}`;
      const same = breaks.filter((x) => `${x.start_time}|${x.end_time}|${x.title}` === key);
      if (seen.has(key)) continue;
      seen.add(key);
      breakLines.push(`${timeRange(b)} · ${b.title}, ${[...new Set(same.map((x) => x.hall))].join(', ')}`);
    }
    const talks = ofDay.filter((s) => !isBreak(s));
    const halls = [...new Map(talks.map((s) => [s.hall, s.hall_sort == null ? 999 : Number(s.hall_sort)])).entries()]
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([name]) => name);
    return {
      label, breaks: breakLines,
      halls: halls.map((name) => ({
        name,
        items: talks.filter((s) => s.hall === name).sort((a, b) => a.start_time.localeCompare(b.start_time)).map((s) => ({
          time: time12(s.start_time), when: timeRange(s), label: s.label || '', title: s.title,
          speakers: s.speakers || '', chairs: s.chairs || '', chairLabel: chairLabel(s),
        })),
      })),
    };
  }

  // The whole programme as a printable A4 PDF (owner, 20 Nov 2026).
  async function programmePdf(req, res, next) {
    try {
      const all = await sessions();
      const dates = [...new Set(all.map((s) => s.session_date))].sort();
      const C = d.CONFERENCE;
      const pdf = await require('./programme-pdf').renderProgrammePdf(
        dates.map((day) => programmeByHall(all.filter((s) => s.session_date === day), dayLong(day))),
        { conference: C.name, acronym: C.acronym, venue: C.location, dates: d.formatConferenceDates ? d.formatConferenceDates() : '', url: host ? `${host}/programme` : '' });
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `inline; filename="${String(C.acronym || 'Conference').replace(/[^A-Za-z0-9]+/g, '-')}-Scientific-Programme.pdf"`);
      res.set('Cache-Control', 'no-cache');
      res.send(pdf);
    } catch (err) {
      next(err);
    }
  }

  // The programme at a glance (owner, 20 Nov 2026): the same sessions,
  // typeset on a few pages -- the workshop day as a table, the conference
  // day as a timetable by hall -- under the conference header, with the
  // partners' logos at the foot of every page. Linked beside the full programme.
  async function programmeGlancePdf(req, res, next) {
    try {
      const C = d.CONFERENCE;
      const img = (file) => path.join(__dirname, 'public', 'website', 'img', file);
      const pdf = await require('./programme-glance-pdf').renderGlancePdf(await sessions(),
        { conference: C.name, acronym: C.acronym, venue: C.location, dates: d.formatConferenceDates ? d.formatConferenceDates() : '', url: host ? `${host}/programme` : '',
          logo: img('nqocn-mgims-logo.png'), partners: content.partners.map((x) => ({ name: x.name, path: img(x.file) })) });
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `inline; filename="${String(C.acronym || 'Conference').replace(/[^A-Za-z0-9]+/g, '-')}-Programme-at-a-Glance.pdf"`);
      res.set('Cache-Control', 'no-cache');
      res.send(pdf);
    } catch (err) {
      next(err);
    }
  }

  // --- the pages ---
  const builders = {
    async '' (req) {
      const base = req.siteBase;
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
          link: workshops.length ? `${base}/workshops` : `${base}/programme?day=${date}`,
          linkText: workshops.length ? 'All workshops' : 'Full programme',
        };
      });
      const pick = (re) => { const s = all.find((x) => re.test(x.label || '')); return s ? { ...s, when: `${dayLong(s.session_date)}, ${time12(s.start_time)}` } : null; };
      // On a conference day the page is live (21 Nov 2026): what is on now
      // and next. ?at=2026-11-21T14:30 (India time) shows it as at then,
      // to check before the day; a live page reloads itself every 5 minutes.
      const at = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(String(req.query.at || ''));
      const now = at ? Date.parse(`${at[1]}T${at[2]}:${at[3]}:00+05:30`) : Date.now();
      const liveDays = [...new Set(all.map((s) => s.session_date))].filter((x) => x >= (C.startDate || '') && x <= (C.endDate || C.startDate || ''));
      const live = liveLib.build(all, { days: liveDays.length ? liveDays : confDays, now, isBreak });
      // After the last day (owner, 22 Nov 2026): the thank-you page, built
      // from the record of what happened. ?at= previews it too.
      const atDate = at ? at[1] : d.istDateString();
      const after = !live && !!C.endDate && atDate > C.endDate ? await afterConference(all, pick) : null;
      return { days, oration: pick(/oration/i), plenary: pick(/plenary/i), fee: await feeState(), live, after,
        glancePdf: `${base}/programme-at-a-glance.pdf`,
        extraHead: live && !at ? '<meta http-equiv="refresh" content="300">' : undefined };
    },

    async programme(req) {
      const base = req.siteBase;
      const all = await sessions();
      const dates = [...new Set(all.map((s) => s.session_date))].sort();
      const today = d.istDateString();
      const asked = String(req.query.day || '');
      const day = dates.includes(asked) ? asked : dates.includes(today) ? today : (dates.includes(d.CONFERENCE.startDate) ? d.CONFERENCE.startDate : dates[0]);
      const ofDay = all.filter((s) => s.session_date === day);
      const hallNames = [...new Set(ofDay.filter((s) => !isBreak(s)).map((s) => s.hall))];
      const hall = hallNames.includes(String(req.query.hall || '')) ? String(req.query.hall) : '';
      const rows = programmeRows(ofDay, hall);
      const link = (q) => `${base}/programme?${new URLSearchParams(q).toString()}`;
      return {
        day, dayLabel: dayLong(day),
        days: dates.map((x) => ({ date: x, label: dayShort(x), href: link({ day: x }), current: x === day })),
        halls: [{ name: '', label: 'All halls' }, ...hallNames.map((n) => ({ name: n, label: n }))]
          .map((h) => ({ ...h, href: h.name ? link({ day, hall: h.name }) : link({ day }), current: h.name === hall })),
        rows,
        pdf: `${base}/programme.pdf`,
        glancePdf: `${base}/programme-at-a-glance.pdf`,
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
      const cats = await d.dbAll('SELECT label, early_fee, regular_fee, late_fee, spot_fee FROM fee_categories WHERE active = 1 AND COALESCE(staff_only, 0) = 0 ORDER BY sort_order, id');
      const fee = await feeState();
      return {
        fee,
        rows: cats.map((c) => ({ label: c.label, fees: [c.early_fee, c.regular_fee, c.late_fee, c.spot_fee].map(rupees) })),
        abstract: abstractState(),
      };
    },

    async abstracts() {
      return { abstract: abstractState() };
    },

    async 'sample-abstract' () { return {}; },

    // The last date is the portal's (the abstracts desk, Step 3).
    async presentations() {
      const due = d.CONFERENCE.presentationsDue;
      return { due: { text: presentationsLib.dueText(due), open: presentationsLib.isOpen(due) } };
    },

    async faculty(req) {
      const base = req.siteBase;
      const all = await sessions();
      const people = content.internationalFaculty.map((f) => {
        const key = peopleLib.normName(f.name);
        const theirs = [];
        for (const s of mergeHalls(all)) {
          for (const n of sessionNames(s)) {
            if (peopleLib.normName(n.name) !== key) continue;
            const part = n.role === 'chair' ? `${chairLabel(s).replace(/s$/, '')}: ` : '';
            theirs.push({ title: `${part}${s.title}`, when: `${dayLong(s.session_date)}, ${time12(s.start_time)} · ${s.halls.join(', ')}`, href: `${base}/programme?day=${s.session_date}` });
          }
        }
        return { ...f, sessions: theirs.filter((x, i, a) => a.findIndex((y) => y.title === x.title && y.when === x.when) === i) };
      });
      return { people };
    },

    async team() { return {}; },

    // The campus map is for delegates, in the portal; the site gives
    // directions to the campus only.
    async visit() { return {}; },

    async about() { return {}; },
  };

  // Home lines in time order (AM before PM, then by clock).
  function sortLines(lines) {
    const mins = (t) => { const m = /^(\d+):(\d+) (AM|PM)$/.exec(t); if (!m) return 0; return ((Number(m[1]) % 12) + (m[3] === 'PM' ? 12 : 0)) * 60 + Number(m[2]); };
    return lines.sort((a, b) => mins(a.t) - mins(b.t));
  }

  // The conference in figures, the best papers (once the organisers show
  // them) and what each day held -- for the page after it (owner, 22 Nov
  // 2026). Counts only, and the winners' names, institutions and titles.
  async function afterConference(all, pick) {
    const one = async (sql, p = []) => Number(((await d.dbGet(sql, p)) || {}).n || 0);
    const workshopGroup = "(SELECT o.id FROM program_options o JOIN program_groups g ON g.id = o.group_id WHERE g.name = 'Workshops' AND o.active = 1)";
    const papers = await d.dbAll(`SELECT authors FROM abstracts WHERE status = 'ACCEPTED' AND decision_sent_at IS NOT NULL AND allocation IN ('ORAL', 'POSTER', 'AWARD')`);
    const coauthors = papers.reduce((n, a) => { try { const x = JSON.parse(a.authors || '[]'); return n + (Array.isArray(x) ? x.length : 0); } catch (e) { return n; } }, 0);
    const workshops = await one(`SELECT COUNT(DISTINCT option_id) AS n FROM programme_sessions WHERE option_id IN ${workshopGroup}`);
    const stats = [
      [await one("SELECT COUNT(*) AS n FROM registrations WHERE COALESCE(bank_status, '') != 'REJECTED'"), 'registered'],
      [await one("SELECT COUNT(DISTINCT COALESCE(CAST(guest_id AS TEXT), LOWER(TRIM(name)))) AS n FROM programme_session_faculty"), 'faculty'],
      [all.filter((s) => !isBreak(s)).length, 'sessions'],
      [workshops, 'workshops'],
      [await one(`SELECT COUNT(DISTINCT a.phone_number || '|' || s.option_id) AS n FROM attendance a JOIN programme_sessions s ON 's:' || s.id = a.event_key
          WHERE a.removed_at IS NULL AND s.option_id IN ${workshopGroup}`), 'workshop participants'],
      [papers.length, 'abstracts presented'],
      [papers.length + coauthors, 'researchers'],
      [await one("SELECT COUNT(*) AS n FROM program_options o JOIN program_groups g ON g.id = o.group_id WHERE g.name = 'QI Practices' AND o.active = 1"), 'field visits'],
    ].filter(([n]) => n > 0).map(([n, label]) => ({ n: Number(n).toLocaleString('en-IN'), label }));

    // The best papers: only once the organisers choose to show them
    // (Review Desk, Step 5).
    const shown = ((await d.dbGet("SELECT value FROM schema_meta WHERE key = 'website_winners_public'")) || {}).value === '1';
    const rows = shown ? await d.dbAll(`SELECT p.format, p.rank, a.title, a.author_name, u.salutation, u.full_name, u.institution
        FROM presentation_prizes p JOIN abstracts a ON a.id = p.abstract_id LEFT JOIN users u ON u.phone_number = a.phone_number ORDER BY p.rank`) : [];
    const kinds = [['AWARD', 'Award papers'], ['ORAL', 'Oral papers'], ['POSTER', 'E-posters']];
    const winners = kinds.map(([format, label]) => ({ label, places: rows.filter((r) => r.format === format).map((r) => ({
      rank: Number(r.rank), name: [r.salutation, r.full_name || r.author_name].filter(Boolean).join(' '), institution: r.institution || '', title: r.title,
    })) })).filter((k) => k.places.length);

    // What each day held, in the past tense.
    const parliament = pick(/student parliament/i);
    const plenary = pick(/plenary/i);
    const day2 = [
      'Scientific sessions, oral papers and e-posters across the halls',
      parliament ? parliament.title : null,
      plenary ? `Plenary panel: ${plenary.title}` : null,
      pick(/award/i) ? 'Award paper presentations' : null,
    ].filter(Boolean);
    const C = d.CONFERENCE;
    return {
      stats, winners,
      days: [
        { kicker: `Day 1 · ${dayLong(C.startDate)}`, title: 'Workshops and field visits',
          text: `${workshops ? `${workshops} hands-on workshops` : 'Hands-on workshops'}, and quality improvement in practice at sites around Sevagram.`, link: 'workshops', linkText: 'All workshops' },
        { kicker: `Day 2 · ${dayLong(C.endDate)}`, title: 'The scientific programme', list: day2, link: 'programme', linkText: 'Full programme' },
      ],
    };
  }

  function abstractState() {
    const deadline = d.CONFERENCE.abstractDeadline;
    return { deadline, deadlineText: deadline ? dateLong(deadline) : '', open: d.abstractSubmissionOpen() };
  }

  async function render(req, res, next, key, ctx) {
    try {
      req.siteBase = ctx.base;
      const data = await builders[key](req);
      res.set('Cache-Control', 'public, max-age=60');
      res.render(`website/${key || 'home'}`, { ...(await common({ ...ctx, path: key ? `/${key}` : '/' })), page: key, ...data });
    } catch (err) {
      next(err);
    }
  }
  async function notFound(req, res, next, ctx) {
    try {
      res.status(404).render('website/notfound', { ...(await common({ ...ctx, path: req.path })), page: 'notfound' });
    } catch (err) {
      next(err);
    }
  }

  // On the website's own address, at its root. Everything else there --
  // /portal, /admin, /api, /help, the portal's files -- is the portal's, and
  // falls through to its routes.
  const siteCtx = { base: '', portal: '/portal' };
  if (host) {
    app.use((req, res, next) => {
      if (hostOf(req) !== host || (req.method !== 'GET' && req.method !== 'HEAD')) return next();
      const p = req.path;
      const query = req.originalUrl.slice(req.path.length);
      // A hall's QR code (/?hall=...) is the portal's attendance.
      if (p === '/' && req.query.hall) return res.redirect(302, `/portal${query}`);
      if (p === '/') return render(req, res, next, '', siteCtx);
      if (p === '/programme.pdf') return programmePdf(req, res, next);
      if (p === '/programme-at-a-glance.pdf') return programmeGlancePdf(req, res, next);
      const page = /^\/([a-z-]+)\/?$/.exec(p);
      if (page && PAGES.has(page[1])) return render(req, res, next, page[1], siteCtx);
      // Old /website links, on this address: the same page at the root.
      if (p === '/website' || p.startsWith('/website/')) return res.redirect(301, `${p.replace(/^\/website\/?/, '/')}${query}`);
      const old = OLD_PAGES[p.replace(/^\//, '').toLowerCase()];
      if (old) return res.redirect(301, old);
      return next();
    });
  }

  // On the portal's own address, at /website.
  const atPath = { base: '/website', portal: '/portal' };
  app.get(['/website', '/website/'], (req, res, next) => render(req, res, next, '', atPath));
  app.get('/website/programme.pdf', programmePdf);
  app.get('/website/programme-at-a-glance.pdf', programmeGlancePdf);
  app.get('/website/:page', (req, res, next) => {
    const key = String(req.params.page || '');
    if (PAGES.has(key) && key) return render(req, res, next, key, atPath);
    return notFound(req, res, next, atPath);
  });

  // Mounted last, after every portal route: a page nothing else answered,
  // on the site's own address, is the site's 404.
  return {
    notFound: (req, res, next) => (host && hostOf(req) === host && (req.method === 'GET' || req.method === 'HEAD')
      ? notFound(req, res, next, siteCtx) : next()),
  };
};

// The old address: every request to the same place on the new one. The
// portal's home ('/') is /portal there; a /website page is at the root. A
// GET is a 302 (temporary, so it can be undone); anything else a 307, which
// keeps its method and body.
module.exports.redirectOldHosts = function redirectOldHosts(app, { from = [], to = '' } = {}) {
  const old = new Set(from.map((h) => String(h).toLowerCase()).filter(Boolean));
  if (!to || !old.size) return;
  app.use((req, res, next) => {
    if (!old.has(hostOf(req))) return next();
    const p = req.path;
    const query = req.originalUrl.slice(req.path.length);
    const target = p === '/' ? '/portal'
      : (p === '/website' || p.startsWith('/website/')) ? p.replace(/^\/website\/?/, '/')
        : p;
    res.redirect(req.method === 'GET' || req.method === 'HEAD' ? 302 : 307, `https://${to}${target}${query}`);
  });
};

module.exports.MENU = MENU;
