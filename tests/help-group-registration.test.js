// The group-registration how-to page.
//
// A help page is only worth having while it is true, so this file holds it to
// the app rather than to itself:
//
//   * the offers it quotes are the group-discount rules in force, read live --
//     a page with a hardcoded "10% for 5+" would outlive the rule;
//   * the refusals in its troubleshooting section are the server's own
//     messages, word for word, so renaming one here without there is caught;
//   * it is public, because step 1 is "your colleagues sign up" -- a leader
//     sends this link to people who have no account yet.
//
// The suite runs files one at a time against one server, so this file adds a
// rule and removes it again in `finally`, pass or fail.
const { call, check, report, appFile, adminLogin, openDb } = require('./harness');
const fs = require('fs');
const vm = require('vm');

const URL = '/help/group-registration';
const strip = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'")
  .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

(async () => {
  const admin = await adminLogin();
  const db = openDb({ readOnly: true });
  const cat = await db.get('SELECT category_key, label FROM fee_categories WHERE active = 1 ORDER BY sort_order, id LIMIT 1');
  const existing = (await call('GET', '/api/admin/group-rules', null, admin)).body.rules || [];
  const mine = existing.find((r) => r.category_key === cat.category_key);
  check('fixture: a fee category to hang a rule on', !!cat && !!cat.category_key, cat);
  check('fixture: no rule of this test\'s own is left over', !mine, mine);

  try {
    console.log('\n== Anyone can read it, signed in or not ==');
    const anon = await call('GET', URL);
    check('it responds without a session', anon.status === 200, anon.status);
    check('...as a web page', /text\/html/.test(anon.type || ''), anon.type);
    const page = String(anon.body);
    check('...titled as a how-to', /<title>Group Registration — How To/.test(page), (page.match(/<title>[^<]*/) || [])[0]);
    // Read from the rendered text, not the raw HTML: the name contains an
    // ampersand, which the page escapes (and must).
    check('...naming the conference it belongs to', strip(page).includes('Fixture Conference on Quality & Safety 2099'));
    check('...with that ampersand escaped, not raw', /Quality &amp; Safety/.test(page) && !/Quality & Safety/.test(page));
    check('...and offering the way back to the portal', /<a href="\/"[^>]*>[\s\S]{0,120}Back to the portal/.test(page));

    console.log('\n== What it offers is what the rules say ==');
    const before = strip(String((await call('GET', URL)).body));
    check('with no rule set, it says so rather than inventing one',
      before.includes('No group discount is open at the moment'), before.slice(0, 200));

    const set = await call('POST', '/api/admin/group-rules',
      { categoryKey: cat.category_key, minSize: 7, discountType: 'PERCENT', discountValue: 12 }, admin);
    check('an organiser sets a rule', set.body.success === true, set.body.error);
    const withPercent = strip(String((await call('GET', URL)).body));
    check('the page now names that category', withPercent.includes(cat.label), cat.label);
    check('...with the minimum it actually requires', withPercent.includes('7 or more'), withPercent.slice(0, 400));
    check('...and the discount it actually gives', withPercent.includes('12% off'));
    check('...so it no longer says nothing is on offer', !withPercent.includes('No group discount is open'));

    // A rupee rule reads as rupees, the same way the portal's own picker
    // writes it -- a percent sign on a flat discount would be a lie.
    await call('POST', '/api/admin/group-rules',
      { categoryKey: cat.category_key, minSize: 4, discountType: 'FLAT', discountValue: 500 }, admin);
    const withFlat = strip(String((await call('GET', URL)).body));
    check('a flat rule is shown in rupees', withFlat.includes('₹500 off'), withFlat.slice(0, 400));
    check('...with its own minimum', withFlat.includes('4 or more'));
    check('...and no stale percentage from the previous rule', !withFlat.includes('12% off'));

    // A rule the organisers switch off is not an offer any more, and the
    // portal stops letting anyone start a group for it -- so the page must
    // stop advertising it too.
    const ruleId = ((await call('GET', '/api/admin/group-rules', null, admin)).body.rules || [])
      .find((r) => r.category_key === cat.category_key).id;
    const off = await call('PUT', `/api/admin/group-rules/${ruleId}`, { active: false }, admin);
    check('an organiser switches the rule off', off.body.success === true, off.body.error);
    const whileOff = strip(String((await call('GET', URL)).body));
    check('the page stops advertising it', !whileOff.includes('₹500 off'), whileOff.slice(0, 400));
    check('...and says nothing is open, as the portal now does',
      whileOff.includes('No group discount is open at the moment'));
    await call('PUT', `/api/admin/group-rules/${ruleId}`, { active: true }, admin);
    check('switching it back on brings the offer back',
      strip(String((await call('GET', URL)).body)).includes('₹500 off'));

    console.log('\n== The refusals it explains are the server\'s own ==');
    // Each quoted heading must be something POST /api/groups/:id/members can
    // actually say; otherwise the page explains an error nobody ever sees.
    const src = fs.readFileSync(appFile('server.js'), 'utf8');
    const quoted = [...String((await call('GET', URL)).body).matchAll(/<dt[^>]*>[“"]([^<]+?)[”"]<\/dt>/g)].map((m) => m[1]);
    check('it quotes the portal\'s messages', quoted.length >= 4, quoted);
    const notReal = quoted.filter((q) => !src.includes(q.replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, '&')));
    check('...and every one of them is a message the server really sends', notReal.length === 0, notReal);
    const advice = strip(String((await call('GET', URL)).body));
    check('the one that is not an error -- paying too early -- is covered too',
      advice.includes('paid the full fee before the group filled up'), advice.slice(-600));

    console.log('\n== The advice matches how the discount actually works ==');
    // The page's central warning: the discount is computed when a payment is
    // submitted, and nothing grants it retroactively. If that ever changes,
    // this check should fail and the page should be rewritten.
    check('the server still grants the group discount only at payment time',
      /discountAmount = groupDiscount; discountCodeApplied = 'GROUP';/.test(src)
      && !/applyGroupDiscountIfQualifies|grantGroupDiscount|recomputeGroupDiscount/.test(src));
    check('...so the page warns against paying before the group is full',
      advice.includes('before anyone pays'), advice.slice(0, 900));
    check('the server still reverts the fee when a group shrinks',
      /async function revokeGroupDiscountIfBelowThreshold/.test(src));
    check('...and the page says the difference becomes due',
      /drops below the minimum[\s\S]{0,200}balance due/.test(advice));
    check('the page repeats the portal\'s rule that only the leader adds members',
      /Only the leader can add people/.test(advice) && src.includes('Only the group leader can add members.'));
    check('...and that a promo code and a group discount do not stack',
      /do not add up[\s\S]{0,80}worth more is applied/.test(advice)
      && /groupDiscount >= promoDiscount/.test(src));

    console.log('\n== Nothing on the page is unescaped ==');
    const view = fs.readFileSync(appFile('views', 'help', 'group-registration.ejs'), 'utf8');
    check('every value from the database is escaped', !/<%-/.test(view),
      (view.match(/<%-[^%]*%>/g) || []).slice(0, 3));

    console.log('\n== The group panel in the delegate portal points at it ==');
    // Rendered for real, both states of the panel: a regex over app.js would
    // pass on a link inside a template that never renders.
    const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
    check('one link, defined once, so the two states cannot drift',
      (js.match(/const GROUP_HELP_LINK = /g) || []).length === 1);

    const panelHtml = async (groupReply) => {
      const box = { id: 'group-section', innerHTML: '', hidden: false,
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false } };
      const doc = { getElementById: (id) => (id === 'group-section' ? box : null),
        querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
        createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, addEventListener() {}, appendChild() {}, remove() {} }),
        body: { appendChild() {}, classList: { add() {}, remove() {} } },
        documentElement: {}, readyState: 'loading', cookie: '' };
      const sandbox = {
        document: doc,
        window: { addEventListener() {}, location: { href: '', hash: '', pathname: '/', search: '' },
          matchMedia: () => ({ matches: false, addEventListener() {} }), history: { replaceState() {} } },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        navigator: { userAgent: 'node' },
        fetch: async (u) => ({ json: async () => (u === '/api/groups/me' ? groupReply
          : { categories: [{ category_key: 'doctor', label: 'Doctor', min_size: 5, discount_type: 'FLAT', discount_value: 500 }] }) }),
        console: { log() {}, warn() {}, error() {}, info() {} },
        setTimeout: (fn, ms) => (ms >= 1000 ? 0 : setTimeout(fn, ms)), clearTimeout, setInterval: () => 0, clearInterval,
        URL, Intl, Date, Math, JSON, Promise, requestAnimationFrame: () => 0,
      };
      sandbox.window.document = doc; sandbox.self = sandbox; sandbox.globalThis = sandbox;
      vm.createContext(sandbox);
      vm.runInContext(`${js}\n globalThis.__render = renderGroupSection;`, sandbox, { filename: 'app.js+driver' });
      await sandbox.__render();
      return box.innerHTML;
    };

    const inGroup = await panelHtml({ group: {
      categoryLabel: 'Doctor', size: 3, minSize: 5, qualifies: false, allVerified: false, isLeader: true,
      leaderPhone: '9000000001', members: [{ phone: '9000000001', name: 'A Leader', status: 'PENDING' }] } });
    check('a delegate already in a group sees the link', inGroup.includes(`href="${URL}"`), inGroup.slice(0, 200));
    check('...labelled as help, not buried in a sentence', /How group registration works<\/a>/.test(inGroup));
    // Asked for as a bigger target: it is a full-size control, not the small
    // outlined button the other two in the row are.
    check('...and sized as a real button, full width on a phone',
      /class="[^"]*w-full sm:w-auto[^"]*px-5 py-3[^"]*text-sm font-bold[^"]*"/.test(inGroup), (inGroup.match(/<a href="\/help[^>]*>/) || [])[0]);
    check('...among the panel\'s buttons, beside Leave group',
      /Leave group<\/button>[\s\S]{0,600}href="\/help\/group-registration"/.test(inGroup), inGroup.slice(-700));
    check('...opening in its own tab, so a half-filled panel is not lost',
      /href="\/help\/group-registration"[^>]*target="_blank"[^>]*rel="noopener"/.test(inGroup));
    check('...once, not twice', (inGroup.match(/\/help\/group-registration/g) || []).length === 1,
      (inGroup.match(/\/help\/group-registration/g) || []).length);

    const noGroup = await panelHtml({ group: null });
    check('a delegate who has not started one sees it too', noGroup.includes(`href="${URL}"`), noGroup.slice(0, 200));
    check('...beside Start a group', /Start a group<\/button>[\s\S]{0,600}href="\/help\/group-registration"/.test(noGroup), noGroup.slice(-700));
    check('...and the panel still offers what it did before',
      /Start a group/.test(noGroup) && /Doctor/.test(noGroup));

    const modal = fs.readFileSync(appFile('views', 'portal', 'modals', 'add-group-member.ejs'), 'utf8');
    check('the add-member dialog links it, where the errors it explains happen',
      /href="\/help\/group-registration"/.test(modal));
  } finally {
    const rules = (await call('GET', '/api/admin/group-rules', null, admin)).body.rules || [];
    const added = rules.find((r) => r.category_key === cat.category_key);
    if (added) await call('DELETE', `/api/admin/group-rules/${added.id}`, null, admin);
  }
  const left = ((await call('GET', '/api/admin/group-rules', null, admin)).body.rules || [])
    .filter((r) => r.category_key === cat.category_key);
  check('the rule this file added is cleaned up for the files after it', left.length === 0, left);

  db.close();
  report();
})();
