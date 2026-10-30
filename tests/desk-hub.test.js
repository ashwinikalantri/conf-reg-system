// The Front Desk as the centre of operations.
//
//   * Delegates carry a desk pass -- a QR of their ID -- on the dashboard,
//     the receipt and the confirmation email; the QR image is public and
//     encodes only an ID-shaped code it is given.
//   * The desk's search can be filled by scanning: a desk pass, a link, or a
//     barcode holding an ID, mobile or email.
//   * From a delegate's desk page each role reaches its own editors --
//     payment review, abstract review and allotment, faculty travel & stay,
//     profile & roles -- and only those its permissions allow.
//   * Anyone who can open the desk lands on it.
const { call, check, report, appFile, adminLogin, openDb } = require('./harness');
const fs = require('fs');
const vm = require('vm');

(async () => {
  const admin = await adminLogin();
  const db = openDb({ readOnly: true });
  const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
  const src = fs.readFileSync(appFile('server.js'), 'utf8');
  const deskEjs = fs.readFileSync(appFile('views', 'admin', 'sections', 'desk.ejs'), 'utf8');
  const dash = fs.readFileSync(appFile('views', 'portal', 'sections', 'dashboard.ejs'), 'utf8');

  console.log('\n== The desk pass ==');
  const qr = await call('GET', '/api/qr/NQOCN20261049.png');
  check('a desk pass QR is a PNG, no sign-in needed', qr.status === 200 && /image\/png/.test(qr.headers['content-type'])
    && qr.buf && qr.buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a', [qr.status, qr.headers['content-type']]);
  check('...cached, being the same image every time', /max-age=86400/.test(qr.headers['cache-control'] || ''));
  check('only ID-shaped codes: no paths, no long text', (await call('GET', '/api/qr/..%2Fetc.png')).status !== 200
    && (await call('GET', `/api/qr/${'A'.repeat(40)}.png`)).status === 400 && (await call('GET', '/api/qr/a%20b.png')).status === 400);
  const verified = await db.get("SELECT id, registration_number FROM registrations WHERE bank_status = 'BANK_VERIFIED' AND COALESCE(registration_number, '') != '' LIMIT 1");
  const receipt = await call('GET', `/api/registrations/${verified.id}/receipt`, null, admin);
  check('the receipt carries it', receipt.status === 200 && receipt.raw.includes(`/api/qr/${encodeURIComponent(verified.registration_number)}.png`), receipt.status);
  const confirmedEmails = (src.match(/emailWrap\('Your registration is confirmed'[\s\S]*?\)\);/g) || []);
  check('every "registration confirmed" email carries it', confirmedEmails.length === 4 && confirmedEmails.every((e) => /deskPassEmailHtml\(/.test(e)), confirmedEmails.length);
  check('...and no other email', (src.match(/deskPassEmailHtml\(/g) || []).length === 4 + 0 && !/verification pending[\s\S]{0,400}deskPassEmailHtml/.test(src));
  check('...served from the portal\'s own address (email clients block inline images)', /src="\$\{escapeHtml\(String\(PORTAL_URL\)/.test(src));
  check('the dashboard shows it with the registration number', /id="desk-pass" class="hidden/.test(dash) && /desk-pass-qr'\)\.src = `\/api\/qr\/\$\{encodeURIComponent\(reg\.registration_number\)\}\.png`/.test(js));

  console.log('\n== Scanning ==');
  const grab = (n) => { const i = js.indexOf(`function ${n}(`); return js.slice(i, js.indexOf('\n}', i) + 2); };
  const sb = { String, URL, decodeURIComponent };
  vm.createContext(sb);
  vm.runInContext(`${grab('deskIdentifierFromScan')}\nglobalThis.read = deskIdentifierFromScan;`, sb);
  check('a desk pass reads as the ID', sb.read('NQOCN20261049') === 'NQOCN20261049' && sb.read(' nqocn20261049 ') === 'NQOCN20261049');
  check('a link carrying the ID', sb.read('https://registration.mgims.ac.in/?id=NQOCN20261049') === 'NQOCN20261049'
    && sb.read('https://example.org/delegate/NQOCN20261049') === 'NQOCN20261049');
  check('a mobile number, however printed', sb.read('+91 98765 43210') === '9876543210' && sb.read('tel:09876543210') === '9876543210');
  check('an email', sb.read('mailto:someone@example.org') === 'someone@example.org' || sb.read('someone@example.org') === 'someone@example.org');
  check('anything else is searched as typed', sb.read('Dr Rajini Peter') === 'Dr Rajini Peter' && sb.read('') === '');
  check('Scan sits beside the search box, with its own camera window', /onclick="openDeskScanner\(\)"/.test(deskEjs) && /id="modal-desk-scan"/.test(deskEjs) && /id="desk-scan-reader"/.test(deskEjs));
  check('the scanner library is pinned and loaded only when Scan is pressed',
    /const DESK_SCANNER_SRC = 'https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/html5-qrcode\/2\.3\.8\/html5-qrcode\.min\.js'/.test(js)
    && !/html5-qrcode/.test(fs.readFileSync(appFile('views', 'admin.ejs'), 'utf8')));
  check('a scan fills the search and looks them up', /document\.getElementById\('desk-search'\)\.value = id;\n\s*deskLookup\(\);/.test(js));
  check('the camera is released when the window closes', /async function closeDeskScanner\(\) \{[\s\S]*?scanner\.stop\(\)[\s\S]*?scanner\.clear\(\)/.test(js));

  console.log('\n== Each role\'s editors, from the desk ==');
  check('Profile & roles, for a role that may see users', /can\('users\.view'\) \? deskBtn\('Profile & roles', 'deskOpenProfile\(\)'\)/.test(js));
  check('Payment review, for a role that may see payments', /can\('payments\.view'\) \? deskBtn\('Payment review', `deskOpenPaymentReview\(\$\{esc\(reg\.id\)\}\)`/.test(js));
  check('...loading the payments list first if this session has not', /async function deskOpenPaymentReview\(regId\) \{[\s\S]*?if \(!cachedPaymentRegs\.some[^\n]*await renderBackendPayments\(\);[\s\S]*?openReviewModal\(regId\);/.test(js));
  check('Abstract review, and oral/poster for a role that allots', /can\('abstracts\.view'\) \? deskBtn\('Review', `deskOpenAbstract/.test(js)
    && /can\('abstracts\.assign'\) && a\.status === 'ACCEPTED' \? deskBtn\(/.test(js));
  check('Faculty travel & stay, for anyone who may see faculty', /const open = can\('guests\.view'\) \? deskBtn\(/.test(js));
  check('the desk reads the record again when one of these editors closes',
    /const DESK_EDITORS = new Set\(\['modal-review', 'modal-guest-edit', 'modal-abstract-review', 'user-detail'\]\);/.test(js)
    && /function closeModal\(id\) \{\n\s*document\.getElementById\(id\)\.classList\.add\('hidden'\);\n\s*deskRefreshAfter\(id\);/.test(js)
    && /deskRefreshAfter\('user-detail'\);\n\}/.test(js));
  const lookup = (await call('GET', `/api/desk/delegate/${encodeURIComponent(verified.registration_number)}`, null, admin)).body;
  check('the desk record carries what those editors need (the registration id)', lookup.registration && lookup.registration.id === verified.id);

  console.log('\n== Landing ==');
  check('anyone who can open the desk lands on it', /const defaultTab = canSee\('desk'\) \? 'desk'\n\s*: canSee\('overview'\) \? 'overview'/.test(js));

  db.close();
  report();
})();
