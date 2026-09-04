// Admin panel redesign, phase 12 (Reminders): every one of the app's other
// 18 irreversible actions confirms through showConfirm() -- a custom modal
// built specifically to replace the browser's native confirm(), which
// Chrome (and others) can suppress after a page has shown a few of them, and
// which some automated/sandboxed contexts don't support at all (see
// #modal-confirm's own comment in confirm.ejs). The three bulk-send actions
// in Reminders -- explicitly labelled "This can't be undone" in their own
// confirmation text, sending real email to potentially hundreds of people --
// were the only three call sites in the whole file still using the raw,
// suppressible confirm(). Checked at the source level: this is a "did we
// call the right function" fact, not app behaviour worth driving a DOM for.
const { check, report, appFile } = require('./harness');
const fs = require('fs');

const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');

console.log('\n== The three reminder bulk-send actions confirm through showConfirm() ==');
const hasShowConfirmBeforeBtn = (btnId) => {
  const btnLine = `const btn = document.getElementById('${btnId}');`;
  const btnIdx = js.indexOf(btnLine);
  if (btnIdx === -1) return false;
  const before = js.slice(Math.max(0, btnIdx - 250), btnIdx);
  return before.includes('await showConfirm(`Send this reminder to') && before.includes("This can't be undone.`)))");
};
check('sendRegistrationReminders uses showConfirm', hasShowConfirmBeforeBtn('reminder-send-btn'));
check('sendBalanceDueReminders uses showConfirm', hasShowConfirmBeforeBtn('bdreminder-send-btn'));
check('sendCustomReminders uses showConfirm',
  js.includes("await showConfirm(`Send this reminder to ${emails.length} entered ${emails.length === 1 ? 'address' : 'addresses'}? This can't be undone.`)))"));

console.log('\n== No raw, suppressible confirm() calls remain as actual function calls ==');
// A bare `if (!confirm(` or `if (!window.confirm(` -- the one legitimate
// window.confirm is showConfirm's own documented fallback when #modal-confirm
// isn't in the DOM, not a live call site elsewhere in the file.
const rawConfirmCalls = [...js.matchAll(/if\s*\(\s*!\s*confirm\(/g)];
check('zero call sites use the raw, suppressible confirm( directly',
  rawConfirmCalls.length === 0, rawConfirmCalls.map((m) => js.slice(Math.max(0, m.index - 20), m.index + 20)));

report();
