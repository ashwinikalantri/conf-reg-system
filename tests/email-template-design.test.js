// The email chrome had fallen a redesign behind: months after the portal and
// admin panel moved to the steel-blue "Clinical Trust" ramp, every outgoing
// email still went out in the old Tailwind indigo (#312e81 / #c7d2fe). It
// had also been copy-pasted -- one definition in server.js, a second,
// byte-identical one in scripts/daily-digest.js -- which is how half the
// mail could have been restyled and the other half missed.
//
// Both now import email-template.js. These checks are about the two things
// that let it rot: that there is exactly ONE definition, and that the
// palette it uses is the app's, not a stale copy of it.
const { check, report, appFile } = require('./harness');
const fs = require('fs');
const path = require('path');

const serverSrc = fs.readFileSync(appFile('server.js'), 'utf8');
const digestSrc = fs.readFileSync(appFile('scripts', 'daily-digest.js'), 'utf8');
const tplSrc = fs.readFileSync(appFile('email-template.js'), 'utf8');
const { emailWrap, STEEL } = require(path.join(__dirname, '..', 'email-template'));

const CONF = { name: 'ICHQPS 2026', acronym: 'NQOCN 2026', location: 'MGIMS, Sevagram' };
const html = emailWrap('Your registration is confirmed', '<p>Dear Dr Test,</p>', CONF);

console.log('\n== The palette is the app\'s, taken from the portal\'s tailwind config ==');
// views/index.ejs remaps Tailwind's `indigo` onto this ramp; the email has
// to be the same colour as the page it links to.
const portalCfg = fs.readFileSync(appFile('views', 'index.ejs'), 'utf8');
check('the steel ramp matches the portal config exactly',
  Object.entries(STEEL).every(([k, v]) => new RegExp(`${k}: '${v}'`).test(portalCfg)),
  JSON.stringify(STEEL));
check('the rendered header uses a steel tone', html.includes(STEEL[800]), html.slice(0, 200));
check('the eyebrow uses a steel tone', html.includes(STEEL[200]));

console.log('\n== No pre-redesign Tailwind indigo survives in anything that renders ==');
// The full default ramp, so a later paste of any shade is caught, not just
// the two the old template happened to use.
const OLD_INDIGO = ['#e0e7ff', '#c7d2fe', '#a5b4fc', '#818cf8', '#6366f1',
  '#4f46e5', '#4338ca', '#3730a3', '#312e81', '#1e1b4b', '#eef2ff'];
// Comments are stripped first: this is about what RENDERS, and naming the
// old colour in a note explaining why it changed is exactly the kind of
// comment worth keeping.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
for (const [name, src] of [['email-template.js', tplSrc], ['server.js', serverSrc], ['daily-digest.js', digestSrc]]) {
  const found = OLD_INDIGO.filter((hex) => code(src).toLowerCase().includes(hex));
  check(`${name} carries none of the old indigo ramp`, found.length === 0, found.join(' '));
}

console.log('\n== There is one definition, not two ==');
// The literal that both copies opened with. Its absence is what proves the
// duplicate is gone rather than merely recoloured.
const OLD_OPENING = "max-width:560px;margin:0 auto;color:#0f172a";
check('server.js no longer defines its own chrome',
  !serverSrc.includes(`<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;${OLD_OPENING}`));
check('daily-digest.js no longer defines its own chrome',
  !digestSrc.includes(`<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;${OLD_OPENING}`));
check('server.js imports the shared template', /require\('\.\/email-template'\)/.test(serverSrc));
check('daily-digest.js imports the shared template', /require\(path\.join\(APP_DIR, 'email-template'\)\)/.test(digestSrc));
check('only one file builds the chrome',
  (tplSrc.match(/border-radius:12px 12px 0 0/g) || []).length === 1
  && !serverSrc.includes('border-radius:12px 12px 0 0')
  && !digestSrc.includes('border-radius:12px 12px 0 0'));

console.log('\n== The wrapper still behaves as its ~20 callers expect ==');
check('the body is placed inside the card', html.includes('<p>Dear Dr Test,</p>'));
check('the title is rendered', html.includes('Your registration is confirmed'));
check('the conference name is rendered', html.includes('ICHQPS 2026'));
check('the eyebrow joins acronym and location', html.includes('NQOCN 2026 · MGIMS, Sevagram'));
check('the automated-message footer survives', html.includes('This is an automated message'));
check('it is still a fragment, not a document (what SES has always been sent)',
  !/^\s*<!doctype/i.test(html) && !html.includes('<html'), html.slice(0, 60));

console.log('\n== Every style is inline, since Gmail drops stylesheets ==');
check('the chrome contains no <style> block', !/<style/i.test(html));
check('...and no external stylesheet link', !/<link/i.test(html));

console.log('\n== Text reaching the template is escaped ==');
const nasty = emailWrap('<script>alert(1)</script>', '<p>body</p>',
  { name: '<img src=x onerror=alert(1)>', acronym: 'A', location: 'B' });
check('a title cannot inject markup', !nasty.includes('<script>'), nasty.slice(0, 300));
check('a conference name cannot inject markup', !nasty.includes('<img src=x'));

console.log('\n== The standalone pages load the real webface ==');
// Unlike email, these render in a browser, so they can have the actual font
// rather than approximating it.
check('a shared font <link> constant exists', /const PAGE_FONTS =/.test(serverSrc));
check('...pointing at the same two families the portal loads',
  /Libre\+Franklin/.test(serverSrc) && /Source\+Sans\+3/.test(serverSrc));
check('the short notice pages go through one helper now',
  /function noticePage\(/.test(serverSrc));
check('...and none of them is a bare unstyled page any more',
  !/font-family:sans-serif;max-width:32rem/.test(serverSrc)
  && !/font-family:sans-serif;text-align:center/.test(serverSrc));

console.log('\n== Every page that scopes a font by id actually loads that stylesheet ==');
// public/styles.css is what puts Libre Franklin on the headings, scoped by
// id to each page's own containers. Its own comment says it is shared by
// index.ejs and admin.ejs -- but index.ejs never linked it, so the portal
// downloaded the face from Google Fonts on every load and then applied it
// to nothing. Nothing about that is visible in a diff of either file, which
// is why it lasted; the invariant is cheap to state, so state it.
const css = fs.readFileSync(appFile('public', 'styles.css'), 'utf8');
const linksStylesheet = (src) => /<link[^>]+href="styles\.css"/.test(src);
for (const page of ['index.ejs', 'admin.ejs']) {
  const src = fs.readFileSync(appFile('views', page), 'utf8');
  check(`${page} links styles.css`, linksStylesheet(src));
}
check('the heading rule still scopes to the portal containers it names',
  /#dashboard-page h1/.test(css) && /#auth-page h1/.test(css));
check('setup.ejs carries the design tokens too (it loads its own Tailwind)',
  (() => { const s2 = fs.readFileSync(appFile('views', 'setup.ejs'), 'utf8');
    return /tailwind\.config/.test(s2) && s2.includes('#2f5673') && /Libre\+Franklin/.test(s2); })());

report();
