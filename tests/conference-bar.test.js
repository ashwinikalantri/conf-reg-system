// One menu for the website, the delegate portal and the admin panel (approved
// from the "NQOCN Menus" canvas, 31 Oct 2026): the website's header is the
// pattern -- the logo, links in navy, the page you are on and an open
// drop-down in pale gold with no underline, drop-downs like the website's,
// the account on the right where the website has Sign in. The portal wears it
// as #dash-bar (partials/topbar.ejs), the admin panel as #admin-bar, whose
// menus are one ☰ panel below 1200px.
const { check, report, appFile } = require('./harness');
const fs = require('fs');
const vm = require('vm');
const read = (...p) => fs.readFileSync(appFile(...p), 'utf8');

const css = read('public', 'styles.css');
const siteCss = read('public', 'website', 'site.css');
const siteHead = read('views', 'website', 'partials', 'head.ejs');
const topbar = read('views', 'portal', 'partials', 'topbar.ejs');
const index = read('views', 'index.ejs');
const header = read('views', 'admin', 'partials', 'header.ejs');
const admin = read('views', 'admin.ejs');
const server = read('server.js');
const js = read('public', 'app.js');

console.log('\n== The website ==');
check('the page you are on: pale gold, bold, no gold underline',
  /\.nav \.top\[aria-current="page"\], \.dd summary\.here \{ background: var\(--gold-50\); font-weight: 700; \}/.test(siteCss) && !/inset 0 -3px 0 var\(--gold\)/.test(siteCss));
check('its phone menu ends as the others do: Go to, the delegate portal', /<p class="menu-group">Go to<\/p>\s*<a class="menu-go" href="<%= portal %>">Delegate portal<span>Sign in<\/span><\/a>\s*<\/nav>/.test(siteHead));

console.log('\n== The same look in the portal and the admin panel ==');
check('one stylesheet for the bar: white, the logo, a gold tag', /\.cbar \{ background: #fff; border-bottom: 1px solid #e3e7eb;/.test(css) && /\.cbar-place \{[^}]*color: #8a6d2b;/.test(css));
check('the page you are on and an open drop-down in pale gold, no underline',
  /\.cbar-link\[aria-expanded="true"\], \.cbar-link\[aria-current="page"\] \{ background: #faf5e8; \}/.test(css) && !/\.cbar[^{]*\{[^}]*inset 0 -/.test(css));
check('drop-down items as the website\'s: a name and a line on it', /\.cbar-item b \{/.test(css) && /\.cbar-item > span \{ font-size: 14px;/.test(css));
check('a rule here that sets display yields to .hidden', /\.cbar-link\.hidden, \.cbar-item\.hidden, \.cbar-group\.hidden \{ display: none; \}/.test(css));
check('the logo links to the website, by its own address', [topbar, header].every((h) => /<a href="<%= locals\.websiteUrl \|\| '\/' %>" class="shrink-0" aria-label="The conference website"><img class="cbar-logo" src="\/website\/img\/nqocn-mgims-logo\.png"/.test(h))
  && (server.match(/websiteUrl: `https:\/\/\$\{WEBSITE_HOST\}\/`/g) || []).length === 2);

console.log('\n== The delegate portal ==');
check('one bar, above sign-in and the pages, hidden until a delegate page opens', /<%- include\('portal\/partials\/topbar'\) %>\s*<!-- Sign in:/.test(index) && /<header id="dash-bar" class="cbar hidden /.test(topbar));
check('a gold "Delegate" tag, then Home, Programme, Map, Badge', /<span class="cbar-place">Delegate<\/span>/.test(topbar)
  && ['home', 'programme', 'map', 'badge'].every((t) => new RegExp(`data-tab="${t}"[^>]*class="dash-nav-link cbar-link`).test(topbar)));
check('the account on the right: initials, the name from a laptop up', /id="dash-menu-btn"[^>]*class="cbar-me"/.test(topbar) && /id="dash-me-initials"/.test(topbar) && /id="dash-me-name" class="hidden lg:inline/.test(topbar));
check('its menu: Profile, Change password, Admin panel (staff), the website, then Log out',
  /id="dash-menu" class="hidden cbar-panel">[\s\S]*?dashGo\('profile'\)[\s\S]*?openSetPasswordModal\(false\)[\s\S]*?id="admin-nav-btn" href="\/admin" class="cbar-item hidden"[\s\S]*?Conference website[\s\S]*?onclick="logout\(\)"/.test(topbar));
check('the Admin panel item shows on every delegate page for an admin, not only Home',
  /updateAdminNav\(Object\.prototype\.hasOwnProperty\.call\(DASH_TAB_OF_PAGE, pageId\) && isAdminUser\(\)\)/.test(js));

console.log('\n== The admin panel ==');
check('the bar replaces the navy title card; the desks are in it, not under it', /<header id="admin-bar" class="cbar /.test(header) && !/include\('admin\/partials\/nav-tabs'\)/.test(admin));
check('the full-bleed bar undoes the page\'s padding', /class="cbar -mx-4 -mt-4 sm:-mx-8 sm:-mt-8 mb-6"/.test(header) && /<body class="[^"]*p-4 sm:p-8/.test(admin));
check('each Settings item says what it is', (header.match(/class="cbar-item"><b>[^<]+(<span[^>]*>0<\/span>)?<\/b><span>[^<]+<\/span><\/button>/g) || []).length === 11);
check('desks inline and drop-downs from 1200px; one ☰ panel below', /#admin-menu \{ display: none; position: absolute;/.test(css) && /#admin-menu\.open \{ display: flex; \}/.test(css)
  && /@media \(min-width: 1200px\) \{\s*#admin-menu-btn \{ display: none; \}/.test(css));

// The admin menus' script, on its own: the drop-downs open one at a time,
// a desk closes them, Escape closes and hands focus back.
{
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) {
      const s = new Set();
      const attrs = {};
      els.set(id, { id, focused: false, classList: { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c),
        toggle: (c, on) => { const w = on === undefined ? !s.has(c) : !!on; if (w) s.add(c); else s.delete(c); return w; } },
      setAttribute: (k, v) => { attrs[k] = String(v); }, getAttribute: (k) => attrs[k] ?? null, contains: () => false, focus() { this.focused = true; } });
    }
    return els.get(id);
  };
  const handlers = {};
  const sb = { document: { getElementById: el, addEventListener: (t, f) => { (handlers[t] = handlers[t] || []).push(f); } } };
  vm.createContext(sb);
  const start = js.indexOf('const ADMIN_MENUS');
  const end = js.indexOf('// Settings sub-menu tabs (each is now its own');
  vm.runInContext(`${js.slice(start, end)}\nglobalThis.__f = { toggleSettingsMenu, toggleAdminMeMenu, toggleAdminMenu, closeAdminMenus };`, sb);
  const f = sb.__f;
  const open = (id) => el(id).classList.contains('open');
  f.toggleSettingsMenu();
  check('Settings opens, and its button says so', open('settings-menu') && el('settings-menu-btn').getAttribute('aria-expanded') === 'true');
  f.toggleAdminMeMenu();
  check('...the account opening closes it: one at a time', open('admin-me-menu') && !open('settings-menu') && el('settings-menu-btn').getAttribute('aria-expanded') === 'false');
  f.toggleAdminMeMenu();
  check('...a second tap closes it', !open('admin-me-menu'));
  f.toggleAdminMenu();
  handlers.keydown.forEach((h) => h({ key: 'Escape' }));
  check('Escape closes the ☰ panel and hands focus back to ☰', !open('admin-menu') && el('admin-menu-btn').focused);
  f.toggleSettingsMenu();
  handlers.click.forEach((h) => h({ target: {} }));
  check('a click outside closes it', !open('settings-menu'));
}
check('opening a desk or a Settings screen closes the menus', /settingsBtn\.setAttribute\('aria-current', SETTINGS_TABS\.includes\(tab\) \? 'page' : 'false'\);\s*closeAdminMenus\(\);/.test(js)
  && /function selectSettingsTab\(tab\) \{\s*switchBackendTab\(tab\);\s*closeAdminMenus\(\);/.test(js));

// Initials for the account button.
{
  const sb = {};
  vm.createContext(sb);
  const src = js.slice(js.indexOf('function nameInitials'), js.indexOf('// Who is signed in, on the bar'));
  vm.runInContext(`${src}\nglobalThis.f = nameInitials;`, sb);
  check('initials: first and last name, the title left off', sb.f('Dr Asha Rao') === 'AR' && sb.f('Prof. Vikram Kumar Datta') === 'VD' && sb.f('Meena') === 'M' && sb.f('') === '', [sb.f('Dr Asha Rao'), sb.f('Prof. Vikram Kumar Datta')]);
}
report();
