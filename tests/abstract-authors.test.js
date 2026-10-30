// Every author of an abstract, in order.
//
// Abstracts first stored only the delegate who submitted them. The owner's
// decisions (2026-10-30): names only; at most six; the submitter stays on
// the list as the presenting author, at any position, and cannot be removed
// or renamed by the delegate; delegates change their list until a "last date
// for authors" set in Conference setup, admins at any time; the text of the
// abstract stays locked. What must hold:
//
//   * the rules in abstract-authors.js;
//   * a delegate can add, reorder and save their list, and nothing else
//     about the abstract changes; after the last date they are refused;
//   * a reviewer can set anyone's list, after the date too, and correct the
//     presenting author's spelling; a delegate cannot reach that route;
//   * the list reaches the admin list, the PDF, the accepted-abstracts
//     report and the "authors not added" reminder audience;
//   * every change is in the activity log.
//
// The suite runs files one at a time against one server, so this file moves
// the shared last date for authors -- and puts it back in `finally`.
const { call, check, report, appFile, adminLogin, openDb } = require('./harness');
const fs = require('fs');
const A = require('../abstract-authors');

const IST = 5.5 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const istDay = (offset) => new Date(Date.now() + IST + offset * DAY).toISOString().slice(0, 10);
const N = String(Date.now() % 100000000).padStart(8, '0');
const phones = { sole: `85${N}`, team: `84${N}`, rejected: `83${N}` };
const ABSTRACT = {
  format: 'Oral Paper', title: 'Authors fixture abstract',
  background: 'Some background.', aim: 'An aim.', methods: 'A method.', results: 'A result.',
  conclusion: 'A conclusion.', keywords: 'quality, safety',
};

console.log('\n== The rules ==');
const me = { name: 'Asha Rao', presenting: true };
check('a list in any order, the presenting author anywhere',
  JSON.stringify(A.cleanAuthors([{ name: ' B  Shah ' }, me, 'C Iyer']).authors) === JSON.stringify([{ name: 'B Shah', presenting: false }, me, { name: 'C Iyer', presenting: false }]));
check('blank rows are left out', A.cleanAuthors([me, { name: '  ' }, { name: 'D Das' }]).authors.length === 2);
check('there must be exactly one presenting author', !!A.cleanAuthors([{ name: 'X' }]).error && !!A.cleanAuthors([me, { name: 'Y', presenting: true }]).error);
check('six at most', !A.cleanAuthors([me, ...[1, 2, 3, 4, 5].map((i) => `Author ${'ABCDE'[i - 1]}`)]).error
  && /at most 6/.test(A.cleanAuthors([me, ...'ABCDEF'.split('').map((c) => `Author ${c}`)]).error), A.MAX_AUTHORS);
check('the same name twice is refused, whatever the case or full stops', /twice/.test(A.cleanAuthors([me, 'Dr. B Shah', 'dr b shah']).error || ''));
check('a name needs letters', !!A.cleanAuthors([me, '1234']).error);
check('the presenting author\'s name is fixed when told to be', A.cleanAuthors([{ name: 'Someone Else', presenting: true }], { presentingName: 'Asha Rao' }).authors[0].name === 'Asha Rao');
check('no list given: the submitter alone, presenting', JSON.stringify(A.effectiveAuthors({ author_name: 'Asha Rao', authors: null })) === JSON.stringify([me]));
check('as text, * marks the presenting author', A.authorsText([{ name: 'B Shah' }, me]) === 'B Shah, Asha Rao*' && A.authorsText([me]) === 'Asha Rao');

(async () => {
  const admin = await adminLogin();
  const db = openDb();
  const settings = async () => (await call('GET', '/api/admin/general-settings', null, admin)).body.conference;
  const setLast = (d) => call('PUT', '/api/admin/general-settings', { conference: { authorsDeadline: d } }, admin);
  const original = (await settings()).authorsDeadline || '';
  const originalAbstract = (await settings()).abstractDeadline || '';
  const signIn = async (phone) => {
    const r = await call('POST', `/api/users/${phone}/reset-password`, {}, admin);
    return (await call('POST', '/api/auth/login-password', { identifier: phone, password: r.body.tempPassword })).cookie;
  };
  const mine = async (cookie) => (await call('GET', '/api/abstracts/me', null, cookie)).body;
  const putMine = (cookie, authors) => call('PUT', '/api/abstracts/me/authors', { authors }, cookie);

  try {
    await call('PUT', '/api/admin/general-settings', { conference: { abstractDeadline: istDay(5) } }, admin);
    await setLast(istDay(3));
    const cookies = {};
    for (const [k, p] of Object.entries(phones)) {
      await call('POST', '/api/users', { phone: p, name: `Author ${k} ${N}`, email: `authors-${k}-${N}@example.test`, role: 'DELEGATE' }, admin);
      cookies[k] = await signIn(p);
    }

    console.log('\n== Submitting with authors, and without ==');
    const sub = await call('POST', '/api/abstracts', { ...ABSTRACT, title: `Team ${N}`,
      authors: [{ name: 'Co One' }, { name: 'Renamed Me', presenting: true }] }, cookies.team);
    check('a new abstract can carry its authors', sub.body.success === true, sub.body);
    const team = (await mine(cookies.team)).abstract;
    check('...stored in order, the submitter under their own name', A.authorsText(team.authors) === `Co One, Author team ${N}*` && team.authors_given === true, team.authors);
    await call('POST', '/api/abstracts', { ...ABSTRACT, title: `Sole ${N}` }, cookies.sole);
    await call('POST', '/api/abstracts', { ...ABSTRACT, title: `Rejected ${N}` }, cookies.rejected);
    const sole = await mine(cookies.sole);
    check('one sent without: the submitter alone, not yet given', sole.abstract.authors.length === 1 && sole.abstract.authors[0].presenting && sole.abstract.authors_given === false, sole.abstract.authors);
    check('...and the delegate is told the window', sole.authorsWindow.open === true && sole.authorsWindow.deadline === istDay(3) && sole.authorsWindow.max === 6, sole.authorsWindow);

    console.log('\n== The delegate adds and orders them ==');
    const before = await db.get('SELECT title, background, word_count, status FROM abstracts WHERE phone_number = ?', [phones.sole]);
    const saved = await putMine(cookies.sole, [{ name: 'First Author' }, { name: 'x', presenting: true }, { name: 'Third Author' }]);
    check('saved', saved.body.success === true, saved.body);
    const after = await mine(cookies.sole);
    check('in their order, still presenting, under their own name', A.authorsText(after.abstract.authors) === `First Author, Author sole ${N}*, Third Author`, after.abstract.authors);
    const same = await db.get('SELECT title, background, word_count, status FROM abstracts WHERE phone_number = ?', [phones.sole]);
    check('nothing else about the abstract changed', JSON.stringify(before) === JSON.stringify(same));
    check('a list without them is refused', (await putMine(cookies.sole, [{ name: 'Only Others' }])).status === 400);
    check('seven are refused', (await putMine(cookies.sole, [me, ...'ABCDEF'.split('').map((c) => ({ name: `Author ${c}` }))])).status === 400);
    const solo = await putMine(cookies.sole, [{ name: 'x', presenting: true }]);
    check('the only author can confirm just themselves', solo.body.success === true && (await mine(cookies.sole)).abstract.authors_given === true);
    const audit = await db.get(`SELECT old_value, new_value FROM audit_log WHERE action = 'ABSTRACT_AUTHORS_UPDATED'
      AND entity_id = (SELECT CAST(id AS TEXT) FROM abstracts WHERE phone_number = ?) ORDER BY id DESC LIMIT 1`, [phones.sole]);
    check('the change is in the activity log, before and after', audit && /First Author/.test(audit.old_value) && audit.new_value === `Author sole ${N}`, audit);

    console.log('\n== Not for a rejected abstract, nor after the last date ==');
    const rejId = (await db.get('SELECT id FROM abstracts WHERE phone_number = ?', [phones.rejected])).id;
    await call('PUT', `/api/abstracts/${rejId}/status`, { status: 'REJECTED' }, admin);
    check('a rejected abstract\'s authors cannot be changed', (await putMine(cookies.rejected, [{ name: 'x', presenting: true }])).status === 409);
    await setLast(istDay(-1));
    check('the setting says it is closed', (await settings()).abstractAuthorsOpen === false);
    const late = await putMine(cookies.team, [{ name: 'x', presenting: true }]);
    check('after the last date the delegate is refused', late.status === 403 && late.body.code === 'AUTHORS_CLOSED', [late.status, late.body]);

    console.log('\n== A reviewer can set them for anyone ==');
    const teamId = (await db.get('SELECT id FROM abstracts WHERE phone_number = ?', [phones.team])).id;
    const byAdmin = await call('PUT', `/api/abstracts/${teamId}/authors`, { authors: [{ name: 'Dr Team Corrected', presenting: true }, { name: 'Co One' }, { name: 'Co Two' }] }, admin);
    check('after the last date too, correcting the presenting author\'s spelling', byAdmin.body.success === true
      && A.authorsText(byAdmin.body.authors) === 'Dr Team Corrected*, Co One, Co Two', byAdmin.body);
    check('a delegate cannot use that route', [401, 403].includes((await call('PUT', `/api/abstracts/${teamId}/authors`, { authors: [{ name: 'x', presenting: true }] }, cookies.team)).status));
    check('an unknown abstract is not found', (await call('PUT', '/api/abstracts/99999999/authors', { authors: [me] }, admin)).status === 404);

    console.log('\n== Where the list shows ==');
    const list = (await call('GET', '/api/abstracts', null, admin)).body;
    const row = list.abstracts.find((a) => a.id === teamId);
    check('the admin list carries it, and whether it was given', row && row.authors.length === 3 && row.authors_given === true
      && list.abstracts.find((a) => a.title === `Rejected ${N}`).authors_given === false, row);
    check('...and the window', list.authorsWindow && list.authorsWindow.open === false && list.authorsWindow.max === 6, list.authorsWindow);
    const pdf = await call('GET', `/api/abstracts/${teamId}/pdf`, null, admin);
    check('the PDF still downloads', pdf.status === 200);
    const pdfSrc = fs.readFileSync(appFile('abstract-pdf.js'), 'utf8');
    check('...and draws every author, the presenting one underlined', /author_list/.test(pdfSrc) && /underline: authors\.length > 1 && a\.presenting/.test(pdfSrc));
    await db.run("UPDATE abstracts SET status = 'ACCEPTED' WHERE id = ?", [teamId]);
    const rep = (await call('GET', '/api/admin/reports/abstracts?format=json', null, admin)).body.report;
    const section = rep.sections[0];
    const line = section.rows.find((r) => r[0] === `Team ${N}`);
    check('the accepted-abstracts report lists the authors in order', section.columns.includes('Authors') && line && line[1] === 'Dr Team Corrected*, Co One, Co Two', [section.columns, line]);

    console.log('\n== The reminder audience ==');
    const aud = (await call('GET', '/api/admin/reminders/audiences', null, admin)).body.audiences.find((a) => a.key === 'abstract_authors');
    check('"Abstract authors not added" is offered', !!aud && aud.group === 'Abstracts', aud);
    await setLast(istDay(3));
    await call('PUT', '/api/abstracts/me/authors', { authors: [{ name: 'x', presenting: true }] }, cookies.team);
    await db.run('UPDATE abstracts SET authors = NULL WHERE phone_number = ?', [phones.sole]);
    const people = (await call('GET', '/api/admin/reminders/audiences/abstract_authors/recipients', null, admin)).body;
    const ids = (people.recipients || []).map((p) => p.id);
    check('it holds those still listing only themselves, and not those done or rejected',
      ids.includes(phones.sole) && !ids.includes(phones.team) && !ids.includes(phones.rejected), ids.filter((i) => Object.values(phones).includes(i)));

    console.log('\n== The screens ==');
    const js = fs.readFileSync(appFile('public/app.js'), 'utf8');
    const portal = (await call('GET', '/', null, cookies.sole)).raw || '';
    check('the delegate page has the authors box and the Authors modal', /id="abstract-authors-box"/.test(portal) && /id="modal-abstract-authors"/.test(portal));
    check('...and the submission form asks for authors', /id="abstract-form-authors"/.test(portal));
    const adminPage = (await call('GET', '/admin', null, admin)).raw || '';
    check('the admin panel has the Authors modal, the summary and the last-date setting',
      /id="modal-abstract-authors"/.test(adminPage) && /id="abstracts-authors-summary"/.test(adminPage) && /id="gs-conf-authorsdeadline"/.test(adminPage));
    check('authors move with arrows and the presenting one cannot be removed',
      /function moveAuthor\(/.test(js) && /removeAuthor[\s\S]{0,200}presenting\) return/.test(js));
    check('the review modal shows them, with Edit authors', /abstractAuthorsReviewHtml\(a\) \+ abstractSectionsHtml\(a\)/.test(js) && /openAbstractAuthors\(\$\{esc\(a\.id\)\}\)/.test(js));
    check('a reminder template asks for them', /'abstract-add-authors'/.test(js) && /abstract_authors: 'abstract-add-authors'/.test(js));
  } finally {
    await setLast(original);
    await call('PUT', '/api/admin/general-settings', { conference: { abstractDeadline: originalAbstract } }, admin);
    for (const p of Object.values(phones)) {
      await db.run(`DELETE FROM audit_log WHERE entity_type = 'abstract' AND entity_id IN (SELECT CAST(id AS TEXT) FROM abstracts WHERE phone_number = ?)`, [p]);
      await db.run('DELETE FROM abstracts WHERE phone_number = ?', [p]);
      await db.run('DELETE FROM users WHERE phone_number = ?', [p]);
    }
  }
  check('the last date for authors is put back', ((await settings()).authorsDeadline || '') === original);
  const left = await db.get('SELECT COUNT(*) AS n FROM abstracts WHERE phone_number IN (?, ?, ?)', Object.values(phones));
  check('nothing this file made is left in the fixture', left.n === 0, left.n);
  db.close();
  report();
})();
