// The reviewer can download an abstract as a PDF: GET /api/abstracts/:id/pdf,
// guarded by abstracts.view, a real PDF as an attachment; unknown id is a 404.
// The renderer reads the stored <b>/<i>/<sup>/<sub> markup back into styled runs.
const { call, check, report, adminLogin, loginPassword, ADMIN_PW, openDb } = require('./harness');
const perms = require('../permissions');
const { parseRuns, renderAbstractPdf } = require('../abstract-pdf');

(async () => {
  const admin = await adminLogin();
  const reviewer = await loginPassword('9000000003', ADMIN_PW);
  const db = openDb();
  const phone = `9${String(Date.now()).slice(-9)}`;
  let id;
  try {
    const r = await db.run(
      `INSERT INTO abstracts (phone_number, author_name, format, title, text, word_count, status, background, aim, methods, results, conclusion, keywords)
       VALUES (?, 'PDF Author', 'Paper', 'PDF fixture', 'x', 20, 'UNDER_REVIEW', 'CO<sub>2</sub> &amp; <b>bold</b>', 'Aim', 'Methods', 'Results', 'Conclusion', 'a, b')`, [phone]);
    id = r.lastID;

    console.log('\n== The route ==');
    check('guarded by abstracts.view', perms.permissionForRoute('GET /api/abstracts/:id/pdf') === 'abstracts.view');
    const ok = await call('GET', `/api/abstracts/${id}/pdf`, null, admin);
    check('an admin gets a PDF', ok.status === 200 && /application\/pdf/.test(ok.type || '') && ok.raw.startsWith('%PDF'), ok.status);
    check('...as a download named for the abstract', /attachment; filename="abstract-\d+\.pdf"/.test(ok.headers['content-disposition'] || ''), ok.headers['content-disposition']);
    const rev = await call('GET', `/api/abstracts/${id}/pdf`, null, reviewer);
    check('a reviewer gets it too', rev.status === 200 && rev.raw.startsWith('%PDF'), rev.status);
    const anon = await call('GET', `/api/abstracts/${id}/pdf`);
    check('signed out is refused', anon.status === 401 || anon.status === 403, anon.status);
    const none = await call('GET', '/api/abstracts/99999999/pdf', null, admin);
    check('an unknown abstract is a 404', none.status === 404, none.status);

    console.log('\n== The renderer ==');
    const runs = parseRuns('a &lt; b <b>bold</b> H<sub>2</sub>O x<sup>2</sup> <i>it</i>');
    check('markup becomes styled runs', runs.some((x) => x.bold && x.text === 'bold') && runs.some((x) => x.script === 'sub') && runs.some((x) => x.script === 'sup') && runs.some((x) => x.italic));
    check('escaped text is read back', runs[0].text === 'a < b ', runs[0].text);
    const buf = await renderAbstractPdf({ id: 1, title: 'T', author_name: 'A', format: 'Paper', status: 'ACCEPTED', methods: 'word '.repeat(2000) });
    check('a long abstract runs onto more pages', buf.toString('latin1').match(/\/Type \/Page\b/g).length > 1);
  } finally {
    if (id) await db.run('DELETE FROM abstracts WHERE id = ?', [id]);
  }
  db.close();
  report();
})();
