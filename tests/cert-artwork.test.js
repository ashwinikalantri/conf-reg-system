// Certificates on the designer's artwork, and the sponsors' logos.
//
// - Every certificate carries the website's partner logos (plus its QR).
// - On artwork, the page takes the artwork's proportions -- A4's width, its
//   own height -- so it is never stretched or cut.
// - Each certificate carries a lighter copy of the artwork, made once on
//   upload: at most 3508 pixels across, as a JPEG; the original is kept.
const { call, check, report, adminLogin, appFile, openDb } = require('./harness');
const jpeg = require(appFile('node_modules', 'jpeg-js'));
const { PNG } = require(appFile('node_modules', 'pngjs'));
const certLib = require(appFile('certificate-pdf.js'));
const partners = require(appFile('website-content.js')).partners;

const images = (pdf) => (pdf.toString('latin1').match(/\/Subtype \/Image/g) || []).length;
const mediaBox = (pdf) => { const m = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(pdf.toString('latin1')); return m ? [Number(m[1]), Number(m[2])] : null; };

(async () => {
  const admin = await adminLogin();
  const db = openDb();
  try {
    console.log('\n== The generated design ==');
    await call('PUT', '/api/admin/certificates/background', { image: null }, admin);
    const gen = (await call('GET', '/api/admin/certificates/preview.pdf?kind=CONF', null, admin)).buf;
    check('a specimen draws', gen.slice(0, 4).toString() === '%PDF');
    check('...with every partner\'s logo and the QR', images(gen) >= partners.length + 1, images(gen));
    check('...on A4', JSON.stringify(mediaBox(gen)) === JSON.stringify([841.89, 595.28]), mediaBox(gen));

    console.log('\n== On the designer\'s artwork ==');
    // 1510 x 1000: wider than A4, like the real artwork; textured, like linen,
    // and saved at quality 100, as a designer's export is.
    const art = { width: 1510, height: 1000, data: Buffer.alloc(1510 * 1000 * 4) };
    for (let i = 0; i < art.data.length; i++) art.data[i] = i % 4 === 3 ? 255 : 180 + Math.floor(Math.random() * 60);
    const artJpg = jpeg.encode(art, 100).data;
    const up = await call('PUT', '/api/admin/certificates/background', { image: `data:image/jpeg;base64,${artJpg.toString('base64')}` }, admin);
    check('the artwork uploads', up.body.success === true, up.body);
    const saved = JSON.parse((await db.get("SELECT value FROM schema_meta WHERE key = 'certificate_settings'")).value);
    check('a lighter copy is made on upload, and the original kept', saved.background && saved.backgroundCopy && saved.backgroundCopy.from === saved.background
      && saved.backgroundCopy.file !== saved.background, saved.backgroundCopy);
    const on = (await call('GET', '/api/admin/certificates/preview.pdf?kind=MMC', null, admin)).buf;
    const box = mediaBox(on);
    check('the page is A4\'s width and the artwork\'s height', box && box[0] === 841.89 && Math.abs(box[1] - 841.89 / 1.51) < 0.5, box);
    check('...with the artwork, the logos and the QR', images(on) >= partners.length + 2, images(on));
    check('...and the copy, not the original, inside it', on.length < artJpg.length + 400000, [on.length, artJpg.length]);

    console.log('\n== The copy ==');
    const wide = new PNG({ width: 4000, height: 50 });
    // Colour behind full transparency: laid on white, it must come out white.
    for (let i = 0; i < wide.data.length; i++) wide.data[i] = i % 4 === 3 ? 0 : Math.floor(Math.random() * 256);
    const copy = certLib.certificateCopy(PNG.sync.write(wide));
    const decoded = copy && jpeg.decode(copy);
    check('an artwork wider than A4 at 300 dpi comes down to 3508 pixels', decoded && decoded.width === 3508 && decoded.height === 44, decoded && [decoded.width, decoded.height]);
    check('...transparency on white', decoded && decoded.data[0] > 250 && decoded.data[1] > 250 && decoded.data[2] > 250);
    check('CMYK as PDF viewers show it: no ink is white, black ink a near-black',
      JSON.stringify(certLib.cmykToRgb(0, 0, 0, 0)) === '[255,255,255]' && JSON.stringify(certLib.cmykToRgb(0, 0, 0, 1)) === '[35,31,32]', certLib.cmykToRgb(0, 0, 0, 1));
    check('...and full cyan its measured blue, not pure cyan', JSON.stringify(certLib.cmykToRgb(1, 0, 0, 0)) === '[0,173,239]', certLib.cmykToRgb(1, 0, 0, 0));
    check('what is not an image is left to the original', certLib.certificateCopy(Buffer.from('not an image')) === null);
  } finally {
    await call('PUT', '/api/admin/certificates/background', { image: null }, admin);
    db.close();
  }
  report();
})();
