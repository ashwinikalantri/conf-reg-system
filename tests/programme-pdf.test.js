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
  report();
})();
