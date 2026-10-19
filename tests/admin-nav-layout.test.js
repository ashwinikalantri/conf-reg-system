// Admin navigation: Bank statement is a sub-menu of Registration (one tab in
// the bar), and Attendance and Programme live in the Settings menu, Programme
// as its own page rather than a view of Attendance.
const { check, report, appFile } = require('./harness');
const fs = require('fs');
const read = (...p) => fs.readFileSync(appFile(...p), 'utf8');

const tabs = read('views', 'admin', 'partials', 'nav-tabs.ejs');
const header = read('views', 'admin', 'partials', 'header.ejs');
const subtabs = read('views', 'admin', 'partials', 'registration-subtabs.ejs');
const admin = read('views', 'admin.ejs');
const attendance = read('views', 'admin', 'sections', 'attendance.ejs');
const js = read('public', 'app.js');

console.log('\n== Registration and its sub-menu ==');
check('the tab bar has one Registration tab', /id="nav-tab-payments"[\s\S]*?Registration/.test(tabs));
check('...and no separate Bank Statement or Attendance tab', !/nav-tab-statement|nav-tab-attendance/.test(tabs));
check('the sub-menu offers Approval and Bank statement',
  /id="reg-subtab-payments"[^>]*switchBackendTab\('payments'\)/.test(subtabs) && /id="reg-subtab-statement"[^>]*switchBackendTab\('statement'\)/.test(subtabs));
check('...drawn once, above both sections',
  admin.indexOf('registration-subtabs') > 0 && admin.indexOf('registration-subtabs') < admin.indexOf("sections/payments"));
check('the Registration tab stays lit on the statement', /t === 'payments' && tab === 'statement'/.test(js));
check('old #statement links still open it', js.includes("'payments', 'statement'"));

console.log('\n== Settings ==');
check('Attendance and Programme are in the Settings menu',
  /id="settings-item-attendance"/.test(header) && /id="settings-item-programme"/.test(header));
check('both are Settings tabs, not main tabs', /SETTINGS_TABS = \['attendance', 'programme'/.test(js) && !/MAIN_TABS = \[[^\]]*'attendance'/.test(js));
check('the Programme page has the halls and sessions', /id="section-programme"/.test(read('views', 'admin', 'sections', 'programme.ejs')));
check('Attendance no longer has a Programme view', !/data-att-view="programme"|att-view-programme/.test(attendance));
report();
