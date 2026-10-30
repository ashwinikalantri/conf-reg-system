// The public conference website, at /website.
//
// What must hold:
//   * every page opens without signing in, with the menu, and the footer's
//     copyright is MGIMS, Sevagram's;
//   * what the portal knows is live: a session added to the programme shows
//     on the programme page (filterable by day and hall), fee categories on
//     the fees table, workshops with their seats left;
//   * the abstract guidelines page carries the guidelines and the sample PDF;
//   * nothing typed by an admin is sent unescaped, and nothing private is
//     shown: no email address, no mobile number;
//   * an unknown page is a 404, in the site's own look.
const { call, check, report, adminLogin, openDb } = require('./harness');

const N = String(Date.now() % 100000000).padStart(8, '0');

(async () => {
  const admin = await adminLogin();
  const db = openDb();
  let hallId = null;
  const sessions = [];
  try {
    console.log('\n== Every page, signed out ==');
    const pages = ['', 'programme', 'workshops', 'registration', 'abstracts', 'faculty', 'team', 'visit', 'about'];
    const got = {};
    for (const p of pages) {
      const r = await call('GET', `/website${p ? `/${p}` : ''}`, null, null);
      got[p] = r.raw || '';
      check(`/website/${p} opens without signing in`, r.status === 200, r.status);
    }
    check('every page has the menu and the MGIMS copyright', pages.every((p) => /href="\/website\/programme"/.test(got[p]) && /© Mahatma Gandhi Institute of Medical Sciences, Sevagram/.test(got[p])));
    check('...and links Register and Sign in to the portal', pages.every((p) => /class="btn btn-navy" href="\/"/.test(got[p])));
    const groups = [...got[''].matchAll(/<details class="dd">\s*<summary[^>]*>([A-Za-z ]+)</g)].map((m) => m[1].trim());
    check('the menu is three groups and two links', JSON.stringify(groups) === JSON.stringify(['Programme', 'Registration', 'People'])
      && /class="top" href="\/website\/visit"/.test(got['']) && /class="top" href="\/website\/about"/.test(got['']), groups);
    check('...each group holding its pages', /<details class="dd">[\s\S]*?href="\/website\/workshops"[\s\S]*?<\/details>/.test(got['']) && /href="\/website\/faculty"[\s\S]*?href="\/website\/team"/.test(got['']));
    check('the group of the page you are on is marked', /<summary class="here">Programme/.test(got.workshops) && /<summary class="here">People/.test(got.team));
    check('on a phone the same pages, under group headings', /<p class="menu-group">Registration<\/p>/.test(got['']));
    check('the stylesheet, logo and a team photo are served', (await call('GET', '/website/site.css', null, null)).status === 200
      && (await call('GET', '/website/img/nqocn-mgims-logo.png', null, null)).status === 200
      && (await call('GET', '/website/img/people/dr-vikram-datta.png', null, null)).status === 200);
    const nf = await call('GET', '/website/no-such-page', null, null);
    check('an unknown page is a 404 in the site\'s look', nf.status === 404 && /Page not found/.test(nf.raw || '') && /site\.css/.test(nf.raw || ''));

    console.log('\n== Live from the portal ==');
    hallId = (await call('POST', '/api/admin/programme/halls', { name: `Site Hall ${N}` }, admin)).body.id;
    const add = (b) => call('POST', '/api/admin/programme/sessions', { hallId, date: '2026-11-22', counts: false, ...b }, admin);
    const s1 = await add({ start: '17:10', end: '17:30', label: 'Session 99', title: `Website talk ${N} <script>alert(1)</script>`, speakers: `Dr Web Speaker ${N}`, chairs: `Dr Web Chair ${N}` });
    sessions.push(s1.body.id);
    check('fixture: a session in a new hall', s1.body.success === true, s1.body);
    const prog = (await call('GET', '/website/programme?day=2026-11-22', null, null)).raw || '';
    check('it is on the programme page, with its speaker and chair', prog.includes(`Website talk ${N}`) && prog.includes(`Dr Web Speaker ${N}`) && prog.includes(`Chairs: Dr Web Chair ${N}`));
    check('...escaped, never run', !prog.includes('<script>alert(1)</script>') && prog.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    check('...in time, as "5:10 PM"', prog.includes('5:10'));
    const byHall = (await call('GET', `/website/programme?day=2026-11-22&hall=${encodeURIComponent(`Site Hall ${N}`)}`, null, null)).raw || '';
    check('choosing its hall shows it', byHall.includes(`Website talk ${N}`) && /aria-current="true">Site Hall/.test(byHall));
    const s2 = await add({ date: '2026-11-21', start: '10:00', end: '11:00', label: 'Workshop 99', title: `Saturday item ${N}` });
    sessions.push(s2.body.id);
    const otherDay = (await call('GET', '/website/programme?day=2026-11-21', null, null)).raw || '';
    check('another day shows its own sessions, not this one', otherDay.includes(`Saturday item ${N}`) && !otherDay.includes(`Website talk ${N}`));

    const cats = await db.all('SELECT label FROM fee_categories WHERE active = 1');
    check('every active fee category is on the fees table', cats.length > 0 && cats.every((c) => got.registration.includes(c.label.replace(/&/g, '&amp;'))), cats.map((c) => c.label));
    check('the fee that applies today is marked', /class="now"/.test(got.registration));
    const opt = await db.get(`SELECT o.name FROM program_options o JOIN program_groups g ON g.id = o.group_id WHERE o.active = 1 AND g.active = 1 AND COALESCE(g.invite_only, 0) = 0 LIMIT 1`);
    if (opt) check('a workshop is listed, with its seats', got.workshops.includes(opt.name.replace(/&/g, '&amp;')) && /seats left|Full/.test(got.workshops), opt.name);

    console.log('\n== Abstract guidelines ==');
    check('the guidelines are there', /Only registered delegates may submit/.test(got.abstracts) && /NQOCN Gold Medal/.test(got.abstracts) && /400 words/.test(got.abstracts));
    check('the PDF is gone; the sample is a page', (await call('GET', '/website/docs/sample-abstract.pdf', null, null)).status === 404);
    check('the registration page links to them', got.registration.includes('href="/website/abstracts"'));
    const sample = await call('GET', '/website/sample-abstract', null, null);
    check('the sample abstract is a page of its own', sample.status === 200 && /Kangaroo Mother Care/.test(sample.raw || '')
      && ['Background', 'Aim statement', 'Methods', 'Results', 'Conclusions'].every((h) => (sample.raw || '').includes(`<h3>${h}</h3>`)));
    check('...linked from the guidelines, with no PDF', got.abstracts.includes('href="/website/sample-abstract"') && !/\.pdf/.test(got.abstracts));
    check('...in the menu under Registration', /href="\/website\/sample-abstract" aria-current="page"/.test(sample.raw || '') && /<summary class="here">Registration/.test(sample.raw || ''));

    console.log('\n== Nothing private ==');
    const all = Object.values(got).join('\n');
    const emails = all.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
    check('no email address on any page (none is set to show)', emails.length === 0, emails.slice(0, 3));
    const mobiles = all.match(/(?<![\d+])[6-9]\d{9}(?!\d)/g) || [];
    check('no bare mobile number on any page', mobiles.length === 0, mobiles.slice(0, 3));
    check('no hall code (the QR secret) is sent', !/\?hall=[A-Z0-9]{8}\b/.test(all));
    check('the campus map stays in the delegate portal, not on the site', !/campus-map|leaflet/i.test(got.visit) && /Directions to MGIMS/.test(got.visit));
  } finally {
    for (const id of sessions.filter(Boolean)) await db.run('DELETE FROM programme_sessions WHERE id = ?', [id]);
    if (hallId) await db.run('DELETE FROM halls WHERE id = ?', [hallId]);
  }
  db.close();
  report();
})();
