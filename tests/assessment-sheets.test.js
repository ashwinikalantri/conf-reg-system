// Judges' assessment sheets (owner, 21 Nov 2026, from their template): one
// per session -- each hall for orals and awards, each screen for e-posters --
// the papers in running order prefilled, four criteria of 25 marks each.
const fs = require('fs');
const { call, check, report, appFile, adminLogin } = require('./harness');
const { renderAssessmentSheets, CRITERIA } = require('../assessment-sheet-pdf');

(async () => {
  const admin = await adminLogin();
  check('the four criteria of the template', CRITERIA.length === 4 && /Relevance/.test(CRITERIA[0]) && /Discussion/.test(CRITERIA[3]));
  const papers = (n) => Array.from({ length: n }, (_, i) => ({ place: i + 1, time: '8:00 AM', presenter: `Dr P${i}`, regNo: `R${i}`, title: 'A title' }));
  const pages = async (sheets) => (await renderAssessmentSheets(sheets, { acronym: 'T' })).toString('latin1').match(/\/Type \/Page\b/g).length;
  check('a row per presenter: a session on one page; a much longer one carries over', await pages([{ heading: 'ORAL PAPER ASSESSMENT', venue: 'Hall A', session: 'S', judges: [], papers: papers(7) }]) === 1
    && await pages([{ heading: 'ORAL PAPER ASSESSMENT', venue: 'Hall A', session: 'S', judges: [], papers: papers(16) }]) === 2);
  check('eight presenters (the most in any hall or screen) still one sheet, signature included', await pages([{ heading: 'E-POSTER ASSESSMENT', venue: 'Screen 1', session: 'S', judges: [], papers: papers(8) }]) === 1);
  check('...one sheet per session: two sessions, two pages', await pages([1, 2].map((k) => ({ heading: 'E-POSTER ASSESSMENT', venue: `Screen ${k}`, session: 'S', judges: [], papers: papers(5) }))) === 2);
  for (const url of ['/api/admin/oral-order/assessment.pdf?format=ORAL', '/api/admin/oral-order/assessment.pdf?format=AWARD', '/api/admin/poster-screens/assessment.pdf']) {
    const r = await call('GET', url, null, admin);
    const buf = r.buf || Buffer.from(r.raw || '', 'binary');
    check(`${url}: a PDF, or says why not`, (r.status === 200 && buf.slice(0, 4).toString() === '%PDF') || (r.status === 404 && r.body && r.body.error), r.status);
  }
  check('the judges\' names are not printed (21 Nov)', !/Judges for this session/.test(fs.readFileSync(appFile('assessment-sheet-pdf.js'), 'utf8')));
  // Black and white (22 Nov): the logo a grey image, no colour image at all.
  const pdf = (await renderAssessmentSheets([{ heading: 'ORAL PAPER ASSESSMENT', venue: 'Hall A', session: 'S', judges: [], papers: papers(1) }], { acronym: 'T' })).toString('latin1');
  check('printed in black and white: the logo in grey, no colour image', /\/ColorSpace \/DeviceGray/.test(pdf) && !/\/ColorSpace \/DeviceRGB/.test(pdf));
  const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
  check('linked beside each running order', /oral-order\/assessment\.pdf\?format=/.test(js) && /poster-screens\/assessment\.pdf"/.test(js) && /poster-screens\/assessment\.pdf\?screen=/.test(js));
  report();
})();
