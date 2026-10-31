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
const { call, check, report, adminLogin, openDb, HOST, PORT } = require('./harness');
const http = require('http');

// A request as if to the website's own address (nqocn2026.mgims.ac.in).
const SITE = 'nqocn2026.mgims.ac.in';
const asHost = (hostName) => (path, method = 'GET') => new Promise((resolve, reject) => {
  const r = http.request({ host: HOST, port: PORT, path, method, headers: { Host: hostName } }, (res) => {
    let raw = ''; res.on('data', (c) => { raw += c; }); res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, raw }));
  });
  r.on('error', reject); r.end();
});
const asSite = asHost(SITE);
// The old address, which now sends everything to the site's.
const asOld = asHost('registration.mgims.ac.in');

const N = String(Date.now() % 100000000).padStart(8, '0');

(async () => {
  const admin = await adminLogin();
  const db = openDb();
  let hallId = null;
  let hallId2 = null;
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
    check('...and links Register and Sign in to the portal', pages.every((p) => /class="btn btn-navy register" href="\/portal"/.test(got[p])));
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
    // A second hall that day, so there is something to filter between.
    hallId2 = (await call('POST', '/api/admin/programme/halls', { name: `Site Hall B ${N}` }, admin)).body.id;
    const s1b = await call('POST', '/api/admin/programme/sessions', { hallId: hallId2, date: '2026-11-22', counts: false, start: '17:10', end: '17:30', label: 'Session 98', title: `Other hall talk ${N}` }, admin);
    sessions.push(s1b.body.id);
    const prog = (await call('GET', '/website/programme?day=2026-11-22', null, null)).raw || '';
    check('it is on the programme page, with its speaker and chair', prog.includes(`Website talk ${N}`) && prog.includes(`Dr Web Speaker ${N}`) && prog.includes(`Chairs: Dr Web Chair ${N}`));
    check('...escaped, never run', !prog.includes('<script>alert(1)</script>') && prog.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    check('...in time, as "5:10 PM"', prog.includes('5:10'));
    const byHall = (await call('GET', `/website/programme?day=2026-11-22&hall=${encodeURIComponent(`Site Hall ${N}`)}`, null, null)).raw || '';
    check('the hall filter is a drop-down: day kept, All halls first', /<form class="hall-filter" method="get" action="\/website\/programme">/.test(byHall)
      && /<input type="hidden" name="day" value="2026-11-22">/.test(byHall) && /<select id="hall-select" name="hall" class="chosen">\s*<option value="">All halls \(\d+\)<\/option>/.test(byHall)
      && !/class="pills"/.test(byHall));
    check('choosing its hall shows it, not the other hall\'s', byHall.includes(`Website talk ${N}`) && !byHall.includes(`Other hall talk ${N}`) && new RegExp(`<option value="Site Hall ${N}" selected>Site Hall ${N}</option>`).test(byHall));
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

    console.log('\n== On its own address, at the root ==');
    const home = await asSite('/');
    check('nqocn2026.mgims.ac.in/ is the website home', home.status === 200 && /Two days at Sevagram/.test(home.raw), home.status);
    check('...its links are at the root', /href="\/programme"/.test(home.raw) && !/href="\/website\/(programme|workshops|registration|abstracts|faculty|team|visit|about)/.test(home.raw));
    check('...its images and stylesheet still load', /src="\/website\/img\/nqocn-mgims-logo\.png"/.test(home.raw) && /href="\/website\/site\.css/.test(home.raw));
    check('...PCI India among the partners, its logo served', /<img src="\/website\/img\/partners\/pci-india-logo\.png" alt="PCI India"/.test(home.raw)
      && (await call('GET', '/website/img/partners/pci-india-logo.png', null, null)).status === 200);
    {
      const { PNG } = require(require('./harness').appFile('node_modules', 'pngjs'));
      const pci = PNG.sync.read(require('fs').readFileSync(require('./harness').appFile('public', 'website', 'img', 'partners', 'pci-india-logo.png')));
      check('...on a transparent background (drawn from their SVG)', pci.data[3] === 0 && pci.data[(pci.width * pci.height - 1) * 4 + 3] === 0 && pci.width > 800);
    }
    check('...Register and Sign in go to the portal, at /portal', /class="btn btn-navy register" href="\/portal"/.test(home.raw));
    check('...and it names itself as the address to list', /<link rel="canonical" href="https:\/\/nqocn2026\.mgims\.ac\.in\/">/.test(home.raw));
    const fac = await asSite('/faculty');
    check('the faculty page lists Dr Peter Lachman, no longer Dr Katherine Semrau', fac.raw.includes('Dr Peter Lachman') && !/Semrau/.test(fac.raw));
    check('every page opens there', (await Promise.all(['/programme', '/workshops', '/registration', '/abstracts', '/sample-abstract', '/faculty', '/team', '/visit', '/about'].map((x) => asSite(x)))).every((r) => r.status === 200));
    const old = await asSite('/website/programme?day=2026-11-22');
    check('an old /website link there moves to the root', old.status === 301 && old.location === '/programme?day=2026-11-22', [old.status, old.location]);
    const aspx = await asSite('/Abstarct_Instructions.aspx');
    check('the earlier site\'s pages move to their new ones', aspx.status === 301 && aspx.location === '/abstracts'
      && (await asSite('/ScientificProgrammeDay2.aspx')).location === '/programme?day=2026-11-22', aspx.location);
    const qr = await asSite('/?hall=ABCD2345');
    check('a hall QR link opens the portal there, at /portal', qr.status === 302 && qr.location === '/portal?hall=ABCD2345', qr.location);
    const portal = await asSite('/portal');
    check('the portal is at /portal', portal.status === 200 && /app\.js\?v=/.test(portal.raw) && !/Two days at Sevagram/.test(portal.raw));
    check('.../portal/ drops the slash (the page\'s files are relative)', (await asSite('/portal/?x=1')).location === '/portal?x=1');
    const adm = await asSite('/admin');
    check('/admin is served there; signed out, it sends you to /portal', adm.status === 302 && adm.location === '/portal', adm.location);
    check('the API is served there', (await asSite('/api/conference')).status === 200);
    check('the group-registration help is served there', (await asSite('/help/group-registration')).status === 200);
    check('an unknown page there is the site\'s 404', (await asSite('/no-such-page')).status === 404 && /Page not found/.test((await asSite('/no-such-page')).raw));
    check('elsewhere (an IP, localhost) / is still the portal', !/Two days at Sevagram/.test((await call('GET', '/', null, null)).raw || ''));

    console.log('\n== The old address sends everything to the new one ==');
    const o1 = await asOld('/');
    check('registration.mgims.ac.in/ goes to the portal on the new address', o1.status === 302 && o1.location === 'https://nqocn2026.mgims.ac.in/portal', o1.location);
    check('...a hall QR link keeps its code', (await asOld('/?hall=ABCD2345')).location === 'https://nqocn2026.mgims.ac.in/portal?hall=ABCD2345');
    check('...a /website page goes to the same page at the root', (await asOld('/website/programme?day=2026-11-22')).location === 'https://nqocn2026.mgims.ac.in/programme?day=2026-11-22');
    check('.../admin, an email\'s verify link and the help page keep their path', (await asOld('/admin')).location === 'https://nqocn2026.mgims.ac.in/admin'
      && (await asOld('/verify/abc123')).location === 'https://nqocn2026.mgims.ac.in/verify/abc123'
      && (await asOld('/help/group-registration')).location === 'https://nqocn2026.mgims.ac.in/help/group-registration');
    check('...files too', (await asOld('/app.js?v=1')).location === 'https://nqocn2026.mgims.ac.in/app.js?v=1');
    const post = await asOld('/api/auth/login', 'POST');
    check('...and a POST keeps its method (307)', post.status === 307 && post.location === 'https://nqocn2026.mgims.ac.in/api/auth/login', [post.status, post.location]);

    console.log('\n== Nothing private ==');
    const all = Object.values(got).join('\n');
    const emails = all.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
    check('no email address on any page but the conference\'s own', emails.every((e) => e === 'nqocn2026@mgims.ac.in') && emails.length > 0, [...new Set(emails)].slice(0, 3));
    const mobiles = all.match(/(?<![\d+])[6-9]\d{9}(?!\d)/g) || [];
    check('no bare mobile number on any page', mobiles.length === 0, mobiles.slice(0, 3));
    check('no hall code (the QR secret) is sent', !/\?hall=[A-Z0-9]{8}\b/.test(all));
    check('the campus map stays in the delegate portal, not on the site', !/campus-map|leaflet/i.test(got.visit) && /Directions to MGIMS/.test(got.visit));
  } finally {
    for (const id of sessions.filter(Boolean)) await db.run('DELETE FROM programme_sessions WHERE id = ?', [id]);
    if (hallId) await db.run('DELETE FROM halls WHERE id = ?', [hallId]);
    if (hallId2) await db.run('DELETE FROM halls WHERE id = ?', [hallId2]);
  }
  console.log('\n== Signed in to the portal: their button, not Sign in and Register ==');
  {
    const out = await call('GET', '/api/auth/whoami');
    check('signed out: says so, and is never cached', out.status === 200 && out.body && out.body.signedIn === false && /no-store/.test(out.headers['cache-control'] || ''));
    const cookie = await adminLogin();
    const me = await call('GET', '/api/auth/whoami', null, cookie);
    check('signed in: their name, and nothing more', me.body && me.body.signedIn === true && typeof me.body.name === 'string' && me.body.name.length > 0
      && Object.keys(me.body).sort().join() === 'name,signedIn');
    const home = await asSite('/');
    check('the header has the button, swapped in by the browser (the page itself stays the same for everyone)',
      /<a class="me" id="site-me" href="\/portal" aria-label="Your delegate portal">/.test(home.raw) && /fetch\('\/api\/auth\/whoami'/.test(home.raw)
      && /class="signin" href="\/portal">Sign in<\/a>/.test(home.raw));
    const siteCss = require('fs').readFileSync(require('./harness').appFile('public', 'website', 'site.css'), 'utf8');
    check('...which hides Sign in and Register once signed in', /\.signed-in \.me \{ display: inline-flex; \}/.test(siteCss) && /\.signed-in \.signin, \.signed-in \.register \{ display: none; \}/.test(siteCss));
  }
  db.close();
  report();
})();
