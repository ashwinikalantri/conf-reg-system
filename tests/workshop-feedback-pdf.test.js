// The Workshop Feedback report's PDF (owner, 22 Nov 2026): its existing PDF
// button now draws the report as it reads on screen -- a first page with the
// totals and every workshop, then each workshop on a new page of its own.
// Other reports keep the table PDF.
const { call, check, report, adminLogin, appFile } = require('./harness');
const fs = require('fs');
const { renderWorkshopFeedbackPdf } = require(appFile('workshop-feedback-pdf.js'));

const pages = (buf) => (buf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
const scale = [1, 2, 3, 4, 5].map((value, i) => ({ value, label: ['Poor', 'Fair', 'Good', 'Very good', 'Excellent'][i] }));
const workshop = (no, n, suggestions = 0) => {
  const rows = Array.from({ length: n }, (_, i) => ({ regNo: `EX${no}${String(i).padStart(3, '0')}`, ratings: [4, 5, 3], at: Date.now() }));
  return {
    no, label: `Workshop ${no}`, name: `Example workshop ${no}`, hall: 'Hall A', present: n + 2, responses: n,
    questions: ['Relevance of content', 'Quality of facilitation', 'Usefulness in your professional practice'].map((label, k) => ({
      label, n, mean: n ? [4, 5, 3][k] : null, counts: [0, 0, k === 2 ? n : 0, k === 0 ? n : 0, k === 1 ? n : 0] })),
    suggestions: rows.slice(0, suggestions).map((r) => ({ regNo: r.regNo, text: 'Share the slides after the workshop, please.', at: r.at })), rows,
  };
};

(async () => {
  const admin = await adminLogin();
  console.log('\n== The layout ==');
  const three = await renderWorkshopFeedbackPdf({ scale, workshops: [workshop(1, 5, 2), workshop(2, 0), workshop(3, 8, 1)] }, { heading: 'X · Workshop Feedback', subline: 's', footer: 'f' });
  check('a first page, then a new page for each workshop, even one with no responses', pages(three) === 4, pages(three));
  const long = await renderWorkshopFeedbackPdf({ scale, workshops: [workshop(1, 70, 30), workshop(2, 3)] }, { heading: 'h', subline: 's', footer: 'f' });
  check('a long workshop carries on over more pages, and the next still starts on its own', pages(long) >= 4, pages(long));
  const none = await renderWorkshopFeedbackPdf({ scale, workshops: [] }, { heading: 'h', subline: 's', footer: 'f' });
  check('no workshops: still a PDF', none.slice(0, 4).toString() === '%PDF' && pages(none) === 1);

  console.log('\n== The existing PDF button ==');
  const json = (await call('GET', '/api/admin/reports/workshop-feedback?format=json', null, admin)).body.report;
  check('the report carries each response, by registration number only', json.feedback.workshops.every((w) => Array.isArray(w.rows)
    && w.rows.every((r) => Object.keys(r).join() === 'regNo,ratings,at')));
  const pdf = await call('GET', '/api/admin/reports/workshop-feedback?format=pdf', null, admin);
  const buf = pdf.buf || Buffer.from('');
  check('the report\'s PDF is the new layout: a page per workshop after the first', pdf.status === 200 && buf.slice(0, 4).toString() === '%PDF'
    && pages(buf) >= 1 + json.feedback.workshops.length, [pages(buf), json.feedback.workshops.length]);
  check('...from the same PDF button as before', /downloadReport\("workshop-feedback", null, ""\)/.test(fs.readFileSync(appFile('public', 'app.js'), 'utf8')));
  const other = await call('GET', '/api/admin/reports/summary?format=pdf', null, admin);
  check('other reports keep their table PDF', other.status === 200 && (other.buf || Buffer.from('')).slice(0, 4).toString() === '%PDF');
  report();
})();
