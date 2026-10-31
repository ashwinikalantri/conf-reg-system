// The Reports tab, redesigned (31 Oct 2026, from the "Admin Reports"
// canvas): the reports grouped on the left, the one chosen open on the
// right with Excel and PDF at its top; the Summary read as figures; line
// lists with their headings in view and a search that narrows the view;
// rosters pick their workshop first. Each report shows only for a role
// holding its permission, the users report ("All accounts") included.
const { check, report, appFile, call, adminLogin } = require('./harness');
const fs = require('fs');
const vm = require('vm');

const view = fs.readFileSync(appFile('views', 'admin', 'sections', 'reports.ejs'), 'utf8');
const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
const css = fs.readFileSync(appFile('public', 'styles.css'), 'utf8');

console.log('\n== The page ==');
const order = ['report-summary', 'report-delegates', 'report-delegate-programs', 'report-users', 'report-payments', 'report-workshops', 'report-abstracts'];
check('every report in the list, grouped: at a glance, people, money, programme, abstracts',
  order.every((id, i) => view.indexOf(`id="${id}"`) > (i ? view.indexOf(`id="${order[i - 1]}"`) : 0))
  && ['At a glance', 'People', 'Money', 'Programme', 'Abstracts'].every((g) => view.includes(`<p class="rep-group">${g}</p>`)));
check('each opens with one tap, no separate View button', order.every((id) => new RegExp(`id="${id}" data-report="[^"]+" onclick="openReport\\('[^']+'\\)" class="rep-item"`).test(view))
  && !/onclick="(viewReport|downloadReport)/.test(view));
check('the one open in pale gold, like the bar', /\.rep-item\[aria-current="true"\] \{ background: #faf5e8; \}/.test(css) && /\.rep-item\.hidden, \.rep-group\.hidden \{ display: none; \}/.test(css));
check('a roster picks its workshop above the report', /id="report-workshop-pick" class="hidden[^"]*">[\s\S]*?<select id="report-workshop-select"/.test(view));
check('on a phone: the list, then the report in its place, with a way back', /id="report-pane" class="min-w-0 hidden lg:block"/.test(view) && /onclick="closeReport\(\)"/.test(view)
  && /list\.classList\.add\('max-lg:hidden'\)/.test(js));
check('the users report has its own permission behind it', /'report-users': 'reports\.users',/.test(js));

// The pure pieces, run.
const sb = { console };
vm.createContext(sb);
const pick = (name) => { const i = js.indexOf(`function ${name}(`); return js.slice(js.lastIndexOf('\n', i), js.indexOf('\n}\n', i) + 3); };
vm.runInContext(`${pick('esc')}\n${pick('reportSummaryHtml')}\nglobalThis.f = reportSummaryHtml;`, sb);

(async () => {
  console.log('\n== The Summary, as figures ==');
  const cookie = await adminLogin();
  const sum = await call('GET', '/api/admin/reports/summary?format=json', null, cookie);
  check('the summary still comes as sections', sum.body && sum.body.success && Array.isArray(sum.body.report.sections), sum.status);
  const html = sb.f(sum.body.report);
  const regs = sum.body.report.sections.find((s) => s.name === 'Registrations');
  const submitted = regs && regs.rows.find((r) => String(r[0]).startsWith('Registrations submitted'));
  check('the headline figures first: submitted, confirmed, collected', submitted && html.indexOf('Registrations submitted') < html.indexOf('Confirmed, paid and verified')
    && html.indexOf('Confirmed, paid and verified') < html.indexOf('>Collected<') && new RegExp(`>${submitted[1]}</p>`).test(html), html.slice(0, 600));
  check('money shows the amount, with how many beside it', /Collected — verified payments<\/span>\s*<span[^>]*><b[^>]*>₹/.test(html));
  check('the occupancy table in full', /<h4[^>]*>Programme occupancy<\/h4>[\s\S]*?<th[^>]*>Seats left<\/th>/.test(html));

  console.log('\n== The roster picker says how full each is ==');
  const opts = await call('GET', '/api/admin/reports/workshops/options', null, cookie);
  check('each option with its capacity and how many enrolled', opts.body && opts.body.options.length > 0 && opts.body.options.every((o) => Number.isInteger(o.capacity) && Number.isInteger(o.enrolled)));
  check('...shown as "(n of capacity)"', /\$\{Number\(o\.enrolled\) \|\| 0\} of \$\{Number\(o\.capacity\)\}/.test(js));
  report();
})();
