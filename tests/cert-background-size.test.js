// The certificate background has no size limit: a designer's artwork over
// the 8 MB every other request is held to uploads, and draws on a specimen.
// Only someone who manages certificates gets that far; everything else keeps
// the 8 MB limit.
const { call, check, report, adminLogin } = require('./harness');
const { PNG } = require('pngjs');

(async () => {
  const admin = await adminLogin();
  // A4 landscape at 300 dpi, in noise so it does not compress: ~35 MB.
  const png = new PNG({ width: 3508, height: 2480 });
  for (let i = 0; i < png.data.length; i++) png.data[i] = (i % 4 === 3) ? 255 : Math.floor(Math.random() * 256);
  const buf = PNG.sync.write(png);
  const image = `data:image/png;base64,${buf.toString('base64')}`;
  check('fixture: an artwork over 8 MB', buf.length > 8 * 1024 * 1024, buf.length);
  try {
    const up = await call('PUT', '/api/admin/certificates/background', { image }, admin);
    check('it uploads', up.status === 200 && up.body.success === true, up.status);
    const spec = await call('GET', '/api/admin/certificates/preview.pdf?kind=MMC', null, admin);
    check('...and a specimen certificate draws on it', spec.status === 200 && spec.buf.slice(0, 4).toString() === '%PDF' && spec.buf.length > 1024 * 1024, spec.buf.length);
    const anon = await call('PUT', '/api/admin/certificates/background', { image: null }, null);
    check('no one else may change it', anon.status === 401 || anon.status === 403, anon.status);
    const big = await call('PUT', '/api/admin/settings/general', { filler: 'x'.repeat(9 * 1024 * 1024) }, admin);
    check('any other request still stops at 8 MB', big.status === 413, big.status);
  } finally {
    await call('PUT', '/api/admin/certificates/background', { image: null }, admin);
  }
  report();
})();
