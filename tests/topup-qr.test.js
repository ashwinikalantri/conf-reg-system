// Pay balance (2 Nov 2026): the QR code for a balance due must carry the
// conference's UPI ID. The ID comes from /api/fees, which only the
// registration form loaded, so a delegate who went straight to "Pay balance"
// got a QR with an empty payee (pa=) that payment apps refused.
const { check, report, appFile } = require('./harness');
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(appFile('public/app.js'), 'utf8');
const fn = src.match(/async function openTopupModal\(\) \{[\s\S]*?\n\}\n/);
check('openTopupModal is found', !!fn);

function run({ feesGive }) {
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, value: 'x', innerText: '', src: '', href: '', classList: { toggle() {}, add() {}, remove() {} } });
  const toasts = [];
  let opened = null;
  let feeCalls = 0;
  const ctx = {
    OFFICIAL_UPI_ID: '',
    OFFICIAL_UPI_PAYEE_NAME: '',
    currentRegistration: { registration_number: 'NQOCN20269999', remaining: 1500 },
    currentDelegate: { full_name: 'Test Delegate' },
    document: { getElementById: el },
    showToast: (m) => toasts.push(m),
    setText: () => {},
    inr: (n) => String(n),
    setTopupPaymentMode: () => {},
    openModal: (id) => { opened = id; },
    encodeURIComponent,
  };
  ctx.loadFees = async () => { feeCalls += 1; if (feesGive) { ctx.OFFICIAL_UPI_ID = 'conf@bank'; ctx.OFFICIAL_UPI_PAYEE_NAME = 'NQOCN 2026'; } };
  vm.createContext(ctx);
  vm.runInContext(`${fn[0]}; this.go = openTopupModal;`, ctx);
  return ctx.go().then(() => ({ els, toasts, opened, feeCalls }));
}

(async () => {
  const ok = await run({ feesGive: true });
  const qr = decodeURIComponent((ok.els['topup-qr-image'] || {}).src.split('data=')[1] || '');
  check('straight to Pay balance: the payment details are fetched first', ok.feeCalls === 1);
  check('...and the QR names the conference as payee', qr.startsWith('upi://pay?pa=conf@bank&pn=NQOCN%202026&am=1500.00&cu=INR'), qr);
  check('...the pay link matches the QR', ok.els['topup-pay-link'].href === qr && ok.opened === 'modal-topup');

  const bad = await run({ feesGive: false });
  check('no UPI ID to be had: no blank QR, a message instead', bad.opened === null && !(bad.els['topup-qr-image'] || {}).src
    && /could not be loaded/.test(bad.toasts[0] || ''), bad.toasts);
  report();
})();
