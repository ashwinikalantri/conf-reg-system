// Certificates: up to six signatories; a workshop signed by its own; the
// MMC Observer only where there are MMC points; the Faculty certificate;
// the verify QR on the conference's address; logos without their white.
//
//   * A kind takes up to six signatories (it was four).
//   * A signatory marked "only with MMC points" never signs any other kind,
//     ticked or not.
//   * Adding a signatory does not put them on every certificate: the kinds
//     still on the default keep the ones they had.
//   * A workshop may have its own signatories; one without signs as the
//     workshop certificate does.
//   * Everyone on the Faculty list (not cancelled) earns the Faculty
//     certificate, signed up or not; it can be withheld with a reason, and
//     follows them to their account when they are linked.
const { call, check, report, adminLogin, appFile, openDb } = require('./harness');
const fs = require('fs');
const certLib = require(appFile('certificate-pdf.js'));
const partners = require(appFile('website-content.js')).partners;

const N = String(Date.now()).slice(-7);
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const images = (pdf) => (pdf.toString('latin1').match(/\/Subtype \/Image/g) || []).length;

(async () => {
  const admin = await adminLogin();
  const db = openDb();
  const savedSettings = await db.get("SELECT value FROM schema_meta WHERE key = 'certificate_settings'");
  const sigIds = [];
  const madeHalls = [];
  let guestId = null;
  let phone = null;
  try {
    console.log('\n== A signature keeps its transparency ==');
    {
      // A 2×1 PNG, as an optimiser writes it: RGB, white marked see-through by a tRNS chunk.
      const zlib = require('zlib');
      const { keepTransparent, renderCertificatePdf } = require(appFile('certificate-pdf.js'));
      const { PNG } = require('pngjs');
      const crc32 = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; };
      const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const body = Buffer.concat([Buffer.from(t), d]); const r = Buffer.alloc(4); r.writeUInt32BE(crc32(body)); return Buffer.concat([l, body, r]); };
      const ihdr = Buffer.from([0, 0, 0, 2, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
      const keyed = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('tRNS', Buffer.from([0, 255, 0, 255, 0, 255])),
        chunk('IDAT', zlib.deflateSync(Buffer.from([0, 10, 20, 120, 255, 255, 255]))), chunk('IEND', Buffer.alloc(0))]);
      const fixed = keepTransparent(keyed);
      const px = PNG.sync.read(fixed).data;
      check('a PNG that marks one colour see-through keeps it so, the ink solid', fixed[25] === 6 && px[3] === 255 && px[0] === 10 && px[7] === 0, [fixed[25], ...px]);
      const rgba = new PNG({ width: 2, height: 1 }); rgba.data.fill(0); rgba.data[3] = 255;
      const plain = PNG.sync.write(rgba);
      check('...any other PNG is drawn as uploaded, and a JPEG', keepTransparent(plain) === plain && keepTransparent(Buffer.from([0xff, 0xd8, 0xff])).length === 3);
      const pdfOf = async (image) => (await renderCertificatePdf({ kind: 'MMC', title: 'C', name: 'N', body: 'x', conference: { name: 'C', acronym: 'C' }, certNo: 'X', signatories: [{ name: 'S', designation: 'D', image }], logos: [] })).toString('latin1');
      check('...both reach the certificate with a transparency mask, no ground behind', /\/SMask/.test(await pdfOf(keyed)) && /\/SMask/.test(await pdfOf(plain)));
      check('the file is kept byte for byte: no re-encoding on the way in or out', /return \{ buffer, ext: \/png\/i\.test\(m\[1\]\) \? 'png' : 'jpg' \};/.test(fs.readFileSync(appFile('server.js'), 'utf8'))
        && /reader\.readAsDataURL\(file\)/.test(fs.readFileSync(appFile('public', 'app.js'), 'utf8')));
      check('its preview shows the transparency, as checks', /\.sig-preview \{ background: repeating-conic-gradient/.test(fs.readFileSync(appFile('public', 'styles.css'), 'utf8')) && /class="sig-preview /.test(fs.readFileSync(appFile('public', 'app.js'), 'utf8')));
    }

    await call('PUT', '/api/admin/certificates/background', { image: null }, admin);
    const settings = async () => (await call('GET', '/api/admin/certificates/settings', null, admin)).body;
    const put = (b) => call('PUT', '/api/admin/certificates/settings', b, admin);
    const s0 = await settings();
    const confBefore = s0.templates.CONF.signatories;

    console.log('\n== Signatories ==');
    const add = async (name, designation, extra = {}) => {
      const r = await call('POST', '/api/admin/certificates/signatories', { name, designation, ...extra }, admin);
      if (r.body.id) sigIds.push(r.body.id);
      return r.body.id;
    };
    const observer = await add(`Dr Observer ${N}`, 'MMC Observer', { signature: SIG });
    const faculty = await add(`Dr Workshop Lead ${N}`, 'Workshop Faculty', { signature: SIG });
    const more = [];
    for (let i = 0; i < 5; i++) more.push(await add(`Dr Signer ${i} ${N}`, 'Organising Committee'));
    check('fixture: seven signatories added', sigIds.length === 7);
    const s1 = await settings();
    const row = (id) => s1.signatories.find((s) => s.id === id);
    check('an MMC Observer is marked "only with MMC points" when added', Number(row(observer).mmc_only) === 1 && Number(row(faculty).mmc_only) === 0);
    check('adding a signatory leaves the certificates on the default as they were', JSON.stringify(s1.templates.CONF.signatories) === JSON.stringify(confBefore)
      && !s1.templates.WORKSHOP.signatories.includes(faculty), s1.templates.CONF.signatories);
    check('up to six signatories on a certificate', s1.maxSignatories === 6);

    await put({ templates: { MMC: { signatories: [...more, observer] } } });
    await put({ templates: { CONF: { signatories: [observer, ...more] } } });
    const s2 = await settings();
    check('six are kept, in order', JSON.stringify(s2.templates.MMC.signatories) === JSON.stringify([...more, observer]), s2.templates.MMC.signatories);
    check('the MMC Observer never signs the participation certificate, even ticked', JSON.stringify(s2.templates.CONF.signatories) === JSON.stringify(more),
      s2.templates.CONF.signatories);
    // Images in a specimen: the logos and the QR, plus a signature for each
    // signatory who has one (only the observer and the workshop lead do).
    const pdf = async (q) => (await call('GET', `/api/admin/certificates/preview.pdf?${q}`, null, admin)).buf;
    const plain = images(await pdf('kind=CONF'));
    check('fixture: the logos and the QR', plain >= partners.length + 1, plain);
    check('...the observer is drawn on the MMC certificate (their signature)', images(await pdf('kind=MMC')) > plain, [images(await pdf('kind=MMC')), plain]);
    await put({ templates: { CONF: { signatories: [observer] } } });
    check('...but not on a participation one', images(await pdf('kind=CONF')) === plain, images(await pdf('kind=CONF')));
    await call('PUT', `/api/admin/certificates/signatories/${observer}`, { mmcOnly: false }, admin);
    await put({ templates: { CONF: { signatories: [observer] } } });
    check('untick "only with MMC points" and they may sign any', (await settings()).templates.CONF.signatories.includes(observer));
    await call('PUT', `/api/admin/certificates/signatories/${observer}`, { mmcOnly: true }, admin);
    check('...and tick it again, and they are off it', !(await settings()).templates.CONF.signatories.includes(observer));

    console.log('\n== A workshop\'s own ==');
    const hall = (await call('POST', '/api/admin/programme/halls', { name: `Sig Hall ${N}` }, admin)).body.id;
    madeHalls.push(hall);
    const wsOpt = await db.get("SELECT o.id FROM program_options o JOIN program_groups g ON g.id = o.group_id WHERE g.name = 'Workshops' AND o.active = 1 LIMIT 1");
    await call('POST', '/api/admin/programme/sessions', { hallId: hall, date: '2099-03-01', start: '09:00', end: '16:30', title: `Sig Workshop ${N}`, counts: true, optionId: wsOpt.id }, admin);
    const s3 = await settings();
    check('the settings list the workshops', s3.workshops.some((w) => w.optionId === wsOpt.id), s3.workshops);
    await put({ templates: { WORKSHOP: { signatories: more.slice(0, 2) } } });
    check('a workshop without its own signs as the workshop certificate', images(await pdf(`kind=WORKSHOP&option=${wsOpt.id}`)) === plain);
    await put({ templates: { WORKSHOP: { byWorkshop: { [wsOpt.id]: [faculty, observer] } } } });
    const s4 = await settings();
    check('a workshop\'s own signatories are saved (the MMC Observer dropped)', JSON.stringify(s4.templates.WORKSHOP.byWorkshop[String(wsOpt.id)]) === `[${faculty}]`
      && JSON.stringify(s4.templates.WORKSHOP.signatories) === JSON.stringify(more.slice(0, 2)), s4.templates.WORKSHOP);
    check('...and sign its certificate', images(await pdf(`kind=WORKSHOP&option=${wsOpt.id}`)) > plain);
    check('...not every workshop\'s', images(await pdf('kind=WORKSHOP')) === plain);
    await put({ templates: { WORKSHOP: { byWorkshop: { [wsOpt.id]: null } } } });
    check('"sign as above" puts it back on the default', !(await settings()).templates.WORKSHOP.byWorkshop[String(wsOpt.id)]);

    console.log('\n== Faculty ==');
    guestId = (await db.run("INSERT INTO guests (guest_name, guest_designation, created_at) VALUES (?, 'Professor', ?)", [`Dr Faculty ${N}`, Date.now()])).lastID;
    const key = `faculty-${guestId}`;
    const cand = async () => (await call('GET', '/api/admin/certificates/candidates', null, admin)).body.people.find((x) => x.phone === key || (x.faculty && x.faculty.guestId === guestId));
    let me = await cand();
    check('someone on the Faculty list, not signed up, is listed for the Faculty certificate', me && me.notRegistered && me.faculty.eligible && !me.conference.kind, me);
    {
      const view = fs.readFileSync(appFile('views', 'admin', 'sections', 'certificates.ejs'), 'utf8');
      const client = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
      const listFn = client.slice(client.indexOf('function renderCertificateList()'), client.indexOf('async function setCertificateOverride'));
      check('...and shown in the list from the start, not only under the Faculty filter (31 Oct)',
        /<option value="">Everyone: delegates and faculty<\/option>\s*<option value="registered">Registered delegates<\/option>/.test(view)
        && /if \(filter === 'registered'\) return !x\.notRegistered;/.test(listFn) && !/filter === ''\) return !x\.notRegistered/.test(listFn) && /return true;\n  \}\);/.test(listFn));
    }
    check('...and nothing else', me && me.workshops.length === 0 && /Not signed up/.test(me.conference.whyNot));
    check('the Faculty certificate cannot be "included anyway": they have it', (await call('POST', '/api/admin/certificates/override', { phone: key, scope: 'FAC', decision: 'INCLUDE', reason: 'x' }, admin)).status === 400);
    await call('POST', '/api/admin/certificates/override', { phone: key, scope: 'FAC', decision: 'EXCLUDE', reason: 'Did not come' }, admin);
    me = await cand();
    check('...it can be withheld, with the reason', !me.faculty.eligible && /Did not come/.test(me.faculty.whyNot));
    await call('POST', '/api/admin/certificates/override', { phone: key, scope: 'FAC', decision: null }, admin);
    const issued = await call('POST', '/api/admin/certificates/issue', { scope: 'faculty', phones: [key] }, admin);
    check('issuing faculty certificates', issued.body.success && issued.body.issued.FACULTY === 1, issued.body);
    const cert = await db.get('SELECT * FROM certificates WHERE guest_id = ?', [guestId]);
    check('...numbered in its own series, for the faculty entry', cert && /\/F\/\d{4}$/.test(cert.cert_no) && cert.kind === 'FACULTY' && cert.phone_number === key, cert);
    check('...once', (await call('POST', '/api/admin/certificates/issue', { scope: 'faculty', phones: [key] }, admin)).body.issued.FACULTY === 0);
    const one = await call('GET', `/api/admin/certificates/${cert.id}.pdf`, null, admin);
    check('...and it draws', one.status === 200 && one.buf.slice(0, 4).toString() === '%PDF');
    const verify = await call('GET', `/verify/${cert.verify_code}`);
    check('the verify page names it a Faculty certificate', /Valid certificate/.test(verify.raw) && /<dd>Faculty<\/dd>/.test(verify.raw));

    const email = `fac-${N}@example.test`;
    const otp = await call('POST', '/api/otp/request', { destination: email });
    const reg = await call('POST', '/api/auth/register', { salutation: 'Dr', name: `Faculty ${N}`, age: '50', gender: 'Female', designation: 'Professor', institute: 'Test College',
      pincode: '442102', state: 'Maharashtra', district: 'Wardha', country: 'United Kingdom', email, emailOtp: otp.body.devOtp, password: 'testpass123' });
    phone = reg.body.user && reg.body.user.phone_number;
    const linked = await call('PUT', `/api/guests/${guestId}/link`, { phone }, admin);
    check('fixture: they sign up and are linked', linked.body.success === true, linked.body);
    const mine = await call('GET', '/api/certificates/mine', null, reg.cookie);
    check('linked, the certificate is theirs to download', (mine.body.certificates || []).some((c) => c.id === cert.id && c.label === 'Faculty'), mine.body);
    me = await cand();
    check('...and they are listed under their account, issued', me && me.phone === phone && me.faculty.issued && me.faculty.issued.id === cert.id);

    console.log('\n== The page ==');
    const src = fs.readFileSync(appFile('certificate-pdf.js'), 'utf8');
    const server = fs.readFileSync(appFile('server.js'), 'utf8');
    check('the verify QR is on the conference\'s own address', /const verifyUrlFor = \(code\) => `https:\/\/\$\{WEBSITE_HOST\}\/verify\/\$\{code\}`/.test(server));
    check('...and the link is not printed', !/Verify at|Verify: \$\{/.test(src));

    console.log('\n== Logos ==');
    check('the logos as they are, on the soft white band (their white grounds kept, 31 Oct)', !/clearWhite/.test(src + server)
      && /fillOpacity\(0\.72\)\.fillColor\('#ffffff'\)/.test(src));
  } finally {
    if (guestId) {
      await db.run('DELETE FROM certificates WHERE guest_id = ?', [guestId]);
      await db.run('DELETE FROM certificate_overrides WHERE phone_number = ?', [`faculty-${guestId}`]);
      await db.run('DELETE FROM guests WHERE id = ?', [guestId]);
    }
    for (const id of sigIds) await db.run('DELETE FROM certificate_signatories WHERE id = ?', [id]);
    for (const id of madeHalls) {
      await db.run('DELETE FROM programme_sessions WHERE hall_id = ?', [id]);
      await db.run('DELETE FROM halls WHERE id = ?', [id]);
    }
    if (savedSettings) await db.run("UPDATE schema_meta SET value = ? WHERE key = 'certificate_settings'", [savedSettings.value]);
    else await db.run("DELETE FROM schema_meta WHERE key = 'certificate_settings'");
    db.close();
  }
  report();
})();
