// The scientific programme as a printable A4 PDF (owner, 20 Nov 2026), from
// the same rows as the website's programme page, linked from that page.
const fs = require('fs');
const { call, check, report, appFile } = require('./harness');

(async () => {
  const pdf = await call('GET', '/website/programme.pdf');
  const buf = pdf.buf || Buffer.from(pdf.raw || '', 'binary');
  check('the programme is a PDF, open to all', pdf.status === 200 && /application\/pdf/.test(pdf.headers['content-type']) && buf.slice(0, 4).toString() === '%PDF', pdf.status);
  check('...A4 portrait (595 × 842 points)', /\/MediaBox \[0 0 595\.28 841\.89\]/.test(buf.toString('latin1')));
  check('...times printed as times, never "[object Object]"', !/object Object/.test(buf.toString('latin1')) && /time: time12\(s\.start_time\)/.test(fs.readFileSync(appFile('website.js'), 'utf8')));
  check('...named for printing', /Scientific-Programme\.pdf/.test(pdf.headers['content-disposition'] || ''));
  const page = await call('GET', '/website/programme');
  check('the programme page links to it', /href="\/website\/programme\.pdf"/.test(page.raw) && /A4 PDF/.test(page.raw));
  const site = fs.readFileSync(appFile('website.js'), 'utf8');
  check('on the website\'s own address too, from the same rows as the page', /if \(p === '\/programme\.pdf'\) return programmePdf\(req, res, next\);/.test(site)
    && /const rows = programmeRows\(ofDay, hall\);/.test(site));
  check('by hall and time (20 Nov): each day\'s breaks first, then each hall in its order, its sessions by time', /programmeByHall\(all\.filter\(\(s\) => s\.session_date === day\), dayLong\(day\)\)/.test(site)
    && /\.sort\(\(a, b\) => a\[1\] - b\[1\]/.test(site) && /\.sort\(\(a, b\) => a\.start_time\.localeCompare\(b\.start_time\)\)\.map/.test(site));
  // At a glance (20 Nov): the same sessions, typeset; linked beside the full one.
  const glance = await call('GET', '/website/programme-at-a-glance.pdf');
  const gbuf = glance.buf || Buffer.from(glance.raw || '', 'binary');
  check('the programme at a glance is an A4 portrait PDF, open to all', glance.status === 200 && gbuf.slice(0, 4).toString() === '%PDF'
    && /\/MediaBox \[0 0 595\.28 841\.89\]/.test(gbuf.toString('latin1')), glance.status);
  check('...named for printing', /Programme-at-a-Glance\.pdf/.test(glance.headers['content-disposition'] || ''));
  check('...linked from the programme page, and on the website\'s own address', /href="\/website\/programme-at-a-glance\.pdf"/.test(page.raw)
    && /if \(p === '\/programme-at-a-glance\.pdf'\) return programmeGlancePdf\(req, res, next\);/.test(site));
  const { renderGlancePdf } = require(appFile('programme-glance-pdf.js'));
  const day = (date, rows) => rows.map(([a, b, title, hall, extra]) => ({ session_date: date, start_time: a, end_time: b, title, hall, hall_sort: 1, label: '', speakers: '', meal: 0, ...extra }));
  const many = Array.from({ length: 8 }, (_, i) => ['09:00', '16:30', `Workshop ${i + 1}`, `Room ${i + 1}`, { label: `Workshop ${i + 1}` }]);
  const sample = await renderGlancePdf([
    ...day('2026-11-21', [...many, ['13:00', '14:00', 'Lunch', 'Lawn', { meal: 1 }]]),
    ...day('2026-11-22', [['09:00', '10:00', 'Opening', 'Hall A'], ['10:00', '12:00', 'Long session', 'Hall A'], ['09:00', '12:00', 'Posters', 'Hall B'], ['10:00', '11:00', 'Talk', 'Hall B'],
      ['11:00', '11:30', 'Tea Break', 'Lawn', { meal: 1 }]]),
  ], { conference: 'Test', acronym: 'T', dates: '21–22 Nov', logo: '/no/such/logo.png', partners: [{ name: 'Gone', path: '/no/such/partner.png' }] });
  check('...draws a workshop day and a timetable day without failing, even with a logo file missing', sample.slice(0, 4).toString() === '%PDF' && !/NaN|undefined/.test(sample.toString('latin1')));
  check('...under the conference header, with the partners\' logos on every page (20 Nov design)', /logo: img\('nqocn-mgims-logo\.png'\), partners: content\.partners\.map/.test(site)
    && /'In partnership with'/.test(fs.readFileSync(appFile('programme-glance-pdf.js'), 'utf8')));
  check('...and a Programme PDF button on the admin Programme page makes it (21 Nov)', /href="\/website\/programme-at-a-glance\.pdf"[^>]*>[\s\S]*?Programme PDF<\/a>/.test(fs.readFileSync(appFile('views/admin/sections/programme.ejs'), 'utf8')));
  report();
})();
