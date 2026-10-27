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
check('their name opens their delegate page; no separate Delegate Portal button',
  /<a href="\/" title="Open your delegate page"[^>]*>[\s\S]*?id="active-admin-role-badge"/.test(header) && !/Delegate Portal/.test(header));
check('Settings is a menu button (☰), and Log out is the last item in the menu',
  /id="settings-menu-btn"[^>]*aria-label="Menu"/.test(header) && !/> Settings <span/.test(header)
  && /id="admin-logout-item" onclick="logout\(\)"[\s\S]*?<\/button>\s*<\/div>\s*<\/div>\s*<\/div>\s*<\/header>/.test(header)
  && (header.match(/onclick="logout\(\)"/g) || []).length === 1);

const hero = read('views', 'portal', 'partials', 'hero.ejs');
check('the login page\'s conference title is the same navy header, dates in gold',
  /id="portal-hero" class="[^"]*bg-navy text-white/.test(hero) && /id="conf-date-badge" class="[^"]*text-gold-300/.test(hero));

const js = read('public', 'app.js');
check('the open tab: navy, underlined in gold', /btn\.classList\.toggle\('text-navy', active\)/.test(js) && /btn\.classList\.toggle\('border-gold-500', active\)/.test(js));
check('a placeholder on navy shimmers in white', /\.bg-navy \.skeleton \{/.test(read('public', 'styles.css')));
report();
