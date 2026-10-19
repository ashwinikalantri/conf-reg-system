// Assignment has a third format, Award, alongside Oral and Poster. It is only
// ever assigned by a reviewer: the submission form still offers Oral and Poster.
const { call, check, report, adminLogin, appFile, openDb } = require('./harness');
const fs = require('fs');

(async () => {
  const admin = await adminLogin();
  const db = openDb();
  const phone = `9${String(Date.now()).slice(-9)}`;
  let id;
  try {
    const r = await db.run(`INSERT INTO abstracts (phone_number, author_name, format, title, text, word_count, status)
      VALUES (?, 'Award Author', 'Paper', 'Award fixture', 'x', 20, 'ACCEPTED')`, [phone]);
    id = r.lastID;
    const bad = await call('PUT', `/api/abstracts/${id}/allocation`, { allocation: 'KEYNOTE' }, admin);
    check('an unknown format is still refused', bad.status === 400, bad.status);
    const ok = await call('PUT', `/api/abstracts/${id}/allocation`, { allocation: 'AWARD' }, admin);
    check('AWARD can be assigned', ok.status === 200 && ok.body.success, ok.body);
    const row = await db.get('SELECT allocation FROM abstracts WHERE id = ?', [id]);
    check('...and is stored', row.allocation === 'AWARD', row.allocation);
    const pdf = await call('GET', `/api/abstracts/${id}/pdf`, null, admin);
    check('the PDF still renders for it', pdf.status === 200 && pdf.raw.startsWith('%PDF'), pdf.status);
  } finally {
    if (id) await db.run('DELETE FROM abstracts WHERE id = ?', [id]);
  }
  const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
  check('the assignment cards offer Award', /data-alloc="AWARD"/.test(js));
  check('the desk offers Award', js.includes("deskAllotAbstract(${esc(a.id)}, 'AWARD')"));
  check('assigning asks before it emails, on the cards and on the desk',
    /async function updateAbstractAllocation\(id, allocation\) \{\s*if \(!\(await confirmAllocationEmail\(/.test(js)
    && /async function deskAllotAbstract\(id, allocation\) \{\s*if \(!\(await confirmAllocationEmail\(/.test(js));
  const form = fs.readFileSync(appFile('views', 'portal', 'modals', 'abstract.ejs'), 'utf8');
  const options = form.match(/name="abstract-format" value="[^"]+"/g) || [];
  check('the submission form still offers only Oral and Poster',
    options.length === 2 && !options.some((o) => /award/i.test(o)), options);
  db.close();
  report();
})();
