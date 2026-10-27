// The admin panel and the login page wear the delegate page's theme: the
// same colours (two copies of the Tailwind config, which must not drift),
// and the same navy header with a gold kicker.
const { check, report, appFile } = require('./harness');
const fs = require('fs');

const read = (...p) => fs.readFileSync(appFile(...p), 'utf8');
const colours = (src) => (src.match(/colors: \{[\s\S]*?\n {10}\},/) || [''])[0].replace(/\s*\/\/.*$/gm, '').replace(/\s+/g, ' ');

const portal = read('views', 'index.ejs');
const admin = read('views', 'admin.ejs');
check('the admin page has the conference navy and gold', /navy: '#1c3549'/.test(admin) && /gold: \{ 50: '#faf5e8'/.test(admin));
check('...the same colours as the delegate page, value for value', colours(portal) && colours(portal) === colours(admin), [colours(portal), colours(admin)]);

const header = read('views', 'admin', 'partials', 'header.ejs');
check('the admin header is the delegate page\'s navy bar, gold kicker, white title',
  /<header class="[^"]*bg-navy text-white/.test(header) && /text-gold-300">Admin Panel/.test(header) && /id="conf-name-h1" class="skeleton[^"]*text-white/.test(header));
check('...with no white buttons left on it', !/bg-white hover:bg-slate-50/.test(header.split('id="settings-menu"')[0]));
check('the header has one control, the delegate page\'s menu button; the delegate portal is its first item',
  (header.split('id="settings-menu"')[0].match(/<(a|button)\b/g) || []).length === 1
  && /id="settings-menu-btn"[^>]*class="w-10 h-10 rounded-lg border border-white\/25 hover:bg-white\/10/.test(header)
  && /id="settings-menu"[^>]*>\s*<a id="admin-menu-portal" href="\/"[\s\S]*?Delegate portal/.test(header));
check('Settings is a menu button (☰), and Log out is the last item in the menu',
  /id="settings-menu-btn"[^>]*aria-label="Menu"/.test(header) && !/> Settings <span/.test(header)
  && /id="admin-logout-item" onclick="logout\(\)"[\s\S]*?<\/button>\s*<\/div>\s*<\/div>\s*<\/div>\s*<\/header>/.test(header)
  && (header.match(/onclick="logout\(\)"/g) || []).length === 1);

const hero = read('views', 'portal', 'partials', 'hero.ejs');
check('the login page\'s conference title is the same navy header, dates in gold',
  /id="portal-hero" class="[^"]*bg-navy text-white/.test(hero) && /id="conf-date-badge" class="[^"]*text-gold-300/.test(hero));

const js = read('public', 'app.js');
check('the open tab: navy, underlined in gold', /btn\.classList\.toggle\('text-navy', active\)/.test(js) && /btn\.classList\.toggle\('border-gold-500', active\)/.test(js));
const menu = header.split('id="settings-menu"')[1] || '';
const order = ['admin-menu-portal', 'settings-group-conference', 'settings-item-programme', 'settings-item-programs', 'settings-item-attendance',
  'settings-group-fees', 'settings-item-fees', 'settings-item-discount', 'settings-item-groupdiscount',
  'settings-group-messages', 'settings-item-reminders',
  'settings-group-system', 'settings-item-general', 'settings-item-users', 'settings-item-roles', 'settings-item-activity', 'admin-logout-item'];
check('the menu: Delegate portal, the four groups in order, Log out last', order.every((id, i) => i === 0 || menu.indexOf(`id="${id}"`) > menu.indexOf(`id="${order[i - 1]}"`)) && menu.indexOf('id="admin-menu-portal"') >= 0);
check('...with Workshops and Conference setup as the names', />Workshops<\/span>/.test(menu) && />Conference setup<\/span>/.test(menu) && !/Program Groups|>General</.test(menu));
check('a placeholder on navy shimmers in white', /\.bg-navy \.skeleton \{/.test(read('public', 'styles.css')));
report();
