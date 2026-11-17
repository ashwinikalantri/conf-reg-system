// Moving between the website, the delegate portal and the admin panel
// (17 Nov 2026, from a critique of the navigation: "it seems unintuitive").
//
// What must hold:
//   * Back stays inside the place you are in. Each page of the portal
//     (/portal, #programme, #map, #profile, #register) and each tab of the
//     admin panel is a step in the browser's history; the page a visit lands
//     on, and anything the app does by itself, takes the place of the current
//     step instead of adding one.
//   * Signing in takes you where you were going. /admin, signed out, sends
//     you to /portal?next=/admin and a fresh sign-in by staff goes on there.
//     The value is read from the address, so only the admin panel is ever
//     followed.
//   * One switcher, in the same place on all three: "Go to" in the account
//     menu. The logo is each place's own home; the places are called the
//     Conference website, the Delegate portal and the Admin panel.
const { check, report, appFile } = require('./harness');
const fs = require('fs');
const vm = require('vm');
const read = (...p) => fs.readFileSync(appFile(...p), 'utf8');

const js = read('public', 'app.js');
const css = read('public', 'styles.css');
const server = read('server.js');
const topbar = read('views', 'portal', 'partials', 'topbar.ejs');
const auth = read('views', 'portal', 'sections', 'auth.ejs');
const header = read('views', 'admin', 'partials', 'header.ejs');
const siteHead = read('views', 'website', 'partials', 'head.ejs');
const between = (from, to) => js.slice(js.indexOf(from), js.indexOf(to));

// A stand-in for the browser's address and history: pushState adds a step,
// replaceState rewrites the current one, and both move window.location.
const browser = (url) => {
  const at = { pathname: '', search: '', hash: '' };
  const go = (u) => {
    const next = new URL(u, `http://x${at.pathname}${at.search}${at.hash}`);
    Object.assign(at, { pathname: next.pathname, search: next.search, hash: next.hash });
  };
  go(url);
  const steps = [url];
  const here = () => `${at.pathname}${at.search}${at.hash}`;
  const history = {
    pushState(a, b, u) { go(u); steps.push(here()); },
    replaceState(a, b, u) { go(u); steps[steps.length - 1] = here(); },
  };
  return { at, history, steps, here };
};

console.log('\n== Signing in on the way to the admin panel ==');
{
  const src = between('const SIGN_IN_NEXT_RE', '// Each page of the delegate portal has an address');
  const capture = (url) => {
    const b = browser(url);
    const sb = { URLSearchParams, window: { location: b.at, history: b.history } };
    vm.runInNewContext(`${src}\nthis.next = signInNext;`, sb);
    return { next: sb.next, at: b.here() };
  };
  check('/portal?next=/admin is kept', capture('/portal?next=%2Fadmin').next === '/admin');
  const tab = capture('/portal?next=%2Fadmin#reports');
  check('...with the tab they had asked for, moved out of the # the portal uses for its own pages',
    tab.next === '/admin#reports' && tab.at === '/portal?next=%2Fadmin%23reports', tab);
  check('...a part of Conference setup too', capture('/portal?next=%2Fadmin%23general%2Fsms').next === '/admin#general/sms');
  const refused = ['https://evil.example/admin', '//evil.example/admin', '/admin/../portal', '/adminx', '/admin?x=1', '/portal', '/admin#<script>', 'javascript:alert(1)', '/\\evil.example', ''];
  check('anything but the admin panel is not followed: another site, another page, a script',
    refused.every((n) => capture(`/portal?next=${encodeURIComponent(n)}`).next === ''), refused.filter((n) => capture(`/portal?next=${encodeURIComponent(n)}`).next !== ''));
  check('...and a # that is not a tab is dropped, the admin panel kept', capture('/portal?next=%2Fadmin#a%20b').next === '/admin');
  check('no next, nothing kept; the address is left alone', capture('/portal#programme').next === '' && capture('/portal#programme').at === '/portal#programme');

  const follow = between('function followSignInNext()', '// OTP vs password is a login-flow choice');
  const signIn = (next, isAdmin) => {
    const b = browser('/portal?next=%2Fadmin');
    const out = { went: null, toast: null };
    const sb = {
      window: { location: Object.assign(b.at, { replace: (u) => { out.went = u; } }) },
      isAdminUser: () => isAdmin,
      writeAddress: (u, push) => (push ? b.history.pushState : b.history.replaceState)(null, '', u),
      showToast: (m) => { out.toast = m; },
    };
    vm.runInNewContext(`let signInNext = ${JSON.stringify(next)};\n${follow}\nthis.result = followSignInNext(); this.left = signInNext;`, sb);
    return { ...out, result: sb.result, left: sb.left, at: b.here(), steps: b.steps.length };
  };
  const staff = signIn('/admin#reports', true);
  check('staff, once signed in, go on to the tab they asked for', staff.result === true && staff.went === '/admin#reports' && staff.left === '');
  const delegate = signIn('/admin', false);
  check('a delegate stays in the portal, is told why, and the address forgets it',
    delegate.result === false && delegate.went === null && /cannot open the admin panel/.test(delegate.toast) && delegate.at === '/portal' && delegate.steps === 1, delegate);
  check('an ordinary sign-in is untouched', signIn('', true).result === false && signIn('', true).went === null);
  check('both ways of signing in follow it, before the dashboard loads', (js.match(/\n {2,4}if \(followSignInNext\(\)\) return;\n/g) || []).length === 2);
  check('a session that was already there does not: the address just forgets it',
    /if \(signInNext\) \{ signInNext = ''; writeAddress\(`\$\{window\.location\.pathname\}\$\{window\.location\.hash\}`, false\); \}/.test(js));
  check('/admin, signed out, sends you to sign in and remembers the admin panel',
    /if \(!req\.session\) return res\.redirect\(`\/portal\?next=\$\{encodeURIComponent\('\/admin'\)\}`\);/.test(server));
  check('...as the admin page does when its session has ended, with the tab it was on',
    /window\.location\.href = `\/portal\?next=\$\{encodeURIComponent\(`\/admin\$\{window\.location\.hash\}`\)\}`;/.test(js));
  check('the sign-in page says who signs in here, and what signing in will open',
    /<h2 class="text-xl font-bold text-navy">Sign in<\/h2>\s*<p[^>]*>Delegates, organisers and volunteers all sign in here\.<\/p>\s*<p id="login-next-note" class="hidden [^"]*">Sign in to open the admin panel\.<\/p>/.test(auth)
    && /note\.classList\.toggle\('hidden', !signInNext\);/.test(js));
  check('...and it is not a dead end: the bar, with the way back to the website',
    /<header id="front-bar" class="cbar [^"]*">[\s\S]*?<span class="cbar-place">Delegate portal<\/span>\s*<a href="<%= locals\.websiteUrl \|\| '\/' %>" class="cbar-link ml-auto shrink-0">Conference website<\/a>/.test(topbar)
    && /getElementById\('front-bar'\)/.test(js));
  check('a notice page returns to the portal, not to whatever / is on that address', /function noticePage\(title, bodyHtml, linkHref = '\/portal',/.test(server));
}

console.log('\n== The delegate portal: Back stays in the portal ==');
{
  const src = between('function writeAddress(url, push)', 'function navigateTo(pageId, how)');
  // The portal, signed in or out, on the page given; `opened` records what
  // the address made it show.
  const portal = (url, state = {}) => {
    const b = browser(url);
    const opened = [];
    let onPop = null;
    const registerForm = { classList: { contains: () => !state.signUpShown } };
    const sb = {
      history: b.history,
      window: { location: b.at, scrollTo() {}, addEventListener: (name, fn) => { if (name === 'popstate') onPop = fn; } },
      document: { getElementById: (id) => (id === 'register-form' ? registerForm : (id === 'dashboard-page' && !state.admin) || null) },
      PORTAL_HASH_OF_PAGE: { 'dashboard-page': '', 'programme-page': 'programme', 'map-page': 'map', 'profile-page': 'profile' },
      currentDelegate: state.signedOut ? null : { id: 1 },
      programmeData: state.noProgramme ? null : {},
      closeDashMenu() {},
    };
    const page = (name, id) => () => { opened.push(name); sb.setPage(id); };
    Object.assign(sb, {
      openProgrammePage: page('programme', 'programme-page'), openMapPage: page('map', 'map-page'), openProfilePage: page('profile', 'profile-page'),
      navigateTo: (id) => { opened.push(id); sb.setPage(id); },
      toggleAuth: (view, how) => { opened.push(`auth:${view}:${how}`); },
    });
    vm.runInNewContext(`let pendingPortalPage = ${JSON.stringify(state.pending || '')}; let dashTabsPage = ${JSON.stringify(state.page || 'dashboard-page')};
      this.setPage = (id) => { dashTabsPage = id; }; this.pending = () => pendingPortalPage;\n${src}
      this.sync = syncPortalAddress; this.openPending = openPendingPortalPage; this.write = writeAddress;`, sb);
    return { b, sb, opened, back: (to) => { b.history.replaceState(null, '', to); b.steps.pop(); onPop(); } };
  };

  const p = portal('/portal');
  p.sb.sync('programme-page', 'push');
  check('opening the programme is a step: /portal, then /portal#programme', JSON.stringify(p.b.steps) === '["/portal","/portal#programme"]', p.b.steps);
  p.sb.sync('programme-page', 'push');
  check('...the same page asked for twice is still one', p.b.steps.length === 2);
  p.sb.sync('map-page', 'push'); p.sb.sync('profile-page', 'push'); p.sb.sync('dashboard-page', 'push');
  check('...and so are the map, the profile and Home again', p.b.steps.slice(2).join() === '/portal#map,/portal#profile,/portal', p.b.steps);
  p.sb.sync('programme-page');
  check('a page the app opens by itself takes the place of the current step', p.b.steps.length === 5 && p.b.here() === '/portal#programme');
  p.sb.sync('maintenance-page');
  check('the maintenance notice has no address of its own', p.b.here() === '/portal#programme');

  const hall = portal('/portal?x=1');
  hall.sb.sync('profile-page', 'push');
  check('whatever else is in the address is kept', hall.b.here() === '/portal?x=1#profile');

  const adminPage = portal('/admin#reports', { admin: true });
  adminPage.sb.sync('dashboard-page', 'push');
  check('none of this touches the admin panel\'s address', adminPage.b.here() === '/admin#reports' && adminPage.b.steps.length === 1);

  const noPush = portal('/portal');
  delete noPush.b.history.pushState;
  noPush.sb.sync('map-page', 'push');
  check('a browser without pushState still gets the address, in place', noPush.b.here() === '/portal#map' && noPush.b.steps.length === 1);

  console.log('\n-- Back and Forward --');
  const walk = portal('/portal#profile', { page: 'profile-page' });
  walk.back('/portal#programme');
  check('Back to #programme shows the programme', walk.opened.join() === 'programme' && walk.b.here() === '/portal#programme');
  walk.back('/portal');
  check('...and to /portal, Home', walk.opened.join() === 'programme,dashboard-page' && walk.b.here() === '/portal');
  const lost = portal('/portal#profile', { page: 'profile-page' });
  lost.back('/portal#nowhere');
  check('an address that names no page is Home, and then says so', lost.opened.join() === 'dashboard-page' && lost.b.here() === '/portal');
  const same = portal('/portal#programme', { page: 'programme-page' });
  same.back('/portal#programme');
  check('a link to "#" on the page (no step taken) changes nothing', same.opened.length === 0);
  const early = portal('/portal#profile', { page: 'profile-page', noProgramme: true });
  early.back('/portal#map');
  check('a page that cannot be shown yet leaves them where they are, and the address says so', early.opened.length === 0 && early.b.here() === '/portal#profile', early.b.here());
  const out = portal('/portal', { signedOut: true, page: 'auth-page' });
  out.back('/portal#register');
  out.back('/portal');
  check('signed out, Back and Forward move between sign-in and the sign-up form', out.opened.join() === 'auth:register:replace,auth:login:replace');
  const closed = portal('/portal', { page: 'maintenance-page' });
  closed.back('/portal#programme');
  check('under maintenance, nothing opens', closed.opened.length === 0);

  console.log('\n-- A link or a refresh that names a page --');
  const link = portal('/portal#profile', { pending: 'profile' });
  link.sb.sync('auth-page'); link.sb.sync('dashboard-page');
  check('the page asked for stays in the address while signing in and loading', link.b.here() === '/portal#profile' && link.sb.pending() === 'profile');
  link.sb.openPending();
  check('...and opens once the dashboard has loaded', link.opened.join() === 'profile' && link.sb.pending() === '' && link.b.steps.length === 1);
  check('loadDashboard opens it, after everything it needs', /renderHomeHero\(\);\n {2}\/\/ A link or a refresh that named a page[^\n]*\n {2}openPendingPortalPage\(\);/.test(js));
  const elsewhere = portal('/portal#map', { pending: 'map' });
  elsewhere.sb.sync('programme-page', 'push');
  check('going somewhere themselves in the meantime wins over it', elsewhere.sb.pending() === '' && elsewhere.b.here() === '/portal#programme');
  check('only the portal\'s own pages are ever kept from the address',
    /if \(page === 'register' \|\| Object\.values\(PORTAL_HASH_OF_PAGE\)\.includes\(page\)\) pendingPortalPage = page;/.test(js));

  const signUp = portal('/portal', { signedOut: true, page: 'auth-page', signUpShown: true });
  signUp.sb.sync('auth-page', 'push');
  check('the sign-up form is /portal#register, a step Back returns from', signUp.b.steps.join() === '/portal,/portal#register');
  check('...which is where the website\'s Register buttons go', /class="btn btn-navy register" href="<%= portal %>#register"/.test(siteHead)
    && [['home.ejs'], ['registration.ejs']].every(([f]) => /href="<%= portal %>#register">Register now</.test(read('views', 'website', f)))
    && /if \(pendingPortalPage !== 'register'\) return;\n {2}pendingPortalPage = '';\n {2}toggleAuth\('register', 'replace'\);/.test(js));
  check('every page a delegate opens is a step', ["navigateTo('dashboard-page', 'push')", "navigateTo('profile-page', 'push')", "navigateTo('programme-page', 'push')", "navigateTo('map-page', 'push')"].every((c) => js.includes(c))
    && /syncPortalAddress\('auth-page', how \|\| 'push'\);/.test(js));
}

console.log('\n== The admin panel: Back goes to the tab before ==');
{
  const write = between('function writeAddress(url, push)', '// Keeps the delegate portal\'s address');
  // The part of switchBackendTab that keeps the address; the rest draws the tab.
  const head = `${between('function switchBackendTab(tab, opts)', '  // Every section was only ever fetched once')}}`;
  const adminAt = (url) => {
    const b = browser(url);
    const sb = { history: b.history, window: { location: b.at } };
    vm.runInNewContext(`let currentBackendTab = null;\n${write}\n${head}\nthis.go = switchBackendTab;`, sb);
    return { b, go: sb.go };
  };
  const a = adminAt('/admin');
  a.go('overview', { replace: true });
  check('the tab a visit lands on takes the place of /admin', a.b.steps.join() === '/admin#overview', a.b.steps);
  a.go('payments'); a.go('reports');
  check('each tab opened after that is a step', a.b.steps.join() === '/admin#overview,/admin#payments,/admin#reports', a.b.steps);
  a.go('reports');
  check('...the tab already showing is not', a.b.steps.length === 3);
  a.go('faculty', { replace: true });
  check('one the address asked for (Back, Forward, a link) is not a second step', a.b.steps.length === 3 && a.b.here() === '/admin#faculty');
  const setup = adminAt('/admin#general/sms');
  setup.go('general', { replace: true });
  check('a part of Conference setup in the address is left as it is', setup.b.here() === '/admin#general/sms' && setup.b.steps.length === 1);
  const first = adminAt('/admin#reports');
  first.go('reports', { replace: true }); first.go('overview');
  check('a link to a tab, then another tab: two steps, so Back returns to the link', first.b.steps.join() === '/admin#reports,/admin#overview');
  check('landing and the address changing both ask for "in place"', /switchBackendTab\(allowed\.includes\(hashTab\) \? hashTab : defaultTab, \{ replace: true \}\);/.test(js)
    && /if \(allowedBackendTabs\(\)\.includes\(tab\)\) switchBackendTab\(tab, \{ replace: true \}\);/.test(js));
  check('a part of Conference setup opened from another screen is one step, not two',
    /function openSetupPage\(page\) \{\n {2}if \(currentBackendTab === 'general'\) return showSetupPage\(page\);\n {2}setupPage = page;\n {2}switchBackendTab\('general'\);\n\}/.test(js));
}

console.log('\n== One switcher, in the same place on all three ==');
{
  const goTo = (html, start) => (html.slice(html.indexOf(start)).match(/Go to<\/p>([\s\S]*?)(<div class="cbar-rule">|<hr>)/) || [])[1] || '';
  const names = (html) => (html.match(/<b>([^<]+)<\/b>/g) || []).map((m) => m.replace(/<\/?b>/g, '')).join();
  check('the portal\'s account menu: Go to the Conference website, the Admin panel', names(goTo(topbar, 'id="dash-menu"')) === 'Conference website,Admin panel');
  check('the admin panel\'s: Go to the Conference website, the Delegate portal', names(goTo(header, 'id="admin-me-menu"')) === 'Conference website,Delegate portal');
  check('the website\'s: Go to the Delegate portal, the Admin panel', names(goTo(siteHead, 'class="me-panel"')) === 'Delegate portal,Admin panel');
  check('the Admin panel is offered to staff only, on both', /id="admin-nav-btn" href="\/admin" class="cbar-item hidden"/.test(topbar) && /id="site-me-admin" href="\/admin" hidden/.test(siteHead));
  check('Log out is last in each', [[topbar, 'id="dash-menu"', '</header>'], [header, 'id="admin-me-menu"', 'id="admin-menu-btn"'], [siteHead, 'class="me-panel"', '</details>']].every(([html, from, to]) => {
    const menu = html.slice(html.indexOf(from));
    return names(menu.slice(0, menu.indexOf(to))).split(',').pop() === 'Log out';
  }));
  check('the admin panel\'s account is a button of its own at every width, not 20 rows down the ☰ panel',
    header.indexOf('id="admin-me-wrap"') > header.indexOf('id="settings-menu"') && /#admin-me-menu \{ display: none; position: absolute;/.test(css) && /#admin-me-menu\.open \{ display: flex; \}/.test(css));
  check('the logo is each place\'s own home', /<a href="\/portal" onclick="dashGo\('home'\); return false;" class="cbar-home"/.test(topbar)
    && /<a href="\/admin" onclick="return adminGoHome\(\)" class="cbar-home"/.test(header) && /<a class="brand" href="<%= home %>"/.test(siteHead));
  {
    const src = between('function adminGoHome()', 'function switchBackendTab(tab, opts)');
    const went = [];
    const sb = { switchBackendTab: (t) => went.push(t), closeAdminMenus() {}, window: { scrollTo() {} } };
    vm.runInNewContext(`let adminHomeTab = null;\n${src}\nthis.home = adminGoHome; this.set = (t) => { adminHomeTab = t; };`, sb);
    const before = sb.home();
    sb.set('desk');
    check('...in the admin panel, the screen this role lands on (the link itself until that is known)', before === true && sb.home() === false && went.join() === 'desk'
      && /adminHomeTab = defaultTab;/.test(js));
  }
  check('one set of names: "Delegate portal" and "Admin panel", in the tags, the titles and the links',
    /<title>Delegate portal</.test(read('views', 'index.ejs')) && /<title>Admin panel<\/title>/.test(read('views', 'admin.ejs'))
    && ![topbar, header, siteHead, auth, read('views', 'website', 'partials', 'foot.ejs'), read('views', 'setup.ejs'), read('views', 'index.ejs'), read('views', 'admin.ejs')]
      .some((html) => /Admin Panel|Admin Portal|admin portal|Delegate Portal|Registration Portal|registration portal|Admin Backend/.test(html.replace(/<!--[\s\S]*?-->/g, ''))));
  // The menus hang from the right end of each bar, so that end must stay put.
  {
    const siteCss = read('public', 'website', 'site.css');
    check('the tag reads as one phrase: its words are one item beside the divider, not two', /<span class="cbar-place"><span>Delegate<span class="cbar-place-more"> portal<\/span><\/span><\/span>/.test(topbar)
      && /<span class="cbar-place"><span>Admin<span class="cbar-place-more"> panel<\/span><\/span><\/span>/.test(header));
    check('every row of an account menu is 44px to the thumb', /\.cbar-item \{[^}]*justify-content: center;[^}]*min-height: 44px;/.test(css) && /\.me-panel a, \.me-panel button \{[^}]*padding: 12px 14px;/.test(siteCss));
    check('on the website the logo gives way on a narrow phone, not the buttons (their panels hang from that row\'s right end)',
      /\.brand \{[^}]*flex: 1 1 100px; min-width: 0; max-width: max-content;/.test(siteCss) && /\.brand img \{[^}]*max-width: 100%; object-fit: contain;/.test(siteCss)
      && /\.header-actions \{[^}]*position: relative; margin-left: auto; \}/.test(siteCss));
    check('...and the name joins the initials only where the longest one fits beside the menu', /@media \(min-width: 1200px\) \{ \.me-name \{ display: inline; \} \}/.test(siteCss)
      && !/\.me-name \{ display: inline; \}\n  \.me-menu/.test(siteCss) && /\.me-name \{ display: none; max-width: 14rem;/.test(siteCss));
  }
}
report();
