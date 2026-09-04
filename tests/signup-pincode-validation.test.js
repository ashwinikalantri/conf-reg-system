// Signup used to accept any address at all: the wizard had no checks on its
// address step, and the register endpoint stored whatever arrived. The only
// thing resembling validation was a call to api.postalpincode.in, whose own
// failure text -- "Invalid PIN Code or API unreachable" -- admits it could
// not tell a wrong PIN from an unreachable third party.
//
// A PIN code must now be one that exists, and state and district are
// required. The list is the GeoNames dataset the app already ships for the
// delegate map, so the check needs no third party and a PIN that passes is
// one the map can plot.
//
// The failure mode this design has to avoid is worse than the one it fixes.
// State and district are readonly, filled only by that third-party lookup.
// Making them mandatory without more would mean anyone whose lookup failed
// -- on a slow connection, or a network that filters it -- could not
// register at all, because they could not type the values either. Hence the
// unlock, which several of these checks are about.
const { call, check, report, appFile } = require('./harness');
const fs = require('fs');
const vm = require('vm');

const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
const N = Date.now() % 100000;

const base = {
  salutation: 'Dr', name: 'pin test', age: '30', gender: 'Female',
  designation: 'Consultant', institute: 'Test Hospital', password: 'testpassword1',
};
// Registering needs a verified OTP; these all fail on the ADDRESS before the
// OTP is ever considered, which is the point -- the address check has to sit
// in front of anything expensive.
const register = (over) => call('POST', '/api/auth/register', { ...base, ...over });

(async () => {
  console.log('\n== The lookup endpoint answers from the shipped dataset ==');
  const ask = async (pin) => (await call('GET', `/api/pincode/${pin}`)).body;
  const real = await ask('442102');
  check('a real PIN is known', real.known === true && real.wellFormed === true, real);
  check('...and the app says it could check', real.checkable === true, real);
  const fake = await ask('999999');
  check('a well-formed PIN that does not exist is not known',
    fake.wellFormed === true && fake.known === false, fake);
  const malformed = await ask('12345');
  check('a malformed PIN is not well-formed', malformed.wellFormed === false, malformed);
  const leadingZero = await ask('012345');
  check('a PIN cannot start with 0 (no Indian PIN does)', leadingZero.wellFormed === false, leadingZero);

  console.log('\n== The dataset is the one the map already uses ==');
  // Two lists would be free to disagree about what exists: an address that
  // registers but cannot be plotted, or the reverse.
  const raw = JSON.parse(fs.readFileSync(appFile('public', 'data', 'india-pincodes.json'), 'utf8'));
  check('the map dataset is what backs the check',
    !!raw.pincodes && Object.keys(raw.pincodes).length > 15000,
    Object.keys(raw.pincodes || {}).length);
  check('...and it contains the PIN the endpoint accepted', '442102' in raw.pincodes);
  check('...and not the one it refused', !('999999' in raw.pincodes));

  console.log('\n== Registration refuses an address that cannot be real ==');
  const unknown = await register({ phone: `98123${N}`, email: `p1-${N}@example.test`,
    pincode: '999999', state: 'Maharashtra', district: 'Wardha' });
  check('a PIN that does not exist is refused', unknown.body.success === false, unknown.body);
  check('...and the message names it', /999999/.test(unknown.body.error || ''), unknown.body.error);

  const bad = await register({ phone: `98124${N}`, email: `p2-${N}@example.test`,
    pincode: '12ab34', state: 'Maharashtra', district: 'Wardha' });
  check('a malformed PIN is refused', bad.body.success === false && /6-digit/.test(bad.body.error || ''), bad.body);

  const none = await register({ phone: `98125${N}`, email: `p3-${N}@example.test`,
    pincode: '', state: 'Maharashtra', district: 'Wardha' });
  check('an empty PIN is refused', none.body.success === false, none.body);

  console.log('\n== State and district are required ==');
  const noState = await register({ phone: `98126${N}`, email: `p4-${N}@example.test`,
    pincode: '442102', state: '', district: 'Wardha' });
  check('no state is refused', noState.body.success === false && /State is required/.test(noState.body.error || ''), noState.body);
  const noDistrict = await register({ phone: `98127${N}`, email: `p5-${N}@example.test`,
    pincode: '442102', state: 'Maharashtra', district: '' });
  check('no district is refused', noDistrict.body.success === false && /District is required/.test(noDistrict.body.error || ''), noDistrict.body);
  const blankish = await register({ phone: `98128${N}`, email: `p6-${N}@example.test`,
    pincode: '442102', state: '   ', district: 'Wardha' });
  check('whitespace does not count as a state', blankish.body.success === false, blankish.body);

  console.log('\n== A valid Indian address gets past the address checks ==');
  const ok = await register({ phone: `98129${N}`, email: `p7-${N}@example.test`,
    pincode: '442102', state: 'Maharashtra', district: 'Wardha', phoneOtp: '000000' });
  check('it fails on the OTP, not the address',
    /OTP|code/i.test(ok.body.error || '') && !/PIN|State|District/i.test(ok.body.error || ''), ok.body);

  console.log('\n== None of it applies outside India ==');
  // These columns hold a free-text region and city there; there is no PIN to
  // check and no list to check it against.
  const intl = await register({ country: 'Nepal', email: `p8-${N}@example.test`,
    pincode: '', state: 'Bagmati', district: 'Kathmandu' });
  check('an international signup is not asked for a PIN',
    !/PIN/i.test(intl.body.error || ''), intl.body.error);

  console.log('\n== The client never leaves someone unable to fill a required field ==');
  // The whole reason the unlock exists.
  function client(pincodeResponse, postalResponse) {
    const els = {};
    const mk = (id) => (els[id] = els[id] || {
      id, value: '', innerText: '', textContent: '', className: '', readOnly: true,
      classList: { c: new Set(), add(k) { this.c.add(k); }, remove(k) { this.c.delete(k); },
        toggle(k, on) { on ? this.c.add(k) : this.c.delete(k); }, contains(k) { return this.c.has(k); } },
      dataset: {}, style: {}, focus() {}, select() {}, setAttribute() {}, getAttribute: () => null,
      appendChild() {}, remove() {}, addEventListener() {},
      querySelector: () => null, querySelectorAll: () => [],
    });
    const doc = {
      getElementById: (id) => mk(id),
      querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, createElement: () => mk('c'),
      body: mk('body'), documentElement: mk('html'), readyState: 'loading', cookie: '',
    };
    const sandbox = {
      document: doc,
      window: { addEventListener() {}, location: { href: '', hash: '', pathname: '/', search: '' },
        matchMedia: () => ({ matches: false, addEventListener() {} }), history: { replaceState() {} } },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      navigator: { userAgent: 'node' },
      fetch: (url) => {
        const u = String(url);
        if (u.startsWith('/api/pincode/')) {
          if (pincodeResponse === 'down') return Promise.reject(new Error('offline'));
          return Promise.resolve({ ok: true, json: async () => pincodeResponse });
        }
        if (u.includes('postalpincode.in')) {
          if (postalResponse === 'down') return Promise.reject(new Error('offline'));
          return Promise.resolve({ ok: true, json: async () => postalResponse });
        }
        return Promise.reject(new Error('unexpected ' + u));
      },
      console: { log() {}, warn() {}, error() {}, info() {} },
      setTimeout, clearTimeout, setInterval, clearInterval, URL, Intl, Date, Math, JSON, Promise,
      requestAnimationFrame: (f) => setTimeout(f, 0), encodeURIComponent,
    };
    sandbox.window.document = doc; sandbox.self = sandbox; sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(js, sandbox, { filename: 'app.js' });
    // The stub creates elements on first getElementById; pre-create the ones
    // these checks read or set directly.
    ['reg-state', 'reg-district', 'reg-pincode', 'pincode-status', 'reg-country'].forEach(mk);
    return { sandbox, els };
  }

  const KNOWN = { success: true, wellFormed: true, known: true, checkable: true };
  const UNKNOWN = { success: true, wellFormed: true, known: false, checkable: true };
  const POSTAL_OK = [{ Status: 'Success', PostOffice: [{ State: 'Maharashtra', District: 'Wardha' }] }];

  {
    const { sandbox, els } = client(KNOWN, POSTAL_OK);
    await sandbox.fetchAddressDetails('442102');
    check('a good PIN fills state and district',
      els['reg-state'].value === 'Maharashtra' && els['reg-district'].value === 'Wardha');
    check('...and they stay readonly, since they were filled for you',
      els['reg-state'].readOnly === true);
  }
  {
    // The case that would otherwise be a lockout: PIN is fine, the naming
    // service is not.
    const { sandbox, els } = client(KNOWN, 'down');
    await sandbox.fetchAddressDetails('442102');
    check('when the lookup fails, state becomes typeable', els['reg-state'].readOnly === false);
    check('...and so does district', els['reg-district'].readOnly === false);
    check('...and the message asks for them rather than blaming the PIN',
      /type them below|type your state/i.test(els['pincode-status'].innerText),
      els['pincode-status'].innerText);
  }
  {
    // Our own check being unreachable must not reject either -- the server
    // decides, and it has the same list.
    const { sandbox, els } = client('down', 'down');
    await sandbox.fetchAddressDetails('442102');
    check('if our own check is unreachable, the fields still unlock', els['reg-state'].readOnly === false);
    check('...and nothing claims the PIN is wrong',
      !/not a PIN code we recognise/i.test(els['pincode-status'].innerText), els['pincode-status'].innerText);
  }
  {
    const { sandbox, els } = client(UNKNOWN, POSTAL_OK);
    await sandbox.fetchAddressDetails('999999');
    check('a PIN we know is wrong is rejected in the form',
      /not a PIN code we recognise/i.test(els['pincode-status'].innerText), els['pincode-status'].innerText);
    check('...and state/district are cleared rather than left stale', els['reg-state'].value === '');
    check('...and stay locked, since there is nothing valid to describe', els['reg-state'].readOnly === true);
  }

  console.log('\n== The wizard checks the address step, which it never did ==');
  {
    const { sandbox, els } = client(KNOWN, POSTAL_OK);
    els['reg-country'].value = 'India';
    els['reg-pincode'].value = '';
    check('an empty PIN stops the step', /6-digit PIN/.test(await sandbox.validateSignupStep(5) || ''));
    els['reg-pincode'].value = '442102';
    els['reg-state'].value = '';
    check('a missing state stops the step', /state/i.test(await sandbox.validateSignupStep(5) || ''));
    els['reg-state'].value = 'Maharashtra';
    els['reg-district'].value = '';
    check('a missing district stops the step', /district/i.test(await sandbox.validateSignupStep(5) || ''));
    els['reg-district'].value = 'Wardha';
    check('a complete address passes', (await sandbox.validateSignupStep(5)) === null);
  }
  {
    const { sandbox, els } = client(UNKNOWN, POSTAL_OK);
    els['reg-country'].value = 'India';
    els['reg-pincode'].value = '999999';
    els['reg-state'].value = 'Somewhere';
    els['reg-district'].value = 'Someplace';
    check('a PIN that does not exist stops the step even with the rest filled',
      /not a PIN code we recognise/.test(await sandbox.validateSignupStep(5) || ''));
  }

  report();
})();
