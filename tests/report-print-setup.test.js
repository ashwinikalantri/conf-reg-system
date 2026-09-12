// Reports printed as blank pages in Safari, while the payment receipt --
// printed the same way, in the same browser -- came out correctly.
//
// What was ruled out, because the receipt shares it and works:
//   * the Cache-Control: private, no-store header (both routes send it);
//   * the Google webfonts (both load Source Sans 3 and Libre Franklin,
//     display=swap).
//
// What differed, and so what this file pins down: the receipt defines its
// page (@page), resets html and body for print, and is a single page of
// divs. The report was a 12-column table running to ~15 pages with no print
// setup at all -- only its button bar hidden. Large paginated tables are
// where WebKit's printing is fragile, so the report now mirrors the
// receipt's setup and additionally keeps its table inside the page width and
// tells the paginator how to break it.
//
// Safari itself was not available where this was written: these checks pin
// the structure that makes the two pages alike, not a Safari rendering.
const { call, check, report, adminLogin } = require('./harness');

(async () => {
  const admin = await adminLogin();
  const res = await call('GET', '/api/admin/reports/delegates', null, admin);
  const html = typeof res.body === 'string' ? res.body : String(res.body);

  console.log('\n== The report still renders ==');
  check('the report responds', res.status === 200, res.status);
  check('...as an HTML page with its table', /<table>/.test(html) && /<thead>/.test(html));
  check('...and its columns', html.includes('<th>Reg No</th>') && html.includes('<th>Email</th>'));

  const style = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
  // The print block is the one at-rule containing @page. Pull out its body
  // by brace-matching rather than a regex, since @page nests inside it.
  const start = style.indexOf('@media print{');
  let printBlock = '';
  if (start >= 0) {
    let depth = 0;
    for (let i = style.indexOf('{', start); i < style.length; i++) {
      if (style[i] === '{') depth++;
      else if (style[i] === '}') { depth--; if (depth === 0) { printBlock = style.slice(start, i + 1); break; } }
    }
  }
  const screenCss = style.replace(printBlock, '');

  console.log('\n== It defines its page, as the receipt does ==');
  check('there is a print block', printBlock.length > 0);
  check('it sets an explicit A4 page box', /@page\{size:A4 landscape;margin:12mm;\}/.test(printBlock),
    (printBlock.match(/@page\{[^}]*\}/) || [])[0]);
  check('...landscape, because 12 columns do not fit a portrait sheet', /landscape/.test(printBlock));
  check('it resets html and body for print, as the receipt does',
    /html,body\{background:#fff;margin:0;padding:0;\}/.test(printBlock));
  check('it keeps fills, as the receipt does',
    /-webkit-print-color-adjust:exact/.test(printBlock) && /print-color-adjust:exact/.test(printBlock));
  check('the button bar still does not print', /\.actions\{display:none;\}/.test(printBlock));

  console.log('\n== The table stays inside the page and breaks cleanly ==');
  // An email has no spaces, so its column sets a minimum width the table
  // cannot shrink below unless cells are allowed to break long tokens.
  check('long values may break, so no column forces the table past the page',
    /th,td\{word-break:break-word;overflow-wrap:anywhere;\}/.test(printBlock));
  check('the header repeats on every page', /thead\{display:table-header-group;\}/.test(printBlock));
  check('a row is never split across two pages',
    /tr\{break-inside:avoid;page-break-inside:avoid;\}/.test(printBlock));
  check('a section title is never stranded at the foot of a page',
    /h2\{break-after:avoid;page-break-after:avoid;\}/.test(printBlock));

  console.log('\n== None of it changes the report on screen ==');
  check('no @page outside the print block', !/@page/.test(screenCss));
  check('long-token breaking applies only when printing', !/word-break/.test(screenCss));
  check('row-break rules apply only when printing', !/break-inside/.test(screenCss));

  console.log('\n== The page hands PDF-making to the server ==');
  // Safari printed this page blank however it was set up -- even the
  // one-page Summary -- so its button is now a link to a PDF the server
  // draws (report-pdf.js). The print CSS above stays, for anyone who still
  // prints the page itself from another browser.
  check('no print button is left to go blank', !/window\.print\(\)/.test(html) && !/id="print-report"/.test(html));
  check('a Download PDF link is offered instead',
    /<a id="download-pdf" href="\/api\/admin\/reports\/delegates\?format=pdf">Download PDF<\/a>/.test(html),
    (html.match(/<a id="download-pdf"[^>]*>/) || [])[0]);
  const ws = await call('GET', '/api/admin/reports/workshops?optionId=1', null, admin);
  check('...keeping the workshop the page was opened for',
    ws.status !== 200 || /href="\/api\/admin\/reports\/workshops\?format=pdf&amp;optionId=1"/.test(String(ws.body)),
    (String(ws.body).match(/<a id="download-pdf"[^>]*>/) || [ws.status])[0]);

  report();
})();
