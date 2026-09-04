// Admin panel redesign, phase 07: each of the 9 activity-log panels gets its
// own client-side filter box (there was previously no way to search within
// a growing log at all) -- filterActivityRows() hides/shows <tr> rows in
// that panel's own tbody by a case-insensitive text match, same approach as
// the existing generic report-row filter. Isolates the function directly
// (it only touches the DOM, no other app.js internals) rather than driving
// the whole render pipeline.
const { check, report, appFile } = require('./harness');
const fs = require('fs');
const vm = require('vm');

function makeRow(text) {
  const cls = new Set();
  return {
    textContent: text,
    classList: {
      toggle(k, on) { on ? cls.add(k) : cls.delete(k); },
      contains(k) { return cls.has(k); },
    },
  };
}

function makeTbody(rows) {
  return { querySelectorAll: () => rows };
}

(async () => {
  const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
  const src = js.match(/function filterActivityRows\([\s\S]*?\n}/);
  check('filterActivityRows is defined', !!src, 'function not found in app.js');
  if (!src) return report();

  const rows = [
    makeRow('9000000001 Verified UPI'),
    makeRow('9000000002 Rejected NEFT'),
    makeRow('Dr Jane Doe Pending'),
  ];
  const els = {
    'activity-search-approval': { value: '' },
    'activity-approval-body': makeTbody(rows),
  };
  const doc = { getElementById: (id) => els[id] || null };
  const fn = new Function('document', `${src[0]}\nreturn filterActivityRows;`)(doc);

  console.log('\n== An empty filter shows every row ==');
  els['activity-search-approval'].value = '';
  fn('approval');
  check('all three rows visible', rows.every((r) => !r.classList.contains('hidden')));

  console.log('\n== A query hides non-matching rows, case-insensitively ==');
  els['activity-search-approval'].value = 'rejected';
  fn('approval');
  check('the matching row stays visible', !rows[1].classList.contains('hidden'));
  check('the two non-matching rows are hidden', rows[0].classList.contains('hidden') && rows[2].classList.contains('hidden'));

  console.log('\n== Matches against the whole row text, not just one column ==');
  els['activity-search-approval'].value = 'jane';
  fn('approval');
  check('matched by a name that appears anywhere in the row', !rows[2].classList.contains('hidden'));
  check('the other two are hidden', rows[0].classList.contains('hidden') && rows[1].classList.contains('hidden'));

  console.log('\n== Clearing the filter restores every row ==');
  els['activity-search-approval'].value = '';
  fn('approval');
  check('all visible again', rows.every((r) => !r.classList.contains('hidden')));

  console.log('\n== Missing input/tbody is a no-op, not a crash ==');
  let threw = null;
  try { fn('does-not-exist'); } catch (e) { threw = e; }
  check('unknown key does not throw', !threw, threw && threw.message);

  console.log('\n== Every panel has its own search box wired to it ==');
  const ejs = fs.readFileSync(appFile('views', 'admin', 'sections', 'activity.ejs'), 'utf8');
  check('9 activity keys declared', (ejs.match(/key: '[\w-]+'/g) || []).length === 9,
    (ejs.match(/key: '[\w-]+'/g) || []).length);
  check('the filter input is wired per-panel via the same key', /oninput="filterActivityRows\('<%= log\.key %>'\)"/.test(ejs));

  report();
})();
