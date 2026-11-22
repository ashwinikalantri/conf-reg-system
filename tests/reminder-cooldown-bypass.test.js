// The 24-hour limit, set aside for one send (owner, 22 Nov 2026): a box in
// Send to, off by default and off again after each send; the server skips
// the cooldown only when asked, and the Sent history says so. Email is off
// in the fixture, so the send is checked from its code, as the other sends.
const { check, report, appFile } = require('./harness');
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(appFile('server.js'), 'utf8');
const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
const ejs = fs.readFileSync(appFile('views', 'admin', 'sections', 'reminders.ejs'), 'utf8');
const fn = (text, start) => { const i = text.indexOf(start); return text.slice(i, text.indexOf('\n}\n', i) + 3); };

const send = fn(src, 'async function sendReminder(');
check('the server sets the limit aside only when asked, in so many words', /const ignoreCooldown = req\.body\.ignoreCooldown === true;/.test(send));
check('...for people in an audience', /m\.last_reminder_sent_at >= since && !ignoreCooldown\) \{ outcomes\.push\(\{ \.\.\.m, outcome: 'cooldown' \}\)/.test(send));
check('...and for pasted addresses', /recent\.has\(addr\) && !ignoreCooldown\) \{ outcomes\.push/.test(send));
check('...and the send records it', /recordReminderSend\(req, a, filters, subject, bodyHtml, outcomes, ignoreCooldown\)/.test(send)
  && /\.\.\.\(ignoredCooldown \? \{ ignoredCooldown: true \} : \{\}\)/.test(fn(src, 'async function recordReminderSend(')));

check('the box in Send to, off by default', /<input type="checkbox" id="rem-ignore-cooldown" onchange="setReminderIgnoreCooldown\(this\.checked\)"/.test(ejs)
  && !/id="rem-ignore-cooldown"[^>]*\schecked[\s>=]/.test(ejs) && /Include people emailed in the last 24 hours/.test(ejs));
check('the send carries it, says so in the confirm, and turns it off after', /ignoreCooldown: remState\.ignoreCooldown \}/.test(js)
  && /including anyone emailed in the last 24 hours/.test(js) && /remState\.ignoreCooldown = false;\n  const ignoreBox/.test(js));
check('the Sent history marks it, and does not count it as skipped', /k === 'ignoredCooldown' \? 0/.test(js) && /24-hour limit set aside/.test(js));

// Who can be ticked: with the box off, not someone emailed an hour ago.
const sb = { Date, remState: { ignoreCooldown: false, recipients: [], selected: new Set() }, renderReminderRecipients() {} };
vm.createContext(sb);
vm.runInContext(`${js.match(/const REMINDER_COOLDOWN_MS = [^\n]+/)[0]}
${js.match(/const reminderOnCooldown = [^\n]+/)[0]}
${js.match(/const reminderSelectable = [^\n]+/)[0]}
${fn(js, 'function setReminderIgnoreCooldown(')}
this.sel = reminderSelectable; this.setIgnore = setReminderIgnoreCooldown;`, sb);
const recent = { id: '1', email: 'a@example.test', last_reminder_sent_at: Date.now() - 3600 * 1000 };
const fresh = { id: '2', email: 'b@example.test', last_reminder_sent_at: null };
sb.remState.recipients = [recent, fresh];
check('box off: someone emailed an hour ago cannot be chosen', !sb.sel(recent) && sb.sel(fresh));
sb.setIgnore(true);
check('box on: they can', sb.sel(recent) && sb.remState.ignoreCooldown === true);
sb.remState.selected = new Set(['1', '2']);
sb.setIgnore(false);
check('box off again: they drop out of the selection, the rest stay', [...sb.remState.selected].join() === '2');
check('no email is still no email', !sb.sel({ id: '3', email: '', last_reminder_sent_at: null }));
report();
