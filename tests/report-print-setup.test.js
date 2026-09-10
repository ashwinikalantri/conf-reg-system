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
const vm = require('vm');

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

  console.log('\n== Printing waits for the fonts, as the receipt does ==');
  check('the button no longer prints from an inline handler', !/onclick="window\.print\(\)"/.test(html));
  check('it is wired by id instead', /<button type="button" id="print-report">Print \/ Save as PDF<\/button>/.test(html));
  const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
  check('a script handles it', script.includes("getElementById('print-report')"));
  check('...waiting for document.fonts.ready, but never more than a moment',
    /Promise\.race\(\[document\.fonts\.ready, new Promise\(function \(r\) \{ setTimeout\(r, 1500\); \}\)\]\)/.test(script));

  // Drive that script for real: click the button, let the fonts settle, and
  // confirm it prints exactly once -- and not before the fonts are ready.
  let clickHandler = null;
  let printed = 0;
  let releaseFonts;
  const fontsReady = new Promise((r) => { releaseFonts = r; });
  const sandbox = {
    document: {
      getElementById: (id) => (id === 'print-report'
        ? { addEventListener: (type, fn) => { if (type === 'click') clickHandler = fn; } }
        : null),
      fonts: { ready: fontsReady },
    },
    window: { print: () => { printed++; } },
    setTimeout, Promise,
  };
  sandbox.window.document = sandbox.document;
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: 'report-print.js' });
  check('the script attaches a click handler', typeof clickHandler === 'function');
  if (clickHandler) {
    clickHandler();
    await new Promise((r) => setTimeout(r, 20));
    check('clicking does not print before the fonts are ready', printed === 0, printed);
    releaseFonts();
    await new Promise((r) => setTimeout(r, 20));
    check('...and prints exactly once when they are', printed === 1, printed);
  }

  report();
})();
