// The website after the conference (owner, 22 Nov 2026; mockup approved):
// from the day after the last day the home page thanks people -- the
// conference in figures, the Oration, the best papers once the organisers
// show them, what each day held -- with no Register; ?at= previews it.
const { call, check, report, adminLogin, appFile, openDb } = require('./harness');
const fs = require('fs');

(async () => {
  const admin = await adminLogin();
  const db = openDb();
  const savedPrize = await db.all('SELECT * FROM presentation_prizes');
  const savedFlag = await db.get("SELECT value FROM schema_meta WHERE key = 'website_winners_public'");
  try {
    const page = async (at) => (await call('GET', `/website/?at=${at}`, null, null)).raw || '';
    const after = await page('2099-12-31T10:00');
    const before = await page('2000-01-01T10:00');
    check('after the last day: the thank-you page, under the conference\'s name', /<h1>[^<]+<\/h1>\s*<p class="theme">/.test(after) && /class="thanks">Thank you for making/.test(after)
      && /Download your certificate/.test(after) && !/Concluded/.test(after), after.slice(0, 200));
    check('...with no Register now, nor the days to come', !/Register now/.test(after) && !/workshops begin across the campus/.test(after));
    check('...the conference in figures, leaving out any that is nought', /in numbers<\/h2>/.test(after) && /<p class="l">registered<\/p>/.test(after) && !/<p class="n">0<\/p>/.test(after) && !/>0 hands-on/.test(after));
    check('...and what each day held', /What happened/.test(after) && /Workshops and field visits/.test(after) && /The scientific programme/.test(after));
    check('before it: the page as ever', /Register now/.test(before) && !/Thank you for making/.test(before));

    console.log('\n== The best papers ==');
    const list = (await call('GET', '/api/admin/prizes', null, admin)).body;
    check('Step 5 says whether they are shown: not, to begin with', list.success && list.public === false, list.public);
    const paper = await db.get("SELECT id, title FROM abstracts WHERE status = 'ACCEPTED' AND decision_sent_at IS NOT NULL AND allocation = 'ORAL' LIMIT 1");
    if (paper) {
      await db.run("DELETE FROM presentation_prizes WHERE format = 'ORAL' AND rank = 1");
      await db.run("INSERT OR REPLACE INTO presentation_prizes (format, rank, abstract_id, set_by, set_at) VALUES ('ORAL', 1, ?, 'test', ?)", [paper.id, Date.now()]);
      check('a winner chosen, not shown: no Best papers on the site', !/Best papers/.test(await page('2099-12-31T10:00')));
      const on = await call('PUT', '/api/admin/prizes/public', { public: true }, admin);
      const shown = await page('2099-12-31T10:00');
      check('shown: Best papers, with the paper', on.body.success && /Best papers/.test(shown) && shown.includes(paper.title.replace(/&/g, '&amp;').replace(/"/g, '&#34;').slice(0, 20)), on.body);
      await call('PUT', '/api/admin/prizes/public', { public: false }, admin);
      check('...and hidden again', !/Best papers/.test(await page('2099-12-31T10:00')));
    } else check('(no oral paper in this fixture to try the winners on)', true);

    const head = fs.readFileSync(appFile('views', 'website', 'partials', 'head.ejs'), 'utf8');
    const foryou = fs.readFileSync(appFile('views', 'website', 'partials', 'foryou.ejs'), 'utf8');
    const src = fs.readFileSync(appFile('server.js'), 'utf8');
    check('the header has no Register once the conference is over', /<% if \(!conf\.over && conf\.registrationOpen\) \{ %><a class="btn btn-navy register"/.test(head));
    check('For you, after it: each certificate, ready or on its way, and no badge', /for \(const c of certificateLines\(me\)\)/.test(src) && /note\('ok', 'Ready', c\.title/.test(src)
      && /if \(d\.after\) \{ var passBox = box\.querySelector\('\.you-pass'\)/.test(foryou));
  } finally {
    await db.run('DELETE FROM presentation_prizes');
    for (const p of savedPrize) await db.run('INSERT INTO presentation_prizes (format, rank, abstract_id, set_by, set_at) VALUES (?, ?, ?, ?, ?)', [p.format, p.rank, p.abstract_id, p.set_by, p.set_at]);
    if (savedFlag) await db.run("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('website_winners_public', ?)", [savedFlag.value]);
    else await db.run("DELETE FROM schema_meta WHERE key = 'website_winners_public'");
    db.close();
  }
  report();
})();
