// The admin panel and the login page wear the delegate page's theme: the
// same colours (two copies of the Tailwind config, which must not drift);
// the login page's navy header with a gold kicker; and the admin panel the
// conference bar the website and the delegate's pages wear.
const { check, report, appFile } = require('./harness');
const fs = require('fs');

const read = (...p) => fs.readFileSync(appFile(...p), 'utf8');
const colours = (src) => (src.match(/colors: \{[\s\S]*?\n {10}\},/) || [''])[0].replace(/\s*\/\/.*$/gm, '').replace(/\s+/g, ' ');

const portal = read('views', 'index.ejs');
const admin = read('views', 'admin.ejs');
check('the admin page has the conference navy and gold', /navy: '#1c3549'/.test(admin) && /gold: \{ 50: '#faf5e8'/.test(admin));
check('...the same colours as the delegate page, value for value', colours(portal) && colours(portal) === colours(admin), [colours(portal), colours(admin)]);

const header = read('views', 'admin', 'partials', 'header.ejs');
// 31 Oct 2026: the navy title card gave way to the conference bar, the
// website's header -- logo, a gold "Admin" tag, the desks, Settings as a
// drop-down, the account on the right.
check('the admin header is the conference bar: the logo and a gold "Admin" tag',
  /<header id="admin-bar" class="cbar /.test(header) && /src="\/website\/img\/nqocn-mgims-logo\.png"/.test(header) && /<span class="cbar-place">Admin<\/span>/.test(header)
  && /id="conf-name-h1" class="skeleton sr-only"/.test(header) && !/bg-navy text-white/.test(header));
check('Settings is a drop-down in the bar, as the website\'s are', /id="settings-menu-btn"[^>]*aria-expanded="false" class="cbar-link cbar-drop">Settings <svg/.test(header));
check('the account: the website, the delegate portal, then Log out, last of all',
  /id="admin-me-menu">[\s\S]*?Conference website[\s\S]*?id="admin-menu-portal" href="\/portal"[\s\S]*?id="admin-logout-item" onclick="logout\(\)"/.test(header)
  && header.lastIndexOf('admin-logout-item') > header.lastIndexOf('settings-item-') && (header.match(/onclick="logout\(\)"/g) || []).length === 1);
check('below 1200px, one ☰ panel holds all of it', /id="admin-menu-btn" onclick="toggleAdminMenu\(\)" aria-label="Menu"/.test(header)
  && header.indexOf('id="admin-menu"') < header.indexOf("include('nav-tabs')") && header.indexOf("include('nav-tabs')") < header.indexOf('id="settings-menu"')
  && header.indexOf('id="settings-menu"') < header.indexOf('id="admin-me-menu"'));

const hero = read('views', 'portal', 'partials', 'hero.ejs');
check('the login page\'s conference title is the same navy header, dates in gold',
  /id="portal-hero" class="[^"]*bg-navy text-white/.test(hero) && /id="conf-date-badge" class="[^"]*text-gold-300/.test(hero));

const js = read('public', 'app.js');
check('the open desk: pale gold, no underline (aria-current)', /btn\.setAttribute\('aria-current', active \? 'page' : 'false'\)/.test(js) && !/btn\.classList\.toggle\('border-gold-500'/.test(js)
  && /\.cbar-link\[aria-expanded="true"\], \.cbar-link\[aria-current="page"\] \{ background: #faf5e8; \}/.test(read('public', 'styles.css')));
const menu = header.split('id="settings-menu"')[1] || '';
const order = ['settings-group-conference', 'settings-item-programme', 'settings-item-programs', 'settings-item-attendance',
  'settings-group-fees', 'settings-item-fees', 'settings-item-discount', 'settings-item-groupdiscount',
  'settings-group-messages', 'settings-item-reminders',
  'settings-group-system', 'settings-item-general', 'settings-item-users', 'settings-item-roles', 'settings-item-activity', 'admin-logout-item'];
check('the menu: the four groups in order, then the account, Log out last', order.every((id, i) => i === 0 || menu.indexOf(`id="${id}"`) > menu.indexOf(`id="${order[i - 1]}"`)) && menu.indexOf('id="settings-group-conference"') >= 0);
check('...with Workshops and Conference setup as the names', /<b>Workshops<\/b>/.test(menu) && /<b>Conference setup<\/b>/.test(menu) && !/Program Groups|>General</.test(menu));
check('...and the Workshops screen adds a "workshop group"', />Add workshop group<\/h3>/.test(read('views', 'admin', 'sections', 'programs.ejs')) && !/Program Group/.test(read('views', 'admin', 'sections', 'programs.ejs').split('-->').slice(1).join('')));
check('a placeholder on navy shimmers in white', /\.bg-navy \.skeleton \{/.test(read('public', 'styles.css')));
report();
