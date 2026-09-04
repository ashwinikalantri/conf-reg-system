// Admin panel redesign, phase 03: status pills and category/attribute
// badges across payments, statement, review, users, abstracts, group
// discount, roles, reminders, and the ledger's payment-mode tag used to be
// a mix of ~20 ad hoc shapes -- some bordered, most not, sizes ranging from
// px-2 py-0.5 text-[10px] to px-2.5 py-1 text-xs with no consistent rule.
// They now share exactly two deliberate shapes: a "standard" pill for
// prominent single-status indicators (text-xs px-2.5 py-1 rounded-full
// border) and a "compact" one for dense inline contexts (text-[10px] px-2
// py-0.5 rounded-full border) -- colour is the only thing that varies
// within each tier. This checks the source directly (regex, not a DOM
// render) since these are template-literal-built strings scattered across
// many render functions rather than one place to drive.
const { check, report, appFile } = require('./harness');
const fs = require('fs');

const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');

console.log('\n== Standard-tier pills: payments, review verdict, users, abstracts, group discount ==');
check('paymentRowHtml\'s status pill is bordered, standard size',
  /const statusPill = `<span class="\$\{statusTone2\} text-xs px-2\.5 py-1 rounded-full font-bold border">/.test(js));
check('paymentRowHtml\'s tone map carries a border colour for every state',
  /statusTone = p\.bank_status === 'REJECTED' \? 'bg-rose-100 text-rose-800 border-rose-300'/.test(js) &&
  /: p\.bank_status === 'BANK_VERIFIED' \? 'bg-emerald-100 text-emerald-800 border-emerald-300'/.test(js) &&
  /: p\.bank_status === 'PARTIAL_PAYMENT' \? 'bg-orange-100 text-orange-800 border-orange-300'/.test(js) &&
  /: 'bg-amber-100 text-amber-800 border-amber-300'/.test(js));
check('review-modal verdict pill is the canonical shape',
  /verdict\.className = `text-xs font-bold px-2\.5 py-1 rounded-full border \$\{pillTone\}`/.test(js));
check('review verdict tone map is bordered for all four states',
  ['BANK_VERIFIED', 'REJECTED', 'PARTIAL_PAYMENT', 'PENDING'].every((k) => new RegExp(`${k}: \\['[^']+', '[^']*border-[\\w]+-300'`).test(js)));
check('REG_STATUS_STYLES (users table) is bordered for all four states',
  /BANK_VERIFIED: 'bg-emerald-100 text-emerald-800 border-emerald-300'/.test(js) &&
  /PENDING: 'bg-amber-100 text-amber-800 border-amber-300'/.test(js) &&
  /REJECTED: 'bg-rose-100 text-rose-800 border-rose-300'/.test(js) &&
  /PARTIAL_PAYMENT: 'bg-orange-100 text-orange-800 border-orange-300'/.test(js));
check('the users-table render call uses the canonical shape',
  /text-xs font-bold px-2\.5 py-1 rounded-full border">\$\{esc\(BANK_STATUS_LABELS/.test(js));
check('ABSTRACT_STATUS_STYLES is bordered for all four states',
  /UNDER_REVIEW: 'bg-amber-100 text-amber-800 border-amber-300'/.test(js) &&
  /ACCEPTED: 'bg-emerald-100 text-emerald-800 border-emerald-300'/.test(js) &&
  /REVISION_REQUESTED: 'bg-orange-100 text-orange-800 border-orange-300'/.test(js));
check('abstractCardHeader\'s badge render uses the canonical shape',
  /\$\{badge\} text-xs px-2\.5 py-1 rounded-full font-bold border whitespace-nowrap/.test(js));
check('group-discount status badges are canonical size (were px-2 py-0.5 text-[11px])',
  /text-xs font-bold text-emerald-800 bg-emerald-100 border border-emerald-300 rounded-full px-2\.5 py-1/.test(js) &&
  /text-xs font-bold text-indigo-800 bg-indigo-100 border border-indigo-300 rounded-full px-2\.5 py-1/.test(js) &&
  /text-xs font-bold text-amber-800 bg-amber-100 border border-amber-300 rounded-full px-2\.5 py-1/.test(js));

console.log('\n== Compact-tier pills: role editor, Faculty tags, reminder recipient tags, payment-mode ==');
check('activityPill (the exemplar) is unchanged: text-[10px] px-2 py-0.5 rounded-full border',
  /text-\[10px\] font-bold px-2 py-0\.5 rounded-full border \$\{tones\[tone\]/.test(js));
check('role editor\'s two "Built-in" badges are bordered',
  (js.match(/Built-in[^<]*<\/span>/g) || []).length >= 1 &&
  /bg-indigo-100 text-indigo-700 border border-indigo-300 px-2 py-0\.5 rounded-full font-bold">Built-in · every permission/.test(js) &&
  /bg-slate-100 text-slate-600 border border-slate-300 px-2 py-0\.5 rounded-full font-bold">Built-in</.test(js));
check('both Faculty tags are bordered and no longer forced uppercase',
  (js.match(/bg-indigo-100 text-indigo-700 border border-indigo-300 px-2 py-0\.5 rounded-full font-bold align-middle">Faculty<\/span>/g) || []).length === 2);
check('both "No email" reminder tags are bordered',
  (js.match(/bg-rose-100 text-rose-700 border border-rose-300 px-2 py-0\.5 rounded-full font-bold shrink-0">No email<\/span>/g) || []).length === 2);
check('both "Sent within 24h" reminder tags are bordered',
  (js.match(/bg-amber-100 text-amber-700 border border-amber-300 px-2 py-0\.5 rounded-full font-bold shrink-0">Sent within 24h<\/span>/g) || []).length === 2);
check('the payment-mode ledger tag is bordered and font-bold (was font-semibold, no border)',
  /bg-slate-100 text-slate-600 border border-slate-300 text-\[10px\] font-bold px-2 py-0\.5 rounded-full">\$\{esc\(PAYMENT_MODE_LABELS/.test(js));
check('review-category-locked-badge (fixed during the icon pass) already matches the compact spec',
  /text-\[10px\] font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-full px-2 py-0\.5/.test(
    fs.readFileSync(appFile('views', 'admin', 'modals', 'review.ejs'), 'utf8')));
check('the Matched table\'s "rejected" tag (found during phase 09/10\'s statement pass, missed here because it used plain `rounded` not `rounded-full`)',
  /text-\[10px\] font-bold text-rose-800 bg-rose-100 border border-rose-300 rounded-full px-2 py-0\.5">rejected<\/span>/.test(js));
check('no more compact badges use plain `rounded` with `font-bold` instead of `rounded-full`',
  !/font-bold[^"]*\brounded\b(?!-)[^"]*px-\d/.test(js) && !/\brounded\b(?!-)[^"]*px-\d[^"]*font-bold/.test(js));
check('paymentRowHtml\'s "Category changed" hint is canonical (found in phase 14\'s final sweep)',
  js.includes('bg-orange-100 border border-orange-300 rounded-full px-2 py-0.5">${ICON(\'warning\')}Category changed'));
check('paymentRowHtml\'s "excess paid" pill is canonical (found in phase 14\'s final sweep)',
  js.includes('bg-amber-100 border border-amber-300 rounded-full px-2 py-0.5">${ICON(\'coin\')}₹'));
check('paymentRowHtml\'s two Flagged badges (mobile + desktop) are canonical shape, red kept deliberately (a distinct \'needs scrutiny\' signal from rose=\'rejected\')',
  (js.match(/bg-red-100 text-red-800 px-2 py-0\.5 rounded-full border border-red-300 font-bold">\$\{ICON\('warning'\)\}Flagged<\/span>/g) || []).length === 2);

console.log('\n== Deliberately untouched: count badges are a different component, not a status pill ==');
check('nav-tab / header / payments count badges stay as they were (quantity, not state)',
  /bg-amber-100 text-amber-800 text-xs px-2 py-0\.5 rounded-full font-bold">0<\/span>/.test(
    fs.readFileSync(appFile('views', 'admin', 'partials', 'nav-tabs.ejs'), 'utf8')));

report();
