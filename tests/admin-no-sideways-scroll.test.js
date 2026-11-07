// The admin panel never scrolls sideways (7 Nov 2026). A wide table is a
// table only where it fits: elsewhere it is one card per row (data-fit and
// fitTable), or cards drawn for phones and tablets with the table from a
// laptop up (lg:). And controls that sit side by side share one height.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, report, appFile } = require('./harness');

const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
const css = fs.readFileSync(appFile('public', 'styles.css'), 'utf8');
const dir = appFile('views', 'admin', 'sections');
const sections = Object.fromEntries(fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));

console.log('\n== Every wide table has a way to fit ==');
// A table with a fixed minimum width: either it stacks (data-fit), or the
// minimum applies only from a laptop up (lg:min-w), or the table sits in a
// box shown only from a laptop up (hidden lg:block).
const wide = [];
// The narrowest the page is at each breakpoint, less its side padding.
const ROOM = { '': 300, sm: 570, md: 700, lg: 950, xl: 1200 };
const scan = (name, text) => {
  const re = /<table[^>]*\bmin-w-\[[^\]]+\][^>]*>/g;
  let m;
  while ((m = re.exec(text))) {
    const tag = m[0];
    const before = text.slice(Math.max(0, m.index - 300), m.index);
    const mins = [...tag.matchAll(/(?:^|[\s"])(?:(sm|md|lg|xl):)?min-w-\[(\d+)(px|rem)\]/g)]
      .map(([, bp, n, unit]) => ({ bp: bp || '', px: Number(n) * (unit === 'rem' ? 16 : 1) }));
    const ok = /data-fit=/.test(tag) || /hidden lg:block[^>]*>\s*$/.test(before) || (mins.length && mins.every((x) => x.px <= ROOM[x.bp]));
    wide.push({ name, ok, tag: tag.slice(0, 120) });
  }
};
for (const [f, t] of Object.entries(sections)) scan(f, t);
scan('app.js', js);
const stuck = wide.filter((w) => !w.ok);
check(`all ${wide.length} wide tables stack, or wait for a laptop`, wide.length >= 8 && !stuck.length, stuck);
check('the Bank statement tables are cards until a laptop', !/hidden sm:table-header-group/.test(sections['statement.ejs'])
  && (sections['statement.ejs'].match(/hidden lg:table-header-group/g) || []).length === 6);
check('the Faculty tabs wrap rather than swipe', /id="guests-subnav" role="tablist" class="flex flex-wrap/.test(sections['guests.ejs']));

console.log('\n== A table that does not fit becomes cards ==');
check('the stacked look: no header, each cell under its column name', /table\.is-stacked thead \{ display: none; \}/.test(css)
  && /table\.is-stacked td::before \{\s*content: attr\(data-label\)/.test(css) && /table\.is-stacked \{ min-width: 0 !important; \}/.test(css));
const grab = (n) => { const i = js.indexOf(`function ${n}(`); return js.slice(i, js.indexOf('\n}', i) + 2); };
const sb = {};
vm.createContext(sb);
vm.runInContext(`${grab('fitTable')}\nglobalThis.fit = fitTable;`, sb);
const cell = (colSpan = 1) => ({ colSpan, dataset: {} });
const make = (boxWidth, need) => {
  const cls = new Set();
  const heads = [{ colSpan: 1, textContent: 'Code' }, { colSpan: 1, textContent: ' Valid\n  until ' }, { colSpan: 1, textContent: '' }];
  const rows = [{ cells: [cell(), cell(), cell()] }, { cells: [cell(3)] }];
  return {
    dataset: { fit: String(need) }, parentElement: { clientWidth: boxWidth }, rows,
    classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), has: (c) => cls.has(c) },
    querySelectorAll: (q) => (q.startsWith('thead') ? heads : rows),
  };
};
const narrow = make(326, 820);
sb.fit(narrow);
check('narrower than it needs: stacked', narrow.classList.has('is-stacked'));
check('...each cell named from its column, spaces tidied', narrow.rows[0].cells[0].dataset.label === 'Code' && narrow.rows[0].cells[1].dataset.label === 'Valid until');
check('...the actions column and a full-width row get no name', narrow.rows[0].cells[2].dataset.label === '' && narrow.rows[1].cells[0].dataset.label === '');
const roomy = make(958, 820);
sb.fit(roomy);
check('where it fits: a table', !roomy.classList.has('is-stacked'));
const hiddenBox = make(0, 820);
sb.fit(hiddenBox);
check('in a hidden panel: left alone until it is shown', !hiddenBox.classList.has('is-stacked') && hiddenBox.rows[0].cells[0].dataset.label === undefined);
const lineList = (offsetWidth, boxWidth) => {
  const cls = new Set(['is-carded']);
  return { dataset: { fit: 'cards' }, parentElement: { clientWidth: boxWidth }, offsetWidth,
    classList: { remove: (c) => cls.delete(c), toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), has: (c) => cls.has(c) } };
};
const tooWide = lineList(1600, 980);
sb.fit(tooWide);
const fits = lineList(900, 980);
sb.fit(fits);
check('a report wider than its box: cards; one that fits: a table, measured afresh', tooWide.classList.has('is-carded') && !fits.classList.has('is-carded'));
check('a report too wide for its box shows each row\'s card', /<table data-fit="cards"/.test(js) && /td class="report-card /.test(js) && /td class="report-cell /.test(js)
  && /table\.is-carded td\.report-card \{ display: block !important; \}/.test(css) && /\$\{rep\.sections\.map\(table\)\.join\(''\)\}<\/div>`\}`;\n  watchFitTables\(\);/.test(js));
check('watched for new rows and a new size', /new MutationObserver\(\(\) => fitTable\(t\)\)\.observe\(t, \{ childList: true, subtree: true \}\)/.test(js)
  && /fitTableSizes\.observe\(t\.parentElement\)/.test(js) && /document\.addEventListener\('DOMContentLoaded', watchFitTables\)/.test(js));
for (const [f, w] of [['fees.ejs', 1140], ['users.ejs', 720], ['discount.ejs', 820], ['groupdiscount.ejs', 640]]) {
  check(`${f.replace('.ejs', '')}: stacks below ${w}px`, sections[f].includes(`<table data-fit="${w}"`));
}

console.log('\n== Side by side, one height ==');
check('Halls: the four boxes in a grid that fits, the buttons one height', /prog-hall-name w-full min-w-0 h-9/.test(js)
  && /QR poster/.test(js) && ['>Save', '>QR poster', '>New QR', ">${h.active ? 'Turn off'"].every((b) => js.includes(`inline-flex items-center h-8 px-3 rounded-lg text-xs font-semibold`) && new RegExp(`h-8 px-3 rounded-lg text-xs font-semibold[^"]*"${b.replace(/[$?{}()]/g, '\\$&')}`).test(js)));
check('Signatories: the boxes never shrink to nothing', (js.match(/cs-sig-field w-full min-w-0 h-9/g) || []).length === 2);
check('Workshops: an option\'s boxes and buttons are all h-8', ['prog-name w-full h-8', 'prog-capacity w-20 h-8', 'prog-fee w-24 h-8', 'prog-save h-8', 'prog-roster h-8', 'prog-toggle h-8', 'prog-delete h-8'].every((c) => js.includes(c)));
check('Fees: the dates and Save Dates are h-10', (sections['fees.ejs'].match(/type="date" id="fee-\w+-until" class="h-10/g) || []).length === 3 && /saveFeeConfig\(\)" class="h-10/.test(sections['fees.ejs']));
check('Category and role: the select and its button match', /review-category-select" class="flex-1 min-w-0 h-10/.test(fs.readFileSync(appFile('views', 'admin', 'modals', 'review.ejs'), 'utf8'))
  && /user-detail-role-select[^>]*class="flex-1 min-w-0 h-10/.test(js) && /saveUserDetailRole\(\)" [^>]*class="h-10/.test(js));

report();
