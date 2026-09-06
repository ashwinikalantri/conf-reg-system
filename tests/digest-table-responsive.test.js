// The daily digest's pending-approvals table ran off the side of a phone.
//
// The cause was not the number of columns so much as what was in them: with
// the default auto layout a browser widens a column to fit its longest word,
// and a 13-character monospace registration number beside "Nurse / Community
// Health Officer" pushes the table past a 320px viewport. The mail client
// then either scrolls sideways or shrinks the whole message to fit.
//
// It cannot be fixed with a media query. email-template.js is deliberately a
// fragment with every style inline, because Gmail strips <style> blocks --
// there is nowhere for a breakpoint to live. So the fix is table-layout:fixed
// with percentage widths, which caps the columns at the container and makes
// long values wrap instead, and works in every client because it is one
// inline declaration.
//
// The Flag column is gone: a whole column of em-dashes was a poor trade for
// the width it cost. The signal is kept as a marker on the name, where it
// costs a character rather than a column.
const { check, report, appFile } = require('./harness');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(appFile('scripts', 'daily-digest.js'), 'utf8');
// Requiring this used to SEND the digest -- main() ran at import. It is
// guarded now, which is the only reason this file can test the real builder
// rather than a regex over its source.
const { buildDigestHtml } = require(path.join(__dirname, '..', 'scripts', 'daily-digest.js'));

// Real shapes: the longest category label on file, and a registration number
// at its actual length. Short fixtures would fit anything and prove nothing.
const PENDING = [
  { registration_number: 'NQOCN20261164', delegate_name: 'Priyanka A. Pothare', delegate_salutation: 'Dr',
    category_label: 'Nurse / Community Health Officer', expected_amount: 2000, is_flagged: 0 },
  { registration_number: 'NQOCN20261432', delegate_name: 'Shaikh Mohammed Hasan Mohammed Rafique', delegate_salutation: 'Mr',
    category_label: 'Medical Student (UG)', expected_amount: 1500, is_flagged: 1 },
];
const html = buildDigestHtml(PENDING, 2, 197, 3, 8, 1, '6 September 2026');
const headers = [...html.matchAll(/<th style="([^"]*)"[^>]*>([^<]*)</g)].map((m) => ({ style: m[1], label: m[2] }));

console.log('\n== Importing the digest no longer sends it ==');
check('the builder is exported', typeof buildDigestHtml === 'function');
check('...and main() only runs when invoked as a script',
  /if \(require\.main === module\)/.test(src));

console.log('\n== The Flag column is gone ==');
check('no Flag header remains', !headers.some((h) => h.label.trim() === 'Flag'),
  headers.map((h) => h.label));
check('four columns, not five', headers.length === 4, headers.length);
check('...and they are the ones worth the width',
  headers.map((h) => h.label.trim()).join('|') === 'Reg No|Name|Category|Amount',
  headers.map((h) => h.label.trim()));
check('the empty-state row spans the new column count',
  /colspan="4"/.test(src) && !/colspan="5"/.test(src));

console.log('\n== ...but the flag itself is not lost ==');
// A flagged registration is the one most worth opening, so dropping the
// column must not drop the signal with it.
check('a flagged row still carries a marker', html.includes('⚠️'));
const rows = [...html.matchAll(/<tr style="border-bottom[^"]*">([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
check('...on the flagged row', rows[1].includes('⚠️'), rows[1].slice(0, 80));
check('...and not on the unflagged one', !rows[0].includes('⚠️'));
// The old column printed an em-dash for every unflagged row -- a column of
// nothing, which is what made it not worth its width.
check('an unflagged row spends no width saying so', !rows[0].includes('—'));

console.log('\n== The table cannot outgrow its container ==');
check('layout is fixed, not auto', /table-layout:fixed/.test(html));
check('...and the table is bounded', /max-width:100%/.test(html));
const widths = headers.map((h) => Number((h.style.match(/width:(\d+)%/) || [])[1]));
check('every column has a declared width', widths.every((w) => w > 0), widths);
// Fixed layout divides the container by these; anything but 100 leaves the
// table either short of the width or over it.
check('and they total exactly 100%', widths.reduce((a, b) => a + b, 0) === 100,
  widths.reduce((a, b) => a + b, 0));

console.log('\n== Long values wrap rather than pushing the table wide ==');
const cells = [...html.matchAll(/<td style="([^"]*)"/g)].map((m) => m[1]);
check('the registration number may break', cells[0].includes('word-break:break-word'), cells[0]);
check('the name may break', cells[1].includes('word-break:break-word'));
check('the category may break', cells[2].includes('word-break:break-word'));
// Money is the one thing that must not: "₹1,500" broken across two lines is
// harder to read than a slightly wider column.
check('the amount may NOT break', cells[3].includes('white-space:nowrap'), cells[3]);
check('...and it is the only cell in each row held that way',
  cells.filter((c) => c.includes('white-space:nowrap')).length === rows.length,
  { nowrapCells: cells.filter((c) => c.includes('white-space:nowrap')).length, rows: rows.length });

console.log('\n== It stays a fragment with inline styles, as the template requires ==');
// A media query would be the obvious fix and does not work here: Gmail
// strips <style> blocks, which is why email-template.js returns a fragment
// with everything inline in the first place.
check('the digest adds no <style> block', !/<style[\s>]/i.test(html));
check('...and no media query', !/@media/.test(html));
check('...so the fix lives in inline declarations', /style="[^"]*table-layout:fixed/.test(html));

console.log('\n== The rest of the digest still reads correctly ==');
check('both pending rows render', rows.length === 2, rows.length);
check('the amounts are formatted', html.includes('₹2,000') && html.includes('₹1,500'));
check('the long category survives intact, just wrapped',
  html.includes('Nurse / Community Health Officer'));
check('names carry their salutation', html.includes('Dr Priyanka A. Pothare'));
check('the summary tiles are still there', html.includes('Pending Approval')
  && html.includes('Abstracts Submitted'));
check('and the call to action still points at the approval screen',
  /\/admin"[^>]*>Open Registration Approval/.test(html));

console.log('\n== An empty day says so instead of drawing an empty table ==');
const none = buildDigestHtml([], 0, 197, 3, 8, 1, '6 September 2026');
check('no table is drawn', !/<table/.test(none));
check('...it says nothing is pending', /Nothing pending approval right now/.test(none));

report();
