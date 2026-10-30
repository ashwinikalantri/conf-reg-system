// One name for a workshop.
//
// A workshop (Workshops tab, program_options) and its sessions in the
// programme were named separately, and drifted apart ("POCQI" in one,
// "PoQCI" in the other). The owner chose (2026-10-30): the Workshops tab's
// name wins. What must hold:
//
//   * a workshop's name can be edited in the Workshops tab;
//   * a programme session linked to a workshop is shown under the
//     workshop's name, so renaming the workshop renames it in the programme;
//   * the session's own stored title is kept, untouched, when it is saved;
//     a new linked session needs no title of its own;
//   * a session not linked to a workshop keeps its own title.
const { call, check, report, appFile, adminLogin, openDb } = require('./harness');
const fs = require('fs');

const N = String(Date.now() % 100000000).padStart(8, '0');

(async () => {
  const admin = await adminLogin();
  const db = openDb();
  let groupId = null;
  let optionId = null;
  let hallId = null;
  const sessions = [];
  try {
    groupId = (await call('POST', '/api/admin/program-groups', { name: `Name Group ${N}`, required: false, maxSelect: 1 }, admin)).body.id;
    optionId = (await call('POST', '/api/admin/program-options', { groupId, name: `POCQI Method ${N}`, capacity: 30, fee: 0 }, admin)).body.id;
    hallId = (await call('POST', '/api/admin/programme/halls', { name: `Name Hall ${N}` }, admin)).body.id;
    check('fixture: a workshop and a hall', !!optionId && !!hallId);

    const base = { hallId, date: '2026-11-23', start: '09:00', end: '10:00', counts: false };
    const typed = await call('POST', '/api/admin/programme/sessions', { ...base, label: 'Workshop 1', title: `PoQCI Method ${N} (typed)`, optionId }, admin);
    sessions.push(typed.body.id);
    const bare = await call('POST', '/api/admin/programme/sessions', { ...base, start: '11:00', end: '12:00', label: 'Workshop 1', optionId }, admin);
    sessions.push(bare.body.id);
    const plain = await call('POST', '/api/admin/programme/sessions', { ...base, start: '13:00', end: '14:00', title: `Own talk ${N}` }, admin);
    sessions.push(plain.body.id);
    check('a linked session needs no title of its own', bare.body.success === true, bare.body);
    const shown = async (id) => (await call('GET', '/api/programme', null, admin)).body.sessions.find((x) => x.id === id);
    const stored = async (id) => (await db.get('SELECT title FROM programme_sessions WHERE id = ?', [id])).title;

    console.log('\n== The programme shows the workshop\'s name ==');
    check('a session typed differently shows the workshop\'s name', (await shown(typed.body.id)).title === `POCQI Method ${N}`);
    check('...in the admin programme too', (await call('GET', '/api/admin/programme', null, admin)).body.sessions.find((x) => x.id === typed.body.id).title === `POCQI Method ${N}`);
    check('...while what was typed stays stored', (await stored(typed.body.id)) === `PoQCI Method ${N} (typed)`);
    check('a session not linked keeps its own title', (await shown(plain.body.id)).title === `Own talk ${N}`);

    console.log('\n== Renaming the workshop renames it in the programme ==');
    const renamed = await call('PUT', `/api/admin/program-options/${optionId}`, { name: `POCQI Methodology ${N}` }, admin);
    check('the workshop is renamed', renamed.body.success === true, renamed.body);
    check('...and so is every session for it', (await shown(typed.body.id)).title === `POCQI Methodology ${N}` && (await shown(bare.body.id)).title === `POCQI Methodology ${N}`);
    check('a blank name is refused', (await call('PUT', `/api/admin/program-options/${optionId}`, { name: '  ' }, admin)).status === 400);

    console.log('\n== Saving a linked session keeps its stored title ==');
    const saved = await call('PUT', `/api/admin/programme/sessions/${typed.body.id}`, { ...base, label: 'Workshop 1', optionId }, admin);
    check('saved without a title', saved.body.success === true, saved.body);
    check('...and its stored title is unchanged', (await stored(typed.body.id)) === `PoQCI Method ${N} (typed)`);

    console.log('\n== The screens ==');
    const js = fs.readFileSync(appFile('public/app.js'), 'utf8');
    const ejs = fs.readFileSync(appFile('views/admin/sections/programme.ejs'), 'utf8');
    check('each workshop has a name box, sent on Save', /class="prog-name /.test(js) && /\.prog-name\[data-id=/.test(js) && /name: String\(name\)\.trim\(\)/.test(js));
    check('the session editor locks the title to the workshop\'s name', /function syncSessionTitleField\(/.test(js) && /onchange="syncSessionTitleField\(\)"/.test(ejs) && /id="ps-title-note"/.test(ejs));
    check('...and does not send it', /title: linked \? undefined : v\('ps-title'\)/.test(js));
  } finally {
    for (const id of sessions.filter(Boolean)) await db.run('DELETE FROM programme_sessions WHERE id = ?', [id]);
    if (hallId) await db.run('DELETE FROM halls WHERE id = ?', [hallId]);
    if (optionId) await db.run('DELETE FROM program_options WHERE id = ?', [optionId]);
    if (groupId) await db.run('DELETE FROM program_groups WHERE id = ?', [groupId]);
  }
  db.close();
  report();
})();
