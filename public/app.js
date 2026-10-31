// The conference's UPI ID, payee name, and bank-transfer fallback details,
// all admin-editable from Settings → General / set during first-run setup.
// Populated by loadFees() from /api/fees so the QR code and the server's OCR
// check (which reads the same UPI object) can never drift apart. No
// hardcoded fallback values -- blank until the server has something to send,
// same as server.js's own UPI/BANK objects start blank.
let OFFICIAL_UPI_ID = '';
let OFFICIAL_UPI_PAYEE_NAME = '';
let BANK_DETAILS = { accountName: '', accountNumber: '', ifsc: '', branch: '' };

// Conference name/acronym/dates/location, admin-editable from Settings →
// General / set during first-run setup. Blank until loadConferenceInfo()
// resolves, matching server.js's own CONFERENCE object (also blank by
// default -- see the comment there for why). Every page load calls it (see
// the DOMContentLoaded listener below) so the landing page, admin header,
// and reminder composer default text all reflect the current setting
// without a code change.
let conferenceInfo = {
  name: '',
  acronym: '',
  startDate: '',
  endDate: '',
  location: '',
  dateLabel: '',
};

async function loadConferenceInfo() {
  try {
    const data = await (await fetch('/api/conference')).json();
    conferenceInfo = { ...conferenceInfo, ...data };
  } catch (e) {
    /* keep the fallback defaults above */
  }
  applyConferenceInfoToDom();
}

// Full month name, e.g. "22 November 2026" -- matches the wording already on
// the landing page (formatConferenceDates() server-side uses short "Nov" for
// the compact date-range badge instead; both read from the same fields).
function formatFullDate(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || '');
  if (!m) return '';
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

// "Saturday, 5 September 2026" -- the weekday matters on a deadline, since it
// tells the reader how much time they actually have. Computed from the date
// parts rather than toLocaleDateString so it can't be reordered by a locale.
function formatFullDateWithDay(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || '');
  if (!m) return '';
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${DAYS[d.getUTCDay()]}, ${formatFullDate(isoDate)}`;
}

// "28 Aug 2026" from a YYYY-MM-DD string -- same short-month style as the
// server's formatDMY() (server.js), used for the discount-code voucher and
// WhatsApp share message so both read the same way.
function formatDMY(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || '');
  if (!m) return '';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

function applyConferenceInfoToDom() {
  const c = conferenceInfo;
  document.title = document.title.includes('Admin')
    ? (c.acronym ? `${c.acronym} - Admin & Backend Portal` : 'Admin & Backend Portal')
    : (c.name || 'Registration Portal');

  const nameEl = document.getElementById('conf-name-h1');
  if (nameEl) {
    nameEl.textContent = (c.name || 'Registration Portal') + (nameEl.dataset.suffix || '');
    clearSkeleton(nameEl);
  }

  // Hidden until there's something real to show -- rather than a stale
  // placeholder sitting visible before first-run setup fills these in.
  const dateBadge = document.getElementById('conf-date-badge');
  if (dateBadge) { dateBadge.textContent = c.dateLabel || ''; dateBadge.classList.toggle('hidden', !c.dateLabel); }

  const locationLine = document.getElementById('conf-location-line');
  if (locationLine) { locationLine.textContent = c.location || ''; locationLine.classList.toggle('hidden', !c.location); }

  const presentDate = document.getElementById('conf-presentations-date');
  if (presentDate) presentDate.textContent = formatFullDate(c.endDate) || presentDate.textContent;

  // Reminder composer defaults (admin only) -- set once at load, well before
  // an admin could have opened the panel and started typing.
  const subjectInput = document.getElementById('reminder-subject');
  if (subjectInput && document.activeElement !== subjectInput) {
    subjectInput.value = c.acronym ? `Complete your registration for ${c.acronym}` : 'Complete your registration';
  }
}


// Human-readable labels for a registration's bank_status, used everywhere it's
// shown so raw DB constants (e.g. BANK_VERIFIED, PARTIAL_PAYMENT) never leak
// into the UI as-is.
const BANK_STATUS_LABELS = { PENDING: 'Pending', BANK_VERIFIED: 'Verified', REJECTED: 'Rejected', PARTIAL_PAYMENT: 'Partial Payment' };

const REJECTION_LABELS = {
  WRONG_DETAILS: 'Wrong payment details',
  WRONG_SCREENSHOT: 'Wrong screenshot attached',
  WRONG_CATEGORY: 'Wrong category selected',
  ID_DISCREPANCY: 'Student ID discrepancy',
  OTHER: 'Other',
  // legacy codes on older rejected rows
  PAYMENT: 'Payment discrepancy',
  ID: 'ID discrepancy',
};

// Browser storage can throw outright, not just come back empty: a browser set
// to block site data, and some private modes, throw on merely READING
// window.localStorage. These helpers touch it only inside a try, and carry on
// as if nothing were stored -- the identifier itself is evaluated inside the
// try, since passing localStorage in as an argument would throw before it.
function storageGet(kind, key) {
  try { return (kind === 'session' ? sessionStorage : localStorage).getItem(key); } catch (e) { return null; }
}
function storageSet(kind, key, value) {
  try { (kind === 'session' ? sessionStorage : localStorage).setItem(key, value); } catch (e) { /* not remembered */ }
}
function storageRemove(kind, key) {
  try { (kind === 'session' ? sessionStorage : localStorage).removeItem(key); } catch (e) { /* nothing to remove */ }
}

// Defensively parsed: a bad/corrupted value here (e.g. the literal string
// "undefined", which JSON.parse rejects) must never throw at module load --
// that would abort every later top-level const/let in this file, leaving
// them in the temporal-dead-zone and breaking the whole page. Storage that
// refuses to be read at all used to do exactly that; see storageGet.
function readStoredDelegate() {
  const raw = storageGet('local', 'nqocn_current_user');
  if (!raw || raw === 'undefined' || raw === 'null') return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    storageRemove('local', 'nqocn_current_user');
    return null;
  }
}
let currentDelegate = readStoredDelegate();

// A hall's door QR (/?hall=CODE): kept until the delegate is logged in (see
// markFromHallCode), and taken out of the address so a refresh or a shared
// link does not carry it.
(function captureHallCode() {
  try {
    const code = new URLSearchParams(window.location.search).get('hall');
    if (!code) return;
    storageSet('session', 'nqocn_hall', code);
    window.history.replaceState(null, '', window.location.pathname + window.location.hash);
  } catch (e) { /* no address to read */ }
}());

// Never store undefined/null -- JSON.stringify(undefined) is the string
// "undefined", not valid JSON, which is exactly what corrupts the next load.
function persistDelegate(user) {
  if (user) storageSet('local', 'nqocn_current_user', JSON.stringify(user));
  else storageRemove('local', 'nqocn_current_user');
}
let activeAdminUser = null;
// The delegate's own current registration (from /api/registrations/me), kept
// so the top-up flow knows the outstanding balance.
let currentRegistration = null;

// Read a File into a base64 data URL.
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = (e) => resolve(e.target.result);
    r.onerror = () => reject(new Error('Could not read file.'));
    r.readAsDataURL(file);
  });
}

// Non-blocking toast notifications, replacing native alert() (which blocks
// script execution and reads as jarring/dated on top of being untestable by
// browser automation). Creates its own container lazily so it works on any
// page that loads this script, delegate portal or admin panel alike.
const TOAST_STYLES = {
  error: 'bg-rose-600 text-white',
  success: 'bg-emerald-600 text-white',
  info: 'bg-slate-800 text-white',
};
function showToast(message, type = 'error') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'fixed top-4 left-1/2 -translate-x-1/2 z-[200] flex flex-col gap-2 w-full max-w-sm px-4 pointer-events-none';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `pointer-events-auto ${TOAST_STYLES[type] || TOAST_STYLES.error} rounded-xl shadow-lg px-4 py-3 text-sm font-semibold flex items-start justify-between gap-3`;
  const text = document.createElement('span');
  text.className = 'flex-1 whitespace-pre-line';
  text.textContent = message == null ? '' : String(message);
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'shrink-0 opacity-80 hover:opacity-100 font-bold leading-none';
  closeBtn.setAttribute('aria-label', 'Dismiss');
  closeBtn.textContent = '✕';
  closeBtn.onclick = () => toast.remove();
  toast.appendChild(text);
  toast.appendChild(closeBtn);
  container.appendChild(toast);
  setTimeout(() => toast.remove(), type === 'error' ? 7000 : 4000);
}

// Any role but DELEGATE counts as admin-capable -- including a custom one
// created in Settings -> Roles, which this checked against a hardcoded list
// of the five built-ins would have missed (this shows/hides the "go to
// admin panel" button on the delegate dashboard, which every account, admin
// or not, can land on). Mirrors isKnownAdminRole() on the server, which had
// the same gap in POST /api/users, PUT /api/users/:phone/role and the
// /admin page's own gate before it was fixed -- this is the client-side
// instance of the identical mistake, caught in the same sweep.
function isAdminUser() {
  return !!currentDelegate && !!currentDelegate.role && currentDelegate.role !== 'DELEGATE';
}

// Human-readable role names for display (raw values keep their underscores).
const ROLE_LABELS = {
  DELEGATE: 'Delegate',
  FINANCE_ADMIN: 'Finance Admin',
  ACADEMIC_REVIEWER: 'Academic Reviewer',
  FINANCE_ACADEMIC: 'Finance & Academic Reviewer',
  OPERATIONS: 'Operations',
  SUPER_ADMIN: 'Super Admin',
};
function roleLabel(role) {
  return ROLE_LABELS[role] || String(role || '')
    .toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Show the admin backend link (icon-only, next to Logout) only to a
// logged-in admin on the dashboard.
function updateAdminNav(show) {
  const btn = document.getElementById('admin-nav-btn');
  if (btn) btn.classList.toggle('hidden', !show);
}

// --- NAVIGATION & UI TOGGLES ---
function navigateTo(pageId) {
  document.querySelectorAll('main, section').forEach(el => el.classList.add('hidden'));
  const target = document.getElementById(pageId);
  if (target) target.classList.remove('hidden');
  // The dashboard and the programme carry the conference in their own navy
  // header; the title above the sign-in page would only repeat it.
  const hero = document.getElementById('portal-hero');
  if (hero) hero.classList.toggle('hidden', ['dashboard-page', 'programme-page', 'profile-page', 'map-page'].includes(pageId));
  // Off the map: stop following their location.
  if (pageId !== 'map-page') stopCampusLocate();
  updateDashTabs(pageId);
  // The Admin panel item, in the bar's account menu: for admins, on the
  // delegate's pages.
  updateAdminNav(Object.prototype.hasOwnProperty.call(DASH_TAB_OF_PAGE, pageId) && isAdminUser());
}


// The delegate's tab bar: on their own pages only, each tab when it has
// something behind it, the page they are on marked.
const DASH_TAB_OF_PAGE = { 'dashboard-page': 'home', 'programme-page': 'programme', 'map-page': 'map', 'profile-page': null };
let dashTabsPage = null;
function updateDashTabs(pageId) {
  if (pageId !== undefined) dashTabsPage = pageId;
  const bar = document.getElementById('dash-tabs');
  if (!bar) return;
  const on = Object.prototype.hasOwnProperty.call(DASH_TAB_OF_PAGE, dashTabsPage);
  bar.classList.toggle('hidden', !on);
  const topBar = document.getElementById('dash-bar');
  if (topBar) topBar.classList.toggle('hidden', !on);
  if (document.body && document.body.classList) {
    document.body.classList.toggle('has-tabs', on);
    // The delegate's pages start at the top; sign-in stays centred.
    document.body.classList.toggle('justify-center', !on);
    document.body.classList.toggle('justify-start', on);
  }
  const has = {
    home: true,
    programme: !!(programmeData && (programmeData.sessions || []).length),
    map: !!(programmeData && campusPlaces(programmeData.halls).length),
    badge: !!(currentRegistration && currentRegistration.bank_status === 'BANK_VERIFIED'),
  };
  for (const [tab, shown] of Object.entries(has)) {
    const btn = document.getElementById(`dash-tab-${tab}`);
    if (!btn) continue;
    const here = DASH_TAB_OF_PAGE[dashTabsPage] === tab;
    btn.classList.toggle('hidden', !shown);
    if (btn.setAttribute) btn.setAttribute('aria-current', here ? 'page' : 'false');
    btn.classList.toggle('bg-gold-50', here);
    btn.classList.toggle('text-navy', here);
    btn.classList.toggle('font-bold', here);
    btn.classList.toggle('text-slate-600', !here);
  }
  // The same tabs as links in the conference bar, from tablet width up; the
  // page they are on is marked by aria-current (pale gold, styles.css).
  const links = document.querySelectorAll ? document.querySelectorAll('.dash-nav-link') : [];
  for (const link of links) {
    const tab = link.dataset ? link.dataset.tab : null;
    const here = DASH_TAB_OF_PAGE[dashTabsPage] === tab;
    link.classList.toggle('hidden', !has[tab]);
    if (link.setAttribute) link.setAttribute('aria-current', here ? 'page' : 'false');
  }
}

// Initials for the bar's account button: "Dr Asha Rao" -> "AR".
function nameInitials(name) {
  const words = String(name || '').replace(/^\s*(dr|prof|mr|mrs|ms|miss|shri|smt)\.?\s+/i, '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
}

// Who is signed in, on the bar's account button: their initials, and from a
// laptop up their name.
function setBarAccount(name) {
  const initials = nameInitials(name);
  const box = document.getElementById('dash-me-initials');
  if (box && initials) box.textContent = initials;
  setText('dash-me-name', name || '');
}

function toggleAuth(view) {
  const regForm = document.getElementById('register-form');
  const loginForm = document.getElementById('login-form');

  if (view === 'register') {
    // Fill the country list and apply its rules the first time the form is
    // shown, so the phone/address fields are never briefly in the wrong shape.
    populateSignupCountries();
    onSignupCountryChange();
    resetSignupWizard();
    regForm.classList.remove('hidden');
    loginForm.classList.add('hidden');
  } else {
    loginForm.classList.remove('hidden');
    regForm.classList.add('hidden');
  }
}

// OTP vs password is a login-flow choice, not two different accounts --
// every account can always fall back to OTP regardless of whether a
// password is also set. handleLogin() below reads this to decide which
// endpoint to call.
let loginMode = 'password';
function setLoginMode(mode) {
  loginMode = mode;
  const isOtp = mode === 'otp';
  document.getElementById('login-otp-mode').classList.toggle('hidden', !isOtp);
  document.getElementById('login-password-mode').classList.toggle('hidden', isOtp);
  const otpBtn = document.getElementById('login-mode-otp-btn');
  const pwBtn = document.getElementById('login-mode-password-btn');
  otpBtn.classList.toggle('bg-white', isOtp); otpBtn.classList.toggle('shadow-sm', isOtp); otpBtn.classList.toggle('text-indigo-700', isOtp); otpBtn.classList.toggle('text-slate-500', !isOtp);
  pwBtn.classList.toggle('bg-white', !isOtp); pwBtn.classList.toggle('shadow-sm', !isOtp); pwBtn.classList.toggle('text-indigo-700', !isOtp); pwBtn.classList.toggle('text-slate-500', isOtp);
  setText('login-submit-btn', isOtp ? 'Verify OTP & Login' : 'Login');
}

// --- PIN CODE ----------------------------------------------------------
// Two separate questions, deliberately answered by two different sources:
//
//   Does this PIN exist?  -> our own /api/pincode, from the dataset the app
//                            ships. Authoritative, always reachable, and the
//                            same list the server enforces at register time.
//   What is its state and district?
//                         -> api.postalpincode.in, purely as a convenience.
//
// They used to be one question put to the third party, whose failure text
// said "Invalid PIN Code or API unreachable" -- it genuinely could not tell
// those apart. A delegate on a slow or filtered connection was told their
// address was wrong, and since state and district are readonly and filled
// only by that call, they then had no way to proceed at all.
//
// So a lookup failure now unlocks the two fields to be typed instead of
// blocking the form. State and district are required (see
// validateSignupStep), but never unfillable.
function setAddressFieldsEditable(editable, prefix = 'reg') {
  [`${prefix}-state`, `${prefix}-district`].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.readOnly = !editable;
    el.classList.toggle('bg-slate-100', !editable);
    el.classList.toggle('text-slate-600', !editable);
    el.classList.toggle('bg-white', editable);
  });
}

// null means "could not check" -- never a rejection. The register endpoint
// applies the same list and is what actually decides.
async function checkPincodeKnown(pin) {
  try {
    const res = await fetch(`/api/pincode/${encodeURIComponent(pin)}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.checkable) return null;
    return !!data.known;
  } catch (e) {
    return null;
  }
}

// `prefix` lets the front desk's edit form drive exactly this logic against
// its own controls rather than growing a second, subtly different copy. The
// careful part here is the fallback -- an unrecognised PIN blocks, but a PIN
// we recognise and merely cannot NAME unlocks the two fields to be typed --
// and that is precisely the part a duplicate would get wrong.
async function fetchAddressDetails(pincode, prefix = 'reg') {
  const statusSpan = document.getElementById(`${prefix === 'reg' ? '' : prefix + '-'}pincode-status`)
    || document.getElementById('pincode-status');
  const stateInput = document.getElementById(`${prefix}-state`);
  const districtInput = document.getElementById(`${prefix}-district`);
  if (!statusSpan || !stateInput || !districtInput) return;

  const say = (text, tone) => {
    statusSpan.innerText = text;
    statusSpan.className = `text-xs mt-1 block font-medium ${
      tone === 'ok' ? 'text-emerald-600 font-bold'
      : tone === 'bad' ? 'text-rose-600 font-bold'
      : tone === 'warn' ? 'text-amber-700 font-bold' : 'text-indigo-600'}`;
  };

  const pin = String(pincode || '').trim();
  if (pin.length !== 6) {
    say('', 'info');
    stateInput.value = '';
    districtInput.value = '';
    setAddressFieldsEditable(false, prefix);
    return;
  }

  say('Checking PIN code…', 'info');

  // 1. Does it exist? Our own list decides.
  let known = null;   // null = could not check
  try {
    const res = await fetch(`/api/pincode/${encodeURIComponent(pin)}`);
    if (res.ok) {
      const data = await res.json();
      known = data.checkable ? !!data.known : null;
      if (data.checkable && !data.known) {
        say(`${pin} is not a PIN code we recognise.`, 'bad');
        stateInput.value = '';
        districtInput.value = '';
        setAddressFieldsEditable(false, prefix);
        return;
      }
    }
  } catch (e) { /* fall through: treat as "could not check" */ }

  // 2. What is it called? A convenience, so its failure is not fatal.
  try {
    const res = await fetch(`https://api.postalpincode.in/pincode/${encodeURIComponent(pin)}`);
    const data = await res.json();
    if (data && data[0] && data[0].Status === 'Success' && data[0].PostOffice && data[0].PostOffice.length) {
      stateInput.value = data[0].PostOffice[0].State;
      districtInput.value = data[0].PostOffice[0].District;
      setAddressFieldsEditable(false, prefix);
      say(known === false ? 'PIN code found' : '✓ PIN code verified', 'ok');
      return;
    }
    throw new Error('no match');
  } catch (e) {
    // The PIN is fine (or unverifiable) but we could not name it. Let them
    // fill it in rather than stopping here.
    setAddressFieldsEditable(true, prefix);
    if (!stateInput.value) stateInput.focus();
    say(known === true
      ? 'PIN code recognised, but we could not look up its state and district. Please type them below.'
      : 'We could not look up this PIN code just now. Please type your state and district below.', 'warn');
  }
}

// --- AUTHENTICATION API CALLS ---
// Signup OTPs: either channel can be verified, and the server only requires
// one of them (see POST /api/auth/register). Tracked here purely so the
// status line and the submit-time check can tell you which you've done.
const signupVerified = { phone: false, email: false };

async function requestSignupOTP(which) {
  const isPhone = which === 'phone';
  const destination = document.getElementById(isPhone ? 'reg-phone' : 'reg-email').value.trim();
  if (isPhone && !isIndianPhone(destination)) {
    return showToast('We can only send SMS to Indian mobile numbers. Verify your email address instead.');
  }
  if (!isPhone && !EMAIL_RE.test(destination)) {
    return showToast('Please enter a valid email address.');
  }

  const data = await (await fetch('/api/otp/request', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ destination }),
  })).json();

  if (!data.success) return showToast(data.error || 'Could not send OTP. Please try again.');

  const containerId = isPhone ? 'reg-otp-container' : 'reg-email-otp-container';
  const hintId = isPhone ? 'reg-otp-hint' : 'reg-email-otp-hint';
  document.getElementById(containerId).classList.remove('hidden');
  const where = isPhone ? (toE164(destination) || destination) : destination;
  if (data.devOtp) {
    setText(hintId, `Demo OTP: ${data.devOtp}`);
    showToast(`OTP for ${where}: ${data.devOtp}`, 'info');
  } else {
    setText(hintId, isPhone ? 'Sent via SMS' : 'Sent via email');
    showToast(`A 6-digit OTP has been sent to ${where}.`, 'info');
  }
}

// Reflects which channels have a code entered -- the server is what actually
// decides, this just stops someone submitting the whole form with neither.
function updateSignupVerifyStatus() {
  const el = document.getElementById('reg-verify-status');
  if (!el) return;
  const hasPhoneOtp = !!(document.getElementById('reg-otp') || {}).value?.trim();
  const hasEmailOtp = !!(document.getElementById('reg-email-otp') || {}).value?.trim();
  if (hasPhoneOtp || hasEmailOtp) {
    const which = [hasPhoneOtp && 'mobile', hasEmailOtp && 'email'].filter(Boolean).join(' + ');
    el.textContent = `OTP entered for ${which}`;
    el.className = 'text-[11px] font-bold text-emerald-700 shrink-0';
  } else {
    el.textContent = 'Verify mobile or email';
    el.className = 'text-[11px] font-bold text-amber-700 shrink-0';
  }
}

// Login OTPs go through a different endpoint to the signup ones above: it
// resolves the identifier to a real account and refuses to send a code to a
// channel that account hasn't verified.
async function requestLoginOTP() {
  const identifier = document.getElementById('login-identifier').value.trim();
  if (!identifier) return showToast('Enter your mobile number or email address.');

  const data = await (await fetch('/api/auth/login-otp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  })).json();

  if (data.notRegistered) {
    // Carry whatever they typed into the signup form's matching field.
    toggleAuth('register');
    const isEmail = EMAIL_RE.test(identifier);
    document.getElementById(isEmail ? 'reg-email' : 'reg-phone').value = identifier;
    return showToast("That isn't registered yet — please complete the sign-up form to create your account.", 'info');
  }
  if (!data.success) return showToast(data.error || 'Could not send OTP. Please try again.');

  document.getElementById('login-otp-container').classList.remove('hidden');
  if (data.devOtp) {
    setText('login-otp-hint', `Demo OTP: ${data.devOtp}`);
    showToast(`Your OTP is: ${data.devOtp}`, 'info');
  } else {
    setText('login-otp-hint', data.channel === 'email' ? 'Sent via email' : 'Sent via SMS');
    showToast(`A 6-digit OTP has been sent to your ${data.channel === 'email' ? 'email address' : 'mobile'}.`, 'info');
  }
}

// Same pattern the server enforces (server.js) -- pragmatic "good enough"
// email shape, not full RFC 5322. Checked here too so a malformed address
// is caught immediately with the app's own toast, instead of only via the
// browser's native type="email" validation (which is inconsistently loose
// across browsers) or a round-trip to the server.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// --- PHONE NUMBERS ------------------------------------------------------
// Mirrors toE164 / isIndianPhone in server.js -- same rules, so the client
// never accepts something the server will reject (or vice versa). Numbers
// are held in E.164 (+<country><number>); a bare national number is assumed
// to be the default country.
const DEFAULT_PHONE_CC = '91';
const E164_RE = /^\+[1-9]\d{7,14}$/;
const INDIAN_E164_RE = /^\+91[6-9]\d{9}$/;

function toE164(v, defaultCc = DEFAULT_PHONE_CC) {
  let raw = String(v || '').trim().replace(/[\s()\-.]/g, '');
  if (!raw) return '';
  // Letters mean this is not a phone number -- most importantly a synthetic
  // account key, whose leftover digits would otherwise be read as one. Mirrors
  // the same guard in server.js.
  if (/[a-z]/i.test(raw)) return '';
  if (raw.startsWith('+')) return E164_RE.test(raw) ? raw : '';
  raw = raw.replace(/\D/g, '');
  if (!raw) return '';
  if (raw.length === 11 && raw.startsWith('0')) raw = raw.slice(1);
  if (raw.length > 10 && raw.startsWith(defaultCc)) {
    const withPlus = `+${raw}`;
    return E164_RE.test(withPlus) ? withPlus : '';
  }
  if (raw.length !== 10) return '';
  const withCc = `+${defaultCc}${raw}`;
  return E164_RE.test(withCc) ? withCc : '';
}
const isPhoneValue = (v) => !!toE164(v);

// Delegate portal only (admin.html has no #dashboard-page). Shows the
// dashboard immediately from the cached user, before restoreSession()'s
// network round-trip resolves -- otherwise the login page is what's in the
// HTML by default, and it flashes on screen for every returning delegate
// until that fetch comes back. restoreSession() still re-validates against
// the server afterwards and reverts to the login page if the session
// turned out to be stale.
//
// POSITION MATTERS. This is top-level code, so it runs DURING this script's
// evaluation and can only use bindings already initialised above it:
// navigateTo/isAdminUser, and -- since it prints the delegate's
// phone -- delegateDisplayPhone's whole chain, toE164 / isPhoneValue /
// DEFAULT_PHONE_CC. Reading a `const` declared further down throws a
// temporal-dead-zone ReferenceError, and because this is top-level that
// aborts the REST OF THE FILE: every constant below stays uninitialised and
// the portal renders as raw HTML ("Registration Pending" with a
// Register & Pay button) for every returning delegate. That is exactly what
// happened when the phone helpers were added below it, so it now sits after
// them -- and the try/catch makes a repeat cost a flash of the login page
// instead of the whole app.
try {
  if (currentDelegate && document.getElementById('dashboard-page')) {
    navigateTo('dashboard-page');
    const displayName = currentDelegate.full_name || currentDelegate.name;
    const nameEl = document.getElementById('user-display-name');
    const subEl = document.getElementById('user-display-sub');
    if (nameEl) nameEl.innerText = currentDelegate.salutation ? `${currentDelegate.salutation} ${displayName}` : displayName;
    setBarAccount(currentDelegate.salutation ? `${currentDelegate.salutation} ${displayName}` : displayName);
    if (subEl) subEl.innerText = `${currentDelegate.designation} | ${currentDelegate.institution || currentDelegate.institute} (${delegateDisplayPhone(currentDelegate) || currentDelegate.email || ''})`;
  }
} catch (err) {
  // Never let the optimistic paint take the rest of the script with it.
  console.error('Early dashboard paint failed; falling back to restoreSession.', err);
}
const isIndianPhone = (v) => INDIAN_E164_RE.test(toE164(v));

// Countries offered at signup. India first (the overwhelming majority and
// the default), then alphabetical. Not an exhaustive ISO list -- it covers
// the places delegates realistically attend from, and "Other" is the escape
// hatch so nobody is ever blocked by an absent entry.
const SIGNUP_COUNTRIES = ['India', 'Australia', 'Bangladesh', 'Bhutan', 'Canada', 'China', 'Egypt', 'Ethiopia',
  'France', 'Germany', 'Ghana', 'Indonesia', 'Ireland', 'Italy', 'Japan', 'Kenya', 'Malaysia', 'Maldives',
  'Mauritius', 'Nepal', 'Netherlands', 'New Zealand', 'Nigeria', 'Oman', 'Pakistan', 'Philippines', 'Qatar',
  'Saudi Arabia', 'Singapore', 'South Africa', 'South Korea', 'Spain', 'Sri Lanka', 'Sweden', 'Switzerland',
  'Tanzania', 'Thailand', 'Uganda', 'United Arab Emirates', 'United Kingdom', 'United States', 'Vietnam',
  'Zambia', 'Zimbabwe', 'Other'];

function populateSignupCountries() {
  const sel = document.getElementById('reg-country');
  if (!sel || sel.options.length) return;
  sel.innerHTML = SIGNUP_COUNTRIES.map((c) => `<option value="${esc(c)}"${c === 'India' ? ' selected' : ''}>${esc(c)}</option>`).join('');
}

const signupCountryIsIndia = () => {
  const sel = document.getElementById('reg-country');
  return !sel || sel.value === 'India';
};

// Country decides the shape of the phone field and which address block
// applies. Mirrors the server's rules in POST /api/auth/register.
function onSignupCountryChange() {
  const india = signupCountryIsIndia();
  const phone = document.getElementById('reg-phone');
  const cc = document.getElementById('reg-phone-cc');

  if (cc) cc.classList.toggle('hidden', !india);
  if (phone) {
    phone.classList.toggle('pl-12', india);
    phone.maxLength = india ? 10 : 20;
    phone.placeholder = india ? '10-digit Mobile No.' : 'e.g. +44 7700 900123';
    if (!india) phone.value = phone.value.replace(/^\+?91/, '');
  }
  setText('reg-phone-label', india ? 'Mobile Number' : 'Mobile Number (optional)');
  // We can only SMS Indian numbers, so there is no OTP to send anywhere
  // else -- an international delegate verifies by email instead. Hides the
  // whole "Mobile OTP" block in the Verify step, not just its button, so
  // there's no dangling label with nothing to press.
  const phoneOtpBlock = document.getElementById('reg-phone-otp-block');
  if (phoneOtpBlock) phoneOtpBlock.classList.toggle('hidden', !india);
  const otpBox = document.getElementById('reg-otp-container');
  if (!india && otpBox) { otpBox.classList.add('hidden'); const o = document.getElementById('reg-otp'); if (o) o.value = ''; }

  const indiaBlock = document.getElementById('reg-address-india');
  const intlBlock = document.getElementById('reg-address-intl');
  if (indiaBlock) indiaBlock.classList.toggle('hidden', !india);
  if (intlBlock) { intlBlock.classList.toggle('hidden', india); intlBlock.classList.toggle('grid', !india); }
  updateSignupVerifyStatus();
}

// --- SIGNUP WIZARD ---
// Five visible steps over the one form above; every field stays in the DOM
// throughout; handleRegistration() below reads all of them by id regardless
// of step, so this is a pure presentation layer. Per-step checks are a UX
// nicety only -- the server is the real gate on submit either way.
const SIGNUP_STEP_LABELS = ['Name', 'Contact', 'Verify', 'Details', 'Address'];
let signupStep = 1;

function resetSignupWizard() {
  showSignupStep(1);
}

function showSignupStep(n) {
  signupStep = n;
  for (let i = 1; i <= 5; i++) {
    const el = document.getElementById(`reg-step-${i}`);
    if (el) el.classList.toggle('hidden', i !== n);
  }
  document.querySelectorAll('.reg-step-dot').forEach((dot) => {
    const i = Number(dot.dataset.step);
    dot.classList.toggle('bg-indigo-600', i <= n);
    dot.classList.toggle('bg-slate-200', i > n);
  });
  setText('reg-step-label', `Step ${n} of 5 · ${SIGNUP_STEP_LABELS[n - 1]}`);
  const backBtn = document.getElementById('reg-back-btn');
  const nextBtn = document.getElementById('reg-next-btn');
  const submitBtn = document.getElementById('reg-submit-btn');
  if (backBtn) backBtn.classList.toggle('hidden', n === 1);
  if (nextBtn) nextBtn.classList.toggle('hidden', n === 5);
  if (submitBtn) { submitBtn.classList.toggle('hidden', n !== 5); submitBtn.disabled = n !== 5; }
  if (n === 3) updateSignupContactRecap();
  const firstField = document.getElementById(`reg-step-${n}`)?.querySelector('input, select');
  if (firstField) firstField.focus({ preventScroll: true });
}

async function nextSignupStep() {
  const btn = document.getElementById('reg-next-btn');
  const original = btn ? btn.innerText : null;
  if (btn) { btn.disabled = true; btn.innerText = 'Please wait…'; }
  try {
    const err = await validateSignupStep(signupStep);
    if (err) return showToast(err);
    showSignupStep(Math.min(signupStep + 1, 5));
  } finally {
    if (btn) { btn.disabled = false; btn.innerText = original; }
  }
}

function prevSignupStep() {
  showSignupStep(Math.max(signupStep - 1, 1));
}

function updateSignupContactRecap() {
  const el = document.getElementById('reg-contact-recap');
  if (!el) return;
  const india = signupCountryIsIndia();
  const phone = document.getElementById('reg-phone').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const parts = [];
  if (phone) parts.push(india ? `+91 ${phone}` : phone);
  if (email) parts.push(email);
  el.textContent = parts.length ? `Sending a code to ${parts.join(' and ')}.` : 'Enter a mobile number or email to receive a code.';
}

// Shared by the Contact step's Next gate and handleRegistration's own
// pre-flight check, so the two can't drift apart.
function validateSignupContact() {
  const phone = document.getElementById('reg-phone').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const india = signupCountryIsIndia();
  if (india && !phone) return 'A mobile number is required.';
  if (india && phone && !isIndianPhone(phone)) {
    return 'Enter a valid 10-digit Indian mobile number, or change your country.';
  }
  if (phone && !isPhoneValue(phone)) return 'Please enter a valid mobile number, including the country code.';
  if (!india && phone && isIndianPhone(phone)) {
    return 'That looks like an Indian mobile number — please set your country to India.';
  }
  if (!email) return 'An email address is required.';
  if (!EMAIL_RE.test(email)) return 'Please enter a valid email address.';
  return null;
}

// Checked once the Contact step's own format checks above already pass --
// no point asking the server about a number/address that isn't even shaped
// right yet. A network hiccup fails OPEN (returns no error) rather than
// stranding the wizard: POST /api/auth/register is the real, unconditional
// gate regardless of what this said.
async function checkSignupContactAvailable() {
  const phone = document.getElementById('reg-phone').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  try {
    const data = await (await fetch('/api/auth/check-contact', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, email }),
    })).json();
    if (data.emailTaken) return 'An account with this email address already exists. Please sign in instead.';
    if (data.phoneTaken) return 'An account with this mobile number already exists. Please sign in instead.';
    return null;
  } catch (e) {
    return null;
  }
}

async function validateSignupStep(n) {
  if (n === 1) {
    if (!document.getElementById('reg-name').value.trim()) return 'Please enter your full name.';
    return null;
  }
  if (n === 2) {
    const formatErr = validateSignupContact();
    if (formatErr) return formatErr;
    return await checkSignupContactAvailable();
  }
  if (n === 3) {
    const phoneOtp = document.getElementById('reg-otp').value.trim();
    const emailOtp = document.getElementById('reg-email-otp').value.trim();
    if (!phoneOtp && !emailOtp) {
      return signupCountryIsIndia()
        ? 'Verify your mobile number or your email address with an OTP to continue.'
        : 'Verify your email address with an OTP to continue — we can only send SMS to Indian numbers.';
    }
    return null;
  }
  if (n === 4) {
    if (!document.getElementById('reg-age').value) return 'Please enter your age.';
    if (!document.getElementById('reg-gender').value) return 'Please select your gender.';
    if (!document.getElementById('reg-designation').value.trim()) return 'Please enter your designation.';
    if (!document.getElementById('reg-institute').value.trim()) return 'Please enter your institute or organization.';
    const pw = document.getElementById('reg-password').value;
    if (!pw || pw.length < 8) return 'Please set a password of at least 8 characters.';
    return null;
  }
  // Step 5 is the address, and had no checks at all -- the wizard would let
  // you finish with an empty one and the server stored whatever arrived.
  // Indian delegates only: elsewhere these columns hold a free-text region
  // and city, with no PIN to check (see the register endpoint, which
  // enforces the same rules and is the one that actually decides).
  if (n === 5) {
    if (!signupCountryIsIndia()) return null;
    const pin = document.getElementById('reg-pincode').value.trim();
    if (!/^[1-9][0-9]{5}$/.test(pin)) return 'Please enter a valid 6-digit PIN code.';
    const known = await checkPincodeKnown(pin);
    if (known === false) return `${pin} is not a PIN code we recognise. Please check and try again.`;
    if (!document.getElementById('reg-state').value.trim()) return 'Please enter your state.';
    if (!document.getElementById('reg-district').value.trim()) return 'Please enter your district.';
    return null;
  }
  return null;
}

async function handleRegistration(e) {
  e.preventDefault();
  for (let step = 1; step <= 4; step++) {
    const err = await validateSignupStep(step);
    if (err) return showToast(err);
  }

  const phone = document.getElementById('reg-phone').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const phoneOtp = document.getElementById('reg-otp').value.trim();
  const emailOtp = document.getElementById('reg-email-otp').value.trim();
  const country = (document.getElementById('reg-country') || {}).value || 'India';
  const india = signupCountryIsIndia();
  const password = document.getElementById('reg-password').value;

  const payload = {
    phone,
    email,
    phoneOtp,
    emailOtp,
    salutation: document.getElementById('reg-salutation').value,
    name: document.getElementById('reg-name').value,
    age: document.getElementById('reg-age').value,
    gender: document.getElementById('reg-gender').value,
    designation: document.getElementById('reg-designation').value,
    institute: document.getElementById('reg-institute').value,
    password,
    country,
    // state/district carry the free-text region and city for an
    // international delegate -- the same columns, since they mean the same
    // thing; only the way they're collected differs.
    pincode: india ? document.getElementById('reg-pincode').value : '',
    state: india ? document.getElementById('reg-state').value : document.getElementById('reg-region').value,
    district: india ? document.getElementById('reg-district').value : document.getElementById('reg-city').value,
  };

  const res = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();

  if (data.success) {
    currentDelegate = data.user;
    persistDelegate(currentDelegate);
    showToast('Verified! Your account has been created.', 'success');
    await loadDashboard();
    // Straight into payment (step 1) so a freshly-created account doesn't
    // sit "signed up but never paid" -- that's the drop-off we're trying
    // to close, not just get them to the dashboard.
    openPaymentModal();
  } else {
    showToast(data.error || "Registration failed.");
  }
}

async function handleLogin(e) {
  e.preventDefault();
  if (loginMode === 'password') return handlePasswordLogin();

  const identifier = document.getElementById('login-identifier').value.trim();
  const otp = document.getElementById('login-otp').value.trim();
  if (!identifier) return showToast('Enter your mobile number or email address.');
  if (!otp) return showToast('Enter the OTP that was sent to you.');

  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, otp })
  });
  const data = await res.json();

  if (data.success) {
    currentDelegate = data.user;
    persistDelegate(currentDelegate);
    const welcomeName = currentDelegate.full_name || currentDelegate.name;
    showToast(`Welcome back, ${currentDelegate.salutation ? currentDelegate.salutation + ' ' : ''}${welcomeName}!`, 'success');
    // A delegate who logs in mid-maintenance gets the notice, not a dashboard
    // whose every API call is going to come back 503.
    if (await shouldShowMaintenance(currentDelegate)) return navigateTo('maintenance-page');
    loadDashboard();
    runPostLoginPrompts();
  } else if (data.notRegistered) {
    // New identifier — switch to sign-up, carrying it across. Land on the
    // Contact step so the carried-over value is immediately visible rather
    // than tucked away behind the Name step.
    toggleAuth('register');
    const isEmail = EMAIL_RE.test(identifier);
    document.getElementById(isEmail ? 'reg-email' : 'reg-phone').value = identifier;
    showSignupStep(2);
    showToast("That isn't registered yet — please complete the sign-up form to create your account.", 'info');
  } else {
    showToast(data.error || "Login failed.");
  }
}

async function handlePasswordLogin() {
  const identifier = document.getElementById('login-password-identifier').value.trim();
  const password = document.getElementById('login-password').value;
  if (!identifier) return showToast('Enter your mobile number or email address.');
  if (!password) return showToast('Enter your password.');

  const res = await fetch('/api/auth/login-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  });
  const data = await res.json();
  if (!data.success) return showToast(data.error || 'Login failed.');

  currentDelegate = data.user;
  persistDelegate(currentDelegate);
  const welcomeName = currentDelegate.full_name || currentDelegate.name;
  showToast(`Welcome back, ${currentDelegate.salutation ? currentDelegate.salutation + ' ' : ''}${welcomeName}!`, 'success');
  if (await shouldShowMaintenance(currentDelegate)) return navigateTo('maintenance-page');
  loadDashboard();
  runPostLoginPrompts();
}

// --- DELEGATE DASHBOARD & FEATURES ---
async function loadDashboard() {
  if (!currentDelegate) return navigateTo('auth-page');

  const displayName = currentDelegate.full_name || currentDelegate.name;
  document.getElementById('user-display-name').innerText = currentDelegate.salutation ? `${currentDelegate.salutation} ${displayName}` : displayName;
  setBarAccount(currentDelegate.salutation ? `${currentDelegate.salutation} ${displayName}` : displayName);
  // phone_number is the account key, which is only a real number for
  // phone-based accounts -- fall back to the email for email-only ones
  // rather than printing a synthetic key as if it were a mobile.
  const contactLine = delegateDisplayPhone(currentDelegate)
    ? delegateDisplayPhone(currentDelegate)
    : (currentDelegate.email || '');
  document.getElementById('user-display-sub').innerText =
    `${currentDelegate.designation} | ${currentDelegate.institution || currentDelegate.institute}${contactLine ? ` (${contactLine})` : ''}`;

  renderVerifyEmailBanner();
  setText('dash-acronym', (conferenceInfo.acronym || '').toUpperCase());
  setText('dash-when', [shortDateRange(conferenceInfo.startDate, conferenceInfo.endDate), conferenceInfo.location].filter(Boolean).join(' · '));

  // Show the dashboard shell now rather than gating it behind three
  // separate network round trips run one after another -- on a slow
  // connection that meant staring at nothing but the "Welcome back" toast
  // for as long as all three combined took, and a single one of them
  // rejecting outright used to throw straight past navigateTo, leaving the
  // delegate stuck with no page under the toast at all. The markup already
  // ships neutral placeholder states for exactly this ("Checking...", "Not
  // Submitted", the bootstrap chip below) -- this is what they're for. Each
  // section now fills in on its own, in parallel, as its own fetch resolves.
  navigateTo('dashboard-page');

  await Promise.all([
    (async () => {
      try {
        const regRes = await fetch('/api/registrations/me');
        const regData = await regRes.json();
        applyRegistrationState(regData.registration);
      } catch (e) { /* leave as-is */ }
    })(),
    loadAbstractStatus(),
    renderGroupSection(),
    markFromHallCode().then(() => Promise.all([loadAttendanceCard(), loadProgrammeCard()])),
  ]);
  // The one thing that matters now, from everything just loaded; and the
  // badge's back, which needs the programme and their workshop.
  renderHomeHero();
  renderBadgeBack();
  // Every section has had its turn, including the ones that failed -- see
  // settleSkeletons on why a shimmer must not outlive the attempt.
  settleSkeletons();
}

// --- The virtual badge (portal) ---
// Shown once the registration is verified: the conference, the delegate's
// role (FACULTY for anyone on the faculty list), name, designation and
// institution, and their desk pass QR -- the registration number, which the
// desk and the hall-door volunteers scan.
function renderBadge(reg) {
  const pass = document.getElementById('desk-pass');
  if (!pass || !/^[A-Za-z0-9-]{3,32}$/.test(reg.registration_number || '')) return;
  const c = conferenceInfo;
  const d = currentDelegate || {};
  const role = reg.is_faculty_member ? 'FACULTY' : 'DELEGATE';
  setText('badge-acronym', (c.acronym || '').toUpperCase());
  setText('badge-conference', c.name || '');
  setText('badge-when', [shortDateRange(c.startDate, c.endDate), c.location].filter(Boolean).join(' · '));
  const ribbon = document.getElementById('badge-role');
  ribbon.textContent = role;
  ribbon.classList.toggle('bg-[#b08d3c]', role === 'FACULTY');
  ribbon.classList.toggle('bg-[#2f5673]', role !== 'FACULTY');
  setText('badge-name', reg.delegate_name || [d.salutation, d.full_name || d.name].filter(Boolean).join(' '));
  setText('badge-designation', d.designation || '');
  setText('badge-institution', d.institution || d.institute || '');
  document.getElementById('desk-pass-qr').src = `/api/qr/${encodeURIComponent(reg.registration_number)}.png`;
  // The full-screen badge's QR, loaded now so tapping Badge shows it at once.
  const fullQr = document.getElementById('badge-full-qr');
  if (fullQr) fullQr.src = `/api/qr/${encodeURIComponent(reg.registration_number)}.png`;
  setText('badge-reg', reg.registration_number);
  setText('badge-category', reg.category_label || '');
  const acr = (c.acronym || '').toUpperCase();
  setText('badge-strap-text', acr ? `${acr} · ${acr} · ${acr}` : '');
  setText('badge-back-acronym', acr);
  pass.classList.remove('hidden');
  renderBadgeBack();
  initBadge3d();
}

// The badge's back: what is coming up -- the next few talks from now, by
// day, time and hall; of the workshops, only their own; no breaks; a session
// common to several halls once. Refreshed every minute, so on the day it
// keeps up with the programme.
let badgeBackTimer = null;
function renderBadgeBack() {
  const box = document.getElementById('badge-back-programme');
  if (!box) return;
  if (!badgeBackTimer && typeof setInterval === 'function') badgeBackTimer = setInterval(renderBadgeBack, 60000);
  const sessions = (programmeData && programmeData.sessions) || [];
  if (!sessions.length) { box.innerHTML = '<p>The programme will be shown here.</p>'; return; }
  const ist = new Date(Date.now() + 5.5 * 3600e3);
  const today = ist.toISOString().slice(0, 10);
  const nowMin = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const mine = new Set(((attendanceMeData && attendanceMeData.workshops) || []).map((w) => w.optionId));
  const ahead = sessions.filter((x) => !progIsBreak(x) && (!x.workshop || mine.has(x.optionId))
    && (x.date > today || (x.date === today && progToMin(x.end) >= nowMin)));
  const allHalls = [...new Set(sessions.map((x) => x.hall))];
  const items = programmeItems(ahead).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)).slice(0, 4);
  const when = (it) => `${it.date === today ? (progToMin(it.start) <= nowMin ? 'Now' : 'Today') : shortDateRange(it.date, it.date).replace(/ \d{4}$/, '')} · ${guestTime12(it.start)}`;
  box.innerHTML = items.length
    ? items.map((it) => `<div><p class="text-[11px] font-bold text-indigo-700 uppercase tracking-wide">${esc(when(it))} · ${esc(hallsLabel(it.halls, allHalls))}</p>
        <p class="text-slate-800 leading-snug line-clamp-2">${esc(it.title)}</p></div>`).join('')
    : '<p>The programme is over. Thank you for attending.</p>';
}

// The badge in 3D: it tilts with the pointer, or with the phone (iPhones ask
// once, on the first tap), and a tap turns it over. Still for anyone who
// asked for less motion.
let badge3dReady = false;
let badgeMotionAsked = false;
function tiltBadge(x, y) {
  const swing = document.getElementById('badge3d-swing');
  const card = document.getElementById('badge-card');
  if (!swing || !card) return;
  const cx = Math.max(-1, Math.min(1, x));
  const cy = Math.max(-1, Math.min(1, y));
  swing.style.transform = `rotateX(${(-cy * 12).toFixed(1)}deg) rotateY(${(cx * 20).toFixed(1)}deg)`;
  if (card.style.setProperty) card.style.setProperty('--sheen', `${Math.round(-60 + (cx + 1) * 80)}%`);
}
function onBadgeOrientation(e) {
  if (e.gamma == null || e.beta == null) return;
  tiltBadge(e.gamma / 30, (e.beta - 45) / 30);
}
function initBadge3d() {
  if (badge3dReady) return;
  badge3dReady = true;
  const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const stage = document.getElementById('badge3d-stage');
  if (!stage || still) return;
  stage.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    const b = stage.getBoundingClientRect();
    tiltBadge(((e.clientX - b.left) / b.width) * 2 - 1, ((e.clientY - b.top) / b.height) * 2 - 1);
  });
  stage.addEventListener('pointerleave', () => tiltBadge(0, 0));
  // Phones that hand out motion freely (Android): listen now.
  if (window.DeviceOrientationEvent && typeof window.DeviceOrientationEvent.requestPermission !== 'function') {
    window.addEventListener('deviceorientation', onBadgeOrientation);
  }
  tiltBadge(0.3, -0.1);
}
function flipBadge() {
  const card = document.getElementById('badge-card');
  if (card) card.classList.toggle('flipped');
  // iPhones: motion needs asking, from a tap.
  if (!badgeMotionAsked && window.DeviceOrientationEvent && typeof window.DeviceOrientationEvent.requestPermission === 'function') {
    badgeMotionAsked = true;
    window.DeviceOrientationEvent.requestPermission()
      .then((answer) => { if (answer === 'granted') window.addEventListener('deviceorientation', onBadgeOrientation); })
      .catch(() => {});
  }
}

// --- Menu and the Profile page ---
function dashGo(where) {
  closeDashMenu();
  if (where === 'programme') return openProgrammePage();
  if (where === 'map') return openMapPage();
  if (where === 'profile') return openProfilePage();
  navigateTo('dashboard-page');
  window.scrollTo(0, 0);
}

function openProfilePage() {
  setText('profile-page-acronym', (conferenceInfo.acronym || '').toUpperCase());
  renderProfilePage();
  navigateTo('profile-page');
  window.scrollTo(0, 0);
}

// Their details, as registered: read here, corrected at the counter.
function renderProfilePage() {
  const d = currentDelegate || {};
  const box = document.getElementById('profile-details');
  if (!box) return;
  const phone = delegateDisplayPhone(d);
  const rows = [
    ['Name', [d.salutation, d.full_name || d.name].filter(Boolean).join(' ')],
    ['Designation', d.designation],
    ['Institution', d.institution || d.institute],
    ['Category', currentRegistration && currentRegistration.category_label],
    ['Email', d.email ? `${d.email}${d.email_verified ? ' · verified' : ' · not verified'}` : ''],
    ['Mobile', phone],
  ].filter(([, v]) => v);
  box.innerHTML = rows.map(([k, v]) => `<div class="flex justify-between gap-4 py-2"><dt class="text-slate-500 shrink-0">${esc(k)}</dt><dd class="text-slate-900 text-right break-words min-w-0">${esc(v)}</dd></div>`).join('');
}

function openBadgeFullScreen() {
  setText('badge-full-role', document.getElementById('badge-role').textContent);
  setText('badge-full-name', document.getElementById('badge-name').textContent);
  setText('badge-full-reg', document.getElementById('badge-reg').textContent);
  document.getElementById('badge-full-qr').src = document.getElementById('desk-pass-qr').src;
  document.getElementById('badge-full').classList.remove('hidden');
}
function closeBadgeFullScreen() {
  document.getElementById('badge-full').classList.add('hidden');
}

// --- Attendance & certificate (portal) ---
// Scanned a hall's door QR: now that they are logged in, mark them present
// at the session on there.
async function markFromHallCode() {
  const code = storageGet('session', 'nqocn_hall');
  if (!code) return;
  storageSet('session', 'nqocn_hall', '');
  try {
    const data = await (await fetch('/api/attendance/hall', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
    })).json();
    if (data.success) {
      showToast(data.already ? `Already marked present: ${data.session.title}.` : `Marked present: ${data.session.title} (${data.hall}). Thank you!`, 'success');
    } else {
      showToast(data.error || 'Could not mark you present. Please see the volunteer at the door.');
    }
  } catch (e) {
    showToast('Could not mark you present. Please see the volunteer at the door.');
  }
}

// Their profile name, which the certificate follows until they type another.
let certificateDefaultName = '';

async function loadAttendanceCard() {
  const card = document.getElementById('attendance-card');
  if (!card) return;
  let data;
  try { data = await (await fetch('/api/attendance/me')).json(); } catch (e) { return; }
  attendanceMeData = data;
  card.classList.toggle('hidden', !data.registered);
  if (!data.registered) return;
  const time = (ms) => new Date(ms).toLocaleString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  const tick = (done, label, sub) => `
    <li class="flex items-start gap-2">
      <span class="w-5 text-center font-bold ${done ? 'text-emerald-600' : 'text-slate-300'}">${done ? '✓' : '○'}</span>
      <span class="flex-1"><span class="${done ? 'text-slate-800 font-semibold' : 'text-slate-600'}">${esc(label)}</span>
        ${sub ? `<span class="block text-xs text-slate-500">${esc(sub)}</span>` : ''}</span>
    </li>`;
  // Until the day before the conference, the card is the certificate
  // details alone.
  const showAtt = data.showAttendance !== false;
  ['attendance-intro', 'attendance-list', 'attendance-status'].forEach((id) => document.getElementById(id).classList.toggle('hidden', !showAtt));
  setText('attendance-title', showAtt ? 'Attendance & certificate' : 'Certificate');
  document.getElementById('attendance-list').innerHTML = [
    ...data.completion.parts.map((p) => tick(p.done, `Conference: ${p.label}`, p.session ? `${p.session.title}, ${p.session.hall}` : '')),
    ...data.workshops.map((w) => tick(w.present, `Workshop: ${w.name}`, w.present ? '' : formatFullDate(w.date))),
  ].join('') || '<li class="text-slate-500">The programme is not out yet.</li>';
  document.getElementById('attendance-sessions').classList.toggle('hidden', !showAtt || !data.attended.length);
  document.getElementById('attendance-session-list').innerHTML = data.attended.map((s) => `<li>${esc(shortDateRange(s.date, s.date))}, ${esc(time(s.at))} · ${esc(s.hall)} · ${esc(s.title)}</li>`).join('');
  const status = document.getElementById('attendance-status');
  status.className = `text-xs font-bold px-2.5 py-1 rounded-full border ${data.completion.complete ? 'bg-emerald-100 text-emerald-800 border-emerald-300' : 'bg-slate-100 text-slate-600 border-slate-200'}`;
  status.textContent = data.completion.complete ? 'Conference completed' : 'Attendance in progress';
  // Issued certificates, to download; once issued, the details are fixed.
  let mine = [];
  try { mine = (await (await fetch('/api/certificates/mine')).json()).certificates || []; } catch (e) { mine = []; }
  myCertificates = mine;
  document.getElementById('cert-downloads').classList.toggle('hidden', !mine.length);
  document.getElementById('cert-download-list').innerHTML = mine.map((m) => `
    <a href="/api/certificates/mine/${encodeURIComponent(m.id)}.pdf" class="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-sm rounded-lg text-center">Download: ${esc(m.label)}</a>`).join('');
  const c = data.certificate;
  document.getElementById('cert-locked-note').classList.toggle('hidden', !c.locked);
  document.querySelectorAll('#cert-details-form input, #cert-details-form button').forEach((el) => { el.disabled = !!c.locked; });
  certificateDefaultName = c.defaultName || '';
  document.getElementById('cert-name').value = c.name || c.defaultName || '';
  if (Array.isArray(c.councils)) medicalCouncilList = c.councils;
  // Given once: then shown, not edited here.
  const councilSaved = !!c.councilRegNo;
  document.getElementById('cert-council-wrap').classList.toggle('hidden', !c.asksCouncilNumber || councilSaved);
  document.getElementById('cert-council-saved').classList.toggle('hidden', !councilSaved);
  setText('cert-council-saved-text', councilSaved ? `${c.councilName || 'Medical Council'} · ${c.councilRegNo}` : '');
  document.getElementById('cert-council').innerHTML = councilOptionsHtml(c.councilName || '');
  document.getElementById('cert-council-no').value = c.councilRegNo || '';
}

// --- The programme, for the delegate ---
// The home screen's Programme panel (what is on now, or next) and the
// programme's own page: one day at a time, start times in a column, a card
// per talk, breaks as thin dividers, a session common to several halls shown
// once, a filter by hall, and -- on the day -- opening at what is on now.
let programmeData = null;
let programmeDay = null;
let programmeHall = '';
const progToMin = (t) => { const [h, m] = String(t || '0:0').split(':').map(Number); return h * 60 + m; };
const progIsNow = (s) => programmeData && s.date === programmeData.now.date
  && progToMin(s.start) <= programmeData.now.minutes && programmeData.now.minutes <= progToMin(s.end);
// A break, a meal, registration: no speakers, no chairs, no attendance.
const progIsBreak = (s) => !s.counts && !s.speakers && !s.chairs && !s.optionId;

// The same session in several halls (an oration common to all) as one item,
// naming its halls.
function programmeItems(sessions) {
  const byKey = new Map();
  for (const s of sessions) {
    const key = [s.date, s.start, s.end, s.label, s.title].join('|');
    if (!byKey.has(key)) byKey.set(key, { ...s, halls: [], ids: [], hallIds: [] });
    byKey.get(key).halls.push(s.hall);
    byKey.get(key).ids.push(s.id);
    byKey.get(key).hallIds.push(s.hallId);
  }
  return [...byKey.values()];
}
function hallsLabel(halls, allHalls) {
  if (halls.length > 1 && allHalls.length > 1 && allHalls.every((h) => halls.includes(h))) return 'All halls';
  if (halls.length > 1 && halls.every((h) => /^Hall \S+$/.test(h))) return `Halls ${halls.map((h) => h.slice(5)).join(', ')}`;
  return halls.join(', ');
}

async function loadProgrammeCard() {
  const card = document.getElementById('programme-card');
  if (!card) return;
  try { programmeData = await (await fetch('/api/programme')).json(); } catch (e) { return; }
  updateDashTabs();
  const sessions = programmeData.sessions || [];
  card.classList.toggle('hidden', !sessions.length);
  const regProg = document.getElementById('reg-programme-btn');
  if (regProg) regProg.classList.toggle('hidden', !sessions.length);
  if (!sessions.length) return;
  const days = [...new Set(sessions.map((s) => s.date))].sort();
  if (!days.includes(programmeDay)) programmeDay = days.includes(programmeData.now.date) ? programmeData.now.date : days[0];
  // On now; else the next talks; else when it all happens.
  const live = programmeItems(sessions.filter((s) => progIsNow(s) && !progIsBreak(s)));
  const upcoming = sessions.filter((s) => !progIsBreak(s) && (s.date > programmeData.now.date
    || (s.date === programmeData.now.date && progToMin(s.start) > programmeData.now.minutes)))
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  const nextSlot = upcoming.length ? programmeItems(upcoming.filter((s) => s.date === upcoming[0].date && s.start === upcoming[0].start)) : [];
  const allHalls = [...new Set(sessions.map((s) => s.hall))];
  const line = (it) => `<div class="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2">
      <p class="text-xs font-semibold text-indigo-700">${esc(hallsLabel(it.halls, allHalls))} · ${esc(guestTime12(it.start))}</p>
      <p class="font-semibold text-slate-900 leading-snug">${esc(it.title)}</p>
      ${it.speakers ? `<p class="text-sm text-slate-600">${esc(it.speakers)}</p>` : ''}</div>`;
  const dayList = days.map((d, i) => `Day ${i + 1}: ${shortDateRange(d, d)}`).join(' · ');
  document.getElementById('programme-now').innerHTML = live.length
    ? `<p class="text-xs font-bold text-gold-700 uppercase tracking-wide">On now</p>${live.slice(0, 3).map(line).join('')}${live.length > 3 ? `<p class="text-sm text-slate-500">and ${live.length - 3} more</p>` : ''}`
    : nextSlot.length
      ? `<p class="text-xs font-bold text-slate-500 uppercase tracking-wide">Next${nextSlot[0].date !== programmeData.now.date ? ` · ${esc(shortDateRange(nextSlot[0].date, nextSlot[0].date))}` : ''}</p>${nextSlot.slice(0, 2).map(line).join('')}${nextSlot.length > 2 ? `<p class="text-sm text-slate-500">and ${nextSlot.length - 2} more at the same time</p>` : ''}`
      : `<p class="text-slate-600">${esc(dayList)}</p>`;
}

function openProgrammePage() {
  if (!programmeData) return;
  setText('prog-page-acronym', (conferenceInfo.acronym || '').toUpperCase());
  navigateTo('programme-page');
  renderProgrammePage();
  window.scrollTo(0, 0);
  // On the day, open at what is on now.
  const now = document.querySelector('#prog-page-list [data-now="1"]');
  if (now && now.scrollIntoView) now.scrollIntoView({ block: 'center' });
}

function closeProgrammePage() {
  navigateTo('dashboard-page');
  window.scrollTo(0, 0);
}

function renderProgrammePage() {
  const sessions = programmeData.sessions || [];
  const days = [...new Set(sessions.map((s) => s.date))].sort();
  const weekday = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'UTC' });
  const dayTabs = document.getElementById('prog-page-days');
  dayTabs.style.gridTemplateColumns = `repeat(${Math.max(1, days.length)}, minmax(0, 1fr))`;
  dayTabs.innerHTML = days.map((d, i) => `
    <button type="button" onclick="programmeDay='${esc(d)}'; programmeHall=''; renderProgrammePage()" role="tab" aria-selected="${d === programmeDay}"
      class="min-h-[44px] px-2 py-2 rounded-lg text-[15px] ${d === programmeDay ? 'bg-navy text-white font-bold' : 'text-navy font-semibold hover:bg-slate-50'}">
      Day ${i + 1} · ${esc(weekday(d))} ${esc(shortDateRange(d, d).replace(/ \d{4}$/, ''))}</button>`).join('');
  const day = sessions.filter((s) => s.date === programmeDay);
  const allHalls = [...new Set(day.map((s) => s.hall))];
  // A hall filter, a drop-down, on any day with talks in more than one hall.
  const hallOrder = (programmeData.halls || []).map((h) => h.name);
  const hallsWithTalks = [...new Set(day.filter((s) => !progIsBreak(s)).map((s) => s.hall))]
    .sort((a, b) => ((hallOrder.indexOf(a) + 1) || 1e9) - ((hallOrder.indexOf(b) + 1) || 1e9) || a.localeCompare(b));
  const filtered = hallsWithTalks.length > 1;
  if (!filtered || (programmeHall && !hallsWithTalks.includes(programmeHall))) programmeHall = '';
  const hallBox = document.getElementById('prog-page-halls');
  hallBox.innerHTML = !filtered ? ''
    : `<select id="prog-page-hall-select" aria-label="Hall" onchange="programmeHall=this.value; renderProgrammePage()"
      class="w-full sm:w-auto sm:min-w-[16rem] h-11 px-3 rounded-xl border bg-white text-navy text-[15px] font-semibold ${programmeHall ? 'border-navy ring-1 ring-navy' : 'border-slate-300'}">
      ${['', ...hallsWithTalks].map((h) => `<option value="${esc(h)}"${h === programmeHall ? ' selected' : ''}>${esc(h || `All halls (${hallsWithTalks.length})`)}</option>`).join('')}</select>`;
  // On the day: what is on now, pinned above the list, with how far it has run.
  const nowBox = document.getElementById('prog-page-now');
  if (nowBox) {
    const live = programmeDay === programmeData.now.date ? programmeItems(day.filter((s) => progIsNow(s) && !progIsBreak(s))) : [];
    nowBox.classList.toggle('hidden', !live.length);
    nowBox.innerHTML = live.length ? `<div class="rounded-2xl border-2 border-gold-500 bg-white px-4 py-3 shadow-sm space-y-3">${live.map((it, i) => `<div>
        <div class="flex items-center justify-between gap-2">${i === 0 ? '<p class="text-xs font-bold tracking-[0.15em] text-gold-700 uppercase">On now</p>' : '<span></span>'}<p class="text-sm text-slate-600">${esc(hallsLabel(it.halls, allHalls))} · until ${esc(guestTime12(it.end))}</p></div>
        <p class="font-bold text-slate-900 leading-snug mt-0.5">${esc(it.title)}</p>
        <div class="mt-1.5 h-1.5 rounded-full bg-gold-100 overflow-hidden" role="img" aria-label="${progElapsed(it)}% of the session gone"><div class="h-1.5 bg-gold-500" style="width:${progElapsed(it)}%"></div></div></div>`).join('')}</div>` : '';
  }
  const mine = new Set(programmeData.mine || []);
  const shown = day.filter((s) => !programmeHall || s.hall === programmeHall);
  const items = programmeItems(shown);
  const myWorkshops = new Set((attendanceMeData && attendanceMeData.workshops || []).map((w) => w.optionId));
  const slots = [...new Set(items.map((it) => it.start))].sort();
  // A talk in one hall that is on the campus map: its hall opens the map there.
  const onMap = new Set(campusPlaces(programmeData.halls).flatMap((p) => p.halls.map((h) => h.id)));
  const hallTag = (it) => {
    const label = esc(hallsLabel(it.halls, allHalls));
    const cls = 'shrink-0 text-xs font-semibold rounded-md px-2 py-0.5 bg-indigo-50 text-navy';
    return it.hallIds.length === 1 && onMap.has(it.hallIds[0])
      ? `<button type="button" onclick="openMapPage(${Number(it.hallIds[0])})" aria-label="${label} on the campus map" class="${cls} inline-flex items-center gap-1 hover:bg-indigo-100"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="w-3 h-3" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></svg>${label}</button>`
      : `<span class="${cls}">${label}</span>`;
  };
  // A talk's card. On a desktop the talks that start together sit side by
  // side, two or three to a row, each the row's height.
  const card = (it, showHall = true) => {
    const now = it.halls.length && it.ids.some((id) => progIsNow({ ...it, id }));
    const was = it.ids.some((id) => mine.has(id));
    const yours = myWorkshops.has(it.optionId);
    return `<article data-now="${now ? 1 : 0}" class="bg-white rounded-xl border ${now ? 'border-2 border-gold-500' : 'border-slate-200'} px-4 py-3 h-full">
          <div class="flex items-start justify-between gap-2">
            <p class="text-xs font-bold tracking-wide text-navy uppercase">${esc(it.label || '')}${yours ? ' · <span class="text-gold-700">Your workshop</span>' : ''}</p>
            ${showHall ? hallTag(it) : ''}
          </div>
          ${now ? `<p class="text-xs font-bold text-gold-700 mt-0.5">On now${was ? ' · you are marked present' : ''}</p>` : (was ? '<p class="text-xs font-bold text-emerald-700 mt-0.5">✓ You were marked present</p>' : '')}
          <h4 class="text-[17px] font-semibold text-slate-900 leading-snug mt-1">${esc(it.title)}</h4>
          ${it.speakers ? `<p class="text-[15px] text-slate-700 mt-1 leading-snug">${esc(it.speakers)}</p>` : ''}
          ${it.chairs ? `<p class="text-sm text-slate-500 mt-1">Chair: ${esc(it.chairs)}</p>` : ''}
          <p class="text-xs text-slate-400 mt-1.5 tabular-nums">${esc(guestTime12(it.start))} – ${esc(guestTime12(it.end))}</p>
        </article>`;
  };
  const breakLine = (breaks) => `${esc(guestTime12(breaks[0].start))} – ${esc(guestTime12(breaks[0].end))} · ${esc(breaks.map((b) => b.title).filter((t, i, a) => a.indexOf(t) === i).join(', '))}`;
  document.getElementById('prog-page-list').innerHTML = slots.map((start) => {
    const at = items.filter((it) => it.start === start);
    const breaks = at.filter(progIsBreak);
    const talks = at.filter((it) => !progIsBreak(it))
      .sort((a, b) => Number(myWorkshops.has(b.optionId)) - Number(myWorkshops.has(a.optionId)));
    const divider = breaks.length && !talks.length
      ? `<div class="ml-[4.5rem] my-3 border-t border-dashed border-slate-300 pt-1.5 text-sm text-slate-500">${breakLine(breaks)}</div>` : '';
    if (!talks.length) return divider;
    const [time, ampm] = guestTime12(start).split(' ');
    return `<div class="grid grid-cols-[3.75rem_minmax(0,1fr)] gap-3 mt-3">
      <div class="pt-3 text-right"><p class="text-lg font-bold text-navy leading-none tabular-nums">${esc(time)}</p><p class="text-xs text-slate-500 mt-0.5">${esc(ampm || '')}</p></div>
      <div class="grid gap-2 ${talks.length > 1 ? 'lg:grid-cols-2' : ''} ${talks.length > 2 ? 'xl:grid-cols-3' : ''}">${talks.map((it) => card(it)).join('')}</div>
    </div>${divider}`;
  }).join('') || '<p class="mt-6 text-center text-slate-500">Nothing on this day.</p>';
}

// --- The campus map, for the delegate ---
// The halls with a map location (Programme settings), one pin per building,
// numbered as in the list under the map. Street or satellite tiles; "Where am
// I" follows the phone's location while the page is open (it goes nowhere);
// Directions opens Google Maps walking there. Leaflet is fetched the first
// time the page opens, not with the portal.
const LEAFLET_URL = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min';
let leafletLoading = null;
function loadLeaflet() {
  if (window.L && window.L.map) return Promise.resolve(window.L);
  if (!leafletLoading) {
    leafletLoading = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = `${LEAFLET_URL}.css`;
      document.head.appendChild(css);
      const js = document.createElement('script');
      js.src = `${LEAFLET_URL}.js`;
      js.onload = () => resolve(window.L);
      js.onerror = () => { leafletLoading = null; reject(new Error('Leaflet did not load')); };
      document.head.appendChild(js);
    });
  }
  return leafletLoading;
}

// Halls at the same spot are one building: one pin, its halls listed.
function campusPlaces(halls) {
  const places = [];
  for (const h of halls || []) {
    if (h.lat == null || h.lng == null) continue;
    const key = `${Number(h.lat).toFixed(6)},${Number(h.lng).toFixed(6)}`;
    let p = places.find((x) => x.key === key);
    if (!p) { p = { key, n: places.length + 1, lat: Number(h.lat), lng: Number(h.lng), building: '', halls: [] }; places.push(p); }
    p.halls.push({ id: h.id, name: h.name, floor: h.floor || '' });
    if (!p.building && h.building) p.building = h.building;
  }
  // In a building, ground floor up; halls with no floor keep their order.
  for (const p of places) p.halls.sort((a, b) => campusFloorRank(a.floor) - campusFloorRank(b.floor));
  return places;
}
// "Basement" -1, "Ground floor" 0, "First floor" / "1st floor" 1, ... Not a
// floor anyone wrote: after the rest (sort is stable, so they keep order).
function campusFloorRank(floor) {
  const f = String(floor || '').toLowerCase();
  if (!f) return 99;
  if (/basement|lower ground/.test(f)) return -1;
  if (/ground/.test(f)) return 0;
  const n = /(\d+)/.exec(f);
  if (n) return Number(n[1]);
  const words = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
  const i = words.findIndex((w) => f.includes(w));
  return i >= 0 ? i + 1 : 98;
}
// "Pediatrics Seminar Hall, 2nd floor" -- the floor only where one is set.
const campusHallName = (h) => (h.floor ? `${h.name}, ${h.floor}` : h.name);
const campusDirectionsUrl = (p) => `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}&travelmode=walking`;

// Metres between two places (haversine), to tell the campus from a field
// visit miles off.
function campusDistance(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}
// The campus: the places within 2 km of the first (the main venue). One
// further off -- a village on a field visit -- keeps its pin and directions,
// but the map opens on the campus, not zoomed out to take it in.
const CAMPUS_RADIUS_M = 2000;
const campusCore = (places) => (places.length ? places.filter((p) => campusDistance(places[0], p) <= CAMPUS_RADIUS_M) : []);
const campusAway = (places, p) => (places.length && campusDistance(places[0], p) > CAMPUS_RADIUS_M ? campusDistance(places[0], p) : 0);

// What is on in a building now, or next today -- breaks aside.
function campusPlaceNow(place) {
  if (!programmeData || !programmeData.now) return '';
  const ids = new Set(place.halls.map((h) => h.id));
  const today = (programmeData.sessions || []).filter((s) => ids.has(s.hallId) && s.date === programmeData.now.date && !progIsBreak(s));
  const now = today.find(progIsNow);
  if (now) return `On now: ${now.title}`;
  const next = today.filter((s) => progToMin(s.start) > programmeData.now.minutes).sort((a, b) => progToMin(a.start) - progToMin(b.start))[0];
  return next ? `Next, ${guestTime12(next.start)}: ${next.title}` : '';
}

function campusListHtml(places, chosen) {
  return places.map((p) => {
    const [first, ...rest] = p.halls;
    const now = campusPlaceNow(p);
    const away = campusAway(places, p);
    // A named building heads its halls, each with its floor.
    const lines = p.building
      ? `<span class="block font-semibold text-navy leading-snug">${esc(p.building)}</span>
          ${p.halls.map((h) => `<span class="block text-xs text-slate-600">${esc(h.name)}${h.floor ? ` <span class="text-slate-400">·</span> <span class="font-semibold">${esc(h.floor)}</span>` : ''}</span>`).join('')}`
      : `<span class="block font-semibold text-navy leading-snug">${esc(first.name)}</span>
          ${first.floor ? `<span class="block text-xs font-semibold text-slate-600">${esc(first.floor)}</span>` : ''}
          ${rest.length ? `<span class="block text-xs text-slate-500">Same building: ${esc(rest.map(campusHallName).join('; '))}</span>` : ''}`;
    return `<div class="flex items-center gap-3 px-4 py-3 ${p.n === chosen ? 'bg-gold-50' : ''}">
      <button type="button" onclick="focusCampusPlace(${p.n})" class="flex items-center gap-3 flex-1 min-w-0 text-left">
        <span class="campus-pin shrink-0 ${p.n === chosen ? 'is-chosen' : ''}" aria-hidden="true">${p.n}</span>
        <span class="min-w-0">${lines}
          ${away ? `<span class="block text-xs text-slate-500">Off campus, about ${esc(Math.round(away / 1000))} km away</span>` : ''}
          ${now ? `<span class="block text-xs font-semibold text-gold-700 truncate">${esc(now)}</span>` : ''}</span>
      </button>
      <a href="${esc(campusDirectionsUrl(p))}" target="_blank" rel="noopener" class="shrink-0 px-3 py-1.5 rounded-lg border border-slate-300 text-sm font-semibold text-navy hover:bg-slate-50">Directions</a>
    </div>`;
  }).join('') || '<p class="p-4 text-sm text-slate-500">No halls are on the map yet.</p>';
}

let campusMap = null;
let campusLayers = null;
let campusMarkers = new Map();
let campusPlacesList = [];
let campusChosen = 0;
let campusMe = null;
let campusLocateFirst = false;

async function openMapPage(hallId) {
  setText('map-page-acronym', (conferenceInfo.acronym || '').toUpperCase());
  navigateTo('map-page');
  window.scrollTo(0, 0);
  campusPlacesList = campusPlaces(programmeData && programmeData.halls);
  const target = hallId ? campusPlacesList.find((p) => p.halls.some((h) => h.id === hallId)) : null;
  campusChosen = target ? target.n : 0;
  document.getElementById('campus-map-list').innerHTML = campusListHtml(campusPlacesList, campusChosen);
  let L;
  try { L = await loadLeaflet(); } catch (e) {
    document.getElementById('campus-map-error').classList.remove('hidden');
    return;
  }
  document.getElementById('campus-map-error').classList.add('hidden');
  renderCampusMap(L);
  if (target) focusCampusPlace(target.n, false);
}

const campusIcon = (L, p) => L.divIcon({ className: '', html: `<span class="campus-pin ${p.n === campusChosen ? 'is-chosen' : ''}">${p.n}</span>`,
  iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -16] });
const campusPopupHtml = (p) => `${p.building ? `<p style="margin:0 0 2px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#8a6d2b">${esc(p.building)}</p>` : ''}
  <p style="margin:0 0 6px;font-weight:700;color:#1c3549">${p.halls.map((h) => esc(campusHallName(h))).join('<br>')}</p>
  <a href="${esc(campusDirectionsUrl(p))}" target="_blank" rel="noopener" style="font-weight:600;color:#8a6d2b">Walking directions</a>`;

function renderCampusMap(L) {
  if (!campusMap) {
    campusMap = L.map('campus-map');
    campusLayers = {
      street: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }),
      satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        { maxZoom: 19, maxNativeZoom: 18, attribution: 'Imagery &copy; Esri' }),
    };
    campusLayers.street.addTo(campusMap);
    campusMap.on('locationfound', onCampusLocation);
    campusMap.on('locationerror', () => showToast('Your location is off. Allow location for this site to see where you are.'));
  }
  campusMarkers.forEach((m) => m.remove());
  campusMarkers = new Map();
  for (const p of campusPlacesList) {
    const m = L.marker([p.lat, p.lng], { icon: campusIcon(L, p), title: p.halls.map((h) => h.name).join(', '), riseOnHover: true })
      .addTo(campusMap).bindPopup(campusPopupHtml(p));
    m.on('click', () => focusCampusPlace(p.n, false));
    campusMarkers.set(p.n, m);
  }
  campusMap.invalidateSize();
  const core = campusCore(campusPlacesList);
  if (core.length) campusMap.fitBounds(L.latLngBounds(core.map((p) => [p.lat, p.lng])), { padding: [48, 48], maxZoom: 18 });
}

function focusCampusPlace(n, scroll = true) {
  campusChosen = n;
  document.getElementById('campus-map-list').innerHTML = campusListHtml(campusPlacesList, n);
  if (!campusMap || !window.L) return;
  campusMarkers.forEach((m, k) => m.setIcon(campusIcon(window.L, campusPlacesList.find((x) => x.n === k))));
  const p = campusPlacesList.find((x) => x.n === n);
  const m = campusMarkers.get(n);
  if (p && m) {
    // Close in on a building; a village needs its surroundings.
    campusMap.setView([p.lat, p.lng], campusAway(campusPlacesList, p) ? 16 : Math.max(campusMap.getZoom(), 18));
    m.openPopup();
  }
  if (scroll) document.getElementById('campus-map').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function setCampusMapStyle(style) {
  if (!campusMap || !campusLayers) return;
  for (const [name, layer] of Object.entries(campusLayers)) {
    if (name === style) layer.addTo(campusMap); else layer.remove();
    const btn = document.getElementById(`campus-map-${name}`);
    if (btn) {
      btn.setAttribute('aria-pressed', String(name === style));
      btn.className = `px-3 py-1.5 ${name === style ? 'bg-navy text-white' : 'text-slate-600'}`;
    }
  }
}

function locateOnCampusMap() {
  if (!campusMap) return;
  if (!navigator.geolocation) return showToast('This browser cannot share your location.');
  campusLocateFirst = true;
  campusMap.locate({ watch: true, enableHighAccuracy: true, setView: false });
}

// Their dot, and how sure the phone is of it. The first fix brings the
// campus and them into view -- or, far away, says how far.
function onCampusLocation(e) {
  const L = window.L;
  if (!campusMe) {
    campusMe = {
      ring: L.circle(e.latlng, { radius: e.accuracy, color: '#2f80ed', weight: 1, fillOpacity: 0.1, interactive: false }).addTo(campusMap),
      dot: L.marker(e.latlng, { icon: L.divIcon({ className: '', html: '<span class="campus-me" style="display:block"></span>', iconSize: [16, 16], iconAnchor: [8, 8] }),
        interactive: false, zIndexOffset: 1000 }).addTo(campusMap),
    };
  } else {
    campusMe.dot.setLatLng(e.latlng);
    campusMe.ring.setLatLng(e.latlng).setRadius(e.accuracy);
  }
  if (!campusLocateFirst) return;
  campusLocateFirst = false;
  const pts = campusCore(campusPlacesList).map((p) => [p.lat, p.lng]);
  const nearest = pts.length ? Math.min(...pts.map((pt) => campusMap.distance(pt, e.latlng))) : 0;
  if (nearest > 5000) {
    showToast(`You are about ${Math.round(nearest / 1000)} km from the campus.`);
    campusMap.setView(e.latlng, 14);
  } else {
    campusMap.fitBounds(L.latLngBounds([...pts, e.latlng]), { padding: [48, 48], maxZoom: 18 });
  }
}

function stopCampusLocate() {
  if (campusMap) campusMap.stopLocate();
}

// --- The home screen ---
// The bar's account menu: profile, password, the admin panel (staff), log out.
function toggleDashMenu(e) {
  if (e) e.stopPropagation();
  const menu = document.getElementById('dash-menu');
  if (!menu) return;
  const open = menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !open);
  const btn = document.getElementById('dash-menu-btn');
  if (btn && btn.setAttribute) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}
function closeDashMenu() {
  const menu = document.getElementById('dash-menu');
  if (menu) menu.classList.add('hidden');
  const btn = document.getElementById('dash-menu-btn');
  if (btn && btn.setAttribute) btn.setAttribute('aria-expanded', 'false');
}
document.addEventListener('click', (e) => {
  const menu = document.getElementById('dash-menu');
  if (menu && !menu.classList.contains('hidden') && !menu.contains(e.target)) closeDashMenu();
});
document.addEventListener('keydown', (e) => {
  const menu = document.getElementById('dash-menu');
  if (e.key === 'Escape' && menu && !menu.classList.contains('hidden')) {
    closeDashMenu();
    const btn = document.getElementById('dash-menu-btn');
    if (btn && btn.focus) btn.focus();
  }
});

// The one thing that matters now, by where they are:
//   not registered -> register; submitted -> being verified;
//   certificates issued -> download them;
//   a conference day -> what is on now, the badge, the programme;
//   after the conference -> certificates soon;
//   registered, before -> the badge and the programme.
// A rejected payment or a balance due has its own banner, which leads instead.
let attendanceMeData = null;
let myCertificates = [];
function renderHomeHero() {
  const box = document.getElementById('home-hero');
  if (!box) return;
  const shown = (id) => { const el = document.getElementById(id); return el && !el.classList.contains('hidden'); };
  const reg = currentRegistration;
  if (shown('reverify-banner') || shown('balance-banner')) { box.classList.add('hidden'); return; }
  const today = programmeData && programmeData.now ? programmeData.now.date : new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const days = programmeData ? [...new Set((programmeData.sessions || []).map((s) => s.date))].sort() : [];
  const first = days[0] || conferenceInfo.startDate;
  const last = days[days.length - 1] || conferenceInfo.endDate;
  const kicker = (t) => `<p class="text-xs font-bold tracking-[0.15em] text-gold-700 uppercase">${esc(t)}</p>`;
  const primary = (label, onclick) => `<button type="button" onclick="${onclick}" class="mt-4 w-full sm:w-auto px-5 py-3 bg-navy hover:bg-indigo-700 text-white font-semibold rounded-lg">${esc(label)}</button>`;
  const next = document.getElementById('home-next');
  let nextHtml = '';
  // Registering, being verified and registered are the registration panel's
  // to say; this leads only on the days and after.
  let html = '';
  if (!reg || reg.bank_status !== 'BANK_VERIFIED') {
    html = '';
  } else if (reg.bank_status === 'BANK_VERIFIED' && myCertificates.length) {
    html = `${kicker('Your certificates')}<h3 class="text-xl font-bold text-slate-900 mt-1">Thank you for attending</h3>
      <div class="mt-3 flex flex-col sm:flex-row sm:flex-wrap gap-2">${myCertificates.map((m) => `<a href="/api/certificates/mine/${encodeURIComponent(m.id)}.pdf" class="px-5 py-3 bg-navy hover:bg-indigo-700 text-white font-semibold rounded-lg text-center">Download: ${esc(m.label)}</a>`).join('')}</div>`;
  } else if (reg.bank_status === 'BANK_VERIFIED' && first && today >= first && today <= last) {
    const sessions = programmeData ? programmeData.sessions || [] : [];
    const live = programmeItems(sessions.filter((s) => progIsNow(s) && !progIsBreak(s)));
    const allHalls = [...new Set(sessions.map((s) => s.hall))];
    const parts = attendanceMeData && attendanceMeData.completion ? attendanceMeData.completion.parts : [];
    html = `${live.length ? live.slice(0, 3).map((it, i) => homeLiveHtml(it, allHalls, i === 0)).join('<div class="my-4 border-t border-gold-100"></div>')
        : `${kicker('Today')}<h3 class="text-xl font-bold text-slate-900 mt-1">Nothing is on right now</h3>`}
      ${primary('Show my badge to mark attendance', 'openBadgeFullScreen()').replace('sm:w-auto ', '')}
      ${parts.length ? `<div class="mt-3 flex flex-wrap gap-2">${parts.map((p) => `<span class="text-sm font-semibold px-3 py-1 rounded-full border ${p.done ? 'bg-emerald-50 border-emerald-300 text-emerald-800' : 'bg-white border-slate-300 text-slate-600'}">${p.done ? '✓' : '○'} ${esc(p.label.replace(/^\d+ \w+, /, ''))}${p.done ? ' marked' : ''}</span>`).join('')}</div>` : ''}
      <p class="text-sm text-slate-600 mt-2">Or scan the QR code at the hall door.</p>`;
    nextHtml = homeNextHtml(sessions, allHalls);
  } else if (reg.bank_status === 'BANK_VERIFIED' && last && today > last) {
    html = `${kicker('Thank you for attending')}<h3 class="text-xl font-bold text-slate-900 mt-1">Your certificates will be ready here soon</h3>
      <p class="text-[15px] text-slate-600 mt-1">We will email you when they are. Meanwhile, check the name your certificate will carry in your Profile.</p>
      <button type="button" onclick="openProfilePage()" class="mt-4 w-full sm:w-auto px-5 py-3 border border-navy text-navy hover:bg-indigo-50 font-semibold rounded-lg">Open my profile</button>`;
  }
  box.innerHTML = html;
  box.classList.toggle('hidden', !html);
  if (next) { next.innerHTML = nextHtml; next.classList.toggle('hidden', !nextHtml); }
  // Once this leads, registration is one line.
  setRegistrationCompact(!!html);
}

// A talk on now: how far it has run, and its hall -- on the map, if it is.
const MAP_PIN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5 shrink-0" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></svg>';
function progElapsed(it) {
  const a = progToMin(it.start);
  const b = progToMin(it.end);
  return Math.max(0, Math.min(100, Math.round(((programmeData.now.minutes - a) / Math.max(1, b - a)) * 100)));
}
function homeLiveHtml(it, allHalls, first) {
  const places = new Map(campusPlaces(programmeData.halls).flatMap((p) => p.halls.map((h) => [h.id, { place: p, hall: h }])));
  const loc = it.hallIds && it.hallIds.length === 1 ? places.get(it.hallIds[0]) : null;
  const where = loc
    ? `<button type="button" onclick="openMapPage(${Number(it.hallIds[0])})" class="mt-3 w-full flex items-center gap-2.5 text-left rounded-xl bg-gold-50 hover:bg-gold-100 px-3 py-2.5 text-navy">${MAP_PIN_SVG}
        <span class="min-w-0"><span class="block font-bold">${esc(it.halls[0])}</span><span class="block text-sm text-slate-600">${esc([loc.place.building, loc.hall.floor].filter(Boolean).join(' · ') || 'Campus map')} · Map and directions</span></span></button>`
    : `<p class="mt-2 text-sm font-semibold text-navy">${esc(hallsLabel(it.halls, allHalls))}</p>`;
  return `<div class="flex items-center justify-between gap-2">${first ? '<p class="text-xs font-bold tracking-[0.15em] text-gold-700 uppercase">On now</p>' : '<span></span>'}
      <p class="text-sm text-slate-600">until ${esc(guestTime12(it.end))}</p></div>
    <p class="text-lg font-bold text-slate-900 leading-snug mt-1">${esc(it.title)}</p>
    ${it.speakers ? `<p class="text-[15px] text-slate-600">${esc(it.speakers)}</p>` : ''}
    <div class="mt-2 h-1.5 rounded-full bg-gold-100 overflow-hidden" role="img" aria-label="${progElapsed(it)}% of the session gone"><div class="h-1.5 bg-gold-500" style="width:${progElapsed(it)}%"></div></div>
    ${where}`;
}
// The next talk today, if any: when, what, where.
function homeNextHtml(sessions, allHalls) {
  const now = programmeData && programmeData.now;
  if (!now) return '';
  const upcoming = sessions.filter((s) => s.date === now.date && !progIsBreak(s) && progToMin(s.start) > now.minutes)
    .sort((a, b) => progToMin(a.start) - progToMin(b.start));
  if (!upcoming.length) return '';
  const slot = programmeItems(upcoming.filter((s) => s.start === upcoming[0].start));
  const it = slot[0];
  return `<p class="text-xs font-bold tracking-[0.12em] text-slate-500 uppercase">Next · ${esc(guestTime12(it.start))}</p>
    <p class="text-base font-semibold text-slate-900 leading-snug mt-0.5">${esc(it.title)}</p>
    <p class="text-sm text-slate-600">${esc([hallsLabel(it.halls, allHalls), it.speakers].filter(Boolean).join(' · '))}</p>
    ${slot.length > 1 ? `<button type="button" onclick="openProgrammePage()" class="mt-1 text-sm font-semibold text-navy underline">and ${slot.length - 1} more at the same time</button>` : ''}`;
}

// Registration as one line (the conference is on, or over): the number and
// category; tapping it opens the whole panel.
let registrationExpanded = false;
function setRegistrationCompact(on) {
  const row = document.getElementById('registration-row');
  const card = document.getElementById('registration-card');
  if (!row || !card) return;
  const reg = currentRegistration || {};
  row.classList.toggle('hidden', !on);
  if (on) {
    setText('registration-row-number', reg.registration_number || '—');
    setText('registration-row-line', [reg.category_label, registrationExpanded ? 'Hide details' : 'Receipt and details'].filter(Boolean).join(' · '));
  }
  card.classList.toggle('hidden', on && !registrationExpanded);
  row.setAttribute('aria-expanded', String(on && registrationExpanded));
  const chev = document.getElementById('registration-row-chevron');
  if (chev) chev.classList.toggle('rotate-90', on && registrationExpanded);
}
function toggleRegistrationDetails() {
  registrationExpanded = !registrationExpanded;
  setRegistrationCompact(true);
}

async function saveCertificateDetails(e) {
  e.preventDefault();
  const typed = document.getElementById('cert-name').value.trim();
  const body = {
    // Unchanged: keep following the profile name rather than a copy of it.
    certificateName: typed === certificateDefaultName ? '' : typed,
    councilName: document.getElementById('cert-council').value.trim(),
    councilRegNo: document.getElementById('cert-council-no').value.trim(),
  };
  const data = await (await fetch('/api/attendance/me/certificate', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })).json();
  if (!data.success) return showToast(data.error || 'Could not save.');
  showToast('Certificate details saved.', 'success');
  loadAttendanceCard();
}

// Paint every part of the dashboard that depends on the registration: the
// status chip, the register/pay action, the confirmed block and the balance
// banner.
//
// Split out of loadDashboard so it can run BEFORE the network. The markup
// has to ship some status in the chip, and shipping a real one meant every
// delegate saw "Registration Pending" until the fetch returned -- a wrong
// status, briefly, for anyone already confirmed. The page now ships a
// neutral "Checking..." and the server hands the delegate's own registration
// to the page as __BOOTSTRAP_REG__, which is applied synchronously at the
// bottom of this file. loadDashboard still calls this again with the fetched
// copy, so a stale bootstrap corrects itself; the call is idempotent.
//
// `reg` is the registration, or null for a delegate who has not paid yet.
function applyRegistrationState(reg) {
  const statusTag = document.getElementById('payment-status-tag');
  const confBtn = document.getElementById('register-conf-btn');
  const reverifyBanner = document.getElementById('reverify-banner');
  const confirmedBlock = document.getElementById('confirmed-block');

  currentRegistration = reg;
  updateDashTabs();

  // Registration number, receipt, and the chosen workshop / QI practice are
  // revealed only once the payment is verified. The register/edit action and
  // the pending note are hidden in that state.
  const verified = reg && reg.bank_status === 'BANK_VERIFIED';
  const partial = reg && reg.bank_status === 'PARTIAL_PAYMENT';
  // Locked: submitted and awaiting review, or partially paid (category/fee are
  // fixed once any payment is verified) -- the delegate can only top up the
  // balance, not edit the original submission.
  const locked = reg && (reg.bank_status === 'PENDING' || partial);

  // Partial-payment balance banner + top-up entry point.
  const balanceBanner = document.getElementById('balance-banner');
  if (balanceBanner) {
    balanceBanner.classList.toggle('hidden', !partial);
    if (partial) {
      setText('balance-fee', `₹${inr(Number(reg.expected_amount))}`);
      setText('balance-paid', `₹${inr(Number(reg.verified_total || 0))}`);
      setText('balance-due', `₹${inr(Number(reg.remaining || 0))}`);
      // If a top-up is already submitted and pending, show the waiting note and
      // hide the pay button; otherwise offer the top-up.
      const hasPendingTopup = (reg.pending_txn_count || 0) > 0;
      const topupBtn = document.getElementById('balance-topup-btn');
      const pendingNote = document.getElementById('balance-pending-note');
      if (topupBtn) topupBtn.classList.toggle('hidden', hasPendingTopup);
      if (pendingNote) pendingNote.classList.toggle('hidden', !hasPendingTopup);
    }
  }
  const actionArea = document.getElementById('payment-action-area');
  const paymentDesc = document.getElementById('payment-desc');
  const actionNote = document.getElementById('payment-action-note');
  if (confirmedBlock) confirmedBlock.classList.toggle('hidden', !verified);
  if (actionArea) actionArea.classList.toggle('hidden', verified);
  if (paymentDesc) paymentDesc.classList.toggle('hidden', verified);
  if (confBtn) confBtn.classList.toggle('hidden', locked);
  if (actionNote) {
    actionNote.innerHTML = partial
      ? '<b>Partial payment received.</b> Please pay the outstanding balance shown above to complete your registration.'
      : locked
      ? '<b>Your payment details are locked</b> while awaiting verification by the finance admin. Contact the finance team if a correction is needed.'
      : '<b>Note:</b> Registration remains <b>Pending</b> until payment is verified manually by the finance admin.';
  }
  // One panel through every stage: what it says at the top, by status.
  const stage = !reg ? ['Next step', 'Register for the conference', null]
    : verified ? ['You are registered', '', null]
      : reg.bank_status === 'REJECTED' ? ['Action needed', 'Your registration needs a correction', 'See the note above, then update your registration.']
        : partial ? ['Balance due', 'Pay the balance to complete your registration', null]
          : ['Almost there', 'Your registration is being verified', 'The finance team checks each payment by hand. You will get an email when it is confirmed.'];
  setText('reg-kicker', stage[0]);
  const regTitle = document.getElementById('reg-title');
  if (regTitle) { regTitle.textContent = stage[1]; regTitle.classList.toggle('hidden', !stage[1]); }
  if (paymentDesc && stage[2]) paymentDesc.textContent = stage[2];
  if (verified) {
    document.getElementById('reg-number-display').innerText = reg.registration_number || '—';
    setText('reg-category-line', [reg.category_label, Number(reg.verified_total) > 0 ? `₹${inr(Number(reg.verified_total))} paid` : (Number(reg.expected_amount) === 0 ? 'No fee' : '')].filter(Boolean).join(' · '));
    renderBadge(reg);
    const selBox = document.getElementById('conf-selections');
    if (selBox) {
      const selections = reg.selections || [];
      selBox.innerHTML = selections.map((s) => `<div class="flex justify-between gap-3 py-2"><span class="text-slate-500">${esc(s.group_name)}</span><span class="font-semibold text-slate-800 text-right">${esc(s.option_name)}</span></div>`).join('');
    }
  }

  if (!reg) {
    // No payment submitted yet — reset to the initial pending state.
    statusTag.className = "text-xs bg-amber-100 text-amber-800 font-bold px-2.5 py-1 rounded-full border border-amber-300";
    statusTag.innerText = "Not registered";
    confBtn.innerText = "Register & Pay Now";
    reverifyBanner.classList.add('hidden');
  } else if (verified) {
    // Confirmed: the action button/note are hidden; only the confirmed block
    // (number, workshop, QI, receipt) is shown.
    statusTag.className = "text-xs bg-emerald-100 text-emerald-800 font-bold px-2.5 py-1 rounded-full border border-emerald-300";
    statusTag.innerText = "Confirmed ✓";
    reverifyBanner.classList.add('hidden');
  } else if (reg.bank_status === 'REJECTED') {
    // Rejected: show the reason and the tailored action the delegate should
    // take. The button dispatches by reason (see resolveRejection).
    statusTag.className = "text-xs bg-rose-100 text-rose-800 font-bold px-2.5 py-1 rounded-full border border-rose-300";
    statusTag.innerText = "Rejected";

    const R = {
      WRONG_DETAILS: { msg: 'Your payment reference details did not match. Please correct your transaction reference — no need to re-upload the screenshot.', label: 'Correct Details' },
      WRONG_SCREENSHOT: { msg: 'The payment screenshot was unclear or incorrect. Please re-upload the correct screenshot — your other details are kept.', label: 'Re-upload Screenshot' },
      WRONG_CATEGORY: { msg: 'The delegate category selected was incorrect. Please select the correct category and pay any balance due.', label: 'Update Category' },
      ID_DISCREPANCY: { msg: 'Your student ID could not be verified. Upload a valid student ID, or switch to an appropriate category.', label: 'Update ID / Category' },
      // legacy fall-throughs
      PAYMENT: { msg: 'Your payment was rejected due to a discrepancy. Please resubmit your correct payment details and screenshot.', label: 'Resubmit Payment' },
      ID: { msg: 'Your ID could not be verified for the selected category. Please change category or re-upload the correct student ID card.', label: 'Update Category / ID' },
    };
    const r = R[reg.rejection_reason] || {
      msg: 'Your registration was rejected' + (reg.rejection_note ? `: ${reg.rejection_note}` : '.') + ' Please review and resubmit.',
      label: 'Update Registration',
    };
    document.getElementById('reverify-msg').innerText = r.msg + (reg.rejection_note && !R[reg.rejection_reason] ? '' : (reg.rejection_note ? ` (${reg.rejection_note})` : ''));
    document.getElementById('reverify-btn').innerText = r.label;
    reverifyBanner.classList.remove('hidden');
  } else if (partial) {
    // Partial payment: the balance banner above carries the CTA (Pay Balance).
    statusTag.className = "text-xs bg-orange-100 text-orange-800 font-bold px-2.5 py-1 rounded-full border border-orange-300";
    statusTag.innerText = "Balance due";
    reverifyBanner.classList.add('hidden');
  } else {
    // Pending manual verification: payment details are locked once
    // submitted, so there is nothing for the delegate to edit here. Hide
    // the action button entirely rather than opening a form the server
    // will just reject.
    statusTag.className = "text-xs bg-amber-100 text-amber-800 font-bold px-2.5 py-1 rounded-full border border-amber-300";
    statusTag.innerText = reg.is_flagged ? "Being checked" : "Being verified";
    reverifyBanner.classList.add('hidden');
  }

}

// --- GROUP REGISTRATION (delegate) ---
const GROUP_STATUS_LABEL = { BANK_VERIFIED: 'Paid ✓', PARTIAL_PAYMENT: 'Balance due', PENDING: 'Pending', REJECTED: 'Rejected', NOT_REGISTERED: 'Not paid' };
// Shared by both branches of renderGroupSection() below, so the heading
// icon has exactly one source instead of two copies that could drift.
// The how-to page, linked wherever a delegate is looking at the group panel.
// It sits in the panel's row of buttons rather than trailing a sentence: a
// leader looking for "what do I do next" scans the controls, not the note
// under them.
const GROUP_HELP_URL = '/help/group-registration';
const GROUP_HELP_LINK = `<a href="${GROUP_HELP_URL}" target="_blank" rel="noopener"
  class="w-full sm:w-auto justify-center px-5 py-3 bg-indigo-50 border-2 border-indigo-300 text-indigo-800 hover:bg-indigo-100 hover:border-indigo-400 text-sm font-bold rounded-xl shadow-sm inline-flex items-center gap-2">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5 shrink-0"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3 2.45V14"/><circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none"/></svg>
  How group registration works</a>`;
const GROUP_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4 inline align-[-3px] mr-1"><circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 14.2c2.8.4 5 2.8 5 5.8"/></svg>';
async function renderGroupSection() {
  const box = document.getElementById('group-section');
  if (!box) return;
  // Wrapped like loadAbstractStatus's own fetch: the .catch() on .json()
  // below only covers a bad response body, not fetch() itself rejecting
  // outright (a network failure) -- which, unguarded, threw straight past
  // this function's several other callers (loadDashboard included) with
  // nothing to show for it. A failed fetch here just leaves the section
  // hidden, the same as "not in a group with nothing eligible" already does.
  try {
  const data = await (await fetch('/api/groups/me')).json().catch(() => ({}));
  const g = data.group;

  if (g) {
    const rows = g.members.map((m) => {
      const label = GROUP_STATUS_LABEL[m.status] || m.status;
      const tone = m.status === 'BANK_VERIFIED' ? 'text-emerald-700' : m.status === 'PARTIAL_PAYMENT' ? 'text-orange-700' : m.status === 'REJECTED' ? 'text-rose-600' : 'text-slate-500';
      const canRemove = g.isLeader && m.phone !== g.leaderPhone;
      return `<div class="flex items-center justify-between py-1.5 text-sm border-b border-indigo-50 last:border-0">
        <span class="min-w-0 truncate">${esc(m.name)}${m.phone === g.leaderPhone ? ' <span class="text-[10px] text-indigo-500 font-semibold">(leader)</span>' : ''}</span>
        <span class="flex items-center gap-2 shrink-0">
          <span class="text-xs font-semibold ${tone}">${esc(label)}</span>
          ${canRemove ? `<button onclick="removeGroupMember('${esc(m.phone)}')" class="text-[11px] text-rose-500 hover:underline">remove</button>` : ''}
        </span>
      </div>`;
    }).join('');
    const need = Math.max(0, (g.minSize || 0) - g.size);
    const statusLine = g.qualifies
      ? `<span class="text-emerald-700 font-semibold">✓ Group discount active${g.allVerified ? ' · all members paid' : ''}</span>`
      : `<span class="text-amber-700 font-semibold">${need} more member${need === 1 ? '' : 's'} needed to unlock the discount (min ${g.minSize})</span>`;
    box.innerHTML = `
      <div class="flex items-center justify-between mb-2">
        <h3 class="text-lg font-bold text-slate-800">${GROUP_ICON}Group Registration</h3>
        <span class="text-xs text-slate-500">${esc(g.categoryLabel)} · ${g.size} member${g.size === 1 ? '' : 's'}</span>
      </div>
      <p class="text-xs mb-3">${statusLine}</p>
      <div class="bg-white rounded-lg border border-indigo-100 px-3 py-1 mb-3">${rows}</div>
      <div class="flex flex-wrap gap-2">
        ${g.isLeader ? `<button onclick="openAddGroupMember()" class="px-3 py-2 bg-navy hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg">+ Add member</button>` : ''}
        <button onclick="leaveGroup()" class="px-3 py-2 bg-white border border-slate-300 text-slate-600 hover:bg-slate-50 text-xs font-semibold rounded-lg">Leave group</button>
        ${GROUP_HELP_LINK}
      </div>
      <p class="text-[11px] text-slate-500 mt-3">Each member pays their own (discounted) fee. The discount is confirmed once every member's payment is verified.</p>`;
    box.classList.remove('hidden');
    return;
  }

  // Not eligible: a delegate whose registration is already confirmed and paid
  // cannot be in a group (the fee is settled and the discount is worked out at
  // payment), so offering one would only lead to a refusal. Hidden only on an
  // explicit no, so a response that never arrived leaves the panel as it was.
  if (data.canStart === false) { box.classList.add('hidden'); return; }

  // Not in a group: offer to start one for any category that has a rule.
  const eligible = (await (await fetch('/api/groups/eligible-categories')).json().catch(() => ({}))).categories || [];
  if (!eligible.length) { box.classList.add('hidden'); return; }
  box.innerHTML = `
    <div class="flex items-center justify-between mb-2">
      <h3 class="text-lg font-bold text-slate-800">${GROUP_ICON}Group Registration</h3>
      <span class="text-xs text-slate-500">Save with 5+ delegates</span>
    </div>
    <p class="text-xs text-slate-600 mb-3">Registering as a group? Start a group and add fellow delegates in the same category to unlock a group discount for everyone.</p>
    <div class="flex flex-wrap gap-2 items-end">
      <select id="group-start-cat" class="h-9 px-3 border border-slate-300 rounded-lg text-sm bg-white outline-none">
        ${eligible.map((c) => `<option value="${esc(c.category_key)}">${esc(c.label)} — ${c.discount_type === 'PERCENT' ? esc(c.discount_value) + '%' : '₹' + inr(c.discount_value)} off for ${esc(c.min_size)}+</option>`).join('')}
      </select>
      <button onclick="startGroup()" class="h-9 px-4 bg-navy hover:bg-indigo-700 text-white text-sm font-semibold rounded-lg">Start a group</button>
      ${GROUP_HELP_LINK}
    </div>`;
  box.classList.remove('hidden');
  } catch (e) { box.classList.add('hidden'); }
}

async function startGroup() {
  const categoryKey = document.getElementById('group-start-cat').value;
  const data = await (await fetch('/api/groups', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ categoryKey }),
  })).json();
  if (!data.success) return showToast(data.error || 'Could not start the group.');
  showToast('Group started. Add fellow delegates to unlock the discount.', 'success');
  renderGroupSection();
}

let groupAddId = null;
function openAddGroupMember() {
  document.getElementById('group-add-phone').value = '';
  openModal('modal-group-add');
}
async function submitAddGroupMember() {
  // Mobile or email -- strip formatting only when it isn't an email, which
  // digits-only stripping would destroy. The server resolves either to the
  // delegate's account.
  const raw = document.getElementById('group-add-phone').value.trim();
  const identifier = EMAIL_RE.test(raw) ? raw : raw.replace(/\D/g, '');
  if (!isPhoneValue(identifier) && !EMAIL_RE.test(identifier)) {
    return showToast('Enter a valid 10-digit mobile number or email address.');
  }
  const gid = (await (await fetch('/api/groups/me')).json()).group?.id;
  if (!gid) return showToast('Group not found.');
  const data = await (await fetch(`/api/groups/${gid}/members`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier }),
  })).json();
  if (!data.success) return showToast(data.error || 'Could not add member.');
  showToast('Member added.', 'success');
  closeModal('modal-group-add');
  renderGroupSection();
}

async function removeGroupMember(phone) {
  if (!(await showConfirm('Remove this member from the group?'))) return;
  const gid = (await (await fetch('/api/groups/me')).json()).group?.id;
  if (!gid) return;
  const data = await (await fetch(`/api/groups/${gid}/members/${encodeURIComponent(phone)}`, { method: 'DELETE' })).json();
  if (!data.success) return showToast(data.error || 'Could not remove member.');
  renderGroupSection();
}

async function leaveGroup() {
  if (!(await showConfirm('Leave this group? You will lose the group discount.'))) return;
  const me = (await (await fetch('/api/groups/me')).json()).group;
  if (!me) return;
  const myPhone = (currentDelegate && (currentDelegate.phone_number || currentDelegate.phone)) || '';
  const data = await (await fetch(`/api/groups/${me.id}/members/${encodeURIComponent(myPhone)}`, { method: 'DELETE' })).json();
  if (!data.success) return showToast(data.error || 'Could not leave the group.');
  showToast('You left the group.', 'info');
  renderGroupSection();
}

// Reflect the delegate's abstract status on the dashboard. The abstract is
// locked once submitted (no updates).
// The abstract card only while it has something to offer: submission open,
// or an abstract of their own to follow. Without it the registration card
// takes the full width.
function showAbstractCard(show) {
  const card = document.getElementById('abstract-card');
  const reg = document.getElementById('registration-card');
  if (card) card.classList.toggle('hidden', !show);
  if (reg) reg.classList.toggle('md:col-span-2', !show);
}

async function loadAbstractStatus() {
  const tag = document.getElementById('abstract-status-tag');
  const btn = document.getElementById('abstract-action-btn');
  const desc = document.getElementById('abstract-desc');
  if (!tag) return;
  // Same pill shape as payment-status-tag's states -- one status-pill
  // component, not two ad hoc ones, since the two cards sit side by side.
  const STYLES = {
    UNDER_REVIEW: ['Under Review', 'bg-amber-100 text-amber-800 border-amber-300'],
    ACCEPTED: ['Accepted ✓', 'bg-emerald-100 text-emerald-800 border-emerald-300'],
    REJECTED: ['Not Accepted', 'bg-rose-100 text-rose-800 border-rose-300'],
    REVISION_REQUESTED: ['Corrections Needed', 'bg-orange-100 text-orange-800 border-orange-300'],
  };
  const previewToggle = document.getElementById('abstract-preview-toggle');
  const previewBox = document.getElementById('abstract-preview-box');
  try {
    const mine = await (await fetch('/api/abstracts/me')).json();
    const abs = mine.abstract;
    // Missing (an older server) is read as registered, so nobody is wrongly
    // told they have not.
    const registered = mine.registered !== false;
    cachedOwnAbstract = abs;
    cachedAbstractSubmission = mine.submission || { open: true, deadline: '' };
    cachedAbstractAuthorsWindow = mine.authorsWindow || null;
    renderOwnAbstractAuthors(abs, cachedAbstractAuthorsWindow);
    showAbstractCard(!!abs || cachedAbstractSubmission.open !== false);
    if (abs) {
      let [label, cls] = STYLES[abs.status] || ['Submitted', 'bg-slate-100 text-slate-600'];
      if (abs.status === 'ACCEPTED' && abs.allocation) {
        label = `${registered ? 'Accepted' : 'Provisionally Accepted'} · ${abstractFormatLabel(abs.allocation)}`;
      } else if (abs.status === 'ACCEPTED' && !registered) {
        label = 'Provisionally Accepted';
      }
      tag.className = `text-xs font-bold px-2.5 py-1 rounded-full border ${cls}`;
      tag.innerText = label;

      // Locked after submission -- except REVISION_REQUESTED, the one
      // status that reopens the form for editing (see POST /api/abstracts
      // and openModal's prefill below).
      const needsRevision = abs.status === 'REVISION_REQUESTED';
      if (btn) {
        btn.innerText = needsRevision ? 'Revise & Resubmit' : 'Abstract Submitted';
        btn.disabled = !needsRevision;
        btn.classList.toggle('opacity-60', !needsRevision);
        btn.classList.toggle('cursor-not-allowed', !needsRevision);
      }
      if (desc) {
        if (abs.status === 'ACCEPTED' && abs.allocation) {
          const kind = abstractFormatLabel(abs.allocation).toLowerCase();
          desc.innerHTML = registered
            ? `Your abstract has been <b>accepted for ${kind} presentation</b>. Details will be communicated.`
            : `Your abstract has been <b>provisionally accepted for ${kind} presentation</b>, pending your registration.`;
        } else if (abs.status === 'ACCEPTED') {
          desc.innerHTML = registered
            ? 'Your abstract has been <b>accepted</b>. The presentation format will be communicated.'
            : 'Your abstract has been <b>provisionally accepted</b>, pending your registration. The presentation format will be communicated.';
        } else if (abs.status === 'REJECTED') {
          desc.innerText = 'Your abstract was not accepted.';
        } else if (needsRevision) {
          desc.innerHTML = `<b>The committee has requested corrections:</b> ${esc(abs.revision_note || '')}`;
        } else {
          desc.innerText = 'Your abstract has been submitted and is under review. It cannot be changed.';
        }
      }
      // An abstract can only be presented by a registered delegate.
      if (desc && !registered && abs.status !== 'REJECTED') {
        desc.innerHTML += ' <span class="block mt-1.5 text-amber-800 font-semibold">Registration is mandatory for presentation &mdash; you have not registered yet.</span>';
      }
      if (previewToggle) previewToggle.classList.remove('hidden');
      if (previewBox) previewBox.classList.add('hidden'); // collapsed by default each load
    } else {
      const { open, deadline } = cachedAbstractSubmission;
      if (!open) {
        // Past the last date: the server refuses a new abstract (POST
        // /api/abstracts), so the card says so instead of offering a form
        // that would only fail on submit.
        tag.className = 'text-xs bg-rose-50 text-rose-700 font-bold px-2.5 py-1 rounded-full border border-rose-200';
        tag.innerText = 'Submission Closed';
        if (btn) { btn.innerText = 'Submission Closed'; btn.disabled = true; btn.classList.add('opacity-60', 'cursor-not-allowed'); }
        if (desc) desc.innerHTML = `Abstract submission closed on <b>${esc(formatFullDateWithDay(deadline))}</b>. New abstracts can no longer be accepted.`;
      } else {
        tag.className = 'text-xs bg-slate-100 text-slate-600 font-bold px-2.5 py-1 rounded-full border border-slate-200';
        tag.innerText = 'Not Submitted';
        if (btn) { btn.innerText = 'Submit Abstract'; btn.disabled = false; btn.classList.remove('opacity-60', 'cursor-not-allowed'); }
        if (desc) desc.innerHTML = 'Submit papers or posters under Healthcare Quality &amp; Patient Safety. One abstract per delegate; it cannot be changed once submitted.';
      }
      if (previewToggle) previewToggle.classList.add('hidden');
      if (previewBox) previewBox.classList.add('hidden');
    }
    renderAbstractDeadlineNote(abs, cachedAbstractSubmission);
  } catch (e) { /* leave as-is */ }
}

// "Last date for submission: Tuesday, 15 September 2026", on the dashboard
// card and at the top of the submission form. Shown only while it is still
// the delegate's to act on: once they have submitted, the date no longer
// concerns them -- and a resubmission the committee asked for is not held to
// it (see POST /api/abstracts), so showing it there would mislead. Once
// closed, the card's own text already says when.
function renderAbstractDeadlineNote(abs, sub) {
  // A date given to this delegate alone says so, so it is not mistaken for
  // a general extension.
  const text = (!abs && sub && sub.open && sub.deadline)
    ? (sub.extended
      ? `Your last date for submission (extended for you): ${formatFullDateWithDay(sub.deadline)}`
      : `Last date for submission: ${formatFullDateWithDay(sub.deadline)}`) : '';
  const icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3.5 h-3.5 shrink-0"><rect x="3" y="5" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="3" x2="8" y2="7"/><line x1="16" y1="3" x2="16" y2="7"/></svg>';
  for (const id of ['abstract-deadline-note', 'abstract-modal-deadline']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.innerHTML = text ? `${icon}<span>${esc(text)}</span>` : '';
    el.classList.toggle('hidden', !text);
  }
}

// Cached so the preview toggle doesn't need a second round trip.
let cachedOwnAbstract = null;
// The submission window from the same response -- { open, deadline }.
let cachedAbstractSubmission = { open: true, deadline: '' };

// Read-only structured preview. abs.background/aim/methods/results/
// conclusion already went through sanitizeAbstractHtml() server-side (a
// four-tag allowlist -- see there), so this renders them directly rather
// than through esc(), which would double-escape and show literal "&lt;b&gt;"
// instead of actual bold text.
function toggleAbstractPreview() {
  const box = document.getElementById('abstract-preview-box');
  if (!box || !cachedOwnAbstract) return;
  if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
  const abs = cachedOwnAbstract;
  const section = (label, html) => html ? `<div><p class="font-bold text-slate-700">${esc(label)}</p><p class="whitespace-pre-wrap">${html}</p></div>` : '';
  box.innerHTML = [
    section('Background', abs.background), section('Aim', abs.aim), section('Methods', abs.methods),
    section('Results', abs.results), section('Conclusion', abs.conclusion),
    abs.keywords ? `<div><p class="font-bold text-slate-700">Keywords</p><p>${esc(abs.keywords)}</p></div>` : '',
  ].join('');
  box.classList.remove('hidden');
}

// --- Abstract authors ---------------------------------------------------------
// Every author of an abstract, in the order they are to be printed. One
// editor, used in the submission form (#abstract-form-authors) and the
// Authors modal (#abstract-authors-list): the presenting author is always on
// the list; the others can be added, removed and moved with the arrows
// (buttons rather than dragging, which is unreliable on a phone). State is
// kept per list, by its element id. See abstract-authors.js for the rules.
const authorEditors = {};
// From GET /api/abstracts/me: { open, deadline, max } for their own list.
let cachedAbstractAuthorsWindow = null;

function setAuthorEditor(cid, list, { max = 6, renamePresenting = false } = {}) {
  authorEditors[cid] = { list: (list || []).map((a) => ({ name: a.name || '', presenting: !!a.presenting })), max, renamePresenting };
  renderAuthorEditor(cid);
}

function renderAuthorEditor(cid) {
  const box = document.getElementById(cid);
  const ed = authorEditors[cid];
  if (!box || !ed) return;
  const n = ed.list.length;
  const btn = 'w-10 h-11 shrink-0 flex items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed';
  box.innerHTML = ed.list.map((a, i) => `
    <li class="flex items-center gap-1.5">
      <span class="w-6 shrink-0 text-right text-sm font-bold text-slate-400 tabular-nums">${i + 1}.</span>
      <div class="flex-1 min-w-0">${a.presenting && !ed.renamePresenting
        ? `<div class="h-11 px-3 flex items-center gap-2 rounded-lg border border-gold-300 bg-gold-50"><span class="truncate text-sm font-semibold text-slate-900">${esc(a.name)}</span><span class="ml-auto shrink-0 text-[10px] font-bold text-gold-700 uppercase tracking-wide">Presenting</span></div>`
        : `<input type="text" value="${esc(a.name)}" maxlength="120" autocomplete="off" placeholder="${a.presenting ? 'Presenting author' : 'Author\'s full name'}" aria-label="Author ${i + 1}${a.presenting ? ' (presenting)' : ''}" oninput="setAuthorName('${cid}', ${i}, this.value)"
            class="w-full h-11 px-3 border ${a.presenting ? 'border-gold-300 bg-gold-50 font-semibold' : 'border-slate-300 bg-white'} rounded-lg text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100">`}</div>
      <button type="button" ${i === 0 ? 'disabled' : ''} onclick="moveAuthor('${cid}', ${i}, -1)" aria-label="Move ${esc(a.name || 'this author')} up" class="${btn}">↑</button>
      <button type="button" ${i === n - 1 ? 'disabled' : ''} onclick="moveAuthor('${cid}', ${i}, 1)" aria-label="Move ${esc(a.name || 'this author')} down" class="${btn}">↓</button>
      ${a.presenting ? '<span class="w-10 shrink-0" aria-hidden="true"></span>' : `<button type="button" onclick="removeAuthor('${cid}', ${i})" aria-label="Remove ${esc(a.name || 'this author')}" class="${btn} hover:text-rose-700">✕</button>`}
    </li>`).join('')
    + `<li class="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 pl-7">
        ${n < ed.max ? `<button type="button" onclick="addAuthor('${cid}')" class="h-10 px-3 rounded-lg border border-dashed border-slate-300 text-sm font-semibold text-navy hover:bg-slate-50">+ Add author</button>` : ''}
        <span class="text-xs text-slate-500">${n} of ${ed.max} authors${n >= ed.max ? ' — the most an abstract can have' : ''}${n > 1 && ed.renamePresenting ? ' · the gold row is the presenting author' : ''}</span>
      </li>`;
}

function setAuthorName(cid, i, value) {
  const ed = authorEditors[cid];
  if (ed && ed.list[i]) ed.list[i].name = value;
}
function moveAuthor(cid, i, dir) {
  const ed = authorEditors[cid];
  const j = i + dir;
  if (!ed || j < 0 || j >= ed.list.length) return;
  [ed.list[i], ed.list[j]] = [ed.list[j], ed.list[i]];
  renderAuthorEditor(cid);
}
function removeAuthor(cid, i) {
  const ed = authorEditors[cid];
  if (!ed || !ed.list[i] || ed.list[i].presenting) return;
  ed.list.splice(i, 1);
  renderAuthorEditor(cid);
}
function addAuthor(cid) {
  const ed = authorEditors[cid];
  if (!ed || ed.list.length >= ed.max) return;
  ed.list.push({ name: '', presenting: false });
  renderAuthorEditor(cid);
  const inputs = document.querySelectorAll(`#${cid} input`);
  const last = inputs && inputs[inputs.length - 1];
  if (last && last.focus) last.focus();
}
// The list to send: blank rows left out (the presenting author is kept).
function authorEditorValue(cid) {
  const ed = authorEditors[cid];
  if (!ed) return undefined;
  return ed.list.map((a) => ({ name: String(a.name || '').replace(/\s+/g, ' ').trim(), presenting: a.presenting }))
    .filter((a) => a.name || a.presenting);
}

// "A Rao, B Shah, C Iyer" with the presenting author underlined when there
// is more than one.
function abstractAuthorsLineHtml(list) {
  const many = (list || []).length > 1;
  return (list || []).map((a) => (a.presenting && many
    ? `<span class="underline decoration-gold-500 decoration-2 underline-offset-2" title="Presenting author">${esc(a.name)}</span>`
    : esc(a.name))).join(', ');
}

// The delegate's own abstract card: its authors, and the way to add or
// reorder them while the last date for authors has not passed.
function renderOwnAbstractAuthors(abs, win) {
  const box = document.getElementById('abstract-authors-box');
  if (!box) return;
  if (!abs || abs.status === 'REJECTED') { box.innerHTML = ''; box.classList.add('hidden'); return; }
  const open = !win || win.open !== false;
  const by = win && win.deadline ? ` by <b>${esc(formatFullDateWithDay(win.deadline))}</b>` : '';
  const ask = !abs.authors_given && open
    ? `<div class="rounded-xl border border-gold-300 bg-gold-50 px-3.5 py-3 mb-2">
        <p class="text-sm font-bold text-navy">Add your co-authors</p>
        <p class="text-[13px] text-slate-700 mt-0.5 leading-relaxed">Your abstract lists only you. Add every author in the order they should be printed${by}. If you are the only author, open the list and save it.</p>
      </div>` : '';
  const action = open
    ? `<div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <button type="button" onclick="openAbstractAuthors()" class="h-11 px-4 ${abs.authors_given ? 'border border-slate-300 bg-white text-navy hover:bg-slate-50' : 'bg-navy hover:bg-indigo-700 text-white'} font-semibold rounded-lg text-sm">${abs.authors_given ? 'Edit authors' : 'Add authors'}</button>
        ${abs.authors_given && win && win.deadline ? `<span class="text-xs text-slate-500">Can be changed until ${esc(formatFullDate(win.deadline))}</span>` : ''}
      </div>`
    : '<p class="text-xs text-slate-500 mt-1">The author list can no longer be changed here. To correct it, write to the organisers.</p>';
  box.innerHTML = `${ask}<p class="text-sm text-slate-700"><span class="font-semibold text-slate-900">Authors:</span> ${abstractAuthorsLineHtml(abs.authors || [])}</p>${action}`;
  box.classList.remove('hidden');
}

// Open the Authors modal: for the delegate's own abstract (no id), or, from
// the Abstracts tab, for any abstract -- where the presenting author's name
// can be corrected too.
let abstractAuthorsTarget = null;
function openAbstractAuthors(id) {
  const admin = id !== undefined && id !== null;
  const abs = admin ? abstractsCache.find((x) => String(x.id) === String(id)) : cachedOwnAbstract;
  if (!abs) return;
  const win = admin ? abstractsAuthorsWindow : cachedAbstractAuthorsWindow;
  abstractAuthorsTarget = admin ? { mode: 'admin', id: abs.id } : { mode: 'me' };
  setText('abstract-authors-title', abs.title || '');
  setAuthorEditor('abstract-authors-list', abs.authors || [], { max: (win && win.max) || 6, renamePresenting: admin });
  setText('abstract-authors-deadline', admin
    ? (abs.author_name ? `Submitted by ${abs.author_name}` : '')
    : (win && win.deadline ? `Can be changed until ${formatFullDate(win.deadline)}` : ''));
  document.getElementById('modal-abstract-authors').classList.remove('hidden');
}

async function saveAbstractAuthorsList() {
  const t = abstractAuthorsTarget;
  if (!t) return;
  const btn = document.getElementById('abstract-authors-save');
  if (btn) btn.disabled = true;
  try {
    const url = t.mode === 'admin' ? `/api/abstracts/${encodeURIComponent(t.id)}/authors` : '/api/abstracts/me/authors';
    const data = await (await fetch(url, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authors: authorEditorValue('abstract-authors-list') }),
    })).json();
    if (!data.success) return showToast(data.error || 'Could not save the authors.');
    showToast('Authors saved.', 'success');
    closeModal('modal-abstract-authors');
    if (t.mode === 'admin') {
      await renderBackendAbstracts();
      const review = document.getElementById('modal-abstract-review');
      if (review && !review.classList.contains('hidden')) openAbstractReview(t.id);
    } else {
      loadAbstractStatus();
    }
  } catch (e) {
    showToast('Could not save the authors. Check your connection and try again.');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Applied promo code for the current payment form: { code, discountAmount,
// finalFee, categoryKey }. Cleared when the category changes.
let appliedPromo = null;
function clearAppliedPromo() {
  appliedPromo = null;
  const msg = document.getElementById('promo-msg');
  if (msg) msg.classList.add('hidden');
  const inputRow = document.getElementById('promo-input-row');
  if (inputRow) inputRow.classList.remove('hidden');
}

// A personal code issued to this delegate is applied without their typing
// it: when a category is chosen, the server names their best valid personal
// code for it (GET /api/discounts/mine), and it goes in exactly as if typed.
// Removing it with ✕ is respected for the rest of this form -- they chose to
// pay without it -- and each category is only asked about once.
let personalCodeState = { dismissed: false, checked: {} };
async function autoApplyPersonalCode(catKey) {
  if (!catKey || personalCodeState.dismissed || personalCodeState.checked[catKey]) return;
  personalCodeState.checked[catKey] = true;
  let data;
  try {
    data = await (await fetch(`/api/discounts/mine?categoryKey=${encodeURIComponent(catKey)}`)).json();
  } catch (e) { return; }
  // The category may have changed, or a code been typed, while this was asked.
  const current = document.getElementById('payment-category');
  if (!data || !data.success || personalCodeState.dismissed || !current || current.value !== catKey || appliedPromo) return;
  const msg = document.getElementById('promo-msg');
  if (data.code) {
    appliedPromo = { code: data.code.code, discountAmount: data.code.discountAmount, finalFee: data.code.finalFee, categoryKey: catKey, auto: true };
    const codeInput = document.getElementById('promo-code');
    if (codeInput) codeInput.value = data.code.code;
    const inputRow = document.getElementById('promo-input-row');
    if (inputRow) inputRow.classList.add('hidden');
    if (msg) {
      // An email-domain code is not "personal": it comes with their address.
      const whose = data.code.scopeType === 'DOMAIN' ? `Your @${data.code.domain} email address gets code ${data.code.code}` : `Your personal code ${data.code.code} has been applied`;
      msg.textContent = data.code.scopeType === 'DOMAIN' && data.code.discountType === 'FEE_TIER'
        ? `${whose} — you pay the ${FEE_TIER_LABELS[data.code.feeTier] || ''} fee of ₹${inr(data.code.finalFee)}.`
        : data.code.discountType === 'FEE_TIER'
        ? `Your personal code ${data.code.code} has been applied — you pay the ${FEE_TIER_LABELS[data.code.feeTier] || ''} fee of ₹${inr(data.code.finalFee)}.`
        : data.code.discountType === 'FIXED_FEE'
          ? `Your personal code ${data.code.code} has been applied — your fee is now ₹${inr(data.code.finalFee)}.`
          : `Your personal code ${data.code.code} has been applied — you save ₹${inr(data.code.discountAmount)}.`;
      msg.className = 'text-xs mt-1 text-emerald-700 font-semibold';
    }
    calculateFee();
  } else if (data.needsVerification && msg) {
    // A personal code issued to their address, or one for their email domain.
    msg.textContent = 'A discount is waiting for your email address. Verify your email address to use it.';
    msg.className = 'text-xs mt-1 text-amber-700 font-semibold';
    const field = document.getElementById('promo-field');
    if (field && field.classList.contains('hidden')) togglePromoField();
  }
}

// Explicit remove action once a code is applied -- clearing the input text
// and re-clicking Apply worked but wasn't a discoverable way to drop a code.
// Triggered by the small ✕ shown next to the "Discount (CODE)" line.
function removeAppliedPromo() {
  // Removing a code -- the one applied for them included -- is their choice;
  // it is not put back when they change category.
  personalCodeState.dismissed = true;
  const codeInput = document.getElementById('promo-code');
  if (codeInput) codeInput.value = '';
  clearAppliedPromo();
  calculateFee();
}

function togglePromoField() {
  const field = document.getElementById('promo-field');
  const toggle = document.getElementById('promo-toggle');
  if (!field) return;
  const show = field.classList.contains('hidden');
  field.classList.toggle('hidden', !show);
  if (toggle) toggle.classList.toggle('hidden', show); // hide the link once open
  if (show) { const i = document.getElementById('promo-code'); if (i) i.focus(); }
}

async function applyPromoCode() {
  const codeInput = document.getElementById('promo-code');
  const msg = document.getElementById('promo-msg');
  const catKey = document.getElementById('payment-category').value;
  const code = (codeInput.value || '').trim();
  if (!catKey) return showToast('Select your category first.');
  if (!code) { clearAppliedPromo(); calculateFee(); return; }

  const showMsg = (text, ok) => {
    if (!msg) return;
    msg.textContent = text;
    msg.classList.remove('hidden');
    msg.classList.toggle('text-emerald-700', ok);
    msg.classList.toggle('text-rose-600', !ok);
  };
  const btn = document.getElementById('promo-apply-btn');
  if (btn) btn.disabled = true;
  try {
    const data = await (await fetch('/api/discounts/validate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, categoryKey: catKey }),
    })).json();
    if (!data.success) { clearAppliedPromo(); showMsg(data.error || 'Invalid code.', false); calculateFee(); return; }
    appliedPromo = { code: data.code, discountAmount: data.discountAmount, finalFee: data.finalFee, categoryKey: catKey };
    showMsg(data.discountType === 'FEE_TIER'
      ? `Code applied — you pay the ${FEE_TIER_LABELS[data.feeTier] || ''} fee of ₹${inr(data.finalFee)}${data.discountAmount ? ` (you save ₹${inr(data.discountAmount)})` : ''}.`
      : data.discountType === 'FIXED_FEE'
        ? `Code applied — your fee is now ₹${inr(data.finalFee)}${data.discountAmount ? ` (you save ₹${inr(data.discountAmount)})` : ''}.`
        : `Code applied — you save ₹${inr(data.discountAmount)}. New fee: ₹${inr(data.finalFee)}.`, true);
    // The input+Apply row is no longer needed once a code is applied -- the
    // Discount line above (with its own ✕) is now the applied-state UI.
    const inputRow = document.getElementById('promo-input-row');
    if (inputRow) inputRow.classList.add('hidden');
    calculateFee();
  } catch (e) {
    showMsg('Could not check the code. Try again.', false);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function calculateFee() {
  const catKey = document.getElementById('payment-category').value;

  // Student categories must upload an ID card (feeCategories, from /api/fees,
  // carries requiresStudentId -- see loadFees).
  const idBlock = document.getElementById('id-card-block');
  if (idBlock) idBlock.classList.toggle('hidden', !(feeCategories[catKey] && feeCategories[catKey].requiresStudentId));
  // Doctors and Medical PGs: their council registration -- asked once, then
  // shown.
  const councilBlock = document.getElementById('council-block');
  if (councilBlock) {
    const asks = !!(feeCategories[catKey] && feeCategories[catKey].asksCouncilNumber);
    const saved = currentDelegate && currentDelegate.council_reg_no;
    councilBlock.classList.toggle('hidden', !asks);
    document.getElementById('council-inputs').classList.toggle('hidden', !!saved);
    const savedLine = document.getElementById('council-saved');
    savedLine.classList.toggle('hidden', !saved);
    savedLine.textContent = saved ? `${currentDelegate.council_name || 'Medical Council'} · ${currentDelegate.council_reg_no}` : '';
  }

  if (!catKey) return;

  // feeCategories is populated by an earlier /api/fees fetch (see loadFees).
  // If that fetch failed silently (e.g. a flaky mobile connection) but the
  // category list itself still rendered, don't let the fee silently fall
  // back to ₹0 -- that produces a screenshot-payment/claimed-amount mismatch
  // that gets wrongly flagged as tampering even when the delegate paid
  // correctly.
  if (!feeCategories[catKey]) {
    showToast('Could not load the fee for this category. Please close and reopen this form.');
    document.getElementById('calculated-fee-display').innerText = '—';
    document.getElementById('entered-amount').value = '';
    document.getElementById('qr-container').classList.add('hidden');
    return;
  }

  const baseFee = feeCategories[catKey].fee;
  // A promo code only applies to the category it was validated against; if the
  // category changed, the applied discount is dropped (re-apply required).
  if (appliedPromo && appliedPromo.categoryKey !== catKey) clearAppliedPromo();
  if (catKey && !appliedPromo) autoApplyPersonalCode(catKey);
  const discount = (appliedPromo && appliedPromo.categoryKey === catKey) ? appliedPromo.discountAmount : 0;
  // Chosen program options (e.g. a paid pre-conference workshop) add their
  // own fee on top -- not discounted themselves, matching the server (see
  // POST /api/registrations).
  const optionsFee = sumSelectedOptionFees();
  const currentFee = Math.max(0, baseFee - discount) + optionsFee;

  const baseLine = document.getElementById('fee-discount-line');
  const discLine = document.getElementById('fee-discount-amount-line');
  if (discount > 0) {
    if (baseLine) { baseLine.classList.remove('hidden'); setText('fee-base-display', `₹${inr(baseFee)}`); }
    if (discLine) { discLine.classList.remove('hidden'); setText('fee-discount-display', `−₹${inr(discount)}`); setText('fee-discount-label', `Discount (${esc(appliedPromo.code)})`); }
  } else {
    if (baseLine) baseLine.classList.add('hidden');
    if (discLine) discLine.classList.add('hidden');
  }
  const optionsLine = document.getElementById('fee-options-line');
  if (optionsLine) {
    optionsLine.classList.toggle('hidden', optionsFee <= 0);
    if (optionsFee > 0) setText('fee-options-display', `+₹${inr(optionsFee)}`);
  }
  document.getElementById('calculated-fee-display').innerText = `₹${inr(currentFee)}`;
  document.getElementById('entered-amount').value = currentFee;

  // A 100%-off discount brings the fee to ₹0 -- there's nothing to pay, so
  // hide the QR/bank-transfer block and the UTR/screenshot fields entirely
  // (and stop requiring them) rather than asking for payment proof of a
  // payment that was never made. An option fee keeps this from going free
  // even if the category itself is fully discounted.
  const isFreeReg = currentFee <= 0;
  const methodBlocks = document.getElementById('payment-method-blocks');
  const freeNote = document.getElementById('free-registration-note');
  const verifyFields = document.getElementById('payment-verification-fields');
  const utrInput = document.getElementById('entered-utr');
  const screenshotInput = document.getElementById('payment-screenshot');
  if (methodBlocks) methodBlocks.classList.toggle('hidden', isFreeReg);
  if (freeNote) freeNote.classList.toggle('hidden', !isFreeReg);
  if (verifyFields) verifyFields.classList.toggle('hidden', isFreeReg);
  if (utrInput) utrInput.required = !isFreeReg;
  if (screenshotInput) screenshotInput.required = !isFreeReg;
  const submitBtn = document.getElementById('submit-payment-btn');
  if (submitBtn) submitBtn.innerText = isFreeReg ? 'Confirm Registration (No Payment Needed)' : 'Submit for Verification';

  document.getElementById('qr-container').classList.remove('hidden');
  if (isFreeReg) return;

  // Reference is the delegate's registration number plus name, so the
  // transaction note (and therefore the QR code and the "Pay via UPI App"
  // link, which both encode the same note) let finance match a payment to a
  // delegate on sight, not just by number.
  const ref = (currentDelegate && (currentDelegate.registration_number || currentDelegate.phone_number || currentDelegate.phone)) || '';
  const name = (currentDelegate && (currentDelegate.full_name || currentDelegate.name)) || '';
  const note = name ? `${ref}_${name}` : ref;
  const upiUri = `upi://pay?pa=${OFFICIAL_UPI_ID}&pn=${encodeURIComponent(OFFICIAL_UPI_PAYEE_NAME)}&am=${currentFee}.00&cu=INR&tn=${encodeURIComponent(note)}`;
  document.getElementById('upi-qr-image').src = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(upiUri)}`;
  const payLink = document.getElementById('upi-pay-link');
  if (payLink) payLink.href = upiUri;
  togglePaymentMode();
}

// Called by the "Pay by Bank Transfer instead" / "Pay by UPI instead" links
// -- sets the underlying (hidden) payment-mode radio and re-renders.
function setPaymentMode(mode) {
  const input = document.querySelector(`input[name="payment-mode"][value="${mode}"]`);
  if (input) input.checked = true;
  togglePaymentMode();
}

// Switch between the UPI QR/pay-link block and the NEFT/RTGS bank-details
// block, and relabel the transaction-reference field to match.
function togglePaymentMode() {
  const modeInput = document.querySelector('input[name="payment-mode"]:checked');
  const mode = modeInput ? modeInput.value : 'UPI';
  const isNeft = mode === 'NEFT_RTGS';
  const upiBlock = document.getElementById('upi-pay-block');
  const neftBlock = document.getElementById('neft-pay-block');
  if (upiBlock) upiBlock.classList.toggle('hidden', isNeft);
  if (neftBlock) neftBlock.classList.toggle('hidden', !isNeft);
  const label = document.getElementById('entered-utr-label');
  const input = document.getElementById('entered-utr');
  if (label) label.innerText = isNeft ? 'Bank Transaction / Reference Number' : 'Transaction UTR Number';
  if (input) input.placeholder = isNeft ? 'Transaction reference no.' : '12-digit UTR No.';
}

// Program groups (Workshops, QI Practices, or any further admin-defined
// group -- see program_groups/program_options in server.js), with live
// capacity, rendered into the payment form. A group with max_select <= 1
// renders as a single <select> (the common case); a group configured to
// allow more than one choice renders as a checkbox list instead.
// option id -> fee, populated by loadProgramOptions(), so calculateFee() can
// add a chosen option's fee to the total without a round-trip.
let optionFeeById = {};

async function loadProgramOptions() {
  const box = document.getElementById('program-groups-container');
  const section = document.getElementById('program-groups-section');
  if (!box) return;
  try {
    const data = await (await fetch('/api/program-options')).json();
    const groups = data.groups || [];
    optionFeeById = {};
    groups.forEach((g) => g.options.forEach((o) => { optionFeeById[o.id] = Number(o.fee) || 0; }));
    if (section) section.classList.toggle('hidden', groups.length === 0);
    const feeTag = (o) => o.fee > 0 ? ` — +₹${inr(o.fee)}` : '';
    box.innerHTML = groups.map((g) => {
      const label = `${esc(g.name)}${g.required ? ' <span class="text-rose-500">*</span>' : ' <span class="font-normal text-slate-400">(optional)</span>'}`;
      if (g.maxSelect <= 1) {
        return `<div>
          <label class="block text-xs font-semibold text-slate-700 mb-1">${label}</label>
          <select class="program-group-select w-full p-2.5 text-sm border rounded-lg bg-white outline-none" data-group-id="${g.id}" data-group-name="${esc(g.name)}" ${g.required ? 'data-required="1"' : ''} onchange="calculateFee()">
            <option value="">-- Choose${g.required ? '' : ' (optional)'} --</option>
            ${g.options.map((o) => `<option value="${o.id}" ${o.full ? 'disabled' : ''}>${esc(o.name)}${o.full ? ' — FULL' : ` (${o.remaining} left)`}${feeTag(o)}</option>`).join('')}
          </select>
        </div>`;
      }
      return `<div>
        <label class="block text-xs font-semibold text-slate-700 mb-1">${label} <span class="font-normal text-slate-400">(choose up to ${g.maxSelect})</span></label>
        <div class="space-y-1.5" data-group-id="${g.id}" data-group-name="${esc(g.name)}" ${g.required ? 'data-required="1"' : ''}>
          ${g.options.map((o) => `<label class="flex items-center gap-2 text-sm ${o.full ? 'text-slate-400' : 'text-slate-700'}">
            <input type="checkbox" class="program-group-checkbox" data-group-id="${g.id}" value="${o.id}" ${o.full ? 'disabled' : ''} onchange="calculateFee()">
            ${esc(o.name)}${o.full ? ' — FULL' : ` (${o.remaining} left)`}${feeTag(o)}
          </label>`).join('')}
        </div>
      </div>`;
    }).join('') || '<p class="text-sm text-slate-400">No program options available.</p>';
  } catch (e) {
    /* leave the section empty if the fetch fails */
  }
}

// Every option id the delegate currently has selected, across every group
// (single-select <select>s and multi-select checkbox lists alike).
function collectSelectedOptionIds() {
  const ids = [];
  document.querySelectorAll('#program-groups-container .program-group-select').forEach((sel) => {
    if (sel.value) ids.push(Number(sel.value));
  });
  document.querySelectorAll('#program-groups-container .program-group-checkbox:checked').forEach((cb) => {
    ids.push(Number(cb.value));
  });
  return ids;
}

// Sum of the fees on every currently-selected program option (e.g. a paid
// pre-conference workshop) -- added to the category fee in calculateFee().
function sumSelectedOptionFees() {
  return collectSelectedOptionIds().reduce((sum, id) => sum + (optionFeeById[id] || 0), 0);
}

// Client-side nudge only -- required-group and max_select enforcement is
// re-checked server-side (see resolveSelections in server.js) regardless.
function validateProgramGroupSelections() {
  for (const sel of document.querySelectorAll('#program-groups-container .program-group-select[data-required="1"]')) {
    if (!sel.value) return `Please choose an option under "${sel.dataset.groupName}".`;
  }
  for (const wrap of document.querySelectorAll('#program-groups-container [data-required="1"]')) {
    if (wrap.tagName !== 'DIV') continue;
    const checked = wrap.querySelectorAll('.program-group-checkbox:checked').length;
    if (checked === 0) return `Please choose an option under "${wrap.dataset.groupName}".`;
  }
  return null;
}

// Categories + current-phase fee, loaded from the fee master.
let feeCategories = {};
// The medical councils (councils.js on the server), from /api/fees.
let medicalCouncilList = [];
const councilOptionsHtml = (selected) => `<option value="">— Medical Council —</option>${medicalCouncilList
  .map((c) => `<option value="${esc(c)}"${c === selected ? ' selected' : ''}>${esc(c)}</option>`).join('')}`;
// Admin pages: the list, for the edit forms.
async function loadMedicalCouncils() {
  if (medicalCouncilList.length) return;
  try { medicalCouncilList = (await (await fetch('/api/fees')).json()).medicalCouncils || []; } catch (e) { /* the forms fall back to typing */ }
}

async function loadFees() {
  try {
    const data = await (await fetch('/api/fees')).json();
    feeCategories = {};
    (data.categories || []).forEach((c) => { feeCategories[c.key] = c; });
    if (Array.isArray(data.medicalCouncils)) {
      medicalCouncilList = data.medicalCouncils;
      const councilSel = document.getElementById('payment-council');
      if (councilSel) councilSel.innerHTML = councilOptionsHtml(councilSel.value);
    }
    if (data.upi && data.upi.id) OFFICIAL_UPI_ID = data.upi.id;
    if (data.upi && data.upi.payeeName) {
      OFFICIAL_UPI_PAYEE_NAME = data.upi.payeeName;
      setText('upi-payee-label', OFFICIAL_UPI_PAYEE_NAME);
    }
    if (data.bank) {
      BANK_DETAILS = data.bank;
      ['registration', 'topup'].forEach((prefix) => {
        setText(`${prefix}-bank-account-name`, BANK_DETAILS.accountName || '—');
        setText(`${prefix}-bank-account-number`, BANK_DETAILS.accountNumber || '—');
        setText(`${prefix}-bank-ifsc`, BANK_DETAILS.ifsc || '—');
        setText(`${prefix}-bank-branch`, BANK_DETAILS.branch || '—');
      });
    }
    const sel = document.getElementById('payment-category');
    if (sel) {
      const current = sel.value;
      sel.innerHTML = '<option value="">-- Select Category --</option>' +
        (data.categories || []).map((c) => `<option value="${esc(c.key)}">${esc(c.label)}${c.subtitle ? ' — ' + esc(c.subtitle) : ''} — ₹${inr(Number(c.fee))}</option>`).join('');
      if (current) sel.value = current;
    }
  } catch (e) {
    /* keep any hardcoded fallback options */
  }
}

// Refresh capacity + fees then open the payment modal.
async function openPaymentModal() {
  personalCodeState = { dismissed: false, checked: {} };
  await Promise.all([loadProgramOptions(), loadFees()]);
  clearAppliedPromo();
  const promoInput = document.getElementById('promo-code');
  if (promoInput) promoInput.value = '';
  // Collapse the promo field back to its link each time the modal opens.
  const promoField = document.getElementById('promo-field');
  const promoToggle = document.getElementById('promo-toggle');
  if (promoField) promoField.classList.add('hidden');
  if (promoToggle) promoToggle.classList.remove('hidden');
  applyCategoryLock();
  openModal('modal-conference');
}

// If an admin has locked the delegate's category, preset and disable the
// category picker so they can only pay for the locked category.
function applyCategoryLock() {
  const reg = currentRegistration;
  const sel = document.getElementById('payment-category');
  const locked = !!(reg && reg.category_locked);
  if (locked && reg.category_key && sel) {
    sel.value = reg.category_key;
    calculateFee();
  }
  if (sel) sel.disabled = locked;
}

// --- PAYMENT SUBMISSION ---
async function verifyAndSubmitPayment(e) {
  e.preventDefault();

  const categoryKey = document.getElementById('payment-category').value;
  if (!categoryKey) return showToast('Please select your delegate category.');
  const isStudent = !!(feeCategories[categoryKey] && feeCategories[categoryKey].requiresStudentId);

  // Belt-and-braces: entered-amount is only ever auto-filled by
  // calculateFee(), which leaves it blank (not 0) on a load failure -- so an
  // empty/non-numeric value means something didn't load, while an explicit
  // 0 is a legitimate 100%-discounted registration with nothing to pay.
  const enteredAmountRaw = document.getElementById('entered-amount').value;
  const enteredAmount = parseFloat(enteredAmountRaw);
  if (enteredAmountRaw === '' || !Number.isFinite(enteredAmount) || enteredAmount < 0) {
    return showToast('Could not determine the fee for this category. Please close and reopen this form.');
  }
  const isFreeReg = enteredAmount === 0;

  let file = null;
  if (!isFreeReg) {
    file = document.getElementById('payment-screenshot').files[0];
    if (!file) return showToast('Please upload your payment screenshot.');
  }

  const idFile = document.getElementById('payment-id-card').files[0];
  if (isStudent && !idFile) return showToast('Please upload your student ID card for this category.');
  const asksCouncil = !!(feeCategories[categoryKey] && feeCategories[categoryKey].asksCouncilNumber) && !(currentDelegate && currentDelegate.council_reg_no);
  const councilName = asksCouncil ? document.getElementById('payment-council').value : '';
  const councilRegNo = asksCouncil ? document.getElementById('payment-council-no').value.trim() : '';
  // Optional, but both together.
  if (asksCouncil && (!councilName !== !councilRegNo)) return showToast('Choose your Medical Council and enter your registration number -- or leave both blank.');

  const groupError = validateProgramGroupSelections();
  if (groupError) return showToast(groupError);

  const submitBtn = document.getElementById('submit-payment-btn');
  const originalBtnText = submitBtn.innerText;
  submitBtn.innerText = isFreeReg ? 'Confirming...' : 'Checking uploads...';
  submitBtn.disabled = true;

  try {
    const screenshot = isFreeReg ? undefined : await readFileAsDataURL(file);
    const idCard = isStudent ? await readFileAsDataURL(idFile) : undefined;
    const utr = isFreeReg ? '' : document.getElementById('entered-utr').value.trim();

    // The server derives the fee from the category and reads the screenshot
    // (amount / UPI ID / UTR) and, for students, the ID card.
    const basePayload = {
      categoryKey,
      optionIds: collectSelectedOptionIds(),
      amount: parseFloat(document.getElementById('entered-amount').value),
      utr,
      screenshot,
      idCard,
      paymentMode: (document.querySelector('input[name="payment-mode"]:checked') || {}).value || 'UPI',
      // Only send the promo code if it's applied to the category being submitted.
      discountCode: (appliedPromo && appliedPromo.categoryKey === categoryKey) ? appliedPromo.code : undefined,
      councilName: asksCouncil && councilName ? councilName : undefined,
      councilRegNo: asksCouncil && councilRegNo ? councilRegNo : undefined,
    };

    async function submit(acknowledged) {
      const res = await fetch('/api/registrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...basePayload, acknowledged })
      });
      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Server status ${res.status}: ${errorText.substring(0, 100)}`);
      }
      return res.json();
    }

    let data = await submit(false);

    // Server couldn't verify one or more details.
    if (data.needsConfirmation) {
      const c = data.checks || {};
      const problems = [];
      if (!c.amount) problems.push(`• The amount ₹${inr(data.expectedAmount)} could not be found in the screenshot`);
      if (!c.vpa) problems.push('• The conference UPI ID could not be found in the screenshot');
      if (!c.utr) problems.push('• The UTR number you entered could not be found in the screenshot');
      if (c.id === false) problems.push('• Your ID card could not be confirmed to match the selected category');

      const proceed = await showConfirm(
        "We could not verify the following from your uploads:\n\n" +
        problems.join('\n') +
        "\n\nYou can submit anyway, but your registration will be FLAGGED for manual scrutiny by the team.",
        "Submit anyway", "Cancel & re-check"
      );
      if (!proceed) return;
      data = await submit(true);
    }

    if (data.success) {
      showToast(data.flagged
        ? "Submission received and FLAGGED for manual scrutiny (some details could not be auto-verified)."
        : (isFreeReg ? "Registration confirmed — no payment was required." : "Registration submitted successfully! It is PENDING manual verification."),
        data.flagged ? 'info' : 'success'
      );
      // Given now, it is saved: not asked again on a resubmission.
      if (asksCouncil && councilRegNo && currentDelegate) Object.assign(currentDelegate, { council_name: councilName, council_reg_no: councilRegNo.replace(/\s+/g, '').toUpperCase() });
      closeModal('modal-conference');
      loadDashboard();
    } else {
      showToast(data.error || 'Submission failed.');
    }
  } catch (err) {
    console.error('Payment Submission Error:', err);
    showToast(`Submission Error: ${err.message}`);
  } finally {
    submitBtn.innerText = originalBtnText;
    submitBtn.disabled = false;
  }
}

// --- TOP-UP (outstanding balance) ---
// Same UPI-QR-with-a-Bank-Transfer-fallback pattern as the initial
// registration payment (setPaymentMode/togglePaymentMode), kept as its own
// small pair rather than generalizing the existing functions -- the two
// modals' blocks have different ids and can be in the DOM at the same time.
function setTopupPaymentMode(mode) {
  const input = document.querySelector(`input[name="topup-payment-mode"][value="${mode}"]`);
  if (input) input.checked = true;
  const isNeft = mode === 'NEFT_RTGS';
  const upiBlock = document.getElementById('topup-upi-pay-block');
  const neftBlock = document.getElementById('topup-neft-pay-block');
  if (upiBlock) upiBlock.classList.toggle('hidden', isNeft);
  if (neftBlock) neftBlock.classList.toggle('hidden', !isNeft);
  const label = document.getElementById('topup-utr-label');
  const input2 = document.getElementById('topup-utr');
  if (label) label.innerText = isNeft ? 'Bank Transaction / Reference Number' : 'Transaction UTR / Reference Number';
  if (input2) input2.placeholder = isNeft ? 'Transaction reference no.' : '12-digit UTR No.';
}

function openTopupModal() {
  const reg = currentRegistration;
  if (!reg || !(reg.remaining > 0)) return showToast('No outstanding balance to pay.');
  const balance = Number(reg.remaining);
  setText('topup-amount-display', `₹${inr(balance)}`);
  document.getElementById('topup-utr').value = '';
  const fileInput = document.getElementById('topup-screenshot');
  if (fileInput) fileInput.value = '';
  setTopupPaymentMode('UPI'); // reset to the default each time the modal opens

  // UPI QR for the exact balance, with the delegate's reg number + name as the
  // note so finance can match it -- same scheme as the initial payment.
  const ref = reg.registration_number || reg.phone_number || '';
  const name = (currentDelegate && (currentDelegate.full_name || currentDelegate.name)) || '';
  const note = name ? `${ref}_${name}` : ref;
  const upiUri = `upi://pay?pa=${OFFICIAL_UPI_ID}&pn=${encodeURIComponent(OFFICIAL_UPI_PAYEE_NAME)}&am=${balance}.00&cu=INR&tn=${encodeURIComponent(note)}`;
  document.getElementById('topup-qr-image').src = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(upiUri)}`;
  const payLink = document.getElementById('topup-pay-link');
  if (payLink) payLink.href = upiUri;
  openModal('modal-topup');
}

async function submitTopup(e) {
  e.preventDefault();
  const reg = currentRegistration;
  if (!reg || !(reg.remaining > 0)) return showToast('No outstanding balance to pay.');
  const utr = document.getElementById('topup-utr').value.trim();
  const file = document.getElementById('topup-screenshot').files[0];
  if (!utr) return showToast('Enter the transaction UTR / reference number.');
  if (!file) return showToast('Upload your payment screenshot.');

  const btn = document.getElementById('topup-submit-btn');
  const original = btn.innerText;
  btn.innerText = 'Checking upload…';
  btn.disabled = true;
  try {
    const screenshot = await readFileAsDataURL(file);
    const modeInput = document.querySelector('input[name="topup-payment-mode"]:checked');
    const paymentMode = modeInput ? modeInput.value : 'UPI';
    const payload = { amount: Number(reg.remaining), utr, screenshot, paymentMode };
    const submit = async (acknowledged) => (await fetch('/api/registrations/topup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, acknowledged }),
    })).json();

    let data = await submit(false);
    if (data.needsConfirmation) {
      const c = data.checks || {};
      const problems = [];
      if (!c.amount) problems.push(`• The balance ₹${inr(data.expectedAmount)} could not be found in the screenshot`);
      if (!c.vpa) problems.push('• The conference UPI ID could not be found in the screenshot');
      if (!c.utr) problems.push('• The UTR number you entered could not be found in the screenshot');
      const proceed = await showConfirm(
        "We could not verify the following from your upload:\n\n" + problems.join('\n') +
        "\n\nYou can submit anyway, but your top-up will be FLAGGED for manual scrutiny.",
        "Submit anyway", "Cancel & re-check");
      if (!proceed) return;
      data = await submit(true);
    }

    if (data.success) {
      showToast(data.flagged
        ? 'Top-up received and FLAGGED for manual scrutiny.'
        : 'Top-up submitted! It is pending verification.', data.flagged ? 'info' : 'success');
      closeModal('modal-topup');
      loadDashboard();
    } else {
      showToast(data.error || 'Top-up failed.');
    }
  } catch (err) {
    showToast(`Top-up Error: ${err.message}`);
  } finally {
    btn.innerText = original;
    btn.disabled = false;
  }
}

// --- REJECTION RESOLUTION (delegate) ---
// Dispatch the "Update" action on a rejected registration to the right flow:
// targeted correction for wrong details / wrong screenshot; full re-register
// for category / ID / other.
function resolveRejection() {
  const reason = currentRegistration && currentRegistration.rejection_reason;
  if (reason === 'WRONG_DETAILS' || reason === 'WRONG_SCREENSHOT') {
    openCorrectModal(reason);
  } else {
    // WRONG_CATEGORY, ID_DISCREPANCY, OTHER, and legacy codes: re-register.
    openPaymentModal();
  }
}

function openCorrectModal(reason) {
  const utrWrap = document.getElementById('correct-utr-wrap');
  const shotWrap = document.getElementById('correct-screenshot-wrap');
  const utrInput = document.getElementById('correct-utr');
  const shotInput = document.getElementById('correct-screenshot');
  if (utrInput) utrInput.value = (currentRegistration && currentRegistration.utr_number) || '';
  if (shotInput) shotInput.value = '';

  if (reason === 'WRONG_DETAILS') {
    setText('correct-title', 'Correct Payment Details');
    setText('correct-desc', 'Fix your transaction reference below. You don’t need to re-upload the screenshot unless you want to.');
    if (utrWrap) utrWrap.classList.remove('hidden');
    if (shotWrap) shotWrap.classList.add('hidden');
  } else {
    setText('correct-title', 'Re-upload Screenshot');
    setText('correct-desc', 'Upload the correct payment screenshot. Your entered details are kept.');
    if (utrWrap) utrWrap.classList.add('hidden');
    if (shotWrap) shotWrap.classList.remove('hidden');
  }
  document.getElementById('modal-correct').dataset.reason = reason;
  openModal('modal-correct');
}

async function submitCorrection(e) {
  e.preventDefault();
  const reason = document.getElementById('modal-correct').dataset.reason;
  const utr = document.getElementById('correct-utr').value.trim();
  const file = document.getElementById('correct-screenshot').files[0];
  if (reason === 'WRONG_DETAILS' && !utr) return showToast('Enter the corrected transaction reference.');
  if (reason === 'WRONG_SCREENSHOT' && !file) return showToast('Upload the corrected screenshot.');

  const btn = document.getElementById('correct-submit-btn');
  const original = btn.innerText;
  btn.innerText = 'Submitting…';
  btn.disabled = true;
  try {
    const payload = { paymentMode: 'UPI' };
    if (utr) payload.utr = utr;
    if (file) payload.screenshot = await readFileAsDataURL(file);
    const submit = async (acknowledged) => (await fetch('/api/registrations/me/correct', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, acknowledged }),
    })).json();

    let data = await submit(false);
    if (data.needsConfirmation) {
      const c = data.checks || {};
      const problems = [];
      if (!c.amount) problems.push(`• The amount ₹${inr(data.expectedAmount)} could not be found in the screenshot`);
      if (!c.vpa) problems.push('• The conference UPI ID could not be found in the screenshot');
      if (!c.utr) problems.push('• The UTR number could not be found in the screenshot');
      const proceed = await showConfirm(
        "We could not verify the following from your upload:\n\n" + problems.join('\n') +
        "\n\nSubmit anyway? It will be FLAGGED for manual scrutiny.", "Submit anyway", "Cancel & re-check");
      if (!proceed) return;
      data = await submit(true);
    }

    if (data.success) {
      showToast(data.flagged
        ? 'Correction submitted and FLAGGED for manual scrutiny.'
        : 'Correction submitted! Your registration is pending verification again.', data.flagged ? 'info' : 'success');
      closeModal('modal-correct');
      loadDashboard();
    } else {
      showToast(data.error || 'Correction failed.');
    }
  } catch (err) {
    showToast(`Correction Error: ${err.message}`);
  } finally {
    btn.innerText = original;
    btn.disabled = false;
  }
}

// Sections use a plain <textarea> (not contenteditable -- far more
// consistent across browsers) so a formatting button just splices literal
// "<b>...</b>"-style text into the value at the cursor/selection. The server
// re-escapes everything and restores only these same four tags
// (sanitizeAbstractHtml), so this is exactly the markup that survives.
const ABSTRACT_SECTION_IDS = ['abstract-background', 'abstract-aim', 'abstract-methods', 'abstract-results', 'abstract-conclusion'];
const ABSTRACT_MAX_WORDS = 400;

function wrapAbstractSelection(id, tag) {
  const el = document.getElementById(id);
  if (!el) return;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  const before = el.value.slice(0, start);
  const selected = el.value.slice(start, end);
  const after = el.value.slice(end);
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  el.value = `${before}${open}${selected}${close}${after}`;
  el.focus();
  // No selection: drop the cursor between the tags so typing continues
  // inside them. Had a selection: land after the closing tag.
  const cursor = selected ? start + open.length + selected.length + close.length : start + open.length;
  el.setSelectionRange(cursor, cursor);
  updateAbstractWordCount();
}

// Mirrors the server's plainTextWordCount() exactly -- strip tags, count
// whitespace-separated tokens -- so the live counter never disagrees with
// what actually gets enforced on submit.
function abstractWordCount(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').trim().split(/\s+/).filter(Boolean).length;
}

// Textareas grow with their content instead of scrolling inside a fixed
// box -- reset to auto first so shrinking (e.g. after deleting text) is
// picked up too, not just growth.
function autoResizeTextarea(el) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

function updateAbstractWordCount() {
  let total = 0;
  for (const id of ABSTRACT_SECTION_IDS) {
    const el = document.getElementById(id);
    const count = el ? abstractWordCount(el.value) : 0;
    total += count;
    const label = document.getElementById(`${id}-count`);
    if (label) label.textContent = `${count} word${count === 1 ? '' : 's'}`;
  }
  const counter = document.getElementById('abstract-total-wordcount');
  if (counter) {
    counter.textContent = `${total} / ${ABSTRACT_MAX_WORDS} words`;
    counter.className = total > ABSTRACT_MAX_WORDS ? 'text-xs font-bold text-rose-600' : 'text-xs font-semibold text-slate-500';
  }
  const bar = document.getElementById('abstract-wordcount-bar');
  if (bar) {
    bar.style.width = `${Math.min(100, (total / ABSTRACT_MAX_WORDS) * 100)}%`;
    bar.className = 'h-full transition-all duration-200 ' + (total > ABSTRACT_MAX_WORDS ? 'bg-rose-500' : total > ABSTRACT_MAX_WORDS * 0.85 ? 'bg-amber-500' : 'bg-emerald-500');
  }
  const submitBtn = document.getElementById('abstract-submit-btn');
  if (submitBtn) submitBtn.disabled = total > ABSTRACT_MAX_WORDS || total === 0;
  return total;
}

function toggleAbstractGuidelines() {
  const body = document.getElementById('abstract-guidelines-body');
  const chevron = document.getElementById('abstract-guidelines-chevron');
  if (!body) return;
  const collapsed = body.classList.toggle('hidden');
  if (chevron) chevron.textContent = collapsed ? '▸' : '▾';
}

// Keywords are entered one at a time (Enter to add) and rendered as pills
// rather than a single free-text field; abstractKeywords is the source of
// truth and the pills are just its rendering.
let abstractKeywords = [];

function renderAbstractKeywordPills() {
  const box = document.getElementById('abstract-keywords-pills');
  if (!box) return;
  box.innerHTML = abstractKeywords.map((kw, i) => `
    <span class="inline-flex items-center gap-1 pl-2.5 pr-1.5 py-1 bg-indigo-100 text-indigo-800 text-xs font-semibold rounded-full">
      ${esc(kw)}
      <button type="button" onclick="removeAbstractKeyword(${i})" class="text-indigo-500 hover:text-indigo-800 leading-none">✕</button>
    </span>
  `).join('');
}

function addAbstractKeywordFromInput() {
  const input = document.getElementById('abstract-keywords-input');
  if (!input) return;
  const kw = input.value.trim();
  if (!kw) return;
  if (!abstractKeywords.some((k) => k.toLowerCase() === kw.toLowerCase())) {
    abstractKeywords.push(kw);
    renderAbstractKeywordPills();
  }
  input.value = '';
}

function handleAbstractKeywordKeydown(e) {
  if (e.key !== 'Enter' && e.key !== ',') return;
  e.preventDefault();
  addAbstractKeywordFromInput();
}

function removeAbstractKeyword(index) {
  abstractKeywords.splice(index, 1);
  renderAbstractKeywordPills();
}

function resetAbstractKeywords() {
  abstractKeywords = [];
  renderAbstractKeywordPills();
  const input = document.getElementById('abstract-keywords-input');
  if (input) input.value = '';
}

// Briefly rings an input red to draw the eye to it alongside the toast,
// for validation that isn't covered by the browser's native required check
// (e.g. "at least one keyword", which has no single required field).
function flashInvalid(el) {
  if (!el) return;
  el.classList.add('ring-2', 'ring-rose-400', 'border-rose-400');
  el.focus();
  setTimeout(() => el.classList.remove('ring-2', 'ring-rose-400', 'border-rose-400'), 1500);
}

async function handleAbstractSubmit(e) {
  e.preventDefault();
  if (updateAbstractWordCount() > ABSTRACT_MAX_WORDS) return showToast(`Your abstract is over the ${ABSTRACT_MAX_WORDS}-word limit.`);
  addAbstractKeywordFromInput(); // catch a keyword left in the box, unsubmitted
  if (!abstractKeywords.length) {
    flashInvalid(document.getElementById('abstract-keywords-input'));
    return showToast('Add at least one keyword.');
  }

  const formatEl = document.querySelector('input[name="abstract-format"]:checked');
  const payload = { format: formatEl ? formatEl.value : '', title: document.getElementById('abstract-title').value, keywords: abstractKeywords.join(', ') };
  for (const id of ABSTRACT_SECTION_IDS) {
    payload[id.replace('abstract-', '')] = document.getElementById(id).value;
  }
  const authors = authorEditorValue('abstract-form-authors');
  if (authors) payload.authors = authors;

  const submitBtn = document.getElementById('abstract-submit-btn');
  const submitLabel = document.getElementById('abstract-submit-label');
  if (submitBtn) submitBtn.disabled = true;
  if (submitLabel) submitLabel.textContent = 'Submitting…';

  try {
    const res = await fetch('/api/abstracts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      showToast('Abstract submitted for review!', 'success');
      closeModal('modal-abstract');
      loadDashboard();
    } else {
      showToast(data.error || 'Submission failed.');
    }
  } catch (err) {
    showToast(`Submission error: ${err.message}`);
  } finally {
    if (submitLabel) submitLabel.textContent = 'Submit Abstract for Review';
    if (submitBtn) submitBtn.disabled = updateAbstractWordCount() > ABSTRACT_MAX_WORDS;
  }
}

function openModal(id) {
  if (id === 'modal-abstract' && !cachedAbstractSubmission.open
    && !(cachedOwnAbstract && cachedOwnAbstract.status === 'REVISION_REQUESTED')) {
    showToast('Abstract submission has closed.');
    return;
  }
  document.getElementById(id).classList.remove('hidden');
  if (id === 'modal-abstract') {
    // A delegate whose abstract was sent back for corrections
    // (REVISION_REQUESTED -- the only status that leaves the dashboard
    // button enabled here, see loadAbstractStatus) gets the form prefilled
    // with what they already submitted; anyone else gets a blank form.
    const maxAuthors = (cachedAbstractAuthorsWindow && cachedAbstractAuthorsWindow.max) || 6;
    if (cachedOwnAbstract && cachedOwnAbstract.status === 'REVISION_REQUESTED') {
      prefillAbstractFormForRevision(cachedOwnAbstract);
      setAuthorEditor('abstract-form-authors', cachedOwnAbstract.authors, { max: maxAuthors });
    } else {
      const me = (currentDelegate && (currentDelegate.full_name || currentDelegate.name)) || 'You';
      setAuthorEditor('abstract-form-authors', [{ name: me, presenting: true }], { max: maxAuthors });
      resetAbstractKeywords();
      document.getElementById('abstract-title').value = '';
      for (const id of ABSTRACT_SECTION_IDS) {
        const el = document.getElementById(id);
        if (el) { el.value = ''; autoResizeTextarea(el); }
      }
      updateAbstractWordCount();
    }
  }
}

// Prefills the abstract form's raw HTML-as-text (see the fields' own
// comment: sanitizeAbstractHtml's output is exactly what these plain
// <textarea>s already hold, so no conversion is needed) for a delegate
// editing after REVISION_REQUESTED.
function prefillAbstractFormForRevision(abs) {
  document.getElementById('abstract-title').value = abs.title || '';
  const formatInput = document.querySelector(`input[name="abstract-format"][value="${CSS.escape(abs.format || '')}"]`);
  if (formatInput) formatInput.checked = true;
  for (const id of ABSTRACT_SECTION_IDS) {
    const el = document.getElementById(id);
    const key = id.replace('abstract-', ''); // background, aim, methods, results, conclusion
    if (el) { el.value = abs[key] || ''; autoResizeTextarea(el); }
  }
  abstractKeywords = (abs.keywords || '').split(',').map((k) => k.trim()).filter(Boolean);
  renderAbstractKeywordPills();
  const kwInput = document.getElementById('abstract-keywords-input');
  if (kwInput) kwInput.value = '';
  updateAbstractWordCount();
}
function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
  deskRefreshAfter(id);
}

// The Front Desk opens other screens' editors for the person on it; when one
// closes, the desk record is read again so it shows what was just changed.
const DESK_EDITORS = new Set(['modal-review', 'modal-guest-edit', 'modal-abstract-review', 'user-detail']);
function deskRefreshAfter(id) {
  if (DESK_EDITORS.has(id) && typeof currentBackendTab !== 'undefined' && currentBackendTab === 'desk' && deskDelegate) deskReload();
}

// In-page confirmation dialog. Native confirm() is unreliable — browsers
// suppress repeated dialogs and then it silently returns false — so the
// admin panel uses this modal instead. Resolves true/false.
function showConfirm(message, okText = 'Confirm', cancelText = 'Cancel') {
  return new Promise((resolve) => {
    const modal = document.getElementById('modal-confirm');
    if (!modal) return resolve(window.confirm(message)); // fallback
    document.getElementById('confirm-message').textContent = message;
    const input = document.getElementById('confirm-input');
    if (input) input.classList.add('hidden');
    const ok = document.getElementById('confirm-ok');
    const cancel = document.getElementById('confirm-cancel');
    ok.textContent = okText;
    cancel.textContent = cancelText;
    const done = (val) => {
      modal.classList.add('hidden');
      ok.onclick = null;
      cancel.onclick = null;
      resolve(val);
    };
    ok.onclick = () => done(true);
    cancel.onclick = () => done(false);
    modal.classList.remove('hidden');
  });
}

// Ask for a short answer (a reason) in the same modal. Resolves to the
// trimmed text, or null if cancelled or left empty.
function showPrompt(message, placeholder = '', value = '') {
  return new Promise((resolve) => {
    const modal = document.getElementById('modal-confirm');
    const input = document.getElementById('confirm-input');
    if (!modal || !input) { const v = window.prompt(message); return resolve(v && v.trim() ? v.trim() : null); }
    document.getElementById('confirm-message').textContent = message;
    input.value = value;
    input.placeholder = placeholder;
    input.classList.remove('hidden');
    const ok = document.getElementById('confirm-ok');
    const cancel = document.getElementById('confirm-cancel');
    ok.textContent = 'Save';
    cancel.textContent = 'Cancel';
    const done = (val) => {
      modal.classList.add('hidden');
      input.classList.add('hidden');
      ok.onclick = null;
      cancel.onclick = null;
      resolve(val);
    };
    ok.onclick = () => done(input.value.trim() || null);
    cancel.onclick = () => done(null);
    modal.classList.remove('hidden');
    input.focus();
  });
}

// Show a payment screenshot in a modal rather than navigating away.
function openScreenshot(id) {
  const title = document.getElementById('screenshot-modal-title');
  if (title) title.textContent = 'Payment Screenshot';
  const img = document.getElementById('screenshot-modal-img');
  if (img) img.src = `/api/registrations/${encodeURIComponent(id)}/screenshot`;
  openModal('modal-screenshot');
}

// Show a student ID card in the same image modal.
function openIdCard(id) {
  const title = document.getElementById('screenshot-modal-title');
  if (title) title.textContent = 'Student ID Card';
  const img = document.getElementById('screenshot-modal-img');
  if (img) img.src = `/api/registrations/${encodeURIComponent(id)}/id-card`;
  openModal('modal-screenshot');
}

// --- REJECT WITH REASON (admin) ---
let rejectTargetId = null;
function openRejectModal(id) {
  rejectTargetId = id;
  const sel = document.getElementById('reject-reason');
  const note = document.getElementById('reject-note');
  if (sel) sel.value = 'WRONG_DETAILS';
  if (note) note.value = '';
  toggleRejectNote();
  openModal('modal-reject');
}
// "Other" reveals the free-text note field.
function toggleRejectNote() {
  const sel = document.getElementById('reject-reason');
  const noteWrap = document.getElementById('reject-note-wrap');
  if (sel && noteWrap) noteWrap.classList.toggle('hidden', sel.value !== 'OTHER');
}
async function submitReject() {
  const reason = document.getElementById('reject-reason').value;
  const note = document.getElementById('reject-note').value.trim();
  if (reason === 'OTHER' && !note) return showToast('Please describe the reason.');
  const data = await (await fetch(`/api/registrations/${encodeURIComponent(rejectTargetId)}/status`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bankStatus: 'REJECTED', rejectionReason: reason, rejectionNote: note })
  })).json();
  if (!data.success) return showToast(data.error || 'Rejection failed.');
  closeModal('modal-reject');
  closeModal('modal-review');
  renderBackendPayments();
}

// The phone number to SHOW for an account. phone_number is the account key,
// which holds a real number for every phone-based signup but a synthetic one
// for email-only accounts -- mirrors displayPhone() in server.js.
function delegateDisplayPhone(u) {
  if (!u) return '';
  // Returns the full E.164 form INCLUDING the country code -- callers must
  // not prefix "+91" themselves.
  if (u.phone) { const e = toE164(u.phone); if (e) return e; }
  return isPhoneValue(u.phone_number || '') ? toE164(u.phone_number) : '';
}

// Run after every successful login. Two things can be outstanding for an
// account that predates password/email verification, and they're asked in a
// fixed order so only one modal is ever open: set a password first (it's
// mandatory and unblocks logging in at all next time), then verify email.
function runPostLoginPrompts() {
  if (!currentDelegate || currentDelegate.role !== 'DELEGATE') return;
  // Two ways to owe a password, and they need different words. An account
  // that never had one is being asked to add it; an account whose password a
  // member of staff just replaced with a one-time value is being told to
  // replace it back, and should be told that is what happened rather than
  // left wondering why the prompt appeared.
  if (currentDelegate.password_reset_required) return openSetPasswordModal(true, 'reset');
  if (!currentDelegate.hasPassword) return openSetPasswordModal(true);
  promptVerifyEmailIfNeeded();
}

// Existing accounts had their email typed in at signup but never proven, so
// it starts unverified (see the identity backfill in server.js) -- this is
// what asks them to prove it. Skippable, unlike the password prompt: an
// account with a verified phone can still log in without it.
function promptVerifyEmailIfNeeded() {
  if (!currentDelegate || currentDelegate.role !== 'DELEGATE') return;
  if (currentDelegate.email_verified) return;
  if (storageGet('session', 'verifyEmailPromptDismissed')) return;
  openVerifyEmailModal();
}

// Shared by the delegate dashboard and the admin panel -- both include the
// same modal (see views/portal/modals/set-password.ejs) and call the same
// endpoint, since a password is just an alternative login method available
// to every account type.
// mandatory: the post-login prompt for an account that has no password yet
// -- the close button and Esc/backdrop dismissal are removed, since the
// requirement is that they end up with one. The dashboard's 🔑 button opens
// the same modal voluntarily, where dismissing is fine.
function openSetPasswordModal(mandatory, reason) {
  const closeBtn = document.getElementById('set-password-close-btn');
  if (closeBtn) closeBtn.classList.toggle('hidden', !!mandatory);
  setText('set-password-title', reason === 'reset' ? 'Choose a new password'
    : mandatory ? 'Set a password to continue' : 'Set Password');
  setText('set-password-blurb', reason === 'reset'
    ? 'Your password was reset by the conference desk, and the one you were given is temporary. Choose your own now \u2014 the temporary one stops working once you do.'
    : mandatory
      ? 'Your account doesn\u2019t have a password yet. Set one now \u2014 it lets you sign in without waiting for an OTP.'
      : 'Lets you log in with a password instead of waiting for an OTP each time. OTP still always works as a fallback. Applies immediately.');
  openModal('modal-set-password');
}

async function submitSetPassword(e) {
  e.preventDefault();
  const password = document.getElementById('set-password-value').value;
  if (password.length < 8) return showToast('Password must be at least 8 characters.');
  const btn = document.getElementById('set-password-submit-btn');
  btn.disabled = true;
  try {
    const data = await (await fetch('/api/auth/set-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
    })).json();
    if (!data.success) return showToast(data.error || 'Could not save.');
    showToast('Password saved.', 'success');
    document.getElementById('set-password-value').value = '';
    if (currentDelegate) {
      currentDelegate.hasPassword = true;
      // Choosing their own is what satisfies a reset, so the prompt must not
      // come back on the next render.
      currentDelegate.password_reset_required = 0;
      persistDelegate(currentDelegate);
    }
    closeModal('modal-set-password');
    // Password was the first of the two post-login prompts; email
    // verification is the second, so hand straight over rather than waiting
    // for the next login to ask.
    promptVerifyEmailIfNeeded();
  } finally {
    btn.disabled = false;
  }
}

// --- VERIFY EMAIL -------------------------------------------------------
// Always-visible route to verification, unlike the post-login modal, which
// is skippable and only fires once per session. Without it there'd be no
// way back to the modal after skipping, and no way at all for a delegate
// whose session predates the prompt.
function renderVerifyEmailBanner() {
  const banner = document.getElementById('verify-email-banner');
  const me = signedInAccount();
  if (!banner || !me) return;
  const verified = !!me.email_verified;
  banner.classList.toggle('hidden', verified);
  if (verified) return;
  const hasEmail = !!me.email;
  setText('verify-email-banner-title', hasEmail ? 'Email not verified' : 'No email address on file');
  setText('verify-email-banner-msg', hasEmail
    ? `We haven\u2019t confirmed ${me.email} belongs to you. Verify it to receive your receipt and conference updates \u2014 and to sign in with it as well as your mobile.`
    : 'Add an email address so we can send your receipt and conference updates.');
}

// Whichever portal we're in: the delegate dashboard tracks currentDelegate,
// the admin panel activeAdminUser. Both are the signed-in account.
function signedInAccount() {
  return currentDelegate || activeAdminUser || null;
}

function openVerifyEmailModal() {
  const me = signedInAccount();
  const hasEmail = !!(me && me.email);
  setText('verify-email-title', hasEmail ? 'Verify your email' : 'Add your email address');
  setText('verify-email-blurb', hasEmail
    ? 'We\u2019ll send a 6-digit code to your email address. Once verified you can sign in with it as well as your mobile number.'
    : 'Add an email address and we\u2019ll send a 6-digit code to confirm it. You can then sign in with it as well as your mobile number.');
  const input = document.getElementById('verify-email-value');
  if (input) input.value = (me && me.email) || '';
  unlockVerifyEmailAddress();
  openModal('modal-verify-email');
}

// Skipping is remembered for the session only, so it asks again next login
// -- persistent enough not to nag, temporary enough to keep asking until
// the address is actually proven.
function dismissVerifyEmail() {
  storageSet('session', 'verifyEmailPromptDismissed', '1');
  closeModal('modal-verify-email');
}

// Back to "no code outstanding": address editable, OTP box hidden and
// cleared. Clearing the code matters -- leaving a code from the previous
// address in the box next to a newly-typed one is exactly the ambiguity the
// lock exists to prevent.
function unlockVerifyEmailAddress() {
  const input = document.getElementById('verify-email-value');
  if (input) input.disabled = false;
  const sendBtn = document.getElementById('verify-email-send-btn');
  if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send Code'; }
  const wrap = document.getElementById('verify-email-otp-wrap');
  if (wrap) wrap.classList.add('hidden');
  const otp = document.getElementById('verify-email-otp');
  if (otp) otp.value = '';
  const changeBtn = document.getElementById('verify-email-change-btn');
  if (changeBtn) changeBtn.classList.add('hidden');
  const hint = document.getElementById('verify-email-change-hint');
  if (hint) hint.classList.remove('hidden');
  setText('verify-email-hint', '');
}

async function requestVerifyEmailOTP() {
  const value = document.getElementById('verify-email-value').value.trim();
  if (!EMAIL_RE.test(value)) return showToast('Please enter a valid email address.');
  const btn = document.getElementById('verify-email-send-btn');
  btn.disabled = true;
  try {
    const data = await (await fetch('/api/auth/verify-contact/request', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'email', value }),
    })).json();
    if (!data.success) return showToast(data.error || 'Could not send the code.');
    // Freeze the address now a code is out against it, so what gets
    // confirmed is unambiguously what was sent to. (The server would refuse
    // a mismatch anyway -- codes are keyed by destination -- but as a
    // confusing "Incorrect OTP" rather than anything explicable.)
    const input = document.getElementById('verify-email-value');
    if (input) input.disabled = true;
    btn.textContent = 'Code Sent';
    const changeBtn = document.getElementById('verify-email-change-btn');
    if (changeBtn) changeBtn.classList.remove('hidden');
    const hint = document.getElementById('verify-email-change-hint');
    if (hint) hint.classList.add('hidden');
    document.getElementById('verify-email-otp-wrap').classList.remove('hidden');
    if (data.devOtp) {
      setText('verify-email-hint', `Demo code: ${data.devOtp}`);
      showToast(`Your code is: ${data.devOtp}`, 'info');
    } else {
      setText('verify-email-hint', 'Sent — check your inbox');
      showToast(`A 6-digit code has been sent to ${value}.`, 'info');
    }
  } finally {
    // Left disabled on success: a code is outstanding and the address is
    // frozen, so there is nothing to re-send until they unlock. Re-enabled
    // on failure so they can retry.
    btn.disabled = !document.getElementById('verify-email-value').disabled;
  }
}

async function submitVerifyEmail(e) {
  e.preventDefault();
  // Reads fine even while disabled -- .value is unaffected, only submission
  // via native form encoding would be, and this posts JSON explicitly.
  const value = document.getElementById('verify-email-value').value.trim();
  const otp = document.getElementById('verify-email-otp').value.trim();
  if (!otp) return showToast('Enter the 6-digit code we sent you.');
  const btn = document.getElementById('verify-email-submit-btn');
  btn.disabled = true;
  try {
    const data = await (await fetch('/api/auth/verify-contact/confirm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'email', value, otp }),
    })).json();
    if (!data.success) return showToast(data.error || 'Could not verify that code.');
    // Update whichever portal's copy of the account is in play.
    if (currentDelegate) { currentDelegate = data.user; persistDelegate(currentDelegate); }
    if (activeAdminUser) activeAdminUser = data.user;
    showToast(data.repriced
      ? `Email verified. ${data.repriced.code} now applies: your fee is ₹${inr(data.repriced.to)} (was ₹${inr(data.repriced.from)}).`
      : 'Email verified.', 'success');
    closeModal('modal-verify-email');
    renderVerifyEmailBanner();
    // The fee shown on the dashboard changed.
    if (data.repriced && currentDelegate) loadDashboard();
  } finally {
    btn.disabled = false;
  }
}

async function logout() {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
  currentDelegate = null;
  storageRemove('local', 'nqocn_current_user');
  // Full navigation so this works from both the delegate portal and /admin.
  // /portal: on the conference's own address '/' is the website.
  window.location.href = '/portal';
}

// Restore an active server session on page load. The session cookie is the
// source of truth; localStorage only caches display fields.
// True when maintenance mode is on AND this visitor isn't a super admin, i.e.
// the maintenance screen should replace whatever they'd normally see. Super
// admins pass straight through so they can actually do the maintenance.
// Fails open on a network error: the server-side gate is the real control, so
// a failed check here can only ever show a portal whose APIs still 503.
async function shouldShowMaintenance(user) {
  try {
    const res = await fetch('/api/maintenance');
    if (!res.ok) return false;
    const m = await res.json();
    if (!m.enabled) return false;
    if (user && user.role === 'SUPER_ADMIN') return false;
    setText('maintenance-page-message', m.message || '');
    return true;
  } catch (e) {
    return false;
  }
}

async function restoreSession() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) {
      // The optimistic cached-dashboard shell above may already be showing
      // -- a stale/expired session must revert it back to the login page,
      // not just clear storage and leave the dashboard on screen.
      currentDelegate = null;
      persistDelegate(null);
      if (document.getElementById('dashboard-page')) {
        navigateTo(await shouldShowMaintenance(null) ? 'maintenance-page' : 'auth-page');
      }
      return;
    }
    const data = await res.json();
    if (data.success && data.user) {
      currentDelegate = data.user;
      persistDelegate(currentDelegate);
      if (await shouldShowMaintenance(data.user)) return navigateTo('maintenance-page');
      loadDashboard();
    } else {
      currentDelegate = null;
      persistDelegate(null);
      if (document.getElementById('dashboard-page')) {
        navigateTo(await shouldShowMaintenance(null) ? 'maintenance-page' : 'auth-page');
      }
    }
  } catch (e) {
    /* offline — keep showing whatever's already on screen (cached dashboard or login) */
  }
}

// Fills the signup form's Designation and Institute dropdowns from what is
// already on file, so a delegate picks an existing spelling rather than
// typing a near-duplicate of it.
//
// These were free-text inputs with a <datalist>, which suggests but never
// obliges -- and the result was 19 spellings of one institution, 41% of the
// conference between them. A list you choose from is what stops that; the
// "Other" option keeps anyone genuinely new from being locked out.
//
// The <select> and the "Other" box are presentation. The value everything
// downstream reads (handleRegister, validateSignupStep) still comes from the
// hidden #reg-designation / #reg-institute, so nothing else had to change.
const DIRECTORY_FIELDS = {
  designation: { key: 'designations', placeholder: 'Select your designation…' },
  institute: { key: 'institutions', placeholder: 'Select your institute…' },
};

// Keeps the hidden field in step with whichever control is in play.
//
// `prefix` exists so the front desk's edit form can reuse this untouched.
// The signup form's controls are reg-designation-select and friends; the
// desk's are desk-edit-designation-select. Same three-control dance either
// way, and only one implementation of it.
function onDirectorySelect(which, prefix = 'reg') {
  const sel = document.getElementById(`${prefix}-${which}-select`);
  const other = document.getElementById(`${prefix}-${which}-other`);
  const hidden = document.getElementById(`${prefix}-${which}`);
  if (!sel || !other || !hidden) return;
  const isOther = sel.value === '__other__';
  other.classList.toggle('hidden', !isOther);
  if (isOther) {
    hidden.value = other.value.trim();
    other.focus();
  } else {
    hidden.value = sel.value;
    other.value = '';
  }
}

async function loadDirectorySuggestions(prefix = 'reg') {
  // Belt and braces for the listener above: anything that is not an id prefix
  // (an Event, most likely) means the signup form.
  if (typeof prefix !== 'string' || !prefix) prefix = 'reg';
  const anySelect = document.getElementById(`${prefix}-designation-select`)
    || document.getElementById(`${prefix}-institute-select`);
  if (!anySelect) return;   // this form is not on the page
  let data = {};
  try {
    const res = await fetch('/api/directory/suggestions');
    if (res.ok) data = await res.json();
  } catch (e) {
    /* offline -- the lists stay empty, and "Other" still lets anyone finish */
  }
  for (const [which, cfg] of Object.entries(DIRECTORY_FIELDS)) {
    const sel = document.getElementById(`${prefix}-${which}-select`);
    if (!sel) continue;
    const values = data[cfg.key] || [];
    // "Other" stays last: it is the escape hatch, not a first suggestion.
    sel.innerHTML = `<option value="">${esc(cfg.placeholder)}</option>`
      + values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('')
      + '<option value="__other__">Other — type it in</option>';
    // With nothing on file yet (a fresh conference), a dropdown of one
    // option is a dead end -- open straight into the text box instead.
    if (!values.length) {
      sel.value = '__other__';
      onDirectorySelect(which, prefix);
    }
  }
  ['designation', 'institute'].forEach((which) => {
    const other = document.getElementById(`${prefix}-${which}-other`);
    if (other) other.addEventListener('input', () => onDirectorySelect(which, prefix));
  });
}
// Wrapped, not passed by reference. A listener is called with the Event as
// its first argument, and loadDirectorySuggestions takes an id prefix there:
// a default parameter only applies when the argument is undefined, so passing
// the function directly made prefix the Event, the lookup search for
// "[object Event]-designation-select", and the guard below return silently --
// leaving signup's dropdowns empty and its Other box unwired. That shipped.
document.addEventListener('DOMContentLoaded', () => loadDirectorySuggestions());
// Public (no login required) -- runs on both the delegate landing page and
// the admin panel, so conference name/dates/location/acronym shown as static
// page text everywhere reflect the current Settings → General value.
document.addEventListener('DOMContentLoaded', loadConferenceInfo);

// --- ADMIN & BACKEND LOGIC ---

// Same stroke-icon language as the rest of the admin panel (2px stroke,
// round caps/joins, currentColor) -- these are the ones needed inline inside
// dense render-function output (review-modal marks, table cells, small
// status lines), so they default to a smaller size than the EJS-authored
// ones. `ICON(name, cls)` lets a call site size/space one individually.
const ADMIN_ICON_SVG = {
  check: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5 L11 15.5 L16 9"/>',
  cross: '<circle cx="12" cy="12" r="9"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/>',
  warning: '<path d="M12 3 L22 20 L2 20 Z"/><line x1="12" y1="9" x2="12" y2="14"/><circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none"/>',
  coin: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10"/><path d="M9 9.7c0-1.1 1.2-1.7 3-1.7s3 .8 3 1.9-1.2 1.6-3 1.6-3 .6-3 1.8 1.2 1.9 3 1.9 3-.6 3-1.6"/>',
  link: '<path d="M8 12l-2.5 2.5a3.5 3.5 0 0 0 5 5L13 17"/><path d="M16 12l2.5-2.5a3.5 3.5 0 0 0-5-5L11 7"/><path d="M9 15l6-6"/>',
  gradcap: '<path d="M12 4L2 9l10 5 10-5-10-5z"/><path d="M6 12v5c0 1.5 3 3 6 3s6-1.5 6-3v-5"/>',
  document: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="15" y2="16"/>',
  refresh: '<path d="M4 12a8 8 0 0 1 14-5.3"/><path d="M20 12a8 8 0 0 1-14 5.3"/><path d="M17 4v4h-4"/><path d="M7 20v-4h4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><line x1="3" y1="12" x2="21" y2="12"/>',
  idbadge: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M6 16c0-1.7 1.3-3 3-3s3 1.3 3 3"/><line x1="14" y1="9" x2="18" y2="9"/><line x1="14" y1="13" x2="18" y2="13"/>',
  search: '<circle cx="10" cy="10" r="7"/><line x1="15.5" y1="15.5" x2="21" y2="21"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  envelope: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M3 6.5 L12 13 L21 6.5"/>',
  send: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7 L12 12 L16 14"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="3" x2="8" y2="7"/><line x1="16" y1="3" x2="16" y2="7"/>',
  mappin: '<path d="M12 21s-7-6.5-7-11a7 7 0 0 1 14 0c0 4.5-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  close: '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>',
  circle: '<circle cx="12" cy="12" r="9"/>',
};
function ICON(name, cls) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${cls || 'w-3.5 h-3.5 inline align-[-2px] mr-1'}">${ADMIN_ICON_SVG[name]}</svg>`;
}

// Escape untrusted values before putting them in HTML. Delegate-supplied
// fields (name, UTR, institution, ...) reach the admin's browser, so every
// interpolation below must pass through this.
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Format a rupee amount with Indian digit grouping (e.g. 100000 -> 1,00,000):
// last three digits grouped, then every two digits. Done manually rather than
// via toLocaleString('en-IN') because that falls back to Western grouping on
// runtimes without full ICU (e.g. the Node the backend runs on). Forgiving:
// accepts numbers or numeric strings, returns the input if not a finite number.
function inr(v) {
  const num = typeof v === 'number' ? v : Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
  if (!isFinite(num)) return v == null ? '' : String(v);
  const neg = num < 0;
  const s = String(Math.round(Math.abs(num)));
  let out;
  if (s.length <= 3) out = s;
  else out = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + s.slice(-3);
  return (neg ? '-' : '') + out;
}

// Inline onclick/onchange can be broken out of by a value containing a quote,
// so the dynamic controls use data-* attributes plus these delegated
// listeners, attached once.
let adminDelegationReady = false;
function setupAdminDelegation() {
  if (adminDelegationReady) return;
  adminDelegationReady = true;

  const paymentClickHandler = (e) => {
    const review = e.target.closest('.review-btn');
    if (review) return openReviewModal(review.dataset.id);
    const view = e.target.closest('.view-image-btn');
    if (view) return openScreenshot(view.dataset.id);
    const viewId = e.target.closest('.view-id-btn');
    if (viewId) return openIdCard(viewId.dataset.id);
  };
  ['payment-table-body', 'rejected-table-body', 'verified-table-body', 'balance-table-body'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', paymentClickHandler);
  });

  const userBody = document.getElementById('user-table-body');
  if (userBody) {
    userBody.addEventListener('change', (e) => {
      const sel = e.target.closest('.role-select');
      if (sel) return updateRole(sel.dataset.phone, sel.value);
    });
  }

  // Abstract Approval and Assignment are two separate containers/steps; both
  // use the same delegated actions.
  ['abstracts-approval-container', 'abstracts-assignment-container'].forEach((id) => {
    const box = document.getElementById(id);
    if (!box) return;
    box.addEventListener('click', (e) => {
      const btn = e.target.closest('.abstract-status-btn');
      if (btn) return updateAbstractStatus(btn.dataset.id, btn.dataset.status);
      const alloc = e.target.closest('.abstract-alloc-btn');
      if (alloc) return updateAbstractAllocation(alloc.dataset.id, alloc.dataset.alloc);
    });
  });

  // Approve/Reject/Reset inside the abstract review modal -- id comes from
  // the container's data-id (set by openAbstractReview), not the button itself.
  const abstractReviewActions = document.getElementById('abstract-review-modal-actions');
  if (abstractReviewActions) {
    abstractReviewActions.addEventListener('click', (e) => {
      const btn = e.target.closest('.abstract-status-btn');
      if (!btn) return;
      updateAbstractStatus(abstractReviewActions.dataset.id, btn.dataset.status);
      closeModal('modal-abstract-review');
    });
  }

  // Every group's option rows, plus the group-level controls, live in one
  // dynamically-rendered container -- see renderBackendPrograms().
  const programsBox = document.getElementById('program-groups-admin-container');
  if (programsBox) {
    programsBox.addEventListener('change', async (e) => {
      const box = e.target.closest('.group-attendance, .group-invite');
      if (!box) return;
      const body = box.classList.contains('group-invite') ? { inviteOnly: box.checked } : { takesAttendance: box.checked };
      const data = await (await fetch(`/api/admin/program-groups/${encodeURIComponent(box.dataset.id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })).json();
      if (!data.success) showToast(data.error || 'Could not change it.');
      renderBackendPrograms();
    });
    programsBox.addEventListener('click', (e) => {
      const save = e.target.closest('.prog-save');
      if (save) {
        const capInput = programsBox.querySelector(`.prog-capacity[data-id="${save.dataset.id}"]`);
        const feeInput = programsBox.querySelector(`.prog-fee[data-id="${save.dataset.id}"]`);
        const nameInput = programsBox.querySelector(`.prog-name[data-id="${save.dataset.id}"]`);
        return saveProgramOption(save.dataset.id, parseInt(capInput.value, 10), parseFloat(feeInput.value) || 0, nameInput ? nameInput.value : undefined);
      }
      const toggle = e.target.closest('.prog-toggle');
      if (toggle) return toggleProgram(toggle.dataset.id, toggle.dataset.active === '1' ? 0 : 1);
      const del = e.target.closest('.prog-delete');
      if (del) return deleteProgram(del.dataset.id);
      const roster = e.target.closest('.prog-roster');
      if (roster) return openRosterModal(roster.dataset.id, roster.dataset.name);
      const groupToggle = e.target.closest('.group-toggle');
      if (groupToggle) return toggleProgramGroup(groupToggle.dataset.id, groupToggle.dataset.active === '1' ? 0 : 1);
      const groupDelete = e.target.closest('.group-delete');
      if (groupDelete) return deleteProgramGroup(groupDelete.dataset.id);
    });
    programsBox.addEventListener('submit', (e) => {
      const form = e.target.closest('.add-option-form');
      if (form) return handleAddProgramOption(e, form);
    });
  }

  const rosterList = document.getElementById('roster-list');
  if (rosterList) {
    rosterList.addEventListener('click', (e) => {
      const del = e.target.closest('.roster-remove');
      if (del) return handleRosterRemove(del.dataset.phone);
    });
    rosterList.addEventListener('change', (e) => {
      const toggle = e.target.closest('.roster-faculty-toggle');
      if (toggle) return toggleRosterFaculty(toggle.dataset.phone, toggle.checked);
    });
  }

  const rosterSearch = document.getElementById('roster-search');
  if (rosterSearch) {
    rosterSearch.addEventListener('input', (e) => handleRosterSearch(e.target.value));
  }
  const rosterResults = document.getElementById('roster-search-results');
  if (rosterResults) {
    rosterResults.addEventListener('click', (e) => {
      const pick = e.target.closest('.roster-search-pick');
      if (pick) return handleRosterEnroll(pick.dataset.phone);
    });
  }

  const feeBody = document.getElementById('fee-table-body');
  if (feeBody) {
    // One action on the row now; everything else moved into the modal.
    feeBody.addEventListener('click', (e) => {
      const edit = e.target.closest('.fee-edit');
      if (edit) return openFeeCategoryModal(edit.dataset.id);
    });
  }
  const fcSave = document.getElementById('fc-save-btn');
  if (fcSave) fcSave.addEventListener('click', saveFeeCategoryModal);
  const fcDelete = document.getElementById('fc-delete-btn');
  if (fcDelete) fcDelete.addEventListener('click', () => deleteFeeCategory(editingFeeCategoryId));
  const fcRealign = document.getElementById('fc-realign-btn');
  if (fcRealign) fcRealign.addEventListener('click', () => realignFeeCategory(editingFeeCategoryId));
}

// Set the text of an element if it exists.
function setText(id, value) {
  const el = document.getElementById(id);
  if (el) { el.textContent = value; clearSkeleton(el); }
}

// --- Loading skeletons ---------------------------------------------------
// Elements that ship a placeholder in the markup wear .skeleton (see
// styles.css): the text keeps its size but is transparent under a shimmer,
// so the layout never moves when the real value lands. Going through
// setText means most values stop shimmering on their own.
function clearSkeleton(el) {
  if (el && el.classList) el.classList.remove('skeleton');
}

// The safety valve. A skeleton means "not known yet", so it has to end even
// when the answer never comes -- a failed fetch, a field the response had
// nothing for, a delegate whose registration simply has no number. Without
// this an unlucky request leaves part of the page shimmering forever, which
// reads as broken in a way the old stale placeholder did not.
function settleSkeletons(root) {
  (root || document).querySelectorAll('.skeleton').forEach((el) => el.classList.remove('skeleton'));
}

// Today's calendar date in IST as YYYY-MM-DD, matching the server's
// istDateString(). Used for the min/max on date inputs: every cutoff in this
// app is an Indian calendar date, and an admin opening the page at 00:30 IST
// would otherwise be offered yesterday as the earliest allowed date, because
// toISOString() reports UTC no matter where the browser is. India has no DST,
// so the fixed +5:30 offset is exact.
function istDateString(when = Date.now()) {
  return new Date(Number(when) + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Sibling of setText for the few places that need markup rather than text.
// Callers own escaping: pass only markup you built yourself, with esc()
// around anything that came from the database.
function setHTML(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

// One line of the screenshot OCR check result: 1 = match, 0 = mismatch,
// null/undefined = not checked (legacy rows).
// Rendered as a small chip rather than a plain colored line, so a row of
// checks reads at a glance (used both in the compact table cell and the
// larger review modal).
// The verdict of one automated screenshot check, rendered as a mark that
// sits in front of the field it judges (Amount, Transaction ID, Mode) rather
// than as a free-floating pill the reviewer has to match back to a value.
// A null check never ran, which is not the same as failing, so it gets a
// muted dash instead of a cross. Colour alone doesn't carry it -- the glyph
// differs too, so it survives being read on a bad monitor or by someone
// colour-blind.
function reviewCheckMark(val, what) {
  if (val == null) {
    return `<span class="text-slate-300 font-bold" title="${esc(what)} was not checked automatically">–</span>`;
  }
  return Number(val) === 1
    ? `<span class="text-emerald-600 font-bold" title="${esc(what)} matches the payment screenshot">${ICON('check')}</span>`
    : `<span class="text-rose-600 font-bold" title="${esc(what)} does not match the payment screenshot">${ICON('cross')}</span>`;
}

// The amount has a third outcome the other checks don't: the slip may simply
// be unreadable. Most payment apps render the amount as large light text on a
// dark background, which OCR erases while still reading the smaller body
// text, so on about a fifth of slips there is nothing to compare. That is not
// a discrepancy, and showing it as a red cross had admins chasing amounts
// that were correct all along.
function reviewAmountMark(status, legacyVal) {
  if (status === 'unreadable') {
    return '<span class="text-amber-500 font-bold" title="The amount could not be read from this screenshot — nothing to compare, not a discrepancy. Check it against the slip yourself.">?</span>';
  }
  if (status === 'match') {
    return '<span class="text-emerald-600 font-bold" title="The amount on the screenshot matches the fee">' + ICON('check') + '</span>';
  }
  if (status === 'mismatch') {
    return '<span class="text-rose-600 font-bold" title="The screenshot shows an amount, and it is not the one expected">' + ICON('cross') + '</span>';
  }
  // Checked before the three-state result existed: fall back to the old flag.
  return reviewCheckMark(legacyVal, 'The amount');
}

// Format an epoch-ms audit timestamp for display; '' when absent.
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "4 Sep 2026, 2:20 pm" -- when the delegate submitted their registration,
// which is not when they signed up (users.created_at). Built by hand rather
// than through toLocaleString: this file runs in a browser with full ICU but
// its tests run in Node without it, and the same call returns a different
// string in each -- the reason inr() formats Indian digit grouping manually
// too. A test that passes on a format the user never sees is worse than none.
function fmtRegisteredAt(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms));
  if (isNaN(d.getTime())) return '';
  const h24 = d.getHours();
  const h12 = h24 % 12 || 12;
  const mins = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}, ${h12}:${mins} ${h24 < 12 ? 'am' : 'pm'}`;
}

function fmtAuditTime(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms));
  return isNaN(d) ? '' : d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

// What this session may do, as resolved by the server (see /api/auth/me) --
// not re-derived from the role name. That re-derivation used to live here as
// four booleans (isSuper/isFinance/isReviewer/isOperations) and had already
// drifted from what the server actually enforced: the Settings menu offered
// Reminders to a Finance Admin whose every send button answered 403. Now the
// server is asked once at login, and everything downstream reads its answer.
let myPermissions = new Set();
let mySections = {};

// May this session do this? `permission` is a catalogue key, e.g.
// 'payments.decide' -- see permissions.js on the server, which is the only
// place these strings are defined.
function can(permission) {
  return myPermissions.has(permission);
}

// May this session open this screen? `section` is a views/admin/sections
// filename with no extension, e.g. 'payments'.
function canSee(section) {
  return !!mySections[section];
}

// Show only the nav tabs, menu items and report cards this session's
// permissions actually allow. Reads myPermissions/mySections, populated from
// /api/auth/me before this is called -- see initBackendPortal.
function applyRoleVisibility() {
  const tabPayments = document.getElementById('nav-tab-payments');
  const tabAbstracts = document.getElementById('nav-tab-abstracts');
  const tabReports = document.getElementById('nav-tab-reports');
  const tabDesk = document.getElementById('nav-tab-desk');
  if (tabDesk) tabDesk.classList.toggle('hidden', !canSee('desk'));
  // One Registration tab holds both the approval worklist and the bank
  // statement; it opens for a role that sees either.
  if (tabPayments) tabPayments.classList.toggle('hidden', !(canSee('payments') || canSee('statement')));
  const regPay = document.getElementById('reg-subtab-payments');
  const regStatement = document.getElementById('reg-subtab-statement');
  if (regPay) regPay.classList.toggle('hidden', !canSee('payments'));
  if (regStatement) regStatement.classList.toggle('hidden', !canSee('statement'));
  if (tabAbstracts) tabAbstracts.classList.toggle('hidden', !canSee('abstracts'));
  if (tabReports) tabReports.classList.toggle('hidden', !canSee('reports'));
  const tabFaculty = document.getElementById('nav-tab-faculty');
  if (tabFaculty) tabFaculty.classList.toggle('hidden', !canSee('faculty'));

  // The walk-in registration button now lives on the Front Desk tab
  // (#desk-register-btn, toggled in initFrontDesk) rather than in the
  // Payments header, so it is reachable by a role that holds
  // payments.desk_register without payments.view.

  // Step 2 of the Abstracts tab. Assignment is its own permission, so a
  // reviewer who may accept and reject but not decide oral vs poster does
  // not get a section full of buttons the server would refuse -- which is
  // what happened before this, silently, since the allocation call never
  // read its response.
  const assignBlock = document.getElementById('abstracts-assignment-block');
  if (assignBlock) assignBlock.classList.toggle('hidden', !can('abstracts.assign'));

  // Masters/Users/Reminders/Logs live in the header's menu, not the main
  // tab bar, above Log out. Each item toggles on the same section key that governs its
  // own tab, from the same source that gated it above -- no separate list of
  // roles kept in step by hand.
  const settingsMenuBtn = document.getElementById('settings-menu-btn');
  const settingsItems = ['attendance', 'programme', 'programs', 'fees', 'general', 'discount', 'activity', 'reminders', 'groupdiscount', 'roles'];
  settingsItems.forEach((key) => {
    const el = document.getElementById(`settings-item-${key}`);
    if (el) el.classList.toggle('hidden', !canSee(key));
  });
  const usersItem = document.getElementById('settings-item-users');
  if (usersItem) usersItem.classList.toggle('hidden', !canSee('users'));
  // The menu itself is always there: the delegate portal and Log out live in
  // it. Each group's heading shows only when the role may open something
  // under it.
  if (settingsMenuBtn) settingsMenuBtn.classList.remove('hidden');
  const SETTINGS_GROUPS = {
    conference: ['programme', 'programs', 'attendance'],
    fees: ['fees', 'discount', 'groupdiscount'],
    messages: ['reminders'],
    system: ['general', 'users', 'roles', 'activity'],
  };
  Object.entries(SETTINGS_GROUPS).forEach(([group, keys]) => {
    const heading = document.getElementById(`settings-group-${group}`);
    if (heading) heading.classList.toggle('hidden', !keys.some(canSee));
  });

  // Show only the report cards this permission set can access. Each report
  // is its own permission (see permissions.js), so this is not one
  // isFinance/isReviewer/isOperations question but six separate ones.
  const reportCards = {
    'report-summary': 'reports.summary',
    'report-delegates': 'reports.delegates',
    'report-delegate-programs': 'reports.delegate_programs',
    'report-payments': 'reports.payments',
    'report-workshops': 'reports.programs',
    'report-abstracts': 'reports.abstracts',
  };
  Object.entries(reportCards).forEach(([id, permission]) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', !can(permission));
  });
}

async function initBackendPortal() {
  setupAdminDelegation();

  // Identify the logged-in admin from the session, not a client-side switcher.
  const meRes = await fetch('/api/auth/me');
  if (!meRes.ok) {
    showToast('Please log in through the delegate portal with an administrator account.');
    window.location.href = '/portal';
    return;
  }
  const me = await meRes.json();
  activeAdminUser = me.user;
  // Who is signed in, on the bar's account button and at the top of its menu.
  const meName = (me.user && me.user.full_name) || '';
  const meInitials = nameInitials(meName);
  const meBox = document.getElementById('admin-me-initials');
  if (meBox && meInitials) meBox.textContent = meInitials;
  setText('admin-me-name', meName);
  setText('admin-me-role', (me.roles && me.roles.length ? me.roles : [me.user && me.user.role]).filter(Boolean).map(roleLabel).join(', '));
  myPermissions = new Set(me.permissions || []);
  mySections = me.sections || {};

  applyRoleVisibility();

  // Land on the section from the URL (so a refresh, bookmark, or shared link
  // stays put), falling back to the first section this permission set can
  // actually use. A hash naming a tab this session can't open -- a stale
  // bookmark, or a link from a super admin -- falls back too rather than
  // showing an empty page. Done now, before the awaited renders below, not
  // after: switching tabs here first means an admin who clicks a different
  // tab while data is still loading stays where they clicked; switching
  // again afterwards would silently snap them back once loading finished.
  // Overview first: it is the landing screen, and the reason it exists is
  // that opening straight into a worklist shows work without showing where
  // the conference stands. Falls through for a role that cannot see it --
  // Operations holds none of the sections it summarises.
  // The Front Desk first, for every role that can open it: it is where a
  // delegate's whole record is, with each role's own actions. Overview stays
  // a tab.
  const defaultTab = canSee('desk') ? 'desk'
    : canSee('overview') ? 'overview'
    : canSee('payments') ? 'payments'
    : canSee('statement') ? 'statement'
    : canSee('abstracts') ? 'abstracts'
    : canSee('reports') ? 'reports'
    // The coordinators' whole job is the Guests tab.
    : canSee('faculty') ? 'faculty'
    : canSee('attendance') ? 'attendance'
    : 'workshops'; // unreachable for the five built-in roles; a defensive fallback for an unrecognised one
  const allowed = allowedBackendTabs();
  const hashTab = tabFromHash();
  const loading = document.getElementById('admin-initial-loading');
  if (loading) loading.classList.add('hidden');
  switchBackendTab(allowed.includes(hashTab) ? hashTab : defaultTab);

  // Render every section this session may see (this also fills the tab
  // badges). Each gate is the section that screen belongs to -- the same
  // fact applyRoleVisibility() just drew the menu from.
  if (canSee('payments')) await renderBackendPayments();
  if (canSee('payments')) renderDelegateMap();
  if (canSee('abstracts')) await renderBackendAbstracts();
  // Fills the Faculty tab badge (arrivals without a vehicle, faculty without a room).
  if (canSee('faculty')) renderGuests();
  loadMedicalCouncils();
  if (canSee('users')) await loadBackendUsers();
  // The role picker used in Users & Roles and the Create Staff User modal --
  // needed by anyone who can assign a role, not only someone who can also
  // redesign one.
  if (can('users.assign_role')) await renderRoleOptions();
  if (canSee('roles')) await loadBackendRoles();
  if (canSee('programs')) await renderBackendPrograms();
  if (canSee('fees')) await renderBackendFees();
  if (canSee('discount')) await renderDiscountCodes();
  if (canSee('discount') || canSee('groupdiscount')) await renderGroupRules();
  if (canSee('general')) await renderGeneralSettings();
  if (canSee('activity')) await renderBackendActivity();
  if (canSee('payments')) await loadReportWorkshopOptions();
  if (canSee('reminders')) await renderReminders();
}

const PAYMENT_MODE_LABELS = { UPI: 'UPI', NEFT_RTGS: 'NEFT / RTGS' };

// Cached so the review modal can look a row up by id without a second fetch.
let cachedPaymentRegs = [];

// "Balance due" = the admin has revised the payment (after a fee change), so
// the delegate has been formally asked to pay the difference. These sit in the
// "Awaiting Balance Payment" section, not the main decision worklist. A
// category change alone doesn't land a registration here -- the admin must
// link the existing payment and click Revise Payment first (which sets
// PARTIAL_PAYMENT).
function isBalanceDue(r) {
  return r.bank_status === 'PARTIAL_PAYMENT';
}

// Shared row markup for both the main worklist and the collapsed rejected
// list below it.
// Kept deliberately spare: everything else (UTR, mode, submitted date, OCR
// checks, screenshot/ID card, transaction link) is already one click away
// in the review modal -- repeating it here just made the list noisy.
function paymentRowHtml(p) {
  // The Status column is gone: the four tables on this screen already
  // separate pending, balance-due, rejected and verified, so a pill naming
  // the status only restated which table you were reading. balanceDue
  // survives because the balance note below still needs it.
  const balanceDue = isBalanceDue(p);
  // Surface how much is still owed at a glance: use the verified total when
  // there is one, else the claimed amount (category-changed, not yet
  // verified). Also what the Amount column itself shows below -- it used to
  // show the raw claimed p.paid_amount there while the balance pill showed
  // this verified-first figure, so the two could disagree (e.g. a delegate
  // claims ₹2,000 but only ₹750 is actually verified: Amount showed ₹2,000
  // while the pill correctly said "₹750 of ₹2,000"). Using the same value
  // in both places keeps them consistent everywhere this row renders.
  const paidSoFar = Number(p.verified_total) > 0 ? Number(p.verified_total) : (Number(p.paid_amount) || 0);
  const owed = Number(p.expected_amount) - paidSoFar;
  // Category was changed to a higher fee and the delegate still owes -- flag it
  // in the worklist so the admin knows to link the payment and Revise.
  const categoryChangedShortfall = !!p.category_locked && p.bank_status === 'PENDING' && owed > 0;
  const balancePill = ((balanceDue || categoryChangedShortfall) && owed > 0)
    ? `<span class="inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-full border bg-orange-100 text-orange-800 border-orange-300">${ICON('coin')}₹${inr(paidSoFar)} of ₹${inr(Number(p.expected_amount))} · ₹${inr(owed)} due</span>`
    : '';
  // Same compact-pill shape as everywhere else (phase 03) -- this one and
  // the three below it used a plain `rounded` corner and lighter tones
  // instead of `rounded-full` + the standard -100/-800/-300 triad, missed
  // in that pass for the same reason phase 10's "rejected" tag was: it
  // doesn't match "rounded-full", the pattern that pass searched for.
  const reviseHint = categoryChangedShortfall
    ? `<span class="text-[10px] text-orange-800 font-bold bg-orange-100 border border-orange-300 rounded-full px-2 py-0.5">${ICON('warning')}Category changed — revise</span>`
    : '';
  // Verified payments (net of any already-recorded refund) exceed what was
  // owed -- surfaced here so it's visible while scanning the list, not only
  // after opening Review (see getPaymentSummary's overpaid / the refund
  // section inside the review modal, where it's actually recorded as
  // refunded).
  const overpaidAmt = Number(p.overpaid) || 0;
  const overpaidPill = overpaidAmt > 0
    ? `<span class="text-[10px] text-amber-800 font-bold bg-amber-100 border border-amber-300 rounded-full px-2 py-0.5">${ICON('coin')}₹${inr(overpaidAmt)} excess paid</span>`
    : '';
  // --- the two checks, as chips that always say where they stand ---------
  //
  // Both of these used to be bare coloured text with no pill shape, and both
  // only ever showed a negative. The bank one appeared as "Awaiting bank
  // match" and then vanished once matched, so there was no way to confirm a
  // payment WAS matched -- only to notice when it wasn't. The ID one
  // rendered solely for student categories, which made "no ID required" and
  // "ID not checked yet" both look like an empty cell.
  //
  // Now each is one of three states, in the canonical compact-pill shape:
  // done, outstanding, or not applicable.
  const chip = (tone, icon, label) => {
    const tones = {
      ok: 'bg-emerald-100 text-emerald-800 border-emerald-300',
      due: 'bg-amber-100 text-amber-800 border-amber-300',
      off: 'bg-slate-100 text-slate-500 border-slate-300',
      bad: 'bg-red-100 text-red-800 border-red-300',
    };
    return `<span class="inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-full border ${tones[tone]}">${icon}${esc(label)}</span>`;
  };

  // Linking a payment to a bank credit sets txn_status = 'VERIFIED' in the
  // same statement, so a VERIFIED transaction IS a matched one -- which is
  // what gives this a truthful positive state at last. "Matched" is asserted
  // from one of those, never inferred from the absence of anything pending:
  // a rejected registration, and a Rs0 one fully covered by a discount (the
  // free path confirms outright and never writes a transaction at all), both
  // have an empty pending set having matched nothing, and would otherwise
  // claim a bank credit that does not exist. They fall to n/a instead.
  const allTxns = p.transactions || [];
  const pendingTxns = allTxns.filter((t) => t.txn_status === 'PENDING');
  const matchedTxns = allTxns.filter((t) => t.txn_status === 'VERIFIED');
  const bankChip = p.bank_status === 'REJECTED'
    ? chip('off', ICON('link'), 'Bank n/a')
    : pendingTxns.length > 0
      ? chip('due', ICON('warning'), 'Bank pending')
      : matchedTxns.length > 0
        ? chip('ok', ICON('link'), 'Bank matched')
        : chip('off', ICON('link'), 'Bank n/a');

  // Only student categories need a card at all, and for the rest there is no
  // chip -- not a grey "n/a" one. A check that does not apply is not a state
  // of that check, and putting it on every row costs a column's worth of
  // attention to say nothing. The chip appears exactly when there is
  // something to do or something that was done.
  const idChip = !isStudentCategory(p.category_key)
    ? ''
    : p.id_verified
      ? chip('ok', ICON('gradcap'), 'ID verified')
      : chip('due', ICON('warning'), 'ID pending');

  // The reason becomes a chip like everything else; the free-text note the
  // reviewer typed can be any length, so it goes on its own line underneath
  // rather than stretching a pill across the row.
  const rejectionNote = p.bank_status === 'REJECTED' && p.rejection_reason
    ? `<span class="inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-full border bg-rose-100 text-rose-800 border-rose-300">${ICON('cross')}${esc(REJECTION_LABELS[p.rejection_reason] || p.rejection_reason)}</span>`
    : '';
  const rejectionDetail = p.bank_status === 'REJECTED' && p.rejection_note
    ? `<p class="text-[11px] text-rose-700 mt-1">${esc(p.rejection_note)}</p>`
    : '';
  const reviewBtn = `<button class="review-btn px-3 py-1.5 ${p.is_flagged ? 'bg-red-600 hover:bg-red-700' : 'bg-navy hover:bg-indigo-700'} text-white font-semibold rounded-lg text-xs shadow-sm" data-id="${esc(p.id)}">${p.is_flagged ? 'Review (Force Verify)' : 'Review'}</button>`;
  // The delegate's own receipt, opened in a new tab -- the exact document
  // they see, so the desk can answer "what does my receipt say" and reprint
  // one without reading it off their phone. Only on verified rows: a receipt
  // for an unverified payment doesn't exist, and the server refuses one.
  const receiptBtn = p.bank_status === 'BANK_VERIFIED'
    ? `<a href="/api/registrations/${esc(p.id)}/receipt" target="_blank" rel="noopener" class="px-3 py-1.5 border border-slate-300 hover:bg-slate-50 text-slate-700 font-semibold rounded-lg text-xs">${ICON('document')}Receipt</a>`
    : '';
  const rowActions = `<div class="flex flex-wrap items-center gap-2 sm:justify-end">${reviewBtn}${receiptBtn}</div>`;

  // Exception notes: things true of THIS delegate that the reviewer needs
  // to know before opening them. Grouped once and used by both layouts, so
  // the phone and the desktop cannot drift apart.
  const notes = [
    p.is_flagged ? chip('bad', ICON('warning'), 'Flagged') : '',
    reviseHint, balancePill, overpaidPill, rejectionNote,
  ].filter(Boolean).join('');

  const registered = fmtRegisteredAt(p.submitted_at);

  return `
    <tr class="border-b border-slate-100 ${p.is_flagged ? 'bg-red-50/50' : ''}">
      <!-- Phone: one card, read top to bottom -- who, when, how much, what
           is outstanding, what you can do. No column labels; meaning comes
           from position and from the chips saying their own names. -->
      <td class="p-4 block sm:hidden">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="font-bold text-sm text-slate-800 truncate">${esc(p.delegate_name)}</p>
            <p class="text-[11px] text-slate-500 truncate">${esc(p.category_label)}</p>
          </div>
          <p class="font-bold text-slate-800 shrink-0 tabular-nums">₹${inr(paidSoFar)}</p>
        </div>
        ${registered ? `<p class="text-[11px] text-slate-400 mt-1">Registered ${esc(registered)}</p>` : ''}
        <div class="flex flex-wrap items-center gap-1.5 mt-2">${bankChip}${idChip}</div>
        ${notes ? `<div class="flex flex-wrap items-center gap-1.5 mt-1.5">${notes}</div>` : ''}
        ${rejectionDetail}
        <div class="mt-3 flex flex-wrap gap-2">${rowActions}</div>
      </td>

      <!-- Desktop columns: Delegate & Category | Registered | Amount |
           Checks | Action. Status is gone -- the four tables already
           separate pending, balance-due, rejected and verified, so the
           column restated the table you were looking at. -->
      <td class="p-4 hidden sm:table-cell align-top">
        <p class="font-bold text-sm text-slate-800">${esc(p.delegate_name)}</p>
        <p class="text-[11px] text-slate-500">${esc(p.category_label)}</p>
        ${notes ? `<div class="flex flex-wrap items-center gap-1.5 mt-1.5">${notes}</div>` : ''}
        ${rejectionDetail}
      </td>
      <td class="p-4 hidden sm:table-cell align-top text-[11px] text-slate-500 whitespace-nowrap">
        ${esc(registered) || '<span class="text-slate-300">—</span>'}
      </td>
      <td class="p-4 hidden sm:table-cell align-top text-sm">
        <span class="font-semibold text-slate-700 tabular-nums">₹${inr(paidSoFar)}</span>
      </td>
      <td class="p-4 hidden sm:table-cell align-top">
        <div class="flex flex-wrap items-center gap-1.5">${bankChip}${idChip}</div>
      </td>
      <td class="p-4 hidden sm:table-cell align-top text-right whitespace-nowrap">
        ${rowActions}
      </td>
    </tr>
  `;
}

// Re-runs the automated screenshot/ID checks against every currently
// flagged, still-pending registration's already-uploaded files -- useful
// after fixing a bug in the OCR matching logic itself, so past
// submissions get re-judged instead of sitting flagged on stale results.
// Walks the rescan in batches. The server answers one batch per request and
// hands back the cursor for the next: OCR takes a second or two per slip, and
// a whole-corpus rescan in a single request would run for minutes and be cut
// off by the proxy at 100 seconds -- the admin seeing a failure while the
// server carried on working. Batching keeps every request short and lets the
// button report real progress.
async function rescanFlaggedPayments(all = false) {
  const btn = document.getElementById('rescan-flagged-btn');
  // innerHTML, not textContent -- the button's default label carries an SVG
  // icon (see payments.ejs); textContent would silently strip it every time
  // this runs, since it only writes plain text nodes.
  const label = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = ICON('refresh') + 'Rescanning…'; }

  const tally = { rescanned: 0, unflagged: 0, stillFlagged: 0, skippedNoFile: 0 };
  let after = 0;
  let total = 0;
  let failure = null;

  try {
    for (;;) {
      const res = await fetch('/api/admin/registrations/rescan-flagged', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all, after }),
      });
      const data = await res.json();
      if (!data.success) { failure = data.error || 'Rescan failed.'; break; }

      ['rescanned', 'unflagged', 'stillFlagged', 'skippedNoFile'].forEach((k) => { tally[k] += data[k] || 0; });
      if (!total) total = data.totalFlagged || 0;
      if (btn && total) btn.innerHTML = ICON('refresh') + `Rescanning ${tally.rescanned}/${total}…`;

      if (data.nextAfter == null) break;
      after = data.nextAfter;
    }
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = label || (ICON('refresh') + 'Rescan Flagged'); }
  }

  if (failure) { showToast(failure); return; }
  showToast(
    `Rescanned ${tally.rescanned} of ${total}. ${tally.unflagged} cleared, ${tally.stillFlagged} still flagged.`
      + (tally.skippedNoFile ? ` (${tally.skippedNoFile} skipped -- file missing.)` : ''),
    tally.unflagged ? 'success' : 'info'
  );
  await renderBackendPayments();
}

// The landing screen: one figure per section, each linking to the section
// that owns it. Nothing here is computed on the server -- every number comes
// from the same endpoints the sections themselves use, so the overview can
// never quietly disagree with the tab it summarises.
//
// Each block is skipped for a role that cannot open the section behind it.
// The endpoints would 403 anyway; hiding the card as well means a finance
// admin is not shown an empty "Abstracts to review" box they can do nothing
// about and cannot verify.
// The Overview's "Now": each session open for attendance this minute, its
// hall and how many are marked present. One that started ten minutes ago
// with nobody marked is flagged -- the door may have no one scanning.
function renderOverviewNow(summary) {
  const box = document.getElementById('overview-now');
  const halls = document.getElementById('overview-now-halls');
  if (!box || !halls) return;
  const open = summary && Array.isArray(summary.sessions) ? summary.sessions.filter((s) => s.window && s.window.open) : [];
  box.classList.toggle('hidden', !open.length);
  if (!open.length) { halls.innerHTML = ''; return; }
  const ist = new Date(Date.now() + 5.5 * 3600e3);
  const nowMin = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const toMin = (t) => { const [h, m] = String(t || '0:0').split(':').map(Number); return h * 60 + m; };
  setText('overview-now-when', `· ${ist.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}, ${guestTime12(`${String(ist.getUTCHours()).padStart(2, '0')}:${String(ist.getUTCMinutes()).padStart(2, '0')}`)}`);
  halls.innerHTML = open.map((s) => {
    const quiet = s.present === 0 && nowMin >= toMin(s.start) + 10;
    return `<div class="rounded-xl border ${quiet ? 'border-amber-300 bg-amber-50' : 'border-slate-200'} p-3.5">
      <p class="text-sm font-bold ${quiet ? 'text-amber-900' : 'text-slate-600'}">${esc(s.hall)} · until ${esc(guestTime12(s.end))}</p>
      <p class="font-semibold text-slate-900 leading-snug mt-0.5">${esc(s.title)}</p>
      ${quiet ? '<p class="text-sm font-bold text-amber-900 mt-1.5">No one marked yet: check the door volunteer</p>'
        : `<p class="mt-1.5 text-2xl font-bold text-navy tabular-nums">${esc(s.present)} <span class="text-sm font-semibold text-slate-600">marked present${s.enrolled != null ? ` of ${esc(s.enrolled)} enrolled` : ''}</span></p>`}
    </div>`;
  }).join('');
}

// From the Overview's faculty cards: the Faculty tab, filtered.
let pendingGuestFlag = null;
function openFacultyFlag(flag) {
  pendingGuestFlag = flag;
  switchBackendTab('faculty');
}

async function renderBackendOverview() {
  const host = document.getElementById('section-overview');
  if (!host) return;

  const seesPayments = canSee('payments');
  const seesStatement = canSee('statement');
  const seesAbstracts = canSee('abstracts');
  const seesFaculty = can('guests.view');
  const seesAttendance = can('attendance.view');
  // Conference-wide money is its own permission: working the approval queue
  // and seeing what the conference has taken are different disclosures.
  const seesTotals = can('payments.view_totals');

  const show = (id, on) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', !on);
  };

  // Fetched in parallel and each guarded on its own: one section being
  // unreachable, or simply slow, must not stop the rest of the page
  // resolving (the same reasoning as loadDashboard's own fetches).
  const getJson = async (url) => {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      return await res.json();
    } catch (e) { return null; }
  };

  const [regs, abstracts, statement, totals, faculty, attendance] = await Promise.all([
    seesPayments ? getJson('/api/registrations') : Promise.resolve(null),
    seesAbstracts ? getJson('/api/abstracts') : Promise.resolve(null),
    seesStatement ? getJson('/api/admin/bank-statement/reconcile') : Promise.resolve(null),
    seesTotals ? getJson('/api/admin/finance-summary') : Promise.resolve(null),
    seesFaculty ? getJson('/api/guests') : Promise.resolve(null),
    seesAttendance ? getJson('/api/attendance/summary') : Promise.resolve(null),
  ]);
  renderOverviewNow(attendance);

  let pending = 0;
  let balanceCount = 0;
  let unmatched = 0;
  let underReview = 0;

  // The block appears if EITHER half has something to show: the headcounts
  // need payments.view, the two rupee figures need payments.view_totals, and
  // a role may hold one without the other.
  show('overview-money', !!regs || !!totals);
  show('ov-card-collected', !!totals);
  show('ov-card-outstanding', !!totals);

  if (regs) {
    const all = regs.registrations || [];
    const verified = all.filter((r) => r.bank_status === 'BANK_VERIFIED');
    const partial = all.filter((r) => r.bank_status === 'PARTIAL_PAYMENT' || isBalanceDue(r));
    const needsDecision = all.filter((r) => r.bank_status === 'PENDING' && !isBalanceDue(r));
    pending = needsDecision.length;
    balanceCount = partial.length;

    setText('ov-delegates', all.length);
    setText('ov-delegates-sub', 'registrations submitted');
    setText('ov-confirmed', verified.length);
    setText('ov-confirmed-sub', all.length ? `${Math.round((verified.length / all.length) * 100)}% of submissions` : 'none yet');

    setText('ov-pending', pending);
    setText('ov-balance', balanceCount);
    setText('ov-balance-sub', balanceCount ? 'waiting on the delegate' : 'none outstanding');
  }

  // Totals come from the server, not from summing the registration list in
  // the browser. That is what makes payments.view_totals a real boundary:
  // derived client-side, the figures were only ever as private as
  // /api/registrations itself.
  if (totals) {
    setText('ov-collected', `₹${inr(totals.collected)}`);
    setText('ov-outstanding', `₹${inr(totals.outstanding)}`);
    setText('ov-outstanding-sub', totals.outstanding > 0
      ? `across ${totals.owingCount} delegate${totals.owingCount === 1 ? '' : 's'}`
      : 'nothing owed');
    // The sub-line under Collected counts confirmed registrations, which only
    // the registration list knows -- left blank for a totals-only role rather
    // than inventing a number it cannot see.
    if (regs) {
      const verified = (regs.registrations || []).filter((r) => r.bank_status === 'BANK_VERIFIED');
      setText('ov-collected-sub', `${verified.length} confirmed registration${verified.length === 1 ? '' : 's'}`);
    } else {
      setText('ov-collected-sub', '');
    }
  }

  if (statement) {
    // The endpoint already counts this (see its `summary`), and its
    // reconciliation is subtle enough -- split credits, non-registration
    // markings, debits -- that recomputing it here would be a second
    // definition free to drift from the tab it summarises.
    unmatched = Number((statement.summary || {}).unmatchedCredits) || 0;
    setText('ov-unmatched', unmatched);
  }

  if (abstracts) {
    const list = abstracts.abstracts || [];
    underReview = list.filter((a) => a.status === 'UNDER_REVIEW').length;
    const accepted = list.filter((a) => a.status === 'ACCEPTED').length;
    setText('ov-abstracts', underReview);
    setText('ov-abstracts-sub', `${list.length} submitted · ${accepted} accepted`);
  }

  // Faculty: rooms to assign, pickups to decide, accounts to link.
  let noRoom = 0;
  let undecided = 0;
  let notSignedUp = 0;
  if (faculty && faculty.dashboard) {
    const live = (faculty.guests || []).filter((g) => !g.cancelled);
    noRoom = Number(faculty.dashboard.noAccommodation) || 0;
    undecided = live.filter((g) => !String(g.pickup_status || '').trim()).length;
    notSignedUp = Number(faculty.dashboard.notSignedUp) || 0;
    setText('ov-rooms', noRoom);
    setText('ov-pickups', undecided);
    setText('ov-signup', notSignedUp);
  }
  show('ov-q-rooms', seesFaculty && noRoom > 0);
  show('ov-q-pickups', seesFaculty && undecided > 0);
  show('ov-q-signup', seesFaculty && notSignedUp > 0);
  show('overview-queues-faculty', seesFaculty && noRoom + undecided + notSignedUp > 0);

  // A queue card earns its place by being reachable AND having something in
  // it. An overview of four zeroes tells the desk less than one sentence.
  show('ov-q-payments', seesPayments && pending > 0);
  show('ov-q-balance', seesPayments && balanceCount > 0);
  show('ov-q-statement', seesStatement && unmatched > 0);
  show('ov-q-abstracts', seesAbstracts && underReview > 0);
  // The whole block belongs to whoever can open at least one of the sections
  // it summarises. Without this the heading and the all-clear line showed to
  // everyone, and the line in particular claimed nothing was waiting ANYWHERE
  // -- said to someone who can see only abstracts while a payments queue was
  // piling up behind a tab they cannot open.
  const anySection = seesPayments || seesStatement || seesAbstracts || seesFaculty;
  show('overview-attention', anySection);

  const anyQueue = (seesPayments && (pending > 0 || balanceCount > 0))
    || (seesStatement && unmatched > 0) || (seesAbstracts && underReview > 0)
    || (seesFaculty && noRoom + undecided + notSignedUp > 0);
  show('overview-all-clear', anySection && !anyQueue);
  // Say which sections the all-clear covers, so it is a claim about the
  // viewer's own work rather than about the conference.
  if (anySection && !anyQueue) {
    const mine = [seesPayments && 'registrations', seesStatement && 'the bank statement',
      seesAbstracts && 'abstracts', seesFaculty && 'faculty'].filter(Boolean);
    const list = mine.length > 1 ? `${mine.slice(0, -1).join(', ')} or ${mine[mine.length - 1]}` : mine[0];
    setText('overview-all-clear', `Nothing is waiting on a decision in ${list} right now.`);
  }

  setText('overview-updated', `Updated ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`);
  settleSkeletons(host);
}

// Registration › Approval: the counts are the filters. 'pending' is the
// worklist, with balance due and rejected below it ("Still needs a hand");
// each other shows just its own list. Verified opens the settled list for
// whoever may un-approve, else Reports.
let paymentFilter = 'pending';
let paymentCounts = { pending: 0, balance: 0, rejected: 0, verified: 0, canUnapprove: false };
function setPaymentFilter(key) {
  if (key === 'verified' && !paymentCounts.canUnapprove) return switchBackendTab('reports');
  paymentFilter = key;
  applyPaymentFilter();
}
function applyPaymentFilter() {
  const key = paymentFilter;
  const c = paymentCounts;
  const show = (id, on) => { const el = document.getElementById(id); if (el) el.classList.toggle('hidden', !on); };
  const open = (id, on) => { const el = document.getElementById(id); if (el) el.open = !!on; };
  show('pay-main', key === 'pending');
  show('pay-main-note', key === 'pending');
  show('balance-section', c.balance > 0 && (key === 'pending' || key === 'balance'));
  show('rejected-section', c.rejected > 0 && (key === 'pending' || key === 'rejected'));
  show('verified-section', c.canUnapprove && c.verified > 0 && key === 'verified');
  open('balance-section', key === 'balance');
  open('rejected-section', key === 'rejected');
  open('verified-section', key === 'verified');
  show('pay-needs-hand', key === 'pending' && c.balance + c.rejected > 0);
  const none = key !== 'pending' && !c[key];
  show('pay-filter-empty', none);
  setText('pay-filter-empty', none ? { balance: 'No one has a balance due.', rejected: 'No rejected registrations.', verified: 'No verified registrations yet.' }[key] : '');
  // Selected: navy. The delegate's-turn counts in rose while they hold anyone.
  for (const k of ['pending', 'balance', 'rejected', 'verified']) {
    const btn = document.getElementById(`pay-filter-${k}`);
    if (!btn) continue;
    const on = k === key;
    const urgent = (k === 'balance' || k === 'rejected') && c[k] > 0;
    btn.className = `pay-filter h-10 px-3.5 rounded-full border text-sm ${on ? 'bg-navy border-navy text-white font-bold'
      : urgent ? 'bg-white border-rose-200 text-rose-800 font-semibold hover:bg-rose-50' : 'bg-white border-slate-300 text-slate-700 font-semibold hover:bg-slate-50'}`;
    if (btn.setAttribute) btn.setAttribute('aria-selected', String(on));
    if (k === 'verified' && !c.canUnapprove && btn.setAttribute) btn.setAttribute('title', 'The verified list is in Reports');
  }
}

async function renderBackendPayments() {
  await ensureReviewCategories(); // warms isStudentCategory() before rows render below
  const res = await fetch('/api/registrations');
  const data = await res.json();
  const tbody = document.getElementById('payment-table-body');
  if (!tbody) return;

  const allRegs = data.registrations || [];
  cachedPaymentRegs = allRegs;

  // Metrics reflect everyone; the worklist below only shows what still needs
  // a decision -- a verified delegate drops off it (see Reports for the
  // full verified list). Rejected registrations already have a decision
  // (the delegate needs to resubmit), so they're not "pending" and live in
  // their own collapsed section instead of the main worklist/metric/badge.
  const verified = allRegs.filter(r => r.bank_status === 'BANK_VERIFIED');
  // The worklist is everything PENDING -- a fresh submission with payment(s) to
  // link, or a fully-linked registration awaiting final approval. Both are
  // PENDING; a top-up flips a PARTIAL_PAYMENT registration back to PENDING so
  // it resurfaces here. PARTIAL_PAYMENT (balance due) is the delegate's turn,
  // so it stays off the worklist.
  const rejected = allRegs.filter(r => r.bank_status === 'REJECTED');
  // Balance-due delegates (acknowledged partial, or category changed to a
  // higher fee than paid) live in their own section, not the worklist.
  const partialAwaiting = allRegs.filter(isBalanceDue);
  const needsDecision = allRegs.filter(r => r.bank_status === 'PENDING' && !isBalanceDue(r));
  const totalCleared = verified.reduce((sum, r) => sum + (Number(r.verified_total) || 0), 0);
  // Same "what's actually still owed" math as the balancePill in
  // paymentRowHtml: the verified total if there is one, else whatever's
  // been claimed so far (category-changed, not yet verified).
  const totalBalanceDue = partialAwaiting.reduce((sum, r) => {
    const paidSoFar = Number(r.verified_total) > 0 ? Number(r.verified_total) : (Number(r.paid_amount) || 0);
    return sum + Math.max(0, Number(r.expected_amount) - paidSoFar);
  }, 0);
  setText('metric-total-amount', `₹${inr(totalCleared)}`);
  setText('metric-verified-count', verified.length);
  setText('metric-pending-count', needsDecision.length);
  setText('metric-balance-count', partialAwaiting.length);
  setText('metric-balance-amount', `₹${inr(totalBalanceDue)} outstanding`);
  setText('metric-rejected-count', rejected.length);
  setText('badge-pending-payments', needsDecision.length);

  tbody.innerHTML = needsDecision.map(paymentRowHtml).join('');
  if (!needsDecision.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="p-8 text-center">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-8 h-8 mx-auto text-emerald-600" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/></svg>
      <p class="mt-2 text-base font-bold text-slate-800">All caught up</p>
      <p class="text-sm text-slate-500">Nothing awaiting a decision. New submissions appear here as they arrive.</p></td></tr>`;
  }

  const rejectedBody = document.getElementById('rejected-table-body');
  setText('badge-rejected-count', rejected.length);
  if (rejectedBody) rejectedBody.innerHTML = rejected.map(paymentRowHtml).join('');

  // Balance-due section: PARTIAL_PAYMENT delegates (e.g. after a category
  // change) who've been emailed to pay the difference. It's their turn, so
  // they live here instead of the main worklist -- finance can still track
  // and open them.
  const balanceBody = document.getElementById('balance-table-body');
  setText('badge-balance-count', partialAwaiting.length);
  if (balanceBody) balanceBody.innerHTML = partialAwaiting.map(paymentRowHtml).join('');

  // The verified section is an entry point into already-verified
  // registrations, purely so they can be opened and un-approved -- hidden
  // for anyone who can't do that (finance admins never need to reach a
  // settled record here).
  const canUnapprove = can('payments.unapprove');
  const verifiedBody = document.getElementById('verified-table-body');
  setText('badge-verified-count', verified.length);
  if (verifiedBody) verifiedBody.innerHTML = canUnapprove ? verified.map(paymentRowHtml).join('') : '';
  // Which of the lists show is the filter's (the counts above).
  paymentCounts = { pending: needsDecision.length, balance: partialAwaiting.length, rejected: rejected.length, verified: verified.length, canUnapprove };
  applyPaymentFilter();

  // Each metric above clears its own skeleton through setText; this covers
  // anything the response had nothing to say about, so no part of the panel
  // is left shimmering after the data has arrived.
  settleSkeletons();
}

// --- DELEGATE LOCATION MAP (approval page overview) ---
// A choropleth (colored district polygons), not markers -- markers on top of
// India-scale geography inevitably collide wherever delegates cluster (e.g.
// the districts around the host). Coloring the district's own shape has
// nowhere to collide: every district gets exactly its own area, no matter
// how tightly packed its neighbors are.

// Delegates are placed on the map by district NAME first, falling back to the
// PIN code's coordinates (see resolveDelegateDistrict). Name-first, not
// coordinates-first, because the two data sources fail in opposite ways:
//
//  - The district name comes from India Post (see fetchAddressDetails), which
//    is accurate but spells some districts differently from the shapefile
//    ("Tuticorin" vs "Thoothukkudi"), and is occasionally blank. A name we
//    can't match means the delegate silently vanishes from the map.
//  - The PIN code coordinates (public/data/india-pincodes.json, from GeoNames)
//    always resolve to *some* polygon, but are only approximate: spot-checking
//    against real delegate data found 411033 (Pune) carrying an office point
//    ~180km away in Beed, and Koramangala (560034) plotting ~33km north into
//    Bengaluru Rural. Trusting them first would silently move delegates to the
//    wrong district -- worse than dropping them.
//
// So coordinates are only consulted when the name fails, and only when the
// polygon they land in is in the state the delegate gave -- a wrong-district
// guess within the right state is a tolerable approximation for a fallback,
// but a wrong-state one is a data error worth surfacing as unmapped instead.
const DISTRICT_NAME_ALIASES = {
  'ahmed nagar': 'ahmadnagar',
  'gondia': 'gondiya',
  'kanchipuram': 'kancheepuram',
  'north west delhi': 'north west',
  'south west delhi': 'south west',
  'tiruvallur': 'thiruvallur',
  'warangal': 'warangal urban',
};

// Low end starts well clear of the neutral "no data" fill (#f1efe8) and
// already reads as clearly colored, not just off-white -- a value of 1
// should never look like a value of 0.
const DELEGATE_MAP_COLORS = {
  registered: { empty: '#f1efe8', ramp: ['#a7d7b8', '#064e2f'] },
  signedup: { empty: '#f1efe8', ramp: ['#f6c977', '#7a3d02'] },
};

let delegateMapRendered = false;
let delegateMapMetric = 'registered';
let delegateMapData = null; // cached {topo, byKey, totalReg, totalSign, districtCount, unmatched} -- toggling redraws without refetching

async function renderDelegateMap() {
  if (delegateMapRendered) return; // static enough; render once per page load
  const host = document.getElementById('delegate-map');
  if (!host || typeof d3 === 'undefined' || typeof topojson === 'undefined') return;
  delegateMapRendered = true;

  const [locRes, topo, pinFile] = await Promise.all([
    fetch('/api/admin/delegate-locations'),
    // Self-hosted district-level topology (public/data/india-districts.topo.json)
    // rather than an external CDN -- built from the official Survey of India
    // district shapefile, so it depicts India's full claimed territory (all of
    // Jammu & Kashmir and Ladakh as separate states) and doesn't depend on a
    // third party staying up. dtname/stname are the only properties kept.
    d3.json('/data/india-districts.topo.json').catch(() => null),
    // PIN code -> [lat, lon], for the coordinate fallback. Optional: if it
    // fails to load, name matching still works exactly as it did before.
    d3.json('/data/india-pincodes.json').catch(() => null),
  ]);
  if (!locRes.ok || !topo) { delegateMapRendered = false; setText('delegate-map-summary', 'Could not load the map.'); return; }
  const locPayload = await locRes.json();
  const locations = locPayload.locations || [];
  // Counted, not plotted: the choropleth is an Indian district map, so
  // international delegates are reported beside it instead of vanishing.
  const international = locPayload.international || [];

  const feat = topojson.feature(topo, topo.objects.in_district);
  const pinCoords = (pinFile && pinFile.pincodes) || {};

  // Bounding box per district, so the point-in-polygon fallback can skip the
  // ~729 features it obviously isn't in instead of walking every ring.
  const featBoxes = feat.features.map((f) => ({ f, bbox: d3.geoBounds(f) }));

  const byKey = new Map();
  let totalReg = 0, totalSign = 0;
  const unmatched = [];
  locations.forEach((loc) => {
    totalReg += loc.registered; totalSign += loc.signedup;
    const hit = resolveDelegateDistrict(loc, feat, featBoxes, pinCoords);
    if (!hit) {
      const label = String(loc.district || '').trim() || `PIN ${loc.pincode}`;
      if (!unmatched.includes(label)) unmatched.push(label);
      return;
    }
    const prev = byKey.get(hit.key) || { registered: 0, signedup: 0, rawName: hit.rawName };
    byKey.set(hit.key, { registered: prev.registered + loc.registered, signedup: prev.signedup + loc.signedup, rawName: prev.rawName });
  });

  // State borders and the country outline, derived once here rather than on
  // every metric toggle -- they depend only on the topology. Computed in
  // THIS function because `topo` is in scope here and not in
  // drawDelegateMap, which only ever sees the cached object below.
  //
  // A mesh of the arcs where stname differs draws each internal border
  // exactly once; stroking each state's outline separately would draw every
  // shared edge twice and render it double-thickness. Filtering to arcs with
  // only one side (a === b) gives the coast and international boundary.
  const stateMesh = topojson.mesh(topo, topo.objects.in_district,
    (a, b) => a !== b && a.properties.stname !== b.properties.stname);
  const outline = topojson.mesh(topo, topo.objects.in_district, (a, b) => a === b);

  delegateMapData = { feat, byKey, totalReg, totalSign, districtCount: byKey.size, unmatched, international, stateMesh, outline };
  drawDelegateMap();
}

// A district is identified by its STATE and its name, never by name alone.
// Six names in the shapefile belong to two states each -- Hamirpur, Bilaspur,
// Pratapgarh, Balrampur, Aurangabad and Raigarh -- so a bare name is not a
// district, and using one as the key had two consequences: a delegate could
// be drawn on the wrong state's district, and both same-named polygons got
// shaded with the combined count (Aurangabad, Bihar was showing Aurangabad,
// Maharashtra's four delegates).
//
// Built from the feature's own properties on both sides -- the map's key and
// the delegate's resolved key always come from the same source -- so the
// tolerant state matching below never has to produce a key, only compare.
const districtKey = (f) => `${normalizeStateName(f.properties.stname)}|${String(f.properties.dtname || '').toLowerCase().trim()}`;

// The shapefile shouts its state names ("UTTAR PRADESH"); a tooltip shouldn't.
const titleCaseState = (v) => String(v == null ? '' : v).toLowerCase()
  .replace(/\b[a-z]/g, (c) => c.toUpperCase());

// Deliberately loose: this only has to catch a coordinate landing in a wholly
// different state, so it tolerates the two sources spelling the same state
// differently. India Post writes "Chattisgarh" where the shapefile writes
// "CHHATTISGARH", uses the post-rename spellings the shapefile predates
// (Orissa/Odisha, Pondicherry/Puducherry, Uttaranchal/Uttarakhand), and the
// shapefile truncates some names outright ("DADRA & NAGAR HAVE") -- hence the
// prefix comparison rather than equality. A blank on either side passes,
// since a missing state can't contradict anything.
const STATE_SYNONYMS = { orissa: 'odisha', pondicherry: 'puducherry', uttaranchal: 'uttarakhand', chattisgarh: 'chhattisgarh', nctofdelhi: 'delhi' };
function normalizeStateName(v) {
  const s = String(v == null ? '' : v).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
  return STATE_SYNONYMS[s] || s;
}
function sameState(a, b) {
  const x = normalizeStateName(a), y = normalizeStateName(b);
  if (!x || !y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 4 && long.startsWith(short);
}

// Place one grouped location row on a map polygon. Returns {key, rawName} for
// the district it belongs to, or null if neither the name nor the PIN code
// could place it (reported as "unmapped" in the map summary rather than being
// silently dropped). See the DISTRICT_NAME_ALIASES comment for why the name is
// tried first and the coordinates only as a guarded fallback.
function resolveDelegateDistrict(loc, feat, featBoxes, pinCoords) {
  const rawName = String(loc.district || '').trim();
  const named = rawName.toLowerCase();
  const name = DISTRICT_NAME_ALIASES[named] || named;
  if (name) {
    const candidates = feat.features.filter((f) => String(f.properties.dtname || '').toLowerCase().trim() === name);
    // The overwhelmingly common case: the name belongs to exactly one
    // district in the country, so the state adds nothing.
    if (candidates.length === 1) return { key: districtKey(candidates[0]), rawName };
    if (candidates.length > 1) {
      // Shared name. The delegate's own state decides which one it is.
      const inState = candidates.filter((f) => sameState(loc.state, f.properties.stname));
      if (inState.length === 1) return { key: districtKey(inState[0]), rawName };
      // Still ambiguous -- the delegate gave no state, or one that matches
      // both spellings. Deliberately NOT a coin flip between two real
      // districts a thousand kilometres apart: fall through to the PIN code,
      // which places them exactly, and leave them unmapped if there isn't one.
    }
  }

  const coord = pinCoords[String(loc.pincode || '').trim()];
  if (!coord) return null;
  const pt = [coord[1], coord[0]]; // stored [lat, lon]; geoContains wants [lon, lat]
  for (const { f, bbox } of featBoxes) {
    // geoBounds returns [[west, south], [east, north]].
    if (pt[0] < bbox[0][0] || pt[0] > bbox[1][0] || pt[1] < bbox[0][1] || pt[1] > bbox[1][1]) continue;
    if (!d3.geoContains(f, pt)) continue;
    // State guard: an approximate coordinate landing in a neighbouring
    // district is an acceptable fallback, but landing in a different state
    // means the coordinate is simply wrong -- leave it unmapped instead.
    if (!sameState(loc.state, f.properties.stname)) return null;
    return { key: districtKey(f), rawName: rawName || f.properties.dtname };
  }
  return null;
}

// Redraw with the currently selected metric, from cached data -- no refetch.
function drawDelegateMap() {
  const data = delegateMapData;
  const host = document.getElementById('delegate-map');
  if (!data || !host) return;

  const regBtn = document.getElementById('delegate-map-btn-registered');
  const signBtn = document.getElementById('delegate-map-btn-signedup');
  const active = delegateMapMetric === 'registered';
  if (regBtn) { regBtn.classList.toggle('bg-white', active); regBtn.classList.toggle('shadow-sm', active); regBtn.classList.toggle('text-emerald-700', active); regBtn.classList.toggle('text-slate-500', !active); }
  if (signBtn) { signBtn.classList.toggle('bg-white', !active); signBtn.classList.toggle('shadow-sm', !active); signBtn.classList.toggle('text-amber-700', !active); signBtn.classList.toggle('text-slate-500', active); }

  const intl = data.international || [];
  const intlReg = intl.reduce((n, c) => n + (c.registered || 0), 0);
  const intlSign = intl.reduce((n, c) => n + (c.signedup || 0), 0);
  setText('delegate-map-summary',
    `${data.totalReg} registered · ${data.totalSign} signed up only across ${data.districtCount} districts`
    + (data.unmatched.length ? ` (${data.unmatched.length} not shown — unmapped location: ${data.unmatched.slice(0, 3).join(', ')}${data.unmatched.length > 3 ? '…' : ''})` : ''));

  // International delegates, listed under the map rather than on it. Hidden
  // entirely when there are none, so the panel doesn't sit empty for what is
  // currently every conference.
  const intlBox = document.getElementById('delegate-map-international');
  if (intlBox) {
    intlBox.classList.toggle('hidden', intl.length === 0);
    if (intl.length) {
      intlBox.innerHTML =
        `<p class="text-xs font-bold text-slate-600 mb-1.5">${ICON('globe')}International — ${intlReg} registered · ${intlSign} signed up only <span class="font-normal text-slate-400">(not shown on the map)</span></p>`
        + `<div class="flex flex-wrap gap-1.5">${intl.map((c) => `
             <span class="inline-flex items-center gap-1.5 bg-white border border-slate-200 rounded-full px-2.5 py-1 text-[11px]">
               <span class="font-semibold text-slate-700">${esc(c.country)}</span>
               <span class="text-emerald-700 font-bold">${c.registered}</span>
               ${c.signedup ? `<span class="text-amber-600">+${c.signedup}</span>` : ''}
             </span>`).join('')}</div>`;
    }
  }

  const W = 680, H = 720;
  host.innerHTML = '';
  // width/height ATTRIBUTES (not just viewBox) give the SVG an intrinsic
  // aspect ratio -- without them, height:auto can't resolve and the browser
  // falls back to a ~150px default, rendering the whole map tiny.
  const svg = d3.select(host).append('svg')
    .attr('viewBox', `0 0 ${W} ${H}`).attr('width', W).attr('height', H)
    .attr('preserveAspectRatio', 'xMidYMid meet')
    .style('width', '100%').style('height', 'auto').style('display', 'block').style('overflow', 'hidden');
  const tip = d3.select(host).append('div')
    .style('position', 'absolute').style('pointer-events', 'none').style('opacity', 0)
    .style('background', '#fff').style('border', '0.5px solid #cbd5e1').style('border-radius', '8px')
    .style('padding', '6px 10px').style('font-size', '12px').style('color', '#0f172a')
    .style('box-shadow', '0 2px 8px rgba(0,0,0,.15)').style('white-space', 'nowrap');

  const proj = d3.geoMercator().fitExtent([[10, 10], [W - 10, H - 10]], data.feat);
  const path = d3.geoPath(proj);
  const metricKey = delegateMapMetric;
  const colors = DELEGATE_MAP_COLORS[metricKey];

  const districts = data.feat.features.map((f) => {
    const key = districtKey(f);
    const rec = data.byKey.get(key);
    return {
      f, key, name: f.properties.dtname, rec, value: rec ? rec[metricKey] : 0,
      // The host district, by name -- Wardha is unique, and this is about
      // marking the venue rather than matching a delegate to a polygon.
      host: String(f.properties.dtname || '').toLowerCase().trim() === 'wardha',
    };
  });
  const maxVal = Math.max(1, ...districts.map((d) => d.value));
  // Sqrt scale (not linear): with a handful of very high districts and many
  // low ones, a linear scale crams every low value into the first few percent
  // of the ramp, right where it's least distinguishable from "no data". Sqrt
  // spreads the low end out so a 1 and a 5 are visibly different colors.
  const color = d3.scaleSequentialSqrt().domain([1, maxVal]).interpolator(d3.interpolateRgb(colors.ramp[0], colors.ramp[1])).clamp(true);

  svg.append('g').selectAll('path').data(districts).join('path')
    .attr('d', (d) => path(d.f))
    .attr('fill', (d) => d.value > 0 ? color(d.value) : colors.empty)
    .attr('stroke', (d) => d.host ? '#ea580c' : '#fff').attr('stroke-width', (d) => d.host ? 1.6 : 0.5)
    .style('cursor', (d) => d.rec ? 'pointer' : 'default')
    .on('mousemove', (ev, d) => {
      if (!d.rec) return;
      const b = host.getBoundingClientRect();
      // State on the tooltip too: with six names shared between two states,
      // "Aurangabad" alone doesn't say which Aurangabad you're hovering.
      tip.style('opacity', 1).html(`<b>${esc(d.rec.rawName || d.name)}</b><br><span style="color:#64748b">${esc(titleCaseState(d.f.properties.stname))}</span><br>${d.rec.registered} registered · ${d.rec.signedup} signed up`)
        .style('left', (ev.clientX - b.left + 12) + 'px').style('top', (ev.clientY - b.top - 6) + 'px');
    })
    .on('mouseleave', () => tip.style('opacity', 0));

  // State borders, over the district fills but under the labels (see the
  // meshes cached in renderDelegateMap). fill:none matters -- a mesh is a
  // single MultiLineString, and filling it would flood the map.
  svg.append('path')
    .attr('d', path(data.stateMesh))
    .attr('fill', 'none')
    .attr('stroke', '#94a3b8')
    .attr('stroke-width', 1)
    .attr('stroke-linejoin', 'round')
    .style('pointer-events', 'none');   // never steal hover from the districts

  svg.append('path')
    .attr('d', path(data.outline))
    .attr('fill', 'none')
    .attr('stroke', '#64748b')
    .attr('stroke-width', 1.2)
    .attr('stroke-linejoin', 'round')
    .style('pointer-events', 'none');

  // Number labels at every colored district's centroid -- every district
  // with a non-zero value for the active metric gets a label, always (an
  // empty district showing "0" everywhere would bury the real numbers in
  // noise, so those stay unlabeled). A white halo (paint-order stroke) keeps
  // each number legible over its fill color; two adjacent small districts can
  // still sit close together, but nothing is ever hidden.
  const labeled = districts.filter((d) => d.value > 0).sort((a, b) => b.value - a.value);
  svg.append('g').selectAll('text').data(labeled).join('text')
    .attr('transform', (d) => `translate(${path.centroid(d.f)})`)
    .attr('text-anchor', 'middle').attr('dy', '0.32em')
    .attr('font-size', '9.5px').attr('font-weight', '700').attr('fill', '#1e293b')
    .attr('paint-order', 'stroke').attr('stroke', '#fff').attr('stroke-width', 2.5).attr('stroke-linejoin', 'round')
    .style('pointer-events', 'none')
    .text((d) => d.value);

  // Legend: a small gradient bar for the active metric's color scale.
  const legend = document.getElementById('delegate-map-legend');
  if (legend) {
    legend.innerHTML = `
      <span class="text-[10px] text-slate-500">0</span>
      <span class="inline-block w-24 h-2.5 rounded-full" style="background:linear-gradient(to right, ${colors.ramp[0]}, ${colors.ramp[1]})"></span>
      <span class="text-[10px] text-slate-500">${maxVal}</span>
      <span class="text-[10px] text-slate-400 ml-1">${metricKey === 'registered' ? 'delegates registered' : 'signed up only'}</span>`;
  }
}

function setDelegateMapMetric(metric) {
  delegateMapMetric = metric;
  drawDelegateMap();
}

// --- PAYMENT REVIEW MODAL (verify / force-verify / reject entry point) ---
let reviewTargetId = null;

function openReviewModal(id) {
  const p = cachedPaymentRegs.find((r) => String(r.id) === String(id));
  if (!p) return;
  reviewTargetId = id;

  setText('review-title', p.is_flagged ? 'Review registration (flagged)' : 'Review registration');
  setText('review-name', p.delegate_name);
  setText('review-category', p.category_label);
  setText('review-regno', p.registration_number ? ` · ${p.registration_number}` : '');
  // One claim, no per-payment rows (an older registration): shown on its own.
  const legacyClaim = document.getElementById('review-claim-legacy');
  if (legacyClaim) legacyClaim.classList.toggle('hidden', (p.transactions || []).length > 0);
  // Context for the decision, not the decision itself -- one wrapped line
  // rather than four labelled cells. Blank fields drop out entirely instead
  // of rendering a row of em-dashes.
  setText('review-demographics', [
    p.delegate_designation,
    p.delegate_institution,
    p.delegate_age != null && p.delegate_age !== '' ? `${p.delegate_age}y` : null,
    p.delegate_gender,
  ].filter(Boolean).join(' · '));
  setText('review-mode', PAYMENT_MODE_LABELS[p.payment_mode] || p.payment_mode || 'UPI');
  setText('review-amount', `₹${inr(Number(p.paid_amount))}` + (p.expected_amount != null && Number(p.paid_amount) !== Number(p.expected_amount) ? ` (expected ₹${inr(Number(p.expected_amount))})` : ''));
  setText('review-utr', p.utr_number);
  setText('review-date', fmtAuditTime(p.submitted_at) || '—');

  // Evidence pane: every document for this registration, one tab each, reset
  // and reselected from scratch on every open so the previous delegate's
  // chosen tab and zoom don't carry over. The first couple are fetched into
  // memory immediately -- these endpoints are served Cache-Control: no-store
  // (payment evidence shouldn't sit in the browser's disk cache), so a plain
  // <img src> swap would be a real, uncached network round trip on each tab
  // click. See buildReviewEvidence.
  buildReviewEvidence(p);

  // Automated check verdicts, shown against the field each one is about.
  // NEFT/RTGS slips carry no VPA to read, so Mode gets no mark at all there
  // -- a dash would imply a check that could have run and didn't.
  setHTML('review-amount-check', reviewAmountMark(p.ocr_amount_status, p.ocr_amount_match));
  setHTML('review-utr-check', reviewCheckMark(p.ocr_utr_match, 'The transaction ID'));
  setHTML('review-mode-check', p.payment_mode === 'NEFT_RTGS' ? '' : reviewCheckMark(p.ocr_vpa_match, 'The UPI ID'));

  renderReviewFeeAdjust(p);

  const flaggedNote = document.getElementById('review-flagged-note');
  if (flaggedNote) flaggedNote.classList.toggle('hidden', !p.is_flagged);

  // Rejecting an already-rejected registration doesn't mean anything --
  // that action is only offered while a decision is still pending.
  const rejectBtn = document.getElementById('review-reject-btn');
  if (rejectBtn) rejectBtn.classList.toggle('hidden', p.bank_status === 'REJECTED');

  // Un-approve: only for a currently-verified registration (reverting a
  // decision that's already been made). The Accept/Reject buttons are
  // meaningless on an already-verified record, so hide them in that state
  // and offer un-approve instead.
  const isVerified = p.bank_status === 'BANK_VERIFIED';
  const unapproveBtn = document.getElementById('review-unapprove-btn');
  const acceptBtn = document.getElementById('review-accept-btn');
  if (unapproveBtn) unapproveBtn.classList.toggle('hidden', !(can('payments.unapprove') && isVerified));
  // Un-reject: the same reversal for a rejected registration, same key.
  const unrejectBtn = document.getElementById('review-unreject-btn');
  if (unrejectBtn) unrejectBtn.classList.toggle('hidden', !(can('payments.unapprove') && p.bank_status === 'REJECTED'));
  if (isVerified) {
    if (acceptBtn) acceptBtn.classList.add('hidden');
    if (rejectBtn) rejectBtn.classList.add('hidden');
  } else if (acceptBtn) {
    acceptBtn.classList.remove('hidden');
  }

  // Revise Payment: request the outstanding balance from a delegate who's
  // short of the fee -- whether that's because their category (and so the
  // fee) changed, or simply because their actual bank credit fell short of
  // what they claimed (a genuine partial payment, e.g. Priyanka Pothare:
  // claimed ₹2,000, the linked credit only had ₹750). Both look the same
  // here: a linked/verified total that doesn't cover expected_amount. Not
  // gated to category_locked -- the server endpoint never required that
  // either. Enabled only once the existing payment is linked (acknowledged),
  // so the balance is against what they've actually paid -- not the claim.
  const reviseBtn = document.getElementById('review-revise-btn');
  if (reviseBtn) {
    const txns = p.transactions || [];
    const verified = Number(p.verified_total) || 0;
    const owed = (Number(p.expected_amount) || 0) - verified;
    const hasUnlinkedPending = txns.some((t) => t.txn_status === 'PENDING');
    const showRevise = (p.bank_status === 'PENDING' || p.bank_status === 'PARTIAL_PAYMENT') && txns.length > 0 && owed > 0;
    reviseBtn.classList.toggle('hidden', !showRevise);
    if (showRevise) {
      const canRevise = !hasUnlinkedPending && verified > 0;
      reviseBtn.disabled = !canRevise;
      reviseBtn.title = canRevise ? '' : 'Link the delegate’s existing payment first';
    }
  }

  // "More" in the footer: shown only when it holds something.
  const more = document.getElementById('review-more');
  if (more) {
    more.open = false;
    more.classList.toggle('hidden', ['review-revise-btn', 'review-unapprove-btn', 'review-unreject-btn']
      .every((id) => { const b = document.getElementById(id); return !b || b.classList.contains('hidden'); }));
  }

  renderReviewIdVerification(p);
  // Bank reconciliation is per transaction, inside the ledger.
  renderReviewPaymentProgress(p);
  renderReviewRefunds(p);
  renderReviewCategoryLock(p);
  // Last: reads the reviewGate flags the two renders above just set, so the
  // "what's blocking Accept" list reflects this registration's real state.
  renderReviewStatusStrip(p);
  openModal('modal-review');
}

// --- REVIEW EVIDENCE PANE (screenshot + ID card) ---
// Both documents share the left pane behind a switcher. The ID card used to
// render full-width inside the narrow right column, which made a document
// you have to actually read effectively unreadable.
// Evidence slots, rebuilt per registration by buildReviewEvidence(). Keyed
// dynamically rather than being three fixed slots: 'idcard', plus one
// 'slip<txnId>' for every payment that has a slip on file. A partial payment
// and its top-up therefore each get their own tab, instead of taking turns in
// a single reused one.
let reviewImageUrls = {};
// Blob: URLs for documents already fetched into memory this modal-open --
// see prefetchReviewImages(). Falls back to the plain API url (a real
// network fetch, same as before) until its prefetch resolves.
let reviewImageBlobUrls = {};
// [{ key, label }] in tab order -- the order the reviewer works through them.
let reviewImageTabs = [];
let reviewImageZoomed = false;
let reviewImageWhich = '';
// The documents opened this time: each tab says Seen or Not opened.
let reviewImageSeen = new Set();

// Build this registration's evidence tabs and show the first one.
function buildReviewEvidence(p) {
  // Revoke the previous delegate's blobs first -- otherwise every review this
  // session leaks one per document.
  Object.values(reviewImageBlobUrls).forEach((u) => { if (u) URL.revokeObjectURL(u); });
  reviewImageUrls = {};
  reviewImageBlobUrls = {};
  reviewImageTabs = [];

  // ID card first, and selected by default. For a student category the ID is
  // the first question the reviewer has to answer -- it gates Accept & Verify
  // -- which is why it is also the first section of the detail column.
  // icon and label are kept APART, not pre-concatenated. They end up in two
  // different sinks -- innerHTML for the tab strip, and the solo label -- and
  // a single combined string forced both to choose between escaping the
  // delegate-facing text or letting the icon's SVG through. Split, each half
  // gets the treatment it needs: the icon is our own markup and goes in raw,
  // the text is escaped. (Pre-concatenated, both sinks escaped the whole
  // thing and printed the raw <svg ...> source into the button.)
  if (p.has_id_card) {
    reviewImageTabs.push({ key: 'idcard', icon: ICON('idbadge'), label: 'ID Card' });
    reviewImageUrls.idcard = `/api/registrations/${encodeURIComponent(p.id)}/id-card`;
  }
  // Then one tab per payment with a slip, oldest first. Numbered only when
  // there is more than one -- a lone "Payment Slip 1" would imply a missing
  // second slip.
  const slipTxns = (p.transactions || []).filter((t) => t.has_screenshot);
  slipTxns.forEach((t, i) => {
    const key = `slip${t.id}`;
    reviewImageTabs.push({ key, icon: ICON('document'), label: `Payment Slip${slipTxns.length > 1 ? ` ${i + 1}` : ''}` });
    reviewImageUrls[key] = `/api/payment-transactions/${encodeURIComponent(t.id)}/screenshot`;
  });
  // Older registrations predate the per-payment ledger and only have the
  // registration's own screenshot; without this they'd show no slip at all.
  if (!slipTxns.length && p.has_screenshot) {
    reviewImageTabs.push({ key: 'screenshot', icon: ICON('document'), label: 'Payment Slip' });
    reviewImageUrls.screenshot = `/api/registrations/${encodeURIComponent(p.id)}/screenshot`;
  }

  reviewImageZoomed = false;
  reviewImageSeen = new Set();
  setReviewImage(reviewImageTabs.length ? reviewImageTabs[0].key : '');
  prefetchReviewImages();
}

// Both documents are served with Cache-Control: no-store (payment evidence
// shouldn't sit in the browser's disk cache), so a plain <img src> reload
// hits the network every time a reviewer switches tabs -- the delay this
// works around. Fetching each into a blob: URL up front means the switch
// itself is just swapping which already-downloaded image is shown.
function prefetchReviewImages() {
  // Only the first two tabs. With a tab per payment there can be several,
  // and pulling them all down on open would trade the delay this avoids for
  // a larger one; the rest are fetched when their tab is first opened.
  reviewImageTabs.slice(0, 2).forEach(({ key }) => fetchReviewImage(key));
}

// Pull one document into memory as a blob: URL, once.
function fetchReviewImage(key) {
  const url = reviewImageUrls[key];
  if (!url || reviewImageBlobUrls[key]) return;
  fetch(url)
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('fetch failed'))))
    .then((blob) => {
      // The modal may have moved on to a different registration (or closed)
      // by the time this resolves -- only apply it if the URL it was fetched
      // for is still the one assigned to this slot.
      if (reviewImageUrls[key] !== url) return;
      reviewImageBlobUrls[key] = URL.createObjectURL(blob);
      if (reviewImageWhich === key) setReviewImage(key); // clears the spinner if they're already looking at it
    })
    .catch(() => { /* leave it to load the normal way via <img src> */ });
}

function setReviewImage(which) {
  reviewImageWhich = which;
  if (which) reviewImageSeen.add(which);
  const img = document.getElementById('review-screenshot');
  const empty = document.getElementById('review-img-empty');
  const link = document.getElementById('review-img-open-link');
  const loading = document.getElementById('review-img-loading');
  const url = reviewImageUrls[which] || '';
  const blobUrl = reviewImageBlobUrls[which];
  const displayUrl = blobUrl || url;

  if (loading) loading.classList.toggle('hidden', !url || !!blobUrl);
  if (empty) {
    empty.textContent = 'No image on file.';
    empty.classList.toggle('hidden', !!url);
  }
  if (img) {
    img.classList.toggle('hidden', !displayUrl);
    if (displayUrl) {
      img.onload = () => { if (loading) loading.classList.add('hidden'); };
      // A referenced file that isn't on disk: 2 of the live ledger's slips
      // are orphaned this way (the file was cleaned up on a resubmission
      // while the row kept its name). Say so, rather than leaving an empty
      // dark pane that looks like the app is still loading or broken.
      img.onerror = () => {
        if (loading) loading.classList.add('hidden');
        img.classList.add('hidden');
        if (empty) {
          empty.textContent = 'This file is no longer on file — it was removed when the payment was resubmitted.';
          empty.classList.remove('hidden');
        }
      };
      img.src = displayUrl;
    }
  }
  // Open ↗ always uses the real (session-authenticated) API url, never the
  // blob: one -- a blob: URL is only valid inside this tab and won't
  // resolve if opened in a new one.
  if (link) { link.href = url; link.classList.toggle('hidden', !url); }
  // Nothing to zoom or open on a ₹0 registration (fully discounted -- no
  // screenshot was ever required), so don't offer controls that do nothing.
  const zoomBtn = document.getElementById('review-img-zoom-btn');
  if (zoomBtn) zoomBtn.classList.toggle('hidden', !url);

  // The switcher is a real toggle only when there's more than one document
  // to choose between. With exactly one (the common case: no ID card
  // required, no slip opened) it collapses to a plain label, so the pane
  // never shows an inert single-option control.
  // A tab that hasn't been prefetched yet (the third slip, say) starts
  // downloading the moment it's opened; the spinner covers the wait.
  fetchReviewImage(which);

  const multi = reviewImageTabs.length > 1;
  const switcher = document.getElementById('review-img-switcher');
  const soloLabel = document.getElementById('review-img-solo-label');
  const tabsBox = document.getElementById('review-img-tabs');
  if (switcher) {
    // A one-document registration gets a plain label instead of an inert
    // single-option control.
    switcher.classList.toggle('hidden', !multi);
    switcher.classList.toggle('flex', multi);
  }
  if (soloLabel) {
    // innerHTML, not textContent: the label carries an icon. textContent
    // printed the icon's SVG source into the page as literal text.
    const solo = reviewImageTabs.length === 1 ? reviewImageTabs[0] : null;
    soloLabel.innerHTML = solo ? solo.icon + esc(solo.label) : '';
    soloLabel.classList.toggle('hidden', multi || !solo);
  }
  // Active-tab styling written out by hand rather than toggled via a class,
  // so the inactive state stays legible on the dark pane.
  if (tabsBox) {
    tabsBox.innerHTML = reviewImageTabs.map(({ key, icon, label }) => {
      const active = key === which;
      // icon is our own markup (ICON()) and goes in as-is; only the text is
      // escaped. Escaping the pair together printed the SVG source instead.
      const seen = reviewImageSeen.has(key);
      return `<button type="button" role="tab" aria-selected="${active}" onclick="setReviewImage('${esc(key)}')" class="flex items-center gap-1.5 h-10 px-3 rounded-lg text-sm font-bold transition ${
        active ? 'bg-white text-slate-900 shadow-sm' : 'border border-slate-600 text-slate-200 hover:text-white hover:bg-slate-700'}">${icon || ''}${esc(label)}<span class="font-semibold ${seen ? (active ? 'text-emerald-700' : 'text-emerald-300') : 'text-amber-300'}">· ${seen ? 'Seen' : 'Not opened'}</span></button>`;
    }).join('');
  }
  // Nudges a reviewer looking at a payment slip to also open the ID card --
  // the document that actually gates Accept & Verify for a student category
  // -- rather than letting it go unnoticed as a small inactive tab. Clears
  // itself the moment they switch to it.
  // (The old "check both" nudge is the tabs' own Seen / Not opened now.)
  applyReviewImageZoom();
}

// Fit (object-contain) vs natural size inside a scrollable box -- a real
// 1:1 zoom you can pan, which is what a low-resolution ID card needs.
function applyReviewImageZoom() {
  const img = document.getElementById('review-screenshot');
  const box = document.getElementById('review-img-box');
  const btn = document.getElementById('review-img-zoom-btn');
  if (!img || !box) return;
  if (reviewImageZoomed) {
    img.className = 'max-w-none max-h-none w-auto h-auto';
    box.className = 'flex-1 min-h-0 overflow-auto p-1';
  } else {
    img.className = 'max-h-full max-w-full object-contain';
    box.className = 'flex-1 min-h-0 overflow-auto flex items-center justify-center p-1';
  }
  if (btn) btn.innerHTML = ICON('search') + (reviewImageZoomed ? 'Fit' : 'Zoom');
}

// Opens ONE ledger payment's own slip in the evidence pane. Each payment now
// has its own tab there (see buildReviewEvidence), so this is just a jump to
// it -- the same document the reviewer could reach from the tab strip, which
// keeps the two routes showing the same thing.
function showTxnSlip(txnId) {
  setReviewImage(`slip${txnId}`);
}

function toggleReviewImageZoom() {
  reviewImageZoomed = !reviewImageZoomed;
  applyReviewImageZoom();
}

// --- REVIEW DECISION STRIP ---
// What was owed, what's actually in, and (via updateReviewAcceptGate) what
// is still blocking Accept & Verify. Previously the Accept button just sat
// disabled with no explanation of which requirement was unmet.
function renderReviewStatusStrip(p) {
  const strip = document.getElementById('review-status-strip');
  if (!strip) return;
  const fee = Number(p.expected_amount) || 0;
  const paid = Number(p.verified_total) || 0;
  const balance = Math.max(0, fee - paid);

  setText('review-strip-fee', `₹${inr(fee)}`);
  setText('review-strip-paid', `₹${inr(paid)}`);
  const balWrap = document.getElementById('review-strip-balance-wrap');
  if (balWrap) balWrap.classList.toggle('hidden', balance <= 0);
  setText('review-strip-balance', `₹${inr(balance)}`);

  // The status, in the header beside who this is. Same pill shape as the
  // approval list (see paymentRowHtml).
  const verdict = document.getElementById('review-strip-verdict');
  const TONE = {
    BANK_VERIFIED: ['Verified', 'bg-emerald-100 text-emerald-800 border-emerald-300'],
    REJECTED: ['Rejected', 'bg-rose-100 text-rose-800 border-rose-300'],
    PARTIAL_PAYMENT: ['Balance due', 'bg-rose-100 text-rose-800 border-rose-300'],
    PENDING: ['Awaiting decision', 'bg-amber-100 text-amber-800 border-amber-300'],
  };
  const [label, pillTone] = TONE[p.bank_status] || TONE.PENDING;
  if (verdict) verdict.className = `shrink-0 self-center text-xs font-bold px-2.5 py-1 rounded-full border ${pillTone}`;
  if (verdict) verdict.textContent = label;

  updateReviewAcceptGate();
}

// The reconciliation surface: fee/verified/balance summary plus the
// per-transaction ledger, where each payment is linked 1-to-1 to its bank
// statement credit. This supersedes the legacy registration-level link
// section (hidden here). Always shown in the review modal when transactions
// exist, since linking is required before verifying.
let reviewTxns = [];
let reviewRegVerified = false;
function renderReviewPaymentProgress(p) {
  const wrap = document.getElementById('review-payment-progress');
  const ledger = document.getElementById('review-txn-ledger');
  const txns = p.transactions || [];
  reviewTxns = txns;
  reviewRegVerified = p.bank_status === 'BANK_VERIFIED';
  const fee = Number(p.expected_amount) || 0;
  const verifiedTotal = Number(p.verified_total) || 0;
  const remaining = Number(p.remaining != null ? p.remaining : Math.max(0, fee - verifiedTotal));

  if (wrap) wrap.classList.toggle('hidden', txns.length === 0);
  if (ledger && txns.length) {
    setText('review-progress-summary', `₹${inr(verifiedTotal)} / ₹${inr(fee)}${remaining > 0 ? ` · ₹${inr(remaining)} due` : ' · fully paid'}`);
    ledger.innerHTML = txns.map((t, i) => reviewTxnRowHtml(t, i)).join('');
    // The credits each unlinked bank payment could be, ready in its card.
    if (can('payments.link')) {
      txns.filter((t) => t.txn_status === 'PENDING' && t.bank_txn_id == null && t.payment_mode !== 'CASH').forEach((t) => toggleTxnCandidates(t.id));
    }
  }

  // Verify gate: no unacknowledged (pending) payments may remain -- linking a
  // payment to its bank credit is what acknowledges it. Server also enforces
  // that the acknowledged total covers the fee.
  const pending = txns.filter((t) => t.txn_status === 'PENDING');
  reviewGate.linked = txns.length === 0 ? !!p.bank_txn_id : pending.length === 0;
  updateReviewAcceptGate();
}

// Excess this delegate paid (see getPaymentSummary's overpaid, netted off
// verifiedTotal once refunded) plus the history of what's already been
// recorded as sent back. Bookkeeping only -- recording a refund here never
// moves money; it's the admin telling the app what already happened
// elsewhere. Shown whenever there's currently outstanding excess or any
// refund has ever been recorded, so the history stays visible even after
// the excess is fully refunded.
// Cache of the candidate debit rows currently offered in the select, keyed
// by their bank_statement_transactions.id -- recordRefund() reads a
// selected debit's own amount from here to cap/default the refund amount,
// rather than re-fetching.
let reviewRefundCandidates = [];
let reviewRefundOverpaid = 0;

async function renderReviewRefunds(p) {
  const wrap = document.getElementById('review-refund-section');
  if (!wrap) return;
  const overpaid = Number(p.overpaid) || 0;
  const refunds = p.refunds || [];
  wrap.classList.toggle('hidden', overpaid <= 0 && refunds.length === 0);
  if (overpaid <= 0 && refunds.length === 0) return;

  const excessLine = document.getElementById('review-refund-excess-line');
  if (excessLine && overpaid > 0) {
    // A refund must now be backed by a real, unlinked debit row from the
    // imported bank statement (see POST /api/registrations/:id/refund) --
    // fetch what's available rather than accepting a free-typed amount.
    const data = await (await fetch(`/api/registrations/${encodeURIComponent(p.id)}/refund-candidates`)).json();
    reviewRefundCandidates = data.transactions || [];
    excessLine.innerHTML = `<span class="font-bold text-amber-700">₹${inr(overpaid)} excess still outstanding</span>
       <div class="mt-1 space-y-1">
         ${reviewRefundCandidates.length
        ? `<select id="review-refund-txn" onchange="onReviewRefundTxnChange()" class="w-full p-1 border rounded text-[10px]">
               ${reviewRefundCandidates.map((t) => `<option value="${esc(t.id)}">${esc(t.post_date)} · ₹${inr(t.debit)}${t.description ? ' · ' + esc(String(t.description).slice(0, 40)) : ''}</option>`).join('')}
             </select>`
        : `<p class="text-rose-600 font-semibold">No unlinked debit found in the imported bank statement. Import the latest statement (Settings → Bank Reconciliation) once this refund has actually been paid out, then come back here.</p>`}
         <div class="flex items-center gap-1">
           <input type="number" min="0.01" step="0.01" id="review-refund-amount" ${reviewRefundCandidates.length ? '' : 'disabled'} class="w-24 p-1 border rounded text-[10px]">
           <input type="text" placeholder="Reference / note (optional)" id="review-refund-note" ${reviewRefundCandidates.length ? '' : 'disabled'} class="flex-1 min-w-0 p-1 border rounded text-[10px]">
           <button type="button" onclick="recordRefund()" ${reviewRefundCandidates.length ? '' : 'disabled'} class="shrink-0 px-2 py-1 bg-navy hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold rounded text-[10px]">Record Refund</button>
         </div>
       </div>`;
    reviewRefundOverpaid = overpaid;
    if (reviewRefundCandidates.length) onReviewRefundTxnChange();
  } else if (excessLine) {
    excessLine.innerHTML = `<span class="text-emerald-700 font-semibold">${ICON('check')}No outstanding excess</span>`;
  }

  const historyBox = document.getElementById('review-refund-history');
  if (historyBox) {
    historyBox.innerHTML = refunds.length ? refunds.map((r) => `
      <div class="flex items-center justify-between gap-2 py-1 text-[10px] border-t border-slate-100">
        <span class="text-slate-600">${esc(fmtAuditTime(r.refunded_at))} · ₹${inr(esc(r.amount))}${r.bank_txn_date ? ` · debit ${esc(r.bank_txn_date)}` : ''}${r.reference_note ? ` · ${esc(r.reference_note)}` : ''} <span class="text-slate-400">(${esc(r.refunded_by || '—')})</span></span>
        <button type="button" onclick="deleteRefund(${esc(r.id)})" class="shrink-0 text-rose-600 hover:underline font-semibold">Undo</button>
      </div>`).join('') : '';
  }
}

// The refund amount can't exceed either the outstanding excess or the
// selected debit's own amount, whichever is smaller -- re-capped every time
// the picked debit changes.
function onReviewRefundTxnChange() {
  const sel = document.getElementById('review-refund-txn');
  const amountInput = document.getElementById('review-refund-amount');
  if (!sel || !amountInput) return;
  const txn = reviewRefundCandidates.find((t) => String(t.id) === sel.value);
  const cap = Math.min(reviewRefundOverpaid, txn ? Number(txn.debit) || 0 : reviewRefundOverpaid);
  amountInput.max = cap;
  amountInput.value = cap;
}

async function recordRefund() {
  const txnSelect = document.getElementById('review-refund-txn');
  const amountInput = document.getElementById('review-refund-amount');
  const noteInput = document.getElementById('review-refund-note');
  const bankTxnId = txnSelect ? txnSelect.value : null;
  if (!bankTxnId) return showToast('Select the debit transaction this refund was paid out on.');
  const amount = amountInput ? Number(amountInput.value) : 0;
  if (!Number.isFinite(amount) || amount <= 0) return showToast('Enter a valid refund amount.');
  if (!(await showConfirm(`Record a ₹${inr(amount)} refund for this registration, against the selected debit? This only logs that it happened -- it doesn't send any money.`))) return;
  const data = await (await fetch(`/api/registrations/${encodeURIComponent(reviewTargetId)}/refund`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount, bankTxnId, note: noteInput ? noteInput.value.trim() : '' }),
  })).json();
  if (!data.success) return showToast(data.error || 'Could not record this refund.');
  showToast('Refund recorded.', 'success');
  await renderBackendPayments();
  openReviewModal(reviewTargetId);
}

async function deleteRefund(refundId) {
  if (!(await showConfirm('Undo this refund record?'))) return;
  const data = await (await fetch(`/api/registrations/${encodeURIComponent(reviewTargetId)}/refund/${encodeURIComponent(refundId)}`, { method: 'DELETE' })).json();
  if (!data.success) return showToast(data.error || 'Could not undo this refund.');
  showToast('Refund record removed.', 'success');
  await renderBackendPayments();
  openReviewModal(reviewTargetId);
}

// One payment, as a step of the review: what the delegate says (amount,
// mode, transaction ID, each with its automated check) beside what the bank
// shows (the linked credit, or the credits to link it to). Linking a payment
// to its bank credit is what acknowledges it.
function reviewTxnRowHtml(t, i = 0) {
  const amt = t.txn_status === 'VERIFIED' && t.verified_amount != null ? t.verified_amount : t.amount;
  const linked = t.bank_txn_id != null;
  const isRejected = t.txn_status === 'REJECTED';
  // Cash was acknowledged when it was taken at the desk; what is left is only
  // whether it has been BANKED, reconciled in bulk from the Bank Statement tab.
  const isCash = t.payment_mode === 'CASH';
  const done = t.txn_status === 'VERIFIED';
  const n = reviewStepOffset + i + 1;
  const mode = PAYMENT_MODE_LABELS[t.payment_mode] || t.payment_mode || 'UPI';
  const badge = `<span aria-hidden="true" class="w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-sm font-bold text-white ${done ? 'bg-emerald-700' : isRejected ? 'bg-slate-400' : 'bg-navy'}">${done ? '✓' : esc(n)}</span>`;
  const state = done ? '<span class="text-sm font-bold text-emerald-800">Done</span>'
    : isRejected ? '<span class="text-sm font-bold text-slate-500">Rejected</span>' : '<span class="text-sm font-bold text-amber-800">To do</span>';
  // Each payment keeps its own slip; opening it shows it in the documents.
  const slipBtn = t.has_screenshot
    ? `<button type="button" class="shrink-0 h-9 px-3 rounded-lg border border-navy text-navy hover:bg-indigo-50 text-sm font-semibold" onclick="showTxnSlip(${esc(t.id)})">View slip</button>`
    : '<span class="text-xs text-slate-500">No slip on file</span>';
  const says = isCash
    ? `<p>₹${inr(Number(t.amount))} in cash${t.collected_by ? `, taken by ${esc(t.collected_by)}` : ''}</p>`
    : `<p class="flex items-center gap-1.5">${reviewCheckMark(t.ocr_amount_match, 'The amount')}<span>₹${inr(Number(t.amount))} by ${esc(mode)}</span></p>
       ${t.payment_mode === 'NEFT_RTGS' ? '' : `<p class="flex items-center gap-1.5">${reviewCheckMark(t.ocr_vpa_match, 'The UPI ID')}<span>UPI ID on the slip</span></p>`}
       ${t.utr_number ? `<p class="flex items-center gap-1.5 min-w-0">${reviewCheckMark(t.ocr_utr_match, 'The transaction ID')}<span class="font-mono text-[13px] break-all">${esc(t.utr_number)}</span></p>` : ''}`;
  // The bank statement's own line: the authoritative record of what arrived.
  const shows = linked
    ? `<p class="font-semibold text-emerald-800">${ICON('link')}${isCash ? 'Banked: ' : ''}₹${inr(esc(t.bank_txn_credit != null ? t.bank_txn_credit : ''))} on ${esc(t.bank_txn_date || '')}</p>
       ${t.bank_txn_description ? `<p class="font-mono text-[13px] text-slate-600 truncate" title="${esc(t.bank_txn_description)}">${esc(t.bank_txn_description)}</p>` : ''}
       ${reviewRegVerified || isCash ? '' : `<button type="button" class="text-sm text-rose-700 hover:underline font-semibold" onclick="unlinkTxn(${esc(t.id)})">Unlink</button>`}`
    : isRejected
      ? '<p class="text-slate-500">Rejected — not linked</p>'
      : isCash
        ? '<p class="text-slate-600">Not yet banked — reconciled from the Bank Statement tab</p>'
        : `<p class="font-semibold text-amber-800">Not linked yet. Pick the credit:</p>
           <div id="txn-candidates-${esc(t.id)}" class="space-y-1.5"><p class="text-xs text-slate-500">Looking for matching credits…</p></div>`;
  return `<article class="rounded-xl p-4 space-y-3 ${done ? 'border border-emerald-200 bg-emerald-50/40' : isRejected ? 'border border-slate-200 bg-slate-50' : 'border-2 border-gold-500'}">
    <div class="flex items-center gap-2.5">
      ${badge}
      <h4 class="flex-1 min-w-0 text-base font-bold text-slate-900">Payment ${esc(i + 1)} · ₹${inr(Number(amt))} · ${esc(mode)}</h4>
      ${state}
    </div>
    <div class="grid sm:grid-cols-2 gap-3 text-sm">
      <div class="space-y-1 min-w-0">
        <p class="text-xs font-bold text-slate-500">The delegate says</p>
        ${says}
        <p class="text-xs text-slate-500">Submitted ${esc(fmtAuditTime(t.submitted_at) || '—')}</p>
      </div>
      <div class="space-y-1 min-w-0">
        <p class="text-xs font-bold text-slate-500">The bank shows</p>
        ${shows}
      </div>
    </div>
    <div class="flex justify-end">${slipBtn}</div>
  </article>`;
}

// The credits a payment could be: fetched when its card is drawn, best match
// first -- the delegate's transaction ID in the bank's description, then the
// exact amount -- three shown, the rest a tap away. The server is still the
// gate when linking.
const reviewCandidates = {};
async function toggleTxnCandidates(txnId) {
  const box = document.getElementById(`txn-candidates-${txnId}`);
  if (!box) return;
  box.innerHTML = '<p class="text-xs text-slate-500">Looking for matching credits…</p>';
  let rows;
  try {
    const res = await fetch(`/api/payment-transactions/${encodeURIComponent(txnId)}/candidates`);
    if (!res.ok) throw new Error('candidates');
    rows = (await res.json()).transactions || [];
  } catch (e) {
    box.innerHTML = '<p class="text-xs text-rose-700">Could not load the bank credits. Close and open this again.</p>';
    return;
  }
  const t = (reviewTxns || []).find((x) => String(x.id) === String(txnId)) || {};
  reviewCandidates[txnId] = rankTxnCandidates(t, rows);
  drawTxnCandidates(txnId, false);
}
// Score: the reference (the delegate's transaction ID, or its last six
// digits) in the bank's description; the amount within a rupee. Stable, so
// the server's order (closest amount, then latest) breaks ties.
function rankTxnCandidates(t, rows) {
  const utr = String(t.utr_number || '').replace(/\s+/g, '');
  const tail = utr.length >= 6 ? utr.slice(-6) : utr;
  return rows.map((c, i) => {
    const desc = String(c.description || '').replace(/\s+/g, '');
    const ref = !!tail && desc.includes(tail);
    const amount = Math.abs(Number(c.remaining) - Number(t.amount)) < 1;
    return { ...c, ref, amount, i };
  }).sort((a, b) => (Number(b.ref) * 2 + Number(b.amount)) - (Number(a.ref) * 2 + Number(a.amount)) || a.i - b.i);
}
function drawTxnCandidates(txnId, all) {
  const box = document.getElementById(`txn-candidates-${txnId}`);
  const rows = reviewCandidates[txnId] || [];
  if (!box) return;
  if (!rows.length) { box.innerHTML = '<p class="text-xs text-slate-500">No unused credits in the bank statement yet. Import the latest statement, then open this again.</p>'; return; }
  const shown = all ? rows : rows.slice(0, 3);
  box.innerHTML = shown.map((c, k) => {
    const best = k === 0 && (c.ref || c.amount);
    const why = c.ref && c.amount ? 'Best match: amount and reference' : c.ref ? 'Best match: reference' : c.amount ? 'Amount matches' : '';
    return `<div class="flex items-center gap-2 rounded-lg px-2.5 py-2 ${best ? 'border border-gold-500 bg-gold-50' : 'border border-slate-200'}">
      <div class="flex-1 min-w-0 text-[13px]">
        <p><b>₹${inr(esc(c.remaining))}</b>${c.remaining !== c.credit ? ` of ₹${inr(esc(c.credit))}` : ''} · ${esc(c.post_date)}</p>
        <p class="font-mono text-slate-600 truncate" title="${esc(c.description)}">${esc(c.description)}</p>
        ${why && k === 0 ? `<p class="text-xs font-bold text-gold-700">${why}</p>` : ''}
      </div>
      <button type="button" class="shrink-0 h-9 px-3 rounded-lg text-sm font-semibold ${best ? 'bg-navy hover:bg-indigo-700 text-white' : 'border border-navy text-navy hover:bg-indigo-50'}" onclick="linkTxnToBank(${esc(txnId)}, ${esc(c.id)})">Link</button>
    </div>`;
  }).join('') + (!all && rows.length > 3 ? `<button type="button" class="text-sm font-semibold text-navy underline" onclick="drawTxnCandidates(${esc(txnId)}, true)">Show ${rows.length - 3} more</button>` : '');
}

async function linkTxnToBank(txnId, bankId) {
  const data = await (await fetch(`/api/payment-transactions/${encodeURIComponent(txnId)}/link`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bankTxnId: bankId }),
  })).json();
  if (!data.success) return showToast(data.error || 'Could not link this transaction.');
  await renderBackendPayments();
  openReviewModal(reviewTargetId);
}

async function unlinkTxn(txnId) {
  if (!(await showConfirm('Unlink this payment from its bank transaction?'))) return;
  const data = await (await fetch(`/api/payment-transactions/${encodeURIComponent(txnId)}/link`, { method: 'DELETE' })).json();
  if (!data.success) return showToast(data.error || 'Could not unlink.');
  await renderBackendPayments();
  openReviewModal(reviewTargetId);
}

// Admin-initiated: unlike toggleTxnCandidates/linkTxnToBank above, there's no
// existing payment_transactions row to attach a candidate to here -- picking
// one creates the row and links it in the same request (see
// POST .../admin-add-payment). Reuses the same unused-credits query as the
// legacy registration-level picker (candidate-transactions), just for a new
// purpose.
async function toggleAdminAddPayment() {
  const box = document.getElementById('review-admin-add-payment-box');
  if (!box) return;
  if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.innerHTML = '<p class="text-[10px] text-slate-400 p-2">Loading candidates…</p>';
  const res = await fetch(`/api/registrations/${encodeURIComponent(reviewTargetId)}/candidate-transactions`);
  if (!res.ok) { box.innerHTML = '<p class="text-[10px] text-rose-600 p-2">Could not load candidates.</p>'; return; }
  const rows = (await res.json()).transactions || [];
  // A credit can now be split across delegates, so "remaining" (not the
  // credit's full amount) is what's actually available here -- pre-filled
  // into an editable amount input, since taking only part of a credit for
  // this registration (leaving the rest for someone else) is the whole point.
  box.innerHTML = rows.length ? rows.map((c) => `
    <div class="flex items-center justify-between gap-2 p-2 text-[10px]">
      <div class="min-w-0"><p class="font-semibold text-slate-700">${esc(c.post_date)} · ₹${inr(esc(c.remaining))}${c.remaining !== c.credit ? ` of ₹${inr(esc(c.credit))}` : ''} available</p><p class="text-slate-500 truncate">${esc(c.description)}</p></div>
      <div class="flex items-center gap-1 shrink-0">
        <input type="number" min="0.01" max="${esc(c.remaining)}" step="0.01" value="${esc(c.remaining)}" id="admin-add-amount-${esc(c.id)}" class="w-20 p-1 border rounded text-[10px]">
        <button type="button" class="px-2 py-1 bg-navy hover:bg-indigo-700 text-white font-semibold rounded" onclick="adminAddPayment(${esc(c.id)}, ${esc(c.remaining)})">Add</button>
      </div>
    </div>`).join('') : '<p class="text-[10px] text-slate-400 p-2">No unused credits in the statement yet.</p>';
}

async function adminAddPayment(bankTxnId, maxRemaining) {
  const input = document.getElementById(`admin-add-amount-${bankTxnId}`);
  const amount = input ? Number(input.value) : maxRemaining;
  if (!Number.isFinite(amount) || amount <= 0) return showToast('Enter a valid amount.');
  if (amount > maxRemaining + 0.5) return showToast(`Only ₹${inr(maxRemaining)} of this credit is available.`);
  if (!(await showConfirm(`Add ₹${inr(amount)} of this bank credit as a verified payment for this registration? This is for a payment the delegate never submitted a claim for.`))) return;
  const data = await (await fetch(`/api/registrations/${encodeURIComponent(reviewTargetId)}/admin-add-payment`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bankTxnId, amount }),
  })).json();
  if (!data.success) return showToast(data.error || 'Could not add this payment.');
  showToast('Payment added.', 'success');
  await renderBackendPayments();
  openReviewModal(reviewTargetId);
}

// Accept & Verify is gated on every applicable requirement being met: a
// linked bank transaction always, and (for student categories) an
// approver's confirmation that the ID card verifies that status. Each
// render function records its own reviewGate flag; this reconciles them.
const reviewGate = { linked: false, idOk: true };
let reviewStepOffset = 0;
function updateReviewAcceptGate() {
  const acceptBtn = document.getElementById('review-accept-btn');
  const blocked = !(reviewGate.linked && reviewGate.idOk);
  if (acceptBtn) acceptBtn.disabled = blocked;

  // Spell out each requirement rather than leaving a disabled button with no
  // explanation. Refreshed from here (not only on open) so ticking the ID
  // checkbox updates the list immediately. Only rendered while the button is
  // actually on screen -- on an already-verified or rejected registration
  // there's no decision left to gate.
  // In the footer, beside the buttons: what is still left, in the reviewer's
  // words -- or that it is ready.
  const list = document.getElementById('review-gate-list');
  if (!list) return;
  const acceptVisible = acceptBtn && !acceptBtn.classList.contains('hidden');
  if (!acceptVisible) { list.textContent = ''; return; }
  const left = [];
  if (!reviewGate.idOk) left.push('confirm the student ID');
  if (!reviewGate.linked) {
    const unlinked = reviewTxns.map((t, i) => (t.txn_status === 'PENDING' ? i + 1 : null)).filter(Boolean);
    if (!reviewTxns.length) left.push('link the payment to its bank credit');
    else unlinked.forEach((n) => left.push(`link payment ${n}${reviewTxns.length > 1 ? '' : ' to its bank credit'}`));
  }
  list.className = `flex-1 min-w-[12rem] text-sm font-semibold sm:text-right ${blocked ? 'text-amber-800' : 'text-emerald-800'}`;
  list.textContent = blocked ? `${left.length} step${left.length === 1 ? '' : 's'} left: ${left.join(' · ')}` : 'Ready to verify';
}

// Category list for the review modal's lock control, loaded once from the fee
// master and cached. Also the one source of truth for which categories
// require a student ID (requires_student_id, admin-editable on the Fees
// tab) -- see isStudentCategory below.
let reviewCategoryList = null;
async function ensureReviewCategories() {
  if (reviewCategoryList) return reviewCategoryList;
  try {
    const data = await (await fetch('/api/admin/fees')).json();
    reviewCategoryList = (data.categories || []).map((c) => ({ key: c.category_key, label: c.label, requiresStudentId: !!c.requires_student_id }));
  } catch (e) { reviewCategoryList = []; }
  return reviewCategoryList;
}

// Sync check for render paths that can't await -- returns false (not,
// conservatively, "unknown") until ensureReviewCategories() has resolved at
// least once. Every admin render path that uses this calls
// ensureReviewCategories() itself first (see renderBackendPayments), so in
// practice the cache is always warm by the time this runs.
function isStudentCategory(categoryKey) {
  return !!(reviewCategoryList || []).find((c) => c.key === categoryKey && c.requiresStudentId);
}

// --- fee adjustment (review modal) ---------------------------------------
//
// Two ways what a delegate owes can differ from the price list. The
// early-phase one is evidenced and the server offers it unprompted; the
// discretionary one is a judgement and has to be written down. Both are
// behind payments.adjust_fee, so a role without it sees neither -- and would
// be refused by the server anyway.
function renderReviewFeeAdjust(p) {
  const block = document.getElementById('review-fee-adjust-block');
  if (!block) return;
  const allowed = can('payments.adjust_fee');
  block.classList.toggle('hidden', !allowed);
  if (!allowed) return;

  const early = document.getElementById('review-early-phase');
  const done = document.getElementById('review-fee-adjusted');
  const disc = document.getElementById('review-discretionary');

  // Already adjusted: show what was taken off and why, rather than offering
  // to do it again. A second reduction is a fresh decision and starts from
  // Unadjust, which does not exist yet -- deliberately, since undoing a
  // recorded concession should be its own audited act.
  const adjusted = Number(p.fee_adjustment) > 0;
  done.classList.toggle('hidden', !adjusted);
  if (adjusted) {
    setText('review-fee-adjusted-text',
      `₹${inr(p.fee_adjustment)} taken off by ${p.fee_adjustment_by || 'staff'}`
      + `${p.fee_adjustment_at ? ' on ' + fmtRegisteredAt(p.fee_adjustment_at) : ''}. ${p.fee_adjustment_reason || ''}`);
  }

  const b = p.early_phase_benefit;
  early.classList.toggle('hidden', !b || adjusted);
  if (b && !adjusted) {
    setText('review-early-phase-text',
      `Their payment reached the bank on ${b.paidOn}, while the ${b.toPhase} price was still in force, `
      + `but the form was submitted in the ${b.fromPhase} phase — so they were charged ₹${inr(b.saving)} more `
      + `than the price on the day they paid. Honouring it makes the fee ₹${inr(b.newExpectedAmount)}.`);
  }

  disc.classList.toggle('hidden', adjusted);
  const amt = document.getElementById('review-adjust-amount');
  if (amt && !adjusted) amt.placeholder = `New fee (₹) — currently ₹${inr(p.expected_amount)}`;
}

async function reviewHonourEarlyPhase() {
  // No amount is sent: the server re-derives it from the bank credit, so what
  // was shown and what is written cannot come from different numbers.
  await submitFeeAdjustment({ mode: 'EARLY_PHASE' });
}

async function reviewAdjustFee() {
  const newAmount = Number(document.getElementById('review-adjust-amount').value);
  const reason = (document.getElementById('review-adjust-reason').value || '').trim();
  if (!Number.isFinite(newAmount) || newAmount < 0) return showToast('Enter the new fee.');
  if (reason.length < 10) return showToast('Give a reason — at least a short sentence.');
  await submitFeeAdjustment({ mode: 'DISCRETIONARY', newAmount, reason });
}

async function submitFeeAdjustment(body) {
  // reviewTargetId is what openReviewModal() sets; there is no
  // currentReviewId.
  const id = reviewTargetId;
  if (!id) return;
  const data = await (await fetch(`/api/registrations/${id}/fee-adjustment`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })).json();
  if (!data.success) return showToast(data.error || 'Could not adjust the fee.');
  showToast(data.settled
    ? `Fee is now ₹${inr(data.expectedAmount)} — the balance is settled.`
    : `Fee is now ₹${inr(data.expectedAmount)}.`, 'success');
  closeModal('modal-review');
  await renderBackendPayments();
}

async function renderReviewCategoryLock(p) {
  const sel = document.getElementById('review-category-select');
  const lockBtn = document.getElementById('review-category-lock-btn');
  const unlockBtn = document.getElementById('review-category-unlock-btn');
  const badge = document.getElementById('review-category-locked-badge');
  if (!sel) return;
  const cats = await ensureReviewCategories();
  sel.innerHTML = cats.map((c) => `<option value="${esc(c.key)}" ${c.key === p.category_key ? 'selected' : ''}>${esc(c.label)}</option>`).join('');

  const locked = !!p.category_locked;
  if (badge) badge.classList.toggle('hidden', !locked);
  // When locked, the picker is disabled; only someone who can unlock it sees the button.
  sel.disabled = locked;
  if (lockBtn) lockBtn.classList.toggle('hidden', locked);
  if (unlockBtn) unlockBtn.classList.toggle('hidden', !(locked && can('payments.unlock_category')));

  // The Corrections disclosure is closed by default (these controls are used
  // on a small minority of reviews), but an already-locked category is state
  // the admin needs to notice -- so surface it on the summary line and open
  // the section when it applies.
  const details = document.getElementById('review-corrections');
  const hint = document.getElementById('review-corrections-hint');
  if (hint) hint.textContent = locked ? ' · category locked' : '';
  if (details) details.open = locked;
}

async function reviewLockCategory() {
  const categoryKey = document.getElementById('review-category-select').value;
  if (!(await showConfirm('Lock this delegate into the selected category? The fee will be recalculated and the delegate can no longer change it.'))) return;
  const data = await (await fetch(`/api/registrations/${encodeURIComponent(reviewTargetId)}/lock-category`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ categoryKey }),
  })).json();
  if (!data.success) return showToast(data.error || 'Could not lock category.');
  showToast(`Category locked. Fee is now ₹${inr(data.expectedAmount)}${data.remaining > 0 ? `, ₹${inr(data.remaining)} balance due from the delegate.` : '.'}`, 'info');
  await renderBackendPayments();
  openReviewModal(reviewTargetId);
}

async function reviewUnlockCategory() {
  const data = await (await fetch(`/api/registrations/${encodeURIComponent(reviewTargetId)}/lock-category`, { method: 'DELETE' })).json();
  if (!data.success) return showToast(data.error || 'Could not unlock category.');
  showToast('Category unlocked. The delegate can choose again.', 'info');
  await renderBackendPayments();
  openReviewModal(reviewTargetId);
}

// Student categories require an approver to confirm the uploaded ID card
// verifies that status before the registration can be verified. This drives
// the whole ID Verification section of the review modal, header included --
// non-student categories have no ID question to answer, so they see none of it.
function renderReviewIdVerification(p) {
  const wrap = document.getElementById('review-idverify-wrap');
  const checkbox = document.getElementById('review-idverify-checkbox');
  const note = document.getElementById('review-idverify-note');
  const isStudent = isStudentCategory(p.category_key);

  if (wrap) wrap.classList.toggle('hidden', !isStudent);
  reviewGate.idOk = !isStudent || !!p.id_verified;
  // Step 1 when it applies; the payments are numbered after it.
  reviewStepOffset = isStudent ? 1 : 0;
  const done = !!p.id_verified;
  if (wrap) wrap.className = `${isStudent ? '' : 'hidden '}rounded-xl p-4 space-y-2.5 ${done ? 'border border-emerald-200 bg-emerald-50/60' : 'border-2 border-gold-500'}`;
  const badge = document.getElementById('review-idverify-badge');
  if (badge) {
    badge.className = `w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-sm font-bold text-white ${done ? 'bg-emerald-700' : 'bg-navy'}`;
    badge.textContent = done ? '✓' : '1';
  }
  const state = document.getElementById('review-idverify-state');
  if (state) {
    state.className = `text-sm font-bold ${done ? 'text-emerald-800' : 'text-amber-800'}`;
    state.textContent = done ? 'Done' : 'To do';
  }

  if (checkbox) checkbox.checked = !!p.id_verified;
  if (note) {
    note.classList.toggle('hidden', !p.id_verified);
    note.textContent = p.id_verified_by ? `Verified by ${p.id_verified_by} · ${fmtAuditTime(p.id_verified_at)}` : '';
  }
  updateReviewAcceptGate();
}

async function reviewSetIdVerified(checked) {
  const data = await (await fetch(`/api/registrations/${encodeURIComponent(reviewTargetId)}/verify-id`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ verified: checked }),
  })).json();
  if (!data.success) {
    showToast(data.error || 'Could not update ID verification.');
    document.getElementById('review-idverify-checkbox').checked = !checked; // revert the click
    return;
  }
  await renderBackendPayments();
  openReviewModal(reviewTargetId); // re-open with fresh cached data
}

async function reviewAccept() {
  if (!(await showConfirm('Have you cross-checked the payment screenshot and bank record?'))) return;
  const data = await (await fetch(`/api/registrations/${encodeURIComponent(reviewTargetId)}/status`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bankStatus: 'BANK_VERIFIED' })
  })).json();
  if (!data.success) return showToast(data.error || 'Verification failed.');
  closeModal('modal-review');
  renderBackendPayments();
}

// Hand off to the existing reject-with-reason modal, stacked on top.
function reviewReject() {
  openRejectModal(reviewTargetId);
}

// Revert a verified registration back to pending (super admin only; the
// server re-checks the role). Confirmed first since it undoes a decision the
// delegate may already have been told about.
async function reviewUnapprove() {
  if (!(await showConfirm('Un-approve this registration and send it back to pending review?'))) return;
  const data = await (await fetch(`/api/registrations/${encodeURIComponent(reviewTargetId)}/unapprove`, {
    method: 'PUT',
  })).json();
  if (!data.success) return showToast(data.error || 'Could not un-approve.');
  showToast('Registration un-approved and moved back to pending.', 'info');
  closeModal('modal-review');
  renderBackendPayments();
}

// Return a rejected registration to pending review (super admin only; the
// server re-checks). Silent: the delegate is not emailed.
async function reviewUnreject() {
  if (!(await showConfirm('Un-reject this registration and send it back to pending review? The delegate is not emailed.'))) return;
  const data = await (await fetch(`/api/registrations/${encodeURIComponent(reviewTargetId)}/unreject`, {
    method: 'PUT',
  })).json();
  if (!data.success) return showToast(data.error || 'Could not un-reject.');
  showToast(data.status === 'PARTIAL_PAYMENT'
    ? 'Registration un-rejected. It is back to awaiting its balance.'
    : 'Registration un-rejected and moved back to pending review.', 'info');
  closeModal('modal-review');
  renderBackendPayments();
}

// Ask the delegate to pay the balance after a category/fee change. The server
// enforces that the existing payment is linked first.
async function reviewRevisePayment() {
  if (!(await showConfirm('Ask this delegate to pay the outstanding balance? They will be emailed and moved to Awaiting Balance Payment.'))) return;
  const data = await (await fetch(`/api/registrations/${encodeURIComponent(reviewTargetId)}/revise-payment`, {
    method: 'POST',
  })).json();
  if (!data.success) return showToast(data.error || 'Could not revise the payment.');
  showToast(`Revised — ₹${inr(data.remaining)} balance requested from the delegate.`, 'info');
  closeModal('modal-review');
  renderBackendPayments();
}

const REG_STATUS_STYLES = {
  BANK_VERIFIED: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  PENDING: 'bg-amber-100 text-amber-800 border-amber-300',
  REJECTED: 'bg-rose-100 text-rose-800 border-rose-300',
  PARTIAL_PAYMENT: 'bg-orange-100 text-orange-800 border-orange-300',
};

// Cached so filtering/search re-renders instantly without a round-trip, and
// so the program-change modal has the full group/option list to draw from.
let cachedUsers = [];
let cachedAdminProgramGroups = [];

// --- ROLES (Settings -> Roles) --------------------------------------------
// The catalogue -- every permission, grouped by section, with a description
// for each -- comes from the server (permissions.js) rather than being
// duplicated here, so the matrix can never list a checkbox the server
// wouldn't recognise.
let cachedRoles = [];
let cachedRoleCatalogue = { sections: [], permissions: [] };
// Editor state: null (closed), {mode:'create'} or {mode:'edit', key}.
let roleEditorState = null;

// The role picker used by the "Assign Administrative Role" select (Create
// Staff User modal) and the role dropdown in a user's own detail panel.
// Fetched separately from the full editor payload -- it's held by anyone who
// can ASSIGN a role, not only someone who can also redesign one -- and kept
// in ROLE_LABELS too, so a role's chosen label (not just its key, humanised)
// shows everywhere a role is named, including one created after this page
// loaded.
let cachedRoleOptions = [];
async function renderRoleOptions() {
  const res = await fetch('/api/admin/roles/options');
  if (!res.ok) return;
  const data = await res.json();
  cachedRoleOptions = data.roles || [];
  cachedRoleOptions.forEach((r) => { ROLE_LABELS[r.key] = r.label; });
  // If a user's detail panel is open, its role select was built from the
  // list as it stood at the time -- refresh it in place rather than leaving
  // it stale until the panel is reopened. Same for the Users table's Role
  // filter, which this call is what actually enables (see
  // populateUserFilterOptions) -- loadBackendUsers() runs before this
  // during init, so the filter's first paint uses the static fallback list
  // until this refresh replaces it with the real catalogue.
  if (userDetailData) renderUserDetail();
  if (document.getElementById('user-table-body')) renderBackendUsers();
}

async function loadBackendRoles() {
  const res = await fetch('/api/admin/roles');
  if (!res.ok) return;
  const data = await res.json();
  cachedRoles = data.roles || [];
  cachedRoleCatalogue = data.catalogue || { sections: [], permissions: [] };
  renderRoleCards();
}

function renderRoleCards() {
  const list = document.getElementById('roles-list');
  if (!list) return;
  list.innerHTML = cachedRoles.map((r) => {
    const isMine = activeAdminUser && activeAdminUser.role === r.key;
    const badge = r.grantsAll
      ? `<span class="text-[10px] bg-indigo-100 text-indigo-700 border border-indigo-300 px-2 py-0.5 rounded-full font-bold">Built-in · every permission</span>`
      : r.isSystem
        ? `<span class="text-[10px] bg-slate-100 text-slate-600 border border-slate-300 px-2 py-0.5 rounded-full font-bold">Built-in</span>`
        : '';
    const deleteDisabled = r.isSystem || r.userCount > 0;
    const deleteTitle = r.isSystem ? 'Built-in roles cannot be deleted'
      : r.userCount > 0 ? `${r.userCount} user(s) still hold this role -- reassign them first` : '';
    return `
    <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 flex flex-col gap-3">
      <div>
        <div class="flex items-center gap-2 flex-wrap">
          <h3 class="text-sm font-bold text-slate-800">${esc(r.label)}</h3>
          ${badge}
          ${isMine ? '<span class="text-[10px] text-emerald-700 font-bold">· this is your role</span>' : ''}
        </div>
        <p class="text-[11px] font-mono text-slate-400 mt-0.5">${esc(r.key)}</p>
        ${r.description ? `<p class="text-xs text-slate-500 mt-1.5">${esc(r.description)}</p>` : ''}
      </div>
      <p class="text-xs text-slate-500">${r.grantsAll ? 'Every permission, always' : `${r.permissions.length} permission(s)`} · ${r.userCount} user(s)</p>
      <div class="flex items-center gap-2 mt-auto pt-1">
        <button type="button" onclick="openRoleEditor('${esc(r.key)}')" ${r.grantsAll ? 'disabled title="Super Admin cannot be edited"' : ''}
          class="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed text-slate-700 text-xs font-semibold rounded-lg">
          ${r.grantsAll ? 'Uneditable' : 'Edit'}
        </button>
        <button type="button" onclick="duplicateRole('${esc(r.key)}')" class="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-lg">Duplicate</button>
        <button type="button" onclick="deleteRoleAction('${esc(r.key)}')" ${deleteDisabled ? `disabled title="${esc(deleteTitle)}"` : ''}
          class="ml-auto px-3 py-1.5 text-rose-600 hover:bg-rose-50 disabled:opacity-30 disabled:cursor-not-allowed text-xs font-semibold rounded-lg">Delete</button>
      </div>
    </div>`;
  }).join('');
}

// The checkbox matrix, grouped by section exactly as the catalogue orders
// them. `selected` is the set of permission keys already held (edit) or
// pre-filled from a source role (duplicate); empty for a fresh create.
function buildPermissionMatrix(selected) {
  const bySection = {};
  cachedRoleCatalogue.permissions.forEach((p) => {
    (bySection[p.section] = bySection[p.section] || []).push(p);
  });
  return cachedRoleCatalogue.sections.map((sec) => {
    const perms = bySection[sec.key] || [];
    if (!perms.length) return '';
    return `
    <div>
      <h4 class="text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">${esc(sec.label)}</h4>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
        ${perms.map((p) => `
          <label class="flex items-start gap-2 py-1 cursor-pointer" title="${esc(p.description)}">
            <input type="checkbox" class="role-perm-checkbox mt-0.5" value="${esc(p.key)}" ${selected.has(p.key) ? 'checked' : ''} onchange="updateRolePermCount()">
            <span class="text-xs text-slate-700">${esc(p.label)}</span>
          </label>`).join('')}
      </div>
    </div>`;
  }).join('');
}

function updateRolePermCount() {
  const n = document.querySelectorAll('.role-perm-checkbox:checked').length;
  setText('role-editor-perm-count', String(n));
}

function roleEditorErrorEl() { return document.getElementById('role-editor-error'); }
function showRoleEditorError(msg) {
  const el = roleEditorErrorEl();
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}
function clearRoleEditorError() {
  const el = roleEditorErrorEl();
  if (el) el.classList.add('hidden');
}

// No argument: a blank create form. A key: edit that existing role, its key
// field locked (a role's key is permanent -- see the server's own
// validateRoleKey comment).
function openRoleEditor(key) {
  clearRoleEditorError();
  const keyInput = document.getElementById('role-editor-key');
  const labelInput = document.getElementById('role-editor-label');
  const descInput = document.getElementById('role-editor-description');
  const title = document.getElementById('role-editor-title');
  const subtitle = document.getElementById('role-editor-subtitle');
  const matrix = document.getElementById('role-editor-matrix');

  const role = key ? cachedRoles.find((r) => r.key === key) : null;
  roleEditorState = role ? { mode: 'edit', key } : { mode: 'create' };

  if (title) title.textContent = role ? `Edit ${role.label}` : 'New Role';
  if (subtitle) subtitle.textContent = role
    ? 'The key stays fixed; everything else can change.'
    : 'A role\'s key can\'t be changed once it\'s created.';
  if (keyInput) { keyInput.value = role ? role.key : ''; keyInput.disabled = !!role; }
  if (labelInput) labelInput.value = role ? role.label : '';
  if (descInput) descInput.value = (role && role.description) || '';
  if (matrix) matrix.innerHTML = buildPermissionMatrix(new Set(role ? role.permissions : []));
  updateRolePermCount();
  openModal('modal-role-editor');
}

// Pre-fills a NEW role's form from an existing one's permission set -- a
// duplicate is just a create with a head start, so it reuses the same
// create endpoint rather than a dedicated one.
function duplicateRole(sourceKey) {
  const source = cachedRoles.find((r) => r.key === sourceKey);
  if (!source) return;
  openRoleEditor(); // blank create form, then override with the source's shape
  roleEditorState = { mode: 'create' };
  const labelInput = document.getElementById('role-editor-label');
  const descInput = document.getElementById('role-editor-description');
  const matrix = document.getElementById('role-editor-matrix');
  if (labelInput) labelInput.value = `Copy of ${source.label}`;
  if (descInput) descInput.value = source.description || '';
  if (matrix) matrix.innerHTML = buildPermissionMatrix(new Set(source.grantsAll ? cachedRoleCatalogue.permissions.map((p) => p.key) : source.permissions));
  updateRolePermCount();
}

async function submitRoleEditor(e) {
  e.preventDefault();
  clearRoleEditorError();
  if (!roleEditorState) return;

  const label = document.getElementById('role-editor-label').value.trim();
  const description = document.getElementById('role-editor-description').value.trim();
  const permissions = Array.from(document.querySelectorAll('.role-perm-checkbox:checked')).map((cb) => cb.value);

  const btn = document.getElementById('role-editor-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  try {
    let data;
    if (roleEditorState.mode === 'create') {
      const key = document.getElementById('role-editor-key').value.trim().toUpperCase();
      data = await (await fetch('/api/admin/roles', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, label, description, permissions }),
      })).json();
    } else {
      data = await (await fetch(`/api/admin/roles/${encodeURIComponent(roleEditorState.key)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, description, permissions }),
      })).json();
    }
    if (!data.success) return showRoleEditorError(data.error || 'Could not save this role.');

    closeModal('modal-role-editor');
    showToast(roleEditorState.mode === 'create' ? 'Role created.' : 'Role updated.', 'success');
    await loadBackendRoles();
    await renderRoleOptions();
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save Role'; }
  }
}

async function deleteRoleAction(key) {
  const role = cachedRoles.find((r) => r.key === key);
  if (!role) return;
  if (!(await showConfirm(`Delete the role "${role.label}"? This can't be undone.`))) return;
  const data = await (await fetch(`/api/admin/roles/${encodeURIComponent(key)}`, { method: 'DELETE' })).json();
  if (!data.success) return showToast(data.error || 'Could not delete this role.');
  showToast('Role deleted.', 'success');
  await loadBackendRoles();
  await renderRoleOptions();
}

async function loadBackendUsers() {
  const [usersRes, groupsRes] = await Promise.all([
    fetch('/api/users'),
    fetch('/api/admin/program-groups'),
  ]);
  cachedUsers = ((await usersRes.json()).users) || [];
  cachedAdminProgramGroups = ((await groupsRes.json()).groups) || [];
  renderBackendUsers();
}

// A "Change"/"Add" button (verified registrations only -- nothing to enroll
// into before payment is verified) opens a confirm-before-save modal instead
// of an inline <select>. An inline select sitting in a dense table is an
// easy misclick/scroll-wheel-while-hovering away from silently changing
// someone's enrollment; routing every change through an explicit
// "Change" -> modal -> "Save" flow removes that. See the Users detail panel
// for where this is actually used.
// Subtle, monochrome role marks for the Users table (staff stand out without
// colour). Delegates — the overwhelming majority — get no mark, keeping the
// list quiet; only staff roles show a glyph.
const ROLE_ICONS_BW = {
  SUPER_ADMIN: '★',
  FINANCE_ADMIN: '₹',
  ACADEMIC_REVIEWER: '✎',
  FINANCE_ACADEMIC: '❖',
  OPERATIONS: '◆',
  DELEGATE: '',
};

function roleMarkBW(role) {
  const glyph = ROLE_ICONS_BW[role];
  if (!glyph) return '';
  return `<span class="text-slate-400 mr-1" title="${esc(roleLabel(role))}">${glyph}</span>`;
}

// Account-security marks for the Users table: verified Mobile, verified
// Email, Password set. Three fixed slots in a fixed order so the column
// scans vertically -- a missing one reads as an absence at a glance rather
// than shifting the others along, which is why the "off" state is shown
// muted rather than hidden.
//
// Lettered pills, NOT emoji: emoji are rendered from a colour font and
// ignore CSS `color`, so an emoji set of marks looks identical whether it's
// styled as set or unset -- which is exactly how the first version of this
// shipped looking always-on. Plain letters take the styling reliably, and
// filled-vs-outlined carries the state independently of colour for anyone
// who can't distinguish the two greens.
function accountMarks(u) {
  const mark = (on, letter, onTitle, offTitle) =>
    `<span class="inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold border ${
      on ? 'bg-emerald-500 border-emerald-500 text-white' : 'bg-white border-slate-200 text-slate-300'
    }" title="${esc(on ? onTitle : offTitle)}">${letter}</span>`;
  const ph = delegateDisplayPhone(u);
  return `<span class="inline-flex items-center gap-1">
    ${mark(u.phone_verified, 'M', `Mobile verified${ph ? ` (${ph})` : ''}`, ph ? `Mobile NOT verified (${ph})` : 'No mobile number on file')}
    ${mark(u.email_verified, 'E', `Email verified${u.email ? ` (${u.email})` : ''}`, u.email ? `Email NOT verified (${u.email})` : 'No email address on file')}
    ${mark(u.hasPassword, 'P', 'Password set', 'No password set \u2014 signs in by OTP only')}
  </span>`;
}

// Fills the Designation and Institute filter <select>s from the distinct
// values present in the current user list, preserving the current selection.
function populateUserFilterOptions() {
  const fill = (id, values) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const current = sel.value;
    const first = sel.querySelector('option'); // keep the "All …" option
    sel.innerHTML = '';
    if (first) sel.appendChild(first);
    values.forEach((v) => {
      const opt = document.createElement('option');
      opt.value = v; opt.textContent = v;
      sel.appendChild(opt);
    });
    if (values.includes(current)) sel.value = current;
  };
  const uniqSorted = (key) => [...new Set(cachedUsers.map((u) => (u[key] || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  fill('user-filter-designation', uniqSorted('designation'));
  fill('user-filter-institute', uniqSorted('institution'));

  // Role filter: rebuilt from the live role catalogue (cachedRoleOptions),
  // not the static <option>s users.ejs ships as a pre-load fallback. Without
  // this, a custom role created via the Role Editor is fully assignable
  // everywhere (Create Staff User, the detail panel's role select) but has
  // no way to be filtered TO here -- silently unreachable by role once a
  // conference actually uses one. Skipped while cachedRoleOptions hasn't
  // loaded yet; the static fallback stands until renderRoleOptions() calls
  // back in to refresh this (see there).
  const roleSel = document.getElementById('user-filter-role');
  if (roleSel && cachedRoleOptions.length) {
    const current = roleSel.value;
    const roleKeys = ['DELEGATE', ...cachedRoleOptions.map((r) => r.key)];
    roleSel.innerHTML = '<option value="">All roles</option>'
      + roleKeys.map((k) => `<option value="${esc(k)}">${esc(roleLabel(k))}</option>`).join('');
    if (roleKeys.includes(current)) roleSel.value = current;
  }
}

function renderBackendUsers() {
  const tbody = document.getElementById('user-table-body');
  if (!tbody) return;

  populateUserFilterOptions();

  const search = (document.getElementById('user-filter-search')?.value || '').trim().toLowerCase();
  const roleFilter = document.getElementById('user-filter-role')?.value || '';
  const statusFilter = document.getElementById('user-filter-status')?.value || '';
  const designationFilter = document.getElementById('user-filter-designation')?.value || '';
  const instituteFilter = document.getElementById('user-filter-institute')?.value || '';

  const filtered = cachedUsers.filter((u) => {
    // Held as the main role or as an additional one.
    if (roleFilter && u.role !== roleFilter && !(u.extra_roles || []).includes(roleFilter)) return false;
    if (designationFilter && (u.designation || '').trim() !== designationFilter) return false;
    if (instituteFilter && (u.institution || '').trim() !== instituteFilter) return false;
    if (statusFilter) {
      const matches = statusFilter === 'NONE' ? !u.registration_status : u.registration_status === statusFilter;
      if (!matches) return false;
    }
    if (search) {
      const hay = [u.full_name, u.phone_number, u.registration_number].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  setText('user-total-count', String(cachedUsers.length));
  setText('user-filter-count', String(filtered.length));
  setText('badge-user-count', String(cachedUsers.length));

  tbody.innerHTML = filtered.length ? filtered.map((u) => `
    <tr class="hover:bg-slate-50 cursor-pointer" onclick="openUserDetail('${esc(u.phone_number)}')">
      <td class="p-4 font-mono text-xs">${esc(u.registration_number || '—')}</td>
      <td class="p-4 font-semibold text-slate-800">${roleMarkBW(u.role)}${u.salutation ? esc(u.salutation) + ' ' : ''}${esc(u.full_name)}${(u.extra_roles || []).length
        ? `<p class="text-[11px] font-normal text-slate-500 mt-0.5">${esc(roleLabel(u.role))} + ${esc(u.extra_roles.map(roleLabel).join(', '))}</p>` : ''}</td>
      <td class="p-4 text-slate-600">${esc(u.designation || '—')}</td>
      <td class="p-4 text-slate-600">${esc(u.institution || '—')}</td>
      <td class="p-4 whitespace-nowrap">${accountMarks(u)}</td>
      <td class="p-4">${u.registration_status
        ? `<span class="${REG_STATUS_STYLES[u.registration_status] || 'bg-slate-100 text-slate-600 border-slate-200'} text-xs font-bold px-2.5 py-1 rounded-full border">${esc(BANK_STATUS_LABELS[u.registration_status] || u.registration_status)}</span>`
        : `<span class="text-xs text-slate-400">Not registered</span>`}</td>
      <td class="p-4 text-right">
        <button type="button" onclick="event.stopPropagation();openUserDetail('${esc(u.phone_number)}')" class="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-lg">Details →</button>
      </td>
    </tr>
  `).join('') : `<tr><td colspan="7" class="p-8 text-center text-sm text-slate-400">No users match these filters.</td></tr>`;
}

// State for the shared program-group change modal -- one modal, reused for
// every group and re-populated per delegate/group on open. currentId comes
// from userDetailSelections (the last-loaded Users detail panel response --
// see openUserDetail), since the Users list itself no longer carries every
// group's selection per row (there can be arbitrarily many groups).
let programChangeState = { phone: null, groupId: null, currentId: null };

function openProgramChangeModal(phone, groupId) {
  const u = cachedUsers.find((x) => x.phone_number === phone);
  const group = cachedAdminProgramGroups.find((g) => String(g.id) === String(groupId));
  if (!u || !group) return;
  const current = userDetailSelections.find((s) => String(s.group_id) === String(groupId));
  const currentId = current ? current.option_id : null;
  const options = group.options;
  programChangeState = { phone, groupId, currentId };

  setText('program-change-title', `Change ${group.name}`);
  setText('program-change-subtitle', [u.salutation, u.full_name].filter(Boolean).join(' '));

  // An inactive option only stays selectable if it's the delegate's current
  // choice, so it doesn't just vanish from the list out from under them.
  const selectable = options.filter((o) => o.active || String(o.id) === String(currentId));
  const sel = document.getElementById('program-change-select');
  sel.innerHTML = `<option value="">— None —</option>` + selectable.map((o) => {
    const isCurrent = String(o.id) === String(currentId);
    const isFull = !isCurrent && o.enrolled >= o.capacity;
    return `<option value="${esc(o.id)}" ${isCurrent ? 'selected' : ''} ${isFull ? 'disabled' : ''}>${esc(o.name)}${isFull ? ' — FULL' : ''}${!o.active ? ' (inactive)' : ''}</option>`;
  }).join('');

  openModal('modal-program-change');
}

async function saveProgramChange() {
  const { phone, currentId } = programChangeState;
  const sel = document.getElementById('program-change-select');
  const newId = sel.value;
  if (newId === String(currentId ?? '')) { closeModal('modal-program-change'); return; }

  const saveBtn = document.getElementById('program-change-save-btn');
  if (saveBtn) saveBtn.disabled = true;

  let data;
  if (newId) {
    data = await (await fetch(`/api/admin/program-options/${encodeURIComponent(newId)}/enroll`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }),
    })).json();
  } else if (currentId) {
    data = await (await fetch(`/api/admin/program-options/${encodeURIComponent(currentId)}/enroll/${encodeURIComponent(phone)}`, { method: 'DELETE' })).json();
  } else {
    data = { success: true };
  }

  if (saveBtn) saveBtn.disabled = false;

  if (!data.success) {
    showToast(data.error || 'Could not update enrollment.');
    return;
  }
  closeModal('modal-program-change');
  showToast('Enrollment updated.', 'success');
  await loadBackendUsers();
  if (userDetailPhone) await openUserDetail(userDetailPhone);
}

async function updateRole(phone, role) {
  await fetch(`/api/users/${encodeURIComponent(phone)}/role`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role })
  });
  await loadBackendUsers();
}

// --- USER DETAIL SIDE PANEL ------------------------------------------------
let userDetailPhone = null;
let userDetailData = null;
let userDetailEditing = false;
let userDetailSelections = [];

// Whether the viewer literally IS Super Admin -- a role-hierarchy check, not
// a permission one. Reserved for the two places that mirror the server's own
// hardcoded escalation boundary (PUT /api/users/:phone/role, POST
// /api/users): only a Super Admin may grant Super Admin, or touch an
// existing Super Admin's role. That boundary is about the role itself being
// special, which is exactly what stays true even if every permission it
// holds were later copied onto another role -- so it is deliberately not
// expressed as a permission, and can()/canSee() are what everything else
// in this file should use.
function isSuperAdminViewer() {
  return activeAdminUser && activeAdminUser.role === 'SUPER_ADMIN';
}

async function openUserDetail(phone) {
  userDetailPhone = phone;
  userDetailEditing = false;
  const overlay = document.getElementById('user-detail-overlay');
  const panel = document.getElementById('user-detail-panel');
  const body = document.getElementById('user-detail-body');
  if (!overlay || !panel) return;
  overlay.classList.remove('hidden');
  // Slide in on the next frame so the transform transition plays.
  requestAnimationFrame(() => panel.classList.remove('translate-x-full'));
  if (body) body.innerHTML = '<p class="text-slate-400">Loading…</p>';

  const res = await fetch(`/api/users/${encodeURIComponent(phone)}/detail`);
  if (!res.ok) {
    if (body) body.innerHTML = '<p class="text-rose-600">Could not load this user.</p>';
    return;
  }
  userDetailData = await res.json();
  userDetailSelections = userDetailData.selections || [];
  renderUserDetail();
}

function closeUserDetail(event) {
  if (event && event.target && event.target.id && event.target.id !== 'user-detail-overlay') return;
  const overlay = document.getElementById('user-detail-overlay');
  const panel = document.getElementById('user-detail-panel');
  if (panel) panel.classList.add('translate-x-full');
  // Wait for the slide-out before hiding the overlay.
  setTimeout(() => { if (overlay) overlay.classList.add('hidden'); }, 200);
  userDetailPhone = null;
  userDetailData = null;
  userDetailEditing = false;
  deskRefreshAfter('user-detail');
}

function detailRow(label, value) {
  return `<div class="flex justify-between gap-3 py-1">
    <span class="text-slate-500">${esc(label)}</span>
    <span class="text-slate-800 font-medium text-right">${value == null || value === '' ? '—' : esc(String(value))}</span>
  </div>`;
}

function detailCard(title, inner, actionHtml) {
  return `<div class="border border-slate-200 rounded-xl overflow-hidden">
    <div class="bg-slate-50 px-3 py-2 border-b border-slate-100 flex items-center justify-between">
      <h4 class="text-xs font-bold text-slate-500 uppercase tracking-wide">${esc(title)}</h4>
      ${actionHtml || ''}
    </div>
    <div class="px-3 py-2">${inner}</div>
  </div>`;
}

function renderUserDetail() {
  const body = document.getElementById('user-detail-body');
  if (!body || !userDetailData) return;
  const { user: u, registration: reg, payment, signup_at } = userDetailData;

  const nameEl = document.getElementById('user-detail-name');
  if (nameEl) nameEl.innerHTML = `${roleMarkBW(u.role)}${u.salutation ? esc(u.salutation) + ' ' : ''}${esc(u.full_name || '—')}`;
  setText('user-detail-subline', `${u.registration_number || 'No reg no'}${delegateDisplayPhone(u) ? ' · ' + delegateDisplayPhone(u) : ''} · ${roleLabel(u.role)}`);

  if (userDetailEditing) {
    body.innerHTML = userDetailEditForm(u);
    // After the form is in the DOM: the selects have to exist before they can
    // be filled.
    hydrateUserDetailDirectories(u);
    return;
  }

  // Demography
  const demography = detailRow('Age', u.age) + detailRow('Gender', u.gender)
    + detailRow('District', u.district) + detailRow('State', u.state)
    + detailRow('Pincode', u.pincode);

  // Contact -- its own section, because these two are not descriptions of a
  // person but the channels the system reaches them through, and once
  // verified, how they prove who they are. Each shows whether it has been
  // proved and carries its own Edit.
  const contact = contactRow('phone', 'Phone', delegateDisplayPhone(u), !!u.phone_verified)
    + contactRow('email', 'Email', u.email, !!u.email_verified);

  // Registration + payment
  let regHtml;
  if (reg) {
    const paidBits = payment ? detailRow('Fee', '₹' + inr(payment.fee))
      + detailRow('Verified paid', '₹' + inr(payment.verifiedTotal))
      + detailRow('Remaining', '₹' + inr(payment.remaining)) : '';
    regHtml = detailRow('Category', reg.category_label)
      + detailRow('Status', BANK_STATUS_LABELS[reg.bank_status] || reg.bank_status)
      + (reg.discount_code ? detailRow('Discount', `${reg.discount_code} (−₹${inr(reg.discount_amount || 0)})`) : '')
      + detailRow('Registered', fmtAuditTime(reg.submitted_at))
      + detailRow('Signed up', fmtAuditTime(signup_at))
      + paidBits;
  } else {
    regHtml = `<p class="text-slate-400 py-1">Not registered.</p>`
      + detailRow('Signed up', fmtAuditTime(signup_at));
  }

  // Payment ledger
  let ledger = '';
  if (payment && payment.txns && payment.txns.length) {
    ledger = payment.txns.map((t) => {
      const st = t.txn_status || 'PENDING';
      const stColor = st === 'VERIFIED' ? 'text-emerald-700' : st === 'REJECTED' ? 'text-rose-600' : 'text-amber-600';
      return `<div class="flex justify-between gap-3 py-1 border-b border-slate-50 last:border-0">
        <span class="text-slate-600">${fmtAuditTime(t.submitted_at) || '—'}<br><span class="text-[10px] text-slate-400 font-mono">${esc(t.utr_number || '')}</span></span>
        <span class="text-right"><span class="font-semibold text-slate-800">₹${inr(t.amount)}</span><br><span class="text-[10px] font-bold ${stColor}">${esc(st)}</span></span>
      </div>`;
    }).join('');
  }

  // One line per active program group (Workshops, QI Practices, or any
  // further group), with a Change/Add button (verified registrations only).
  // Faculty status is set from that option's Roster (Settings → Program
  // Groups), not editable here -- just shown for context.
  const canChange = reg && reg.bank_status === 'BANK_VERIFIED';
  const progLine = (group) => {
    const sel = userDetailSelections.find((s) => String(s.group_id) === String(group.id));
    return `<div class="flex justify-between items-center gap-3 py-1">
    <span class="text-slate-500">${esc(group.name)}</span>
    <span class="text-right">
      <span class="text-slate-800 font-medium">${sel ? esc(sel.option_name) : '—'}</span>
      ${sel && sel.is_faculty ? '<span class="ml-1.5 text-[10px] bg-indigo-100 text-indigo-700 border border-indigo-300 px-2 py-0.5 rounded-full font-bold align-middle">Faculty</span>' : ''}
      ${canChange ? `<button type="button" onclick="openProgramChangeModalFromDetail(${group.id})" class="ml-2 text-[11px] text-indigo-600 hover:text-indigo-800 underline font-semibold">${sel ? 'Change' : 'Add'}</button>` : ''}
    </span>
  </div>`;
  };
  const activeGroups = cachedAdminProgramGroups.filter((g) => g.active);
  const programs = reg && activeGroups.length
    ? activeGroups.map(progLine).join('')
    : `<p class="text-slate-400 py-1">No enrollment.</p>`;

  // Role setter. Mirrors the server's escalation boundary (see
  // PUT /api/users/:phone/role): a non-super-admin viewer -- i.e. an
  // Operations admin, the only other role with Users & Roles access -- can't
  // grant Super Admin, and can't touch an existing Super Admin's role at
  // all. Hiding/disabling here is UX only; the server enforces regardless.
  const viewerIsSuper = isSuperAdminViewer();
  const targetIsSuper = u.role === 'SUPER_ADMIN';
  const roleLocked = targetIsSuper && !viewerIsSuper;
  // A viewer who can SEE Users & Roles but was not given users.assign_role
  // (possible now that roles are editable -- a custom role could hold view
  // without assign) gets the role shown as plain text, not a control they'd
  // click only to be refused by the server.
  const canAssign = can('users.assign_role');
  const roleSelect = !canAssign
    ? `<p class="text-sm text-slate-700 font-medium">${esc(roleLabel(u.role))}</p>`
    : `<div class="flex items-center gap-2">
    <select id="user-detail-role-select" ${roleLocked ? 'disabled' : ''} class="flex-1 p-2 border rounded-lg text-sm bg-white outline-none disabled:bg-slate-100 disabled:text-slate-400">
      ${roleLocked ? `<option value="SUPER_ADMIN" selected>${esc(roleLabel('SUPER_ADMIN'))}</option>`
        : roleSelectOptionsHtml({ includeDelegate: 'first', selected: u.role })}
    </select>
    <button type="button" onclick="saveUserDetailRole()" ${roleLocked ? 'disabled' : ''} class="px-3 py-2 bg-navy hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg disabled:bg-slate-300 disabled:cursor-not-allowed">Save</button>
  </div>${roleLocked ? `<p class="text-[11px] text-slate-400 mt-1.5">Only a Super Admin can change another Super Admin's role.</p>` : ''}`;

  const editBtn = can('users.edit')
    ? `<button type="button" onclick="toggleUserDetailEdit()" class="text-[11px] text-indigo-600 hover:text-indigo-800 font-semibold underline">Edit</button>`
    : '';

  // Sign-in, apart from Contact. A phone number and an address are how we
  // reach somebody; a password is how they get in, and resetting one is not
  // an edit to their details -- it hands out a credential. Its own card, so
  // the state is visible before anyone reaches for the button.
  const signInState = u.password_reset_required
    ? `<span class="inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-full border bg-amber-100 text-amber-800 border-amber-300">${ICON('warning')}Reset pending</span>`
    : u.hasPassword
      ? `<span class="inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-full border bg-emerald-100 text-emerald-800 border-emerald-300">${ICON('check')}Password set</span>`
      : `<span class="inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-full border bg-slate-100 text-slate-500 border-slate-300">OTP only</span>`;
  const signIn = `<div class="flex justify-between items-center gap-3 py-1.5">
      <span class="text-slate-500">Password</span>
      <span class="flex items-center gap-2">${signInState}</span>
    </div>
    ${u.password_reset_required
      ? '<p class="text-[11px] text-amber-800">A one-time password was issued. They must choose their own at their next sign-in.</p>'
      : ''}`;
  const resetBtn = can('users.reset_password')
    ? `<button type="button" onclick="resetUserPassword('${esc(u.phone_number)}', '${esc(u.full_name || '')}')" class="text-[11px] text-indigo-600 hover:text-indigo-800 font-semibold underline">Reset password</button>`
    : '';

  body.innerHTML =
    detailCard('Demography', demography, editBtn)
    + detailCard('Contact', contact)
    + detailCard('Sign-in', signIn, resetBtn)
    + detailCard('Registration', regHtml)
    + (ledger ? detailCard('Payments', ledger) : '')
    + detailCard('Programs', programs)
    + detailCard('Role', roleSelect + userDetailExtraRolesHtml(u, canAssign && !roleLocked));
}

// Reset somebody's password to a one-time value.
//
// Shared by the front desk and the Users panel because it is the same act
// from both: the delegate cannot get in, somebody at a counter or on a phone
// gives them a temporary password, and the portal makes them replace it
// before they can do anything else.
//
// The value comes back exactly once. It is not stored in plaintext, not
// written to the audit log, and cannot be looked up afterwards -- so it is
// shown until dismissed rather than in a toast that slides away while
// somebody is still writing it down.
async function resetUserPassword(phone, label) {
  const who = label ? ` for ${label}` : '';
  if (!window.confirm(`Reset the password${who}?\n\nThey will be given a one-time password and must choose their own the next time they sign in. Their current password stops working immediately.`)) return;
  const data = await (await fetch(`/api/users/${encodeURIComponent(phone)}/reset-password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
  })).json();
  if (!data.success) return showToast(data.error || 'Could not reset the password.');
  showTempPassword(data.tempPassword, data.name || label || '');
}

// Deliberately a panel that stays until dismissed, in a large monospaced
// face: this is read out loud or copied onto paper, and the alphabet it is
// drawn from already excludes the characters that are easy to confuse when
// that happens (see generateTempPassword).
function showTempPassword(tempPassword, name) {
  const box = document.getElementById('temp-password-box');
  const value = document.getElementById('temp-password-value');
  const who = document.getElementById('temp-password-who');
  if (!box || !value) return showToast(`One-time password: ${tempPassword}`, 'success');
  value.textContent = tempPassword;
  if (who) who.textContent = name ? `for ${name}` : '';
  box.classList.remove('hidden');
  openModal('modal-temp-password');
}

function closeTempPassword() {
  closeModal('modal-temp-password');
  const value = document.getElementById('temp-password-value');
  if (value) value.textContent = '';
}

// Contact is edited on its own, apart from the demography form below.
//
// The two are different kinds of change. A district or a designation is a
// description of somebody; a mobile number or an email address is how the
// system reaches them and, once verified, how they prove who they are. Mixing
// them into one form meant a verified address sat in a plain text box beside
// an age, with nothing saying it had been proved and nothing warning that
// editing it silently withdraws that proof.
let userContactEditing = null;   // 'phone' | 'email' | null

const VERIFIED_PILL = `<span class="inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-full border bg-emerald-100 text-emerald-800 border-emerald-300">${ICON('check')}Verified</span>`;
const UNVERIFIED_PILL = `<span class="inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-full border bg-slate-100 text-slate-500 border-slate-300">Not verified</span>`;

// One contact channel: what it is, whether it has been proved, and a way to
// change it. Editing is inline rather than a modal -- there is one field.
function contactRow(kind, label, value, verified) {
  if (userContactEditing === kind) {
    return `<div class="py-2">
      <label class="block text-[11px] font-semibold text-slate-600 mb-1">${esc(label)}</label>
      <input id="uc-${esc(kind)}" type="${kind === 'email' ? 'email' : 'tel'}"
             value="${value == null ? '' : esc(String(value))}"
             class="w-full p-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-200">
      ${verified ? `<p class="text-[11px] text-amber-700 mt-1">${ICON('warning')}This ${esc(label.toLowerCase())} is verified. Changing it withdraws that, and the delegate must prove the new one before it can receive a sign-in code.</p>` : ''}
      <div class="flex justify-end gap-2 mt-2">
        <button type="button" onclick="cancelContactEdit()" class="px-3 py-1.5 border rounded-lg text-xs font-semibold text-slate-600">Cancel</button>
        <button type="button" onclick="saveContactEdit('${esc(kind)}')" class="px-3 py-1.5 bg-navy hover:bg-indigo-700 text-white rounded-lg text-xs font-bold">Save</button>
      </div>
    </div>`;
  }
  return `<div class="flex justify-between items-center gap-3 py-1.5">
    <span class="text-slate-500 shrink-0">${esc(label)}</span>
    <span class="flex items-center gap-2 min-w-0 justify-end">
      <span class="text-slate-800 font-medium truncate">${value ? esc(String(value)) : '—'}</span>
      ${value ? (verified ? VERIFIED_PILL : UNVERIFIED_PILL) : ''}
      ${can('users.edit') ? `<button type="button" onclick="startContactEdit('${esc(kind)}')" class="shrink-0 text-[11px] font-bold text-indigo-600 hover:underline">Edit</button>` : ''}
    </span>
  </div>`;
}

function startContactEdit(kind) {
  if (!can('users.edit')) return showToast('You do not have permission to edit user details.');
  userContactEditing = kind;
  renderUserDetail();
}

function cancelContactEdit() {
  userContactEditing = null;
  renderUserDetail();
}

async function saveContactEdit(kind) {
  const el = document.getElementById(`uc-${kind}`);
  if (!el || !userDetailPhone) return;
  const body = {};
  body[kind] = el.value.trim();
  const data = await (await fetch(`/api/users/${encodeURIComponent(userDetailPhone)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })).json();
  if (!data.success) return showToast(data.error || 'Could not save.');
  showToast(`${kind === 'email' ? 'Email' : 'Mobile number'} updated.`, 'success');
  userContactEditing = null;
  await loadBackendUsers();
  await openUserDetail(userDetailPhone);
}

// The demography form. Every field with a known set of answers offers that
// set, for the same reason the signup form and the front desk do: this is
// where "Prof." and "professor" get typed, and the homogenisation passes that
// had to clean those up afterwards are not worth repeating. It drives the
// signup form's own helpers through their id prefix rather than growing a
// second copy of the pincode fallback logic.
function userDetailEditForm(u) {
  const field = (id, label, val, type = 'text') =>
    `<div><label class="block text-[11px] font-semibold text-slate-600 mb-1">${esc(label)}</label>
      <input id="ude-${id}" type="${type}" value="${val == null ? '' : esc(String(val))}" class="w-full p-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-200"></div>`;
  const directory = (which, label, value) =>
    `<div><label class="block text-[11px] font-semibold text-slate-600 mb-1">${esc(label)}</label>
      <select id="ude-${which}-select" onchange="onDirectorySelect('${which}', 'ude')"
              class="w-full p-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-200"></select>
      <input id="ude-${which}-other" type="text" placeholder="Type it in"
             class="hidden w-full mt-1 p-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-200">
      <input type="hidden" id="ude-${which}" value="${value == null ? '' : esc(String(value))}"></div>`;

  // Email and phone are absent on purpose -- they are edited from the Contact
  // section, where their verified standing is visible.
  return `<div class="space-y-3">
    <div class="grid grid-cols-2 gap-3">
      ${field('salutation', 'Salutation', u.salutation)}
      ${field('full_name', 'Full name', u.full_name)}
    </div>
    <div class="grid grid-cols-2 gap-3">
      ${directory('designation', 'Designation', u.designation)}
      ${directory('institute', 'Institute', u.institution)}
    </div>
    <div class="grid grid-cols-2 gap-3">
      ${field('age', 'Age', u.age, 'number')}
      <div><label class="block text-[11px] font-semibold text-slate-600 mb-1">Gender</label>
        <select id="ude-gender" class="w-full p-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-200">
          <option value="">Select</option>
          ${GENDER_OPTIONS.map((g) => `<option value="${esc(g)}"${u.gender === g ? ' selected' : ''}>${esc(g)}</option>`).join('')}
        </select></div>
    </div>
    <div class="grid grid-cols-2 gap-3">
      <div><label class="block text-[11px] font-semibold text-slate-600 mb-1">Medical Council</label>
        <select id="ude-council_name" class="w-full p-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-200">${councilOptionsHtml(u.council_name || '')}</select></div>
      ${field('council_reg_no', 'Council registration no.', u.council_reg_no)}
    </div>
    <div>
      <label class="block text-[11px] font-semibold text-slate-600 mb-1">Pincode</label>
      <input id="ude-pincode" type="text" maxlength="6" value="${u.pincode == null ? '' : esc(String(u.pincode))}"
             oninput="fetchAddressDetails(this.value, 'ude')"
             class="w-full p-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-200">
      <span id="ude-pincode-status" class="text-xs mt-1 block font-medium"></span>
    </div>
    <div class="grid grid-cols-2 gap-3">
      <div><label class="block text-[11px] font-semibold text-slate-600 mb-1">District</label>
        <input id="ude-district" type="text" readonly value="${u.district == null ? '' : esc(String(u.district))}"
               class="w-full p-2 border border-slate-300 rounded-lg text-sm bg-slate-100 text-slate-600 outline-none"></div>
      <div><label class="block text-[11px] font-semibold text-slate-600 mb-1">State</label>
        <input id="ude-state" type="text" readonly value="${u.state == null ? '' : esc(String(u.state))}"
               class="w-full p-2 border border-slate-300 rounded-lg text-sm bg-slate-100 text-slate-600 outline-none"></div>
    </div>
    <div class="flex justify-end gap-2 pt-2">
      <button type="button" onclick="toggleUserDetailEdit()" class="px-4 py-2 border rounded-xl text-xs font-semibold text-slate-600">Cancel</button>
      <button type="button" onclick="saveUserDetailEdit()" class="px-4 py-2 bg-navy hover:bg-indigo-700 text-white rounded-xl text-xs font-semibold shadow-md">Save changes</button>
    </div>
  </div>`;
}

// Fills the two dropdowns after the form is in the DOM, and selects what this
// person already has. A value not on the list opens in "Other" pre-filled, so
// opening the form and saving it unchanged cannot quietly erase an
// institution that predates the directory.
function hydrateUserDetailDirectories(u) {
  loadDirectorySuggestions('ude').then(() => {
    for (const [which, value] of [['designation', u.designation], ['institute', u.institution]]) {
      const sel = document.getElementById(`ude-${which}-select`);
      if (!sel) continue;
      const known = Array.from(sel.options || []).some((o) => o.value === value);
      sel.value = known && value ? value : (value ? '__other__' : '');
      onDirectorySelect(which, 'ude');
      if (!known && value) {
        document.getElementById(`ude-${which}-other`).value = value;
        onDirectorySelect(which, 'ude');
      }
    }
  });
}

function toggleUserDetailEdit() {
  if (!can('users.edit')) return showToast('You do not have permission to edit user details.');
  userDetailEditing = !userDetailEditing;
  userContactEditing = null;
  renderUserDetail();
}

async function saveUserDetailEdit() {
  if (!userDetailPhone) return;
  // institution reads from the directory control's hidden field, which is
  // named for the form ("institute") rather than the column ("institution").
  const ids = ['salutation', 'full_name', 'designation', 'age', 'gender', 'district', 'state', 'pincode', 'council_name', 'council_reg_no'];
  const payload = {};
  ids.forEach((id) => {
    const el = document.getElementById(`ude-${id}`);
    if (el) payload[id] = el.value.trim();
  });
  const inst = document.getElementById('ude-institute');
  if (inst) payload.institution = inst.value.trim();
  if (!payload.full_name) return showToast('Full name is required.');
  const data = await (await fetch(`/api/users/${encodeURIComponent(userDetailPhone)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  })).json();
  if (!data.success) return showToast(data.error || 'Could not save changes.');
  showToast('Details updated.', 'success');
  userDetailEditing = false;
  await loadBackendUsers();
  await openUserDetail(userDetailPhone); // refetch + re-render the panel
}

// Additional roles, under the main one: staff only, and never Super Admin
// (a main role that already holds everything). What the person may do is
// everything any of their roles allows. See PUT /api/users/:phone/roles.
function userDetailExtraRolesHtml(u, canAssign) {
  if (!u.role || u.role === 'DELEGATE' || u.role === 'SUPER_ADMIN') return '';
  const held = (userDetailData && userDetailData.extraRoles) || [];
  const options = cachedRoleOptions.filter((r) => r.key !== 'SUPER_ADMIN' && r.key !== u.role);
  if (!canAssign) {
    return `<p class="text-[11px] text-slate-500 mt-2">Additional roles: ${held.length ? esc(held.map(roleLabel).join(', ')) : 'none'}</p>`;
  }
  if (!options.length) return '';
  return `<div class="mt-3 pt-3 border-t border-slate-100">
      <p class="text-xs font-semibold text-slate-700">Additional roles</p>
      <p class="text-[11px] text-slate-500 mb-2">They can do everything each of their roles allows.</p>
      <div id="user-detail-extra-roles" class="grid grid-cols-1 sm:grid-cols-2 gap-1.5">${options.map((r) => `
        <label class="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
          <input type="checkbox" value="${esc(r.key)}" ${held.includes(r.key) ? 'checked' : ''}> ${esc(r.label)}
        </label>`).join('')}</div>
      <button type="button" onclick="saveUserDetailExtraRoles()" class="mt-2 px-3 py-1.5 bg-navy hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg">Save additional roles</button>
    </div>`;
}

async function saveUserDetailExtraRoles() {
  if (!userDetailPhone) return;
  const roles = Array.from(document.querySelectorAll('#user-detail-extra-roles input:checked')).map((b) => b.value);
  const data = await (await fetch(`/api/users/${encodeURIComponent(userDetailPhone)}/roles`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roles }),
  })).json().catch(() => ({}));
  if (!data.success) return showToast(data.error || 'Could not save the roles.');
  showToast(roles.length ? 'Additional roles saved.' : 'Additional roles removed.', 'success');
  await loadBackendUsers();
  await openUserDetail(userDetailPhone);
}

async function saveUserDetailRole() {
  const sel = document.getElementById('user-detail-role-select');
  if (!sel || !userDetailPhone) return;
  await updateRole(userDetailPhone, sel.value);
  showToast('Role updated.', 'success');
  await openUserDetail(userDetailPhone);
}

// Bridges the detail panel to the shared program-group change modal, which
// reads from cachedAdminProgramGroups and userDetailSelections (both already
// loaded for the Users table / this panel).
function openProgramChangeModalFromDetail(groupId) {
  if (userDetailPhone) openProgramChangeModal(userDetailPhone, groupId);
}

// --- PROGRAM GROUPS (admin) ---
// A group is a named bucket of mutually-related options (Workshops, QI
// Practices, or any further group a conference defines -- see
// program_groups/program_options in server.js). Rendered as one card per
// group: its own settings, an "add option" form, and its option rows.
async function renderBackendPrograms() {
  const box = document.getElementById('program-groups-admin-container');
  if (!box) return;
  const res = await fetch('/api/admin/program-groups');
  if (!res.ok) { box.innerHTML = '<p class="text-sm text-slate-500 p-4">Unable to load program groups.</p>'; return; }
  const groups = (await res.json()).groups || [];
  setText('badge-program-count', groups.reduce((n, g) => n + g.options.length, 0));

  const optionRow = (o) => {
    const remaining = Math.max(0, o.capacity - o.enrolled);
    const facultyCount = Number(o.faculty_count) || 0;
    return `
    <div class="flex flex-wrap items-center gap-3 py-3 border-b border-slate-100 ${o.active ? '' : 'opacity-60'}">
      <div class="flex-1 min-w-[220px]">
        <input type="text" value="${esc(o.name)}" maxlength="200" aria-label="Name" title="Name — the programme shows this name too" class="prog-name w-full p-1.5 border border-slate-300 rounded text-sm font-semibold text-slate-800" data-id="${esc(o.id)}">
        <p class="text-[11px] text-slate-500 mt-1">${Number(o.fee) > 0 ? `<span class="text-indigo-600">+₹${inr(o.fee)}</span> · ` : ''}Enrolled ${Number(o.enrolled)} / ${Number(o.capacity)} · ${remaining} left${facultyCount ? ` · ${facultyCount} faculty` : ''}${o.active ? '' : ' · inactive'}</p>
      </div>
      <input type="number" min="0" value="${esc(o.capacity)}" title="Capacity" class="prog-capacity w-20 p-1.5 border rounded text-sm" data-id="${esc(o.id)}">
      <input type="number" min="0" step="0.01" value="${esc(o.fee)}" title="Fee (₹)" class="prog-fee w-24 p-1.5 border rounded text-sm" data-id="${esc(o.id)}">
      <button class="prog-save px-3 py-1.5 bg-navy hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg" data-id="${esc(o.id)}">Save</button>
      <button class="prog-roster px-3 py-1.5 bg-navy hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg" data-id="${esc(o.id)}" data-name="${esc(o.name)}">Roster</button>
      <button class="prog-toggle px-3 py-1.5 ${o.active ? 'bg-amber-500 hover:bg-amber-600' : 'bg-emerald-600 hover:bg-emerald-700'} text-white text-xs font-semibold rounded-lg" data-id="${esc(o.id)}" data-active="${o.active ? 1 : 0}">${o.active ? 'Deactivate' : 'Activate'}</button>
      <button class="prog-delete px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold rounded-lg" data-id="${esc(o.id)}">Delete</button>
    </div>`;
  };

  box.innerHTML = groups.map((g) => `
    <div class="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm mb-6 ${g.active ? '' : 'opacity-60'}">
      <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div>
          <h4 class="font-bold text-slate-800">${esc(g.name)}${g.active ? '' : ' <span class="text-[10px] font-normal text-slate-400">(inactive)</span>'}</h4>
          <p class="text-[11px] text-slate-500">${Number(g.invite_only) ? 'By invitation: delegates do not see it -- enrol invitees from an option\'s Roster' : `${g.required ? 'Required' : 'Optional'} · choose up to ${Number(g.max_select)}`}</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <label class="flex items-center gap-1.5 text-xs font-semibold text-slate-600 mr-1 select-none" title="Its options are workshops: their sessions in the programme earn a workshop certificate">
            <input type="checkbox" class="group-attendance" data-id="${esc(g.id)}" ${Number(g.takes_attendance) ? 'checked' : ''}> Attendance &amp; certificates
          </label>
          <label class="flex items-center gap-1.5 text-xs font-semibold text-slate-600 mr-1 select-none" title="Not offered to delegates; the organisers enrol invitees">
            <input type="checkbox" class="group-invite" data-id="${esc(g.id)}" ${Number(g.invite_only) ? 'checked' : ''}> Invite only
          </label>
          <button class="group-toggle px-2.5 py-1.5 ${g.active ? 'bg-amber-500 hover:bg-amber-600' : 'bg-emerald-600 hover:bg-emerald-700'} text-white text-xs font-semibold rounded-lg" data-id="${esc(g.id)}" data-active="${g.active ? 1 : 0}">${g.active ? 'Deactivate' : 'Activate'}</button>
          <button class="group-delete px-2.5 py-1.5 bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold rounded-lg" data-id="${esc(g.id)}">Delete Group</button>
        </div>
      </div>
      <form class="add-option-form flex flex-wrap items-end gap-2 mb-3 bg-slate-50 p-3 rounded-xl" data-group-id="${esc(g.id)}">
        <div class="flex-1 min-w-[160px]">
          <label class="block text-[11px] font-semibold text-slate-600 mb-1">Option name</label>
          <input required class="new-option-name w-full p-2 border rounded-lg text-sm" placeholder="e.g. Workshop 1: ...">
        </div>
        <div>
          <label class="block text-[11px] font-semibold text-slate-600 mb-1">Capacity</label>
          <input type="number" min="0" value="50" class="new-option-capacity w-24 p-2 border rounded-lg text-sm">
        </div>
        <div>
          <label class="block text-[11px] font-semibold text-slate-600 mb-1">Fee (₹)</label>
          <input type="number" min="0" step="0.01" value="0" class="new-option-fee w-24 p-2 border rounded-lg text-sm">
        </div>
        <button type="submit" class="px-3 py-2 bg-navy hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg">+ Add</button>
      </form>
      ${g.options.map(optionRow).join('') || '<p class="text-sm text-slate-400 py-2">No options yet.</p>'}
    </div>
  `).join('') || '<p class="text-sm text-slate-400 p-4">No program groups yet. Add one above.</p>';
}

async function handleAddProgramGroup(e) {
  e.preventDefault();
  const nameInput = document.getElementById('new-group-name');
  const requiredInput = document.getElementById('new-group-required');
  const maxSelectInput = document.getElementById('new-group-max-select');
  const payload = {
    name: nameInput.value,
    required: !!(requiredInput && requiredInput.checked),
    maxSelect: parseInt((maxSelectInput && maxSelectInput.value) || '1', 10) || 1,
  };
  const data = await (await fetch('/api/admin/program-groups', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  })).json();
  if (!data.success) return showToast(data.error || 'Could not add group.');
  nameInput.value = '';
  if (requiredInput) requiredInput.checked = false;
  if (maxSelectInput) maxSelectInput.value = '1';
  renderBackendPrograms();
}

async function toggleProgramGroup(id, active) {
  await fetch(`/api/admin/program-groups/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active }),
  });
  renderBackendPrograms();
}

async function deleteProgramGroup(id) {
  if (!(await showConfirm('Delete this group? All its options must already be removed. This cannot be undone.'))) return;
  const data = await (await fetch(`/api/admin/program-groups/${encodeURIComponent(id)}`, { method: 'DELETE' })).json();
  if (!data.success) showToast(data.error || 'Delete failed.');
  renderBackendPrograms();
}

async function handleAddProgramOption(e, form) {
  e.preventDefault();
  const nameInput = form.querySelector('.new-option-name');
  const payload = {
    groupId: Number(form.dataset.groupId),
    name: nameInput.value,
    capacity: parseInt(form.querySelector('.new-option-capacity').value, 10),
    fee: parseFloat(form.querySelector('.new-option-fee').value) || 0,
  };
  const data = await (await fetch('/api/admin/program-options', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  })).json();
  if (!data.success) return showToast(data.error || 'Could not add option.');
  renderBackendPrograms();
}

// Name, capacity and fee. A new name is the workshop's everywhere: the
// registration form, the programme (see programmeSessions) and the badge.
async function saveProgramOption(id, capacity, fee, name) {
  if (name !== undefined && !String(name).trim()) return showToast('Enter a name.');
  const data = await (await fetch(`/api/admin/program-options/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ capacity, fee, ...(name !== undefined ? { name: String(name).trim() } : {}) }),
  })).json();
  if (!data.success) showToast(data.error || 'Update failed.');
  else showToast('Saved.', 'success');
  renderBackendPrograms();
}

async function toggleProgram(id, active) {
  await fetch(`/api/admin/program-options/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active }),
  });
  renderBackendPrograms();
}

async function deleteProgram(id) {
  if (!(await showConfirm('Delete this option? This cannot be undone.'))) return;
  const data = await (await fetch(`/api/admin/program-options/${encodeURIComponent(id)}`, { method: 'DELETE' })).json();
  if (!data.success) showToast(data.error || 'Delete failed.');
  renderBackendPrograms();
}

// --- PROGRAM OPTION ROSTER (manual admin add/remove) ---
let rosterOptionId = null;
let rosterEnrolledPhones = new Set();

async function openRosterModal(id, name) {
  rosterOptionId = id;
  setText('roster-title', `Roster — ${name}`);
  document.getElementById('roster-search').value = '';
  hideRosterSearchResults();
  await loadRoster();
  openModal('modal-roster');
}

async function loadRoster() {
  const list = document.getElementById('roster-list');
  if (!list) return;
  list.innerHTML = '<p class="text-xs text-slate-400 py-3">Loading…</p>';
  const res = await fetch(`/api/admin/program-options/${encodeURIComponent(rosterOptionId)}/enrolled`);
  if (!res.ok) { list.innerHTML = '<p class="text-xs text-rose-600 py-3">Could not load roster.</p>'; return; }
  const data = await res.json();
  const enrolled = data.enrolled || [];
  rosterEnrolledPhones = new Set(enrolled.map((r) => r.phone_number));
  list.innerHTML = enrolled.length
    ? enrolled.map(r => `
      <div class="flex items-center justify-between py-2 gap-2">
        <div class="min-w-0">
          <p class="font-semibold text-slate-800 truncate">${esc(r.delegate_name)}${Number(r.is_faculty) ? ' <span class="text-[10px] bg-indigo-100 text-indigo-700 border border-indigo-300 px-2 py-0.5 rounded-full font-bold align-middle">Faculty</span>' : ''}</p>
          <p class="text-[11px] text-slate-500">${esc(delegateDisplayPhone(r) || r.email || '—')} · ${esc(r.registration_number || '—')}</p>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <label class="flex items-center gap-1.5 text-[11px] text-slate-600 cursor-pointer select-none">
            <input type="checkbox" class="roster-faculty-toggle" data-phone="${esc(r.phone_number)}" ${Number(r.is_faculty) ? 'checked' : ''}>
            Faculty
          </label>
          <button class="roster-remove px-2.5 py-1 bg-white border border-rose-300 text-rose-700 hover:bg-rose-50 text-xs font-semibold rounded-lg" data-phone="${esc(r.phone_number)}">Remove</button>
        </div>
      </div>`).join('')
    : '<p class="text-xs text-slate-400 py-3">Nobody enrolled yet.</p>';
}

// Faculty don't occupy a capacity slot on this option and are labeled
// "Faculty" instead of "Delegate" on the workshops/QI report.
async function toggleRosterFaculty(phone, isFaculty) {
  const data = await (await fetch(`/api/admin/program-options/${encodeURIComponent(rosterOptionId)}/enrolled/${encodeURIComponent(phone)}/faculty`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isFaculty }),
  })).json();
  if (!data.success) { showToast(data.error || 'Could not update faculty status.'); await loadRoster(); return; }
  await loadRoster();
  renderBackendPrograms();
  if (userDetailPhone) await openUserDetail(userDetailPhone);
}

function hideRosterSearchResults() {
  const box = document.getElementById('roster-search-results');
  if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
}

// Live-filters already-registered delegates (the only ones eligible for
// enrollment) by name, phone, or registration number -- reuses the payments
// list already fetched for this admin session rather than a new endpoint.
function handleRosterSearch(query) {
  const box = document.getElementById('roster-search-results');
  if (!box) return;
  const q = query.trim().toLowerCase();
  if (!q) return hideRosterSearchResults();

  const matches = (cachedPaymentRegs || [])
    .filter((r) => !rosterEnrolledPhones.has(r.phone_number))
    .filter((r) => `${r.delegate_name || ''} ${r.phone_number || ''} ${r.registration_number || ''}`.toLowerCase().includes(q))
    .slice(0, 8);

  box.innerHTML = matches.length
    ? matches.map(r => `
      <button type="button" class="roster-search-pick w-full text-left px-3 py-2 hover:bg-indigo-50" data-phone="${esc(r.phone_number)}">
        <p class="font-semibold text-slate-800 text-sm">${esc(r.delegate_name)}</p>
        <p class="text-[11px] text-slate-500">${esc(delegateDisplayPhone(r) || r.email || '—')} · ${esc(r.registration_number || '—')}${r.category_label ? ' · ' + esc(r.category_label) : ''}</p>
      </button>`).join('')
    : '<p class="text-xs text-slate-400 p-3">No matching registered delegates.</p>';
  box.classList.remove('hidden');
}

async function handleRosterEnroll(phone) {
  const data = await (await fetch(`/api/admin/program-options/${encodeURIComponent(rosterOptionId)}/enroll`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }),
  })).json();
  if (!data.success) return showToast(data.error || 'Could not enroll this delegate.');
  document.getElementById('roster-search').value = '';
  hideRosterSearchResults();
  await loadRoster();
  renderBackendPrograms();
}

async function handleRosterRemove(phone) {
  if (!(await showConfirm('Remove this delegate from the roster?'))) return;
  const data = await (await fetch(`/api/admin/program-options/${encodeURIComponent(rosterOptionId)}/enroll/${encodeURIComponent(phone)}`, {
    method: 'DELETE',
  })).json();
  if (!data.success) showToast(data.error || 'Could not remove this delegate.');
  await loadRoster();
  renderBackendPrograms();
}

// --- FEES (admin) ---
async function renderBackendFees() {
  const [res, confRes] = await Promise.all([fetch('/api/admin/fees'), fetch('/api/conference')]);
  const tbody = document.getElementById('fee-table-body');
  if (!tbody || !res.ok) return;
  const data = await res.json();
  setText('fee-current-phase', data.phase || '—');
  const cfg = data.config || {};
  const early = document.getElementById('fee-early-until');
  const regular = document.getElementById('fee-regular-until');
  const late = document.getElementById('fee-late-until');
  if (early) early.value = cfg.early_until || '';
  if (regular) regular.value = cfg.regular_until || '';
  if (late) late.value = cfg.late_until || '';
  // A pricing-phase cutoff can't be in the past, or after the conference has
  // already started -- nudged here, enforced server-side regardless (see
  // PUT /api/admin/fees/config).
  const todayStr = istDateString();
  const conf = confRes.ok ? await confRes.json() : {};
  [early, regular, late].forEach((el) => {
    if (!el) return;
    el.min = todayStr;
    if (conf.startDate) el.max = conf.startDate;
  });

  // The table is a read-only summary; everything is edited in
  // #modal-fee-category. It used to carry live text and number inputs, so a
  // stray keystroke could change a fee, or -- once labels became editable --
  // rename every registration in the category on the next Save. Caching the
  // rows lets the modal open without a second fetch.
  feeCategoriesById = Object.fromEntries((data.categories || []).map((c) => [String(c.id), c]));
  tbody.innerHTML = (data.categories || []).map((c) => `
    <tr class="${c.active ? '' : 'opacity-50'}" data-id="${esc(c.id)}">
      <td class="p-4">
        <p class="font-semibold text-slate-800">${esc(c.label)}</p>
        ${c.subtitle ? `<p class="text-xs text-slate-500">${esc(c.subtitle)}</p>` : ''}
        <!-- The key is shown, never edited: registrations, group discount
             rules and promo-code scopes all join on it. -->
        <p class="text-[10px] font-mono text-slate-400 mt-1">${esc(c.category_key)}${c.active ? '' : ' · inactive'}</p>
        ${Number(c.drifted) > 0 ? `
        <p class="mt-1.5 text-[10px] text-amber-800 font-bold bg-amber-100 border border-amber-300 rounded-full px-2 py-0.5 inline-block">${ICON('warning')}${esc(c.drifted)} registration${Number(c.drifted) === 1 ? '' : 's'} on an older name</p>` : ''}
      </td>
      <td class="p-4 text-sm text-slate-700 tabular-nums">₹${inr(c.early_fee)}</td>
      <td class="p-4 text-sm text-slate-700 tabular-nums">₹${inr(c.regular_fee)}</td>
      <td class="p-4 text-sm text-slate-700 tabular-nums">₹${inr(c.late_fee)}</td>
      <td class="p-4 text-sm text-slate-700 tabular-nums">₹${inr(c.spot_fee)}</td>
      <td class="p-4 text-sm">${c.requires_student_id
        ? `<span class="text-[10px] font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-full px-2 py-0.5">${ICON('gradcap')}Required</span>`
        : '<span class="text-slate-400">—</span>'}</td>
      <td class="p-4 text-right whitespace-nowrap">
        <button class="fee-edit px-3 py-1.5 bg-navy hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg" data-id="${esc(c.id)}">Edit</button>
      </td>
    </tr>`).join('');
}

// Small pill used throughout the activity log to show an action/outcome at a glance.
function activityPill(text, tone) {
  const tones = {
    ok: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    bad: 'bg-rose-50 text-rose-700 border-rose-200',
    warn: 'bg-amber-50 text-amber-700 border-amber-200',
    info: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    muted: 'bg-slate-100 text-slate-600 border-slate-200',
  };
  return `<span class="inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-full border ${tones[tone] || tones.muted}">${esc(text)}</span>`;
}

function activityTransition(oldVal, newVal) {
  return `<span class="text-slate-400 line-through">${esc(oldVal ?? '—')}</span> <span class="text-slate-300">→</span> <span class="font-semibold text-slate-800">${esc(newVal ?? '—')}</span>`;
}

const ACTIVITY_ACTION_LABELS = {
  BANK_STATUS_CHANGE: 'Status', STUDENT_ID_VERIFICATION: 'ID Verified', UTR_CORRECTION: 'UTR Fix',
  PAYMENT_MODE_CORRECTION: 'Mode Fix', ADMIN_ENROLL: 'Roster +', ADMIN_UNENROLL: 'Roster −',
  BANK_TXN_LINK: 'Linked', BANK_TXN_UNLINK: 'Unlinked', PAYMENT_ADMIN_ADDED: 'Payment Added', ABSTRACT_STATUS_CHANGE: 'Status', ABSTRACT_ALLOCATION: 'Allotted',
  ABSTRACT_EXTENSION_GRANT: 'Late Submission Allowed', ABSTRACT_EXTENSION_REVOKE: 'Late Submission Withdrawn',
  GUEST_ADDED: 'Marked Faculty', GUEST_UPDATED: 'Faculty Updated', GUEST_REMOVED: 'Faculty Removed', GUEST_LINKED: 'Faculty Linked', GUEST_UNLINKED: 'Faculty Unlinked',
  GUEST_VEHICLE_ADDED: 'Vehicle Added', GUEST_VEHICLE_UPDATED: 'Vehicle Updated', GUEST_VEHICLE_DELETED: 'Vehicle Deleted',
  GUEST_ROOM_ADDED: 'Room Added', GUEST_ROOM_UPDATED: 'Room Updated', GUEST_ROOM_DELETED: 'Room Deleted',
  GUEST_LIST_VALUE_ADDED: 'List Value Added', GUEST_LIST_VALUE_ON: 'List Value On', GUEST_LIST_VALUE_OFF: 'List Value Off',
  GUEST_LIST_VALUE_DELETED: 'List Value Removed', GUEST_SETTINGS_UPDATED: 'Faculty Settings',
  PROGRAM_OPTION_CREATE: 'Created', PROGRAM_OPTION_UPDATE: 'Updated', PROGRAM_OPTION_DELETE: 'Deleted',
  FEE_CONFIG_UPDATE: 'Dates Updated', FEE_CATEGORY_CREATE: 'Created', FEE_CATEGORY_UPDATE: 'Updated', FEE_CATEGORY_DELETE: 'Deleted',
  FEE_CATEGORY_REALIGN: 'Labels Realigned',
  DISCOUNT_CODE_CREATE: 'Created', DISCOUNT_CODE_UPDATE: 'Updated', DISCOUNT_CODE_DELETE: 'Deleted', DISCOUNT_CODE_USED: 'Used', DISCOUNT_CODE_EMAILED: 'Emailed',
  GROUP_RULE_SET: 'Created', GROUP_RULE_UPDATE: 'Updated', GROUP_RULE_DELETE: 'Deleted',
  GENERAL_SETTINGS_UPDATE: 'Updated', BANK_TXN_NON_REGISTRATION_UPDATE: 'Non-Reg Marking',
  PAYMENT_REFUNDED: 'Refunded', PAYMENT_REFUND_DELETED: 'Refund Deleted',
};
function activityActionPill(action) {
  const label = ACTIVITY_ACTION_LABELS[action] || action;
  let tone = 'muted';
  if (action === 'BANK_STATUS_CHANGE') tone = 'info';
  else if (action === 'STUDENT_ID_VERIFICATION' || action === 'BANK_TXN_LINK' || action === 'PAYMENT_ADMIN_ADDED' || action === 'PAYMENT_REFUNDED' || action === 'PROGRAM_OPTION_CREATE' || action === 'FEE_CATEGORY_CREATE'
    || action === 'DISCOUNT_CODE_CREATE' || action === 'DISCOUNT_CODE_USED' || action === 'GROUP_RULE_SET') tone = 'ok';
  else if (action === 'ADMIN_UNENROLL' || action === 'BANK_TXN_UNLINK' || action === 'PAYMENT_REFUND_DELETED' || action.endsWith('_DELETE')) tone = 'bad';
  else if (action.includes('CORRECTION') || action.endsWith('_UPDATE')) tone = 'warn';
  return activityPill(label, tone);
}

async function renderBackendActivity() {
  const res = await fetch('/api/admin/activity-log');
  if (!res.ok) return;
  const data = await res.json();

  setText('activity-count-imports', String((data.imports || []).length));
  document.getElementById('activity-imports-body').innerHTML = (data.imports || []).map((r) => `
    <tr>
      <td class="py-3 px-4 whitespace-nowrap text-slate-500">${fmtAuditTime(r.imported_at)}</td>
      <td class="py-3 px-4 font-mono text-xs text-slate-600">${esc(r.source_file)}</td>
      <td class="py-3 px-4">${esc(r.rows_imported)}</td>
      <td class="py-3 px-4 font-semibold">₹${inr(esc(r.total_credit ?? 0))}</td>
      <td class="py-3 px-4">${esc(r.imported_by)}</td>
    </tr>`).join('') || `<tr><td colspan="5" class="py-6 text-center text-slate-400">No statement imports yet</td></tr>`;

  setText('activity-count-mapping', String((data.mapping || []).length));
  document.getElementById('activity-mapping-body').innerHTML = (data.mapping || []).map((r) => `
    <tr>
      <td class="py-3 px-4 whitespace-nowrap text-slate-500">${fmtAuditTime(r.created_at)}</td>
      <td class="py-3 px-4 font-mono text-xs">${esc(r.registration_number || ('id:' + r.entity_id))}</td>
      <td class="py-3 px-4">${esc(r.delegate_name || '—')}</td>
      <td class="py-3 px-4">${activityTransition(r.action === 'BANK_TXN_UNLINK' ? ('txn #' + r.old_value) : 'unlinked', r.action === 'BANK_TXN_UNLINK' ? 'unlinked' : ('txn #' + r.new_value))}</td>
      <td class="py-3 px-4">${esc(r.actor_name)}</td>
    </tr>`).join('') || `<tr><td colspan="5" class="py-6 text-center text-slate-400">No transaction links yet</td></tr>`;

  setText('activity-count-approval', String((data.approval || []).length));
  document.getElementById('activity-approval-body').innerHTML = (data.approval || []).map((r) => `
    <tr>
      <td class="py-3 px-4 whitespace-nowrap text-slate-500">${fmtAuditTime(r.created_at)}</td>
      <td class="py-3 px-4 font-mono text-xs">${esc(r.registration_number || ('id:' + r.entity_id))}</td>
      <td class="py-3 px-4">${esc(r.delegate_name || '—')}</td>
      <td class="py-3 px-4">${activityActionPill(r.action)}</td>
      <td class="py-3 px-4">${activityTransition(r.old_value, r.new_value)}</td>
      <td class="py-3 px-4">${esc(r.actor_name)} <span class="text-[10px] text-slate-400">${esc((r.actor_role || '').replace('_', ' '))}</span></td>
    </tr>`).join('') || `<tr><td colspan="6" class="py-6 text-center text-slate-400">No registration approval activity yet</td></tr>`;

  setText('activity-count-abstract-approval', String((data.abstractApproval || []).length));
  document.getElementById('activity-abstract-approval-body').innerHTML = (data.abstractApproval || []).map((r) => `
    <tr>
      <td class="py-3 px-4 whitespace-nowrap text-slate-500">${fmtAuditTime(r.created_at)}</td>
      <td class="py-3 px-4">${esc(r.title || '—')}</td>
      <td class="py-3 px-4">${esc(r.author_name || '—')}</td>
      <td class="py-3 px-4">${activityTransition(r.old_value, r.new_value)}</td>
      <td class="py-3 px-4">${esc(r.actor_name)}</td>
    </tr>`).join('') || `<tr><td colspan="5" class="py-6 text-center text-slate-400">No abstract decisions logged yet</td></tr>`;

  setText('activity-count-abstract-allotment', String((data.abstractAllotment || []).length));
  document.getElementById('activity-abstract-allotment-body').innerHTML = (data.abstractAllotment || []).map((r) => `
    <tr>
      <td class="py-3 px-4 whitespace-nowrap text-slate-500">${fmtAuditTime(r.created_at)}</td>
      <td class="py-3 px-4">${esc(r.title || '—')}</td>
      <td class="py-3 px-4">${esc(r.author_name || '—')}</td>
      <td class="py-3 px-4">${activityTransition(r.old_value, r.new_value)}</td>
      <td class="py-3 px-4">${esc(r.actor_name)}</td>
    </tr>`).join('') || `<tr><td colspan="5" class="py-6 text-center text-slate-400">No allotments logged yet</td></tr>`;

  const areaLabels = {
    program_option: 'Workshop / QI', fee_config: 'Fee Dates', fee_category: 'Fee Category',
    discount_code: 'Discount Code', group_rule: 'Group Discount', general_settings: 'Conference setup', settings: 'Conference setup',
    bank_statement_transaction: 'Bank Statement',
  };
  setText('activity-count-master', String((data.master || []).length));
  document.getElementById('activity-master-body').innerHTML = (data.master || []).map((r) => `
    <tr>
      <td class="py-3 px-4 whitespace-nowrap text-slate-500">${fmtAuditTime(r.created_at)}</td>
      <td class="py-3 px-4">${activityPill(areaLabels[r.entity_type] || r.entity_type, 'info')} ${activityActionPill(r.action)}</td>
      <td class="py-3 px-4">${activityTransition(r.old_value, r.new_value)}</td>
      <td class="py-3 px-4">${esc(r.actor_name)}</td>
    </tr>`).join('') || `<tr><td colspan="4" class="py-6 text-center text-slate-400">No settings changes logged yet</td></tr>`;

  setText('activity-count-login', String((data.login || []).length));
  document.getElementById('activity-login-body').innerHTML = (data.login || []).map((r) => `
    <tr>
      <td class="py-3 px-4 whitespace-nowrap text-slate-500">${fmtAuditTime(r.created_at)}</td>
      <td class="py-3 px-4">${esc(r.actor_name || '—')}</td>
      <td class="py-3 px-4 font-mono text-xs">${esc(delegateDisplayPhone({ phone_number: r.phone }) || r.phone)}</td>
      <td class="py-3 px-4">${esc((r.actor_role || '').replace('_', ' '))}</td>
    </tr>`).join('') || `<tr><td colspan="4" class="py-6 text-center text-slate-400">No logins logged yet</td></tr>`;

  setText('activity-count-sms', String((data.sms || []).length));
  document.getElementById('activity-sms-body').innerHTML = (data.sms || []).map((r) => `
    <tr>
      <td class="py-3 px-4 whitespace-nowrap text-slate-500">${fmtAuditTime(r.created_at)}</td>
      <td class="py-3 px-4 font-mono text-xs">${esc(delegateDisplayPhone({ phone_number: r.phone }) || r.phone)}</td>
      <td class="py-3 px-4">${activityPill(r.action === 'SMS_SENT' ? 'Sent' : 'Failed', r.action === 'SMS_SENT' ? 'ok' : 'bad')}</td>
      <td class="py-3 px-4 text-xs text-slate-500">${esc(r.detail || '—')}</td>
    </tr>`).join('') || `<tr><td colspan="4" class="py-6 text-center text-slate-400">No SMS sent yet</td></tr>`;

  setText('activity-count-email', String((data.email || []).length));
  document.getElementById('activity-email-body').innerHTML = (data.email || []).map((r) => `
    <tr>
      <td class="py-3 px-4 whitespace-nowrap text-slate-500">${fmtAuditTime(r.created_at)}</td>
      <td class="py-3 px-4 text-xs">${esc(r.recipient)}</td>
      <td class="py-3 px-4 text-xs text-slate-500">${esc(r.detail || '—')}</td>
      <td class="py-3 px-4">${activityPill(r.action === 'EMAIL_SENT' ? 'Sent' : 'Failed', r.action === 'EMAIL_SENT' ? 'ok' : 'bad')}</td>
    </tr>`).join('') || `<tr><td colspan="4" class="py-6 text-center text-slate-400">No emails sent yet</td></tr>`;

  // Only set the initial sub-tab -- if the admin already picked one while
  // this fetch was in flight, leave their choice alone.
  if (!document.querySelector('[id^="activity-panel-"]:not(.hidden)')) switchActivityLog('imports');

  // Re-fetching replaces every tbody's innerHTML, which would otherwise
  // silently drop a filter someone had typed while the fetch was in
  // flight -- the search box would still show their text, but every row
  // would be back to visible. Re-apply whichever logs already have one.
  ACTIVITY_SUBTABS.forEach((key) => {
    const input = document.getElementById(`activity-search-${key}`);
    if (input && input.value) filterActivityRows(key);
  });
}

// Plain client-side row filter for one activity log's own table -- matches
// filterReportRows()'s approach (row text includes the query), just against
// <tr> elements instead of the generic report viewer's .report-row divs.
function filterActivityRows(key) {
  const input = document.getElementById(`activity-search-${key}`);
  const tbody = document.getElementById(`activity-${key}-body`);
  if (!input || !tbody) return;
  const q = input.value.trim().toLowerCase();
  tbody.querySelectorAll('tr').forEach((row) => {
    row.classList.toggle('hidden', !(!q || row.textContent.toLowerCase().includes(q)));
  });
}

async function saveFeeConfig() {
  const data = await (await fetch('/api/admin/fees/config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      earlyUntil: document.getElementById('fee-early-until').value || null,
      regularUntil: document.getElementById('fee-regular-until').value || null,
      lateUntil: document.getElementById('fee-late-until').value || null,
    })
  })).json();
  if (!data.success) return showToast(data.error || 'Could not save dates.');
  renderBackendFees();
}


async function handleAddFeeCategory(e) {
  e.preventDefault();
  const body = {
    categoryKey: document.getElementById('new-fee-key').value.trim(),
    label: document.getElementById('new-fee-label').value.trim(),
    subtitle: document.getElementById('new-fee-subtitle').value.trim(),
    earlyFee: Number(document.getElementById('new-fee-early').value),
    regularFee: Number(document.getElementById('new-fee-regular').value),
    lateFee: Number(document.getElementById('new-fee-late').value),
    spotFee: Number(document.getElementById('new-fee-spot').value),
    requiresStudentId: document.getElementById('new-fee-studentid').checked,
  };
  const data = await (await fetch('/api/admin/fees/categories', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  })).json();
  if (!data.success) return showToast(data.error || 'Could not add category.');
  document.getElementById('new-fee-key').value = '';
  document.getElementById('new-fee-label').value = '';
  document.getElementById('new-fee-subtitle').value = '';
  document.getElementById('new-fee-studentid').checked = false;
  reviewCategoryList = null; // category list changed -- force ensureReviewCategories() to refetch
  renderBackendFees();
}

// Rows cached by renderBackendFees so the modal opens without refetching.
let feeCategoriesById = {};
let editingFeeCategoryId = null;

// Everything about a category is edited here. The table itself is read-only:
// live inputs in a dense table made a stray keystroke enough to change a fee
// or, once labels became editable, rename every registration in the category.
function openFeeCategoryModal(id) {
  const c = feeCategoriesById[String(id)];
  if (!c) return showToast('That category is no longer on screen — reloading.');
  editingFeeCategoryId = String(id);

  setText('fc-key', c.category_key);
  const set = (elId, value) => { const el = document.getElementById(elId); if (el) el.value = value; };
  set('fc-label', c.label || '');
  set('fc-subtitle', c.subtitle || '');
  set('fc-early', c.early_fee);
  set('fc-regular', c.regular_fee);
  set('fc-late', c.late_fee);
  set('fc-spot', c.spot_fee);
  const check = (elId, on) => { const el = document.getElementById(elId); if (el) el.checked = !!on; };
  check('fc-studentid', c.requires_student_id);
  check('fc-active', c.active);

  // Renaming rewrites registrations.category_label for everyone in the
  // category -- what receipts and exports print -- so the count is stated
  // before it happens, not reported afterwards.
  const note = document.getElementById('fc-rename-note');
  const regs = Number(c.registrations) || 0;
  if (note) {
    note.textContent = regs > 0
      ? `Renaming also updates ${regs} existing registration${regs === 1 ? '' : 's'} — their receipts and exports will show the new name.`
      : '';
    note.classList.toggle('hidden', regs === 0);
  }

  // Drift is rows carrying an OLDER name than the saved label, from a rename
  // made outside the app. Realign applies the saved label, so it is offered
  // apart from the rename field above rather than folded into Save.
  const drift = document.getElementById('fc-drift');
  const drifted = Number(c.drifted) || 0;
  if (drift) {
    drift.classList.toggle('hidden', drifted === 0);
    setText('fc-drift-msg', drifted > 0
      ? `${drifted} registration${drifted === 1 ? '' : 's'} in this category still show an older name.`
      : '');
  }

  // Deletion is refused server-side once anything references the category.
  // Saying so on the button beats letting the press fail.
  const delBtn = document.getElementById('fc-delete-btn');
  const delNote = document.getElementById('fc-delete-note');
  if (delBtn) delBtn.disabled = regs > 0;
  if (delNote) {
    delNote.textContent = regs > 0
      ? `Cannot delete: ${regs} registration${regs === 1 ? '' : 's'} use this category. Untick Active instead — it stays on existing registrations but is no longer offered.`
      : 'Nothing uses this category yet, so it can be deleted.';
  }

  openModal('modal-fee-category');
}

async function saveFeeCategoryModal() {
  const id = editingFeeCategoryId;
  if (!id) return;
  const val = (elId) => (document.getElementById(elId) || {}).value;
  const on = (elId) => !!(document.getElementById(elId) || {}).checked;
  const label = String(val('fc-label') || '').trim();
  if (!label) return showToast('Label is required.');

  const btn = document.getElementById('fc-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  const data = await (await fetch(`/api/admin/fees/categories/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      label,
      subtitle: String(val('fc-subtitle') || '').trim(),
      earlyFee: Number(val('fc-early')),
      regularFee: Number(val('fc-regular')),
      lateFee: Number(val('fc-late')),
      spotFee: Number(val('fc-spot')),
      requiresStudentId: on('fc-studentid'),
      active: on('fc-active') ? 1 : 0,
    }),
  })).json();
  if (btn) { btn.disabled = false; btn.textContent = 'Save changes'; }

  if (!data.success) return showToast(data.error || 'Update failed.');
  showToast(data.renamed > 0
    ? `Saved. ${data.renamed} registration${data.renamed === 1 ? '' : 's'} updated to the new name.`
    : 'Category saved.', 'success');
  closeModal('modal-fee-category');
  reviewCategoryList = null; // requiresStudentId may have changed -- force ensureReviewCategories() to refetch
  renderBackendFees();
}

// Bring registrations that stored an older name for this category up to the
// current label. Only the display name changes -- not the category, not the
// fee -- but it does alter what already-issued receipts print, so it asks
// first, like every other irreversible action here.
async function realignFeeCategory(id) {
  // The SAVED label, from the cached row -- realign applies what the server
  // already holds, so quoting the unsaved edit box would promise something
  // this does not do.
  const c = feeCategoriesById[String(id)] || {};
  const label = c.label || 'the saved label';
  if (!(await showConfirm(`Update every registration in this category to "${label}"? Their receipts and exports will show the new name.`))) return;
  const data = await (await fetch(`/api/admin/fees/categories/${encodeURIComponent(id)}/realign`, { method: 'POST' })).json();
  if (!data.success) return showToast(data.error || 'Could not realign.');
  showToast(`${data.updated} registration${data.updated === 1 ? '' : 's'} updated.`, 'success');
  closeModal('modal-fee-category');
  renderBackendFees();
}

async function deleteFeeCategory(id) {
  const c = feeCategoriesById[String(id)] || {};
  // Belt and braces: the button is disabled in this case and the server
  // refuses with a 409 regardless, but nothing here should be the only guard.
  if (Number(c.registrations) > 0) {
    return showToast('This category is in use and cannot be deleted. Untick Active instead.');
  }
  if (!(await showConfirm(`Delete "${c.label || 'this category'}"? This cannot be undone.`))) return;
  const data = await (await fetch(`/api/admin/fees/categories/${encodeURIComponent(id)}`, { method: 'DELETE' })).json();
  if (!data.success) return showToast(data.error || 'Delete failed.');
  showToast('Category deleted.', 'success');
  closeModal('modal-fee-category');
  reviewCategoryList = null; // category list changed -- force ensureReviewCategories() to refetch
  renderBackendFees();
}

// --- DISCOUNT CODES (admin) ---
let cachedDiscountCodes = [];
let shareDiscountCodeId = null;

// Build the copy-pasteable WhatsApp message and open the share modal (PDF
// voucher link + WhatsApp text). Reuses the already-fetched code list rather
// than a second round trip.
function openShareDiscountModal(id) {
  const c = (cachedDiscountCodes || []).find((x) => String(x.id) === String(id));
  if (!c) return;

  const discountLine = describeDiscountCode(c);
  let scopeLine = '';
  if (c.scope_type === 'INDIVIDUAL' && c.pending_email) {
    scopeLine = `\nThis code is reserved for ${c.pending_email}. Sign up with that email address to use it.`;
  } else if (c.scope_type === 'INDIVIDUAL') {
    const u = (cachedUsers || []).find((x) => x.phone_number === c.scope_value);
    scopeLine = `\nThis code is reserved for ${u ? u.full_name : 'you'} only.`;
  } else if (c.scope_type === 'CATEGORY') {
    scopeLine = '\nApplies to a specific delegate category — check on the registration page.';
  } else if (c.scope_type === 'DOMAIN') {
    scopeLine = `\nFor anyone with a verified @${c.scope_value} email address — applied automatically at payment.`;
  }
  const expiryLine = c.expires_at ? `\nValid through ${formatDMY(c.expires_at)}.` : '';
  const portalUrl = window.location.origin;

  // Deliberately emoji-free: emoji in this message rendered as tofu/blanks on
  // some recipients' devices, so the structure comes from WhatsApp's own
  // *bold* markup instead of decorative characters.
  const message = `*${conferenceInfo.acronym} — Discount Code*\n\n` +
    `Code: *${c.code}*\n` +
    `Discount: ${discountLine}${scopeLine}${expiryLine}\n\n` +
    `How to use:\n` +
    `1. Go to ${portalUrl}\n` +
    `2. Register / log in and select your category\n` +
    `3. Tap "Apply promo code" and enter ${c.code}\n\n` +
    `See you at the conference!`;

  setText('share-discount-code', c.code);
  const textarea = document.getElementById('share-whatsapp-text');
  if (textarea) textarea.value = message;
  // For an individual code, pre-fill the delegate's own number (India country
  // code 91 + their 10-digit mobile) so the chat opens directly with them
  // instead of WhatsApp's "choose a contact" screen.
  // wa.me wants digits with the country code and no '+'.
  const waNumber = c.scope_type === 'INDIVIDUAL' ? toE164(c.scope_value || '').replace(/^\+/, '') : '';
  const waLink = document.getElementById('share-whatsapp-link');
  if (waLink) waLink.href = `https://wa.me/${waNumber}?text=${encodeURIComponent(message)}`;
  const pdfLink = document.getElementById('share-pdf-link');
  if (pdfLink) pdfLink.href = `/api/admin/discount-codes/${encodeURIComponent(c.id)}/share`;

  shareDiscountCodeId = c.id;
  const emailInput = document.getElementById('share-email-address');
  if (emailInput) {
    // Pre-fill for an individual code if that delegate has an email on file
    // (same convenience as the WhatsApp number pre-fill above) -- still a
    // plain editable field, so sending to a different/new address just means
    // typing over it.
    const u = c.scope_type === 'INDIVIDUAL' ? (cachedUsers || []).find((x) => x.phone_number === c.scope_value) : null;
    emailInput.value = (u && u.email) || '';
  }

  openModal('modal-share-discount');
}

async function handleEmailShareDiscount(e) {
  e.preventDefault();
  if (!shareDiscountCodeId) return;
  const email = document.getElementById('share-email-address').value.trim();
  const btn = document.getElementById('share-email-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  try {
    const data = await (await fetch(`/api/admin/discount-codes/${encodeURIComponent(shareDiscountCodeId)}/email`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
    })).json();
    if (!data.success) return showToast(data.error || 'Could not send the email.');
    showToast(`Sent to ${email}.`, 'success');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = ICON('envelope') + 'Send'; }
  }
}

async function copyShareWhatsappText() {
  const textarea = document.getElementById('share-whatsapp-text');
  if (!textarea) return;
  try {
    await navigator.clipboard.writeText(textarea.value);
    showToast('Message copied — paste it into WhatsApp.', 'success');
  } catch (e) {
    // Clipboard API can be blocked (non-HTTPS, permissions); fall back to a
    // manual select so the admin can still Ctrl/Cmd+C it themselves.
    textarea.select();
    showToast('Could not auto-copy — text is selected, press Ctrl/Cmd+C.');
  }
}

// Generate a random, human-readable code (no ambiguous 0/O/1/I) so the admin
// doesn't have to invent one. Uniqueness is enforced by the server's UNIQUE
// index; on the rare collision the create call surfaces an error and a fresh
// code can be generated.
function generateDiscCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  const el = document.getElementById('new-disc-code');
  if (el) el.value = s;
}

// "50% off" / "₹500 off" / "Fee set to ₹1,000" -- same wording as the
// server's describeDiscount(), which the voucher and emails use.
function describeDiscountCode(c) {
  const v = Number(c.discount_value);
  if (c.discount_type === 'PERCENT') return `${v}% off`;
  if (c.discount_type === 'FEE_TIER') return `Pay the ${FEE_TIER_LABELS[c.fee_tier] || 'set'} fee`;
  if (c.discount_type === 'FIXED_FEE') return `Fee set to ₹${inr(v)}`; // issued before tiers
  return `₹${inr(v)} off`;
}

// Fee tiers, named as on the fee master (server: FEE_TIERS).
const FEE_TIER_LABELS = { early: 'Early Bird', regular: 'Regular', late: 'Late', spot: 'Spot' };

// A tier code has no amount -- the fee is the delegate's own category at that
// tier -- so the value field gives way to a tier picker, and stops being
// required (a hidden required field would block the form).
function updateDiscTypeHints() {
  const type = document.getElementById('new-disc-type').value;
  const tier = type === 'FEE_TIER';
  const input = document.getElementById('new-disc-value');
  const label = document.getElementById('new-disc-value-label');
  document.getElementById('new-disc-value-wrap').classList.toggle('hidden', tier);
  document.getElementById('new-disc-tier-wrap').classList.toggle('hidden', !tier);
  if (input) input.required = !tier;
  if (label) label.textContent = type === 'PERCENT' ? 'Value (%)' : 'Value (₹)';
}

function updateDiscScopeHints() {
  const scope = document.getElementById('new-disc-scope').value;
  const catWrap = document.getElementById('new-disc-scope-cat-wrap');
  const phoneWrap = document.getElementById('new-disc-scope-phone-wrap');
  const maxWrap = document.getElementById('new-disc-max-wrap');
  if (catWrap) catWrap.classList.toggle('hidden', scope !== 'CATEGORY');
  if (phoneWrap) phoneWrap.classList.toggle('hidden', scope !== 'INDIVIDUAL');
  const domainWrap = document.getElementById('new-disc-scope-domain-wrap');
  if (domainWrap) domainWrap.classList.toggle('hidden', scope !== 'DOMAIN');
  // An individual code is single-delegate by nature, so a usage cap is
  // meaningless -- hide and clear it for that scope.
  const isIndividual = scope === 'INDIVIDUAL';
  if (maxWrap) maxWrap.classList.toggle('hidden', isIndividual);
  if (isIndividual) document.getElementById('new-disc-max').value = '';
  if (scope !== 'INDIVIDUAL') clearDiscDelegate();
}

// Delegate picker for an individual-scoped code -- searches the full user list
// (not just those who've paid) so a code can be given to anyone registered.
function searchDiscDelegate(query) {
  const box = document.getElementById('new-disc-delegate-results');
  if (!box) return;
  const q = String(query || '').trim().toLowerCase();
  document.getElementById('new-disc-scope-phone').value = '';
  document.getElementById('new-disc-delegate-selected').classList.add('hidden');
  if (!q) { box.classList.add('hidden'); return; }
  // Searches email as well as name/mobile/reg-no, so an email-only delegate
  // is reachable here at all. What gets STORED is still u.phone_number --
  // the account key, which is what the server matches an INDIVIDUAL code
  // against -- so nothing about the stored shape changes.
  const matches = (cachedUsers || [])
    .filter((u) => `${u.full_name || ''} ${delegateDisplayPhone(u)} ${u.email || ''} ${u.registration_number || ''}`.toLowerCase().includes(q))
    .slice(0, 8);
  // A full email address that no account uses can still be chosen: the code
  // waits on it and becomes that person's when they sign up with it.
  const typed = String(query || '').trim();
  const isNewEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(typed)
    && !(cachedUsers || []).some((u) => (u.email || '').toLowerCase() === typed.toLowerCase());
  const newEmailOption = isNewEmail
    ? `<button type="button" class="w-full text-left px-3 py-2 hover:bg-amber-50" onclick="pickDiscPendingEmail('${esc(typed.replace(/'/g, "\\'"))}')">
        <p class="font-semibold text-amber-800 text-sm">Issue to ${esc(typed)}</p>
        <p class="text-[11px] text-slate-500">No account uses this address yet — the code activates when they sign up with it.</p>
      </button>` : '';
  box.innerHTML = (matches.length
    ? matches.map((u) => `<button type="button" class="w-full text-left px-3 py-2 hover:bg-indigo-50" onclick="pickDiscDelegate('${esc(u.phone_number)}', '${esc((u.full_name || '').replace(/'/g, "\\'"))}', '${esc(discDelegateContact(u))}')">
        <p class="font-semibold text-slate-800 text-sm">${esc(u.full_name || '—')}</p>
        <p class="text-[11px] text-slate-500">${esc(discDelegateContact(u))}${u.registration_number ? ' · ' + esc(u.registration_number) : ''}</p>
      </button>`).join('')
    : (newEmailOption ? '' : '<p class="text-xs text-slate-400 p-3">No matching delegate. Type their full email address to issue a code before they sign up.</p>'))
    + newEmailOption;
  box.classList.remove('hidden');
}

// How to show a delegate's contact in the picker: their mobile when they
// have one, otherwise their email -- never the raw account key, which is
// synthetic for an email-only account.
function discDelegateContact(u) {
  const ph = delegateDisplayPhone(u);
  return ph || (u.email || '');
}

function pickDiscDelegate(key, name, contact) {
  document.getElementById('new-disc-scope-phone').value = key;
  document.getElementById('new-disc-delegate-search').value = name || contact || key;
  document.getElementById('new-disc-delegate-results').classList.add('hidden');
  const sel = document.getElementById('new-disc-delegate-selected');
  sel.textContent = `✓ ${name || ''}${contact ? ` (${contact})` : ''}`;
  sel.classList.remove('hidden');
}

function pickDiscPendingEmail(email) {
  // The server resolves an email to an account if one exists by then, and
  // otherwise stores it as waiting -- so the address itself is what is sent.
  document.getElementById('new-disc-scope-phone').value = email;
  document.getElementById('new-disc-delegate-search').value = email;
  document.getElementById('new-disc-delegate-results').classList.add('hidden');
  const sel = document.getElementById('new-disc-delegate-selected');
  sel.textContent = `✓ ${email} — waiting for them to sign up`;
  sel.classList.remove('hidden');
}

function clearDiscDelegate() {
  const s = document.getElementById('new-disc-delegate-search');
  const p = document.getElementById('new-disc-scope-phone');
  const r = document.getElementById('new-disc-delegate-results');
  const sel = document.getElementById('new-disc-delegate-selected');
  if (s) s.value = '';
  if (p) p.value = '';
  if (r) r.classList.add('hidden');
  if (sel) sel.classList.add('hidden');
}

const DISC_SCOPE_LABEL = { GLOBAL: 'All delegates', CATEGORY: 'Category', INDIVIDUAL: 'Individual' };
async function renderDiscountCodes() {
  const tbody = document.getElementById('discount-table-body');
  if (!tbody) return;
  // Populate the category scope picker from the fee master (reuse the cache).
  const cats = await ensureReviewCategories();
  const catSel = document.getElementById('new-disc-scope-cat');
  if (catSel && !catSel.dataset.filled) {
    catSel.innerHTML = cats.map((c) => `<option value="${esc(c.key)}">${esc(c.label)}</option>`).join('');
    catSel.dataset.filled = '1';
  }
  // Pre-fill a generated code so the field is never blank.
  const codeEl = document.getElementById('new-disc-code');
  if (codeEl && !codeEl.value) generateDiscCode();
  const res = await fetch('/api/admin/discount-codes');
  if (!res.ok) return;
  const codes = (await res.json()).codes || [];
  cachedDiscountCodes = codes; // reused by openShareDiscountModal() below
  const catLabel = (key) => (cats.find((c) => c.key === key) || {}).label || key;
  tbody.innerHTML = discountCodeTableHtml(codes, catLabel);
}

// The list in three groups. Used wins over Expired: a used code has nothing
// left to extend, whatever its date (see discountCodeUsedUp). Unused includes
// a shared code that still has uses left -- its Used column says how many.
const DISC_GROUPS = [
  { key: 'unused', label: 'Unused', hint: 'Still available to use.', openByDefault: true },
  { key: 'expired', label: 'Expired', hint: 'Unused, but past their last date — extend one to bring it back.', openByDefault: true },
  { key: 'used', label: 'Used', hint: 'Used by their holder, or at their usage limit.', openByDefault: false },
  { key: 'deactivated', label: 'Deactivated', hint: 'Switched off — by an admin, or when their holder registered without them. Activate one to bring it back.', openByDefault: false },
];

// Switched off only when the row says so -- a row without the field is not
// guessed to be off.
function discountCodeDeactivated(c) {
  return c.active != null && !Number(c.active);
}
// Deactivated comes first: a code that is switched off cannot be used,
// whatever else is true of it, so that is where it is looked for.
function discountCodeGroup(c) {
  if (discountCodeDeactivated(c)) return 'deactivated';
  if (discountCodeUsedUp(c)) return 'used';
  if (c.expires_at && c.expires_at < istDateString()) return 'expired';
  return 'unused';
}

// Open or collapsed, remembered per browser. Storage can be unavailable
// (private mode, blocked site data) -- the defaults then apply.
function discGroupOpen(key) {
  const v = storageGet('local', `nqocn_disc_group_${key}`);
  if (v === '1') return true;
  if (v === '0') return false;
  const g = DISC_GROUPS.find((x) => x.key === key);
  return g ? g.openByDefault : true;
}

function toggleDiscGroup(key) {
  const open = !discGroupOpen(key);
  storageSet('local', `nqocn_disc_group_${key}`, open ? '1' : '0');
  document.querySelectorAll(`[data-disc-group="${key}"]`).forEach((r) => r.classList.toggle('hidden', !open));
  const head = document.getElementById(`disc-group-head-${key}`);
  if (head) {
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    const chevron = head.querySelector('.disc-chevron');
    if (chevron) chevron.style.transform = open ? 'rotate(90deg)' : '';
  }
}

function discountCodeTableHtml(codes, catLabel) {
  if (!codes.length) return '<tr><td colspan="7" class="p-6 text-center text-slate-400">No discount codes yet.</td></tr>';
  return DISC_GROUPS.map((g) => {
    const members = codes.filter((c) => discountCodeGroup(c) === g.key);
    const open = discGroupOpen(g.key);
    const head = `<tr class="bg-slate-50 border-y border-slate-200">
      <td colspan="7" class="p-0">
        <button type="button" id="disc-group-head-${g.key}" onclick="toggleDiscGroup('${g.key}')" aria-expanded="${open ? 'true' : 'false'}"
          class="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500">
          <span class="disc-chevron inline-block text-slate-400 transition-transform" style="${open ? 'transform:rotate(90deg)' : ''}">▸</span>
          <span class="text-xs font-bold text-slate-700 uppercase tracking-wide">${g.label}</span>
          <span class="text-[11px] font-bold px-2 py-0.5 rounded-full bg-white border border-slate-300 text-slate-600">${members.length}</span>
          <span class="hidden sm:inline text-[11px] text-slate-400">${g.hint}</span>
        </button>
      </td>
    </tr>`;
    const rows = members.length
      ? members.map((c) => discountCodeRowHtml(c, catLabel, g.key, open)).join('')
      : `<tr data-disc-group="${g.key}" class="${open ? '' : 'hidden'}"><td colspan="7" class="px-4 py-3 text-sm text-slate-400">No ${g.label.toLowerCase()} codes.</td></tr>`;
    return head + rows;
  }).join('');
}

function discountCodeRowHtml(c, catLabel, group, open) {
  const disc = esc(describeDiscountCode(c));
  const indivName = c.scope_type === 'INDIVIDUAL'
    ? ((cachedUsers || []).find((u) => u.phone_number === c.scope_value) || {}).full_name : null;
  const scope = c.scope_type === 'GLOBAL' ? 'All delegates'
    : c.scope_type === 'DOMAIN' ? `Email domain: @${esc(c.scope_value)} <span class="text-[11px] text-slate-400">· verified emails, applied automatically</span>`
    : c.scope_type === 'CATEGORY' ? `Category: ${esc(catLabel(c.scope_value))}`
    : c.pending_email ? `${esc(c.pending_email)} <span class="inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-full border bg-amber-100 text-amber-800 border-amber-300">Waiting for signup</span>`
    : `Delegate: ${esc(indivName ? indivName + ' (' + c.scope_value + ')' : c.scope_value || '')}`
      + (c.issued_email ? ` <span class="text-[11px] text-slate-400">· issued to ${esc(c.issued_email)}, needs it verified</span>` : '');
  const usedTxt = `${c.applied_count}${c.max_uses ? ' / ' + c.max_uses : ''}${c.verified_count ? ` (${c.verified_count} verified)` : ''}`;
  return `<tr data-disc-group="${group}" class="${open ? '' : 'hidden '}${c.active ? '' : 'opacity-50'}">
    <td class="p-4"><span class="font-mono font-bold text-slate-800">${esc(c.code)}</span>${c.active ? '' : ' <span class="text-[10px] text-slate-400">· inactive</span>'}</td>
    <td class="p-4 font-semibold">${disc}</td>
    <td class="p-4 text-slate-600">${scope}</td>
    <td class="p-4">${usedTxt}</td>
    <td class="p-4 text-slate-600">${discountExpiryCell(c)}</td>
    <td class="p-4 text-right whitespace-nowrap">
      <button onclick="openShareDiscountModal(${esc(c.id)})" class="px-3 py-1.5 bg-navy hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg">${ICON('send')}Share</button>
    </td>
    <td class="p-4 text-right whitespace-nowrap">
      <button onclick="toggleDiscountCode(${esc(c.id)}, ${c.active ? 0 : 1})" class="px-3 py-1.5 ${c.active ? 'bg-amber-500 hover:bg-amber-600' : 'bg-emerald-600 hover:bg-emerald-700'} text-white text-xs font-semibold rounded-lg">${c.active ? 'Deactivate' : 'Activate'}</button>
    </td>
  </tr>`;
}

async function handleAddDiscountCode(e) {
  e.preventDefault();
  const scopeType = document.getElementById('new-disc-scope').value;
  if (scopeType === 'INDIVIDUAL' && !document.getElementById('new-disc-scope-phone').value) {
    return showToast('Choose the delegate, or type the full email address of someone who has not signed up yet.');
  }
  const body = {
    code: document.getElementById('new-disc-code').value,
    discountType: document.getElementById('new-disc-type').value,
    discountValue: document.getElementById('new-disc-value').value,
    feeTier: document.getElementById('new-disc-type').value === 'FEE_TIER' ? document.getElementById('new-disc-tier').value : undefined,
    scopeType,
    scopeValue: scopeType === 'CATEGORY' ? document.getElementById('new-disc-scope-cat').value
      : scopeType === 'INDIVIDUAL' ? document.getElementById('new-disc-scope-phone').value
      : scopeType === 'DOMAIN' ? document.getElementById('new-disc-scope-domain').value : '',
    maxUses: document.getElementById('new-disc-max').value,
    expiresAt: document.getElementById('new-disc-expires').value,
  };
  const data = await (await fetch('/api/admin/discount-codes', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })).json();
  if (!data.success) {
    // Rare generated-code collision: hand the admin a fresh code to retry with.
    if (/already exists/i.test(data.error || '')) generateDiscCode();
    return showToast(data.error || 'Could not add code.');
  }
  showToast(data.pendingEmail
    ? `Discount code ${body.code} added. No account uses ${data.pendingEmail} yet — it will work for them once they sign up with that address and verify it.`
    : data.needsVerification
      ? `Discount code ${body.code} added. ${data.issuedEmail} is not verified on their account yet — the code will work once they verify it.`
      : `Discount code ${body.code} added.`, 'success');
  generateDiscCode(); // fresh code ready for the next one
  document.getElementById('new-disc-value').value = '';
  document.getElementById('new-disc-max').value = '';
  document.getElementById('new-disc-expires').value = '';
  clearDiscDelegate();
  renderDiscountCodes();
}

// A code that has been used: a personal code once its holder's registration
// carries it, a shared one once it has reached its limit. applied_count is
// the "Used" column's own count (a rejected registration does not hold a
// code), so a rejection makes the code unused again. A shared code with no
// limit is never used up. The server applies the same rule.
// A personal code whose holder has registered without it is spent too -- a
// registration cannot take a code afterwards -- and the server deactivates it
// (retireHolderCodesOnRegistration). holder_registered comes from the list.
function discountCodeUsedUp(c) {
  const applied = Number(c.applied_count) || 0;
  return c.scope_type === 'INDIVIDUAL' ? (applied > 0 || !!Number(c.holder_registered))
    : (Number(c.max_uses) > 0 && applied >= Number(c.max_uses));
}

// The expiry column: the last date in words, and a tag -- Used once the code
// has been used (whatever its date says: there is nothing left to extend),
// otherwise Expired once its last day has passed (a code works through its
// last day, IST). Only an unused, expired code offers Extend, and only to
// whoever may manage codes.
function discountExpiryCell(c) {
  const used = discountCodeUsedUp(c);
  const expired = !!c.expires_at && c.expires_at < istDateString();
  const date = c.expires_at ? esc(formatFullDate(c.expires_at)) : '<span class="text-slate-400">No expiry</span>';
  const registeredWithout = used && c.scope_type === 'INDIVIDUAL' && !(Number(c.applied_count) > 0);
  const off = discountCodeDeactivated(c);
  const pill = registeredWithout
    ? ' <span class="inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-full border bg-slate-100 text-slate-600 border-slate-300">Holder registered</span>'
    : used
    ? ' <span class="inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-full border bg-indigo-100 text-indigo-700 border-indigo-300">Used</span>'
    : off
      ? ' <span class="inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-full border bg-slate-100 text-slate-600 border-slate-300">Deactivated</span>'
    : expired
      ? ' <span class="inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-full border bg-rose-100 text-rose-700 border-rose-300">Expired</span>' : '';
  // Extending a switched-off code would do nothing until it is activated.
  const extend = !used && !off && expired && can('discounts.manage')
    ? `<button type="button" onclick="openDiscountValidityModal(${esc(c.id)})" class="block mt-1 text-[11px] font-semibold text-indigo-600 hover:underline">Extend</button>` : '';
  return `${date}${pill}${extend}`;
}

let validityCodeId = null;
function openDiscountValidityModal(id) {
  const c = (cachedDiscountCodes || []).find((x) => String(x.id) === String(id));
  if (!c) return;
  validityCodeId = c.id;
  const today = istDateString();
  setText('validity-code', c.code);
  setText('validity-current', c.expires_at
    ? `${c.expires_at < today ? 'Expired after' : 'Currently valid through'} ${formatFullDateWithDay(c.expires_at)}.`
    : 'Currently has no expiry date.');
  const input = document.getElementById('validity-date');
  input.min = today;
  // Start from the current date if it is still ahead, else from today.
  input.value = c.expires_at && c.expires_at >= today ? c.expires_at : today;
  input.disabled = false;
  document.getElementById('validity-no-expiry').checked = false;
  const untilConf = document.getElementById('validity-until-conference');
  if (untilConf) untilConf.classList.toggle('hidden', !(conferenceInfo.startDate && conferenceInfo.startDate >= today));
  openModal('modal-discount-validity');
}

// "+1 week" / "+1 month" count from whichever is later: the code's current
// last date, or today -- extending an expired code from the date it expired
// would still leave it in the past.
function extendDiscountValidityBy(days) {
  const input = document.getElementById('validity-date');
  const today = istDateString();
  const from = input.value && input.value >= today ? input.value : today;
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  input.value = d.toISOString().slice(0, 10);
  document.getElementById('validity-no-expiry').checked = false;
  input.disabled = false;
}

function extendDiscountValidityToConference() {
  if (!conferenceInfo.startDate) return;
  const input = document.getElementById('validity-date');
  input.value = conferenceInfo.startDate;
  document.getElementById('validity-no-expiry').checked = false;
  input.disabled = false;
}

function onDiscountNoExpiryChange() {
  document.getElementById('validity-date').disabled = document.getElementById('validity-no-expiry').checked;
}

async function saveDiscountValidity(e) {
  e.preventDefault();
  if (validityCodeId == null) return;
  const noExpiry = document.getElementById('validity-no-expiry').checked;
  const date = document.getElementById('validity-date').value;
  if (!noExpiry && !date) return showToast('Pick the new last date, or tick "No expiry date".');
  const btn = document.getElementById('validity-save-btn');
  if (btn) btn.disabled = true;
  try {
    const data = await (await fetch(`/api/admin/discount-codes/${encodeURIComponent(validityCodeId)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresAt: noExpiry ? '' : date }),
    })).json();
    if (!data.success) { showToast(data.error || 'Could not change the validity.'); return; }
    const code = (cachedDiscountCodes.find((x) => String(x.id) === String(validityCodeId)) || {}).code || 'The code';
    showToast(noExpiry ? `${code} no longer expires.` : `${code} is now valid through ${formatFullDate(date)}.`, 'success');
    closeModal('modal-discount-validity');
    renderDiscountCodes();
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function toggleDiscountCode(id, active) {
  const data = await (await fetch(`/api/admin/discount-codes/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active }),
  })).json();
  if (!data.success) showToast(data.error || 'Update failed.');
  renderDiscountCodes();
}

// --- GROUP DISCOUNT RULES (admin) ---
async function renderGroupRules() {
  const tbody = document.getElementById('group-rule-table-body');
  if (!tbody) return;
  const cats = await ensureReviewCategories();
  const catSel = document.getElementById('new-grp-cat');
  if (catSel && !catSel.dataset.filled) {
    catSel.innerHTML = cats.map((c) => `<option value="${esc(c.key)}">${esc(c.label)}</option>`).join('');
    catSel.dataset.filled = '1';
  }
  const res = await fetch('/api/admin/group-rules');
  if (!res.ok) return;
  const rules = (await res.json()).rules || [];
  const catLabel = (key) => (cats.find((c) => c.key === key) || {}).label || key;
  tbody.innerHTML = rules.length ? rules.map((r) => `
    <tr class="${r.active ? '' : 'opacity-50'}">
      <td class="p-4 font-semibold text-slate-800">${esc(catLabel(r.category_key))}${r.active ? '' : ' <span class="text-[10px] text-slate-400">· inactive</span>'}</td>
      <td class="p-4">${esc(r.min_size)}+</td>
      <td class="p-4 font-semibold">${r.discount_type === 'PERCENT' ? esc(r.discount_value) + '%' : '₹' + inr(r.discount_value)}</td>
      <td class="p-4 text-right whitespace-nowrap">
        <button onclick="toggleGroupRule(${esc(r.id)}, ${r.active ? 0 : 1})" class="px-3 py-1.5 ${r.active ? 'bg-amber-500 hover:bg-amber-600' : 'bg-emerald-600 hover:bg-emerald-700'} text-white text-xs font-semibold rounded-lg">${r.active ? 'Deactivate' : 'Activate'}</button>
        <button onclick="deleteGroupRule(${esc(r.id)})" class="px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold rounded-lg">Delete</button>
      </td>
    </tr>`).join('') : `<tr><td colspan="4" class="p-6 text-center text-slate-400">No group discount rules yet.</td></tr>`;
}

async function handleAddGroupRule(e) {
  e.preventDefault();
  const body = {
    categoryKey: document.getElementById('new-grp-cat').value,
    minSize: document.getElementById('new-grp-min').value,
    discountType: document.getElementById('new-grp-type').value,
    discountValue: document.getElementById('new-grp-value').value,
  };
  const data = await (await fetch('/api/admin/group-rules', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })).json();
  if (!data.success) return showToast(data.error || 'Could not save rule.');
  showToast('Group discount rule saved.', 'success');
  document.getElementById('new-grp-value').value = '';
  renderGroupRules();
}

async function toggleGroupRule(id, active) {
  const data = await (await fetch(`/api/admin/group-rules/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active }),
  })).json();
  if (!data.success) showToast(data.error || 'Update failed.');
  renderGroupRules();
}

async function deleteGroupRule(id) {
  if (!(await showConfirm('Delete this group discount rule?'))) return;
  const data = await (await fetch(`/api/admin/group-rules/${encodeURIComponent(id)}`, { method: 'DELETE' })).json();
  if (!data.success) showToast(data.error || 'Delete failed.');
  renderGroupRules();
}

// --- GENERAL SETTINGS: SMS / Email / UPI (super admin) ---
let cachedGeneralSettings = null;

// Daily digest recipients, picked by name/phone search over cachedUsers
// (same picker pattern as searchDiscDelegate) rather than typed as raw
// phone numbers. State lives here as {phone, name} objects; only the phone
// is what's actually persisted (email.digestRecipients, comma-separated).
let gsDigestRecipients = [];

// Rebuilds gsDigestRecipients from the comma-separated phone list the server
// returns, resolving each to a name via cachedUsers where possible (a number
// with no matching user -- e.g. set by hand outside this UI -- still shows
// as a chip, just without a name).
function loadDigestRecipients(csv) {
  const phones = String(csv || '').split(',').map((p) => p.trim()).filter(Boolean);
  gsDigestRecipients = phones.map((phone) => {
    const u = (cachedUsers || []).find((x) => x.phone_number === phone);
    return { phone, name: u ? u.full_name : '' };
  });
  renderDigestChips();
}

function renderDigestChips() {
  const box = document.getElementById('gs-digest-chips');
  if (!box) return;
  box.innerHTML = gsDigestRecipients.map((r) => `
    <span class="inline-flex items-center gap-1.5 bg-indigo-50 text-indigo-700 text-xs font-medium pl-2.5 pr-1.5 py-1 rounded-full">
      ${esc(r.name || 'Unknown')} <span class="text-indigo-400">${esc(delegateDisplayPhone({ phone_number: r.phone }) || r.phone)}</span>
      <button type="button" onclick="removeDigestRecipient('${esc(r.phone)}')" class="text-indigo-400 hover:text-indigo-900 font-bold leading-none px-0.5">×</button>
    </span>`).join('') || '<p class="text-xs text-slate-400">No recipients selected.</p>';
}

function searchDigestRecipient(query) {
  const box = document.getElementById('gs-digest-search-results');
  if (!box) return;
  const q = String(query || '').trim().toLowerCase();
  if (!q) { box.classList.add('hidden'); return; }
  const already = new Set(gsDigestRecipients.map((r) => r.phone));
  const matches = (cachedUsers || [])
    .filter((u) => !already.has(u.phone_number) && `${u.full_name || ''} ${u.phone_number || ''}`.toLowerCase().includes(q))
    .slice(0, 8);
  box.innerHTML = matches.length
    ? matches.map((u) => `<button type="button" class="w-full text-left px-3 py-2 hover:bg-indigo-50" onclick="addDigestRecipient('${esc(u.phone_number)}', '${esc((u.full_name || '').replace(/'/g, "\\'"))}')">
        <p class="font-semibold text-slate-800 text-sm">${esc(u.full_name || '—')}</p>
        <p class="text-[11px] text-slate-500">${esc(delegateDisplayPhone(u) || u.email || '—')}</p>
      </button>`).join('')
    : '<p class="text-xs text-slate-400 p-3">No matching user.</p>';
  box.classList.remove('hidden');
}

function addDigestRecipient(phone, name) {
  if (!gsDigestRecipients.some((r) => r.phone === phone)) gsDigestRecipients.push({ phone, name });
  renderDigestChips();
  const search = document.getElementById('gs-digest-search');
  const results = document.getElementById('gs-digest-search-results');
  if (search) search.value = '';
  if (results) results.classList.add('hidden');
}

function removeDigestRecipient(phone) {
  gsDigestRecipients = gsDigestRecipients.filter((r) => r.phone !== phone);
  renderDigestChips();
}

// --- BACKUPS (Settings) ---
// The button queues a backup rather than running one: the Drive credential is
// deliberately absent from the app container, so scripts/backup.sh (cron,
// every few minutes) is what actually does the work. See the endpoints in
// server.js for why.
async function renderBackupStatus() {
  const box = document.getElementById('backup-status');
  const btn = document.getElementById('backup-now-btn');
  if (!box) return;
  let data;
  try {
    data = await (await fetch('/api/admin/backup/status')).json();
  } catch {
    box.textContent = 'Could not read the backup status.';
    return;
  }
  if (!data.success) { box.textContent = data.error || 'Could not read the backup status.'; return; }

  const lines = [];
  if (data.last && data.last.finishedAt) {
    const when = fmtAuditTime(data.last.finishedAt);
    const size = data.last.databaseBytes
      ? ` · database ${(Number(data.last.databaseBytes) / 1048576).toFixed(1)} MB` : '';
    const drive = data.last.uploadedToDrive
      ? '<span class="text-emerald-700 font-semibold">copied to Google Drive</span>'
      : '<span class="text-amber-700 font-semibold">not copied to Google Drive</span>';
    lines.push(`<b>Last backup:</b> ${esc(when)} (${esc(data.last.kind || 'scheduled')})${esc(size)} — ${drive}`);
  } else {
    // Absent until the first run after this feature shipped -- say so plainly
    // rather than implying no backup has ever been taken.
    lines.push('<b>Last backup:</b> not recorded yet — the next run will report here.');
  }
  if (data.pending) {
    const asked = data.request && data.request.requestedAt ? fmtAuditTime(data.request.requestedAt) : '';
    lines.push(`<span class="text-indigo-700 font-semibold">${ICON('clock')}A backup is queued${asked ? ` (requested ${esc(asked)})` : ''} and will start within a few minutes.</span>`);
  }
  box.innerHTML = lines.join('<br>');
  if (btn) btn.disabled = !!data.pending;
  renderDriveStatus(data);
}

// Google Drive linkage. The panel captures the token and hands it to the
// backup script; nothing here ever reads it back, and the status shown comes
// from what that script reports after it tries to use it.
function renderDriveStatus(data) {
  const box = document.getElementById('drive-status');
  const checkBtn = document.getElementById('drive-check-btn');
  const cmd = document.getElementById('drive-authorize-cmd');
  if (!box) return;
  const d = data.drive;

  if (data.drivePending) {
    box.innerHTML = '<span class="text-indigo-700 font-semibold">' + ICON('clock') + 'Applying the Google Drive change — this takes up to five minutes.</span>';
  } else if (!d) {
    // No report yet: the script writes one on every run and after any link
    // attempt, so this is a fresh deployment, not a broken link.
    box.innerHTML = '<span class="text-slate-500">Not checked yet — run a backup or press <b>Test connection</b>.</span>';
  } else if (d.linked) {
    // The account matters: it is whose Drive these backups are sitting in, and
    // the one thing you cannot infer from the folder name if the wrong person
    // linked it.
    box.innerHTML = `<span class="text-emerald-700 font-semibold">${ICON('check')}Linked</span>`
      + (d.account ? ` as <b>${esc(d.account)}</b>` : '')
      + ` · <code class="bg-slate-100 px-1 rounded">${esc(d.remote || '')}</code>`
      + ` · holds <b>${esc(String(d.backupCount || 0))}</b> backup${Number(d.backupCount) === 1 ? '' : 's'}`
      + ` (oldest removed beyond ${esc(String(d.keep || 14))})`
      + (d.checkedAt ? ` · checked ${esc(fmtAuditTime(d.checkedAt))}` : '');
  } else {
    box.innerHTML = `<span class="text-rose-700 font-semibold">${ICON('cross')}Not linked</span>`
      + (d.lastError ? ` — ${esc(d.lastError)}` : '')
      + (d.checkedAt ? ` <span class="text-slate-400">(checked ${esc(fmtAuditTime(d.checkedAt))})</span>` : '');
  }
  if (checkBtn) checkBtn.disabled = !!data.drivePending;

  // The Connect button only works once an OAuth client exists, so it appears
  // only then; until that point the setup panel is the way in.
  const oauth = data.driveOauth || {};
  const connectBtn = document.getElementById('drive-connect-btn');
  const setupBtn = document.getElementById('drive-setup-toggle');
  const redirectEl = document.getElementById('drive-redirect-uri');
  if (redirectEl) redirectEl.textContent = oauth.redirectUri || '';
  if (connectBtn) {
    connectBtn.classList.toggle('hidden', !oauth.configured);
    connectBtn.textContent = d && d.linked ? 'Reconnect Google Drive' : 'Connect Google Drive';
  }
  if (setupBtn) setupBtn.textContent = oauth.configured ? 'Change sign-in setup' : 'Set up sign-in';
  const idField = document.getElementById('drive-oauth-id');
  if (idField && oauth.clientId && !idField.value) idField.value = oauth.clientId;
  // Only show the client-id flags when this deployment actually uses its own
  // OAuth client; with rclone's built-in one the bare command is correct.
  if (cmd) cmd.textContent = d && d.clientId
    ? `rclone authorize "drive" --client-id ${d.clientId} --client-secret YOUR_CLIENT_SECRET`
    : 'rclone authorize "drive"';
}

function toggleDriveLinkForm() {
  const form = document.getElementById('drive-link-form');
  if (form) form.classList.toggle('hidden');
}

function toggleDriveSetupForm() {
  const form = document.getElementById('drive-setup-form');
  if (form) form.classList.toggle('hidden');
}

function copyDriveRedirectUri() {
  const el = document.getElementById('drive-redirect-uri');
  if (!el) return;
  navigator.clipboard.writeText(el.textContent.trim())
    .then(() => showToast('Redirect URI copied.', 'success'))
    .catch(() => showToast('Could not copy — select it and copy by hand.'));
}

async function saveDriveOauthClient() {
  const clientId = (document.getElementById('drive-oauth-id').value || '').trim();
  const clientSecret = (document.getElementById('drive-oauth-secret').value || '').trim();
  if (!clientId || !clientSecret) return showToast('Both the client ID and the secret are needed.');
  const btn = document.getElementById('drive-oauth-save-btn');
  if (btn) btn.disabled = true;
  const data = await (await fetch('/api/admin/backup/drive-oauth/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret }),
  })).json();
  if (btn) btn.disabled = false;
  if (!data.success) return showToast(data.error || 'Could not save the OAuth client.');
  // Don't leave the secret sitting in the form once it is stored.
  document.getElementById('drive-oauth-secret').value = '';
  toggleDriveSetupForm();
  showToast('Saved — you can now connect with the button.', 'success');
  await renderBackupStatus();
}

async function checkDriveLink() {
  const data = await (await fetch('/api/admin/backup/drive-check', { method: 'POST' })).json();
  if (!data.success) return showToast(data.error || 'Could not queue the check.');
  showToast('Testing the Google Drive connection…', 'success');
  await renderBackupStatus();
}

async function submitDriveLink() {
  const token = (document.getElementById('drive-token').value || '').trim();
  if (!token) return showToast('Paste the token that rclone printed.');
  if (!(await showConfirm('Replace the Google Drive link with this token? Existing backups on Drive are not affected.'))) return;
  const btn = document.getElementById('drive-link-btn');
  if (btn) btn.disabled = true;
  const data = await (await fetch('/api/admin/backup/drive-link', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token,
      folder: (document.getElementById('drive-folder').value || '').trim(),
      clientId: (document.getElementById('drive-client-id').value || '').trim(),
      clientSecret: (document.getElementById('drive-client-secret').value || '').trim(),
    }),
  })).json();
  if (btn) btn.disabled = false;
  if (!data.success) return showToast(data.error || 'Could not submit the link.');
  // Clear it immediately -- there is no reason for a live credential to sit
  // in a form field once it has been handed over.
  document.getElementById('drive-token').value = '';
  document.getElementById('drive-client-secret').value = '';
  toggleDriveLinkForm();
  showToast('Google Drive link submitted — it will be applied and tested shortly.', 'success');
  await renderBackupStatus();
}

async function requestBackupNow() {
  if (!(await showConfirm('Queue a backup now? It will start within a few minutes and be copied to Google Drive.'))) return;
  const btn = document.getElementById('backup-now-btn');
  if (btn) btn.disabled = true;
  const data = await (await fetch('/api/admin/backup/request', { method: 'POST' })).json();
  if (!data.success) {
    showToast(data.error || 'Could not queue a backup.');
  } else {
    showToast('Backup queued — it will start within a few minutes.', 'success');
  }
  await renderBackupStatus();
}

// Conference setup's side menu (a desktop): the card on screen is marked.
let settingsJumpWatched = false;
function watchSettingsJump() {
  if (settingsJumpWatched || typeof IntersectionObserver !== 'function') return;
  const buttons = [...document.querySelectorAll('#gs-jump .gs-jump-btn')];
  if (!buttons.length) return;
  settingsJumpWatched = true;
  const mark = (id) => buttons.forEach((b) => {
    const on = b.dataset.target === id;
    b.classList.toggle('lg:bg-gold-50', on);
    b.classList.toggle('lg:text-navy', on);
    b.classList.toggle('lg:font-bold', on);
    if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
  });
  const seen = new Map();
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => seen.set(e.target.id, e.isIntersecting ? e.intersectionRatio : 0));
    const first = buttons.map((b) => b.dataset.target).find((id) => (seen.get(id) || 0) > 0);
    if (first) mark(first);
  }, { rootMargin: '-15% 0px -55% 0px', threshold: [0, 0.01] });
  buttons.forEach((b) => { const card = document.getElementById(b.dataset.target); if (card) io.observe(card); });
}

async function renderGeneralSettings() {
  // Independent of the settings fetch below, so a backup-status hiccup can't
  // stop the rest of the tab rendering.
  renderBackupStatus();
  loadHallsCard();
  watchSettingsJump();
  const res = await fetch('/api/admin/general-settings');
  if (!res.ok) return;
  const data = await res.json();
  cachedGeneralSettings = data;

  const smsToggle = document.getElementById('notify-sms-toggle');
  const emailToggle = document.getElementById('notify-email-toggle');
  const digestToggle = document.getElementById('notify-digest-toggle');
  if (smsToggle) { smsToggle.checked = !!data.sms.enabled; smsToggle.disabled = !data.sms.available; }
  if (emailToggle) { emailToggle.checked = !!data.email.enabled; emailToggle.disabled = !data.email.available; }
  if (digestToggle) digestToggle.checked = !!data.email.digestEnabled;
  setText('notify-sms-state', data.sms.available ? (data.sms.enabled ? '· on' : '· off') : '· not configured');
  setText('notify-email-state', data.email.available ? (data.email.enabled ? '· on' : '· off') : '· not configured');
  setText('notify-digest-state', data.email.digestEnabled ? '· on' : '· off');
  const maintToggle = document.getElementById('maintenance-toggle');
  if (maintToggle) maintToggle.checked = !!(data.maintenance && data.maintenance.enabled);
  setText('maintenance-state', data.maintenance && data.maintenance.enabled ? '· ON' : '· off');
  const maintNote = document.getElementById('maintenance-active-note');
  if (maintNote) maintNote.classList.toggle('hidden', !(data.maintenance && data.maintenance.enabled));

  const smsKeyNote = document.getElementById('sms-key-note');
  if (smsKeyNote) smsKeyNote.classList.toggle('hidden', data.sms.hasApiKey);
  const emailKeyNote = document.getElementById('email-key-note');
  if (emailKeyNote) emailKeyNote.classList.toggle('hidden', data.email.hasCredentials);

  const setVal = (id, v) => { const el = document.getElementById(id); if (el && document.activeElement !== el) el.value = v || ''; };
  setVal('gs-sms-sender', data.sms.sender);
  setVal('gs-sms-url', data.sms.url);
  setVal('gs-sms-entityid', data.sms.entityId);
  setVal('gs-sms-templateid', data.sms.templateId);
  setVal('gs-sms-headerid', data.sms.headerId);
  setVal('gs-sms-type', data.sms.type);
  setVal('gs-email-from', data.email.from);
  setVal('gs-email-fromname', data.email.fromName);
  setVal('gs-email-region', data.email.region);
  loadDigestRecipients(data.email.digestRecipients);
  setVal('gs-digest-sendtime', data.email.digestSendTime);
  setVal('gs-upi-id', data.upi.id);
  setVal('gs-upi-payeename', data.upi.payeeName);
  if (data.bank) {
    setVal('gs-bank-accountname', data.bank.accountName);
    setVal('gs-bank-accountnumber', data.bank.accountNumber);
    setVal('gs-bank-ifsc', data.bank.ifsc);
    setVal('gs-bank-branch', data.bank.branch);
  }
  setVal('gs-conf-name', data.conference.name);
  setVal('gs-conf-acronym', data.conference.acronym);
  setVal('gs-conf-location', data.conference.location);
  setVal('gs-conf-startdate', data.conference.startDate);
  setVal('gs-conf-enddate', data.conference.endDate);
  setVal('gs-conf-regprefix', data.conference.regPrefix);
  setVal('gs-conf-abstractdeadline', data.conference.abstractDeadline);
  renderAbstractDeadlineState(data.conference);
  setVal('gs-conf-authorsdeadline', data.conference.authorsDeadline);
  renderAuthorsDeadlineState(data.conference);
  // A conference being set up is always in the future, and it can't end
  // before it starts -- nudged here, enforced server-side regardless (see
  // PUT /api/admin/general-settings).
  const todayStr = istDateString();
  const startInput = document.getElementById('gs-conf-startdate');
  const endInput = document.getElementById('gs-conf-enddate');
  if (startInput) {
    startInput.min = todayStr;
    startInput.onchange = () => { if (endInput) endInput.min = startInput.value || todayStr; };
  }
  if (endInput) endInput.min = (startInput && startInput.value) || todayStr;
  setVal('gs-maintenance-message', data.maintenance && data.maintenance.message);

  // Credential fields are never prefilled. Bearer secrets (SMS API key, AWS
  // Secret Access Key) show only a set/not-set state -- no bytes ever reach the
  // DOM. The AWS Access Key ID isn't a bearer secret, so a last-4 preview is
  // shown to help confirm which key is active.
  setText('gs-sms-apikey-hint', data.sms.hasApiKey ? '(configured)' : '(not set)');
  setText('gs-email-accesskey-hint', data.email.accessKeyMasked ? `(current: ${data.email.accessKeyMasked})` : '(not set)');
  setText('gs-email-secretkey-hint', data.email.hasSecretKey ? '(configured)' : '(not set)');

  // "Other Environment Variables" -- five editable fields plus the read-only
  // NODE_ENV line. otherEnvVars is a flat array (see describeOtherEnvVars()
  // server-side); pull each one out by key rather than assuming array order.
  const envByKey = {};
  (data.otherEnvVars || []).forEach((v) => { envByKey[v.key] = v; });
  setVal('gs-env-portalurl', envByKey.PORTAL_URL && envByKey.PORTAL_URL.value);
  setVal('gs-env-port', envByKey.PORT && envByKey.PORT.value);
  setVal('gs-env-cookiename', envByKey.COOKIE_NAME && envByKey.COOKIE_NAME.value);
  const cookieSecureEl = document.getElementById('gs-env-cookiesecure');
  if (cookieSecureEl && document.activeElement !== cookieSecureEl) cookieSecureEl.checked = !!(envByKey.COOKIE_SECURE && envByKey.COOKIE_SECURE.value === 'true');
  const otpEchoEl = document.getElementById('gs-env-otpecho');
  if (otpEchoEl && document.activeElement !== otpEchoEl) otpEchoEl.checked = !!(envByKey.OTP_ECHO && envByKey.OTP_ECHO.value === 'true');
  setText('gs-env-nodeenv', (envByKey.NODE_ENV && envByKey.NODE_ENV.value) || '(unset)');
}

// The line under the deadline field says what delegates see right now, from
// the server's own verdict (abstractSubmissionOpen), not a browser-clock
// guess -- the two can differ by the IST offset around midnight.
function renderAbstractDeadlineState(conf) {
  const el = document.getElementById('gs-conf-abstract-state');
  if (!el) return;
  const day = formatFullDateWithDay(conf.abstractDeadline);
  if (!conf.abstractDeadline) {
    el.className = 'text-[11px] font-semibold mt-1 text-slate-500';
    el.textContent = 'Open — no deadline set.';
  } else if (conf.abstractSubmissionOpen) {
    el.className = 'text-[11px] font-semibold mt-1 text-emerald-700';
    el.textContent = `Open — closes at the end of ${day} (IST).`;
  } else {
    el.className = 'text-[11px] font-semibold mt-1 text-rose-700';
    el.textContent = `Closed — the last date was ${day}. New abstracts are refused.`;
  }
}

// The same, for the last date to change an abstract's authors.
function renderAuthorsDeadlineState(conf) {
  const el = document.getElementById('gs-conf-authors-state');
  if (!el) return;
  const day = formatFullDateWithDay(conf.authorsDeadline);
  if (!conf.authorsDeadline) {
    el.className = 'text-[11px] font-semibold mt-1 text-slate-500';
    el.textContent = 'Open — no last date set.';
  } else if (conf.abstractAuthorsOpen) {
    el.className = 'text-[11px] font-semibold mt-1 text-emerald-700';
    el.textContent = `Open — delegates can change their authors until the end of ${day} (IST).`;
  } else {
    el.className = 'text-[11px] font-semibold mt-1 text-rose-700';
    el.textContent = `Closed — the last date was ${day}. Only admins can change authors now.`;
  }
}

// Turning this on locks every delegate and non-super admin out of the portal,
// so it confirms first rather than acting on a single stray click. Turning it
// back off is the safe direction and goes straight through.
async function setMaintenanceMode(enabled) {
  const toggle = document.getElementById('maintenance-toggle');
  if (enabled && !(await showConfirm('Turn ON maintenance mode? Delegates will not be able to register, pay, or submit abstracts, and finance/reviewer admins will lose access to the panel. Only super admins can use the portal until you turn this off.'))) {
    if (toggle) toggle.checked = false; // the click already flipped it -- put it back
    return;
  }
  const data = await (await fetch('/api/admin/general-settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maintenance: { enabled } }),
  })).json();
  if (!data.success) { showToast(data.error || 'Could not update.'); renderGeneralSettings(); return; }
  showToast(enabled ? 'Maintenance mode is ON — the portal is closed to everyone except super admins.' : 'Maintenance mode is OFF — the portal is open again.', enabled ? 'info' : 'success');
  renderGeneralSettings();
}

async function setGeneralToggle(channel, enabled) {
  const data = await (await fetch('/api/admin/general-settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notify: { [channel]: enabled } }),
  })).json();
  if (!data.success) { showToast(data.error || 'Could not update.'); renderGeneralSettings(); return; }
  const CHANNEL_LABELS = { sms: 'SMS', email: 'Email', digest: 'Daily digest' };
  showToast(`${CHANNEL_LABELS[channel] || channel} turned ${enabled ? 'on' : 'off'}.`, 'info');
  renderGeneralSettings();
}

async function saveGeneralSettings(e, group) {
  e.preventDefault();
  let body;
  let credentialInputs = [];
  if (group === 'sms') {
    const apiKey = document.getElementById('gs-sms-apikey').value;
    body = { sms: {
      sender: document.getElementById('gs-sms-sender').value,
      url: document.getElementById('gs-sms-url').value,
      entityId: document.getElementById('gs-sms-entityid').value,
      templateId: document.getElementById('gs-sms-templateid').value,
      headerId: document.getElementById('gs-sms-headerid').value,
      type: document.getElementById('gs-sms-type').value,
    } };
    if (apiKey.trim()) body.sms.apiKey = apiKey.trim();
    credentialInputs = ['gs-sms-apikey'];
  } else if (group === 'email') {
    const accessKey = document.getElementById('gs-email-accesskey').value;
    const secretKey = document.getElementById('gs-email-secretkey').value;
    body = { email: {
      from: document.getElementById('gs-email-from').value,
      fromName: document.getElementById('gs-email-fromname').value,
      region: document.getElementById('gs-email-region').value,
    } };
    if (accessKey.trim()) body.email.awsAccessKeyId = accessKey.trim();
    if (secretKey.trim()) body.email.awsSecretAccessKey = secretKey.trim();
    credentialInputs = ['gs-email-accesskey', 'gs-email-secretkey'];
  } else if (group === 'upi') {
    body = { upi: {
      id: document.getElementById('gs-upi-id').value,
      payeeName: document.getElementById('gs-upi-payeename').value,
    } };
  } else if (group === 'bank') {
    body = { bank: {
      accountName: document.getElementById('gs-bank-accountname').value,
      accountNumber: document.getElementById('gs-bank-accountnumber').value,
      ifsc: document.getElementById('gs-bank-ifsc').value,
      branch: document.getElementById('gs-bank-branch').value,
    } };
  } else if (group === 'conference') {
    body = { conference: {
      name: document.getElementById('gs-conf-name').value,
      acronym: document.getElementById('gs-conf-acronym').value,
      location: document.getElementById('gs-conf-location').value,
      startDate: document.getElementById('gs-conf-startdate').value,
      endDate: document.getElementById('gs-conf-enddate').value,
      regPrefix: document.getElementById('gs-conf-regprefix').value,
      abstractDeadline: document.getElementById('gs-conf-abstractdeadline').value,
      authorsDeadline: document.getElementById('gs-conf-authorsdeadline').value,
    } };
  } else if (group === 'maintenance') {
    body = { maintenance: { message: document.getElementById('gs-maintenance-message').value } };
  } else if (group === 'notifications') {
    // Digest recipients are still persisted as email.digestRecipients server-side
    // (same schema_meta key as before) -- only the admin UI moved to its own card.
    body = { email: {
      digestRecipients: gsDigestRecipients.map((r) => r.phone).join(','),
      digestSendTime: document.getElementById('gs-digest-sendtime').value,
    } };
  } else if (group === 'otherEnv') {
    body = { otherEnv: {
      portalUrl: document.getElementById('gs-env-portalurl').value,
      port: document.getElementById('gs-env-port').value,
      cookieName: document.getElementById('gs-env-cookiename').value,
      cookieSecure: document.getElementById('gs-env-cookiesecure').checked,
      otpEcho: document.getElementById('gs-env-otpecho').checked,
    } };
  } else {
    return;
  }
  const data = await (await fetch('/api/admin/general-settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })).json();
  if (!data.success) return showToast(data.error || 'Could not save.');
  const groupLabels = { sms: 'SMS', email: 'Email', upi: 'UPI', bank: 'Bank Transfer', conference: 'Conference Details', notifications: 'Notification', maintenance: 'Maintenance', otherEnv: 'Environment' };
  if (data.restartRequired) {
    showToast(`${groupLabels[group] || group} settings saved. Restart the server (pm2 restart) for the port/cookie changes to take effect.`, 'info');
  } else {
    showToast(`${groupLabels[group] || group} settings saved.`, 'success');
  }
  // Clear any credential inputs immediately after a successful save -- they
  // should never sit filled-in on screen once submitted.
  credentialInputs.forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
  renderGeneralSettings();
}

// --- GROUP MONITORING (admin) ---
async function renderGroupsMonitor() {
  const box = document.getElementById('groups-monitor-container');
  if (!box) return;
  box.innerHTML = '<p class="text-sm text-slate-500">Loading…</p>';
  const res = await fetch('/api/admin/groups');
  if (!res.ok) { box.innerHTML = '<p class="text-sm text-rose-600">Could not load groups.</p>'; return; }
  const groups = (await res.json()).groups || [];
  if (!groups.length) { box.innerHTML = '<p class="text-sm text-slate-400 p-4">No group registrations yet.</p>'; return; }

  const TONE = { BANK_VERIFIED: 'text-emerald-700', PARTIAL_PAYMENT: 'text-orange-700', REJECTED: 'text-rose-600', PENDING: 'text-amber-700', NOT_REGISTERED: 'text-slate-400' };
  const LABEL = { BANK_VERIFIED: 'Verified', PARTIAL_PAYMENT: 'Balance due', REJECTED: 'Rejected', PENDING: 'Pending', NOT_REGISTERED: 'Not paid' };
  box.innerHTML = groups.map((g) => {
    const statusBadge = g.allVerified
      ? '<span class="text-xs font-bold text-emerald-800 bg-emerald-100 border border-emerald-300 rounded-full px-2.5 py-1">' + ICON('check') + 'Fully approved</span>'
      : g.qualifies
        ? '<span class="text-xs font-bold text-indigo-800 bg-indigo-100 border border-indigo-300 rounded-full px-2.5 py-1">Discount active</span>'
        : `<span class="text-xs font-bold text-amber-800 bg-amber-100 border border-amber-300 rounded-full px-2.5 py-1">Below min (${g.size}/${g.minSize || '—'})</span>`;
    const rows = g.members.map((m) => `
      <div class="flex items-center justify-between py-1.5 text-sm border-b border-slate-50 last:border-0">
        <span class="min-w-0 truncate">${esc(m.name)}${m.phone === g.leaderPhone ? ' <span class="text-[10px] text-indigo-500 font-semibold">(leader)</span>' : ''} <span class="text-[11px] text-slate-400 font-mono">${esc(m.phone)}</span></span>
        <span class="text-xs font-semibold shrink-0 ${TONE[m.status] || 'text-slate-500'}">${esc(LABEL[m.status] || m.status)}</span>
      </div>`).join('');
    const disc = g.discountType ? (g.discountType === 'PERCENT' ? g.discountValue + '%' : '₹' + inr(g.discountValue)) : '—';
    return `<div class="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm">
      <div class="flex items-center justify-between flex-wrap gap-2 mb-2">
        <div>
          <h3 class="font-bold text-slate-800">${esc(g.name || g.categoryLabel + ' group')}</h3>
          <p class="text-xs text-slate-500">${esc(g.categoryLabel)} · ${g.size} members · ${esc(disc)} off</p>
        </div>
        ${statusBadge}
      </div>
      <div class="border-t border-slate-100 pt-1">${rows}</div>
    </div>`;
  }).join('');
}

// --- REPORTS (admin) ---

// Populates the workshops report's picker so only one option's roster is
// viewed/downloaded at a time, instead of dumping every workshop and QI
// practice into one report.
async function loadReportWorkshopOptions() {
  const select = document.getElementById('report-workshop-select');
  if (!select) return;
  const res = await fetch('/api/admin/reports/workshops/options');
  if (!res.ok) { select.innerHTML = '<option value="">Could not load options</option>'; return; }
  const data = await res.json();
  const options = data.options || [];
  select.innerHTML = options.length
    ? `<option value="">Select a program option…</option>` +
      options.map((o) => `<option value="${esc(o.id)}">${esc(o.groupName)}: ${esc(o.name)}</option>`).join('')
    : '<option value="">No program options set up yet</option>';
  select.onchange = () => {
    const enabled = !!select.value;
    ['report-workshop-view-btn', 'report-workshop-csv-btn', 'report-workshop-pdf-btn'].forEach((id) => {
      const btn = document.getElementById(id);
      if (btn) btn.disabled = !enabled;
    });
  };
}

function reportWorkshopQuery() {
  const select = document.getElementById('report-workshop-select');
  return select && select.value ? `&optionId=${encodeURIComponent(select.value)}` : '';
}

// --- REMINDERS (admin) ---
// The email templates first; the composer that uses them follows the
// registry (CUSTOM_REMINDER_TEMPLATES). Each builder reads the conference
// details, and any date it quotes, live from the server, so an email cannot
// announce something the admin-editable settings no longer agree with.

const steelButton = (href, label) => `<p style="text-align:center;margin:1.5rem 0">
  <a href="${href}" style="background:#2f5673;color:#fff;padding:.75rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">${label}</a>
</p>`;
const reminderSignOff = () => `<p>Warm regards,<br><b>Organising Committee</b><br>${esc([conferenceInfo.acronym, conferenceInfo.location].filter(Boolean).join(', '))}</p>`;

// Signed up, never registered.
async function buildRegistrationReminderBody() {
  const c = conferenceInfo;
  const start = formatFullDate(c.startDate);
  const end = formatFullDate(c.endDate);
  const dateRange = (start && end && c.startDate !== c.endDate) ? `${start} &ndash; ${end}` : (start || end);
  const when = [dateRange, esc(c.location || '')].filter(Boolean).join(', ');
  return `<p>Dear {{name}},</p>
<p>Thank you for signing up for the ${esc(c.name || 'conference')}${when ? ` (${when})` : ''}. Your registration is not complete yet &mdash; your account is set up, but we have not received your registration and payment.</p>
<p>Completing it takes only a couple of minutes.</p>
${steelButton(window.location.origin, 'Complete My Registration')}
<p>If you have already registered, please ignore this email.</p>
${reminderSignOff()}`;
}

// Registered, with a balance to pay. {{amount}} is each person's own.
async function buildBalanceDueBody() {
  const c = conferenceInfo;
  return `<p>Dear {{name}},</p>
<p>Thank you for registering for the ${esc(c.name || 'conference')}. Your registration has a balance of <b>{{amount}}</b> still due.</p>
<p>Please log in and complete your payment at your earliest convenience to confirm your place.</p>
${steelButton(window.location.origin, 'Pay My Balance')}
<p>If you have already paid, please ignore this email.</p>
${reminderSignOff()}`;
}

// Holding a personal code not yet used. {{codes}}: their own code(s), what
// each gives and its last date, filled in by the server.
async function buildCodeHolderBody() {
  const c = conferenceInfo;
  return `<p>Dear {{name}},</p>
<p>A personal code was issued to you for <b>${esc(c.name || 'the conference')}</b>, and it has not been used yet.</p>
{{codes}}
<p>Register on the portal and, when you choose your category, your code is applied for you automatically. You can also enter it under <b>Apply promo code</b>. It is yours alone, and works through the end of its last date.</p>
${steelButton(window.location.origin, 'Register Now')}
${reminderSignOff()}`;
}

// Certificates issued: where to download them. Each one carries a QR code
// that verifies it, so it can be shared as it is.
async function buildCertificateReadyBody() {
  const c = conferenceInfo;
  return `<p>Dear {{name}},</p>
<p>Thank you for attending the <b>${esc(c.name || 'conference')}</b>. Your e-certificate is ready.</p>
<p><b>To download it</b></p>
<ol style="padding-left:1.1rem;margin:.5rem 0">
  <li>Log in to the registration portal.</li>
  <li>On your dashboard, find <b>Attendance &amp; Certificate</b>.</li>
  <li>Click <b>Download</b> for each certificate.</li>
</ol>
<p>Each certificate carries a QR code and a certificate number, which anyone can use to check it is genuine.</p>
${steelButton(window.location.origin, 'Download My Certificate')}
${reminderSignOff()}`;
}

// MGIMS accounts whose @mgims.ac.in address is not verified: the
// email-domain code (MGIMS2026) waits on verification, and verifying now
// re-prices a registration already made (repriceWithBestCode).
async function buildMgimsVerifyBody() {
  const c = conferenceInfo;
  return `<p>Dear {{name}},</p>
<p>You have an account for <b>${esc(c.name || 'the conference')}</b> with your <b>@mgims.ac.in</b> email address, but the address has not been verified yet.</p>
<div style="background:#eef3f6;border:1px solid #b9cedb;border-radius:10px;padding:1rem 1.25rem;margin:1.25rem 0">
  <div style="font-size:.7rem;letter-spacing:.09em;text-transform:uppercase;color:#2f5673;font-weight:700">The Early Bird price, for MGIMS</div>
  <div style="font-size:.9rem;color:#1c3549;margin-top:.4rem">Registering with a <b>verified</b> @mgims.ac.in address gets you the <b>Early Bird fee</b>, whatever the date. There is no code to enter: it is applied by itself once your address is verified. If you have already registered, verifying now lowers your fee automatically.</div>
</div>
<p><b>To verify it</b></p>
<ol style="padding-left:1.1rem;margin:.5rem 0">
  <li>Log in to the registration portal.</li>
  <li>On your dashboard, click <b>Verify now</b>.</li>
  <li>Enter the code we email you to your @mgims.ac.in address.</li>
</ol>
${steelButton(window.location.origin, 'Log In and Verify')}
${reminderSignOff()}`;
}

// An account whose email address is not verified. Confirmations go to it,
// and a code issued to the address -- or to its domain -- waits on it.
async function buildVerifyEmailBody() {
  const c = conferenceInfo;
  return `<p>Dear {{name}},</p>
<p>You have an account for <b>${esc(c.name || 'the conference')}</b>, but your email address has not been verified yet.</p>
<p>It takes a minute, and it matters: your registration confirmation and receipt are sent to this address, and a discount issued to your email address &mdash; or to your institution's email domain &mdash; is applied only once it is verified.</p>
<p><b>To verify it</b></p>
<ol style="padding-left:1.1rem;margin:.5rem 0">
  <li>Log in to the registration portal.</li>
  <li>On your dashboard, click <b>Verify Now</b>.</li>
  <li>Enter the code we email you.</li>
</ol>
${steelButton(window.location.origin, 'Log In and Verify')}
${reminderSignOff()}`;
}

// "Early bird ends" -- fetching the actual cutoff date from /api/fees so the
// copy doesn't drift from the real fee_config.
// Pulls conference details, current fee-category pricing, and the
// program-group lineup live from the server (rather than hardcoding any of
// it into the template) so the email can't say something the admin-editable
// settings no longer agree with.
async function buildEarlyBirdReminderBody() {
  const c = conferenceInfo;
  const start = formatFullDate(c.startDate);
  const end = formatFullDate(c.endDate);
  const dateRange = (start && end && c.startDate !== c.endDate) ? `${start} &ndash; ${end}` : (start || end);

  const until = await earlyBirdDeadline();
  const deadlineLine = until ? ` (${esc(formatFullDate(until))})` : '';

  let programLine = '';
  try {
    const programs = await (await fetch('/api/program-options')).json();
    const groups = (programs.groups || []).filter((g) => (g.options || []).length);
    if (groups.length) {
      programLine = groups.map((g) => `<b>${g.options.length}</b> ${esc(g.name)}`).join(' and ') + ' to choose from.';
    }
  } catch { /* best-effort -- the email still makes sense without this line */ }

  return `<p>Dear Colleague,</p>
<p>This is a reminder that <b>today${deadlineLine} is the last day</b> to register for <b>${esc(c.name || 'the conference')}</b> at the early bird rate. Fees go up starting tomorrow, so this is your last chance to lock in the current pricing.</p>
${dateRange || c.location ? `<table style="width:100%;margin:1rem 0;font-size:.85rem">
  ${dateRange ? `<tr><td style="padding:.2rem 0;color:#64748b;width:90px">📅 Dates</td><td style="padding:.2rem 0;font-weight:600">${dateRange}</td></tr>` : ''}
  ${c.location ? `<tr><td style="padding:.2rem 0;color:#64748b">📍 Venue</td><td style="padding:.2rem 0;font-weight:600">${esc(c.location)}</td></tr>` : ''}
</table>` : ''}
${programLine ? `<p>Alongside the main conference, there are ${programLine}</p>` : ''}
<p style="text-align:center;margin:1.5rem 0">
  <a href="${window.location.origin}" style="background:#4f46e5;color:#fff;padding:.75rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;margin:0 .35rem">Register Now</a>
  <a href="https://nqocn2026.mgims.ac.in" style="background:#fff;color:#4f46e5;border:2px solid #4f46e5;padding:.65rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;margin:0 .35rem">Visit Conference Website</a>
</p>
<p>If you've already registered, please disregard this email.</p>`;
}

// The configured early-bird cutoff (YYYY-MM-DD), or '' if it can't be read.
// Every template quotes this rather than a date typed into the copy, so an
// email can never announce a deadline the fee master disagrees with.
async function earlyBirdDeadline() {
  try {
    const fees = await (await fetch('/api/fees')).json();
    return fees.earlyUntil || '';
  } catch { return ''; }
}

// Announcement that the early-bird cutoff has moved. Same shape as the
// "ending soon" template above so the two read as a pair, and built from the
// same live sources -- the deadline comes from the fee master, so this cannot
// promise a date the app won't actually honour.
async function buildEarlyBirdExtensionBody() {
  const c = conferenceInfo;
  const start = formatFullDate(c.startDate);
  const end = formatFullDate(c.endDate);
  const dateRange = (start && end && c.startDate !== c.endDate) ? `${start} &ndash; ${end}` : (start || end);
  const until = await earlyBirdDeadline();
  const deadline = until ? formatFullDateWithDay(until) : '';

  let programLine = '';
  try {
    const programs = await (await fetch('/api/program-options')).json();
    const groups = (programs.groups || []).filter((g) => (g.options || []).length);
    if (groups.length) {
      programLine = groups.map((g) => `<b>${g.options.length}</b> ${esc(g.name)}`).join(' and ') + ' to choose from.';
    }
  } catch { /* best-effort -- the email still makes sense without this line */ }

  return `<p>Dear Colleague,</p>
<p>The response to <b>${esc(c.name || 'the conference')}</b> has been overwhelming, and we have had a steady stream of requests for more time. In response, <b>early bird registration has been extended</b>.</p>
${deadline ? `<div style="background:#eef2ff;border:1px solid #c7d2fe;border-radius:10px;padding:1rem 1.25rem;margin:1.25rem 0">
  <div style="font-size:.7rem;letter-spacing:.09em;text-transform:uppercase;color:#4338ca;font-weight:700">New early bird deadline</div>
  <div style="font-size:1.2rem;font-weight:800;color:#312e81;margin-top:.25rem">${esc(deadline)}</div>
  <div style="font-size:.78rem;color:#4338ca;margin-top:.4rem">Register <i>and</i> complete payment on or before this date to pay the early bird rate. Registrations after it are charged the regular rate.</div>
</div>` : '<p><b>Early bird registration has been extended.</b> Register and complete payment before the new deadline to pay the early bird rate.</p>'}
<p>If you have already registered, nothing changes and no action is needed &mdash; this is simply a longer window for colleagues who have not yet completed theirs. Do pass it on to anyone in your department who meant to register and has not got around to it.</p>
${dateRange || c.location ? `<table style="width:100%;margin:1rem 0;font-size:.85rem">
  ${dateRange ? `<tr><td style="padding:.2rem 0;color:#64748b;width:90px">📅 Dates</td><td style="padding:.2rem 0;font-weight:600">${dateRange}</td></tr>` : ''}
  ${c.location ? `<tr><td style="padding:.2rem 0;color:#64748b">📍 Venue</td><td style="padding:.2rem 0;font-weight:600">${esc(c.location)}</td></tr>` : ''}
</table>` : ''}
${programLine ? `<p>Alongside the main conference, there are ${programLine}</p>` : ''}
<p style="text-align:center;margin:1.5rem 0">
  <a href="${window.location.origin}" style="background:#4f46e5;color:#fff;padding:.75rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;margin:0 .35rem">Register Now</a>
  <a href="https://nqocn2026.mgims.ac.in" style="background:#fff;color:#4f46e5;border:2px solid #4f46e5;padding:.65rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;margin:0 .35rem">Visit Conference Website</a>
</p>
<p>Warm regards,<br><b>Organising Committee</b><br>${esc([c.acronym, c.location].filter(Boolean).join(', '))}</p>`;
}

// The abstract deadline moving. Like the early-bird templates, the date comes
// from the app itself (Settings -> General -> Conference, surfaced on
// /api/conference), so this email cannot announce a date the portal would
// refuse a submission on.
// For MGIMS faculty, sent to addresses pasted into Custom Recipients (no
// names there, so "Dear Colleague"). Personalised bottles must be ordered
// ahead, so the last date is in the email; and anyone signing up with their
// @mgims.ac.in address, once verified, is charged the Early Bird fee by the
// email-domain code -- nothing to type.
const MGIMS_BOTTLE_DEADLINE = '2026-10-20';
async function buildMgimsRegisterBody() {
  const c = conferenceInfo;
  const start = formatFullDate(c.startDate);
  const end = formatFullDate(c.endDate);
  const dateRange = (start && end && c.startDate !== c.endDate) ? `${start} &ndash; ${end}` : (start || end);
  return `<p>Dear Colleague,</p>
<p>This is a reminder to register for <b>${esc(c.name || 'the conference')}</b>${dateRange ? `, on ${dateRange}` : ''}${c.location ? ` at ${esc(c.location)}` : ''}.</p>
<div style="background:#eef3f6;border:1px solid #b9cedb;border-radius:10px;padding:1rem 1.25rem;margin:1.25rem 0">
  <div style="font-size:.7rem;letter-spacing:.09em;text-transform:uppercase;color:#2f5673;font-weight:700">A personalised bottle in your kit</div>
  <div style="font-size:.9rem;color:#1c3549;margin-top:.4rem">Every delegate kit includes a <b>bottle personalised with your name</b>. The bottles are made to order, so we can personalise one only for those who register by <b>${esc(formatFullDateWithDay(MGIMS_BOTTLE_DEADLINE))}</b>. If your registration comes later, it will not be possible to customise your bottle.</div>
</div>
<div style="background:#eef3f6;border:1px solid #b9cedb;border-radius:10px;padding:1rem 1.25rem;margin:1.25rem 0">
  <div style="font-size:.7rem;letter-spacing:.09em;text-transform:uppercase;color:#2f5673;font-weight:700">The Early Bird price, for MGIMS</div>
  <div style="font-size:.9rem;color:#1c3549;margin-top:.4rem">Register with your <b>@mgims.ac.in</b> email address and you will be charged the <b>Early Bird fee</b>, whatever the date. There is no code to enter: once your @mgims.ac.in address is verified, the Early Bird fee is applied at payment by itself.</div>
</div>
<p><b>How to register</b></p>
<ol style="padding-left:1.1rem;margin:.5rem 0">
  <li>Open the registration portal and sign up (or log in) using your <b>@mgims.ac.in</b> email address.</li>
  <li>Verify your email address when asked &mdash; this is what unlocks the Early Bird price.</li>
  <li>Complete your registration and payment. The Early Bird fee is shown at payment.</li>
</ol>
<p style="text-align:center;margin:1.5rem 0">
  <a href="${window.location.origin}" style="background:#2f5673;color:#fff;padding:.75rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">Register Now</a>
</p>
<p>If you have already registered, thank you &mdash; please ignore this message.</p>
<p>Warm regards,<br><b>Organising Committee</b><br>${esc([c.acronym, c.location].filter(Boolean).join(', '))}</p>`;
}

// For delegates whose abstract still lists only themselves: the portal took
// one author per abstract at first. {{title}} is filled in per recipient.
async function buildAbstractAuthorsBody() {
  const c = conferenceInfo;
  const by = c.authorsDeadline ? ` by <b>${esc(formatFullDateWithDay(c.authorsDeadline))}</b>` : '';
  return `<p>Dear {{name}},</p>
<p>Thank you for submitting your abstract, <b>&ldquo;{{title}}&rdquo;</b>, to <b>${esc(c.name || 'the conference')}</b>.</p>
<p>When you submitted it, the portal recorded only you as its author. So that the abstract book and the programme name everyone who worked on it, please add all the co-authors, in the order you want them printed${by}.</p>
<div style="background:#faf5e8;border:1px solid #d6b46a;border-radius:10px;padding:1rem 1.25rem;margin:1.25rem 0">
  <div style="font-size:.7rem;letter-spacing:.09em;text-transform:uppercase;color:#8a6d2b;font-weight:700">How to add them</div>
  <ol style="font-size:.9rem;color:#1c3549;margin:.5rem 0 0;padding-left:1.2rem">
    <li>Log in to the portal with the account you used to submit the abstract.</li>
    <li>On the <b>Abstract</b> card, tap <b>Add authors</b>.</li>
    <li>Add each co-author's full name (up to 6 authors in all), use the arrows to put them in order, and save.</li>
  </ol>
</div>
<p>You stay on the list as the presenting author, and can be placed anywhere in the order. Your abstract itself is not changed. If you are the only author, open the list and save it as it is.</p>
<p style="text-align:center;margin:1.5rem 0">
  <a href="${window.location.origin}" style="background:#1c3549;color:#fff;padding:.75rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">Add Authors</a>
</p>
<p>Warm regards,<br><b>Organising Committee</b><br>${esc([c.acronym, c.location].filter(Boolean).join(', '))}</p>`;
}

// For authors who submitted an abstract but have not registered. {{title}}
// is filled in per recipient by the server, so it only makes sense on the
// Abstract Submitted, Not Registered card.
async function buildAbstractRegistrationMandatoryBody() {
  const c = conferenceInfo;
  const start = formatFullDate(c.startDate);
  const end = formatFullDate(c.endDate);
  const dateRange = (start && end && c.startDate !== c.endDate) ? `${start} &ndash; ${end}` : (start || end);

  return `<p>Dear {{name}},</p>
<p>Thank you for submitting your abstract, <b>&ldquo;{{title}}&rdquo;</b>, to <b>${esc(c.name || 'the conference')}</b>.</p>
<div style="background:#eef3f6;border:1px solid #b9cedb;border-radius:10px;padding:1rem 1.25rem;margin:1.25rem 0">
  <div style="font-size:.7rem;letter-spacing:.09em;text-transform:uppercase;color:#2f5673;font-weight:700">Registration is mandatory for presentation</div>
  <div style="font-size:.9rem;color:#1c3549;margin-top:.4rem">Our records show you have <b>not yet registered</b> for the conference. An abstract can only be presented by a registered delegate, so any approval of your abstract will stay <b>provisional &mdash; pending registration</b> until you register.</div>
</div>
<p>Please log in to the portal with the same account you used to submit your abstract, and complete your registration and payment. Nothing else is needed: once you are registered, your abstract goes forward as usual.</p>
${dateRange || c.location ? `<table style="width:100%;margin:1rem 0;font-size:.85rem">
  ${dateRange ? `<tr><td style="padding:.2rem 0;color:#64748b;width:90px">📅 Dates</td><td style="padding:.2rem 0;font-weight:600">${dateRange}</td></tr>` : ''}
  ${c.location ? `<tr><td style="padding:.2rem 0;color:#64748b">📍 Venue</td><td style="padding:.2rem 0;font-weight:600">${esc(c.location)}</td></tr>` : ''}
</table>` : ''}
<p style="text-align:center;margin:1.5rem 0">
  <a href="${window.location.origin}" style="background:#2f5673;color:#fff;padding:.75rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">Register Now</a>
</p>
<p>If you have registered in the last day or so, please ignore this message.</p>
<p>Warm regards,<br><b>Organising Committee</b><br>${esc([c.acronym, c.location].filter(Boolean).join(', '))}</p>`;
}

async function buildAbstractExtensionBody() {
  const c = conferenceInfo;
  const deadline = c.abstractDeadline ? formatFullDateWithDay(c.abstractDeadline) : '';
  const start = formatFullDate(c.startDate);
  const end = formatFullDate(c.endDate);
  const dateRange = (start && end && c.startDate !== c.endDate) ? `${start} &ndash; ${end}` : (start || end);

  return `<p>Dear {{name}},</p>
<p>Thank you for registering for <b>${esc(c.name || 'the conference')}</b>. We have had a number of requests for more time to prepare abstracts, and the scientific committee has agreed to <b>extend the last date for abstract submission</b>.</p>
${deadline ? `<div style="background:#eef2ff;border:1px solid #c7d2fe;border-radius:10px;padding:1rem 1.25rem;margin:1.25rem 0">
  <div style="font-size:.7rem;letter-spacing:.09em;text-transform:uppercase;color:#4338ca;font-weight:700">New last date for abstracts</div>
  <div style="font-size:1.2rem;font-weight:800;color:#312e81;margin-top:.25rem">${esc(deadline)}</div>
  <div style="font-size:.78rem;color:#4338ca;margin-top:.4rem">Submissions close at the end of this day (IST). After that the portal cannot accept a new abstract.</div>
</div>` : '<p><b>The last date for abstract submission has been extended.</b> Log in to the portal for the new date.</p>'}
<p>Your abstract is submitted from your own dashboard, under <b>Submit Abstract</b>. A reminder of what is expected:</p>
<ul style="padding-left:1.1rem;margin:.5rem 0">
  <li>A <b>structured abstract</b> &mdash; Background, Aim, Methods, Results, Conclusion &mdash; of at most <b>400 words</b>.</li>
  <li>One abstract per delegate, on <b>Healthcare Quality &amp; Patient Safety</b>.</li>
  <li>Submitted for <b>oral</b> or <b>poster</b> presentation; the committee decides which.</li>
</ul>
<p>If you have already submitted, nothing changes and no action is needed. If the committee has asked you for corrections, you can still resubmit from the same place.</p>
${dateRange || c.location ? `<table style="width:100%;margin:1rem 0;font-size:.85rem">
  ${dateRange ? `<tr><td style="padding:.2rem 0;color:#64748b;width:90px">📅 Dates</td><td style="padding:.2rem 0;font-weight:600">${dateRange}</td></tr>` : ''}
  ${c.location ? `<tr><td style="padding:.2rem 0;color:#64748b">📍 Venue</td><td style="padding:.2rem 0;font-weight:600">${esc(c.location)}</td></tr>` : ''}
</table>` : ''}
<p style="text-align:center;margin:1.5rem 0">
  <a href="${window.location.origin}" style="background:#4f46e5;color:#fff;padding:.75rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">Submit Your Abstract</a>
</p>
<p>Warm regards,<br><b>Organising Committee</b><br>${esc([c.acronym, c.location].filter(Boolean).join(', '))}</p>`;
}

// The group discount, for people who have an account but have not registered.
// The categories, minimums and amounts are read from the group-discount rules
// in force, so the offer in the email is the offer the portal will honour --
// and the how-to page carries the detail rather than the email repeating it.
async function buildGroupDiscountBody() {
  const c = conferenceInfo;
  let offers = [];
  try {
    offers = (await (await fetch('/api/groups/eligible-categories')).json()).categories || [];
  } catch { /* best-effort -- the email still reads without the table */ }
  const amount = (o) => (o.discount_type === 'PERCENT' ? `${Number(o.discount_value)}%` : `₹${inr(o.discount_value)}`);
  const minimum = offers.length ? Math.min(...offers.map((o) => Number(o.min_size))) : 5;

  return `<p>Dear {{name}},</p>
<p>You created an account for <b>${esc(c.name || 'the conference')}</b> but have not completed your registration. If colleagues from your institution are coming too, it is worth registering together: <b>a group of ${esc(minimum)} or more pays less, each.</b></p>
${offers.length ? `<table style="width:100%;border-collapse:collapse;margin:1.25rem 0;font-size:.85rem">
  <tr style="background:#eef2ff">
    <th align="left" style="padding:.5rem .6rem;border:1px solid #c7d2fe;font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:#4338ca">Category</th>
    <th align="left" style="padding:.5rem .6rem;border:1px solid #c7d2fe;font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:#4338ca">Group of</th>
    <th align="left" style="padding:.5rem .6rem;border:1px solid #c7d2fe;font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:#4338ca">Each saves</th>
  </tr>
  ${offers.map((o) => `<tr>
    <td style="padding:.5rem .6rem;border:1px solid #e2e8f0">${esc(o.label)}</td>
    <td style="padding:.5rem .6rem;border:1px solid #e2e8f0">${esc(o.min_size)}+</td>
    <td style="padding:.5rem .6rem;border:1px solid #e2e8f0;font-weight:700;color:#047857">${amount(o)}</td>
  </tr>`).join('')}
</table>` : ''}
<p><b>How it works:</b> everyone signs up on the portal, one of you starts a group and adds the others by their registered mobile number or email address, and each person then pays their own reduced fee. The one thing to get right is the order &mdash; the discount is applied when you pay, so gather the group first.</p>
<p style="text-align:center;margin:1.5rem 0">
  <a href="${window.location.origin}" style="background:#4f46e5;color:#fff;padding:.75rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;margin:0 .35rem">Complete Your Registration</a>
  <a href="${window.location.origin}/help/group-registration" style="background:#fff;color:#4f46e5;border:2px solid #4f46e5;padding:.65rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;margin:0 .35rem">How Group Registration Works</a>
</p>
<p>Warm regards,<br><b>Organising Committee</b><br>${esc([c.acronym, c.location].filter(Boolean).join(', '))}</p>`;
}

// Every template, in one place. `audiences` is where the picker offers it:
// only where everything it says is true of the audience, and every
// placeholder it uses can be filled (an email to pasted addresses cannot say
// {{name}}). Subjects are async too, because the "ending soon" one has to
// know whether the cutoff is actually today.
const NOT_REGISTERED = ['signups', 'faculty', 'domain', 'unverified'];
const CUSTOM_REMINDER_TEMPLATES = {
  'registration-reminder': {
    label: 'Complete your registration',
    audiences: NOT_REGISTERED,
    async subject() {
      return conferenceInfo.acronym ? `Complete your registration for ${conferenceInfo.acronym}` : 'Complete your registration';
    },
    body: buildRegistrationReminderBody,
  },
  'verify-email': {
    label: 'Verify your email address',
    audiences: ['unverified'],
    async subject() {
      const who = conferenceInfo.acronym ? ` for ${conferenceInfo.acronym}` : '';
      return `Please verify your email address${who}`;
    },
    body: buildVerifyEmailBody,
  },
  'mgims-verify': {
    label: 'MGIMS — verify your email for the Early Bird price',
    audiences: ['domain', 'unverified'],
    async subject() {
      const who = conferenceInfo.acronym ? ` for ${conferenceInfo.acronym}` : '';
      return `Verify your @mgims.ac.in email to get the Early Bird price${who}`;
    },
    body: buildMgimsVerifyBody,
  },
  'early-bird-ending': {
    label: 'Early bird — ending soon',
    audiences: [...NOT_REGISTERED, 'paste'],
    async subject() {
      const until = await earlyBirdDeadline();
      const who = conferenceInfo.acronym ? ` for ${conferenceInfo.acronym}` : '';
      // "Ends Today" is only true on the cutoff date itself; any other day it
      // is a claim the fee master contradicts.
      if (until && until === istDateString()) return `Early Bird Registration${who} Ends Today`;
      return until
        ? `Early Bird Registration${who} Ends on ${formatFullDate(until)}`
        : `Early Bird Registration${who} Is Ending Soon`;
    },
    body: buildEarlyBirdReminderBody,
  },
  'early-bird-extended': {
    label: 'Early bird — deadline extended',
    audiences: [...NOT_REGISTERED, 'paste'],
    async subject() {
      const until = await earlyBirdDeadline();
      const who = conferenceInfo.acronym ? ` for ${conferenceInfo.acronym}` : '';
      return until
        ? `Early Bird Registration${who} Extended to ${formatFullDate(until)}`
        : `Early Bird Registration${who} Has Been Extended`;
    },
    body: buildEarlyBirdExtensionBody,
  },
  'mgims-register': {
    label: 'MGIMS faculty — register now (Early Bird, personalised bottle)',
    audiences: [...NOT_REGISTERED, 'paste'],
    async subject() {
      const who = conferenceInfo.acronym ? ` for ${conferenceInfo.acronym}` : '';
      return `MGIMS Faculty: Register${who} by ${formatFullDate(MGIMS_BOTTLE_DEADLINE)} — Early Bird Price and a Personalised Bottle`;
    },
    body: buildMgimsRegisterBody,
  },
  'group-discount': {
    label: 'Group discount — register with colleagues',
    audiences: NOT_REGISTERED,
    async subject() {
      const who = conferenceInfo.acronym ? ` at ${conferenceInfo.acronym}` : '';
      return `Registering with colleagues${who}? Your group pays less`;
    },
    body: buildGroupDiscountBody,
  },
  'abstract-registration-mandatory': {
    label: 'Abstracts — registration is mandatory to present',
    audiences: ['abstract'],
    async subject() {
      const who = conferenceInfo.acronym ? ` at ${conferenceInfo.acronym}` : '';
      return `Registration Is Mandatory to Present Your Abstract${who}`;
    },
    body: buildAbstractRegistrationMandatoryBody,
  },
  'abstract-add-authors': {
    label: 'Abstracts — add all your co-authors',
    audiences: ['abstract_authors'],
    async subject() {
      const who = conferenceInfo.acronym ? ` for ${conferenceInfo.acronym}` : '';
      return `Add the Co-authors of Your Abstract${who}`;
    },
    body: buildAbstractAuthorsBody,
  },
  'abstract-deadline-extended': {
    label: 'Abstracts — last date extended',
    audiences: ['registered', 'signups'],
    async subject() {
      const until = conferenceInfo.abstractDeadline;
      const who = conferenceInfo.acronym ? ` for ${conferenceInfo.acronym}` : '';
      return until
        ? `Abstract Submission${who} Extended to ${formatFullDate(until)}`
        : `Abstract Submission${who} Has Been Extended`;
    },
    body: buildAbstractExtensionBody,
  },
  'code-holder': {
    label: 'Your personal code is waiting',
    audiences: ['codes'],
    async subject() {
      const who = conferenceInfo.acronym ? ` for ${conferenceInfo.acronym}` : '';
      return `Your personal registration code${who} is waiting to be used`;
    },
    body: buildCodeHolderBody,
  },
  'certificate-ready': {
    label: 'Your certificate is ready',
    audiences: ['certificates'],
    async subject() {
      const who = conferenceInfo.acronym ? ` for ${conferenceInfo.acronym}` : '';
      return `Your certificate${who} is ready to download`;
    },
    body: buildCertificateReadyBody,
  },
  'balance-due': {
    label: 'Balance payment pending',
    audiences: ['balance'],
    async subject() {
      return 'Balance payment pending for your registration';
    },
    body: buildBalanceDueBody,
  },
};

// What the composer starts with for an audience, while nothing has been
// written yet. Registered delegates hear one-off announcements: no default.
const REMINDER_DEFAULT_TEMPLATE = {
  signups: 'registration-reminder', faculty: 'registration-reminder', domain: 'registration-reminder',
  unverified: 'verify-email', abstract: 'abstract-registration-mandatory', codes: 'code-holder',
  balance: 'balance-due', paste: 'early-bird-ending', certificates: 'certificate-ready',
  abstract_authors: 'abstract-add-authors',
};

// --- The composer ------------------------------------------------------------
// 1 Who (an audience, and its filters) · 2 What (template, subject, body,
// live preview) · 3 Send to (the people, chosen one by one or all at once).
// The email is kept as the audience changes; the preview and the checks say
// at once if it now uses a placeholder the new audience cannot fill.
const remState = {
  audiences: [], placeholders: {}, options: { categories: [], statuses: [] },
  key: null, recipients: [], selected: new Set(), filters: { domain: '', category: '', status: '' },
  autoFilled: null, problems: { unsupported: [], missing: [] }, previewTimer: null, previewSeq: 0,
};
const REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const reminderOnCooldown = (r) => !!r.last_reminder_sent_at && (Date.now() - Number(r.last_reminder_sent_at)) < REMINDER_COOLDOWN_MS;
const reminderSelectable = (r) => !!r.email && !reminderOnCooldown(r);
const remAudience = () => remState.audiences.find((a) => a.key === remState.key) || null;

async function renderReminders() {
  const res = await fetch(`/api/admin/reminders/audiences?domain=${encodeURIComponent(remState.filters.domain)}`);
  if (!res.ok) return;
  const data = await res.json();
  remState.audiences = data.audiences || [];
  remState.placeholders = data.placeholders || {};
  remState.options = data.options || remState.options;
  const signups = remState.audiences.find((a) => a.key === 'signups');
  setText('badge-pending-signups', String(signups ? signups.count : 0));
  fillReminderFilterOptions();
  renderReminderAudiences();
  switchReminderView(storageGet('local', 'nqocn_rem_view') === 'sent' ? 'sent' : 'compose');
  await selectReminderAudience(remState.key && remAudience() ? remState.key : 'signups', { refresh: true });
}

function renderReminderAudiences() {
  const box = document.getElementById('rem-audiences');
  if (!box) return;
  const groups = [...new Set(remState.audiences.map((a) => a.group))];
  box.innerHTML = groups.map((g) => `
    <div>
      <p class="text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">${esc(g)}</p>
      <div class="flex flex-wrap gap-2">
        ${remState.audiences.filter((a) => a.group === g).map((a) => {
          const on = a.key === remState.key;
          return `<button type="button" data-rem-audience="${esc(a.key)}" onclick="selectReminderAudience('${esc(a.key)}')" aria-pressed="${on}"
            class="px-3 py-1.5 rounded-lg border text-sm font-semibold flex items-center gap-2 ${on ? 'bg-indigo-600 border-indigo-600 text-white' : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'}">
            ${esc(a.label)}${a.count != null ? `<span class="text-[11px] px-1.5 py-0.5 rounded-full font-bold ${on ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-600'}">${a.count}</span>` : ''}
          </button>`;
        }).join('')}
      </div>
    </div>`).join('');
}

function fillReminderFilterOptions() {
  const cat = document.getElementById('rem-category');
  const st = document.getElementById('rem-status');
  if (cat) cat.innerHTML = '<option value="">Every category</option>' + remState.options.categories.map((c) => `<option value="${esc(c.value)}">${esc(c.label)}</option>`).join('');
  if (st) st.innerHTML = '<option value="">Every status</option>' + remState.options.statuses.map((s) => `<option value="${esc(s.value)}">${esc(s.label)}</option>`).join('');
  if (cat) cat.value = remState.filters.category;
  if (st) st.value = remState.filters.status;
}

// Choose an audience. The email stays as it is -- unless it is still the
// last audience's untouched default, which is swapped for this one's.
async function selectReminderAudience(key, { refresh = false } = {}) {
  const changed = key !== remState.key;
  remState.key = key;
  const a = remAudience();
  if (!a) return;
  if (changed) { remState.selected = new Set(); remState.recipients = []; }
  renderReminderAudiences();
  setText('rem-audience-desc', a.description);
  document.getElementById('rem-filter-domain').classList.toggle('hidden', !a.filters.includes('domain'));
  document.getElementById('rem-filter-registered').classList.toggle('hidden', !a.filters.includes('category'));
  document.getElementById('rem-recipients-wrap').classList.toggle('hidden', a.key === 'paste');
  document.getElementById('rem-paste-wrap').classList.toggle('hidden', a.key !== 'paste');
  const domainBox = document.getElementById('rem-domain');
  if (domainBox && document.activeElement !== domainBox) domainBox.value = remState.filters.domain;

  const picker = document.getElementById('rem-template');
  const fits = Object.entries(CUSTOM_REMINDER_TEMPLATES).filter(([, t]) => t.audiences.includes(a.key));
  picker.innerHTML = `<option value="">${fits.length ? '— Choose a template —' : '— No template for this audience —'}</option>`
    + fits.map(([k, t]) => `<option value="${esc(k)}">${esc(t.label)}</option>`).join('');
  picker.disabled = !fits.length;

  document.getElementById('rem-placeholders').innerHTML = a.placeholders.length
    ? a.placeholders.map((p) => `<button type="button" onclick="insertReminderPlaceholder('${esc(p)}')" title="${esc(remState.placeholders[p] || '')}"
        class="px-2 py-0.5 rounded-md border border-slate-300 bg-slate-50 hover:bg-slate-100 text-[11px] font-mono text-slate-700">{{${esc(p)}}}</button>`).join('')
    : '<span class="text-[11px] text-slate-400">Nothing is filled in for this audience.</span>';

  const subject = document.getElementById('rem-subject');
  const body = document.getElementById('rem-body');
  const untouched = !subject.value.trim() && !body.value.trim()
    || (remState.autoFilled && subject.value === remState.autoFilled.subject && body.value === remState.autoFilled.body);
  if ((changed || refresh) && untouched && REMINDER_DEFAULT_TEMPLATE[a.key]) {
    await fillReminderTemplate(REMINDER_DEFAULT_TEMPLATE[a.key]);
  }
  if (a.key !== 'paste' && (a.key !== 'domain' || remState.filters.domain)) await loadReminderRecipients();
  else { remState.recipients = []; renderReminderRecipients(); }
  scheduleReminderPreview(0);
}

function applyReminderFilters() {
  const a = remAudience();
  if (!a) return;
  if (a.filters.includes('domain')) {
    remState.filters.domain = document.getElementById('rem-domain').value.trim().replace(/^@+/, '').toLowerCase();
    // The count on the chip is for the domain asked about.
    renderReminders();
    return;
  }
  remState.filters.category = document.getElementById('rem-category').value;
  remState.filters.status = document.getElementById('rem-status').value;
  remState.selected = new Set();
  loadReminderRecipients().then(() => scheduleReminderPreview(0));
}

function reminderFilterQuery() {
  const a = remAudience();
  const f = {};
  if (a && a.filters.includes('domain')) f.domain = remState.filters.domain;
  if (a && a.filters.includes('category')) { f.category = remState.filters.category; f.status = remState.filters.status; }
  return f;
}

async function loadReminderRecipients() {
  const a = remAudience();
  const q = new URLSearchParams(reminderFilterQuery()).toString();
  const res = await fetch(`/api/admin/reminders/audiences/${encodeURIComponent(a.key)}/recipients${q ? `?${q}` : ''}`);
  const data = res.ok ? await res.json() : { recipients: [] };
  if (remState.key !== a.key) return;
  remState.recipients = data.recipients || [];
  // A selection survives a reload only for people still in the audience.
  const ids = new Set(remState.recipients.filter(reminderSelectable).map((r) => String(r.id)));
  remState.selected = new Set([...remState.selected].filter((id) => ids.has(id)));
  const previewAs = document.getElementById('rem-preview-as');
  if (previewAs) {
    const keep = previewAs.value;
    previewAs.innerHTML = '<option value="">Preview as: first in the list</option>'
      + remState.recipients.slice(0, 300).map((r) => `<option value="${esc(r.id)}">${esc(r.name || r.email || r.id)}</option>`).join('');
    previewAs.value = remState.recipients.some((r) => String(r.id) === keep) ? keep : '';
  }
  renderReminderRecipients();
}

function renderReminderRecipients() {
  const list = document.getElementById('rem-recipients');
  if (!list) return;
  const term = (document.getElementById('rem-recipient-search').value || '').trim().toLowerCase();
  const shown = remState.recipients.filter((r) => !term
    || [r.name, r.email, r.detail, ...(r.tags || [])].some((v) => String(v || '').toLowerCase().includes(term)));
  const a = remAudience();
  list.innerHTML = shown.length ? shown.map((r) => {
    const ok = reminderSelectable(r);
    const tags = [
      ...(r.tags || []).map((t) => `<span class="text-[10px] bg-slate-100 text-slate-600 border border-slate-200 px-2 py-0.5 rounded-full font-semibold">${esc(t)}</span>`),
      !r.email ? '<span class="text-[10px] bg-rose-100 text-rose-700 border border-rose-300 px-2 py-0.5 rounded-full font-bold">No email</span>' : '',
      reminderOnCooldown(r) ? '<span class="text-[10px] bg-amber-100 text-amber-700 border border-amber-300 px-2 py-0.5 rounded-full font-bold">Sent within 24h</span>' : '',
    ].join('');
    return `<label class="px-3 py-2 flex items-start gap-2 ${ok ? 'cursor-pointer hover:bg-slate-50' : 'opacity-60'}">
      <input type="checkbox" class="rem-recipient mt-1 shrink-0" value="${esc(r.id)}" ${ok ? '' : 'disabled'} ${remState.selected.has(String(r.id)) ? 'checked' : ''} onchange="toggleReminderRecipient(this.value, this.checked)">
      <span class="min-w-0 flex-1">
        <span class="flex flex-wrap items-center gap-1.5"><span class="font-semibold text-slate-700">${esc(r.name || r.email || r.id)}</span>${tags}</span>
        <span class="block text-xs text-slate-400 truncate">${esc([r.name ? r.email : '', r.detail].filter(Boolean).join(' · ') || '')}${r.last_reminder_sent_at ? ` · last sent ${esc(fmtAuditTime(r.last_reminder_sent_at))}` : ''}</span>
      </span>
    </label>`;
  }).join('')
    : `<div class="px-3 py-6 text-center text-slate-400 text-sm">${a && a.key === 'domain' && !remState.filters.domain
      ? 'Enter an email domain above, then Find.'
      : remState.recipients.length ? 'Nobody matches the search.' : 'Nobody is in this audience right now.'}</div>`;
  const selectAll = document.getElementById('rem-select-all');
  const selectable = shown.filter(reminderSelectable);
  if (selectAll) {
    selectAll.disabled = !selectable.length;
    selectAll.checked = selectable.length > 0 && selectable.every((r) => remState.selected.has(String(r.id)));
  }
  updateReminderSendState();
}

function toggleReminderRecipient(id, on) {
  if (on) remState.selected.add(String(id)); else remState.selected.delete(String(id));
  renderReminderRecipients();
}

// Select (or clear) everyone SHOWN who can be written to -- a search narrows
// what "all" means, so a filtered list can be sent to on its own.
function toggleAllReminderRecipients(on) {
  const term = (document.getElementById('rem-recipient-search').value || '').trim().toLowerCase();
  remState.recipients
    .filter((r) => !term || [r.name, r.email, r.detail, ...(r.tags || [])].some((v) => String(v || '').toLowerCase().includes(term)))
    .filter(reminderSelectable)
    .forEach((r) => (on ? remState.selected.add(String(r.id)) : remState.selected.delete(String(r.id))));
  renderReminderRecipients();
}

function parsePastedAddresses() {
  return (document.getElementById('rem-paste').value || '').split(/[\n,;]/).map((s) => s.trim()).filter(Boolean);
}

function reminderTargets() {
  const a = remAudience();
  return a && a.key === 'paste' ? parsePastedAddresses() : [...remState.selected];
}

function updateReminderSendState() {
  const a = remAudience();
  if (!a) return;
  const n = reminderTargets().length;
  const mayTest = can('comms.reminders_test');
  const maySend = a.key === 'paste' ? can('comms.custom_send') : can('comms.reminders_send');
  const blocked = remState.problems.unsupported.length || remState.problems.missing.length;
  setText('rem-send-count', `${n} ${a.key === 'paste' ? (n === 1 ? 'Address' : 'Addresses') : (n === 1 ? 'Person' : 'People')}`);
  const sendBtn = document.getElementById('rem-send-btn');
  sendBtn.disabled = !n || !maySend || !!blocked;
  sendBtn.title = !maySend ? 'You do not have permission to send this.' : blocked ? 'Fix the placeholders first.' : '';
  const testBtn = document.getElementById('rem-test-btn');
  testBtn.disabled = !mayTest || !!blocked;
  testBtn.title = !mayTest ? 'You do not have permission to send a test.' : '';
  if (a.key === 'paste') {
    setText('rem-recipient-summary', n ? `${n} address${n === 1 ? '' : 'es'} entered` : '');
  } else {
    const writable = remState.recipients.filter(reminderSelectable).length;
    setText('rem-recipient-summary', `${remState.recipients.length} in this audience · ${writable} can be written to now · ${remState.selected.size} selected`);
  }
}

function onReminderEdited() {
  scheduleReminderPreview();
}

function insertReminderPlaceholder(p) {
  const box = document.getElementById('rem-body');
  const token = `{{${p}}}`;
  const at = box.selectionStart != null ? box.selectionStart : box.value.length;
  const to = box.selectionEnd != null ? box.selectionEnd : at;
  box.value = box.value.slice(0, at) + token + box.value.slice(to);
  box.focus();
  box.selectionStart = box.selectionEnd = at + token.length;
  scheduleReminderPreview(0);
}

async function fillReminderTemplate(key) {
  const tpl = CUSTOM_REMINDER_TEMPLATES[key];
  if (!tpl) return;
  const subject = await tpl.subject();
  const body = await tpl.body();
  document.getElementById('rem-subject').value = subject;
  document.getElementById('rem-body').value = body;
  remState.autoFilled = { subject, body };
}

// Anything already typed is confirmed over first: these are long fields,
// and losing a half-written announcement to a stray click would be worse
// than an extra prompt.
async function applyReminderTemplate(key) {
  const picker = document.getElementById('rem-template');
  if (picker) picker.value = '';
  const tpl = CUSTOM_REMINDER_TEMPLATES[key];
  if (!tpl) return;
  const subject = document.getElementById('rem-subject');
  const body = document.getElementById('rem-body');
  const edited = (subject.value.trim() || body.value.trim())
    && !(remState.autoFilled && subject.value === remState.autoFilled.subject && body.value === remState.autoFilled.body);
  if (edited && !(await showConfirm(`Replace the subject and body with the "${tpl.label}" template?`))) return;
  await fillReminderTemplate(key);
  showToast(`Loaded the "${tpl.label}" template.`, 'success');
  scheduleReminderPreview(0);
}

// The preview is drawn by the server -- the same filling-in and the same
// email chrome a recipient gets -- a moment after typing stops.
function scheduleReminderPreview(delay = 450) {
  clearTimeout(remState.previewTimer);
  remState.previewTimer = setTimeout(renderReminderPreview, delay);
}

async function renderReminderPreview() {
  const a = remAudience();
  if (!a) return;
  const seq = ++remState.previewSeq;
  const res = await fetch(`/api/admin/reminders/audiences/${encodeURIComponent(a.key)}/preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subject: document.getElementById('rem-subject').value,
      bodyHtml: document.getElementById('rem-body').value,
      filters: reminderFilterQuery(),
      recipientId: document.getElementById('rem-preview-as').value || null,
    }),
  });
  if (!res.ok || seq !== remState.previewSeq) return;
  const data = await res.json();
  document.getElementById('rem-preview').srcdoc = data.html || '';
  setText('rem-preview-subject', data.subject || '(no subject)');
  setText('rem-preview-to', a.key === 'paste' ? 'To: each pasted address, exactly as written'
    : data.recipient ? `As ${data.recipient.name || data.recipient.email}${data.recipient.email && data.recipient.name ? ` <${data.recipient.email}>` : ''} will see it`
      : 'Filled in with an example -- nobody is in this audience yet');
  remState.problems = data.problems || { unsupported: [], missing: [] };
  const box = document.getElementById('rem-problems');
  const lines = [
    ...remState.problems.missing.map((p) => `Keep {{${p}}} in the email — it is where each person's own ${p === 'codes' ? 'code goes' : 'details go'}.`),
    ...remState.problems.unsupported.map((p) => `{{${p}}} cannot be filled in for "${a.label}" — it would arrive as typed. Remove it, or choose another audience.`),
  ];
  box.classList.toggle('hidden', !lines.length);
  box.innerHTML = lines.map(esc).join('<br>');
  updateReminderSendState();
}

function reminderPayload() {
  return {
    subject: document.getElementById('rem-subject').value.trim(),
    bodyHtml: document.getElementById('rem-body').value.trim(),
    filters: reminderFilterQuery(),
  };
}

function setReminderResult(cls, text) {
  const el = document.getElementById('rem-send-result');
  if (el) { el.className = `text-xs font-semibold ${cls}`; el.textContent = text; }
}

// To the admin's own address, marked [TEST], filled in from the person the
// preview shows.
async function sendReminderTest() {
  const a = remAudience();
  const body = { ...reminderPayload(), recipientId: document.getElementById('rem-preview-as').value || null };
  if (!body.subject || !body.bodyHtml) return showToast('Subject and body are both required.');
  const btn = document.getElementById('rem-test-btn');
  btn.disabled = true;
  setReminderResult('text-slate-500', 'Sending test…');
  const data = await (await fetch(`/api/admin/reminders/audiences/${encodeURIComponent(a.key)}/test`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })).json();
  if (!data.success) {
    setReminderResult('text-rose-600', data.error || 'Test send failed.');
    showToast(data.error || 'Could not send the test.');
  } else {
    setReminderResult('text-emerald-600', `Test sent to ${data.sentTo}.`);
    showToast(`Test sent to ${data.sentTo}.`, 'success');
  }
  updateReminderSendState();
}

async function sendReminders() {
  const a = remAudience();
  const ids = reminderTargets();
  const body = { ...reminderPayload(), ids };
  if (!body.subject || !body.bodyHtml) return showToast('Subject and body are both required.');
  if (!ids.length) return showToast(a.key === 'paste' ? 'Enter at least one email address.' : 'Select at least one person.');
  const who = a.key === 'paste' ? `${ids.length} entered ${ids.length === 1 ? 'address' : 'addresses'}` : `${ids.length} ${ids.length === 1 ? 'person' : 'people'} in "${a.label}"`;
  if (!(await showConfirm(`Send this reminder to ${who}? This can't be undone.`))) return;

  const btn = document.getElementById('rem-send-btn');
  btn.disabled = true;
  setReminderResult('text-slate-500', 'Sending…');
  const url = a.key === 'paste' ? '/api/admin/reminders/paste/send' : `/api/admin/reminders/audiences/${encodeURIComponent(a.key)}/send`;
  const data = await (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  if (!data.success) {
    setReminderResult('text-rose-600', data.error || 'Send failed.');
    showToast(data.error || 'Could not send.');
    updateReminderSendState();
    return;
  }
  const notes = [
    data.skippedNoEmail ? `${data.skippedNoEmail} no email on file` : null,
    data.skippedSentRecently ? `${data.skippedSentRecently} already sent ${a.key === 'paste' ? 'this message' : 'one'} in the last 24h` : null,
    data.skippedInvalid ? `${data.skippedInvalid} not a valid address` : null,
    data.noLongerDue ? `${data.noLongerDue} no longer in this audience` : null,
  ].filter(Boolean).join(', ');
  const msg = `Sent to ${data.sent} of ${data.total}${notes ? ` (${notes})` : ''}.`;
  setReminderResult('text-emerald-600', msg);
  showToast(msg, 'success');
  remState.selected = new Set();
  if (a.key === 'paste') document.getElementById('rem-paste').value = '';
  // Counts, "last sent" and the cooldown marks reflect what just happened.
  await renderReminders();
}

// --- Sent ----------------------------------------------------------------------
function switchReminderView(view) {
  if (!['compose', 'sent'].includes(view)) view = 'compose';
  storageSet('local', 'nqocn_rem_view', view);
  document.querySelectorAll('.rem-subtab').forEach((b) => {
    const on = b.dataset.remView === view;
    b.classList.toggle('bg-indigo-600', on);
    b.classList.toggle('text-white', on);
    b.classList.toggle('text-slate-600', !on);
    b.classList.toggle('hover:bg-slate-100', !on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.getElementById('rem-view-compose').classList.toggle('hidden', view !== 'compose');
  document.getElementById('rem-view-sent').classList.toggle('hidden', view !== 'sent');
  if (view === 'sent') renderReminderHistory();
}

function reminderFilterLabel(f) {
  if (!f) return '';
  const cat = f.category && (remState.options.categories.find((c) => c.value === f.category) || {}).label;
  const st = f.status && (remState.options.statuses.find((s) => s.value === f.status) || {}).label;
  return [f.domain ? `@${f.domain}` : '', cat || f.category || '', st || f.status || ''].filter(Boolean).join(' · ');
}

async function renderReminderHistory() {
  const box = document.getElementById('rem-history');
  if (!box) return;
  const res = await fetch('/api/admin/reminders/history');
  if (!res.ok) return;
  const sends = (await res.json()).sends || [];
  box.innerHTML = sends.length ? sends.map((s) => {
    const skipped = s.skipped ? Object.values(s.skipped).reduce((t, n) => t + Number(n || 0), 0) : 0;
    const filter = reminderFilterLabel(s.filters);
    return `<button type="button" onclick="openReminderSend('${esc(s.id)}')" class="w-full text-left px-4 py-3 hover:bg-slate-50 flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4">
      <span class="min-w-0 flex-1">
        <span class="block font-semibold text-slate-800 truncate">${esc(s.subject || '(no subject)')}</span>
        <span class="block text-xs text-slate-500">${esc(s.audienceLabel)}${filter ? ` · ${esc(filter)}` : ''} · by ${esc(s.sentBy || '—')}${s.legacy ? ' · from the activity log' : ''}</span>
      </span>
      <span class="text-xs text-slate-500 shrink-0 tabular-nums">${esc(fmtAuditTime(s.createdAt))}</span>
      <span class="text-xs font-bold shrink-0 tabular-nums ${s.sent ? 'text-emerald-700' : 'text-slate-500'}">${s.sent} sent${skipped ? `<span class="font-semibold text-amber-700"> · ${skipped} skipped</span>` : ''}</span>
    </button>`;
  }).join('') : '<p class="px-4 py-8 text-center text-sm text-slate-400">Nothing has been sent yet.</p>';
}

const REMINDER_OUTCOMES = {
  sent: ['Sent', 'bg-emerald-50 text-emerald-700 border-emerald-200'],
  cooldown: ['Skipped: sent within 24h', 'bg-amber-50 text-amber-700 border-amber-200'],
  no_email: ['Skipped: no email', 'bg-rose-50 text-rose-700 border-rose-200'],
  invalid: ['Skipped: not a valid address', 'bg-rose-50 text-rose-700 border-rose-200'],
  no_longer_due: ['Skipped: no longer in the audience', 'bg-slate-100 text-slate-600 border-slate-200'],
};

async function openReminderSend(id) {
  const res = await fetch(`/api/admin/reminders/history/${encodeURIComponent(id)}`);
  const data = res.ok ? await res.json() : null;
  if (!data || !data.success) return showToast('Could not open that send.');
  const s = data.send;
  setText('rem-send-title', s.subject || '(no subject)');
  const filter = reminderFilterLabel(s.filters);
  setText('rem-send-meta', `${s.audienceLabel}${filter ? ` · ${filter}` : ''} · ${fmtAuditTime(s.createdAt)} · by ${s.sentBy || '—'} · ${s.sent} sent`);
  document.getElementById('rem-send-recipients').innerHTML = (s.recipients || []).map((r) => {
    const [label, cls] = REMINDER_OUTCOMES[r.outcome] || [r.outcome, 'bg-slate-100 text-slate-600 border-slate-200'];
    return `<div class="px-3 py-2 flex items-center gap-2">
      <span class="min-w-0 flex-1"><span class="block font-semibold text-slate-700 truncate">${esc(r.name || r.email || r.recipient_id)}</span>
      <span class="block text-xs text-slate-400 truncate">${esc(r.name ? (r.email || '') : (r.email && r.email !== r.recipient_id ? r.email : ''))}</span></span>
      <span class="text-[10px] px-2 py-0.5 rounded-full border font-bold shrink-0 ${cls}">${esc(label)}</span>
    </div>`;
  }).join('') || '<p class="px-3 py-6 text-center text-sm text-slate-400">No recipients recorded.</p>';
  document.getElementById('rem-send-preview').srcdoc = s.html
    || '<p style="font-family:sans-serif;color:#64748b;padding:1rem">Sent before the Sent history existed: only the subject and the recipients were recorded.</p>';
  openModal('modal-rem-send');
}

// Downloads a report file: CSV ("Excel") or a PDF the server draws (PDF is
// the default -- the browser no longer prints it, see report-pdf.js).
// Fetched and saved as a file rather than opened in a tab, so a refusal
// (no permission, no workshop picked) shows its message as a toast instead
// of replacing the panel with raw JSON. `extraQuery` is an already-encoded
// fragment like "&optionId=5" (the workshops report's picker).
async function downloadReport(type, format, extraQuery) {
  const fmt = format === 'csv' ? 'csv' : 'pdf';
  const url = `/api/admin/reports/${encodeURIComponent(type)}?format=${fmt}${extraQuery || ''}`;
  if (fmt === 'pdf') showToast('Preparing the PDF…', 'info');
  try {
    const res = await fetch(url);
    if (!res.ok) {
      let msg = 'Could not download the report.';
      try { msg = (await res.json()).error || msg; } catch (e) { /* not JSON */ }
      showToast(msg);
      return;
    }
    const blob = await res.blob();
    const named = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = named ? named[1] : `${type}-report.${fmt}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Kept alive a while: Safari reads the blob after click() returns.
    setTimeout(() => URL.revokeObjectURL(link.href), 60000);
  } catch (err) {
    showToast(`Download failed: ${err.message}`);
  }
}

// Render a report directly in the page (one table per section) instead of
// opening the printable/export view.
// Mobile card for one report row -- report columns vary by report type, so
// this can't hand-craft a bespoke layout per report the way the fixed-shape
// tables elsewhere do. Picks the most name-like column as a bold title and
// the most id-like column as a small mono subtitle (by column name), same
// as before. Everything else now reads as a plain flowing line (middot-
// separated, no pill backgrounds) -- a wall of gray badges for a
// column-heavy report (Registered Delegates has 9 extra fields) looked like
// noise; a quiet text line scans more like a real sentence. A value whose
// column name signals it's an amount or a status gets a touch of color
// inline instead, so the one or two things worth a glance still stand out.
function reportRowCardHtml(row, columns) {
  const titleKeys = ['Delegate', 'Name', 'Title'];
  const subKeys = ['Reg No', 'Author', 'Mobile'];
  let titleIdx = columns.findIndex((c) => titleKeys.includes(c));
  if (titleIdx === -1) titleIdx = Math.min(1, columns.length - 1);
  let subIdx = columns.findIndex((c, i) => subKeys.includes(c) && i !== titleIdx);
  if (subIdx === -1) subIdx = titleIdx === 0 ? Math.min(1, columns.length - 1) : 0;
  let restIdxs = columns.map((_, i) => i).filter((i) => i !== titleIdx && i !== subIdx);

  // Registered Delegates is the one report with enough extra fields (Age,
  // Gender, Mobile, Email, Designation, Institution, District, State,
  // Pincode) that showing all of them even as plain text got busy on a
  // phone screen. Trim it to the handful that actually help identify who
  // someone is at a glance -- designation and institute affiliation --
  // dropping demographic/contact fields the mobile card doesn't need.
  if (columns.includes('Institution') && columns.includes('Pincode')) {
    const keep = ['Designation', 'Institution', 'District', 'State', 'Payment Date'];
    restIdxs = restIdxs.filter((i) => keep.includes(columns[i]));
  }

  // Payments report: Mobile is redundant with the Reg No already shown as
  // the subtitle, and Expected Amount only matters when it *differs* from
  // Amount Paid (a mismatch worth flagging) -- for the common case where
  // they're equal it's just noise next to the amount actually paid.
  const isPayments = columns.includes('Amount Paid') && columns.includes('Expected Amount');
  let amountIdx = -1;
  let statusIdx = -1;
  if (isPayments) {
    const drop = ['Mobile', 'Expected Amount'];
    restIdxs = restIdxs.filter((i) => !drop.includes(columns[i]));
    amountIdx = columns.indexOf('Amount Paid');
    statusIdx = columns.indexOf('Status');
    restIdxs = restIdxs.filter((i) => i !== amountIdx && i !== statusIdx);
  }

  // District/State read as a location, not a fact about the person the way
  // designation/institution do -- giving them their own line separates
  // "who/where they work" from "where they're from" instead of running
  // both together in one dot-separated string.
  const locationIdxs = restIdxs.filter((i) => /^(district|state)$/i.test(columns[i] || ''));
  restIdxs = restIdxs.filter((i) => !locationIdxs.includes(i));

  const STATUS_TONE = { verified: 'text-emerald-600', accepted: 'text-emerald-600', completed: 'text-emerald-600',
    rejected: 'text-rose-600', pending: 'text-amber-600' };
  const renderPart = (i) => {
    const val = row[i];
    if (val == null || val === '') return null;
    const col = String(columns[i] || '');
    if (/status/i.test(col)) {
      const tone = STATUS_TONE[String(val).toLowerCase()] || 'text-slate-600';
      return `<span class="font-semibold ${tone}">${esc(val)}</span>`;
    }
    if (/amount|paid|credit|fee/i.test(col)) {
      return `<span class="font-semibold text-slate-700">₹${inr(esc(val))}</span>`;
    }
    return `<span>${esc(val)}</span>`;
  };
  const restParts = restIdxs.map(renderPart).filter(Boolean);
  const locationParts = locationIdxs.map(renderPart).filter(Boolean);
  const dot = ' <span class="text-slate-300">·</span> ';

  const titleBlock = `
    <div class="min-w-0">
      <p class="font-bold text-sm truncate">${esc(row[titleIdx] ?? '—')}</p>
      ${row[subIdx] != null && row[subIdx] !== '' ? `<p class="text-[11px] font-mono text-slate-400 truncate">${esc(row[subIdx])}</p>` : ''}
    </div>`;

  if (isPayments && amountIdx !== -1) {
    const STATUS_ICON = { verified: ICON('check'), accepted: ICON('check'), completed: ICON('check'), rejected: ICON('cross'), pending: ICON('clock') };
    const statusVal = statusIdx !== -1 ? row[statusIdx] : null;
    const icon = statusVal ? (STATUS_ICON[String(statusVal).toLowerCase()] || '•') : '';
    const amountVal = row[amountIdx];
    return `
      <div class="flex items-start justify-between gap-3">
        ${titleBlock}
        <div class="shrink-0 flex items-center gap-1.5">
          ${amountVal != null && amountVal !== '' ? `<span class="font-semibold text-slate-700 text-sm">₹${inr(esc(amountVal))}</span>` : ''}
          ${icon ? `<span title="${esc(statusVal)}">${icon}</span>` : ''}
        </div>
      </div>
      ${restParts.length ? `<p class="text-[12px] text-slate-500 mt-1.5 leading-relaxed">${restParts.join(dot)}</p>` : ''}
      ${locationParts.length ? `<p class="text-[12px] text-slate-400 mt-1 leading-relaxed">${locationParts.join(dot)}</p>` : ''}`;
  }

  return `
    ${titleBlock}
    ${restParts.length ? `<p class="text-[12px] text-slate-500 mt-1.5 leading-relaxed">${restParts.join(dot)}</p>` : ''}
    ${locationParts.length ? `<p class="text-[12px] text-slate-400 mt-1 leading-relaxed">${locationParts.join(dot)}</p>` : ''}`;
}

async function viewReport(type, extraQuery) {
  const box = document.getElementById('report-view-container');
  if (!box) return;
  box.classList.remove('hidden');
  box.innerHTML = '<p class="text-sm text-slate-500">Loading…</p>';
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const res = await fetch(`/api/admin/reports/${encodeURIComponent(type)}?format=json${extraQuery || ''}`);
  const data = await res.json();
  if (!data.success) { box.innerHTML = `<p class="text-sm text-rose-600">${esc(data.error || 'Could not load report.')}</p>`; return; }

  const rep = data.report;
  const totalRows = rep.sections.reduce((n, s) => n + s.rows.length, 0);

  const table = (sec, idx) => `
    <div class="report-section" data-section-idx="${idx}">
      ${sec.name ? `<h3 class="text-sm font-bold text-indigo-800 mt-4 mb-2">${esc(sec.name)} <span class="report-section-count text-slate-400 font-normal${rep.kind === 'summary' ? ' hidden' : ''}">(${sec.rows.length})</span></h3>` : ''}
      <div class="overflow-x-auto border border-slate-200 rounded-xl">
        <table class="w-full text-left border-collapse text-xs sm:min-w-[600px]">
          <thead class="hidden sm:table-header-group"><tr class="bg-slate-50 border-b border-slate-200 font-bold text-slate-500 uppercase">
            ${sec.columns.map(c => `<th class="py-2 px-3">${esc(c)}</th>`).join('')}
          </tr></thead>
          <tbody class="divide-y divide-slate-100 report-tbody">
            ${sec.rows.length ? sec.rows.map(r => `<tr class="report-row">
                <td class="py-3 px-3 block sm:hidden">${reportRowCardHtml(r, sec.columns)}</td>
                ${r.map((c) => `<td class="py-2 px-3 hidden sm:table-cell">${esc(c)}</td>`).join('')}
              </tr>`).join('')
              : `<tr class="report-empty-row"><td colspan="${sec.columns.length}" class="py-4 px-3 text-center text-slate-400">No records</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>`;

  box.innerHTML = `
    <div class="flex justify-between items-center flex-wrap gap-3">
      <div>
        <h3 class="font-bold text-slate-800">${esc(rep.title)}</h3>
        <p class="text-xs text-slate-500 mt-0.5">${rep.kind === 'summary'
          ? `Summary figures — no individual records<span id="report-total-count" class="hidden">${totalRows}</span>`
          : `Total: <span id="report-total-count" class="font-bold text-slate-700">${totalRows}</span> record${totalRows === 1 ? '' : 's'}`}<span id="report-filtered-note" class="hidden text-slate-400"> (filtered from ${totalRows})</span></p>
      </div>
      <div class="flex items-center gap-2">
        <input id="report-search-input" type="text" placeholder="Search rows…" oninput="filterReportRows()" class="p-2 border rounded-lg text-xs w-52 outline-none focus:ring-2 focus:ring-indigo-200">
        <button onclick="document.getElementById('report-view-container').classList.add('hidden')" class="text-xs text-slate-400 hover:text-slate-600 font-semibold">✕ Close</button>
      </div>
    </div>
    ${rep.sections.map(table).join('')}`;
}

// Filters every row across the currently-viewed report's sections by a
// case-insensitive substring match against the row's full text, updating
// the per-section and overall counts live as the admin types.
function filterReportRows() {
  const box = document.getElementById('report-view-container');
  if (!box) return;
  const input = document.getElementById('report-search-input');
  const q = (input.value || '').trim().toLowerCase();

  let totalVisible = 0;
  let totalAll = 0;
  box.querySelectorAll('.report-section').forEach((sectionEl) => {
    const rows = sectionEl.querySelectorAll('.report-row');
    let visibleInSection = 0;
    rows.forEach((row) => {
      const match = !q || row.textContent.toLowerCase().includes(q);
      row.classList.toggle('hidden', !match);
      if (match) visibleInSection++;
    });
    totalAll += rows.length;
    totalVisible += visibleInSection;

    const countEl = sectionEl.querySelector('.report-section-count');
    if (countEl) countEl.textContent = `(${visibleInSection})`;

    // A search hiding every row needs its own "no matches" message --
    // distinct from the server-side "No records" row, which stays as-is.
    let noMatchRow = sectionEl.querySelector('.report-nomatch-row');
    if (rows.length && visibleInSection === 0) {
      if (!noMatchRow) {
        const tbody = sectionEl.querySelector('.report-tbody');
        const cols = sectionEl.querySelectorAll('thead th').length;
        noMatchRow = document.createElement('tr');
        noMatchRow.className = 'report-nomatch-row';
        noMatchRow.innerHTML = `<td colspan="${cols}" class="py-4 px-3 text-center text-slate-400">No matching records</td>`;
        tbody.appendChild(noMatchRow);
      }
      noMatchRow.classList.remove('hidden');
    } else if (noMatchRow) {
      noMatchRow.classList.add('hidden');
    }
  });

  const totalCountEl = document.getElementById('report-total-count');
  const filteredNote = document.getElementById('report-filtered-note');
  if (totalCountEl) totalCountEl.textContent = q ? totalVisible : totalAll;
  if (filteredNote) filteredNote.classList.toggle('hidden', !q);
}

const ABSTRACT_STATUS_STYLES = {
  UNDER_REVIEW: 'bg-amber-100 text-amber-800 border-amber-300',
  ACCEPTED: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  REJECTED: 'bg-rose-100 text-rose-800 border-rose-300',
  REVISION_REQUESTED: 'bg-orange-100 text-orange-800 border-orange-300',
  PROVISIONAL: 'bg-sky-100 text-sky-800 border-sky-300',
};

// Approved, but the author has not registered: an abstract can only be
// presented by a registered delegate, so the approval is provisional until
// they do. The server works out author_registered each time, so this clears
// by itself once they register.
function abstractProvisional(a) {
  return a.status === 'ACCEPTED' && !Number(a.author_registered);
}

// Shared header markup (title, author, status badge, last-action note, file
// link) for both the Approval and Assignment cards.
function abstractCardHeader(a) {
  const status = a.status || 'UNDER_REVIEW';
  const provisional = abstractProvisional(a);
  const badge = ABSTRACT_STATUS_STYLES[provisional ? 'PROVISIONAL' : status] || 'bg-slate-100 text-slate-700 border-slate-200';
  const label = provisional ? 'ACCEPTED · PROVISIONAL' : status.replace('_', ' ');
  // Before a decision, the reviewer is told approval would be provisional.
  const registrationNote = provisional
    ? '<p class="text-[10px] text-sky-700 font-semibold mt-1">Pending registration — the author has not registered</p>'
    : (!Number(a.author_registered) && status !== 'REJECTED')
      ? '<p class="text-[10px] text-slate-500 mt-1">Author not registered — approval will be provisional</p>' : '';
  return `
      <div class="flex justify-between items-start gap-4">
        <div>
          <h4 class="font-bold text-slate-800">${esc(a.title)}</h4>
          <p class="text-xs text-slate-500 mt-0.5">${a.authors ? abstractAuthorsLineHtml(a.authors) : esc(a.author_name)} · ${esc(a.format)}</p>
          ${a.authors && !a.authors_given && status !== 'REJECTED' ? '<span class="inline-block mt-1 text-[10px] font-bold text-gold-700 bg-gold-50 border border-gold-300 rounded-full px-2 py-0.5">Co-authors not added</span>' : ''}
        </div>
        <div class="text-right shrink-0">
          <span class="${badge} text-xs px-2.5 py-1 rounded-full font-bold border whitespace-nowrap">${esc(label)}</span>
          ${status === 'REVISION_REQUESTED' ? '<p class="text-[10px] text-orange-600 mt-1">Awaiting delegate resubmission</p>' : ''}
          ${registrationNote}
          ${a.last_action_by
            ? `<p class="text-[10px] text-slate-400 mt-1">by ${esc(a.last_action_by)} · ${esc(fmtAuditTime(a.last_action_at))}</p>`
            : ''
          }
        </div>
      </div>
      <div class="mt-3">
        <button type="button" onclick="openAbstractReview(${esc(a.id)})" class="px-3 py-1.5 bg-white border border-indigo-300 text-indigo-700 hover:bg-indigo-50 font-semibold rounded-lg text-xs">Review Abstract</button>
      </div>`;
}

// Full structured read, shown inside the review modal (see
// openAbstractReview). Fields already went through sanitizeAbstractHtml()
// server-side (a four-tag allowlist), so rendered directly rather than
// through esc(), which would double-escape and show literal "&lt;b&gt;"
// instead of bold.
function abstractSectionsHtml(a) {
  const section = (label, html) => html ? `<div class="mb-2"><p class="text-[10px] font-bold text-slate-500 uppercase tracking-wide">${esc(label)}</p><p class="text-sm text-slate-700 whitespace-pre-wrap">${html}</p></div>` : '';
  const revisionNote = a.status === 'REVISION_REQUESTED' && a.revision_note
    ? `<div class="mb-3 bg-orange-50 border border-orange-200 rounded-lg p-3">
         <p class="text-[10px] font-bold text-orange-700 uppercase tracking-wide">Corrections requested — awaiting resubmission</p>
         <p class="text-sm text-orange-800 whitespace-pre-wrap mt-1">${esc(a.revision_note)}</p>
       </div>`
    : '';
  return `<div class="border-t border-slate-100 pt-3">
    ${revisionNote}
    ${section('Background', a.background)}
    ${section('Aim', a.aim)}
    ${section('Methods', a.methods)}
    ${section('Results', a.results)}
    ${section('Conclusion', a.conclusion)}
    ${a.keywords ? `<p class="text-[11px] text-slate-500"><span class="font-bold">Keywords:</span> ${esc(a.keywords)}</p>` : ''}
    <p class="text-[10px] text-slate-400 mt-1">${a.word_count ? esc(a.word_count) + ' words' : ''}</p>
  </div>`;
}

// Cards on the reviewer desk only show Title/Author/Format -- the full
// abstract (see abstractSectionsHtml) and the Approve/Reject/Reset actions
// live in this modal instead. abstractsCache is populated by the most
// recent renderBackendAbstracts() fetch so this can look the row up by id
// without a second round-trip.
let abstractsCache = [];

// Assignment formats. Submission offers only Oral and Poster; Award is
// something a reviewer assigns.
const ABSTRACT_FORMATS = { ORAL: 'Oral', POSTER: 'Poster', AWARD: 'Award' };
const abstractFormatLabel = (a) => ABSTRACT_FORMATS[a] || a || '';

function openAbstractReview(id) {
  const a = abstractsCache.find((x) => String(x.id) === String(id));
  if (!a) return;
  const titleEl = document.getElementById('abstract-review-modal-title');
  if (titleEl) titleEl.innerText = a.title || 'Abstract';
  const body = document.getElementById('abstract-review-modal-body');
  if (body) body.innerHTML = abstractAuthorsReviewHtml(a) + abstractSectionsHtml(a);
  const actions = document.getElementById('abstract-review-modal-actions');
  if (actions) actions.dataset.id = a.id;
  // Shared modal, reused per abstract -- collapse the revision note box and
  // clear any text left over from a previous open.
  const revisionBox = document.getElementById('abstract-revision-box');
  const revisionNote = document.getElementById('abstract-revision-note');
  if (revisionBox) revisionBox.classList.add('hidden');
  if (revisionNote) revisionNote.value = '';
  openModal('modal-abstract-review');
}

function downloadAbstractPdf() {
  const actions = document.getElementById('abstract-review-modal-actions');
  const id = actions && actions.dataset.id;
  if (id) window.location.href = `/api/abstracts/${encodeURIComponent(id)}/pdf`;
}

function toggleAbstractRevisionBox() {
  const box = document.getElementById('abstract-revision-box');
  if (!box) return;
  box.classList.toggle('hidden');
  if (!box.classList.contains('hidden')) document.getElementById('abstract-revision-note').focus();
}

async function submitAbstractRevisionRequest() {
  const actions = document.getElementById('abstract-review-modal-actions');
  const id = actions && actions.dataset.id;
  const note = document.getElementById('abstract-revision-note').value.trim();
  if (!note) return showToast('Enter what needs to be corrected.');
  const data = await (await fetch(`/api/abstracts/${encodeURIComponent(id)}/status`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'REVISION_REQUESTED', note }),
  })).json();
  if (!data.success) return showToast(data.error || 'Could not send this back for corrections.');
  showToast('Sent back to the delegate for corrections.', 'success');
  closeModal('modal-abstract-review');
  renderBackendAbstracts();
}

// The authors' window from GET /api/abstracts, and the "without" filter.
let abstractsAuthorsWindow = null;
let abstractsMissingAuthorsOnly = false;

// Above the lists: how many abstracts have their full author list.
function renderAbstractsAuthorsSummary(abstracts) {
  const el = document.getElementById('abstracts-authors-summary');
  if (!el) return;
  const live = abstracts.filter((a) => a.authors && a.status !== 'REJECTED');
  if (!live.length) { el.classList.add('hidden'); return; }
  const missing = live.filter((a) => !a.authors_given).length;
  if (!missing) abstractsMissingAuthorsOnly = false;
  const w = abstractsAuthorsWindow;
  const when = w && w.deadline
    ? `Delegates can change them until ${esc(formatFullDateWithDay(w.deadline))}${w.open ? '' : ' — that date has passed; only admins can now'}.`
    : 'No last date is set, so delegates can change them at any time (Conference setup).';
  el.innerHTML = `<div class="flex-1 min-w-0">
      <p class="text-sm text-slate-800"><b class="font-bold">${live.length - missing} of ${live.length}</b> abstracts have their full author list${missing ? `; <b class="font-bold">${missing}</b> still list only the submitter` : ''}.</p>
      <p class="text-xs text-slate-600 mt-0.5">${when}</p>
    </div>
    ${missing ? `<button type="button" onclick="toggleAbstractsMissingAuthors()" aria-pressed="${abstractsMissingAuthorsOnly}" class="h-9 px-3 rounded-lg text-xs font-semibold ${abstractsMissingAuthorsOnly ? 'bg-navy hover:bg-indigo-700 text-white' : 'bg-white border border-slate-300 text-navy hover:bg-slate-50'}">${abstractsMissingAuthorsOnly ? 'Show all abstracts' : `Show the ${missing} without`}</button>` : ''}`;
  el.classList.remove('hidden');
}
function toggleAbstractsMissingAuthors() {
  abstractsMissingAuthorsOnly = !abstractsMissingAuthorsOnly;
  renderBackendAbstracts();
}

// The authors, at the top of the review modal, with the way to change them.
function abstractAuthorsReviewHtml(a) {
  if (!a.authors) return '';
  const many = a.authors.length > 1;
  const note = !a.authors_given ? 'Only the submitter so far — co-authors not added yet.'
    : many ? 'Presenting author underlined.' : 'Confirmed as the only author.';
  return `<div class="mb-3 flex items-start gap-3">
    <div class="flex-1 min-w-0">
      <p class="text-[10px] font-bold text-slate-500 uppercase tracking-wide">Authors</p>
      <p class="text-sm text-slate-800 mt-0.5">${abstractAuthorsLineHtml(a.authors)}</p>
      <p class="text-[11px] ${a.authors_given ? 'text-slate-500' : 'text-gold-700 font-semibold'} mt-0.5">${note}</p>
    </div>
    ${can('abstracts.review') ? `<button type="button" onclick="openAbstractAuthors(${esc(a.id)})" class="shrink-0 px-3 py-1.5 bg-white border border-slate-300 text-navy hover:bg-slate-50 font-semibold rounded-lg text-xs">Edit authors</button>` : ''}
  </div>`;
}

async function renderBackendAbstracts() {
  const res = await fetch('/api/abstracts');
  const approvalBox = document.getElementById('abstracts-approval-container');
  const assignBox = document.getElementById('abstracts-assignment-container');
  if (!approvalBox || !assignBox) return;

  if (!res.ok) {
    approvalBox.innerHTML = `<p class="text-sm text-slate-500 p-4">Unable to load abstracts.</p>`;
    assignBox.innerHTML = '';
    return;
  }

  const data = await res.json();
  const all = data.abstracts || [];
  abstractsCache = all;
  abstractsAuthorsWindow = data.authorsWindow || null;
  renderAbstractsAuthorsSummary(all);
  // "Show the ones without": abstracts (not rejected) still listing only
  // their submitter.
  const abstracts = abstractsMissingAuthorsOnly ? all.filter((a) => a.authors && !a.authors_given && a.status !== 'REJECTED') : all;
  const underReview = all.filter(a => (a.status || 'UNDER_REVIEW') === 'UNDER_REVIEW');
  setText('badge-pending-abstracts', underReview.length);

  if (!abstracts.length) {
    approvalBox.innerHTML = `<p class="text-sm text-slate-500 p-4">${all.length ? 'Every abstract has its author list.' : 'No abstracts submitted yet.'}</p>`;
    assignBox.innerHTML = '';
    return;
  }

  // Step 1: Approval -- accept/reject/reset happens inside the review modal
  // (see openAbstractReview), not on the card itself. Still-pending ones
  // first: this list only grows over a conference, and burying "needs a
  // decision" among already-decided abstracts is exactly the wrong order
  // for the one task this step describes. Stable sort keeps each group's
  // own relative order (server's own, typically submission order).
  const approvalOrder = [...abstracts].sort((a, b) =>
    (a.status === 'UNDER_REVIEW' ? 0 : 1) - (b.status === 'UNDER_REVIEW' ? 0 : 1));
  approvalBox.innerHTML = approvalOrder.map(a => `
    <div class="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm">
      ${abstractCardHeader(a)}
    </div>
  `).join('');

  // Step 2: Assignment -- approved abstracts only, not-yet-assigned first
  // for the same reason.
  const approved = abstracts.filter(a => a.status === 'ACCEPTED')
    .sort((a, b) => (a.allocation ? 1 : 0) - (b.allocation ? 1 : 0));
  assignBox.innerHTML = approved.length ? approved.map(a => `
    <div class="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm">
      ${abstractCardHeader(a)}
      <div class="flex flex-wrap items-center gap-2 mt-4 pt-3 border-t border-slate-100">
        <span class="text-[11px] font-semibold text-slate-500">Assign format:</span>
        <button class="abstract-alloc-btn px-3 py-1.5 ${a.allocation === 'ORAL' ? 'bg-indigo-600' : 'bg-white border border-indigo-300 text-indigo-700'} ${a.allocation === 'ORAL' ? 'text-white' : ''} font-semibold rounded-lg text-xs" data-id="${esc(a.id)}" data-alloc="ORAL">Oral</button>
        <button class="abstract-alloc-btn px-3 py-1.5 ${a.allocation === 'POSTER' ? 'bg-indigo-600' : 'bg-white border border-indigo-300 text-indigo-700'} ${a.allocation === 'POSTER' ? 'text-white' : ''} font-semibold rounded-lg text-xs" data-id="${esc(a.id)}" data-alloc="POSTER">Poster</button>
        <button class="abstract-alloc-btn px-3 py-1.5 ${a.allocation === 'AWARD' ? 'bg-indigo-600' : 'bg-white border border-indigo-300 text-indigo-700'} ${a.allocation === 'AWARD' ? 'text-white' : ''} font-semibold rounded-lg text-xs" data-id="${esc(a.id)}" data-alloc="AWARD">Award</button>
        ${a.allocation ? `<span class="text-[11px] text-emerald-600 font-semibold">Assigned &amp; delegate notified: ${esc(abstractFormatLabel(a.allocation))}</span>` : `<span class="text-[11px] text-amber-600 font-semibold">Not yet assigned — delegate has not been notified</span>`}
      </div>
      ${abstractProvisional(a) ? `<p class="text-[11px] text-sky-700 mt-2">${a.allocation ? 'The delegate was told the acceptance is provisional, and that registration is mandatory to present.' : 'The email will say the acceptance is provisional, and that registration is mandatory to present.'}</p>` : ''}
    </div>
  `).join('') : `<p class="text-sm text-slate-500 p-4">No approved abstracts yet.</p>`;
}

async function updateAbstractStatus(id, status) {
  const res = await fetch(`/api/abstracts/${encodeURIComponent(id)}/status`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status })
  });
  const data = await res.json().catch(() => ({}));
  if (!data.success) showToast(data.error || 'Could not update the abstract.');
  else if (data.provisional) showToast('Approved provisionally — pending the author\'s registration. No email is sent at this step.', 'success');
  renderBackendAbstracts();
}

// Assigning a format is what emails the author their decision, so it asks
// first. Re-saving the format already assigned sends nothing, so it does not.
async function confirmAllocationEmail(id, allocation) {
  const a = abstractsCache.find((x) => String(x.id) === String(id));
  if (a && a.allocation === allocation) return true;
  const who = a && a.author_name ? a.author_name : 'the author';
  const kind = abstractFormatLabel(allocation).toLowerCase();
  const note = a && abstractProvisional(a) ? ' The email will say the acceptance is provisional until they register.' : '';
  return showConfirm(`Assign ${kind} presentation and email ${who} that their abstract is accepted for it?${note}`, 'Assign & send email');
}

async function updateAbstractAllocation(id, allocation) {
  if (!(await confirmAllocationEmail(id, allocation))) return;
  const data = await (await fetch(`/api/abstracts/${encodeURIComponent(id)}/allocation`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ allocation })
  })).json();
  if (!data.success) showToast(data.error || 'Allocation failed.');
  renderBackendAbstracts();
}

// Builds <option>s for a role picker from the live role list (see
// renderRoleOptions), so a role created in the editor is immediately
// assignable -- without this, creating a role would be a dead end, since
// nothing could ever be given it. Falls back to nothing extra if the fetch
// hasn't completed yet; the static options already in the markup cover that
// gap until it does.
function roleSelectOptionsHtml({ includeDelegate = 'none', selected = null } = {}) {
  const viewerIsSuper = isSuperAdminViewer();
  const admin = cachedRoleOptions.map((r) => {
    // Same escalation boundary the server enforces (POST /api/users, PUT
    // /api/users/:phone/role): only a Super Admin may hand out Super Admin.
    const locked = r.key === 'SUPER_ADMIN' && !viewerIsSuper;
    return `<option value="${esc(r.key)}" ${locked ? 'disabled' : ''} ${selected === r.key ? 'selected' : ''}>${esc(r.label)}</option>`;
  }).join('');
  const delegateOpt = includeDelegate !== 'none'
    ? `<option value="DELEGATE" ${selected === 'DELEGATE' ? 'selected' : ''}>Delegate</option>` : '';
  return includeDelegate === 'first' ? delegateOpt + admin : admin + delegateOpt;
}

function openCreateUserModal() {
  const roleSelect = document.getElementById('new-user-role');
  if (roleSelect && cachedRoleOptions.length) {
    roleSelect.innerHTML = roleSelectOptionsHtml({ includeDelegate: 'last' });
  } else if (roleSelect) {
    // cachedRoleOptions hasn't loaded (or this viewer can't fetch it) --
    // the static list already in the markup stands in; only the escalation
    // lock still needs applying to it.
    const superOpt = roleSelect.querySelector('option[value="SUPER_ADMIN"]');
    if (superOpt) superOpt.disabled = !isSuperAdminViewer();
  }
  openModal('modal-create-user');
}

async function handleCreateUserSubmit(e) {
  e.preventDefault();
  const password = document.getElementById('new-user-password').value;
  if (password && password.length < 8) return showToast('Password must be at least 8 characters, or leave it blank.');
  const email = document.getElementById('new-user-email').value.trim();
  if (!EMAIL_RE.test(email)) return showToast('Enter a valid email address for this user.');
  const payload = {
    name: document.getElementById('new-user-name').value,
    phone: document.getElementById('new-user-phone').value,
    email,
    designation: document.getElementById('new-user-designation').value,
    institute: document.getElementById('new-user-institute').value,
    role: document.getElementById('new-user-role').value,
    password,
  };

  // The response was previously discarded, so a rejected create (duplicate
  // number, duplicate address, bad input) closed the modal exactly as a
  // successful one did and the user simply never appeared.
  const data = await (await fetch('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })).json();
  if (!data.success) return showToast(data.error || 'Could not create this user.');

  showToast('User created.', 'success');
  closeModal('modal-create-user');
  initBackendPortal();
}

// --- REGISTER DELEGATE (admin, at the desk) -----------------------------
// See POST /api/admin/registrations. Reuses the same fee-category and
// program-group data the delegate's own payment form loads from
// /api/fees and /api/program-options, so what's offered here can never
// drift from what a self-service registration would see.
let rdCategoriesCache = [];
let rdGroupsCache = [];
let rdSelectedOptionIds = new Set();
let rdMode = 'CASH';
let rdSelectedBankTxn = null;
let rdBankLinkLater = false;
// The faculty member being registered free, opened from the Faculty tab
// (registerFacultyFree), or null. Complimentary is offered only then.
let rdFaculty = null;

async function openRegisterDelegateModal(linkAccount, faculty) {
  resetRegisterDelegateForm();
  if (linkAccount) linkRegisterDelegateAccount(linkAccount);
  if (faculty) setRegisterDelegateFaculty(faculty);
  const [feesRes, groupsRes] = await Promise.all([fetch('/api/fees'), fetch('/api/program-options')]);
  const feesData = feesRes.ok ? await feesRes.json() : {};
  rdCategoriesCache = feesData.categories || [];
  const sel = document.getElementById('rd-category');
  if (sel) {
    sel.innerHTML = '<option value="">-- Select Category --</option>' +
      rdCategoriesCache.map((c) => `<option value="${esc(c.key)}">${esc(c.label)}${c.subtitle ? ' — ' + esc(c.subtitle) : ''} — ₹${inr(Number(c.fee))}</option>`).join('');
  }
  const groupsData = groupsRes.ok ? await groupsRes.json() : {};
  rdGroupsCache = groupsData.groups || [];
  renderRegisterDelegateGroups();
  // The collector list is the front-desk staff, same source as the desk's own
  // dropdown. Loaded here rather than assumed, because this modal is also
  // reachable by a finance admin who has never opened the desk tab.
  if (!deskStaff.length) await loadDeskStaff();
  const collectorSel = document.getElementById('rd-cash-collected-by');
  if (collectorSel) {
    const me = activeAdminUser ? activeAdminUser.full_name : '';
    collectorSel.innerHTML = deskStaff.map((st) =>
      `<option value="${esc(st.key)}"${st.name === me ? ' selected' : ''}>${esc(st.name)}</option>`).join('')
      || '<option value="">No front-desk staff configured</option>';
  }
  openModal('modal-register-delegate');
}

// Register someone on the Faculty list free: the Register Delegate form,
// opened on them, with Complimentary chosen. Nothing is saved until it is
// submitted -- and whether a faculty member is complimentary is the
// organisers' decision, one person at a time.
function registerFacultyFree(id) {
  const g = guestData && guestData.guests.find((x) => x.id === id);
  if (!g) return;
  if (g.registered) return showToast(`${g.name} is already registered.`);
  closeModal('modal-guest-edit');
  openRegisterDelegateModal(null, g);
}

function setRegisterDelegateFaculty(g) {
  rdFaculty = g;
  const box = document.getElementById('rd-faculty');
  if (box) box.classList.remove('hidden');
  setText('register-delegate-heading', 'Register Faculty');
  setText('rd-faculty-name', g.name || '');
  if (g.linked) {
    // Registered on their own account, which the server insists on too.
    linkRegisterDelegateAccount({ phone_number: g.phone_number, salutation: g.salutation, full_name: g.full_name, email: g.email, phone: g.phone });
    const change = document.querySelector('#rd-linked button');
    if (change) change.classList.add('hidden');
    setText('rd-faculty-note', 'Registered on their own account.');
  } else {
    // Not signed up: their account is made from these, typed as on their
    // faculty record -- check them, and fill in what is missing.
    const digits = String(g.guest_phone || '').replace(/\D/g, '').slice(-10);
    const put = (id, v) => { const el = document.getElementById(id); if (el && v) el.value = v; };
    put('rd-phone', digits);
    put('rd-name', g.guest_name || g.name);
    put('rd-email', g.guest_email);
    put('rd-designation', g.guest_designation);
    setText('rd-faculty-note', 'Not signed up yet: an account is made from the details below and linked to their faculty entry. Check the mobile and email.');
  }
  const compBtn = document.getElementById('rd-mode-comp-btn');
  if (compBtn) compBtn.classList.toggle('hidden', !can('payments.complimentary'));
  if (can('payments.complimentary')) setRegisterDelegateMode('COMPLIMENTARY');
}

// The signed-up account a walk-in is being registered against, or null for
// someone new. Set by linkRegisterDelegateAccount().
let rdLinkedAccount = null;
let rdLinkSearchSeq = 0;

// "Already signed up?" -- people with an account and no registration yet.
async function searchRegisterDelegateSignups(query) {
  const box = document.getElementById('rd-link-results');
  if (!box) return;
  const q = String(query || '').trim();
  if (q.length < 2) { box.classList.add('hidden'); return; }
  const seq = ++rdLinkSearchSeq; // a slow reply to an older keystroke must not win
  let results = [];
  try {
    results = ((await (await fetch(`/api/desk/signups?q=${encodeURIComponent(q)}`)).json()).results) || [];
  } catch (e) { /* leave the list empty */ }
  if (seq !== rdLinkSearchSeq) return;
  rdLinkCandidates = results;
  box.innerHTML = results.length
    ? results.map((u, i) => `<button type="button" onclick="linkRegisterDelegateAccount(rdLinkCandidates[${i}])" class="w-full text-left px-3 py-2 hover:bg-indigo-50">
        <p class="font-semibold text-slate-800 text-sm">${esc([u.salutation, u.full_name].filter(Boolean).join(' ') || '—')}</p>
        <p class="text-[11px] text-slate-500">${esc(rdAccountContact(u))}${u.institution ? ' · ' + esc(u.institution) : ''}</p>
      </button>`).join('')
    : '<p class="text-xs text-slate-400 p-3">No signed-up delegate without a registration matches. Leave this blank to register someone new.</p>';
  box.classList.remove('hidden');
}
let rdLinkCandidates = [];

// Their mobile when they have one, else their email -- never the account key,
// which is synthetic for someone who signed up by email.
function rdAccountContact(u) {
  const mobile = delegateDisplayPhone(u);
  return [mobile, u.email].filter(Boolean).join(' · ');
}

// Link the walk-in to an existing account: its name, contact details and
// email are theirs already, so those fields are hidden -- and made optional,
// or the browser would refuse to submit a form with a hidden required field.
function linkRegisterDelegateAccount(account) {
  if (!account) return;
  rdLinkedAccount = account;
  document.getElementById('rd-link-results').classList.add('hidden');
  document.getElementById('rd-link-search-wrap').classList.add('hidden');
  document.getElementById('rd-link-hint').classList.add('hidden');
  document.getElementById('rd-linked').classList.remove('hidden');
  setText('rd-linked-name', [account.salutation, account.full_name].filter(Boolean).join(' ') || '—');
  setText('rd-linked-contact', rdAccountContact(account));
  for (const id of ['rd-phone-wrap', 'rd-name-fields']) document.getElementById(id).classList.add('hidden');
  for (const id of ['rd-phone', 'rd-name']) document.getElementById(id).required = false;
  refreshRegisterDelegateQuote();
}

function unlinkRegisterDelegateAccount() {
  rdLinkedAccount = null;
  const search = document.getElementById('rd-link-search');
  if (search) search.value = '';
  for (const id of ['rd-link-search-wrap', 'rd-link-hint', 'rd-phone-wrap', 'rd-name-fields']) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('hidden');
  }
  const linked = document.getElementById('rd-linked');
  if (linked) linked.classList.add('hidden');
  for (const id of ['rd-phone', 'rd-name']) {
    const el = document.getElementById(id);
    if (el) el.required = true;
  }
  // Their personal code was theirs, not the next walk-in's.
  if (rdPromoAuto) {
    const promo = document.getElementById('rd-discount-code');
    if (promo) promo.value = '';
    rdPromoAuto = false;
  }
  rdQuote = null;
  const note = document.getElementById('rd-discount-note');
  if (note) note.className = 'hidden';
}

function resetRegisterDelegateForm() {
  unlinkRegisterDelegateAccount();
  rdFaculty = null;
  const facultyBox = document.getElementById('rd-faculty');
  if (facultyBox) facultyBox.classList.add('hidden');
  const compBtn = document.getElementById('rd-mode-comp-btn');
  if (compBtn) compBtn.classList.add('hidden');
  const change = document.querySelector('#rd-linked button');
  if (change) change.classList.remove('hidden');
  setText('register-delegate-heading', 'Register Delegate');
  const form = document.getElementById('register-delegate-form');
  const result = document.getElementById('register-delegate-result');
  if (form) { form.reset(); form.classList.remove('hidden'); }
  if (result) result.classList.add('hidden');
  rdSelectedOptionIds = new Set();
  rdSelectedBankTxn = null;
  setRegisterDelegateBankLinkLater(false);
  setRegisterDelegateMode('CASH');
  const linklaterAmount = document.getElementById('rd-bank-linklater-amount');
  if (linklaterAmount) linklaterAmount.value = '';
  const linklaterRef = document.getElementById('rd-bank-linklater-ref');
  if (linklaterRef) linklaterRef.value = '';
  const idWrap = document.getElementById('rd-idverify-wrap');
  if (idWrap) idWrap.classList.add('hidden');
  const idCheckbox = document.getElementById('rd-idverify-checkbox');
  if (idCheckbox) idCheckbox.checked = false;
  const partialNote = document.getElementById('rd-partial-note');
  if (partialNote) partialNote.classList.add('hidden');
  setText('rd-fee-display', '₹0');
  const submitBtn = document.getElementById('rd-submit-btn');
  if (submitBtn) submitBtn.disabled = false;
}

function onRegisterDelegateCategoryChange() {
  const key = document.getElementById('rd-category').value;
  const cat = rdCategoriesCache.find((c) => c.key === key);
  const idWrap = document.getElementById('rd-idverify-wrap');
  if (idWrap) idWrap.classList.toggle('hidden', !(cat && cat.requiresStudentId));
  updateRegisterDelegateFee();
  refreshRegisterDelegateQuote();
}

// One block per active program group, same single-select-vs-checkbox split
// as the delegate's own loadProgramOptions() -- see there for why.
function renderRegisterDelegateGroups() {
  const box = document.getElementById('rd-program-groups');
  if (!box) return;
  box.innerHTML = rdGroupsCache.map((g) => {
    const label = `${esc(g.name)}${g.required ? ' <span class="text-rose-500">*</span>' : ' <span class="font-normal text-slate-400">(optional)</span>'}`;
    if (g.maxSelect <= 1) {
      return `<div>
        <label class="block text-xs font-semibold text-slate-700 mb-1">${label}</label>
        <select class="rd-group-select w-full p-2.5 text-sm border rounded-lg bg-white outline-none" data-group-id="${g.id}" data-group-name="${esc(g.name)}" data-required="${g.required ? '1' : '0'}" onchange="updateRegisterDelegateFee()">
          <option value="">-- Choose${g.required ? '' : ' (optional)'} --</option>
          ${g.options.map((o) => `<option value="${o.id}" ${o.full ? 'disabled' : ''}>${esc(o.name)}${o.full ? ' — FULL' : ` (${o.remaining} left)`}${o.fee > 0 ? ` — +₹${inr(o.fee)}` : ''}</option>`).join('')}
        </select>
      </div>`;
    }
    return `<div>
      <label class="block text-xs font-semibold text-slate-700 mb-1">${label} <span class="font-normal text-slate-400">(choose up to ${g.maxSelect})</span></label>
      <div class="space-y-1">
        ${g.options.map((o) => `<label class="flex items-center gap-2 text-sm ${o.full ? 'text-slate-400' : 'text-slate-700'}">
          <input type="checkbox" class="rd-group-checkbox" data-group-id="${g.id}" value="${o.id}" ${o.full ? 'disabled' : ''} onchange="updateRegisterDelegateFee()">
          ${esc(o.name)}${o.full ? ' — FULL' : ` (${o.remaining} left)`}${o.fee > 0 ? ` — +₹${inr(o.fee)}` : ''}
        </label>`).join('')}
      </div>
    </div>`;
  }).join('');
}

function collectRegisterDelegateOptionIds() {
  const ids = [];
  document.querySelectorAll('#rd-program-groups .rd-group-select').forEach((sel) => { if (sel.value) ids.push(Number(sel.value)); });
  document.querySelectorAll('#rd-program-groups .rd-group-checkbox:checked').forEach((cb) => ids.push(Number(cb.value)));
  return ids;
}

// Fee shown here is category + option fees only -- a promo code's actual
// discount is only known once the server validates it, so this is a
// pre-discount estimate the admin can still act on (default cash amount,
// bank-credit search target); the real figure comes back in the response
// after submit.
// The walk-in's discount, priced by the server (POST /api/desk/quote) with the
// same rules the registration will apply: { categoryKey, discountAmount, code,
// auto }. Without it the fee shown -- and the cash pre-filled -- ignored any
// code, while the registration recorded the discounted fee.
let rdQuote = null;
let rdQuoteSeq = 0;
let rdPromoAuto = false; // the code field was filled in for them, not typed
let rdPromoTimer = null;

async function refreshRegisterDelegateQuote() {
  const categoryKey = document.getElementById('rd-category').value;
  const promoInput = document.getElementById('rd-discount-code');
  const note = document.getElementById('rd-discount-note');
  const seq = ++rdQuoteSeq;
  if (!categoryKey) { rdQuote = null; if (note) note.classList.add('hidden'); updateRegisterDelegateFee(); return; }
  const typed = rdPromoAuto ? '' : (promoInput ? promoInput.value.trim() : '');
  let data = null;
  try {
    data = await (await fetch('/api/desk/quote', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        categoryKey, discountCode: typed,
        accountKey: rdLinkedAccount ? rdLinkedAccount.phone_number : undefined,
        phone: rdLinkedAccount ? undefined : document.getElementById('rd-phone').value.trim(),
      }),
    })).json();
  } catch (e) { data = null; }
  if (seq !== rdQuoteSeq) return; // an older answer arriving late
  rdQuote = data && data.success ? { categoryKey, discountAmount: data.discountAmount || 0, code: data.code, auto: !!data.auto } : null;
  // Their own personal code goes in the field, so it is what gets submitted.
  if (rdQuote && rdQuote.auto && promoInput && (!promoInput.value.trim() || rdPromoAuto)) {
    promoInput.value = rdQuote.code;
    rdPromoAuto = true;
  }
  if (note) {
    const off = rdQuote ? rdQuote.discountAmount : 0;
    if (data && data.error) {
      note.textContent = data.error;
      note.className = 'text-[11px] font-semibold text-rose-600';
    } else if (off > 0) {
      note.textContent = rdQuote.code === 'GROUP' ? `Group discount applied — ₹${inr(off)} off.`
        : rdQuote.auto ? `Their personal code ${rdQuote.code} is applied automatically — ₹${inr(off)} off.`
          : `Code ${rdQuote.code} applied — ₹${inr(off)} off.`;
      note.className = 'text-[11px] font-semibold text-emerald-700';
    } else {
      note.textContent = '';
      note.className = 'hidden';
    }
  }
  updateRegisterDelegateFee();
}

function onRegisterDelegatePromoInput() {
  // Typing replaces a code that was filled in for them.
  rdPromoAuto = false;
  clearTimeout(rdPromoTimer);
  rdPromoTimer = setTimeout(refreshRegisterDelegateQuote, 400);
}

function updateRegisterDelegateFee() {
  const key = document.getElementById('rd-category').value;
  const cat = rdCategoriesCache.find((c) => c.key === key);
  const base = cat ? Number(cat.fee) || 0 : 0;
  const optionsFee = collectRegisterDelegateOptionIds().reduce((sum, id) => {
    const opt = rdGroupsCache.flatMap((g) => g.options).find((o) => o.id === id);
    return sum + (opt ? Number(opt.fee) || 0 : 0);
  }, 0);
  const discount = rdQuote && rdQuote.categoryKey === key ? rdQuote.discountAmount : 0;
  // Complimentary: nothing is due; what is waived is said instead.
  if (rdMode === 'COMPLIMENTARY') {
    setText('rd-fee-display', '₹0');
    setText('rd-comp-waived', key ? `₹${inr(base + optionsFee)} waived${optionsFee ? ' (category and workshops)' : ''}.` : 'Choose their category.');
    return 0;
  }
  const total = Math.max(0, base - discount) + optionsFee;
  setText('rd-fee-display', `₹${inr(total)}`);
  const cashInput = document.getElementById('rd-cash-amount');
  if (cashInput && (cashInput.value === '' || Number(cashInput.dataset.auto) === 1)) {
    cashInput.value = total;
    cashInput.dataset.auto = '1';
  }
  // Partial-payment warning: cash only, and only once something's actually
  // been entered -- an empty/zero field isn't "less than the fee due" in
  // any useful sense, just not filled in yet.
  const partialNote = document.getElementById('rd-partial-note');
  if (partialNote) {
    const cashVal = Number(cashInput && cashInput.value) || 0;
    partialNote.classList.toggle('hidden', !(rdMode === 'CASH' && cashVal > 0 && cashVal < total));
  }
  if (rdMode === 'BANK_TRANSFER') loadRegisterDelegateBankCandidates(total);
  return total;
}

// The admin typing their own amount (a deliberate partial payment, say) --
// stop the auto-fill in updateRegisterDelegateFee() from silently
// overwriting it back to the full fee the next time a category or program
// option changes, and refresh the partial-due note against what they just
// typed.
function onRegisterDelegateCashInput() {
  const cashInput = document.getElementById('rd-cash-amount');
  if (cashInput) delete cashInput.dataset.auto;
  updateRegisterDelegateFee();
}

function setRegisterDelegateMode(mode) {
  rdMode = mode;
  const cashBtn = document.getElementById('rd-mode-cash-btn');
  const bankBtn = document.getElementById('rd-mode-bank-btn');
  const compBtn = document.getElementById('rd-mode-comp-btn');
  const cashBox = document.getElementById('rd-mode-cash');
  const bankBox = document.getElementById('rd-mode-bank');
  const compBox = document.getElementById('rd-mode-comp');
  const isCash = mode === 'CASH';
  const isComp = mode === 'COMPLIMENTARY';
  const tab = (on) => `flex-1 py-2 rounded-md ${on ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500'}`;
  if (cashBtn) cashBtn.className = tab(isCash);
  if (bankBtn) bankBtn.className = tab(!isCash && !isComp);
  if (compBtn) compBtn.className = `${tab(isComp)}${rdFaculty && can('payments.complimentary') ? '' : ' hidden'}`;
  if (cashBox) cashBox.classList.toggle('hidden', !isCash);
  if (bankBox) bankBox.classList.toggle('hidden', isCash || isComp);
  if (compBox) compBox.classList.toggle('hidden', !isComp);
  // A promo code means nothing when the whole fee is waived.
  const promo = document.getElementById('rd-promo-wrap');
  if (promo) promo.classList.toggle('hidden', isComp);
  if (isComp) {
    const partialNote = document.getElementById('rd-partial-note');
    if (partialNote) partialNote.classList.add('hidden');
    setRegisterDelegateBankLinkLater(false);
    updateRegisterDelegateFee();
    return;
  }
  // Either direction needs a fresh updateRegisterDelegateFee() call: bank
  // mode uses its return value to load candidates near that amount, and
  // cash mode needs it to re-evaluate the partial-due note (hidden in bank
  // mode, so switching away can leave it stale otherwise).
  if (isCash) { setRegisterDelegateBankLinkLater(false); updateRegisterDelegateFee(); }
  else loadRegisterDelegateBankCandidates(updateRegisterDelegateFee());
}

// Bank Transfer has two sub-modes: pick a credit already in the imported
// statement (default), or defer that link because the delegate's transaction
// hasn't shown up yet -- see linkLater in POST /api/admin/registrations.
function setRegisterDelegateBankLinkLater(later) {
  rdBankLinkLater = later;
  const linkNowSection = document.getElementById('rd-bank-linknow-section');
  const linkLaterSection = document.getElementById('rd-bank-linklater-section');
  const toggle = document.getElementById('rd-bank-linklater-toggle');
  if (linkNowSection) linkNowSection.classList.toggle('hidden', later);
  if (linkLaterSection) linkLaterSection.classList.toggle('hidden', !later);
  if (toggle) toggle.classList.toggle('hidden', later);
}

async function loadRegisterDelegateBankCandidates(targetAmount) {
  const box = document.getElementById('rd-bank-candidates');
  if (!box) return;
  box.innerHTML = '<p class="text-[11px] text-slate-400 p-2">Loading…</p>';
  const res = await fetch(`/api/admin/bank-credit-candidates?amount=${encodeURIComponent(targetAmount || 0)}`);
  const rows = res.ok ? (await res.json()).transactions || [] : [];
  box.innerHTML = rows.length ? rows.map((t) => `
    <div class="flex items-center justify-between gap-2 p-2 text-[11px]">
      <div class="min-w-0"><p class="font-semibold text-slate-700">${esc(t.post_date)} · ₹${inr(t.remaining)}${t.remaining !== t.credit ? ` of ₹${inr(t.credit)}` : ''} available</p><p class="text-slate-500 truncate">${esc(t.description)}</p></div>
      <button type="button" class="shrink-0 px-2 py-1 bg-navy hover:bg-indigo-700 text-white font-semibold rounded" onclick='selectRegisterDelegateBankTxn(${JSON.stringify(t).replace(/'/g, "&#39;")})'>Select</button>
    </div>`).join('') : '<p class="text-[11px] text-slate-400 p-2">No unclaimed credits in the statement.</p>';
}

function selectRegisterDelegateBankTxn(txn) {
  rdSelectedBankTxn = txn;
  const box = document.getElementById('rd-bank-selected');
  if (box) {
    box.classList.remove('hidden');
    box.innerHTML = `Selected: ${esc(txn.post_date)} · ₹${inr(txn.remaining)} available <button type="button" onclick="rdSelectedBankTxn=null;document.getElementById('rd-bank-selected').classList.add('hidden')" class="ml-2 text-rose-600 hover:underline font-semibold">Change</button>`;
  }
}

async function handleRegisterDelegateSubmit(e) {
  e.preventDefault();
  const phone = document.getElementById('rd-phone').value.trim();
  if (!rdLinkedAccount && !isPhoneValue(phone)) return showToast('Enter a valid mobile number.');
  const categoryKey = document.getElementById('rd-category').value;
  if (!categoryKey) return showToast('Select a delegate category.');
  const cat = rdCategoriesCache.find((c) => c.key === categoryKey);
  if (cat && cat.requiresStudentId && !document.getElementById('rd-idverify-checkbox').checked) {
    return showToast('Confirm the student ID card before continuing.');
  }

  const payload = rdLinkedAccount ? { accountKey: rdLinkedAccount.phone_number } : {
    phone,
    name: document.getElementById('rd-name').value.trim(),
    designation: document.getElementById('rd-designation').value.trim(),
    institute: document.getElementById('rd-institute').value.trim(),
    email: document.getElementById('rd-email').value.trim(),
  };
  const comp = rdMode === 'COMPLIMENTARY';
  if (comp && !rdFaculty) return showToast('Complimentary is only for someone on the Faculty list.');
  Object.assign(payload, {
    categoryKey,
    optionIds: collectRegisterDelegateOptionIds(),
    discountCode: comp ? '' : document.getElementById('rd-discount-code').value.trim(),
    idVerifiedByAdmin: cat && cat.requiresStudentId ? true : undefined,
    paymentMode: rdMode,
  });
  if (comp) {
    payload.guestId = rdFaculty.id;
  } else if (rdMode === 'CASH') {
    payload.amount = Number(document.getElementById('rd-cash-amount').value);
    payload.collectedBy = document.getElementById('rd-cash-collected-by').value;
    if (!payload.collectedBy) return showToast('Record who collected the cash.');
  } else if (rdBankLinkLater) {
    payload.linkLater = true;
    payload.amount = Number(document.getElementById('rd-bank-linklater-amount').value);
    payload.utrNumber = document.getElementById('rd-bank-linklater-ref').value.trim();
    if (!Number.isFinite(payload.amount) || payload.amount <= 0) return showToast('Enter the amount this delegate claims to have paid.');
  } else {
    if (!rdSelectedBankTxn) return showToast('Select the bank credit this delegate already paid.');
    payload.bankTxnId = rdSelectedBankTxn.id;
  }

  const submitBtn = document.getElementById('rd-submit-btn');
  if (submitBtn) submitBtn.disabled = true;
  try {
    const data = await (await fetch(comp ? '/api/admin/registrations/complimentary' : '/api/admin/registrations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })).json();
    if (!data.success) { showToast(data.error || 'Could not register this delegate.'); return; }

    document.getElementById('register-delegate-form').classList.add('hidden');
    const result = document.getElementById('register-delegate-result');
    if (result) result.classList.remove('hidden');
    setText('rd-result-regno', `Registration No. ${data.registrationNumber}`);
    const banner = document.getElementById('rd-result-banner');
    const isPending = data.bankStatus === 'PENDING';
    if (banner) banner.className = `rounded-xl p-4 text-center ${isPending ? 'bg-amber-50 border border-amber-200' : 'bg-emerald-50 border border-emerald-200'}`;
    const resultIcon = document.getElementById('rd-result-icon');
    if (resultIcon) resultIcon.innerHTML = ICON(isPending ? 'clock' : 'check', 'w-9 h-9');
    const heading = document.getElementById('rd-result-heading');
    if (heading) heading.className = `font-bold mt-1 ${isPending ? 'text-amber-800' : 'text-emerald-800'}`;
    setText('rd-result-heading', isPending ? 'Registered — payment pending bank-statement linkage' : comp ? 'Registration confirmed — complimentary' : 'Registration confirmed');
    const balance = Math.max(0, Number(data.expectedAmount) - Number(data.paidAmount));
    setText('rd-result-amount', comp
      ? `Faculty · ₹${inr(data.waivedAmount || 0)} waived, nothing to pay`
      : isPending
      ? `₹${inr(data.paidAmount)} claimed — an admin will link it to the bank statement later`
      : balance > 0
        ? `₹${inr(data.paidAmount)} of ₹${inr(data.expectedAmount)} recorded · ₹${inr(balance)} balance due`
        : `₹${inr(data.paidAmount)} recorded — fully paid`);
    const pwBox = document.getElementById('rd-result-password-box');
    if (data.tempPassword) {
      if (pwBox) pwBox.classList.remove('hidden');
      setText('rd-result-password', data.tempPassword);
    } else if (pwBox) {
      pwBox.classList.add('hidden');
    }
    renderBackendPayments();
    if (comp && typeof renderGuests === 'function' && guestData) renderGuests();
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

// "Masters" groups Workshops & QI / Fees / Users under one nav entry with an
// inner sub-nav; the wrapper is shown whenever one of those sub-tabs is
// active, and remembers the last one visited so the top-level Masters button
// can jump back into it.
// Activity Log shows one category at a time, picked from its own submenu
// (separate from the main Masters sub-tabs above).
const ACTIVITY_SUBTABS = ['imports', 'mapping', 'approval', 'abstract-approval', 'abstract-allotment', 'master', 'login', 'sms', 'email'];
function switchActivityLog(tab) {
  ACTIVITY_SUBTABS.forEach((t) => {
    const panel = document.getElementById(`activity-panel-${t}`);
    if (panel) panel.classList.toggle('hidden', t !== tab);
    const btn = document.getElementById(`activity-subnav-${t}`);
    if (btn) {
      const active = t === tab;
      btn.classList.toggle('bg-indigo-600', active);
      btn.classList.toggle('text-white', active);
      btn.classList.toggle('bg-slate-100', !active);
      btn.classList.toggle('text-slate-600', !active);
      const badge = document.getElementById(`activity-count-${t}`);
      if (badge) {
        badge.classList.toggle('bg-white/20', active);
        badge.classList.toggle('bg-slate-200', !active);
      }
    }
  });
}

// The admin bar's menus (views/admin/partials/header.ejs). From 1200px,
// Settings and the account are drop-downs, each opened by its button; below
// it, everything is one panel, #admin-menu, opened by ☰. Each opens by the
// "open" class, and its button says so in aria-expanded.
const ADMIN_MENUS = [['settings-menu', 'settings-menu-btn'], ['admin-me-menu', 'admin-me-btn'], ['admin-menu', 'admin-menu-btn']];
function setAdminMenu(menuId, open) {
  const pair = ADMIN_MENUS.find(([m]) => m === menuId);
  const menu = document.getElementById(menuId);
  if (menu) menu.classList.toggle('open', open);
  const btn = pair && document.getElementById(pair[1]);
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}
function toggleAdminMenuById(menuId) {
  const menu = document.getElementById(menuId);
  const open = !(menu && menu.classList.contains('open'));
  // One open at a time: the drop-downs, or the one panel.
  ADMIN_MENUS.forEach(([m]) => { if (m !== menuId) setAdminMenu(m, false); });
  setAdminMenu(menuId, open);
}
function closeAdminMenus() { ADMIN_MENUS.forEach(([m]) => setAdminMenu(m, false)); }
function toggleSettingsMenu(forceHide) {
  if (forceHide === true) return setAdminMenu('settings-menu', false);
  toggleAdminMenuById('settings-menu');
}
function toggleAdminMeMenu() { toggleAdminMenuById('admin-me-menu'); }
function toggleAdminMenu() { toggleAdminMenuById('admin-menu'); }
function selectSettingsTab(tab) {
  switchBackendTab(tab);
  closeAdminMenus();
}
document.addEventListener('click', (e) => {
  ADMIN_MENUS.forEach(([m, b]) => {
    const menu = document.getElementById(m);
    const btn = document.getElementById(b);
    if (!menu || !menu.classList.contains('open')) return;
    if (menu.contains(e.target) || (btn && btn.contains(e.target))) return;
    // The panel holds the drop-downs; a click inside it is not outside them.
    const panel = document.getElementById('admin-menu');
    if (m !== 'admin-menu' && panel && panel.classList.contains('open') && panel.contains(e.target)) return;
    setAdminMenu(m, false);
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  ADMIN_MENUS.forEach(([m, b]) => {
    const menu = document.getElementById(m);
    if (!menu || !menu.classList.contains('open')) return;
    setAdminMenu(m, false);
    const btn = document.getElementById(b);
    if (btn && btn.focus) btn.focus();
  });
});

// Settings sub-menu tabs (each is now its own top-level <section>) vs. the
// main nav-bar tabs. The Settings items highlight in the dropdown; the main
// tabs highlight in the tab bar.
// --- FRONT DESK -----------------------------------------------------------
//
// The one admin screen that starts from a person instead of a queue. See
// views/admin/sections/desk.ejs for why, and the desk block in
// permissions.js for how it stays narrow.

// The delegate currently on screen, and the front-desk staff list that backs
// every "collected by" dropdown. Both are per-session state, not per-render.
let deskDelegate = null;
let deskStaff = [];
let deskProgrammeGroups = [];

async function initFrontDesk() {
  const box = document.getElementById('section-desk');
  if (!box) return;
  // Loaded once per visit rather than per render: the staff list changes when
  // somebody is given a role, not while a delegate is being served.
  // ensureReviewCategories warms isStudentCategory(), which the payment card's
  // ID chip reads -- without it every category looks like it needs no student
  // ID, which is the wrong answer given confidently.
  await Promise.all([ensureReviewCategories(), loadDeskStaff(), loadDeskProgrammes(), refreshDeskCash()]);
  const registerBtn = document.getElementById('desk-register-btn');
  if (registerBtn) registerBtn.classList.toggle('hidden', !can('payments.desk_register'));
  const search = document.getElementById('desk-search');
  if (search) search.focus();
}

async function loadDeskStaff() {
  try {
    const data = await (await fetch('/api/desk/staff')).json();
    deskStaff = data.success ? (data.staff || []) : [];
  } catch (e) { deskStaff = []; }
}

async function loadDeskProgrammes() {
  try {
    const data = await (await fetch('/api/desk/programmes')).json();
    deskProgrammeGroups = data.success ? (data.groups || []) : [];
  } catch (e) { deskProgrammeGroups = []; }
}

// What this collector is holding and has not yet banked. Shown in the header
// because it is the number they count against at hand-over, and because a
// figure nobody can see is a figure nobody reconciles.
async function refreshDeskCash() {
  const el = document.getElementById('desk-cash-summary');
  if (!el) return;
  try {
    const data = await (await fetch('/api/desk/cash-in-hand')).json();
    if (!data.success) return el.textContent = '';
    el.textContent = data.count
      ? `Cash in hand: ₹${inr(data.total)} across ${data.count} payment${data.count === 1 ? '' : 's'}`
      : 'No cash collected yet';
  } catch (e) { el.textContent = ''; }
}

// The "collected by" control. Pre-selects the signed-in user because that is
// who it usually is, but stays changeable because at a shared desk it often
// is not -- which is the entire reason the field exists separately from
// reviewed_by (see resolveCashCollector in server.js).
function deskCollectorSelect(id) {
  const me = activeAdminUser ? activeAdminUser.full_name : '';
  const options = deskStaff.map((s) =>
    `<option value="${esc(s.key)}"${s.name === me ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
  return `<select id="${esc(id)}" class="w-full p-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-200">${options}</select>`;
}

// --- desk type-ahead ------------------------------------------------------
//
// At a counter the delegate is standing there while you type, so the search
// has to offer people as you go rather than making you commit, wait, and read
// an error. Three things this has to get right beyond "fetch on keyup":
//
//   * Debounced, so a name is one request rather than one per letter.
//   * Race-safe. Responses can arrive out of order, and the slow one for "As"
//     landing after the fast one for "Ashwin" would replace a correct list
//     with a stale one. Each request carries a sequence number and anything
//     but the newest is discarded.
//   * Keyboard-first. Arrow keys move, Enter picks, Escape dismisses -- a
//     desk should never have to reach for the mouse mid-queue.
let deskSuggestSeq = 0;
let deskSuggestTimer = null;
let deskSuggestions = [];
let deskSuggestActive = -1;

function deskSuggest() {
  clearTimeout(deskSuggestTimer);
  const q = (document.getElementById('desk-search').value || '').trim();
  // Under two characters there is nothing worth showing: one letter matches a
  // large share of the conference, and the server declines it anyway.
  if (q.length < 2) return deskSuggestClose();
  deskSuggestTimer = setTimeout(() => deskSuggestFetch(q), 180);
}

async function deskSuggestFetch(q) {
  const seq = ++deskSuggestSeq;
  try {
    const data = await (await fetch(`/api/desk/search?q=${encodeURIComponent(q)}`)).json();
    // A response from a keystroke the user has already typed past.
    if (seq !== deskSuggestSeq) return;
    deskSuggestions = data.success ? (data.results || []) : [];
    deskSuggestActive = -1;
    deskSuggestRender();
  } catch (e) {
    if (seq === deskSuggestSeq) deskSuggestClose();
  }
}

function deskSuggestRender() {
  const box = document.getElementById('desk-suggestions');
  const input = document.getElementById('desk-search');
  if (!deskSuggestions.length) {
    // Said out loud rather than silently showing nothing, so the desk knows
    // the search ran and this person is genuinely not on file -- which is the
    // cue to register them as a walk-in.
    box.innerHTML = '<li class="px-3 py-2.5 text-xs text-slate-400">Nobody matching — register them as a walk-in.</li>';
    box.classList.remove('hidden');
    input.setAttribute('aria-expanded', 'true');
    return;
  }
  box.innerHTML = deskSuggestions.map((s, i) => `
    <li role="option" id="desk-suggestion-${i}" aria-selected="${i === deskSuggestActive}"
        onmousedown="event.preventDefault();deskSuggestPick(${i})"
        onmouseenter="deskSuggestHighlight(${i})"
        class="px-3 py-2 cursor-pointer flex items-center justify-between gap-3 ${i === deskSuggestActive ? 'bg-indigo-50' : 'hover:bg-slate-50'}">
      <span class="min-w-0">
        <span class="block text-sm font-semibold text-slate-800 truncate">${esc(s.full_name || '—')}</span>
        <span class="block text-[11px] text-slate-500 truncate">${esc(s.category_label || 'Not registered')}</span>
      </span>
      <span class="shrink-0 text-right">
        <span class="block text-[11px] font-mono text-slate-400">${esc(s.registration_number || s.phone_number)}</span>
        ${s.checked_in ? '<span class="text-[10px] font-bold text-emerald-700">arrived</span>' : ''}
      </span>
    </li>`).join('');
  box.classList.remove('hidden');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-activedescendant', deskSuggestActive >= 0 ? `desk-suggestion-${deskSuggestActive}` : '');
}

function deskSuggestHighlight(i) {
  deskSuggestActive = i;
  deskSuggestRender();
}

function deskSuggestClose() {
  const box = document.getElementById('desk-suggestions');
  const input = document.getElementById('desk-search');
  if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
  if (input) { input.setAttribute('aria-expanded', 'false'); input.setAttribute('aria-activedescendant', ''); }
  deskSuggestions = [];
  deskSuggestActive = -1;
}

// mousedown on a suggestion is preventDefault-ed above so this never fires
// before the click lands -- otherwise the list would close out from under the
// pointer and the click would hit whatever was underneath.
function deskSuggestBlur() {
  setTimeout(deskSuggestClose, 120);
}

function deskSuggestKey(event) {
  const open = deskSuggestions.length > 0
    && !document.getElementById('desk-suggestions').classList.contains('hidden');
  if (event.key === 'Escape') return deskSuggestClose();
  if (!open) return;
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    deskSuggestActive = (deskSuggestActive + 1) % deskSuggestions.length;
    return deskSuggestRender();
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    deskSuggestActive = (deskSuggestActive - 1 + deskSuggestions.length) % deskSuggestions.length;
    return deskSuggestRender();
  }
  if (event.key === 'Enter' && deskSuggestActive >= 0) {
    // Only when something is actually highlighted. Enter with no selection
    // still submits the form, so typing a full number and pressing enter
    // works exactly as it did before there were suggestions.
    event.preventDefault();
    deskSuggestPick(deskSuggestActive);
  }
}

async function deskSuggestPick(i) {
  const picked = deskSuggestions[i];
  if (!picked) return;
  // The phone number is the account key, so resolving by it is exact -- the
  // name that was typed might still be ambiguous.
  document.getElementById('desk-search').value = picked.phone_number;
  deskSuggestClose();
  await deskLookup();
}

async function deskLookup(event) {
  if (event) event.preventDefault();
  // Whatever route got us here -- typing and pressing enter, or picking a
  // suggestion -- the list has served its purpose.
  deskSuggestClose();
  const input = document.getElementById('desk-search');
  const err = document.getElementById('desk-search-error');
  const candidates = document.getElementById('desk-candidates');
  const empty = document.getElementById('desk-empty');
  const record = document.getElementById('desk-record');
  const q = (input.value || '').trim();
  if (!q) return;

  err.classList.add('hidden');
  candidates.classList.add('hidden');
  try {
    const data = await (await fetch(`/api/desk/delegate/${encodeURIComponent(q)}`)).json();
    if (!data.success) {
      err.textContent = data.error || 'Could not look that up.';
      err.classList.remove('hidden');
      record.classList.add('hidden');
      empty.classList.remove('hidden');
      return;
    }
    if (data.candidates) {
      renderDeskCandidates(data.candidates);
      record.classList.add('hidden');
      empty.classList.add('hidden');
      return;
    }
    deskDelegate = data;
    renderDeskRecord();
  } catch (e) {
    err.textContent = 'Could not reach the server.';
    err.classList.remove('hidden');
  }
}

function renderDeskCandidates(list) {
  const box = document.getElementById('desk-candidates');
  document.getElementById('desk-candidate-list').innerHTML = list.map((c) => `
    <button type="button" onclick="deskPick('${esc(c.phone_number)}')"
            class="w-full text-left p-3 border border-slate-200 rounded-xl hover:bg-slate-50 flex items-center justify-between gap-3">
      <span class="min-w-0">
        <span class="block font-bold text-sm text-slate-800 truncate">${esc(c.full_name || '—')}</span>
        <span class="block text-[11px] text-slate-500 truncate">${esc(c.category_label || 'Not registered')}</span>
      </span>
      <span class="text-[11px] font-mono text-slate-400 shrink-0">${esc(c.registration_number || c.phone_number)}</span>
    </button>`).join('');
  box.classList.remove('hidden');
}

async function deskPick(phone) {
  document.getElementById('desk-search').value = phone;
  await deskLookup();
}

// One card per question the desk gets asked. Order is the order a delegate
// raises them: who am I, what do I owe, am I cleared, what did I pick, what
// happened to my abstract, am I checked in.
function renderDeskRecord() {
  const box = document.getElementById('desk-record');
  const empty = document.getElementById('desk-empty');
  if (!deskDelegate) return;
  const { user, registration: reg, payment, selections, abstracts, checkedIn, abstractWindow, abstractExtension, guest } = deskDelegate;

  box.innerHTML = [
    deskWhoCard(user, reg, checkedIn, guest),
    deskFacultyCard(guest),
    reg ? deskMoneyCard(reg, payment) : deskNoRegistrationCard(),
    reg ? deskProgrammeCard(selections) : '',
    deskAbstractCard(abstracts, abstractWindow, abstractExtension),
  ].filter(Boolean).join('');
  box.classList.remove('hidden');
  empty.classList.add('hidden');
  document.getElementById('desk-candidates').classList.add('hidden');
}

function deskCard(title, bodyHtml, actionsHtml) {
  return `<div class="bg-white p-4 sm:p-5 rounded-2xl shadow-card">
    <div class="flex items-baseline justify-between gap-3 flex-wrap mb-3">
      <h3 class="text-sm font-bold text-slate-800 uppercase tracking-wide">${esc(title)}</h3>
      ${actionsHtml ? `<div class="flex flex-wrap gap-2">${actionsHtml}</div>` : ''}
    </div>
    ${bodyHtml}</div>`;
}

const deskBtn = (label, onclick, tone) => {
  const tones = {
    primary: 'bg-navy hover:bg-indigo-700 text-white',
    plain: 'border border-slate-300 hover:bg-slate-50 text-slate-700',
    good: 'bg-emerald-600 hover:bg-emerald-700 text-white',
  };
  return `<button type="button" onclick="${onclick}" class="px-3 py-1.5 ${tones[tone || 'plain']} text-xs font-bold rounded-lg">${esc(label)}</button>`;
};

const deskField = (label, value) =>
  `<div><dt class="text-[11px] text-slate-400 uppercase tracking-wide">${esc(label)}</dt>
     <dd class="text-sm text-slate-800">${esc(value || '—')}</dd></div>`;

function deskWhoCard(user, reg, checkedIn, guest) {
  // Arrival lives on this card rather than one of its own: at a counter it is
  // a fact about the person, and a card holding one button is a card too many.
  const arrival = checkedIn
    ? `<span class="inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-full border bg-emerald-100 text-emerald-800 border-emerald-300">${ICON('check')}Arrived ${esc(fmtRegisteredAt(checkedIn.at))}</span>`
    : `<span class="inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-full border bg-slate-100 text-slate-500 border-slate-300">Not arrived</span>`;
  const actions = [
    can('desk.checkin') && !checkedIn && reg ? deskBtn('Check in', 'deskCheckIn()', 'good') : '',
    can('users.edit') ? deskBtn('Edit details', 'deskOpenEdit()') : '',
    // A delegate at the counter who cannot get into their account is the
    // commonest reason a desk needs this at all.
    can('users.reset_password')
      ? deskBtn('Reset password', `resetUserPassword('${esc(user.phone_number)}', '${esc(user.full_name || '')}')`)
      : '',
    // Faculty are on the guest list (Guests tab); marking them puts them there.
    can('guests.edit') && !guest ? deskBtn('Mark as faculty', 'deskMarkFaculty()') : '',
    // Their whole account -- details, main and additional roles, password --
    // in the Users panel, for a role that may see it.
    can('users.view') ? deskBtn('Profile & roles', 'deskOpenProfile()') : '',
  ].filter(Boolean).join('');
  const faculty = guest
    ? `<span class="inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-full border bg-indigo-100 text-indigo-800 border-indigo-300" title="On the faculty list${guest.overall_status ? ` · ${esc(guest.overall_status)}` : ''}">Faculty</span>` : '';

  return deskCard('Delegate', `
    <div class="flex items-start justify-between gap-3 flex-wrap mb-3">
      <div class="min-w-0">
        <p class="font-bold text-slate-800">${esc([user.salutation, user.full_name].filter(Boolean).join(' '))}</p>
        <p class="text-xs text-slate-500">${esc(reg ? reg.category_label : 'No registration yet')}</p>
      </div>
      <div class="flex flex-wrap gap-1.5">
        ${(reg && reg.registration_number) || user.registration_number ? `<span class="text-[11px] font-mono text-slate-500">${esc((reg && reg.registration_number) || user.registration_number)}</span>` : ''}
        ${faculty}
        ${arrival}
      </div>
    </div>
    <dl class="grid grid-cols-2 sm:grid-cols-3 gap-3">
      ${deskField('Mobile', user.phone)}${deskField('Email', user.email)}
      ${deskField('Designation', user.designation)}${deskField('Institution', user.institution)}
      ${deskField('District', user.district)}${deskField('State', user.state)}
    </dl>
    <div id="desk-edit-form" class="hidden mt-4 pt-4 border-t border-slate-200"></div>`, actions);
}

function deskNoRegistrationCard() {
  // Registered on the spot against the account they already have -- the
  // walk-in form opens linked to them, so nothing is retyped and no second
  // account is created.
  const canRegister = can('payments.desk_register');
  return deskCard('Registration', `
    <p class="text-sm text-slate-500">This person has an account but has not registered.${canRegister ? ' Register them here to take their payment.' : ''}</p>`,
  canRegister ? deskBtn('Register this delegate', 'registerDeskDelegate()', 'primary') : '');
}

function registerDeskDelegate() {
  if (!deskDelegate || !deskDelegate.user) return;
  const u = deskDelegate.user;
  openRegisterDelegateModal({
    phone_number: u.phone_number, phone: u.phone, salutation: u.salutation,
    full_name: u.full_name, email: u.email, institution: u.institution,
  });
}

function deskMoneyCard(reg, payment) {
  const fee = Number(reg.expected_amount) || 0;
  // netVerifiedTotal, not verifiedTotal: a recorded refund reduces what the
  // delegate has actually paid, and `remaining` is the summary's own name for
  // the outstanding figure -- there is no `balance` field.
  const paid = payment ? Number(payment.netVerifiedTotal) || 0 : 0;
  const balance = payment ? Number(payment.remaining) || 0 : Math.max(0, fee - paid);
  // No chip at all where the category needs no card -- see paymentRowHtml.
  const needsId = isStudentCategory(reg.category_key);
  const idChip = !needsId
    ? ''
    : reg.id_verified
      ? `<span class="inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-full border bg-emerald-100 text-emerald-800 border-emerald-300">${ICON('gradcap')}ID verified</span>`
      : `<span class="inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-full border bg-amber-100 text-amber-800 border-amber-300">${ICON('warning')}ID pending</span>`;

  const actions = [
    can('payments.add_payment') && balance > 0.5 ? deskBtn('Collect cash', 'deskOpenCollect()', 'primary') : '',
    can('payments.verify_id') && needsId && !reg.id_verified ? deskBtn('Verify student ID', 'deskVerifyId()') : '',
    can('payments.revise') ? deskBtn('Correct category', 'deskOpenCategory()') : '',
    reg.bank_status === 'BANK_VERIFIED' ? `<a href="/api/desk/registrations/${esc(reg.id)}/receipt" target="_blank" rel="noopener" class="px-3 py-1.5 border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-bold rounded-lg">Receipt</a>` : '',
    // The finance review -- evidence, accept or reject, un-approve or
    // un-reject, fee adjustment -- for a role that may open it.
    can('payments.view') ? deskBtn('Payment review', `deskOpenPaymentReview(${esc(reg.id)})`, 'primary') : '',
  ].filter(Boolean).join('');

  // An excess is an obligation to the delegate, so it sits on the record for
  // as long as it is unsettled rather than only appearing in the moment a
  // category change creates it.
  const owedBack = payment ? Number(payment.overpaid) || 0 : 0;
  const refundNote = owedBack > 0
    ? `<p class="mt-3 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
        ${ICON('coin')}<b>₹${inr(owedBack)} refundable.</b> Recorded from Payments against the bank
        debit that pays it out — not settled in cash here, which would leave no record.</p>`
    : '';

  return deskCard('Payment', `
    <div class="flex flex-wrap items-end gap-x-8 gap-y-3">
      <div><p class="text-[11px] text-slate-400 uppercase tracking-wide">Fee</p>
        <p class="text-lg font-bold text-slate-800 tabular-nums">₹${inr(fee)}</p></div>
      <div><p class="text-[11px] text-slate-400 uppercase tracking-wide">Paid</p>
        <p class="text-lg font-bold text-slate-800 tabular-nums">₹${inr(paid)}</p></div>
      <div><p class="text-[11px] text-slate-400 uppercase tracking-wide">Balance</p>
        <p class="text-lg font-bold tabular-nums ${balance > 0.5 ? 'text-amber-700' : 'text-emerald-700'}">₹${inr(balance)}</p></div>
      <div class="flex flex-wrap items-center gap-1.5">${idChip}</div>
    </div>
    ${refundNote}
    <div id="desk-collect-form" class="hidden mt-4 pt-4 border-t border-slate-200"></div>`, actions);
}

function deskProgrammeCard(selections) {
  const chosen = new Map((selections || []).map((s) => [s.group_id, s]));
  const body = deskProgrammeGroups.length
    ? deskProgrammeGroups.map((g) => {
      const pick = chosen.get(g.id);
      return `<div class="py-2 border-b border-slate-100 last:border-0">
        <p class="text-[11px] text-slate-400 uppercase tracking-wide">${esc(g.name)}</p>
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <p class="text-sm text-slate-800">${esc(pick ? pick.option_name : 'Not chosen')}${pick && pick.is_faculty ? ' <span class="text-[11px] text-indigo-700 font-bold">(Faculty)</span>' : ''}</p>
          ${can('desk.enroll') ? deskBtn('Change', `deskOpenEnroll(${g.id})`) : ''}
        </div>
        <div id="desk-enroll-form-${g.id}" class="hidden mt-3"></div>
      </div>`;
    }).join('')
    : '<p class="text-sm text-slate-500">No programmes are set up.</p>';
  return deskCard('Programme', body, '');
}

const DESK_ABSTRACT_STATUS = {
  UNDER_REVIEW: ['due', 'Under review'],
  ACCEPTED: ['ok', 'Accepted'],
  REJECTED: ['bad', 'Not accepted'],
  REVISION_REQUESTED: ['due', 'Revision requested'],
};

function deskAbstractCard(abstracts, win, ext) {
  // Read-only, deliberately: presentation format is abstracts.assign, which is
  // Super Admin's, and accepting is abstracts.review. The desk answers "what
  // happened to mine", it does not decide it. The one thing it can do is let
  // this person submit after the last date (abstracts.extend_deadline, held
  // by Super Admin and the Front Desk) -- and only while they have not
  // submitted.
  if (!abstracts || !abstracts.length) {
    const deadline = (win && win.deadline) || conferenceInfo.abstractDeadline;
    const open = win ? win.open : conferenceInfo.abstractSubmissionOpen !== false;
    let status;
    if (ext && win && win.extended && open) {
      status = `They may submit until <b>${esc(formatFullDateWithDay(ext.until))}</b> — a later date given to them alone.`;
    } else if (ext && win && win.extended) {
      status = `Their own later date, ${esc(formatFullDate(ext.until))}, has passed.`;
    } else if (!open && deadline) {
      // Past the deadline "none" is final, which is the answer the desk is
      // usually being asked for.
      status = `Submission closed on ${esc(formatFullDate(deadline))}.`;
    } else {
      status = '';
    }
    const manage = can('abstracts.extend_deadline');
    const form = manage ? `
      <div id="desk-absext-form" class="hidden mt-3 pt-3 border-t border-slate-100">
        <div class="flex flex-wrap items-end gap-3">
          <label class="text-xs font-semibold text-slate-600">May submit until
            <input type="date" id="desk-absext-until" min="${esc(istDateString())}" value="${esc(ext ? ext.until : '')}" class="block mt-1 h-9 px-3 border border-slate-300 rounded-lg text-sm bg-white outline-none">
          </label>
          ${deskBtn(ext ? 'Save date' : 'Allow', 'deskSaveAbstractExtension()', 'primary')}
        </div>
        <label class="mt-2 inline-flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
          <input type="checkbox" id="desk-absext-notify" checked> Email them their last date
        </label>
      </div>` : '';
    const actions = !manage ? ''
      : ext ? deskBtn('Change date', 'deskToggleAbstractExtension()') + deskBtn('Withdraw', 'deskWithdrawAbstractExtension()')
        : deskBtn('Allow late submission', 'deskToggleAbstractExtension()');
    return deskCard('Abstract', `<p class="text-sm text-slate-500">No abstract submitted.${status ? ` ${status}` : ''}</p>${form}`, actions);
  }
  const tones = {
    ok: 'bg-emerald-100 text-emerald-800 border-emerald-300',
    due: 'bg-amber-100 text-amber-800 border-amber-300',
    bad: 'bg-rose-100 text-rose-800 border-rose-300',
  };
  // The review window, and oral/poster, for roles that may use them.
  const abstractActions = (a) => [
    can('abstracts.view') ? deskBtn('Review', `deskOpenAbstract(${esc(a.id)})`) : '',
    can('abstracts.assign') && a.status === 'ACCEPTED' ? deskBtn(a.allocation === 'ORAL' ? 'Oral ✓' : 'Oral', `deskAllotAbstract(${esc(a.id)}, 'ORAL')`) : '',
    can('abstracts.assign') && a.status === 'ACCEPTED' ? deskBtn(a.allocation === 'POSTER' ? 'Poster ✓' : 'Poster', `deskAllotAbstract(${esc(a.id)}, 'POSTER')`) : '',
    can('abstracts.assign') && a.status === 'ACCEPTED' ? deskBtn(a.allocation === 'AWARD' ? 'Award ✓' : 'Award', `deskAllotAbstract(${esc(a.id)}, 'AWARD')`) : '',
  ].filter(Boolean).join('');
  return deskCard('Abstract', abstracts.map((a) => {
    const [tone, label] = DESK_ABSTRACT_STATUS[a.status] || ['due', a.status || 'Submitted'];
    return `<div class="py-2 border-b border-slate-100 last:border-0">
      <p class="text-sm text-slate-800">${esc(a.title || 'Untitled')}</p>
      <div class="flex flex-wrap items-center gap-1.5 mt-1.5">
        <span class="inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-full border ${tones[tone]}">${esc(label)}</span>
        <span class="inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-full border ${a.allocation ? 'bg-indigo-100 text-indigo-800 border-indigo-300' : 'bg-slate-100 text-slate-500 border-slate-300'}">${esc(a.allocation ? abstractFormatLabel(a.allocation) : 'Format not assigned')}</span>
      </div>
      ${a.revision_note ? `<p class="text-[11px] text-amber-800 mt-1">${esc(a.revision_note)}</p>` : ''}
      ${abstractActions(a) ? `<div class="flex flex-wrap gap-1.5 mt-2">${abstractActions(a)}</div>` : ''}
    </div>`;
  }).join('') + (ext ? `<p class="text-[11px] text-slate-500 mt-2">They were given a later last date of ${esc(formatFullDate(ext.until))}.</p>` : ''), '');
}

// --- late abstract submission, for the delegate on screen ----------------

function deskToggleAbstractExtension() {
  const form = document.getElementById('desk-absext-form');
  if (!form) return;
  form.classList.toggle('hidden');
  if (!form.classList.contains('hidden')) document.getElementById('desk-absext-until').focus();
}

async function deskSaveAbstractExtension() {
  const key = deskDelegate && deskDelegate.user ? deskDelegate.user.phone_number : null;
  const until = document.getElementById('desk-absext-until').value;
  const notify = document.getElementById('desk-absext-notify').checked;
  if (!key) return;
  if (!until) return showToast('Choose the last date they may submit on.');
  const data = await (await fetch(`/api/abstracts/extensions/${encodeURIComponent(key)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ until, notify }),
  })).json().catch(() => ({}));
  if (!data.success) return showToast(data.error || 'Could not allow late submission.');
  showToast(`They may submit until ${formatFullDate(until)}.${notify ? (data.emailed ? ' They have been emailed.' : ' No email was sent — none on file, or email is off.') : ''}`, 'success');
  deskReload();
}

async function deskWithdrawAbstractExtension() {
  const key = deskDelegate && deskDelegate.user ? deskDelegate.user.phone_number : null;
  if (!key) return;
  if (!(await showConfirm('Withdraw their later date? They will be held to the general last date again. No email is sent.'))) return;
  const data = await (await fetch(`/api/abstracts/extensions/${encodeURIComponent(key)}`, { method: 'DELETE' })).json().catch(() => ({}));
  if (!data.success) return showToast(data.error || 'Could not withdraw it.');
  showToast('Withdrawn.', 'success');
  deskReload();
}

// --- desk actions ---------------------------------------------------------

// A faculty member's travel and stay, read-only, when any is set -- so the
// desk can answer "when is my pickup, where am I staying".
function deskFacultyCard(g) {
  if (!g) return '';
  // Their record in the Faculty tab's editor: edit for a coordinator or
  // their own volunteer, view for anyone else who may see faculty.
  const open = can('guests.view') ? deskBtn(can('guests.edit') || can('guests.travel') || can('guests.stay')
    || can('guests.travel_assigned') || can('guests.stay_assigned') ? 'Travel & stay' : 'View record', `deskOpenFaculty(${esc(g.id)})`) : '';
  // Whatever has been entered, piece by piece (see guestLegHtml/guestStayHtml).
  const arrival = guestLegHtml(g.arrival_date, g.arrival_time, g.arrival_mode, g.arrival_number, g.arrival_point, g.pickup_vehicle, g.pickup_status);
  const departure = guestLegHtml(g.departure_date, g.departure_time, g.departure_mode, g.departure_number, g.departure_point, g.drop_vehicle, g.drop_status);
  const rows = [
    ['Arrival · pickup', arrival], ['Departure · drop', departure],
    ['Stay', guestStayHtml(g)], ['Transport volunteer', esc(g.transport_volunteer || '')], ['Accommodation volunteer', esc(g.accommodation_volunteer || '')],
    ['Special needs', esc(g.special_needs || '')],
  ].filter(([, v]) => v);
  if (!rows.length && !open) return '';
  return deskCard('Faculty — travel & stay', rows.length ? `<dl class="grid grid-cols-1 sm:grid-cols-2 gap-3">${rows.map(([k, v]) =>
    `<div><dt class="text-[11px] text-slate-400 uppercase tracking-wide">${esc(k)}</dt><dd class="text-sm text-slate-800">${v}</dd></div>`).join('')}</dl>`
    : '<p class="text-sm text-slate-500">No travel or stay details yet.</p>', open);
}

// --- opening other screens' editors for the person on the desk ---
function deskOpenProfile() {
  if (deskDelegate && deskDelegate.user) openUserDetail(deskDelegate.user.phone_number);
}
async function deskOpenPaymentReview(regId) {
  // The review window reads the payments list; load it if this session has
  // not opened Payments yet.
  if (!cachedPaymentRegs.some((r) => String(r.id) === String(regId))) await renderBackendPayments();
  if (!cachedPaymentRegs.some((r) => String(r.id) === String(regId))) return showToast('Could not open the payment review.');
  openReviewModal(regId);
}
async function deskOpenAbstract(id) {
  if (!abstractsCache.some((a) => String(a.id) === String(id))) await renderBackendAbstracts();
  openAbstractReview(id);
}
async function deskAllotAbstract(id, allocation) {
  if (!(await confirmAllocationEmail(id, allocation))) return;
  const data = await (await fetch(`/api/abstracts/${encodeURIComponent(id)}/allocation`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ allocation }),
  })).json().catch(() => ({}));
  if (!data.success) return showToast(data.error || 'Could not allot.');
  showToast(`Allotted ${abstractFormatLabel(allocation).toLowerCase()}; the author has been emailed.`, 'success');
  deskReload();
}
async function deskOpenFaculty(id) {
  if (!guestData || !guestData.guests.some((g) => g.id === id)) {
    const res = await fetch('/api/guests');
    if (!res.ok) return showToast('Could not open the faculty record.');
    guestData = await res.json();
  }
  openGuestEditor(id);
}

// --- scanning a desk pass or barcode ---
// html5-qrcode reads QR codes and the common barcodes from the camera, on
// iPhone and Android alike; loaded only when Scan is first pressed.
const DESK_SCANNER_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/html5-qrcode/2.3.8/html5-qrcode.min.js';
let deskScanner = null;
function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (Array.from(document.scripts || []).some((s) => s.src === src)) return resolve();
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error('Could not load the scanner.'));
    document.head.appendChild(el);
  });
}
// What a scanned code holds, as something the desk search understands: an ID
// (NQOCN2026…), an email, or a mobile number -- from plain text or a link.
function deskIdentifierFromScan(raw) {
  let t = String(raw || '').trim();
  if (!t) return '';
  if (/^https?:\/\//i.test(t)) {
    try {
      const u = new URL(t);
      t = u.searchParams.get('id') || u.searchParams.get('reg') || u.searchParams.get('q') || decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    } catch (e) { /* not a link after all */ }
  }
  const id = /[A-Za-z]{2,10}\d{4,}/.exec(t);
  if (id) return id[0].toUpperCase();
  const email = /[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/.exec(t);
  if (email) return email[0];
  const digits = t.replace(/\D/g, '');
  if (digits.length >= 10) return digits.slice(-10);
  return t.slice(0, 80);
}
async function openDeskScanner() {
  const msg = document.getElementById('desk-scan-msg');
  openModal('modal-desk-scan');
  if (msg) msg.textContent = 'Starting the camera…';
  try {
    if (!window.Html5Qrcode) await loadScriptOnce(DESK_SCANNER_SRC);
    deskScanner = new window.Html5Qrcode('desk-scan-reader');
    await deskScanner.start({ facingMode: 'environment' },
      { fps: 10, qrbox: (w, h) => { const side = Math.floor(Math.min(w, h) * 0.75); return { width: side, height: side }; } },
      (text) => onDeskScan(text), () => {});
    if (msg) msg.textContent = 'Point the camera at the desk pass or barcode.';
  } catch (e) {
    if (msg) msg.textContent = 'The camera could not start. Allow camera access for this site, or type the ID instead.';
  }
}
async function closeDeskScanner() {
  const scanner = deskScanner;
  deskScanner = null;
  if (scanner) {
    try { await scanner.stop(); } catch (e) { /* already stopped */ }
    try { scanner.clear(); } catch (e) { /* nothing to clear */ }
  }
  closeModal('modal-desk-scan');
}
async function onDeskScan(text) {
  if (!deskScanner) return;   // one scan is enough
  const id = deskIdentifierFromScan(text);
  await closeDeskScanner();
  if (!id) return showToast('That code holds nothing the desk can look up.');
  document.getElementById('desk-search').value = id;
  deskLookup();
}

async function deskMarkFaculty() {
  const key = deskDelegate && deskDelegate.user ? deskDelegate.user.phone_number : null;
  if (!key) return;
  if (!(await showConfirm('Mark this delegate as faculty? They join the faculty list, where their travel and stay are coordinated.'))) return;
  const done = await markFaculty(null, key);
  if (done && done.success) deskReload();
}

async function deskReload() {
  const key = deskDelegate && deskDelegate.user ? deskDelegate.user.phone_number : null;
  if (!key) return;
  const data = await (await fetch(`/api/desk/delegate/${encodeURIComponent(key)}`)).json();
  if (data.success && !data.candidates) { deskDelegate = data; renderDeskRecord(); }
}

async function deskCheckIn() {
  const res = await fetch('/api/desk/checkin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: deskDelegate.user.phone_number }),
  });
  const data = await res.json();
  if (!data.success) return showToast(data.error || 'Could not check in.');
  showToast(data.alreadyCheckedIn ? 'Already checked in.' : 'Checked in.', 'success');
  await deskReload();
}

async function deskVerifyId() {
  const res = await fetch(`/api/registrations/${deskDelegate.registration.id}/verify-id`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ verified: true }),
  });
  const data = await res.json();
  if (!data.success) return showToast(data.error || 'Could not verify the ID.');
  showToast('Student ID verified.', 'success');
  await deskReload();
}

function deskOpenCollect() {
  const box = document.getElementById('desk-collect-form');
  const balance = Number(deskDelegate.payment ? deskDelegate.payment.remaining : 0) || 0;
  box.innerHTML = `
    <div class="grid sm:grid-cols-3 gap-3 items-end">
      <div><label class="block text-[11px] text-slate-500 font-semibold mb-1">Amount (₹)</label>
        <input id="desk-collect-amount" type="number" min="1" step="1" value="${Math.round(balance)}"
               class="w-full p-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-200"></div>
      <div><label class="block text-[11px] text-slate-500 font-semibold mb-1">Cash collected by</label>
        ${deskCollectorSelect('desk-collect-by')}</div>
      <div class="flex gap-2">
        ${deskBtn('Record cash', 'deskCollectCash()', 'primary')}
        ${deskBtn('Cancel', "document.getElementById('desk-collect-form').classList.add('hidden')")}
      </div>
    </div>
    <p class="text-[11px] text-slate-400 mt-2">Recorded as received. Bank it later from Bank Statement → cash deposit.</p>`;
  box.classList.remove('hidden');
}

async function deskCollectCash() {
  const amount = Number(document.getElementById('desk-collect-amount').value);
  const collectedBy = document.getElementById('desk-collect-by').value;
  const res = await fetch('/api/desk/collect-cash', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: deskDelegate.user.phone_number, amount, collectedBy }),
  });
  const data = await res.json();
  if (!data.success) return showToast(data.error || 'Could not record the cash.');
  showToast(`₹${inr(data.amount)} recorded.`, 'success');
  document.getElementById('desk-collect-form').classList.add('hidden');
  await Promise.all([deskReload(), refreshDeskCash()]);
}

// Correcting a category at the desk -- the "student" who turns out to be
// faculty, spotted when they hand over an ID that does not match. This is the
// same PUT .../lock-category the Review modal uses: it changes the category
// and the fee and locks it, and deliberately does NOT itself demand money or
// move the registration to balance-due. If the new fee leaves a shortfall the
// desk takes it with Collect cash, which is right there beside it.
function deskOpenCategory() {
  const box = document.getElementById('desk-collect-form');
  const current = deskDelegate.registration.category_key;
  const options = (reviewCategoryList || []).map((c) =>
    `<option value="${esc(c.key)}"${c.key === current ? ' selected' : ''}>${esc(c.label)}</option>`).join('');
  box.innerHTML = `
    <div class="grid sm:grid-cols-3 gap-3 items-end">
      <div class="sm:col-span-2"><label class="block text-[11px] text-slate-500 font-semibold mb-1">Category</label>
        <select id="desk-category-select" class="w-full p-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-200">${options}</select></div>
      <div class="flex gap-2">
        ${deskBtn('Change category', 'deskSaveCategory()', 'primary')}
        ${deskBtn('Cancel', "document.getElementById('desk-collect-form').classList.add('hidden')")}
      </div>
    </div>
    <p class="text-[11px] text-slate-400 mt-2">Changes the fee too. Any shortfall can then be taken with Collect cash.</p>`;
  box.classList.remove('hidden');
}

async function deskSaveCategory() {
  const categoryKey = document.getElementById('desk-category-select').value;
  const res = await fetch(`/api/registrations/${deskDelegate.registration.id}/lock-category`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ categoryKey }),
  });
  const data = await res.json();
  if (!data.success) return showToast(data.error || 'Could not change the category.');
  document.getElementById('desk-collect-form').classList.add('hidden');
  await deskReload();

  // A category correction moves the fee, and the desk has to be told which
  // way and what to do about it -- otherwise a delegate walks away either
  // still owing money or owed it, and nobody notices until reconciliation.
  if (data.remaining > 0) {
    showToast(`Category changed — ₹${inr(data.remaining)} now due. Collect it below.`, 'success');
    deskOpenCollect();
    return;
  }
  if (data.overpaid > 0) {
    // Not offered as a button here on purpose: a refund must be backed by a
    // real debit row from the imported bank statement (POST /api/registrations/
    // :id/refund), which is proof the money actually left the account. Cash
    // handed back over the counter has no such proof, so recording it here
    // would be a claim rather than a record. Surfaced loudly instead, and
    // settled from Payments once the transfer is made.
    deskShowRefundDue(data.overpaid);
    showToast(`Category changed — ₹${inr(data.overpaid)} now refundable.`, 'success');
    return;
  }
  showToast('Category changed.', 'success');
}

// The excess a correction has left on this registration. Deliberately a
// standing notice on the record rather than a toast that disappears: it is
// an obligation to the delegate, and it survives until somebody acts on it.
function deskShowRefundDue(amount) {
  const box = document.getElementById('desk-collect-form');
  if (!box) return;
  box.innerHTML = `
    <div class="flex items-start gap-3 p-3 rounded-xl bg-amber-50 border border-amber-200">
      <span class="shrink-0 text-amber-700">${ICON('coin')}</span>
      <div class="min-w-0">
        <p class="text-sm font-bold text-amber-900">₹${inr(amount)} refundable to this delegate</p>
        <p class="text-[11px] text-amber-800 mt-0.5">
          The new category costs less than they have already paid. A refund is recorded
          against the bank debit that pays it out — from Payments, once the transfer is made.
          Do not settle it in cash here: there would be no record of it.
        </p>
      </div>
    </div>`;
  box.classList.remove('hidden');
}

function deskOpenEnroll(groupId) {
  const group = deskProgrammeGroups.find((g) => g.id === groupId);
  if (!group) return;
  const box = document.getElementById(`desk-enroll-form-${groupId}`);
  // Occupancy comes from the server's own count, which excludes faculty (they
  // hold a place on the roster but not a delegate's seat) and excludes
  // rejected registrations. Counting enrolments any other way overstates a
  // workshop that has faculty attached to it.
  const options = group.options.map((o) => {
    const full = o.enrolled >= o.capacity;
    return `<option value="${o.id}">${esc(o.name)} — ${o.enrolled}/${o.capacity}${full ? ' (full)' : ''}</option>`;
  }).join('');
  box.innerHTML = `
    <div class="grid sm:grid-cols-3 gap-3 items-end">
      <div class="sm:col-span-2"><label class="block text-[11px] text-slate-500 font-semibold mb-1">Move to</label>
        <select id="desk-enroll-option-${groupId}" class="w-full p-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-200">${options}</select></div>
      <div class="flex gap-2">
        ${deskBtn('Move', `deskEnroll(${groupId})`, 'primary')}
        ${deskBtn('Cancel', `document.getElementById('desk-enroll-form-${groupId}').classList.add('hidden')`)}
      </div>
    </div>
    <div id="desk-enroll-reason-${groupId}" class="hidden mt-3"></div>`;
  box.classList.remove('hidden');
}

async function deskEnroll(groupId, reason) {
  const optionId = Number(document.getElementById(`desk-enroll-option-${groupId}`).value);
  const res = await fetch('/api/desk/enroll', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: deskDelegate.user.phone_number, optionId, reason: reason || '' }),
  });
  const data = await res.json();
  // A full option is not refused outright -- the desk is the last resort on
  // the day -- but it cannot be done silently either. The reason typed here
  // is what lands in the audit log.
  if (!data.success && data.needsReason) {
    const box = document.getElementById(`desk-enroll-reason-${groupId}`);
    box.innerHTML = `
      <p class="text-xs text-amber-800 font-semibold mb-2">${esc(data.error)}</p>
      <div class="flex gap-2">
        <input id="desk-enroll-why-${groupId}" type="text" placeholder="Why is this being allowed?"
               class="flex-1 p-2 border border-amber-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-amber-200">
        ${deskBtn('Enrol anyway', `deskEnrollWithReason(${groupId})`, 'primary')}
      </div>`;
    box.classList.remove('hidden');
    return;
  }
  if (!data.success) return showToast(data.error || 'Could not change the programme.');
  showToast(data.overCapacity ? 'Enrolled over capacity — recorded.' : 'Programme changed.', 'success');
  await Promise.all([loadDeskProgrammes(), deskReload()]);
}

async function deskEnrollWithReason(groupId) {
  const reason = (document.getElementById(`desk-enroll-why-${groupId}`).value || '').trim();
  if (!reason) return showToast('Record why this is being allowed.');
  await deskEnroll(groupId, reason);
}

// The desk's edit form. Every control here that used to be free text is a
// constrained one now, for the same reason the signup form's are: a counter
// is where "Prof." and "Professor " and "professor" get typed at speed, and
// the homogenisation pass that had to clean that up afterwards is not an
// exercise worth repeating.
//
// It reuses the signup form's own helpers rather than growing a second copy
// of them -- loadDirectorySuggestions and fetchAddressDetails both take an id
// prefix now, so the desk drives the identical logic (including the fallback
// where a recognised-but-unnameable PIN unlocks the fields to be typed).
// The same three the signup form offers. Shared by the front desk and the
// Users panel so the three surfaces cannot drift apart.
const GENDER_OPTIONS = ['Male', 'Female', 'Other'];

function deskOpenEdit() {
  const u = deskDelegate.user;
  const box = document.getElementById('desk-edit-form');
  const field = (id, label, value, type) =>
    `<div><label class="block text-[11px] text-slate-500 font-semibold mb-1">${esc(label)}</label>
      <input id="desk-edit-${id}" type="${type || 'text'}" value="${esc(value == null ? '' : value)}"
             class="w-full p-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-200"></div>`;
  // Three controls per directory field: a select, a hidden input everything
  // downstream reads, and an "Other" box that only appears when chosen.
  const directory = (which, label, value) =>
    `<div><label class="block text-[11px] text-slate-500 font-semibold mb-1">${esc(label)}</label>
      <select id="desk-edit-${which}-select" onchange="onDirectorySelect('${which}', 'desk-edit')"
              class="w-full p-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-200"></select>
      <input id="desk-edit-${which}-other" type="text" placeholder="Type it in"
             class="hidden w-full mt-1 p-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-200">
      <input type="hidden" id="desk-edit-${which}" value="${esc(value == null ? '' : value)}"></div>`;

  // A verified address is one the delegate proved they control by opening a
  // code sent to it, so it is shown and not editable. The server refuses the
  // change too -- this only saves the desk from typing into a field that was
  // never going to be saved.
  const verified = !!u.email_verified;
  const emailField = verified
    ? `<div><label class="block text-[11px] text-slate-500 font-semibold mb-1">Email</label>
        <div class="w-full p-2 border border-slate-200 bg-slate-50 rounded-lg text-sm text-slate-600 flex items-center justify-between gap-2">
          <span class="truncate">${esc(u.email || '—')}</span>
          <span class="shrink-0 inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-full border bg-emerald-100 text-emerald-800 border-emerald-300">${ICON('check')}Verified</span>
        </div>
        <p class="text-[11px] text-slate-400 mt-1">Verified by the delegate — cannot be changed here.</p></div>`
    : field('email', 'Email', u.email, 'email');

  box.innerHTML = `
    <div class="grid sm:grid-cols-3 gap-3">
      ${field('full_name', 'Full name', u.full_name)}
      ${emailField}
      ${field('age', 'Age', u.age, 'number')}
      ${directory('designation', 'Designation', u.designation)}
      ${directory('institute', 'Institution', u.institution)}
      <div><label class="block text-[11px] text-slate-500 font-semibold mb-1">Medical Council</label>
        <select id="desk-edit-council_name" class="w-full p-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-200">${councilOptionsHtml(u.council_name || '')}</select></div>
      ${field('council_reg_no', 'Council registration no.', u.council_reg_no)}
      <div><label class="block text-[11px] text-slate-500 font-semibold mb-1">Gender</label>
        <select id="desk-edit-gender" class="w-full p-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-200">
          <option value="">Select</option>
          ${GENDER_OPTIONS.map((g) => `<option value="${esc(g)}"${u.gender === g ? ' selected' : ''}>${esc(g)}</option>`).join('')}
        </select></div>
      <div><label class="block text-[11px] text-slate-500 font-semibold mb-1">PIN code</label>
        <input id="desk-edit-pincode" type="text" maxlength="6" value="${esc(u.pincode == null ? '' : u.pincode)}"
               oninput="fetchAddressDetails(this.value, 'desk-edit')"
               class="w-full p-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-200">
        <span id="desk-edit-pincode-status" class="text-xs mt-1 block font-medium"></span></div>
      <!-- Filled from the PIN code, not typed. readOnly rather than disabled
           so the values still read normally and can be unlocked by
           setAddressFieldsEditable when a PIN cannot be named. -->
      <div><label class="block text-[11px] text-slate-500 font-semibold mb-1">State</label>
        <input id="desk-edit-state" type="text" readonly value="${esc(u.state == null ? '' : u.state)}"
               class="w-full p-2 border border-slate-300 rounded-lg text-sm bg-slate-100 text-slate-600 outline-none"></div>
      <div><label class="block text-[11px] text-slate-500 font-semibold mb-1">District</label>
        <input id="desk-edit-district" type="text" readonly value="${esc(u.district == null ? '' : u.district)}"
               class="w-full p-2 border border-slate-300 rounded-lg text-sm bg-slate-100 text-slate-600 outline-none"></div>
    </div>
    <div class="flex gap-2 mt-3">
      ${deskBtn('Save details', 'deskSaveEdit()', 'primary')}
      ${deskBtn('Cancel', "document.getElementById('desk-edit-form').classList.add('hidden')")}
    </div>`;
  box.classList.remove('hidden');

  // Populate the two dropdowns, then select what this delegate already has.
  // A value that is not on the list is not silently dropped -- it goes into
  // "Other" pre-filled, so opening the form and saving it unchanged cannot
  // quietly erase somebody's institution.
  loadDirectorySuggestions('desk-edit').then(() => {
    for (const [which, value] of [['designation', u.designation], ['institute', u.institution]]) {
      const sel = document.getElementById(`desk-edit-${which}-select`);
      if (!sel) continue;
      const known = Array.from(sel.options || []).some((o) => o.value === value);
      sel.value = known && value ? value : (value ? '__other__' : '');
      onDirectorySelect(which, 'desk-edit');
      if (!known && value) {
        document.getElementById(`desk-edit-${which}-other`).value = value;
        onDirectorySelect(which, 'desk-edit');
      }
    }
  });
}

async function deskSaveEdit() {
  const val = (id) => {
    const el = document.getElementById(`desk-edit-${id}`);
    return el ? el.value : undefined;
  };
  const body = {
    full_name: val('full_name'),
    age: val('age'),
    designation: val('designation'),
    institution: val('institute'),
    gender: val('gender'),
    pincode: val('pincode'),
    state: val('state'),
    district: val('district'),
    council_name: val('council_name'),
    council_reg_no: val('council_reg_no'),
  };
  // Omitted entirely when verified: the field is not on the form, and the
  // server would refuse the change anyway. Sending the unchanged address
  // would be harmless but sending `undefined` would blank it.
  const email = val('email');
  if (email !== undefined) body.email = email;

  const res = await fetch(`/api/users/${encodeURIComponent(deskDelegate.user.phone_number)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.success) return showToast(data.error || 'Could not save.');
  showToast('Details updated.', 'success');
  document.getElementById('desk-edit-form').classList.add('hidden');
  await deskReload();
}

// --- GUEST COORDINATION ------------------------------------------------------
// The Guests tab: faculty guests' travel, pickups, drops and stay. One fetch
// (GET /api/guests) brings the list with every flag, the schedules, vehicle
// and room tallies and the dashboard, all worked out server-side (guests.js);
// this only draws them. Editing is split by permission -- travel
// (guests.travel), stay (guests.stay), the shared fields (guests.edit) -- and
// the server enforces the same split.
let guestData = null;
let guestSort = { key: 'sr_no', dir: 1 };
const GUEST_VIEWS = ['list', 'dashboard', 'pickups', 'drops', 'vehicles', 'rooms', 'settings'];

const GUEST_STATUS_STYLES = {
  invited: 'bg-amber-100 text-amber-800 border-amber-300',
  confirmed: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  arrived: 'bg-blue-100 text-blue-800 border-blue-300',
  departed: 'bg-slate-200 text-slate-700 border-slate-300',
  cancelled: 'bg-rose-100 text-rose-800 border-rose-300 line-through',
};
const GUEST_FLAG_STYLES = {
  pickupAlert: 'bg-orange-100 text-orange-800 border-orange-300',
  noAccommodation: 'bg-rose-100 text-rose-800 border-rose-300',
  sharedRoom: 'bg-violet-100 text-violet-800 border-violet-300',
  vehicleClash: 'bg-amber-100 text-amber-800 border-amber-300',
  notRegistered: 'bg-sky-100 text-sky-800 border-sky-300',
  own: 'bg-white text-slate-600 border-slate-300',
};
const guestPill = (cls, text, title) =>
  `<span class="inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-full border ${cls}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;
function guestStatusBadge(status) {
  if (!status) return guestPill('bg-white text-slate-400 border-slate-300 border-dashed', 'Not set');
  return guestPill(GUEST_STATUS_STYLES[String(status).toLowerCase()] || 'bg-slate-100 text-slate-700 border-slate-300', status);
}
// The flag chips on a guest, in order of urgency.
function guestFlagChips(g) {
  const f = g.flags || {};
  const out = [];
  if (f.pickupAlert) out.push(guestPill(GUEST_FLAG_STYLES.pickupAlert, 'Arriving soon · no pickup vehicle'));
  if (f.noAccommodation) out.push(guestPill(GUEST_FLAG_STYLES.noAccommodation, 'No accommodation'));
  if (f.sharedRoom && f.sharedRoom.length) out.push(guestPill(GUEST_FLAG_STYLES.sharedRoom, `Shares room · ${f.sharedRoom.length + 1}`, `With ${f.sharedRoom.join(', ')}`));
  if (f.vehicleClash && f.vehicleClash.length) out.push(guestPill(GUEST_FLAG_STYLES.vehicleClash, 'Vehicle clash', f.vehicleClash.join('\n')));
  if (f.ownStay) out.push(guestPill(GUEST_FLAG_STYLES.own, 'Own stay'));
  if (g.complimentary) out.push(guestPill('bg-gold-50 text-gold-700 border-gold-300', 'Complimentary'));
  if (f.notSignedUp) out.push(guestPill(GUEST_FLAG_STYLES.notRegistered, 'Not signed up'));
  else if (f.notRegistered) out.push(guestPill(GUEST_FLAG_STYLES.notRegistered, 'Not registered'));
  return out.join(' ');
}
// Red outranks orange on the row itself; purple is a chip only (sharing a
// room can be intended).
function guestRowTint(g) {
  if (g.cancelled) return 'bg-slate-50 text-slate-400';
  if (g.flags.noAccommodation) return 'bg-rose-50';
  if (g.flags.pickupAlert) return 'bg-orange-50';
  return '';
}

async function renderGuests() {
  const res = await fetch('/api/guests');
  if (!res.ok) return;
  guestData = await res.json();
  const addBtn = document.getElementById('guests-add-btn');
  if (addBtn) addBtn.classList.toggle('hidden', !can('guests.edit'));
  const settingsTab = document.getElementById('guests-settings-tab');
  if (settingsTab) settingsTab.classList.toggle('hidden', !can('guests.manage'));
  // The tab badge: how many faculty there are, Cancelled aside (what needs
  // doing is the "Needs attention" filter and the orange and red rows).
  const facultyCount = guestData.dashboard.listed;
  const badge = document.getElementById('badge-faculty-count');
  if (badge) { badge.textContent = String(facultyCount); badge.classList.toggle('hidden', !facultyCount); }
  fillGuestFilters();
  if (pendingGuestFlag !== null) {
    const flagSel = document.getElementById('guests-filter-flag');
    if (flagSel) flagSel.value = pendingGuestFlag;
    pendingGuestFlag = null;
  }
  switchGuestView(guestCurrentView());
}

function guestCurrentView() {
  const v = storageGet('local', 'nqocn_guest_view');
  return GUEST_VIEWS.includes(v) && (v !== 'settings' || can('guests.manage')) ? v : 'list';
}

function switchGuestView(view) {
  if (!GUEST_VIEWS.includes(view) || (view === 'settings' && !can('guests.manage'))) view = 'list';
  storageSet('local', 'nqocn_guest_view', view);
  document.querySelectorAll('.guest-subtab').forEach((b) => {
    const on = b.dataset.guestView === view;
    b.classList.toggle('bg-indigo-600', on);
    b.classList.toggle('text-white', on);
    b.classList.toggle('text-slate-600', !on);
    b.classList.toggle('hover:bg-slate-100', !on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  GUEST_VIEWS.forEach((v) => {
    const el = document.getElementById(`guests-view-${v}`);
    if (el) el.classList.toggle('hidden', v !== view);
  });
  if (!guestData) return;
  ({
    list: renderGuestList, dashboard: renderGuestDashboard, pickups: () => renderGuestSchedule('pickups'),
    drops: () => renderGuestSchedule('drops'), vehicles: renderGuestVehicles, rooms: renderGuestRooms, settings: renderGuestSettings,
  })[view]();
}

function fillGuestFilters() {
  const keep = (id) => (document.getElementById(id) || {}).value || '';
  const status = document.getElementById('guests-filter-status');
  if (status) {
    const was = keep('guests-filter-status');
    status.innerHTML = '<option value="">All statuses</option><option value="__live">All but Cancelled</option>'
      + guestData.lists.overall_status.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('')
      + '<option value="__none">Status not set</option>';
    status.value = was;
  }
  const acc = document.getElementById('guests-filter-acc');
  if (acc) {
    const was = keep('guests-filter-acc');
    acc.innerHTML = '<option value="">Any accommodation</option>'
      + guestData.lists.accommodation.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('')
      + '<option value="__none">No accommodation</option>';
    acc.value = was;
  }
  // Institute and district: the values on the list, each once (spelling as
  // first seen, case and spacing aside), with how many. Someone not signed
  // up has neither -- the account is where these come from.
  const places = (id, anyLabel, noneLabel, keyOf, labelOf) => {
    const el = document.getElementById(id);
    if (!el) return;
    const was = keep(id);
    const seen = new Map();
    let none = 0;
    for (const g of guestData.guests) {
      const k = keyOf(g);
      if (!k) { none++; continue; }
      if (!seen.has(k)) seen.set(k, { label: labelOf(g), n: 0 });
      seen.get(k).n++;
    }
    const opts = [...seen].sort((a, b) => a[1].label.localeCompare(b[1].label));
    el.innerHTML = `<option value="">${esc(anyLabel)}</option>`
      + opts.map(([k, o]) => `<option value="${esc(k)}">${esc(o.label)} (${o.n})</option>`).join('')
      + (none ? `<option value="__none">${esc(noneLabel)} (${none})</option>` : '');
    // Keep the choice across a refresh, unless that place has left the list.
    el.value = seen.has(was) || (was === '__none' && none) ? was : '';
  };
  places('guests-filter-institution', 'Any institute', 'Institute not recorded', guestInstitutionKey, (g) => guestPlaceText(g.institution));
  places('guests-filter-district', 'Any district', 'District not recorded', guestDistrictKey, (g) => [g.district, g.state].map(guestPlaceText).filter(Boolean).join(', '));
  const legendHtml = [
    ...guestData.lists.overall_status.map((v) => guestStatusBadge(v)),
    guestPill(GUEST_FLAG_STYLES.pickupAlert, `Orange: arriving within ${guestData.settings.alertDays} day(s), no pickup vehicle`),
    guestPill(GUEST_FLAG_STYLES.noAccommodation, 'Red: no accommodation'),
    guestPill(GUEST_FLAG_STYLES.sharedRoom, 'Purple: shares a room (check it is intended)'),
    guestPill(GUEST_FLAG_STYLES.vehicleClash, `Vehicle used twice within ${guestData.settings.clashMinutes} min`),
  ].join(' ');
  // Shown on desktop; folded under "Colour key" on a phone.
  for (const id of ['guests-legend', 'guests-legend-mobile']) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = legendHtml;
  }
}

const GUEST_SORTS = {
  sr_no: (g) => g.sr_no, name: (g) => (g.name || '').toLowerCase(), arrival_at: (g) => g.arrival_at || '￿',
  // Room numbers by value: room 2 before room 10.
  departure_at: (g) => g.departure_at || '￿', accommodation: (g) => `${(g.accommodation || '￿').toLowerCase()} ${(g.room_no || '').toLowerCase().replace(/\d+/g, (d) => d.padStart(10, '0'))}`,
  overall_status: (g) => (g.overall_status || '￿').toLowerCase(),
};
function sortGuests(key) {
  guestSort = guestSort.key === key ? { key, dir: -guestSort.dir } : { key, dir: 1 };
  renderGuestList();
}
// The phone's Sort select: always ascending, as a header's first tap is.
function setGuestSort(key) {
  guestSort = { key: GUEST_SORTS[key] ? key : 'sr_no', dir: 1 };
  renderGuestList();
}
// A phone number as a tap-to-call link (keeps the + and digits only).
function telLink(phone, cls = 'text-indigo-700 hover:underline') {
  if (!phone) return '';
  const href = String(phone).replace(/[^\d+]/g, '');
  return href.replace(/\D/g, '').length >= 6 ? `<a href="tel:${esc(href)}" class="${cls}">${esc(phone)}</a>` : esc(phone);
}

// Institute and district as filter keys: case and spacing do not split one
// place in two. A district is keyed with its state (Aurangabad, Bihar is not
// Aurangabad, Maharashtra).
const guestPlaceText = (s) => String(s || '').trim().replace(/\s+/g, ' ');
const guestInstitutionKey = (g) => guestPlaceText(g.institution).toLowerCase();
const guestDistrictKey = (g) => (guestPlaceText(g.district) ? `${guestPlaceText(g.district)}|${guestPlaceText(g.state)}`.toLowerCase() : '');
function filteredGuests() {
  const q = String((document.getElementById('guests-search') || {}).value || '').trim().toLowerCase();
  const status = (document.getElementById('guests-filter-status') || {}).value || '';
  const flag = (document.getElementById('guests-filter-flag') || {}).value || '';
  const acc = (document.getElementById('guests-filter-acc') || {}).value || '';
  const institution = (document.getElementById('guests-filter-institution') || {}).value || '';
  const district = (document.getElementById('guests-filter-district') || {}).value || '';
  return guestData.guests.filter((g) => {
    if (institution && guestInstitutionKey(g) !== (institution === '__none' ? '' : institution)) return false;
    if (district && guestDistrictKey(g) !== (district === '__none' ? '' : district)) return false;
    if (q && ![g.name, g.phone, g.designation, g.registration_number, g.arrival_number, g.departure_number, g.pickup_vehicle,
      g.drop_vehicle, g.room_no, g.accommodation, g.remarks, g.special_needs].some((v) => String(v || '').toLowerCase().includes(q))) return false;
    if (status === '__live' && g.cancelled) return false;
    if (status === '__none' && g.overall_status) return false;
    if (status && !status.startsWith('__') && g.overall_status !== status) return false;
    if (acc === '__none' && g.accommodation) return false;
    if (acc && acc !== '__none' && g.accommodation !== acc) return false;
    if (flag === 'attention' && !(g.flags.pickupAlert || g.flags.noAccommodation)) return false;
    // A volunteer's own: the faculty they are assigned to, either side.
    const me = activeAdminUser && activeAdminUser.phone_number;
    if (flag === 'mine' && !(me && (g.transport_coordinator === me || g.accommodation_coordinator === me))) return false;
    if (flag && flag !== 'attention' && flag !== 'mine') {
      const v = g.flags[flag];
      if (Array.isArray(v) ? !v.length : !v) return false;
    }
    return true;
  });
}

function renderGuestList() {
  const thead = document.getElementById('guests-thead');
  const tbody = document.getElementById('guests-tbody');
  if (!thead || !tbody || !guestData) return;
  const th = (key, label) => {
    const on = guestSort.key === key;
    return `<button type="button" onclick="sortGuests('${key}')" class="font-bold uppercase tracking-wide hover:text-slate-800 ${on ? 'text-slate-800' : ''}">${esc(label)}${on ? (guestSort.dir > 0 ? ' ▲' : ' ▼') : ''}</button>`;
  };
  thead.innerHTML = `<tr>
    <th class="p-3 text-left w-10 sticky left-0 z-20 bg-slate-50">${th('sr_no', 'Sr')}</th>
    <th class="p-3 text-left sticky left-10 z-20 bg-slate-50 shadow-[1px_0_0_#e2e8f0]">${th('name', 'Faculty')}</th>
    <th class="p-3 text-left">${th('arrival_at', 'Arrival · Pickup')}</th>
    <th class="p-3 text-left">${th('departure_at', 'Departure · Drop')}</th>
    <th class="p-3 text-left">${th('accommodation', 'Stay')}</th>
    <th class="p-3 text-left">${th('overall_status', 'Status')}</th>
    <th class="p-3"></th>
  </tr>`;
  const rows = filteredGuests();
  const keyOf = GUEST_SORTS[guestSort.key] || GUEST_SORTS.sr_no;
  rows.sort((a, b) => {
    const x = keyOf(a); const y = keyOf(b);
    return (x < y ? -1 : x > y ? 1 : a.sr_no - b.sr_no) * guestSort.dir;
  });
  // The Faculty column has a fixed width: a long designation (often a whole
  // affiliation) wraps to two lines, the rest on hover, instead of widening
  // the column at the expense of travel and stay.
  const line = (parts) => parts.filter(Boolean).map(esc).join(' · ');
  const notSet = '<span class="text-xs text-slate-400">Not set</span>';
  const travel = (...leg) => guestLegHtml(...leg) || notSet;
  tbody.innerHTML = rows.length ? rows.map((g) => `
    <tr class="${guestRowTint(g) || 'bg-white'} align-top">
      <td class="p-3 w-10 text-xs text-slate-400 font-mono sticky left-0 z-10 bg-inherit">${esc(g.sr_no)}</td>
      <td class="p-3 sticky left-10 z-10 bg-inherit shadow-[1px_0_0_#e2e8f0]">
        <div class="w-56 break-words">
          <p class="font-semibold ${g.cancelled ? 'line-through' : 'text-slate-800'}">${esc(g.name)}</p>
          ${g.designation ? `<p class="text-xs text-slate-500 line-clamp-2" title="${esc(g.designation)}">${esc(g.designation)}</p>` : ''}
          <p class="text-xs text-slate-500 font-mono">${esc(g.phone || '')}</p>
          <div class="flex flex-wrap gap-1 mt-1">${guestFlagChips(g)}</div>
          ${g.special_needs ? `<p class="text-[11px] font-semibold text-rose-700 mt-1" title="${esc(g.special_needs)}">Special needs: see the editor</p>` : ''}
          ${(g.sessions || []).length ? `<p class="text-[11px] font-semibold text-indigo-700 mt-1">${g.sessions.length} session${g.sessions.length === 1 ? '' : 's'} in the programme</p>` : ''}
        </div>
      </td>
      <td class="p-3">${travel(g.arrival_date, g.arrival_time, g.arrival_mode, g.arrival_number, g.arrival_point, g.pickup_vehicle, g.pickup_status)}</td>
      <td class="p-3">${travel(g.departure_date, g.departure_time, g.departure_mode, g.departure_number, g.departure_point, g.drop_vehicle, g.drop_status)}</td>
      <td class="p-3">${guestStayHtml(g) || notSet}</td>
      <td class="p-3">${guestStatusBadge(g.overall_status)}</td>
      <td class="p-3 text-right"><button type="button" onclick="openGuestEditor(${esc(g.id)})" class="px-3 py-1.5 bg-white border border-indigo-300 text-indigo-700 hover:bg-indigo-50 text-xs font-semibold rounded-lg">${can('guests.edit') || guestVolunteerOf(g).mineT || guestVolunteerOf(g).mineS ? 'Edit' : 'View'}</button></td>
    </tr>`).join('')
    : `<tr><td colspan="7" class="p-8 text-center text-slate-400 text-sm">${guestData.guests.length ? 'No one matches these filters.' : 'No faculty yet. Mark a delegate as faculty to start.'}</td></tr>`;
  // A card per person, for a phone (the table is hidden there).
  const cards = document.getElementById('guests-cards');
  if (cards) {
    const sortSel = document.getElementById('guests-sort-mobile');
    if (sortSel && sortSel.value !== guestSort.key && Array.from(sortSel.options || []).some((o) => o.value === guestSort.key)) sortSel.value = guestSort.key;
    const edge = (g) => (g.cancelled ? 'border-l-slate-300' : g.flags.noAccommodation ? 'border-l-rose-400' : g.flags.pickupAlert ? 'border-l-orange-400' : 'border-l-slate-200');
    const legLine = (label, date, time, mode, number, point, vehicle, status) => `<div class="flex gap-2 text-sm">
        <span class="w-16 shrink-0 text-[11px] font-semibold text-slate-400 uppercase pt-0.5">${label}</span>
        <div class="min-w-0">${guestLegHtml(date, time, mode, number, point, vehicle, status) || '<p class="text-xs text-slate-400 pt-0.5">Not set</p>'}</div>
      </div>`;
    cards.innerHTML = rows.length ? rows.map((g) => `
      <article class="bg-white rounded-2xl border border-slate-200 border-l-4 ${edge(g)} shadow-sm p-4 ${g.cancelled ? 'opacity-70' : ''}">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="font-bold ${g.cancelled ? 'line-through text-slate-500' : 'text-slate-800'}">${esc(g.name)}</p>
            ${g.designation ? `<p class="text-xs text-slate-500 line-clamp-2">${esc(g.designation)}</p>` : ''}
            ${g.phone ? `<p class="text-xs font-mono mt-0.5">${telLink(g.phone)}</p>` : ''}
          </div>
          <div class="shrink-0">${guestStatusBadge(g.overall_status)}</div>
        </div>
        ${guestFlagChips(g) ? `<div class="flex flex-wrap gap-1 mt-2">${guestFlagChips(g)}</div>` : ''}
        <div class="mt-3 space-y-2 border-t border-slate-100 pt-3">
          ${legLine('Arrival', g.arrival_date, g.arrival_time, g.arrival_mode, g.arrival_number, g.arrival_point, g.pickup_vehicle, g.pickup_status)}
          ${legLine('Departure', g.departure_date, g.departure_time, g.departure_mode, g.departure_number, g.departure_point, g.drop_vehicle, g.drop_status)}
          <div class="flex gap-2 text-sm">
            <span class="w-16 shrink-0 text-[11px] font-semibold text-slate-400 uppercase pt-0.5">Stay</span>
            <div class="min-w-0">${guestStayHtml(g) || '<p class="text-xs text-slate-400 pt-0.5">Not set</p>'}</div>
          </div>
          ${g.transport_coordinator_name || g.accommodation_coordinator_name ? `<p class="text-xs text-slate-500">Volunteers: ${esc([g.transport_coordinator_name && `Transport ${g.transport_coordinator_name}`, g.accommodation_coordinator_name && `Stay ${g.accommodation_coordinator_name}`].filter(Boolean).join(' · '))}</p>` : ''}
          ${g.special_needs ? `<p class="text-xs text-slate-600"><b>Needs:</b> ${esc(g.special_needs)}</p>` : ''}
        </div>
        <button type="button" onclick="openGuestEditor(${esc(g.id)})" class="mt-3 w-full h-10 bg-white border border-indigo-300 text-indigo-700 hover:bg-indigo-50 text-sm font-semibold rounded-xl">${can('guests.edit') || guestVolunteerOf(g).mineT || guestVolunteerOf(g).mineS ? 'Edit' : 'View'}</button>
      </article>`).join('')
      : `<p class="p-8 text-center text-slate-400 text-sm bg-white rounded-2xl border border-slate-200">${guestData.guests.length ? 'No one matches these filters.' : 'No faculty yet. Mark a delegate as faculty to start.'}</p>`;
  }
  const live = guestData.guests.filter((g) => !g.cancelled).length;
  setText('guests-count', `Showing ${rows.length} of ${guestData.guests.length} faculty (${live} not cancelled).`);
}

// --- 12-hour times ---------------------------------------------------------
// Shown and typed in 12-hour form; stored 24-hour (HH:MM), which is what
// sorts and what the time slots read.
function guestTime12(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return hhmm || '';
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}
// "20 November 2026, 9:30 AM", or just the date.
function guestWhen(date, time) {
  if (!date) return '';
  return `${formatFullDate(date) || date}${time ? `, ${guestTime12(time)}` : ''}`;
}
// Whatever has been entered for one leg of the journey, and nothing made up:
// the date and time, then mode / number / point, then vehicle and status.
// '' when nothing at all is set (the caller says "Not set").
// A pickup or drop "Not required" (guests.js NOT_REQUIRED): only that leg's
// date and time are collected; any mode, number, point or vehicle entered
// before is kept but not shown.
function transferNotRequired(status) {
  return String(status || '').trim().toLowerCase() === 'not required';
}
function guestLegHtml(date, time, mode, number, point, vehicle, status) {
  if (transferNotRequired(status)) {
    return (date ? `<p class="font-semibold text-slate-800">${esc(guestWhen(date, time))}</p>` : '')
      + `<p class="text-xs mt-0.5 text-slate-500">${esc(status)}</p>`;
  }
  const route = [mode, number, point].filter(Boolean).map(esc).join(' · ');
  const transfer = [vehicle ? esc(vehicle) : (date ? '<span class="text-slate-400">No vehicle</span>' : ''), status ? esc(status) : ''].filter(Boolean).join(' · ');
  return [
    date ? `<p class="font-semibold text-slate-800">${esc(guestWhen(date, time))}</p>` : '',
    route ? `<p class="text-xs text-slate-500">${route}</p>` : '',
    transfer ? `<p class="text-xs mt-0.5">${transfer}</p>` : '',
  ].join('');
}
// A date range as people write it: "20 - 23 Nov 2026"; across months
// "30 Nov - 2 Dec 2026"; across years "30 Dec 2026 - 2 Jan 2027"; one day
// "20 Nov 2026". Dates are YYYY-MM-DD.
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDateRange(from, to) {
  const part = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? { y: m[1], mon: SHORT_MONTHS[Number(m[2]) - 1], d: String(Number(m[3])) } : null; };
  const a = part(from);
  const b = part(to);
  if (!a || !b) return [from, to].filter(Boolean).join(' - ');
  if (from === to) return `${a.d} ${a.mon} ${a.y}`;
  if (a.y !== b.y) return `${a.d} ${a.mon} ${a.y} - ${b.d} ${b.mon} ${b.y}`;
  if (a.mon !== b.mon) return `${a.d} ${a.mon} - ${b.d} ${b.mon} ${b.y}`;
  return `${a.d} - ${b.d} ${b.mon} ${b.y}`;
}

// Whatever has been entered for the stay: the place and room, then type,
// dates (one alone is shown too) and nights. Arranging their own stay says
// so, and the details kept from before are not shown.
function guestStayHtml(g) {
  if (Number(g.stay_not_needed)) return '<p class="text-xs text-slate-500">Arranging their own stay</p>';
  const place = [g.accommodation, g.room_no ? (g.accommodation ? g.room_no : `Room ${g.room_no}`) : ''].filter(Boolean).map(esc).join(' · ');
  const dates = g.checkin_date && g.checkout_date ? shortDateRange(g.checkin_date, g.checkout_date)
    : g.checkin_date ? `From ${formatFullDate(g.checkin_date)}` : g.checkout_date ? `Until ${formatFullDate(g.checkout_date)}` : '';
  const detail = [g.room_type, dates, nightsLabel(guestNights(g.checkin_date, g.checkout_date))].filter(Boolean).map(esc).join(' · ');
  return [place ? `<p class="font-semibold text-slate-800">${place}</p>` : '', detail ? `<p class="text-xs text-slate-500">${detail}</p>` : ''].join('');
}

// Read what a coordinator types: "9:30 pm", "930p", "9.30 PM", "21:30",
// "2130", "9pm". Returns { hhmm } (24-hour), { empty }, { ambiguous } for an
// hour of 1-12 with no AM/PM, or { invalid }.
function parseTime12(raw) {
  let t = String(raw || '').trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ');
  if (!t) return { empty: true };
  let suffix = null;
  const sm = /\s*(am|a|pm|p)$/.exec(t);
  if (sm) { suffix = sm[1][0]; t = t.slice(0, sm.index).trim(); }
  let hs; let m;
  const parts = /^(\d{1,2})[: ](\d{2})$/.exec(t);
  if (parts) { hs = parts[1]; m = Number(parts[2]); }
  else if (/^\d{1,4}$/.test(t)) {
    if (t.length <= 2) { hs = t; m = 0; }
    else { hs = t.slice(0, t.length - 2); m = Number(t.slice(-2)); }
  } else return { invalid: true };
  let h = Number(hs);
  if (m > 59) return { invalid: true };
  if (suffix) {
    if (h < 1 || h > 12) return { invalid: true };
    h = (h % 12) + (suffix === 'p' ? 12 : 0);
  } else if (h > 23) {
    return { invalid: true };
  } else if (h >= 1 && h <= 12 && !(hs.length === 2 && hs[0] === '0')) {
    // "9:30" could be either; "09:30" or "0930" is 24-hour already.
    return { ambiguous: true };
  }
  return { hhmm: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` };
}
// The visible box: as they type, keep the hidden 24-hour value in step;
// on leaving it, tidy the box into "9:30 PM" or say what is wrong.
function onTime12Input(el) {
  const hidden = el.form && el.form.querySelector(`input[type="hidden"][name="${el.dataset.time12}"]`);
  const p = parseTime12(el.value);
  if (hidden) hidden.value = p.hhmm || '';
  el.dataset.invalid = p.hhmm || p.empty ? '' : '1';
  if (p.hhmm || p.empty) setTime12Error(el, '');
}
function onTime12Blur(el) {
  onTime12Input(el);
  const p = parseTime12(el.value);
  if (p.hhmm) el.value = guestTime12(p.hhmm);
  setTime12Error(el, p.ambiguous ? 'Add AM or PM, e.g. 9:30 PM.' : p.invalid ? 'Not a time. Try 9:30 AM.' : '');
}
function setTime12Error(el, msg) {
  const box = el.parentElement && el.parentElement.querySelector('[data-time12-error]');
  if (box) { box.textContent = msg; box.classList.toggle('hidden', !msg); }
  el.classList.toggle('border-rose-400', !!msg);
}
// The form follows what is chosen: the Flight/Train No field takes its
// name from the mode (and goes for Road), and ticking "accommodation not
// needed" hides the stay details -- kept, not deleted, so unticking brings
// them back.
function syncGuestModeFields(leg) {
  const form = document.getElementById('guest-edit-form');
  if (!form) return;
  const modeEl = form.querySelector(`[name="${leg}_mode"]`);
  const mode = String(modeEl ? modeEl.value : '').toLowerCase();
  const wrap = form.querySelector(`[data-number-for="${leg}"]`);
  if (!wrap) return;
  const label = wrap.querySelector('[data-number-label]');
  wrap.classList.toggle('hidden', mode === 'road');
  if (label) label.textContent = mode === 'flight' ? 'Flight No' : mode === 'train' ? 'Train No' : 'Flight/Train No';
}
// Nights between the check-in and check-out in the form, as they change.
function guestNights(checkin, checkout) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(checkin || '') || !re.test(checkout || '')) return null;
  const n = Math.round((Date.parse(`${checkout}T00:00:00Z`) - Date.parse(`${checkin}T00:00:00Z`)) / 864e5);
  return n >= 0 ? n : null;
}
const nightsLabel = (n) => (n == null ? '' : n === 0 ? 'Same day, no night' : `${n} night${n === 1 ? '' : 's'}`);
function syncGuestNights() {
  const form = document.getElementById('guest-edit-form');
  const out = document.getElementById('guest-nights');
  if (!form || !out) return;
  const cin = (form.querySelector('[name="checkin_date"]') || {}).value;
  const cout = (form.querySelector('[name="checkout_date"]') || {}).value;
  const n = guestNights(cin, cout);
  out.textContent = cin && cout && n == null ? 'Check-out is before check-in.' : nightsLabel(n);
  out.classList.toggle('text-rose-700', !!(cin && cout && n == null));
}

// Pickup or drop "Not required": the leg's details are not asked for.
function syncGuestTransferFields(leg) {
  const form = document.getElementById('guest-edit-form');
  const statusEl = form && form.querySelector(`[name="${leg === 'arrival' ? 'pickup_status' : 'drop_status'}"]`);
  const details = document.getElementById(`guest-${leg}-details`);
  const note = document.getElementById(`guest-${leg}-note`);
  if (!statusEl || !details) return;
  const off = transferNotRequired(statusEl.value);
  details.classList.toggle('hidden', off);
  if (note) note.classList.toggle('hidden', !off);
}

// Room No: the rooms on the Rooms list at the chosen accommodation, with
// their type and how many beds are taken (this person included, if they are
// in it). A room no longer on the list stays offered to whoever has it --
// keepUnlisted -- but is not offered once the accommodation changes.
function guestRoomOptionsHtml(accommodation, current, keepUnlisted) {
  const norm = (s) => String(s || '').trim().toLowerCase();
  if (!norm(accommodation)) return '<option value="">Choose the accommodation first</option>';
  const rooms = ((guestData && guestData.rooms) || []).filter((r) => norm(r.accommodation) === norm(accommodation));
  const listed = rooms.some((r) => norm(r.room_no) === norm(current));
  const label = (r) => [r.room_no, r.room_type, `${r.occupied} of ${r.beds} bed${r.beds === 1 ? '' : 's'} taken`].filter(Boolean).join(' · ')
    + (r.occupied >= r.beds && norm(r.room_no) !== norm(current) ? ' (full)' : '');
  return '<option value="">—</option>'
    + rooms.map((r) => `<option value="${esc(r.room_no)}" ${norm(r.room_no) === norm(current) ? 'selected' : ''}>${esc(label(r))}</option>`).join('')
    + (current && !listed && keepUnlisted ? `<option value="${esc(current)}" selected>${esc(current)} (not on the Rooms list)</option>` : '')
    + (rooms.length ? '' : '<option value="" disabled>No rooms listed here yet: add them under Rooms</option>');
}
function syncGuestRoomOptions() {
  const form = document.getElementById('guest-edit-form');
  const acc = form && form.querySelector('[name="accommodation"]');
  const room = form && form.querySelector('[name="room_no"]');
  if (!acc || !room) return;
  room.innerHTML = guestRoomOptionsHtml(acc.value, room.value, false);
}

function syncGuestStayFields() {
  const form = document.getElementById('guest-edit-form');
  const tickEl = form && form.querySelector('[name="stay_not_needed"]');
  const fields = document.getElementById('guest-stay-fields');
  const note = document.getElementById('guest-stay-note');
  if (!tickEl || !fields) return;
  fields.classList.toggle('hidden', tickEl.checked);
  if (note) note.classList.toggle('hidden', !tickEl.checked);
}

// Is the signed-in person this faculty member's transport or accommodation
// volunteer, with the permission to update that area?
function guestVolunteerOf(g) {
  const me = activeAdminUser && activeAdminUser.phone_number;
  return {
    mineT: !!me && can('guests.travel_assigned') && g.transport_coordinator === me,
    mineS: !!me && can('guests.stay_assigned') && g.accommodation_coordinator === me,
  };
}

// --- the editor ---
function openGuestEditor(id) {
  const g = guestData && guestData.guests.find((x) => x.id === id);
  if (!g) return;
  const travel = can('guests.travel');
  const stay = can('guests.stay');
  const shared = can('guests.edit');
  // A volunteer updates their own area for the faculty assigned to them
  // (the server checks the same: guests.js mayEditField).
  const { mineT, mineS } = guestVolunteerOf(g);
  const pickupOk = travel || mineT;
  const stayOk = stay || mineS;
  const lists = guestData.lists;
  const field = (name, label, html) => `<label class="block min-w-0"><span class="block text-[11px] font-semibold text-slate-600 mb-1">${esc(label)}</span>${html}</label>`;
  const cls = 'w-full h-9 px-2.5 border border-slate-300 rounded-lg text-sm bg-white outline-none disabled:bg-slate-50 disabled:text-slate-500';
  const input = (name, type, enabled, extra = '') =>
    `<input name="${name}" type="${type}" value="${esc(g[name] || '')}" ${enabled ? '' : 'disabled'} class="${cls}" ${extra}>`;
  const select = (name, listKey, enabled, extra = '') => {
    const values = [...(lists[listKey] || [])];
    if (g[name] && !values.includes(g[name])) values.push(g[name]);   // switched off since, still shown
    return `<select name="${name}" ${enabled ? '' : 'disabled'} class="${cls}" ${extra}><option value="">—</option>${values.map((v) => `<option value="${esc(v)}" ${v === g[name] ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>`;
  };
  const people = (name, pool, enabled) => {
    const opts = [...pool];
    if (g[name] && !opts.some((p) => p.phone === g[name])) opts.push({ phone: g[name], name: g[`${name}_name`] || g[name] });
    return `<select name="${name}" ${enabled ? '' : 'disabled'} class="${cls}"><option value="">—</option>${opts.map((p) => `<option value="${esc(p.phone)}" ${p.phone === g[name] ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`;
  };
  const vehicles = `<datalist id="guest-vehicle-options">${guestData.vehicles.map((v) => `<option value="${esc(v.label)}">${esc([v.driver_phone, v.seats ? `${v.seats} seats` : ''].filter(Boolean).join(' · '))}</option>`).join('')}</datalist>`;
  // 12-hour box; the hidden input under the field's name holds the 24-hour
  // value that is saved.
  const time = (name, enabled) => `<input type="hidden" name="${name}" value="${esc(g[name] || '')}" ${enabled ? '' : 'disabled'}>
      <input type="text" data-time12="${name}" value="${esc(guestTime12(g[name]))}" ${enabled ? '' : 'disabled'} autocomplete="off" placeholder="e.g. 9:30 AM"
        class="${cls}" oninput="onTime12Input(this)" onblur="onTime12Blur(this)">
      <p data-time12-error class="hidden text-[11px] text-rose-700 mt-1"></p>`;
  // The flight or train number, named after the mode (see syncGuestModeFields).
  const numberField = (leg) => `<label class="block min-w-0" data-number-for="${leg}"><span data-number-label class="block text-[11px] font-semibold text-slate-600 mb-1">Flight/Train No</span>${input(`${leg}_number`, 'text', travel)}</label>`;
  const modeSelect = (leg) => select(`${leg}_mode`, 'mode', travel, `onchange="syncGuestModeFields('${leg}')"`);
  // A pickup or drop "Not required" asks only for the date and time: the
  // rest of the leg is hidden (syncGuestTransferFields), and still saved
  // as it was.
  const legOff = (leg) => transferNotRequired(g[leg === 'arrival' ? 'pickup_status' : 'drop_status']);
  const legNote = (leg, what, hadDetails) => `<p id="guest-${leg}-note" class="${legOff(leg) ? '' : 'hidden '}col-span-full text-[11px] text-slate-500 -mt-1">${what} not required: only the date and time are needed.${hadDetails ? ' Details entered earlier are kept, unused, and return if you change the status.' : ''}</p>`;
  const legDetails = (leg, body) => `<div id="guest-${leg}-details" class="${legOff(leg) ? 'hidden ' : ''}col-span-full grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">${body}</div>`;
  const group = (title, enabled, note, body) => `<fieldset class="border border-slate-200 rounded-xl p-4">
      <legend class="px-1.5 text-xs font-bold text-slate-700 uppercase tracking-wide">${esc(title)}</legend>
      ${enabled ? '' : `<p class="text-[11px] text-slate-400 -mt-1 mb-2">${esc(note)}</p>`}
      <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">${body}</div></fieldset>`;
  document.getElementById('guest-edit-name').textContent = g.name;
  document.getElementById('guest-edit-who').textContent = g.linked
    ? [g.designation, g.phone, g.registration_number].filter(Boolean).join(' · ')
    : 'Not signed up yet — details as typed in, until linked to their account.';
  // Added by name: who they are is edited here, and they are linked to their
  // account once they have one.
  const identity = g.linked ? '' : group('Details', shared, '',
    field('guest_name', 'Name *', input('guest_name', 'text', shared, 'required maxlength="120"'))
    + field('guest_designation', 'Designation', input('guest_designation', 'text', shared, 'maxlength="300"'))
    + field('guest_phone', 'Phone', input('guest_phone', 'text', shared, 'inputmode="tel" maxlength="20"'))
    + field('guest_email', 'Email', input('guest_email', 'email', shared, 'maxlength="120"')))
    + (shared ? `<div class="mt-3 border border-sky-200 bg-sky-50 rounded-xl p-3">
        <p class="text-xs font-bold text-sky-900 mb-1">Link to their account</p>
        ${g.possible_account && !g.possible_account.taken
          ? `<p class="text-xs text-sky-900 mb-2">An account matches this phone or email: <b>${esc(g.possible_account.name)}</b>.
               <button type="button" onclick="linkGuest(${esc(g.id)}, '${esc(g.possible_account.phone_number)}')" class="ml-1 px-2.5 py-1 bg-sky-700 hover:bg-sky-800 text-white text-[11px] font-semibold rounded-md">Link to ${esc(g.possible_account.name)}</button></p>`
          : ''}
        <input id="guest-link-search" autocomplete="off" oninput="searchGuestLink(this.value)" placeholder="Find their account: name, mobile, email or ID" class="w-full h-9 px-3 border border-sky-200 rounded-lg text-sm bg-white outline-none">
        <div id="guest-link-results" class="mt-2 space-y-1.5"></div>
      </div>` : '');
  // Linked to the wrong person's account: unlink, and the entry is "not
  // signed up" again (PUT /api/guests/:id/unlink).
  const linkedTo = g.linked && shared ? `<div class="flex flex-wrap items-center justify-between gap-2 border border-slate-200 bg-slate-50 rounded-xl px-3 py-2.5">
      <p class="text-xs text-slate-600 min-w-0">Linked to their account: name, designation, phone and email come from it.</p>
      <button type="button" onclick="unlinkGuest(${esc(g.id)})" class="shrink-0 px-2.5 py-1 bg-white border border-slate-300 hover:bg-slate-100 text-slate-700 text-[11px] font-semibold rounded-md">Unlink from this account</button>
    </div><div class="h-4"></div>` : '';
  document.getElementById('guest-edit-flags').innerHTML = `${guestStatusBadge(g.overall_status)} ${guestFlagChips(g)}`;
  // Their sessions in the programme, to set travel by.
  const theirSessions = (g.sessions || []).length ? `<div class="rounded-xl border border-indigo-100 bg-indigo-50/50 px-3 py-2.5 space-y-1.5">
      <p class="text-xs font-bold text-slate-700 uppercase tracking-wide">In the programme</p>
      ${g.sessions.map((s) => `<p class="text-sm leading-snug"><span class="font-semibold text-indigo-800">${esc(s.role)}</span> · ${esc(guestWhen(s.date, s.start))} · ${esc(s.hall)}<span class="block text-slate-700">${esc(s.title)}</span></p>`).join('')}
    </div><div class="h-4"></div>` : '';
  // Not registered: a holder of payments.complimentary can register them
  // free from here -- a choice made for this one person.
  const registerFree = !g.registered && !g.cancelled && can('payments.complimentary')
    ? `<div class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-gold-300 bg-gold-50 px-3 py-2.5">
        <p class="text-xs text-slate-700 min-w-0">Not registered yet. If their registration is complimentary, register them with the fee waived.</p>
        <button type="button" onclick="registerFacultyFree(${esc(g.id)})" class="shrink-0 px-3 py-1.5 bg-navy hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg">Register free</button>
      </div><div class="h-4"></div>` : '';
  document.getElementById('guest-edit-body').innerHTML = vehicles + registerFree + identity + linkedTo + (identity ? '<div class="h-4"></div>' : '') + theirSessions + [
    group('Arrival', travel, mineT ? 'As their transport volunteer you can update the pickup; the itinerary is the coordinator\'s.' : 'Only a transport coordinator can change travel.',
      field('arrival_date', 'Date', input('arrival_date', 'date', travel))
      + field('arrival_time', 'Time', time('arrival_time', travel))
      + field('pickup_status', 'Pickup Status', select('pickup_status', 'transfer_status', pickupOk, `onchange="syncGuestTransferFields('arrival')"`))
      + legNote('arrival', 'Pickup', g.arrival_mode || g.arrival_number || g.arrival_point || g.pickup_vehicle)
      + legDetails('arrival',
        field('arrival_mode', 'Mode', modeSelect('arrival'))
        + numberField('arrival')
        + field('arrival_point', 'Point', select('arrival_point', 'point', travel))
        + field('pickup_vehicle', 'Pickup Vehicle/Driver', input('pickup_vehicle', 'text', pickupOk, 'list="guest-vehicle-options" autocomplete="off"')))),
    group('Departure', travel, mineT ? 'As their transport volunteer you can update the drop; the itinerary is the coordinator\'s.' : 'Only a transport coordinator can change travel.',
      field('departure_date', 'Date', input('departure_date', 'date', travel))
      + field('departure_time', 'Time', time('departure_time', travel))
      + field('drop_status', 'Drop Status', select('drop_status', 'transfer_status', pickupOk, `onchange="syncGuestTransferFields('departure')"`))
      + legNote('departure', 'Drop', g.departure_mode || g.departure_number || g.departure_point || g.drop_vehicle)
      + legDetails('departure',
        field('departure_mode', 'Mode', modeSelect('departure'))
        + numberField('departure')
        + field('departure_point', 'Point', select('departure_point', 'point', travel))
        + field('drop_vehicle', 'Drop Vehicle/Driver', input('drop_vehicle', 'text', pickupOk, 'list="guest-vehicle-options" autocomplete="off"')))),
    group('Stay', stay, mineS ? 'As their accommodation volunteer you can update the stay details.' : 'Only an accommodation coordinator can change the stay.',
      `<label class="col-span-full flex items-center gap-2 text-sm text-slate-700 ${stay ? 'cursor-pointer' : 'opacity-60'}">
        <input type="checkbox" name="stay_not_needed" ${Number(g.stay_not_needed) ? 'checked' : ''} ${stay ? '' : 'disabled'} onchange="syncGuestStayFields()"> Accommodation not needed — they arrange their own stay</label>
      <p id="guest-stay-note" class="${Number(g.stay_not_needed) ? '' : 'hidden'} col-span-full text-[11px] text-slate-500 -mt-1">No stay details needed.${g.accommodation ? ' Those entered earlier are kept, unused, and return if you untick this.' : ''}</p>
      <div id="guest-stay-fields" class="${Number(g.stay_not_needed) ? 'hidden ' : ''}col-span-full grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">`
      + field('accommodation', 'Accommodation', select('accommodation', 'accommodation', stayOk, 'onchange="syncGuestRoomOptions()"'))
      + field('room_no', 'Room No', `<select name="room_no" ${stayOk ? '' : 'disabled'} class="${cls}">${guestRoomOptionsHtml(g.accommodation, g.room_no, true)}</select>`)
      + field('checkin_date', 'Check-in Date', input('checkin_date', 'date', stayOk, 'onchange="syncGuestNights()"'))
      + field('checkout_date', 'Check-out Date', input('checkout_date', 'date', stayOk, 'onchange="syncGuestNights()"'))
      + field('room_type', 'Room Type', select('room_type', 'room_type', stayOk))
      + '<p id="guest-nights" class="col-span-full text-xs font-semibold text-slate-600 -mt-1"></p>'
      + '</div>'),
    group('Other', shared, '',
      field('overall_status', 'Overall Status', select('overall_status', 'overall_status', shared))
      // Only volunteers allotted to that area (the Volunteer – Transport /
      // Volunteer – Accommodation roles) are offered.
      + field('transport_coordinator', 'Transport Volunteer', people('transport_coordinator', guestData.coordinators.transport, travel)
        + (guestData.coordinators.transport.length ? '' : '<span class="block text-[11px] text-slate-400 mt-1">No transport volunteers yet: give someone the Volunteer – Transport role.</span>'))
      + field('accommodation_coordinator', 'Accommodation Volunteer', people('accommodation_coordinator', guestData.coordinators.accommodation, stay)
        + (guestData.coordinators.accommodation.length ? '' : '<span class="block text-[11px] text-slate-400 mt-1">No accommodation volunteers yet: give someone the Volunteer – Accommodation role.</span>'))
      + `<div class="col-span-full grid sm:grid-cols-2 gap-3">`
      + field('special_needs', 'Special Needs', `<textarea name="special_needs" rows="2" ${shared ? '' : 'disabled'} class="${cls} h-auto py-2">${esc(g.special_needs || '')}</textarea>`)
      + field('remarks', 'Remarks', `<textarea name="remarks" rows="2" ${shared ? '' : 'disabled'} class="${cls} h-auto py-2">${esc(g.remarks || '')}</textarea>`)
      + '</div>'),
  ].join('<div class="h-4"></div>');
  const form = document.getElementById('guest-edit-form');
  form.dataset.id = g.id;
  syncGuestModeFields('arrival');
  syncGuestModeFields('departure');
  syncGuestTransferFields('arrival');
  syncGuestTransferFields('departure');
  syncGuestStayFields();
  syncGuestNights();
  const save = document.getElementById('guest-save-btn');
  if (save) save.classList.toggle('hidden', !(travel || stay || shared || mineT || mineS));
  const remove = document.getElementById('guest-remove-btn');
  if (remove) remove.classList.toggle('hidden', !can('guests.manage'));
  openModal('modal-guest-edit');
}

async function saveGuest(ev) {
  ev.preventDefault();
  const form = document.getElementById('guest-edit-form');
  const id = form.dataset.id;
  const bad = [...form.querySelectorAll('[data-time12]')].find((el) => !el.disabled && el.dataset.invalid === '1');
  if (bad) { onTime12Blur(bad); bad.focus(); return showToast('Fix the time first: add AM or PM, e.g. 9:30 PM.'); }
  const fields = {};
  // Only what this role may edit: disabled controls are not sent.
  form.querySelectorAll('input[name], select[name], textarea[name]').forEach((el) => {
    if (!el.disabled) fields[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  });
  const btn = document.getElementById('guest-save-btn');
  if (btn) btn.disabled = true;
  const data = await (await fetch(`/api/guests/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }),
  })).json().catch(() => ({}));
  if (btn) btn.disabled = false;
  if (!data.success) return showToast(data.error || 'Could not save.');
  const told = (data.notified || []).map((s) => `the ${s === 'travel' ? 'transport' : 'accommodation'} volunteer`).join(' and ');
  showToast(data.changed ? `Saved.${told ? ` Emailed ${told}.` : ''}` : 'Nothing changed.', 'success');
  closeModal('modal-guest-edit');
  renderGuests();
}

async function removeGuest() {
  const id = document.getElementById('guest-edit-form').dataset.id;
  const g = guestData.guests.find((x) => String(x.id) === String(id));
  if (!g || !(await showConfirm(`Remove ${g.name} from the faculty list? They will no longer be marked as faculty, and their travel and stay details are deleted. This can't be undone. (To keep the record, set the Overall Status to Cancelled instead.)`))) return;
  const data = await (await fetch(`/api/guests/${encodeURIComponent(id)}`, { method: 'DELETE' })).json().catch(() => ({}));
  if (!data.success) return showToast(data.error || 'Could not remove.');
  showToast('Removed from the faculty list.', 'success');
  closeModal('modal-guest-edit');
  renderGuests();
}

// --- marking faculty ---
let facultySearchSeq = 0;
let facultyCandidates = [];
function openAddFaculty() {
  const input = document.getElementById('guest-add-search');
  if (input) input.value = '';
  document.getElementById('guest-add-results').innerHTML = '';
  openModal('modal-guest-add');
  if (input) input.focus();
}
async function searchFacultyCandidates(q) {
  const box = document.getElementById('guest-add-results');
  q = String(q || '').trim();
  if (q.length < 2) { box.innerHTML = ''; return; }
  const seq = ++facultySearchSeq;
  const res = await fetch(`/api/guests/candidates?q=${encodeURIComponent(q)}`);
  if (seq !== facultySearchSeq || !res.ok) return;   // a later keystroke has its own answer coming
  facultyCandidates = (await res.json()).results || [];
  box.innerHTML = facultyCandidates.length ? facultyCandidates.map((u, i) => `
    <div class="flex items-center justify-between gap-3 p-3 border border-slate-200 rounded-xl">
      <div class="min-w-0">
        <p class="font-semibold text-sm text-slate-800 truncate">${esc(u.name)}</p>
        <p class="text-[11px] text-slate-500 truncate">${esc([u.designation, u.phone, u.registration_number].filter(Boolean).join(' · '))}</p>
        <p class="mt-1">${u.staff ? guestPill('bg-slate-100 text-slate-700 border-slate-300', 'Staff') + ' ' : ''}${u.registered ? guestPill('bg-emerald-100 text-emerald-800 border-emerald-300', 'Registered') : guestPill(GUEST_FLAG_STYLES.notRegistered, 'Not registered yet')}</p>
      </div>
      ${u.guestId ? '<span class="text-xs font-semibold text-slate-400 shrink-0">Already faculty</span>'
        : `<button type="button" onclick="markFaculty(${i})" class="shrink-0 px-3 py-1.5 bg-navy hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg">Mark as faculty</button>`}
    </div>`).join('') : '<p class="text-xs text-slate-400 p-2">No delegate matches.</p>';
}
// From MGIMS or Sevagram (guests.js isLocalFaculty): the server set their
// pickup and drop to "Not required".
function localTransferNote(data) {
  return data && data.local ? ' From MGIMS/Sevagram, so pickup and drop are set to not required.' : '';
}
async function markFaculty(i, phoneOverride) {
  const phone = phoneOverride || (facultyCandidates[i] && facultyCandidates[i].phone_number);
  if (!phone) return;
  const data = await (await fetch('/api/guests', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }),
  })).json().catch(() => ({}));
  if (!data.success) return showToast(data.error || 'Could not mark them as faculty.');
  showToast((data.registered ? 'Marked as faculty. They are on the faculty list.'
    : 'Marked as faculty. They have not registered yet; the faculty list flags it until they do.') + localTransferNote(data), 'success');
  if (!phoneOverride) closeModal('modal-guest-add');
  if (guestData || currentBackendTab === 'faculty') renderGuests();
  return data;
}

async function addUnlinkedGuest(ev) {
  ev.preventDefault();
  const f = ev.target;
  const note = document.getElementById('guest-add-new-note');
  note.classList.add('hidden');
  const data = await (await fetch('/api/guests', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guest: { name: f.guestName.value, designation: f.guestDesignation.value, phone: f.guestPhone.value, email: f.guestEmail.value } }),
  })).json().catch(() => ({}));
  if (data.code === 'ACCOUNT_EXISTS' && data.account) {
    // They have an account after all: mark that, rather than typing them in twice.
    facultyCandidates = [{ phone_number: data.account.phone_number }];
    note.innerHTML = `${esc(data.error)}${data.account.guestId ? ''
      : ' <button type="button" onclick="markFaculty(0)" class="ml-1 px-2.5 py-1 bg-navy hover:bg-indigo-700 text-white text-[11px] font-semibold rounded-md">Mark as faculty</button>'}`;
    note.classList.remove('hidden');
    return;
  }
  if (!data.success) { note.textContent = data.error || 'Could not add them.'; note.classList.remove('hidden'); return; }
  showToast('Added. Link them to their account once they sign up.' + localTransferNote(data), 'success');
  f.reset();
  closeModal('modal-guest-add');
  renderGuests();
}

let guestLinkSeq = 0;
async function searchGuestLink(q) {
  const box = document.getElementById('guest-link-results');
  const id = document.getElementById('guest-edit-form').dataset.id;
  q = String(q || '').trim();
  if (q.length < 2) { box.innerHTML = ''; return; }
  const seq = ++guestLinkSeq;
  const res = await fetch(`/api/guests/candidates?q=${encodeURIComponent(q)}`);
  if (seq !== guestLinkSeq || !res.ok) return;
  const results = (await res.json()).results || [];
  box.innerHTML = results.length ? results.map((u) => `<div class="flex items-center justify-between gap-2 bg-white border border-sky-100 rounded-lg px-2.5 py-1.5">
      <span class="min-w-0 text-xs"><b class="text-slate-800">${esc(u.name)}</b>${u.staff ? ' <span class="text-[10px] font-bold text-slate-500">STAFF</span>' : ''} <span class="text-slate-500">${esc([u.phone, u.email].filter(Boolean).join(' · '))}</span></span>
      ${u.guestId ? '<span class="text-[11px] text-slate-400 shrink-0">Already faculty</span>'
        : `<button type="button" onclick="linkGuest(${esc(id)}, '${esc(u.phone_number)}')" class="shrink-0 px-2.5 py-1 bg-sky-700 hover:bg-sky-800 text-white text-[11px] font-semibold rounded-md">Link</button>`}
    </div>`).join('') : '<p class="text-xs text-sky-900/70">No account matches.</p>';
}

async function linkGuest(id, phone) {
  if (!(await showConfirm('Link them to that account? From now on their name, designation, phone and email come from the account.'))) return;
  const data = await (await fetch(`/api/guests/${encodeURIComponent(id)}/link`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }),
  })).json().catch(() => ({}));
  if (!data.success) return showToast(data.error || 'Could not link.');
  showToast((data.registered ? 'Linked to their account.' : 'Linked to their account. They have not registered yet.') + localTransferNote(data), 'success');
  closeModal('modal-guest-edit');
  renderGuests();
}

async function unlinkGuest(id) {
  const g = guestData && guestData.guests.find((x) => x.id === id);
  if (!g) return;
  if (!(await showConfirm(`Unlink this faculty entry from ${g.name}'s account? Use this when the account is a different person's. The entry, with its travel and stay, stays on the list as "not signed up"; then check the name and add their phone and email.`))) return;
  const data = await (await fetch(`/api/guests/${encodeURIComponent(id)}/unlink`, { method: 'PUT', headers: { 'Content-Type': 'application/json' } })).json().catch(() => ({}));
  if (!data.success) return showToast(data.error || 'Could not unlink.');
  showToast('Unlinked. They are now "not signed up": check their details, and link the right account if they have one.', 'success');
  await renderGuests();
  openGuestEditor(id);
}

// --- dashboard ---
function renderGuestDashboard() {
  const box = document.getElementById('guests-view-dashboard');
  const d = guestData.dashboard;
  const card = (title, body, tone = '') => `<div class="bg-white rounded-2xl border ${tone || 'border-slate-200'} p-4 shadow-sm">
      <h4 class="text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-2">${esc(title)}</h4>${body}</div>`;
  const big = (n, label, cls = 'text-slate-800') => `<p class="text-2xl font-extrabold tabular-nums ${cls}">${esc(n)}</p><p class="text-xs text-slate-500">${esc(label)}</p>`;
  const counts = (rows, notSet = 'Not set') => `<dl class="space-y-1 text-sm">${rows.map((r) => `<div class="flex justify-between gap-3">
      <dt class="${r.value == null ? 'text-slate-400 italic' : 'text-slate-600'}">${esc(r.value == null ? notSet : r.value)}</dt>
      <dd class="font-bold tabular-nums ${r.value == null && r.count ? 'text-amber-700' : 'text-slate-800'}">${esc(r.count)}</dd></div>`).join('')}</dl>`;
  const table = (cols, rows) => rows.length ? `<table class="w-full text-sm"><thead><tr>${cols.map((c, i) => `<th class="text-[11px] text-slate-400 font-semibold pb-1 ${i ? 'text-right' : 'text-left'}">${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td class="py-0.5 ${i ? 'text-right tabular-nums font-semibold' : 'text-slate-600'}">${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`
    : '<p class="text-xs text-slate-400">None yet.</p>';
  const movement = (m) => `<div class="grid sm:grid-cols-3 gap-4">
      <div><p class="text-[11px] text-slate-400 font-semibold mb-1">By date</p>${table(['Date', 'Faculty'], m.byDate.map((r) => [esc(formatFullDate(r.value)), esc(r.count)]))}</div>
      <div><p class="text-[11px] text-slate-400 font-semibold mb-1">By point</p>${table(['Point', 'Faculty'], m.byPoint.map((r) => [esc(r.value == null ? 'Not set' : r.value), esc(r.count)]))}</div>
      <div><p class="text-[11px] text-slate-400 font-semibold mb-1">By time</p>${table(['Slot', 'Faculty'], m.bySlot.map((r) => [esc(r.value == null ? 'Time not set' : r.value), esc(r.count)]))}</div>
    </div>`;
  const a = d.alert;
  box.innerHTML = `<div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
      ${card('Faculty', big(d.listed, `listed${d.cancelled ? ` · ${d.cancelled} cancelled not counted` : ''}`))}
      ${card(`Arriving in ${a.days} day(s)`, `${big(a.arriving, shortDateRange(a.from, a.to))}
        <p class="mt-1 text-xs font-semibold ${a.noVehicle ? 'text-orange-700' : 'text-emerald-700'}">${a.noVehicle ? `${a.noVehicle} with no pickup vehicle` : 'All have a pickup vehicle'}</p>`, a.noVehicle ? 'border-orange-300' : '')}
      ${card('No accommodation', big(d.noAccommodation, `faculty with nowhere to stay${d.ownStay ? ` · ${d.ownStay} arranging their own` : ''}`, d.noAccommodation ? 'text-rose-700' : 'text-slate-800'), d.noAccommodation ? 'border-rose-300' : '')}
      ${card('Not registered', big(d.notRegistered, `faculty who still have to register${d.notSignedUp ? ` · ${d.notSignedUp} not signed up` : ''}`, d.notRegistered ? 'text-sky-700' : 'text-slate-800'))}
    </div>
    <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
      ${card('Overall status (everyone)', counts(d.byOverallStatus))}
      ${card('Pickup status', counts(d.byPickupStatus))}
      ${card('Drop status', counts(d.byDropStatus))}
      ${card('Warnings', `<dl class="space-y-1 text-sm">
          <div class="flex justify-between"><dt class="text-slate-600">Rooms shared</dt><dd class="font-bold tabular-nums ${d.sharedRooms ? 'text-violet-700' : ''}">${esc(d.sharedRooms)}</dd></div>
          <div class="flex justify-between"><dt class="text-slate-600">Vehicle clashes</dt><dd class="font-bold tabular-nums ${d.vehicleClashes ? 'text-amber-700' : ''}">${esc(d.vehicleClashes)}</dd></div></dl>`)}
    </div>
    <div class="grid gap-3">
      ${card(`Arrivals · ${d.arrivals.total} with a date`, movement(d.arrivals))}
      ${card(`Departures · ${d.departures.total} with a date`, movement(d.departures))}
      ${card('Accommodation', table(['Accommodation', 'Faculty', 'Beds listed', 'Beds free'],
        d.perAccommodation.map((r) => [esc(r.accommodation), esc(r.assigned), esc(r.beds), `<span class="${r.free < 0 ? 'text-rose-700' : ''}">${esc(r.free < 0 ? `${-r.free} over` : r.free)}</span>`])))}
    </div>`;
}

// --- pickup and drop schedules ---
function renderGuestSchedule(kind) {
  const box = document.getElementById(`guests-view-${kind}`);
  const rows = guestData[kind];
  const isPickup = kind === 'pickups';
  const clashes = rows.filter((r) => r.clash.length).length;
  // "Not required": no vehicle is wanted, so none is missing.
  const noVehicle = (r, word) => (transferNotRequired(r.status) ? '<span class="text-slate-400">—</span>'
    : `<span class="${r.alert ? 'text-orange-700 font-semibold' : 'text-slate-400'}">${word}</span>`);
  const driverLine = (r) => (r.vehicle ? `${esc(r.vehicle)}${r.driverPhone ? ` · ${telLink(r.driverPhone)}` : ''}` : noVehicle(r, 'No vehicle'));
  box.innerHTML = `${clashes ? `<p class="mb-3 text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">${clashes} ${isPickup ? 'pickup' : 'drop'}(s) use a vehicle within ${esc(guestData.settings.clashMinutes)} minutes of another trip. Check each is intended — guests on the same flight can share.</p>` : ''}
    <div class="md:hidden space-y-2">${rows.length ? rows.map((r) => `
      <article class="bg-white rounded-2xl border border-slate-200 ${r.alert ? 'border-l-4 border-l-orange-400' : ''} shadow-sm p-3.5">
        <div class="flex items-baseline justify-between gap-2">
          <p class="font-bold ${r.at ? 'text-slate-800' : 'text-slate-400'}">${esc(r.at ? guestWhen(r.at.slice(0, 10), r.at.slice(11)) : 'Not set')}</p>
          ${r.status ? guestPill('bg-white text-slate-600 border-slate-300', r.status) : ''}
        </div>
        <button type="button" onclick="openGuestEditor(${esc(r.id)})" class="mt-1 font-semibold text-indigo-700 text-left">${esc(r.name)}</button>
        ${r.phone ? `<p class="text-xs font-mono">${telLink(r.phone)}</p>` : ''}
        <p class="text-xs text-slate-600 mt-1">${[esc(r.mode || ''), esc(r.number || ''), esc(r.point || '')].filter(Boolean).join(' · ') || '—'}</p>
        <p class="text-xs mt-1">${driverLine(r)}</p>
        ${r.clash.map((c) => `<p class="text-[11px] text-amber-800 mt-1">${esc(c)}</p>`).join('')}
      </article>`).join('') : '<p class="p-8 text-center text-slate-400 bg-white rounded-2xl border border-slate-200">No one to schedule yet.</p>'}</div>
    <div class="hidden md:block bg-white rounded-2xl border border-slate-200 shadow-sm overflow-x-auto">
      <table class="w-full text-sm min-w-[56rem]">
        <thead class="bg-slate-50 text-[11px] text-slate-500 uppercase tracking-wide"><tr>
          <th class="p-3 text-left">${isPickup ? 'Arrival' : 'Departure'}</th><th class="p-3 text-left">Name</th><th class="p-3 text-left">Phone</th>
          <th class="p-3 text-left">Mode</th><th class="p-3 text-left">Flight/Train No</th><th class="p-3 text-left">Point</th>
          <th class="p-3 text-left">Vehicle/Driver</th><th class="p-3 text-left">${isPickup ? 'Pickup' : 'Drop'} Status</th>
        </tr></thead>
        <tbody class="divide-y divide-slate-100">${rows.length ? rows.map((r) => `
          <tr class="${r.alert ? 'bg-orange-50' : ''} align-top">
            <td class="p-3 whitespace-nowrap font-semibold ${r.at ? 'text-slate-800' : 'text-slate-400'}">${esc(r.at ? guestWhen(r.at.slice(0, 10), r.at.slice(11)) : 'Not set')}</td>
            <td class="p-3"><button type="button" onclick="openGuestEditor(${esc(r.id)})" class="font-semibold text-indigo-700 hover:underline text-left">${esc(r.name)}</button></td>
            <td class="p-3 font-mono text-xs">${telLink(r.phone)}</td>
            <td class="p-3">${esc(r.mode || '—')}</td><td class="p-3">${esc(r.number || '—')}</td><td class="p-3">${esc(r.point || '—')}</td>
            <td class="p-3">${r.vehicle ? `<p>${esc(r.vehicle)}</p>${r.driverPhone ? `<p class="text-xs text-slate-500 font-mono">${telLink(r.driverPhone, 'text-slate-500 hover:underline')}</p>` : ''}` : noVehicle(r, 'None')}
              ${r.clash.map((c) => `<p class="text-[11px] text-amber-800 mt-1">${esc(c)}</p>`).join('')}</td>
            <td class="p-3">${r.status ? guestPill('bg-white text-slate-600 border-slate-300', r.status) : '<span class="text-xs text-slate-400">Not set</span>'}</td>
          </tr>`).join('') : '<tr><td colspan="8" class="p-8 text-center text-slate-400">No one to schedule yet.</td></tr>'}
        </tbody>
      </table>
    </div>
    <p class="text-xs text-slate-500 mt-2">Cancelled faculty are left out. Anyone with no ${isPickup ? 'arrival' : 'departure'} date is at the end.</p>`;
}

// --- vehicles ---
function renderGuestVehicles() {
  const box = document.getElementById('guests-view-vehicles');
  const edit = can('guests.travel');
  box.innerHTML = `${edit ? `<form id="guest-vehicle-form" onsubmit="saveGuestVehicle(event)" class="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm mb-3 grid sm:grid-cols-[2fr_1fr_6rem_auto_auto] gap-3 items-end">
      <input type="hidden" name="recordId">
      <label class="block"><span class="block text-[11px] font-semibold text-slate-600 mb-1">Vehicle / Driver</span><input name="label" required maxlength="120" placeholder="e.g. Innova MH32 AB 1234 · Ramesh" class="w-full h-9 px-2.5 border border-slate-300 rounded-lg text-sm"></label>
      <label class="block"><span class="block text-[11px] font-semibold text-slate-600 mb-1">Driver Phone</span><input name="driverPhone" inputmode="tel" class="w-full h-9 px-2.5 border border-slate-300 rounded-lg text-sm"></label>
      <label class="block"><span class="block text-[11px] font-semibold text-slate-600 mb-1">Seats</span><input name="seats" type="number" min="1" max="99" step="1" class="w-full h-9 px-2.5 border border-slate-300 rounded-lg text-sm"></label>
      <button type="submit" class="h-9 px-4 bg-navy hover:bg-indigo-700 text-white text-sm font-semibold rounded-lg">Save vehicle</button>
      <button type="button" onclick="this.form.reset()" class="h-9 px-3 border border-slate-300 text-slate-600 text-sm rounded-lg">Clear</button>
    </form>` : ''}
    <div class="md:hidden space-y-2">${guestData.vehicles.length ? guestData.vehicles.map((v) => `
      <article class="bg-white rounded-2xl border border-slate-200 shadow-sm p-3.5">
        <p class="font-semibold text-slate-800">${esc(v.label)}</p>
        <p class="text-xs text-slate-500">${[v.driver_phone ? telLink(v.driver_phone) : '', v.seats ? `${esc(v.seats)} seats` : ''].filter(Boolean).join(' · ') || '—'}</p>
        <p class="text-xs mt-1"><b>${esc(v.pickups)}</b> pickups · <b>${esc(v.drops)}</b> drops</p>
        ${edit || can('guests.manage') ? `<div class="flex gap-2 mt-2">${edit ? `<button type="button" onclick="editGuestVehicle(${esc(v.id)})" class="flex-1 h-9 border border-indigo-300 text-indigo-700 text-xs font-semibold rounded-lg">Edit</button>` : ''}${can('guests.manage') ? `<button type="button" onclick="deleteGuestVehicle(${esc(v.id)})" class="flex-1 h-9 border border-rose-300 text-rose-700 text-xs font-semibold rounded-lg">Delete</button>` : ''}</div>` : ''}
      </article>`).join('') : '<p class="p-6 text-center text-slate-400 bg-white rounded-2xl border border-slate-200">No vehicles yet.</p>'}</div>
    <div class="hidden md:block bg-white rounded-2xl border border-slate-200 shadow-sm overflow-x-auto">
      <table class="w-full text-sm"><thead class="bg-slate-50 text-[11px] text-slate-500 uppercase tracking-wide"><tr>
        <th class="p-3 text-left">Vehicle / Driver</th><th class="p-3 text-left">Driver Phone</th><th class="p-3 text-right">Seats</th>
        <th class="p-3 text-right">Pickups</th><th class="p-3 text-right">Drops</th><th class="p-3"></th></tr></thead>
      <tbody class="divide-y divide-slate-100">${guestData.vehicles.length ? guestData.vehicles.map((v) => `<tr>
        <td class="p-3 font-semibold text-slate-800">${esc(v.label)}</td><td class="p-3 font-mono text-xs">${v.driver_phone ? telLink(v.driver_phone) : '—'}</td>
        <td class="p-3 text-right tabular-nums">${esc(v.seats || '—')}</td><td class="p-3 text-right tabular-nums font-semibold">${esc(v.pickups)}</td>
        <td class="p-3 text-right tabular-nums font-semibold">${esc(v.drops)}</td>
        <td class="p-3 text-right whitespace-nowrap">${edit ? `<button type="button" onclick="editGuestVehicle(${esc(v.id)})" class="px-3 py-1.5 border border-indigo-300 text-indigo-700 hover:bg-indigo-50 text-xs font-semibold rounded-lg">Edit</button>` : ''}
          ${can('guests.manage') ? `<button type="button" onclick="deleteGuestVehicle(${esc(v.id)})" class="px-3 py-1.5 border border-rose-300 text-rose-700 hover:bg-rose-50 text-xs font-semibold rounded-lg">Delete</button>` : ''}</td>
      </tr>`).join('') : '<tr><td colspan="6" class="p-6 text-center text-slate-400">No vehicles yet.</td></tr>'}</tbody></table>
    </div>
    <p class="text-xs text-slate-500 mt-2">Pickups and drops count non-cancelled faculty whose Vehicle/Driver matches the label. A vehicle can also be typed freely; free text is not counted here.</p>`;
}
function editGuestVehicle(id) {
  const v = guestData.vehicles.find((x) => x.id === id);
  const f = document.getElementById('guest-vehicle-form');
  if (!v || !f) return;
  f.recordId.value = v.id; f.label.value = v.label; f.driverPhone.value = v.driver_phone || ''; f.seats.value = v.seats || '';
  f.label.focus();
}
async function saveGuestVehicle(ev) {
  ev.preventDefault();
  const f = ev.target;
  const id = f.recordId.value;
  const data = await (await fetch(id ? `/api/guests/vehicles/${encodeURIComponent(id)}` : '/api/guests/vehicles', {
    method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: f.label.value, driverPhone: f.driverPhone.value, seats: f.seats.value }),
  })).json().catch(() => ({}));
  if (!data.success) return showToast(data.error || 'Could not save the vehicle.');
  showToast(id ? 'Vehicle updated.' : 'Vehicle added.', 'success');
  renderGuests();
}
async function deleteGuestVehicle(id) {
  const v = guestData.vehicles.find((x) => x.id === id);
  if (!v || !(await showConfirm(`Delete ${v.label}? Faculty it was assigned to keep the text, but it is no longer counted or offered.`))) return;
  const data = await (await fetch(`/api/guests/vehicles/${encodeURIComponent(id)}`, { method: 'DELETE' })).json().catch(() => ({}));
  if (!data.success) return showToast(data.error || 'Could not delete.');
  showToast('Vehicle deleted.', 'success');
  renderGuests();
}

// --- rooms ---
const GUEST_ROOM_STATUS = {
  Vacant: 'bg-slate-100 text-slate-600 border-slate-300', 'Partly filled': 'bg-sky-100 text-sky-800 border-sky-300',
  Full: 'bg-emerald-100 text-emerald-800 border-emerald-300', 'Over capacity': 'bg-rose-100 text-rose-800 border-rose-300',
};
function renderGuestRooms() {
  const box = document.getElementById('guests-view-rooms');
  const edit = can('guests.stay');
  const opts = (list, blankLabel) => `<option value="">${esc(blankLabel)}</option>${(guestData.lists[list] || []).map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('')}`;
  box.innerHTML = `${edit ? `<form id="guest-room-form" onsubmit="saveGuestRoom(event)" class="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm mb-3 grid sm:grid-cols-[2fr_1fr_1fr_6rem_auto_auto] gap-3 items-end">
      <input type="hidden" name="recordId">
      <label class="block"><span class="block text-[11px] font-semibold text-slate-600 mb-1">Accommodation</span><select name="accommodation" required class="w-full h-9 px-2 border border-slate-300 rounded-lg text-sm bg-white">${opts('accommodation', 'Choose…')}</select></label>
      <label class="block"><span class="block text-[11px] font-semibold text-slate-600 mb-1">Room No — or a range</span><input name="roomNo" required maxlength="400" placeholder="101, or 1-10, or 101-105, 110" title="One room, a range (1-10, A1-A12) or a list (101-105, 110). A range adds every room with the same details." class="w-full h-9 px-2.5 border border-slate-300 rounded-lg text-sm"></label>
      <label class="block"><span class="block text-[11px] font-semibold text-slate-600 mb-1">Room Type</span><select name="roomType" class="w-full h-9 px-2 border border-slate-300 rounded-lg text-sm bg-white">${opts('room_type', '—')}</select></label>
      <label class="block"><span class="block text-[11px] font-semibold text-slate-600 mb-1">Beds</span><input name="beds" type="number" required min="1" max="20" step="1" class="w-full h-9 px-2.5 border border-slate-300 rounded-lg text-sm"></label>
      <button type="submit" class="h-9 px-4 bg-navy hover:bg-indigo-700 text-white text-sm font-semibold rounded-lg">Save room</button>
      <button type="button" onclick="this.form.reset()" class="h-9 px-3 border border-slate-300 text-slate-600 text-sm rounded-lg">Clear</button>
    </form>` : ''}
    <div class="md:hidden space-y-2">${guestData.rooms.length ? guestData.rooms.map((r) => `
      <article class="bg-white rounded-2xl border border-slate-200 shadow-sm p-3.5">
        <div class="flex items-baseline justify-between gap-2">
          <p class="font-semibold text-slate-800">${esc(r.accommodation)} · ${esc(r.room_no)}</p>
          ${guestPill(GUEST_ROOM_STATUS[r.status] || '', r.status)}
        </div>
        <p class="text-xs text-slate-500">${[r.room_type, `${r.occupied} of ${r.beds} bed${r.beds === 1 ? '' : 's'}`].filter(Boolean).map(esc).join(' · ')}</p>
        ${r.guests.length ? `<p class="text-xs text-slate-600 mt-1">${esc(r.guests.join(', '))}</p>` : ''}
        ${edit || can('guests.manage') ? `<div class="flex gap-2 mt-2">${edit ? `<button type="button" onclick="editGuestRoom(${esc(r.id)})" class="flex-1 h-9 border border-indigo-300 text-indigo-700 text-xs font-semibold rounded-lg">Edit</button>` : ''}${can('guests.manage') ? `<button type="button" onclick="deleteGuestRoom(${esc(r.id)})" class="flex-1 h-9 border border-rose-300 text-rose-700 text-xs font-semibold rounded-lg">Delete</button>` : ''}</div>` : ''}
      </article>`).join('') : '<p class="p-6 text-center text-slate-400 bg-white rounded-2xl border border-slate-200">No rooms yet.</p>'}</div>
    <div class="hidden md:block bg-white rounded-2xl border border-slate-200 shadow-sm overflow-x-auto">
      <table class="w-full text-sm min-w-[44rem]"><thead class="bg-slate-50 text-[11px] text-slate-500 uppercase tracking-wide"><tr>
        <th class="p-3 text-left">Accommodation</th><th class="p-3 text-left">Room No</th><th class="p-3 text-left">Type</th>
        <th class="p-3 text-right">Beds</th><th class="p-3 text-right">Occupied</th><th class="p-3 text-left">Status</th><th class="p-3 text-left">Faculty</th><th class="p-3"></th></tr></thead>
      <tbody class="divide-y divide-slate-100">${guestData.rooms.length ? guestData.rooms.map((r) => `<tr class="align-top">
        <td class="p-3 font-semibold text-slate-800">${esc(r.accommodation)}</td><td class="p-3">${esc(r.room_no)}</td><td class="p-3">${esc(r.room_type || '—')}</td>
        <td class="p-3 text-right tabular-nums">${esc(r.beds)}</td><td class="p-3 text-right tabular-nums font-semibold">${esc(r.occupied)}</td>
        <td class="p-3">${guestPill(GUEST_ROOM_STATUS[r.status] || '', r.status)}</td>
        <td class="p-3 text-xs text-slate-600">${esc(r.guests.join(', ') || '—')}</td>
        <td class="p-3 text-right whitespace-nowrap">${edit ? `<button type="button" onclick="editGuestRoom(${esc(r.id)})" class="px-3 py-1.5 border border-indigo-300 text-indigo-700 hover:bg-indigo-50 text-xs font-semibold rounded-lg">Edit</button>` : ''}
          ${can('guests.manage') ? `<button type="button" onclick="deleteGuestRoom(${esc(r.id)})" class="px-3 py-1.5 border border-rose-300 text-rose-700 hover:bg-rose-50 text-xs font-semibold rounded-lg">Delete</button>` : ''}</td>
      </tr>`).join('') : '<tr><td colspan="8" class="p-6 text-center text-slate-400">No rooms yet.</td></tr>'}</tbody></table>
    </div>
    ${guestData.unlistedRooms.length ? `<p class="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-3">Faculty are placed in rooms not on this list: ${guestData.unlistedRooms.map((r) => `${esc(r.accommodation)} ${esc(r.room_no)} (${esc(r.guests.join(', '))})`).join('; ')}. Add them so their beds are counted.</p>` : ''}
    <p class="text-xs text-slate-500 mt-2">Occupied counts non-cancelled faculty with the same Accommodation and Room No.</p>`;
}
function editGuestRoom(id) {
  const r = guestData.rooms.find((x) => x.id === id);
  const f = document.getElementById('guest-room-form');
  if (!r || !f) return;
  // A value switched off since still needs to be selectable here.
  for (const [sel, v] of [[f.accommodation, r.accommodation], [f.roomType, r.room_type]]) {
    if (v && ![...sel.options].some((o) => o.value === v)) sel.insertAdjacentHTML('beforeend', `<option value="${esc(v)}">${esc(v)}</option>`);
  }
  f.recordId.value = r.id; f.accommodation.value = r.accommodation; f.roomNo.value = r.room_no; f.roomType.value = r.room_type || ''; f.beds.value = r.beds;
  f.roomNo.focus();
}
async function saveGuestRoom(ev) {
  ev.preventDefault();
  const f = ev.target;
  const id = f.recordId.value;
  const data = await (await fetch(id ? `/api/guests/rooms/${encodeURIComponent(id)}` : '/api/guests/rooms', {
    method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accommodation: f.accommodation.value, roomNo: f.roomNo.value, roomType: f.roomType.value, beds: f.beds.value }),
  })).json().catch(() => ({}));
  if (!data.success) return showToast(data.error || 'Could not save the room.');
  if (id) showToast('Room updated.', 'success');
  else {
    const made = (data.created || []).length;
    const already = data.skipped || [];
    showToast(`${made === 1 ? 'Room added' : `${made} rooms added`}.${already.length ? ` Already on the list, so skipped: ${already.join(', ')}.` : ''}`, 'success');
  }
  renderGuests();
}
async function deleteGuestRoom(id) {
  const r = guestData.rooms.find((x) => x.id === id);
  if (!r || !(await showConfirm(`Delete ${r.accommodation} room ${r.room_no}? Faculty placed there keep it on their record, but its beds are no longer counted.`))) return;
  const data = await (await fetch(`/api/guests/rooms/${encodeURIComponent(id)}`, { method: 'DELETE' })).json().catch(() => ({}));
  if (!data.success) return showToast(data.error || 'Could not delete.');
  showToast('Room deleted.', 'success');
  renderGuests();
}

// --- lists and settings (guests.manage) ---
function renderGuestSettings() {
  const box = document.getElementById('guests-view-settings');
  const s = guestData.settings;
  const byList = {};
  for (const r of guestData.listRows) (byList[r.list_key] = byList[r.list_key] || []).push(r);
  const btn = 'px-2 py-1 border border-slate-300 hover:bg-slate-50 text-slate-600 text-[11px] font-semibold rounded-md disabled:opacity-40';
  box.innerHTML = `<form onsubmit="saveGuestSettings(event)" class="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm mb-4">
      <h4 class="text-sm font-bold text-slate-800 mb-3">Settings</h4>
      <div class="grid sm:grid-cols-3 gap-3 items-end">
        <label class="block"><span class="block text-[11px] font-semibold text-slate-600 mb-1">Arrival alert window (days)</span><input name="alertDays" type="number" min="0" max="30" step="1" value="${esc(s.alertDays)}" class="w-full h-9 px-2.5 border border-slate-300 rounded-lg text-sm"></label>
        <label class="block"><span class="block text-[11px] font-semibold text-slate-600 mb-1">Vehicle clash window (minutes)</span><input name="clashMinutes" type="number" min="1" max="720" step="1" value="${esc(s.clashMinutes)}" class="w-full h-9 px-2.5 border border-slate-300 rounded-lg text-sm"></label>
        <div><span class="block text-[11px] font-semibold text-slate-600 mb-1">Time slots start (Morning / Afternoon / Evening, hour)</span>
          <div class="flex gap-2">${s.slotBounds.map((h, i) => `<input name="slot${i}" type="number" min="1" max="23" step="1" value="${esc(h)}" class="w-full h-9 px-2.5 border border-slate-300 rounded-lg text-sm">`).join('')}</div></div>
      </div>
      <p class="text-[11px] text-slate-500 mt-2">Now: ${esc(guestData.slotLabels.join(' · '))}.</p>
      <button type="submit" class="mt-3 h-9 px-4 bg-navy hover:bg-indigo-700 text-white text-sm font-semibold rounded-lg">Save settings</button>
    </form>
    <div class="grid md:grid-cols-2 xl:grid-cols-3 gap-3">${Object.entries(guestData.listLabels).map(([key, label]) => `
      <div class="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
        <h4 class="text-sm font-bold text-slate-800 mb-2">${esc(label)}</h4>
        <ul class="divide-y divide-slate-100">${(byList[key] || []).map((r, i, all) => `<li class="py-1.5 flex items-center gap-2">
          <span class="flex-1 text-sm ${r.active ? 'text-slate-800' : 'text-slate-400 line-through'}">${esc(r.value)}${r.protected ? ' <span class="text-[10px] text-slate-400">(required)</span>' : ''}${r.inUse ? ` <span class="text-[10px] text-slate-400">· used ${esc(r.inUse)}</span>` : ''}</span>
          <button type="button" class="${btn}" ${i === 0 ? 'disabled' : ''} onclick="updateGuestListValue(${esc(r.id)}, { move: 'up' })" aria-label="Move up">▲</button>
          <button type="button" class="${btn}" ${i === all.length - 1 ? 'disabled' : ''} onclick="updateGuestListValue(${esc(r.id)}, { move: 'down' })" aria-label="Move down">▼</button>
          ${r.protected ? '' : `<button type="button" class="${btn}" onclick="updateGuestListValue(${esc(r.id)}, { active: ${r.active ? 'false' : 'true'} })">${r.active ? 'Switch off' : 'Switch on'}</button>`}
          ${r.protected || r.inUse ? '' : `<button type="button" class="${btn} text-rose-700 border-rose-300" onclick="deleteGuestListValue(${esc(r.id)})">Remove</button>`}
        </li>`).join('')}</ul>
        <form onsubmit="addGuestListValue(event, '${esc(key)}')" class="flex gap-2 mt-2">
          <input name="newValue" maxlength="80" required placeholder="Add a value" class="flex-1 h-8 px-2.5 border border-slate-300 rounded-lg text-sm">
          <button type="submit" class="h-8 px-3 bg-navy hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg">Add</button>
        </form>
      </div>`).join('')}</div>
    <p class="text-xs text-slate-500 mt-2">Switching a value off stops it being offered; anyone who already has it keeps it. A value in use cannot be removed.</p>`;
}
async function saveGuestSettings(ev) {
  ev.preventDefault();
  const f = ev.target;
  const data = await (await fetch('/api/guests/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ alertDays: Number(f.alertDays.value), clashMinutes: Number(f.clashMinutes.value), slotBounds: [0, 1, 2].map((i) => Number(f[`slot${i}`].value)) }),
  })).json().catch(() => ({}));
  if (!data.success) return showToast(data.error || 'Could not save the settings.');
  showToast('Settings saved.', 'success');
  renderGuests();
}
async function addGuestListValue(ev, listKey) {
  ev.preventDefault();
  const data = await (await fetch('/api/guests/lists', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ listKey, value: ev.target.newValue.value }),
  })).json().catch(() => ({}));
  if (!data.success) return showToast(data.error || 'Could not add it.');
  renderGuests();
}
async function updateGuestListValue(id, change) {
  const data = await (await fetch(`/api/guests/lists/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change),
  })).json().catch(() => ({}));
  if (!data.success) return showToast(data.error || 'Could not change it.');
  renderGuests();
}
async function deleteGuestListValue(id) {
  const r = guestData.listRows.find((x) => x.id === id);
  if (!r || !(await showConfirm(`Remove "${r.value}" from the ${guestData.listLabels[r.list_key]} list?`))) return;
  const data = await (await fetch(`/api/guests/lists/${encodeURIComponent(id)}`, { method: 'DELETE' })).json().catch(() => ({}));
  if (!data.success) return showToast(data.error || 'Could not remove it.');
  renderGuests();
}

const SETTINGS_TABS = ['attendance', 'programme', 'programs', 'fees', 'general', 'reminders', 'groupdiscount', 'discount', 'users', 'roles', 'activity'];
// 'payments' and 'statement' are two screens of the Registration tab.
const MAIN_TABS = ['overview', 'desk', 'payments', 'statement', 'abstracts', 'faculty', 'reports'];

// Which tabs each role may open -- the single source of truth used both to
// pick the landing tab and to validate a tab restored from the URL, so a
// bookmarked #users can't drop a finance admin on a section they can't see.
// Mirrors the show/hide rules in applyRoleVisibility().
function allowedBackendTabs() {
  return Object.keys(mySections).filter((key) => mySections[key]);
}

// The tab currently shown. Kept so the hashchange listener can tell a
// user-driven back/forward from the hash we just wrote ourselves.
let currentBackendTab = null;

function switchBackendTab(tab) {
  currentBackendTab = tab;
  // Persist in the URL so a refresh (or a bookmark, or back/forward) returns
  // to the section you were on instead of snapping back to the role default.
  if (window.location.hash.slice(1) !== tab) {
    history.replaceState(null, '', `#${tab}`);
  }
  // Every section was only ever fetched once at initial page load, so
  // switching away and back (or another admin changing something in the
  // meantime) showed stale data until a full page refresh. Refetch whatever
  // the tab being switched to actually shows, every time it's switched to --
  // each render function already no-ops if its container isn't in the DOM
  // or the API 403s for this role, so it's safe to call regardless of the
  // viewer's role.
  if (tab === 'overview') { renderBackendOverview(); renderDelegateMap(); }
  if (tab === 'desk') initFrontDesk();
  if (tab === 'payments') renderBackendPayments();
  if (tab === 'abstracts') renderBackendAbstracts();
  if (tab === 'reports') loadReportWorkshopOptions();
  if (tab === 'faculty') renderGuests();
  if (tab === 'attendance') renderAttendance();
  if (tab === 'programme') renderProgramme();
  if (tab === 'programs') renderBackendPrograms();
  if (tab === 'fees') renderBackendFees();
  if (tab === 'discount') renderDiscountCodes();
  if (tab === 'groupdiscount') { renderGroupRules(); renderGroupsMonitor(); }
  if (tab === 'general') renderGeneralSettings();
  if (tab === 'activity') renderBackendActivity();
  if (tab === 'users') loadBackendUsers();
  if (tab === 'roles') loadBackendRoles();
  if (tab === 'reminders') renderReminders();
  [...MAIN_TABS, ...SETTINGS_TABS].forEach(t => {
    const section = document.getElementById(`section-${t}`);
    if (section) section.classList.toggle('hidden', t !== tab);

    const btn = document.getElementById(`nav-tab-${t}`);
    if (btn) {
      const active = t === tab || (t === 'payments' && tab === 'statement');
      btn.setAttribute('aria-current', active ? 'page' : 'false');
    }
  });

  // Mark whichever Settings item is open, and Settings itself in the bar,
  // since those screens live in its drop-down rather than among the desks.
  SETTINGS_TABS.forEach((key) => {
    const item = document.getElementById(`settings-item-${key}`);
    if (item) item.setAttribute('aria-current', key === tab ? 'page' : 'false');
  });
  const settingsBtn = document.getElementById('settings-menu-btn');
  if (settingsBtn) settingsBtn.setAttribute('aria-current', SETTINGS_TABS.includes(tab) ? 'page' : 'false');
  closeAdminMenus();

  // Registration's sub-menu, while either of its two screens is open and the
  // role may open both.
  const regScreen = tab === 'payments' || tab === 'statement';
  const regStrip = document.getElementById('reg-subtabs');
  if (regStrip) regStrip.classList.toggle('hidden', !(regScreen && canSee('payments') && canSee('statement')));
  document.querySelectorAll('.reg-subtab').forEach((b) => {
    const on = b.id === `reg-subtab-${tab}`;
    b.classList.toggle('bg-navy', on);
    b.classList.toggle('text-white', on);
    b.classList.toggle('text-slate-600', !on);
    b.classList.toggle('hover:bg-slate-100', !on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });

  if (tab === 'statement') loadReconciliation();
}

// Follow the hash if it changes from outside our own navigation -- editing it
// in the address bar, or following a link to #general. switchBackendTab writes
// it with replaceState (no new history entry, so clicking through tabs doesn't
// bury the previous page behind a dozen Back presses), which doesn't emit
// hashchange, and the guard below ignores a tab already showing.
// The tab named in the address. #guests was the Faculty tab's first name;
// old bookmarks and links still open it.
function tabFromHash() {
  const tab = window.location.hash.slice(1);
  return tab === 'guests' ? 'faculty' : tab;
}

window.addEventListener('hashchange', () => {
  const tab = tabFromHash();
  if (!tab || tab === currentBackendTab || !activeAdminUser) return;
  if (allowedBackendTabs().includes(tab)) switchBackendTab(tab);
});

// --- ATTENDANCE (admin) ---
// At a hall door: the hall, what is on there now, and marking people present
// by badge. Then the counts, session by session, and who was present.
const attState = { halls: [], summary: null, roster: null, scanner: null, lastScan: { text: '', at: 0 }, pending: null, programme: null };
const ATT_METHODS = { SCAN: 'Scanned at the door', SELF: 'Scanned the hall QR', MANUAL: 'Marked by hand', DESK: 'At the desk' };
const sessionTimes = (s) => `${guestTime12(s.start)} – ${guestTime12(s.end)}`;

async function renderAttendanceView() {
  const mayMark = can('attendance.mark');
  const mayView = can('attendance.view');
  document.getElementById('att-take').classList.toggle('hidden', !mayMark);
  document.getElementById('att-summary-card').classList.toggle('hidden', !mayView);
  document.getElementById('att-roster-card').classList.toggle('hidden', !mayView);
  document.getElementById('att-manual').classList.toggle('hidden', !can('attendance.manage'));
  if (mayMark) {
    const res = await fetch('/api/attendance/halls');
    if (res.ok) attState.halls = (await res.json()).halls || [];
    const picker = document.getElementById('att-hall');
    const keep = picker.value || storageGet('local', 'nqocn_att_hall');
    picker.innerHTML = attState.halls.map((h) => `<option value="${esc(h.id)}">${esc(h.name)}${h.now ? ' — on now' : ''}</option>`).join('')
      || '<option value="">No halls yet -- add them under Settings → Programme</option>';
    if (attState.halls.some((h) => String(h.id) === String(keep))) picker.value = keep;
    onAttendanceHallChange();
  }
  if (mayView) {
    const res = await fetch('/api/attendance/summary');
    if (res.ok) attState.summary = await res.json();
    const s = attState.summary;
    if (!s) return;
    setText('att-completed', `${s.completed} of ${s.registered} have completed the conference`);
    const days = [...new Set(s.sessions.map((x) => x.date))].sort();
    const daySel = document.getElementById('att-day');
    const keepDay = daySel.value;
    const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
    daySel.innerHTML = days.map((d) => `<option value="${esc(d)}">${esc(formatFullDate(d))}</option>`).join('') || '<option value="">No sessions yet</option>';
    daySel.value = days.includes(keepDay) ? keepDay : (days.includes(today) ? today : (days[0] || ''));
    renderAttendanceSummary();
    const rosterSel = document.getElementById('att-roster-session');
    const keepSession = rosterSel.value;
    rosterSel.innerHTML = s.sessions.map((x) => `<option value="${esc(x.id)}">${esc(shortDateRange(x.date, x.date))} · ${esc(guestTime12(x.start))} · ${esc(x.hall)} · ${esc(x.title)}</option>`).join('')
      || '<option value="">No sessions take attendance yet</option>';
    const hallNow = attState.halls.find((h) => String(h.id) === document.getElementById('att-hall').value);
    if (s.sessions.some((x) => String(x.id) === keepSession)) rosterSel.value = keepSession;
    else if (hallNow && hallNow.now) rosterSel.value = String(hallNow.now.id);
    if (rosterSel.value) await loadAttendanceRoster();
  }
}

function onAttendanceHallChange() {
  const id = document.getElementById('att-hall').value;
  storageSet('local', 'nqocn_att_hall', id);
  const h = attState.halls.find((x) => String(x.id) === String(id));
  const box = document.getElementById('att-now');
  if (!h) { box.innerHTML = ''; return; }
  box.innerHTML = h.now
    ? `<div class="rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2"><span class="text-[11px] font-bold text-emerald-700 uppercase tracking-wide">On now</span>
        <span class="block font-semibold text-slate-800">${esc(h.now.label ? `${h.now.label}: ` : '')}${esc(h.now.title)}</span>
        <span class="block text-xs text-slate-500">${esc(sessionTimes(h.now))}${h.now.workshop ? ' · workshop: those enrolled' : ''}</span></div>`
    : `<div class="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-amber-900">Nothing is on in ${esc(h.name)} now.${h.next
      ? ` Next: <b>${esc(h.next.title)}</b>, ${esc(shortDateRange(h.next.date, h.next.date))} ${esc(guestTime12(h.next.start))}.` : ''}</div>`;
  hideAttendanceLetIn();
}

function showAttendanceResult(kind, title, detail) {
  const box = document.getElementById('att-result');
  const tone = { ok: 'bg-emerald-50 border-emerald-300 text-emerald-900', again: 'bg-sky-50 border-sky-300 text-sky-900', bad: 'bg-rose-50 border-rose-300 text-rose-900', warn: 'bg-amber-50 border-amber-300 text-amber-900' }[kind];
  const mark = { ok: '✓', again: '✓', bad: '✕', warn: '!' }[kind];
  box.className = `mt-3 rounded-xl px-4 py-3 border ${tone}`;
  box.innerHTML = `<p class="text-lg sm:text-xl font-extrabold">${mark} ${esc(title)}</p>${detail ? `<p class="text-sm mt-0.5">${esc(detail)}</p>` : ''}`;
  const scanLine = document.getElementById('att-scan-result');
  if (scanLine) { scanLine.className = `p-4 text-center text-base font-bold ${tone}`; scanLine.textContent = `${mark} ${title}${detail ? ` — ${detail}` : ''}`; }
}

function hideAttendanceLetIn() {
  document.getElementById('att-notenrolled').classList.add('hidden');
  attState.pending = null;
}

async function attendanceSignIn(identifier, notEnrolledReason) {
  const id = String(identifier || '').trim();
  const hallId = document.getElementById('att-hall').value;
  if (!id) return showToast('Scan a badge, or type an ID, mobile or email.');
  if (!hallId) return showToast('Choose the hall.');
  const res = await fetch('/api/attendance/scan', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: id, hallId: Number(hallId), notEnrolledReason: notEnrolledReason || undefined }),
  });
  const data = await res.json();
  if (data.success) {
    hideAttendanceLetIn();
    document.getElementById('att-id').value = '';
    if (data.already) showAttendanceResult('again', `${data.name}: already marked`, `${data.session.title}, at ${fmtAuditTime(data.at)}`);
    else showAttendanceResult('ok', data.name, data.session.title);
    return data;
  }
  if (data.notEnrolled) {
    attState.pending = id;
    showAttendanceResult('warn', data.name || 'Not enrolled', data.error);
    document.getElementById('att-notenrolled').classList.remove('hidden');
    document.getElementById('att-notenrolled-reason').value = '';
    return data;
  }
  showAttendanceResult('bad', data.name || 'Not marked', data.error || 'Could not mark them present.');
  return data;
}

function attendanceLetIn() {
  const reason = document.getElementById('att-notenrolled-reason').value.trim();
  if (!reason) return showToast('Give a reason -- it is kept with the record.');
  if (attState.pending) attendanceSignIn(attState.pending, reason);
}

// The camera stays open: scan one badge after another. The same code read
// twice within a few seconds (the camera seeing it again) counts once.
async function openAttendanceScanner() {
  const h = attState.halls.find((x) => String(x.id) === document.getElementById('att-hall').value);
  if (!h) return showToast('Choose the hall.');
  setText('att-scan-event', h.now ? `${h.name}: ${h.now.title}` : h.name);
  const line = document.getElementById('att-scan-result');
  line.className = 'p-4 text-center text-sm font-semibold text-slate-600';
  line.textContent = 'Starting the camera…';
  openModal('modal-att-scan');
  try {
    if (!window.Html5Qrcode) await loadScriptOnce(DESK_SCANNER_SRC);
    attState.scanner = new window.Html5Qrcode('att-scan-reader');
    await attState.scanner.start({ facingMode: 'environment' },
      { fps: 10, qrbox: (w, ht) => { const side = Math.floor(Math.min(w, ht) * 0.75); return { width: side, height: side }; } },
      (text) => onAttendanceScan(text), () => {});
    line.textContent = 'Point the camera at a badge.';
  } catch (e) {
    line.textContent = 'The camera could not start. Allow camera access for this site, or type the ID instead.';
  }
}

async function onAttendanceScan(text) {
  const now = Date.now();
  if (text === attState.lastScan.text && now - attState.lastScan.at < 4000) return;
  attState.lastScan = { text, at: now };
  const id = deskIdentifierFromScan(text);
  if (!id) return showAttendanceResult('bad', 'Not a badge', 'That code holds no ID, mobile or email.');
  await attendanceSignIn(id);
}

async function closeAttendanceScanner() {
  const scanner = attState.scanner;
  attState.scanner = null;
  if (scanner) {
    try { await scanner.stop(); } catch (e) { /* already stopped */ }
    try { scanner.clear(); } catch (e) { /* nothing to clear */ }
  }
  closeModal('modal-att-scan');
  if (can('attendance.view')) renderAttendanceView();
}

function renderAttendanceSummary() {
  const s = attState.summary;
  if (!s) return;
  const day = document.getElementById('att-day').value;
  const list = s.sessions.filter((x) => x.date === day);
  const halls = [...new Set(list.map((x) => x.hall))];
  document.getElementById('att-summary').innerHTML = halls.map((hall) => `
    <div class="py-2">
      <p class="text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">${esc(hall)}</p>
      ${list.filter((x) => x.hall === hall).map((x) => `
        <button type="button" onclick="showAttendanceRoster(${Number(x.id)})" class="w-full text-left flex items-center gap-3 py-1.5 hover:bg-slate-50 rounded">
          <span class="w-28 shrink-0 text-xs text-slate-500 tabular-nums">${esc(sessionTimes(x))}</span>
          <span class="flex-1 min-w-0 truncate text-sm text-slate-800">${esc(x.label ? `${x.label}: ` : '')}${esc(x.title)}${x.window && x.window.open ? ' <span class="text-[10px] bg-emerald-100 text-emerald-700 border border-emerald-300 px-2 py-0.5 rounded-full font-bold">On now</span>' : ''}</span>
          <span class="shrink-0 text-sm font-bold tabular-nums text-slate-800">${x.present}${x.enrolled != null ? `<span class="font-normal text-slate-400"> / ${x.enrolled}</span>` : ''}</span>
        </button>`).join('')}
    </div>`).join('') || '<p class="py-6 text-center text-sm text-slate-400">No sessions take attendance on this day.</p>';
}

function showAttendanceRoster(id) {
  document.getElementById('att-roster-session').value = String(id);
  loadAttendanceRoster();
}

async function loadAttendanceRoster() {
  const id = document.getElementById('att-roster-session').value;
  if (!id) return;
  const res = await fetch(`/api/attendance/roster?session=${encodeURIComponent(id)}`);
  attState.roster = res.ok ? await res.json() : null;
  renderAttendanceRoster();
}

function renderAttendanceRoster() {
  const box = document.getElementById('att-roster');
  const r = attState.roster;
  if (!r || !r.people) { box.innerHTML = ''; return; }
  const filter = document.getElementById('att-roster-filter').value;
  const term = document.getElementById('att-roster-search').value.trim().toLowerCase();
  const mayManage = can('attendance.manage');
  const shown = r.people
    .filter((p) => !filter || (filter === 'in' ? p.attendance : !p.attendance))
    .filter((p) => !term || [p.name, p.registrationNumber].some((v) => String(v || '').toLowerCase().includes(term)));
  const present = r.people.filter((p) => p.attendance).length;
  setText('att-roster-count', r.session.workshop
    ? `${present} present of ${r.people.filter((p) => p.expected).length} enrolled · showing ${shown.length}`
    : `${present} present · showing ${shown.length}`);
  box.innerHTML = shown.map((p) => {
    const a = p.attendance;
    return `<div class="px-3 py-2 flex items-center gap-2">
      <span class="w-5 text-center font-bold ${a ? 'text-emerald-600' : 'text-slate-300'}">${a ? '✓' : '○'}</span>
      <span class="min-w-0 flex-1">
        <span class="block font-semibold text-slate-700 truncate">${esc(p.name || p.phone)}${r.session.workshop && !p.expected ? ' <span class="text-[10px] bg-amber-100 text-amber-800 border border-amber-300 px-2 py-0.5 rounded-full font-bold">Not enrolled</span>' : ''}</span>
        <span class="block text-xs text-slate-400 truncate">${esc([p.registrationNumber, a ? `${fmtAuditTime(a.at)} · ${ATT_METHODS[a.method] || a.method}${a.by && a.method !== 'SELF' ? ` by ${a.by}` : ''}` : '', a && a.note ? a.note : ''].filter(Boolean).join(' · '))}</span>
      </span>
      ${mayManage ? (a
        ? `<button type="button" onclick="removeAttendance(${Number(a.id)})" class="shrink-0 px-2.5 py-1 border border-rose-300 text-rose-700 hover:bg-rose-50 rounded-lg text-xs font-semibold">Remove</button>`
        : `<button type="button" onclick="markAttendanceByHand('${esc(p.phone)}')" class="shrink-0 px-2.5 py-1 border border-slate-300 text-slate-700 hover:bg-slate-50 rounded-lg text-xs font-semibold">Mark present</button>`) : ''}
    </div>`;
  }).join('') || '<p class="px-3 py-6 text-center text-sm text-slate-400">Nobody yet.</p>';
}

// By hand: a row's "Mark present" (phone), or the box above the roster (an
// ID, mobile or email).
async function markAttendanceByHand(phone) {
  const sessionId = document.getElementById('att-roster-session').value;
  const identifier = phone ? null : document.getElementById('att-manual-id').value.trim();
  if (!phone && !identifier) return showToast('Type their ID, mobile or email.');
  const reason = await showPrompt('Why is this being marked by hand? The reason is kept with the record.');
  if (!reason) return;
  const data = await (await fetch('/api/attendance/manual', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: Number(sessionId), phone: phone || undefined, identifier: identifier || undefined, reason }),
  })).json();
  if (!data.success) return showToast(data.error || 'Could not mark them present.');
  showToast(data.already ? 'Already marked present.' : 'Marked present.', 'success');
  document.getElementById('att-manual-id').value = '';
  renderAttendanceView();
}

async function removeAttendance(id) {
  const reason = await showPrompt('Why is this being removed? The reason is kept with the record.');
  if (!reason) return;
  const data = await (await fetch(`/api/attendance/${encodeURIComponent(id)}`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }),
  })).json();
  if (!data.success) return showToast(data.error || 'Could not remove it.');
  showToast('Removed.', 'success');
  renderAttendanceView();
}

// --- HALLS (Conference setup) ---
// Each hall: its name, map location, floor and building; its QR poster, a new
// QR, on or off. Shown to whoever may edit the programme.
async function loadHallsCard() {
  const card = document.getElementById('gs-card-halls');
  const jump = document.getElementById('gs-jump-halls');
  const allowed = can('programme.manage');
  if (card) card.classList.toggle('hidden', !allowed);
  if (jump) jump.classList.toggle('hidden', !allowed);
  if (!allowed) return;
  const res = await fetch('/api/admin/programme');
  if (!res.ok) return;
  renderHalls((await res.json()).halls);
}
function renderHalls(halls) {
  const box = document.getElementById('prog-halls');
  if (!box) return;
  box.innerHTML = halls.map((h) => `
    <div class="py-2 flex flex-col sm:flex-row sm:items-center gap-2 ${h.active ? '' : 'opacity-60'}">
      <input value="${esc(h.name)}" data-hall="${esc(h.id)}" aria-label="Hall name" class="prog-hall-name flex-1 h-9 px-3 border border-slate-300 rounded-lg text-sm outline-none">
      <input value="${h.lat != null && h.lng != null ? esc(`${h.lat}, ${h.lng}`) : ''}" data-hall="${esc(h.id)}" aria-label="Map location" placeholder="Map location: 20.741279, 78.662397"
        title="For the delegates' campus map. In Google Maps, press and hold the spot, then copy the numbers shown." class="prog-hall-loc sm:w-56 h-9 px-3 border border-slate-300 rounded-lg text-sm outline-none tabular-nums">
      <input value="${esc(h.floor || '')}" data-hall="${esc(h.id)}" aria-label="Floor" maxlength="60" placeholder="Floor (if it helps)"
        title="Shown with the hall on the delegates' campus map, e.g. 2nd floor. Leave blank where it is obvious." class="prog-hall-floor sm:w-36 h-9 px-3 border border-slate-300 rounded-lg text-sm outline-none">
      <input value="${esc(h.building || '')}" data-hall="${esc(h.id)}" aria-label="Building" maxlength="80" placeholder="Building (if shared)"
        title="Where several halls share a building and a map location: its name heads them on the delegates' campus map." class="prog-hall-building sm:w-44 h-9 px-3 border border-slate-300 rounded-lg text-sm outline-none">
      <div class="flex flex-wrap gap-1.5">
        <button type="button" onclick="saveHall(${Number(h.id)})" class="px-3 py-1.5 bg-navy hover:bg-indigo-700 text-white rounded-lg text-xs font-semibold">Save</button>
        <a href="/api/admin/programme/posters.pdf?hall=${encodeURIComponent(h.id)}" target="_blank" rel="noopener" class="px-3 py-1.5 border border-slate-300 rounded-lg text-xs font-semibold text-slate-700 hover:bg-slate-50">QR poster</a>
        <button type="button" onclick="newHallCode(${Number(h.id)})" class="px-3 py-1.5 border border-slate-300 rounded-lg text-xs font-semibold text-slate-700">New QR</button>
        <button type="button" onclick="putHall(${Number(h.id)}, { active: ${h.active ? 'false' : 'true'} })" class="px-3 py-1.5 border border-slate-300 rounded-lg text-xs font-semibold text-slate-700">${h.active ? 'Turn off' : 'Turn on'}</button>
      </div>
    </div>`).join('') || '<p class="py-4 text-sm text-slate-400">No halls yet.</p>';
}

// --- PROGRAMME (admin) ---
async function renderProgramme() {
  const res = await fetch('/api/admin/programme');
  if (!res.ok) return;
  const p = await res.json();
  attState.programme = p;
  const days = [...new Set([...p.sessions.map((s) => s.date), conferenceInfo.startDate, conferenceInfo.endDate].filter(Boolean))].sort();
  const daySel = document.getElementById('prog-day');
  const keep = daySel.value;
  daySel.innerHTML = days.map((d) => `<option value="${esc(d)}">${esc(formatFullDate(d))}</option>`).join('');
  if (days.includes(keep)) daySel.value = keep;
  fillProgrammeHallFilter();
  document.getElementById('ps-hall').innerHTML = p.halls.filter((h) => h.active).map((h) => `<option value="${esc(h.id)}">${esc(h.name)}</option>`).join('');
  document.getElementById('ps-option').innerHTML = '<option value="">Not a workshop or practice</option>'
    + p.options.map((o) => `<option value="${esc(o.id)}">${esc(o.group_name)}: ${esc(o.name)}</option>`).join('');
  renderProgrammeSessions();
}

// The Hall filter beside Day: the halls with a session on the chosen day, in
// hall order, kept across a day change where that hall is in use.
function fillProgrammeHallFilter() {
  const p = attState.programme;
  const sel = document.getElementById('prog-hall');
  if (!p || !sel) return;
  const day = document.getElementById('prog-day').value;
  const used = new Set(p.sessions.filter((s) => s.date === day).map((s) => s.hallId));
  const halls = p.halls.filter((h) => used.has(h.id));
  const keep = sel.value;
  sel.innerHTML = `<option value="">All halls (${halls.length})</option>`
    + halls.map((h) => `<option value="${esc(h.id)}">${esc(h.name)}</option>`).join('');
  sel.value = halls.some((h) => String(h.id) === keep) ? keep : '';
}

function renderProgrammeSessions() {
  const p = attState.programme;
  if (!p) return;
  const day = document.getElementById('prog-day').value;
  const hall = document.getElementById('prog-hall') ? document.getElementById('prog-hall').value : '';
  const list = p.sessions.filter((s) => s.date === day && (!hall || String(s.hallId) === hall));
  document.getElementById('prog-sessions').innerHTML = list.map((s) => `
    <div class="py-2 flex items-start gap-3 ${s.counts ? '' : 'opacity-70'}">
      <span class="w-28 shrink-0 text-xs text-slate-500 tabular-nums pt-0.5">${esc(sessionTimes(s))}</span>
      <span class="flex-1 min-w-0">
        <span class="block text-sm text-slate-800"><span class="text-[10px] bg-slate-100 text-slate-600 border border-slate-200 px-2 py-0.5 rounded-full font-bold mr-1">${esc(s.hall)}</span>${esc(s.label ? `${s.label}: ` : '')}<b>${esc(s.title)}</b></span>
        <span class="block text-xs text-slate-500 truncate">${esc([s.speakers, s.chairs ? `Chair: ${s.chairs}` : ''].filter(Boolean).join(' · '))}</span>
        <span class="block text-[11px] mt-0.5">${s.counts ? `<span class="text-emerald-700 font-semibold">Takes attendance · ${s.present} present</span>` : '<span class="text-slate-400">No attendance</span>'}${s.optionName ? ` · <span class="text-indigo-700">${s.workshop ? 'Workshop' : 'Practice'}: ${esc(s.optionName)}</span>` : ''}</span>
      </span>
      <button type="button" onclick="editProgrammeSession(${Number(s.id)})" class="shrink-0 px-2.5 py-1 border border-slate-300 rounded-lg text-xs font-semibold text-slate-700">Edit</button>
    </div>`).join('') || `<p class="py-4 text-sm text-slate-400">${hall ? 'No sessions in this hall on this day.' : 'No sessions on this day.'}</p>`;
}

function editProgrammeSession(id) {
  const p = attState.programme;
  const s = id ? p.sessions.find((x) => x.id === id) : null;
  const set = (k, v) => { document.getElementById(k).value = v == null ? '' : v; };
  set('ps-id', s ? s.id : '');
  const hallFilter = document.getElementById('prog-hall') && document.getElementById('prog-hall').value;
  set('ps-hall', s ? s.hallId : (p.halls.find((h) => h.active && String(h.id) === hallFilter) || p.halls.find((h) => h.active) || {}).id);
  set('ps-date', s ? s.date : document.getElementById('prog-day').value);
  set('ps-start', s ? s.start : '');
  set('ps-end', s ? s.end : '');
  set('ps-label', s ? s.label : '');
  const titleBox = document.getElementById('ps-title');
  titleBox.disabled = false;
  delete titleBox.dataset.typed;
  set('ps-title', s ? s.title : '');
  // The faculty lists; a session typed before them comes with a proposal.
  const copy = (list) => (list || []).map((x) => ({ ...x }));
  psPeople = { speakers: copy(s && s.people && s.people.speakers), chairs: copy(s && s.people && s.people.chairs) };
  const note = document.getElementById('ps-people-note');
  const proposed = !!(s && s.people && s.people.proposed && (psPeople.speakers.length || psPeople.chairs.length));
  note.classList.toggle('hidden', !proposed);
  note.textContent = proposed ? 'This session was typed before the faculty lists. Names that match one faculty member are linked (navy); the rest are kept as typed (dashed) -- add a person to the faculty list, or leave words like "and Team". Check, then Save.' : '';
  renderSessionPeople('speakers');
  renderSessionPeople('chairs');
  set('ps-option', s && s.optionId ? s.optionId : '');
  syncSessionTitleField();
  document.getElementById('ps-counts').checked = s ? s.counts : true;
  document.getElementById('ps-delete').classList.toggle('hidden', !s);
  document.getElementById('prog-session-form').classList.remove('hidden');
  document.getElementById('ps-title').focus();
}

// A session for a workshop or practice is called what the workshop is
// called: its title box shows that name, locked, and is not sent -- the
// server keeps whatever title was stored. Rename it in Workshops.
function syncSessionTitleField() {
  const optSel = document.getElementById('ps-option');
  const title = document.getElementById('ps-title');
  const note = document.getElementById('ps-title-note');
  if (!optSel || !title) return;
  const p = attState.programme;
  const opt = optSel.value && p ? (p.options || []).find((o) => String(o.id) === String(optSel.value)) : null;
  if (opt) {
    if (!title.disabled) title.dataset.typed = title.value;
    title.value = opt.name;
    title.disabled = true;
  } else if (title.disabled) {
    title.disabled = false;
    title.value = title.dataset.typed || '';
  }
  title.classList.toggle('bg-slate-50', !!opt);
  title.classList.toggle('text-slate-500', !!opt);
  if (note) note.classList.toggle('hidden', !opt);
}

async function saveProgrammeSession(e) {
  e.preventDefault();
  const id = document.getElementById('ps-id').value;
  const v = (k) => document.getElementById(k).value;
  const linked = !!v('ps-option');
  const body = {
    hallId: Number(v('ps-hall')), date: v('ps-date'), start: v('ps-start'), end: v('ps-end'), label: v('ps-label'),
    title: linked ? undefined : v('ps-title'), optionId: linked ? Number(v('ps-option')) : null,
    people: Object.fromEntries(['speakers', 'chairs'].map((role) => [role,
      psPeople[role].map((p) => (p.guestId != null ? { guestId: p.guestId } : { text: p.text }))])),
    counts: document.getElementById('ps-counts').checked,
  };
  const data = await (await fetch(id ? `/api/admin/programme/sessions/${encodeURIComponent(id)}` : '/api/admin/programme/sessions', {
    method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })).json();
  if (!data.success) return showToast(data.error || 'Could not save.');
  showToast('Saved.', 'success');
  document.getElementById('prog-session-form').classList.add('hidden');
  document.getElementById('prog-day').value = body.date;
  // Filtered to a hall and the session went to another: follow it there.
  const hallSel = document.getElementById('prog-hall');
  if (hallSel && hallSel.value && hallSel.value !== String(body.hallId)) {
    hallSel.add(new Option('', String(body.hallId)));
    hallSel.value = String(body.hallId);
  }
  renderProgramme();
}

// --- A session's speakers and chairs ---
// Chips in order: navy for someone on the faculty list, dashed for words.
// Search the faculty list to add; or keep what was typed as words; or add
// the person to the faculty list (POST /api/admin/programme/faculty).
let psPeople = { speakers: [], chairs: [] };
let psPendingAccount = null;
const PS_ROLE_LABELS = { speakers: 'Speakers / facilitators', chairs: 'Chairpersons / moderators' };
const PS_TITLES = new Set(['dr', 'prof', 'professor', 'mrs', 'mr', 'ms', 'smt', 'shri', 'maj', 'gen', 'air', 'cmde', 'lt', 'col', 'brig', 'capt', 'sr']);
// As programme-people.js normName: titles, dots and case aside.
function psNormName(name) {
  const words = String(name || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  while (words.length > 1 && PS_TITLES.has(words[0])) words.shift();
  return words.join(' ');
}

function renderSessionPeople(role) {
  const box = document.getElementById(`ps-people-${role}`);
  if (!box) return;
  const x = (i, name) => `<button type="button" onclick="removeSessionPerson('${role}', ${i})" aria-label="Remove ${esc(name)}" class="w-5 h-5 rounded-full leading-none hover:bg-black/10">×</button>`;
  const chip = (p, i) => (p.guestId != null
    ? `<span class="inline-flex items-center gap-1 rounded-full bg-navy text-white text-xs font-semibold pl-2.5 pr-1 py-1">${esc(p.name)}${x(i, p.name)}</span>`
    : `<span class="inline-flex items-center gap-1 rounded-full border border-dashed border-slate-400 bg-slate-50 text-slate-700 text-xs pl-2.5 pr-1 py-1" title="Not on the faculty list">${esc(p.text)}${/^and\b/i.test(p.text) ? ''
      : ` <button type="button" onclick="startNewFaculty('${role}', ${i})" class="text-[11px] font-semibold text-indigo-700 underline">Add to faculty</button>`}${x(i, p.text)}</span>`);
  box.innerHTML = `<p class="text-[11px] font-semibold text-slate-600 mb-1.5">${PS_ROLE_LABELS[role]}</p>
    <div class="flex flex-wrap gap-1.5 mb-2">${psPeople[role].map(chip).join('') || '<span class="text-xs text-slate-400">None yet</span>'}</div>
    <input id="ps-find-${role}" autocomplete="off" oninput="findSessionPerson('${role}')" onkeydown="if (event.key === 'Enter') event.preventDefault()"
      placeholder="Search the faculty list" aria-label="Add to ${PS_ROLE_LABELS[role]}" class="w-full h-9 px-2.5 border border-slate-300 rounded-lg text-sm outline-none">
    <div id="ps-found-${role}" class="mt-1.5 space-y-1"></div>`;
}

function findSessionPerson(role) {
  const q = document.getElementById(`ps-find-${role}`).value.trim();
  const out = document.getElementById(`ps-found-${role}`);
  if (q.length < 2) { out.innerHTML = ''; return; }
  const key = psNormName(q);
  const taken = new Set(psPeople[role].filter((p) => p.guestId != null).map((p) => p.guestId));
  const hits = (attState.programme.faculty || []).filter((f) => !f.cancelled && !taken.has(f.id) && key && psNormName(f.name).includes(key)).slice(0, 8);
  const btn = 'w-full text-left px-2.5 py-1.5 rounded-lg border text-sm';
  out.innerHTML = hits.map((f) => `<button type="button" onclick="addSessionPerson('${role}', ${Number(f.id)})" class="${btn} border-slate-200 hover:bg-slate-50">
      <span class="font-semibold text-slate-800">${esc(f.name)}</span>${f.designation ? `<span class="block text-[11px] text-slate-500 truncate">${esc(f.designation)}</span>` : ''}</button>`).join('')
    + `<div class="flex flex-wrap gap-1.5 pt-0.5">
      <button type="button" onclick="startNewFaculty('${role}')" class="px-2.5 py-1 rounded-lg border border-indigo-300 text-indigo-700 text-xs font-semibold hover:bg-indigo-50">Add “${esc(q)}” to the faculty list</button>
      <button type="button" onclick="addSessionText('${role}')" class="px-2.5 py-1 rounded-lg border border-slate-300 text-slate-600 text-xs font-semibold hover:bg-slate-50">Keep “${esc(q)}” as words</button></div>`;
}

function addSessionPerson(role, guestId) {
  const f = (attState.programme.faculty || []).find((x) => x.id === guestId);
  if (f && !psPeople[role].some((p) => p.guestId === guestId)) psPeople[role].push({ guestId, name: f.name });
  renderSessionPeople(role);
  const input = document.getElementById(`ps-find-${role}`);
  if (input && input.focus) input.focus();
}
function addSessionText(role) {
  const text = document.getElementById(`ps-find-${role}`).value.replace(/\s+/g, ' ').trim();
  if (text) psPeople[role].push({ text, name: text });
  renderSessionPeople(role);
}
function removeSessionPerson(role, i) {
  psPeople[role].splice(i, 1);
  renderSessionPeople(role);
}

// Someone not yet faculty: name (as typed), and what is known, to the
// faculty list. `i` is the dashed chip being turned into them, if any.
function startNewFaculty(role, i) {
  const name = i != null ? psPeople[role][i].text : document.getElementById(`ps-find-${role}`).value.trim();
  const out = document.getElementById(`ps-found-${role}`);
  const field = 'w-full h-9 px-2.5 border border-slate-300 rounded-lg text-sm outline-none';
  out.innerHTML = `<div class="rounded-lg border border-indigo-200 bg-indigo-50/60 p-2.5 space-y-1.5">
      <p class="text-xs font-semibold text-indigo-900">Add to the faculty list</p>
      <input id="ps-new-name-${role}" value="${esc(name)}" maxlength="120" placeholder="Name *" class="${field}">
      <input id="ps-new-designation-${role}" maxlength="300" placeholder="Designation" class="${field}">
      <div class="grid grid-cols-2 gap-1.5"><input id="ps-new-phone-${role}" inputmode="tel" maxlength="20" placeholder="Phone" class="${field}">
        <input id="ps-new-email-${role}" type="email" maxlength="120" placeholder="Email" class="${field}"></div>
      <p class="text-[11px] text-slate-500">A phone or email helps: if they have an account, it is used instead, and nobody is added twice.</p>
      <p id="ps-new-msg-${role}" class="hidden text-xs text-amber-900"></p>
      <div class="flex gap-1.5"><button type="button" onclick="submitNewFaculty('${role}', ${i == null ? 'null' : Number(i)})" class="h-8 px-3 bg-navy hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg">Add to faculty list</button>
        <button type="button" onclick="renderSessionPeople('${role}')" class="h-8 px-3 border border-slate-300 text-slate-700 text-xs font-semibold rounded-lg">Cancel</button></div>
    </div>`;
}

// Into the session, in place of the words it replaces (if any).
function placeSessionFaculty(role, i, guestId, name) {
  const fac = attState.programme.faculty || (attState.programme.faculty = []);
  if (!fac.some((f) => f.id === guestId)) fac.push({ id: guestId, name, designation: '', cancelled: false });
  const already = psPeople[role].some((p) => p.guestId === guestId);
  if (i != null && psPeople[role][i]) {
    if (already) psPeople[role].splice(i, 1); else psPeople[role][i] = { guestId, name };
  } else if (!already) psPeople[role].push({ guestId, name });
  renderSessionPeople(role);
}

async function submitNewFaculty(role, i, account) {
  const v = (k) => (document.getElementById(`ps-new-${k}-${role}`) || {}).value || '';
  const body = account ? { phone: account.phone_number } : { guest: { name: v('name'), designation: v('designation'), phone: v('phone'), email: v('email') } };
  const data = await (await fetch('/api/admin/programme/faculty', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })).json().catch(() => ({}));
  const msg = document.getElementById(`ps-new-msg-${role}`);
  const say = (html) => { if (msg) { msg.innerHTML = html; msg.classList.remove('hidden'); } };
  if (data.success) {
    placeSessionFaculty(role, i, data.id, data.name);
    showToast(`${data.name} added to the faculty list${data.linked && !data.registered ? ' (not registered yet)' : ''}.`, 'success');
    return;
  }
  if (data.code === 'GUEST_EXISTS' && data.guestId) {
    const f = (attState.programme.faculty || []).find((x) => x.id === data.guestId);
    placeSessionFaculty(role, i, data.guestId, f ? f.name : v('name'));
    showToast(`Already on the faculty list: ${f ? f.name : 'added them from there'}.`, 'success');
    return;
  }
  if (data.code === 'ACCOUNT_EXISTS' && data.account) {
    if (data.account.guestId) {
      placeSessionFaculty(role, i, data.account.guestId, data.account.name);
      showToast(`${data.account.name} is already on the faculty list.`, 'success');
      return;
    }
    psPendingAccount = data.account;
    say(`${esc(data.error)} <button type="button" onclick="submitNewFaculty('${role}', ${i == null ? 'null' : Number(i)}, psPendingAccount)" class="ml-1 px-2 py-0.5 bg-indigo-600 text-white rounded-md text-[11px] font-semibold">Mark ${esc(data.account.name)} as faculty</button>`);
    return;
  }
  say(esc(data.error || 'Could not add them.'));
}

async function deleteProgrammeSession() {
  const id = document.getElementById('ps-id').value;
  if (!id || !(await showConfirm('Delete this session from the programme?'))) return;
  const data = await (await fetch(`/api/admin/programme/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })).json();
  if (!data.success) return showToast(data.error || 'Could not delete it.');
  document.getElementById('prog-session-form').classList.add('hidden');
  renderProgramme();
}

async function putHall(id, body) {
  const data = await (await fetch(`/api/admin/programme/halls/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })).json();
  if (!data.success) { showToast(data.error || 'Could not save.'); return; }
  showToast('Saved.', 'success');
  loadHallsCard();
}
function saveHall(id) {
  putHall(id, {
    name: document.querySelector(`.prog-hall-name[data-hall="${id}"]`).value,
    location: document.querySelector(`.prog-hall-loc[data-hall="${id}"]`).value,
    floor: document.querySelector(`.prog-hall-floor[data-hall="${id}"]`).value,
    building: document.querySelector(`.prog-hall-building[data-hall="${id}"]`).value,
  });
}
async function newHallCode(id) {
  if (!(await showConfirm('Give this hall a new QR code? Its printed poster stops working -- print the new one and replace it.', 'New QR code'))) return;
  putHall(id, { newCode: true });
}
async function addHall(e) {
  e.preventDefault();
  const name = document.getElementById('prog-new-hall').value.trim();
  const data = await (await fetch('/api/admin/programme/halls', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  })).json();
  if (!data.success) return showToast(data.error || 'Could not add it.');
  document.getElementById('prog-new-hall').value = '';
  loadHallsCard();
}

// --- The Attendance page's views (the Programme is its own Settings page) ---
const ATT_VIEWS = ['attendance', 'certificates', 'settings'];
function attendanceViewAllowed(view) {
  if (view === 'attendance') return can('attendance.mark') || can('attendance.view');
  if (view === 'certificates') return can('certificates.view');
  if (view === 'settings') return can('certificates.manage');
  return false;
}

async function renderAttendance() {
  document.querySelectorAll('.att-subtab').forEach((b) => b.classList.toggle('hidden', !attendanceViewAllowed(b.dataset.attView)));
  const saved = storageGet('local', 'nqocn_att_view');
  const view = attendanceViewAllowed(saved) ? saved : ATT_VIEWS.find(attendanceViewAllowed) || 'attendance';
  await switchAttendanceView(view);
}

async function switchAttendanceView(view) {
  if (!attendanceViewAllowed(view)) view = ATT_VIEWS.find(attendanceViewAllowed) || 'attendance';
  storageSet('local', 'nqocn_att_view', view);
  document.querySelectorAll('.att-subtab').forEach((b) => {
    const on = b.dataset.attView === view;
    b.classList.toggle('bg-indigo-600', on);
    b.classList.toggle('text-white', on);
    b.classList.toggle('text-slate-600', !on);
    b.classList.toggle('hover:bg-slate-100', !on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  ATT_VIEWS.forEach((v) => { const el = document.getElementById(`att-view-${v}`); if (el) el.classList.toggle('hidden', v !== view); });
  if (view === 'attendance') await renderAttendanceView();
  if (view === 'certificates') await renderCertificates();
  if (view === 'settings') await renderCertificateSettings();
}

// --- CERTIFICATES (admin) ---
const certState = { people: [], issued: {}, kinds: {}, settings: null };
const CERT_BADGE = {
  MMC: 'bg-indigo-100 text-indigo-800 border-indigo-300', CONF: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  WORKSHOP: 'bg-sky-100 text-sky-800 border-sky-300', FACULTY: 'bg-amber-100 text-amber-800 border-amber-300',
};

async function renderCertificates() {
  const res = await fetch('/api/admin/certificates/candidates');
  if (!res.ok) return;
  const data = await res.json();
  certState.people = data.people || [];
  certState.issued = data.issued || {};
  certState.kinds = data.kinds || {};
  const p = certState.people;
  const dueConf = p.filter((x) => x.conference.kind && !x.conference.issued).length;
  const dueWs = p.reduce((n, x) => n + x.workshops.filter((w) => w.eligible && !w.issued).length, 0);
  const dueFac = p.filter((x) => x.faculty && x.faculty.eligible && !x.faculty.issued).length;
  const stat = (label, value, note) => `<div class="bg-white rounded-xl border border-slate-200 p-3"><p class="text-[11px] font-bold text-slate-500 uppercase tracking-wide">${esc(label)}</p>
    <p class="text-2xl font-extrabold text-slate-800 tabular-nums">${value}</p><p class="text-[11px] text-slate-500">${esc(note)}</p></div>`;
  document.getElementById('cert-stats').innerHTML = [
    stat('MMC points', p.filter((x) => x.conference.kind === 'MMC').length, `${certState.issued.MMC || 0} issued`),
    stat('Participation', p.filter((x) => x.conference.kind === 'CONF').length, `${certState.issued.CONF || 0} issued`),
    stat('Workshops', p.reduce((n, x) => n + x.workshops.filter((w) => w.eligible).length, 0), `${certState.issued.WORKSHOP || 0} issued`),
    stat('Faculty', p.filter((x) => x.faculty && x.faculty.eligible).length, `${certState.issued.FACULTY || 0} issued`),
    stat('Not yet', p.filter((x) => !x.conference.kind && !x.notRegistered).length, 'for the conference'),
  ].join('');
  const mayIssue = can('certificates.issue');
  document.getElementById('cert-issue-btns').classList.toggle('hidden', !mayIssue);
  const confBtn = document.getElementById('cert-issue-conf');
  const wsBtn = document.getElementById('cert-issue-ws');
  confBtn.textContent = `Issue conference certificates (${dueConf} due)`;
  confBtn.disabled = !dueConf;
  wsBtn.textContent = `Issue workshop certificates (${dueWs} due)`;
  wsBtn.disabled = !dueWs;
  const facBtn = document.getElementById('cert-issue-fac');
  facBtn.textContent = `Issue faculty certificates (${dueFac} due)`;
  facBtn.disabled = !dueFac;
  renderCertificateList();
}

function renderCertificateList() {
  const filter = document.getElementById('cert-filter').value;
  const term = document.getElementById('cert-search').value.trim().toLowerCase();
  const mayIssue = can('certificates.issue');
  const shown = certState.people.filter((x) => {
    if (term && ![x.name, x.registrationNumber].some((v) => String(v || '').toLowerCase().includes(term))) return false;
    if (filter === 'due') return (x.conference.kind && !x.conference.issued) || x.workshops.some((w) => w.eligible && !w.issued) || !!(x.faculty && x.faculty.eligible && !x.faculty.issued);
    if (filter === 'faculty') return !!x.faculty;
    if (filter === '') return !x.notRegistered;
    if (filter === 'MMC' || filter === 'CONF') return x.conference.kind === filter;
    if (filter === 'nocouncil') return x.mmcCategory && !x.councilRegNo;
    if (filter === 'not') return !x.conference.kind && !x.notRegistered;
    if (filter === 'issued') return !!x.conference.issued || x.workshops.some((w) => w.issued) || !!(x.faculty && x.faculty.issued);
    return true;
  });
  setText('cert-count', `Showing ${shown.length} of ${certState.people.length}`);
  const badge = (kind, text) => `<span class="text-[10px] px-2 py-0.5 rounded-full border font-bold ${CERT_BADGE[kind]}">${esc(text)}</span>`;
  const issuedLink = (c) => `<a href="/api/admin/certificates/${encodeURIComponent(c.id)}.pdf" target="_blank" rel="noopener" class="text-indigo-700 hover:underline font-semibold">${esc(c.cert_no)}</a>`
    + (mayIssue ? ` <button type="button" onclick="correctCertificate(${Number(c.id)})" class="text-xs text-slate-500 hover:underline">Correct name</button>`
      + ` <button type="button" onclick="revokeCertificate(${Number(c.id)})" class="text-xs text-rose-600 hover:underline">Withdraw</button>` : '');
  document.getElementById('cert-list').innerHTML = shown.map((x) => {
    const c = x.conference;
    const conf = c.issued ? `${badge(c.issued.kind, c.issued.kind === 'MMC' ? 'MMC points' : 'Participation')} ${issuedLink(c.issued)}`
      : c.kind ? `${badge(c.kind, c.kind === 'MMC' ? 'MMC points · due' : 'Participation · due')}`
        : `<span class="text-xs text-slate-500">${esc(c.whyNot || '')}</span>`;
    const confOv = mayIssue && !c.issued && !x.notRegistered ? (c.override
      ? ` <button type="button" onclick="setCertificateOverride('${esc(x.phone)}', 'CONF', null)" class="text-xs text-amber-700 hover:underline">${c.override.decision === 'INCLUDE' ? 'Included' : 'Excluded'} by hand — undo</button>`
      : ` <button type="button" onclick="setCertificateOverride('${esc(x.phone)}', 'CONF', '${c.kind ? 'EXCLUDE' : 'INCLUDE'}')" class="text-xs text-slate-500 hover:underline">${c.kind ? 'Exclude' : 'Include anyway'}</button>`) : '';
    const ws = x.workshops.map((w) => `<div class="text-xs mt-1">
        <span class="font-semibold text-slate-700">${esc(w.name)}</span>:
        ${w.issued ? `${badge('WORKSHOP', 'Issued')} ${issuedLink(w.issued)}` : w.eligible ? badge('WORKSHOP', 'Due') : `<span class="text-slate-500">${esc(w.whyNot || '')}</span>`}
        ${mayIssue && !w.issued ? (w.override
          ? ` <button type="button" onclick="setCertificateOverride('${esc(x.phone)}', '${esc(w.e)}', null)" class="text-amber-700 hover:underline">${w.override.decision === 'INCLUDE' ? 'Included' : 'Excluded'} by hand — undo</button>`
          : ` <button type="button" onclick="setCertificateOverride('${esc(x.phone)}', '${esc(w.e)}', '${w.eligible ? 'EXCLUDE' : 'INCLUDE'}')" class="text-slate-500 hover:underline">${w.eligible ? 'Exclude' : 'Include anyway'}</button>`) : ''}
      </div>`).join('');
    const f = x.faculty;
    const fac = !f ? '' : `<div class="text-xs mt-1">Faculty:
        ${f.issued ? `${badge('FACULTY', 'Issued')} ${issuedLink(f.issued)}` : f.eligible ? badge('FACULTY', 'Due') : `<span class="text-slate-500">${esc(f.whyNot || '')}</span>`}
        ${mayIssue && !f.issued ? (f.override
          ? ` <button type="button" onclick="setCertificateOverride('${esc(f.key)}', 'FAC', null)" class="text-amber-700 hover:underline">Excluded by hand — undo</button>`
          : ` <button type="button" onclick="setCertificateOverride('${esc(f.key)}', 'FAC', 'EXCLUDE')" class="text-slate-500 hover:underline">Exclude</button>`) : ''}
      </div>`;
    return `<div class="px-3 py-2.5">
      <div class="flex flex-wrap items-baseline gap-x-2">
        <span class="font-semibold text-slate-800">${esc(x.name)}</span>
        <span class="text-xs text-slate-400">${esc([x.registrationNumber, x.category, x.councilRegNo ? `${x.councilName || 'Council'} ${x.councilRegNo}` : (x.mmcCategory ? 'no council number' : '')].filter(Boolean).join(' · '))}</span>
      </div>
      <div class="text-xs mt-1">Conference: ${conf}${confOv}</div>
      ${ws}${fac}
    </div>`;
  }).join('') || '<p class="px-3 py-6 text-center text-sm text-slate-400">Nobody to show.</p>';
}

async function setCertificateOverride(phone, scope, decision) {
  let reason = '';
  if (decision) {
    reason = await showPrompt(decision === 'INCLUDE'
      ? 'Why should they receive this certificate anyway? The reason is kept.'
      : 'Why should they not receive this certificate? The reason is kept.');
    if (!reason) return;
  }
  const data = await (await fetch('/api/admin/certificates/override', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, scope, decision, reason }),
  })).json();
  if (!data.success) return showToast(data.error || 'Could not save.');
  renderCertificates();
}

function issueCertificatesQuestion(scope) {
  const what = { conference: 'conference certificate', workshops: 'workshop certificate', faculty: 'faculty certificate' }[scope];
  const who = scope === 'faculty' ? 'Faculty with an account can download theirs from the portal; for the rest, download it here.' : 'The delegate can download it from the portal.';
  return `Issue every ${what} now due? Each gets its number. ${who}`;
}

async function issueCertificates(scope) {
  if (!(await showConfirm(issueCertificatesQuestion(scope), 'Issue'))) return;
  const data = await (await fetch('/api/admin/certificates/issue', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope }),
  })).json();
  if (!data.success) return showToast(data.error || 'Could not issue.');
  const i = data.issued;
  showToast(scope === 'conference' ? `Issued ${i.MMC} with MMC points and ${i.CONF} participation certificates.`
    : scope === 'faculty' ? `Issued ${i.FACULTY} faculty certificates.` : `Issued ${i.WORKSHOP} workshop certificates.`, 'success');
  renderCertificates();
}

// An issued certificate on the list, by id.
function issuedCertificate(id) {
  for (const x of certState.people) {
    if (x.conference.issued && x.conference.issued.id === id) return x.conference.issued;
    const w = x.workshops.find((y) => y.issued && y.issued.id === id);
    if (w) return w.issued;
    if (x.faculty && x.faculty.issued && x.faculty.issued.id === id) return x.faculty.issued;
  }
  return null;
}

async function correctCertificate(id) {
  const c = issuedCertificate(id);
  if (!c) return;
  const name = await showPrompt(`The name as it should be printed on ${c.cert_no}. The number stays the same.`, '', c.name);
  if (!name) return;
  const data = await (await fetch(`/api/admin/certificates/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  })).json();
  if (!data.success) return showToast(data.error || 'Could not correct it.');
  showToast('Corrected.', 'success');
  renderCertificates();
}

async function revokeCertificate(id) {
  const c = issuedCertificate(id);
  if (!c) return;
  const reason = await showPrompt(`Withdraw ${c.cert_no}? It stays on record, and its verify page will say it was withdrawn. Give the reason.`);
  if (!reason) return;
  const data = await (await fetch(`/api/admin/certificates/${encodeURIComponent(id)}/revoke`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }),
  })).json();
  if (!data.success) return showToast(data.error || 'Could not withdraw it.');
  showToast('Withdrawn.', 'success');
  renderCertificates();
}

// --- CERTIFICATE SETTINGS (admin) ---
async function renderCertificateSettings() {
  const res = await fetch('/api/admin/certificates/settings');
  if (!res.ok) return;
  const d = await res.json();
  certState.settings = d;
  document.getElementById('cs-mmc-no').value = d.settings.mmc.accreditationNo || '';
  document.getElementById('cs-mmc-points').value = d.settings.mmc.points || '';
  document.getElementById('cs-categories').innerHTML = d.categories.map((c) => `<label class="flex items-center gap-1.5">
    <input type="checkbox" class="cs-category" value="${esc(c.value)}" ${d.settings.eligibleCategories.includes(c.value) ? 'checked' : ''}> ${esc(c.label)}</label>`).join('');
  document.getElementById('cs-lunch').value = d.settings.attendance.lunchSplit;
  document.getElementById('cs-show-from').value = d.settings.attendance.showFrom || '';
  setText('cs-show-from-note', d.settings.attendance.showFrom ? '' : `Blank: the day before the conference${d.settings.attendance.showFromEffective ? ` (${formatFullDate(d.settings.attendance.showFromEffective)})` : ''}.`);
  document.getElementById('cs-early').value = d.settings.attendance.earlyMinutes;
  setText('cs-background-state', d.settings.hasBackground
    ? "Certificates are printed over the designer's background. The text sits in the same places as on the generated design."
    : 'Certificates use the generated design: a navy frame with a gold rule. Upload the designer\'s artwork (A4 landscape, 297 × 210 mm) to print over it instead.');
  document.getElementById('cs-background-remove').classList.toggle('hidden', !d.settings.hasBackground);

  document.getElementById('cs-signatories').innerHTML = d.signatories.map((s) => `
    <div class="flex flex-col sm:flex-row sm:items-center gap-2 p-3 border border-slate-200 rounded-xl ${s.active ? '' : 'opacity-60'}">
      <div class="w-full sm:w-40 h-14 border border-dashed border-slate-300 rounded-lg flex items-center justify-center bg-slate-50 shrink-0">
        ${Number(s.has_signature) ? `<img src="/api/admin/certificates/signatories/${encodeURIComponent(s.id)}/signature?t=${Date.now()}" alt="Signature" class="max-h-12 max-w-full">` : '<span class="text-[11px] text-slate-400">No signature yet</span>'}
      </div>
      <div class="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
        <input value="${esc(s.name)}" data-sig="${esc(s.id)}" data-field="name" aria-label="Name" class="cs-sig-field h-9 px-3 border border-slate-300 rounded-lg text-sm outline-none">
        <input value="${esc(s.designation)}" data-sig="${esc(s.id)}" data-field="designation" aria-label="Designation" class="cs-sig-field h-9 px-3 border border-slate-300 rounded-lg text-sm outline-none">
      </div>
      <div class="flex flex-wrap gap-1.5">
        <label class="px-3 py-1.5 border border-slate-300 rounded-lg text-xs font-semibold text-slate-700 cursor-pointer">Signature
          <input type="file" accept="image/png,image/jpeg" class="hidden" onchange="uploadSignature(${Number(s.id)}, this)"></label>
        <button type="button" onclick="saveSignatory(${Number(s.id)})" class="px-3 py-1.5 bg-navy hover:bg-indigo-700 text-white rounded-lg text-xs font-semibold">Save</button>
        <button type="button" onclick="toggleSignatory(${Number(s.id)}, ${s.active ? 0 : 1})" class="px-3 py-1.5 border border-slate-300 rounded-lg text-xs font-semibold text-slate-700">${s.active ? 'Turn off' : 'Turn on'}</button>
      </div>
      <label class="flex items-center gap-1.5 text-xs text-slate-600 sm:w-44 shrink-0"><input type="checkbox" ${Number(s.mmc_only) ? 'checked' : ''} onchange="putSignatory(${Number(s.id)}, { mmcOnly: this.checked })"> Only on certificates with MMC points</label>
    </div>`).join('');

  const chips = Object.keys(d.placeholders).map((k) => `<code class="text-[11px] bg-slate-100 px-1 py-0.5 rounded" title="${esc(d.placeholders[k])}">{{${esc(k)}}}</code>`).join(' ');
  const max = d.maxSignatories || 6;
  // Who may sign a kind: the active ones, and an MMC-only signatory on the
  // MMC certificate alone.
  const signers = (kind) => d.signatories.filter((s) => s.active && (kind === 'MMC' || !Number(s.mmc_only)));
  const sigBoxes = (kind, ticked, cls) => `<div class="flex flex-wrap gap-x-4 gap-y-1.5 text-sm">${signers(kind).map((s) => `<label class="flex items-center gap-1.5">
      <input type="checkbox" class="${cls}" value="${esc(s.id)}" ${ticked.includes(Number(s.id)) ? 'checked' : ''}> <span><b class="font-semibold">${esc(s.name)}</b> <span class="text-slate-500">· ${esc(s.designation)}</span></span></label>`).join('')}</div>`;
  const sigNames = (ids) => ids.map((id) => d.signatories.find((s) => Number(s.id) === id)).filter((s) => s && s.active).map((s) => s.name).join(', ') || 'nobody';
  const workshopRows = (t) => !d.workshops.length ? '' : `
      <div class="pt-2 border-t border-slate-100">
        <p class="text-xs font-semibold text-slate-600 mb-1">Each workshop's signatories</p>
        <p class="text-[11px] text-slate-500 mb-2">A workshop without its own is signed by those ticked above. Add the workshop's faculty under Signatories first.</p>
        <div class="space-y-1.5">${d.workshops.map((w) => {
          const own = t.byWorkshop && t.byWorkshop[String(w.optionId)];
          return `<details class="border border-slate-200 rounded-lg" data-ws="${esc(w.optionId)}">
            <summary class="px-3 py-2 cursor-pointer text-sm"><span class="font-semibold text-slate-800">${esc(w.name)}</span>
              <span class="text-xs ${own ? 'text-slate-600' : 'text-slate-400'}">· ${own ? esc(sigNames(own)) : 'as above'}</span></summary>
            <div class="px-3 pb-3 space-y-2">
              ${sigBoxes('WORKSHOP', own || t.signatories, 'cs-wsig')}
              <div class="flex flex-wrap gap-2">
                <button type="button" onclick="saveWorkshopSignatories(${Number(w.optionId)})" class="px-3 py-1.5 bg-navy hover:bg-indigo-700 text-white rounded-lg text-xs font-semibold">Save for this workshop</button>
                ${own ? `<button type="button" onclick="saveWorkshopSignatories(${Number(w.optionId)}, true)" class="px-3 py-1.5 border border-slate-300 rounded-lg text-xs font-semibold text-slate-700">Sign as above</button>` : ''}
                <a href="/api/admin/certificates/preview.pdf?kind=WORKSHOP&option=${encodeURIComponent(w.optionId)}" target="_blank" rel="noopener" class="px-3 py-1.5 border border-slate-300 rounded-lg text-xs font-semibold text-slate-700 hover:bg-slate-50">Preview specimen</a>
              </div>
            </div>
          </details>`;
        }).join('')}</div>
      </div>`;
  document.getElementById('cs-templates').innerHTML = Object.entries(d.templates).map(([kind, t]) => `
    <div class="bg-white rounded-2xl p-4 sm:p-5 border border-slate-200 shadow-sm space-y-2" data-kind="${esc(kind)}">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="text-sm font-bold text-slate-800">${esc(d.kinds[kind])}</h3>
        <a href="/api/admin/certificates/preview.pdf?kind=${encodeURIComponent(kind)}" target="_blank" rel="noopener" class="px-3 py-1.5 border border-slate-300 rounded-lg text-xs font-semibold text-slate-700 hover:bg-slate-50">Preview specimen</a>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <input value="${esc(t.title)}" data-tfield="title" aria-label="Title" placeholder="Title" class="h-9 px-3 border border-slate-300 rounded-lg text-sm outline-none">
        <input value="${esc(t.subtitle)}" data-tfield="subtitle" aria-label="Subtitle" placeholder="Subtitle" class="sm:col-span-2 h-9 px-3 border border-slate-300 rounded-lg text-sm outline-none">
        <input value="${esc(t.lead)}" data-tfield="lead" aria-label="Line above the name" placeholder="This is to certify that" class="sm:col-span-3 h-9 px-3 border border-slate-300 rounded-lg text-sm outline-none">
      </div>
      <textarea data-tfield="body" rows="4" aria-label="Wording after the name" class="w-full p-2.5 border border-slate-300 rounded-lg text-sm outline-none">${esc(t.body)}</textarea>
      <p class="text-[11px] text-slate-500">After the name. <b>**bold**</b> for bold; a new line for a new paragraph. ${chips}</p>
      <div>
        <p class="text-xs font-semibold text-slate-600 mb-1">Signed by (up to ${max}, in this order)${kind === 'WORKSHOP' ? ' — every workshop, unless it has its own below' : ''}</p>
        ${sigBoxes(kind, t.signatories, 'cs-tsig')}
      </div>
      <button type="button" onclick="saveCertificateTemplate('${esc(kind)}')" class="px-4 py-2 bg-navy hover:bg-indigo-700 text-white font-semibold text-sm rounded-lg">Save wording</button>
      ${kind === 'WORKSHOP' ? workshopRows(t) : ''}
    </div>`).join('');
}

async function putCertificateSettings(body, okText = 'Saved.') {
  const data = await (await fetch('/api/admin/certificates/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })).json();
  if (!data.success) { showToast(data.error || 'Could not save.'); return false; }
  showToast(okText, 'success');
  return true;
}

async function saveCertificateSettings() {
  const ok = await putCertificateSettings({
    mmc: { accreditationNo: document.getElementById('cs-mmc-no').value, points: document.getElementById('cs-mmc-points').value },
    eligibleCategories: Array.from(document.querySelectorAll('.cs-category')).filter((b) => b.checked).map((b) => b.value),
    attendance: { lunchSplit: document.getElementById('cs-lunch').value, earlyMinutes: Number(document.getElementById('cs-early').value), showFrom: document.getElementById('cs-show-from').value },
  });
  if (ok) renderCertificateSettings();
}

async function saveCertificateTemplate(kind) {
  const box = document.querySelector(`#cs-templates [data-kind="${kind}"]`);
  if (!box) return;
  const t = {};
  box.querySelectorAll('[data-tfield]').forEach((el) => { t[el.dataset.tfield] = el.value; });
  t.signatories = Array.from(box.querySelectorAll('.cs-tsig')).filter((b) => b.checked).map((b) => Number(b.value));
  const max = (certState.settings && certState.settings.maxSignatories) || 6;
  if (t.signatories.length > max) return showToast(`Up to ${max} signatories fit on a certificate.`);
  if (await putCertificateSettings({ templates: { [kind]: t } }, 'Wording saved. It applies to certificates already issued too.')) renderCertificateSettings();
}

// One workshop's own signatories; asDefault puts it back on the workshop
// certificate's.
async function saveWorkshopSignatories(optionId, asDefault = false) {
  const box = document.querySelector(`#cs-templates [data-ws="${optionId}"]`);
  if (!box) return;
  const ids = asDefault ? null : Array.from(box.querySelectorAll('.cs-wsig')).filter((b) => b.checked).map((b) => Number(b.value));
  const max = (certState.settings && certState.settings.maxSignatories) || 6;
  if (ids && ids.length > max) return showToast(`Up to ${max} signatories fit on a certificate.`);
  if (ids && !ids.length) return showToast('Tick at least one signatory, or use "Sign as above".');
  if (await putCertificateSettings({ templates: { WORKSHOP: { byWorkshop: { [optionId]: ids } } } }, 'Saved. It applies to certificates already issued too.')) renderCertificateSettings();
}

function readImageFile(input, maxBytes) {
  return new Promise((resolve) => {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return resolve(null);
    if (!/^image\/(png|jpeg)$/.test(file.type)) { showToast('Choose a PNG or JPEG image.'); return resolve(null); }
    if (maxBytes && file.size > maxBytes) { showToast(`The image must be under ${Math.round(maxBytes / 1048576)} MB.`); return resolve(null); }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

async function putSignatory(id, body) {
  const data = await (await fetch(`/api/admin/certificates/signatories/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })).json();
  if (!data.success) { showToast(data.error || 'Could not save.'); return; }
  showToast('Saved.', 'success');
  renderCertificateSettings();
}

function saveSignatory(id) {
  const field = (f) => document.querySelector(`.cs-sig-field[data-sig="${id}"][data-field="${f}"]`).value;
  putSignatory(id, { name: field('name'), designation: field('designation') });
}
function toggleSignatory(id, active) { putSignatory(id, { active: !!active }); }
async function uploadSignature(id, input) {
  const dataUrl = await readImageFile(input, 2 * 1048576);
  if (dataUrl) putSignatory(id, { signature: dataUrl });
}

async function addSignatory(e) {
  e.preventDefault();
  const name = document.getElementById('cs-new-sig-name').value.trim();
  const designation = document.getElementById('cs-new-sig-designation').value.trim();
  const data = await (await fetch('/api/admin/certificates/signatories', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, designation }),
  })).json();
  if (!data.success) return showToast(data.error || 'Could not add.');
  document.getElementById('cs-new-sig-name').value = '';
  document.getElementById('cs-new-sig-designation').value = '';
  showToast('Added. Upload their signature, and tick them on the certificates they sign.', 'success');
  renderCertificateSettings();
}

async function uploadCertificateBackground(input) {
  const dataUrl = await readImageFile(input, 0); // no size limit
  if (!dataUrl) return;
  const res = await fetch('/api/admin/certificates/background', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: dataUrl }),
  });
  if (res.status === 413) return showToast('That image is too large to send (over about 75 MB). Save it smaller and try again.');
  const data = await res.json();
  if (!data.success) return showToast(data.error || 'Could not upload.');
  showToast('Background uploaded. Preview a specimen to check the placement.', 'success');
  renderCertificateSettings();
}

async function removeCertificateBackground() {
  if (!(await showConfirm('Go back to the generated design?'))) return;
  const data = await (await fetch('/api/admin/certificates/background', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: null }),
  })).json();
  if (!data.success) return showToast(data.error || 'Could not change it.');
  renderCertificateSettings();
}

// --- BANK STATEMENT RECONCILIATION (admin) ---
async function handleStatementUpload(e) {
  e.preventDefault();
  const fileInput = document.getElementById('statement-file');
  const resultEl = document.getElementById('statement-upload-result');
  const file = fileInput.files[0];
  if (!file) return;

  resultEl.className = 'text-xs font-semibold text-slate-500';
  resultEl.textContent = 'Uploading…';

  const form = new FormData();
  form.append('file', file);
  try {
    const res = await fetch('/api/admin/bank-statement/upload', { method: 'POST', body: form });
    const data = await res.json();
    if (!data.success) {
      resultEl.className = 'text-xs font-semibold text-rose-600';
      resultEl.textContent = data.error || 'Upload failed.';
      return;
    }
    resultEl.className = 'text-xs font-semibold text-emerald-600';
    resultEl.textContent = `Imported ${data.imported} new row(s) of ${data.total} (${data.duplicates} already imported)`
      + (data.narrationsFilled ? `, filled in the bank's description for ${data.narrationsFilled} that read "By Transfer"` : '')
      + (data.linked ? `, auto-linked ${data.linked} to registrations.` : '.');
    fileInput.value = '';
    // Auto-linking can change registrations' bank_txn_id, so the Registration
    // Approval list (its "Linked" indicators, metrics, and badge) needs
    // refreshing too, not just this tab's own reconciliation view.
    await Promise.all([loadReconciliation(), renderBackendPayments()]);
  } catch (err) {
    resultEl.className = 'text-xs font-semibold text-rose-600';
    resultEl.textContent = `Upload error: ${err.message}`;
  }
}

// --- CASH AT THE DESK -> BULK DEPOSIT -----------------------------------
// Cash is verified when taken but unbanked until the day's takings go in as
// one credit. This panel is the only place that reconciliation happens:
// per-delegate linking would be the wrong shape, since one deposit covers
// many registrations. See the cash-deposit endpoints in server.js.
let cashInHandRows = [];

async function renderCashInHand(unmatchedCredits) {
  const panel = document.getElementById('cash-in-hand-panel');
  const body = document.getElementById('cash-in-hand-body');
  if (!panel || !body) return;

  const res = await fetch('/api/admin/cash-in-hand');
  if (!res.ok) { panel.classList.add('hidden'); return; }
  const data = await res.json();
  cashInHandRows = data.transactions || [];

  // Nothing in hand means nothing to reconcile -- and for most of a
  // conference's life there is no desk cash at all, so the panel stays out
  // of the way entirely rather than sitting empty.
  panel.classList.toggle('hidden', cashInHandRows.length === 0);
  if (!cashInHandRows.length) return;

  setText('cash-total-count', String(data.count));
  setText('cash-grand-total', `₹${inr(data.total)}`);

  body.innerHTML = cashInHandRows.map((t) => `
    <tr class="hover:bg-slate-50">
      <td class="py-3 px-4"><input type="checkbox" class="cash-row-checkbox" value="${esc(t.id)}" data-amount="${esc(t.amount)}" onchange="updateCashSelection()"></td>
      <td class="py-3 px-4 text-xs text-slate-500">${esc(fmtAuditTime(t.submitted_at) || '—')}</td>
      <td class="py-3 px-4 font-semibold text-slate-700">${esc(t.delegate_name || '—')}<br><span class="text-[11px] font-normal text-slate-400">${esc(t.category_label || '')}</span></td>
      <td class="py-3 px-4 font-mono text-xs">${esc(t.registration_number || '—')}</td>
      <td class="py-3 px-4 text-right font-semibold">₹${inr(t.amount)}</td>
    </tr>`).join('');

  // Only credits with room left can receive a deposit; each option carries
  // its remaining amount so the admin can see what fits before selecting.
  const sel = document.getElementById('cash-deposit-select');
  if (sel) {
    const opts = (unmatchedCredits || []).filter((c) => Number(c.credit) > 0);
    sel.innerHTML = opts.length
      ? '<option value="">— Choose the bank deposit —</option>' + opts.map((c) =>
          `<option value="${esc(c.id)}">${esc(c.post_date)} · ₹${inr(c.credit)} · ${esc(String(c.description || '').slice(0, 40))}</option>`).join('')
      : '<option value="">No unmatched credits — import the statement first</option>';
  }
  updateCashSelection();
}

function toggleAllCashRows(checked) {
  document.querySelectorAll('.cash-row-checkbox').forEach((b) => { b.checked = checked; });
  updateCashSelection();
}

function updateCashSelection() {
  const boxes = Array.from(document.querySelectorAll('.cash-row-checkbox'));
  const picked = boxes.filter((b) => b.checked);
  const total = picked.reduce((sum, b) => sum + (Number(b.dataset.amount) || 0), 0);
  setText('cash-selected-count', String(picked.length));
  setText('cash-selected-total', `₹${inr(total)}`);
  const all = document.getElementById('cash-select-all');
  if (all) all.checked = boxes.length > 0 && picked.length === boxes.length;
  const btn = document.getElementById('cash-deposit-btn');
  if (btn) btn.disabled = picked.length === 0;
}

async function submitCashDeposit() {
  const txnIds = Array.from(document.querySelectorAll('.cash-row-checkbox:checked')).map((b) => Number(b.value));
  const bankTxnId = (document.getElementById('cash-deposit-select') || {}).value;
  const resultEl = document.getElementById('cash-deposit-result');
  const show = (msg, ok) => {
    if (!resultEl) return;
    resultEl.className = `px-4 py-2.5 text-xs font-semibold border-t border-slate-100 ${ok ? 'text-emerald-700 bg-emerald-50/50' : 'text-rose-600 bg-rose-50/50'}`;
    resultEl.textContent = msg;
  };
  if (!txnIds.length) return show('Select at least one cash collection.', false);
  if (!bankTxnId) return show('Choose the bank deposit these were paid into.', false);

  const selected = txnIds.reduce((sum, id) => {
    const row = cashInHandRows.find((t) => Number(t.id) === id);
    return sum + (row ? Number(row.amount) || 0 : 0);
  }, 0);
  if (!(await showConfirm(`Link ${txnIds.length} cash collection(s) totalling ₹${inr(selected)} to this deposit?`))) return;

  const btn = document.getElementById('cash-deposit-btn');
  if (btn) btn.disabled = true;
  try {
    const data = await (await fetch('/api/admin/cash-deposit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bankTxnId: Number(bankTxnId), txnIds }),
    })).json();
    if (!data.success) return show(data.error || 'Could not link these collections.', false);
    show(`Linked ${data.linked} collection(s) totalling ₹${inr(data.total)}.`
      + (data.depositRemaining > 0 ? ` ₹${inr(data.depositRemaining)} of that deposit is still unaccounted for.` : ''), true);
    await loadReconciliation();
    await renderBackendPayments();
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function loadReconciliation() {
  const res = await fetch('/api/admin/bank-statement/reconcile');
  if (!res.ok) return;
  const data = await res.json();
  // Rendered from the same payload's unmatched credits, so the deposit
  // picker can only ever offer a credit that is genuinely still unallocated.
  await renderCashInHand(data.unmatchedCredits || []);

  setText('rec-metric-total', data.summary.registrations);
  setText('rec-metric-matched', data.summary.matched);
  setText('rec-metric-unmatched', data.summary.unmatched);
  setText('rec-metric-credits', data.summary.unmatchedCredits);
  setText('rec-metric-nonreg', data.summary.nonRegistrationCredits);

  const unmatchedBody = document.getElementById('rec-unmatched-body');
  if (unmatchedBody) {
    unmatchedBody.innerHTML = data.unmatched.length ? data.unmatched.map(r => `
      <tr>
        <td class="p-3 block sm:hidden">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="font-bold text-sm truncate">${esc(r.delegate_name)}</p>
              <p class="text-[11px] font-mono text-slate-400">${esc(r.registration_number || '—')}</p>
            </div>
            <p class="font-semibold text-slate-700 shrink-0">₹${inr(esc(r.paid_amount != null ? r.paid_amount : r.expected_amount))}</p>
          </div>
          <div class="flex items-center gap-2 mt-1.5">
            <span class="bg-slate-100 text-slate-600 border border-slate-300 text-[10px] font-bold px-2 py-0.5 rounded-full">${esc(PAYMENT_MODE_LABELS[r.payment_mode] || r.payment_mode || 'UPI')}</span>
            <span class="text-[11px] font-mono text-slate-500 truncate">${esc(r.utr_number)}</span>
          </div>
        </td>
        <td class="p-3 font-mono text-xs hidden sm:table-cell">${esc(r.registration_number || '—')}</td>
        <td class="p-3 hidden sm:table-cell">${esc(r.delegate_name)}</td>
        <td class="p-3 hidden sm:table-cell">${esc(PAYMENT_MODE_LABELS[r.payment_mode] || r.payment_mode || 'UPI')}</td>
        <td class="p-3 font-mono text-xs hidden sm:table-cell">${esc(r.utr_number)}</td>
        <td class="p-3 hidden sm:table-cell">₹${inr(esc(r.paid_amount != null ? r.paid_amount : r.expected_amount))}</td>
      </tr>`).join('') : `<tr><td colspan="5" class="p-4 text-center text-slate-400 text-xs">Every registration's reference was found in the statement.</td></tr>`;
  }

  const creditsBody = document.getElementById('rec-credits-body');
  if (creditsBody) {
    creditsBody.innerHTML = data.unmatchedCredits.length ? data.unmatchedCredits.map(t => `
      <tr>
        <td class="p-3 block sm:hidden">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="text-sm text-slate-700 truncate">${esc(t.description)}</p>
              <p class="text-[11px] text-slate-400">${esc(t.post_date)}</p>
            </div>
            <p class="font-semibold text-amber-700 shrink-0">₹${inr(esc(t.credit))}</p>
          </div>
          <div class="mt-1.5"><button type="button" onclick="markNonRegistration(${esc(t.id)}, true)" class="text-[11px] text-slate-500 hover:text-slate-700 underline font-semibold">Mark as non-registration</button></div>
        </td>
        <td class="p-3 hidden sm:table-cell">${esc(t.post_date)}</td>
        <td class="p-3 hidden sm:table-cell">${esc(t.description)}</td>
        <td class="p-3 font-semibold hidden sm:table-cell">₹${inr(esc(t.credit))}</td>
        <td class="p-3 text-right hidden sm:table-cell">
          <button type="button" onclick="markNonRegistration(${esc(t.id)}, true)" class="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-lg">Mark as Non-Registration</button>
        </td>
      </tr>`).join('') : `<tr><td colspan="4" class="p-4 text-center text-slate-400 text-xs">No unmatched credits.</td></tr>`;
  }

  const nonregBody = document.getElementById('rec-nonreg-body');
  if (nonregBody) {
    nonregBody.innerHTML = (data.nonRegistrationCredits || []).length ? data.nonRegistrationCredits.map(t => `
      <tr>
        <td class="p-3 block sm:hidden">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="text-sm text-slate-700 truncate">${esc(t.description)}</p>
              <p class="text-[11px] text-slate-400">${esc(t.post_date)}</p>
            </div>
            <p class="font-semibold text-slate-600 shrink-0">₹${inr(esc(t.credit))}</p>
          </div>
          <div class="mt-1.5"><button type="button" onclick="markNonRegistration(${esc(t.id)}, false)" class="text-[11px] text-indigo-600 hover:text-indigo-800 underline font-semibold">Unmark</button></div>
        </td>
        <td class="p-3 hidden sm:table-cell">${esc(t.post_date)}</td>
        <td class="p-3 hidden sm:table-cell">${esc(t.description)}</td>
        <td class="p-3 font-semibold hidden sm:table-cell">₹${inr(esc(t.credit))}</td>
        <td class="p-3 text-right hidden sm:table-cell">
          <button type="button" onclick="markNonRegistration(${esc(t.id)}, false)" class="px-3 py-1.5 bg-navy hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg">Unmark</button>
        </td>
      </tr>`).join('') : `<tr><td colspan="4" class="p-4 text-center text-slate-400 text-xs">No transactions marked non-registration.</td></tr>`;
  }

  renderDebits(data.debits || [], data.summary || {});

  cachedMatched = data.matched || [];
  filterMatchedRows();
}

// Debits -- the money-out side of the statement, which nothing else on this
// page looks at. A debit is either a refund this app made (and can therefore
// name the delegate for) or it is unexplained, and unexplained is the whole
// point of showing them: bank charges, a transfer out, a refund someone paid
// by hand without recording it here. Hidden entirely when the statement has
// no debits, which is the normal case for most of a conference.
function renderDebits(debits, summary) {
  const panel = document.getElementById('debits-panel');
  const body = document.getElementById('rec-debits-body');
  if (!panel || !body) return;

  panel.classList.toggle('hidden', debits.length === 0);
  if (!debits.length) return;

  setText('debit-count', String(debits.length));
  setText('debit-total', `₹${inr(summary.debitTotal || 0)}`);
  setText('debit-refunded', `₹${inr(summary.refundedDebitTotal || 0)}`);

  // What a debit was for, in one cell. A refund names its delegate and links
  // through to them; anything else says so plainly rather than showing an
  // empty cell, which reads as "not loaded yet" rather than "nobody knows".
  const appliedTo = (d) => {
    if (!d.refund) return '<span class="text-slate-400">Not a recorded refund</span>';
    // Text, not a link: nothing else on this page clicks through to a
    // registration, and one lone link here would look like the others are
    // broken. The reg number is what you search the Registrations tab with.
    const who = d.refund.registrationNumber
      ? `<span class="font-semibold text-slate-700">${esc(d.refund.delegateName || '—')}</span>`
        + `<span class="text-slate-400"> · ${esc(d.refund.registrationNumber)}</span>`
      : '<span class="text-slate-400">a deleted registration</span>';
    const note = d.refund.note ? `<br><span class="text-[11px] text-slate-400">${esc(d.refund.note)}</span>` : '';
    return `<span class="text-[11px] font-bold text-violet-700 uppercase">Refund</span> ${who}${note}`;
  };

  body.innerHTML = debits.map((d) => `
    <tr class="${d.refund ? '' : 'bg-amber-50/30'}">
      <td class="p-3 block sm:hidden">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="text-sm text-slate-700 truncate">${esc(d.description)}</p>
            <p class="text-[11px] text-slate-400">${esc(d.post_date)}</p>
          </div>
          <p class="font-semibold text-rose-600 shrink-0">₹${inr(esc(d.debit))}</p>
        </div>
        <p class="mt-1.5 text-xs">${appliedTo(d)}</p>
      </td>
      <td class="p-3 hidden sm:table-cell">${esc(d.post_date)}</td>
      <td class="p-3 hidden sm:table-cell">${esc(d.description)}</td>
      <td class="p-3 font-semibold text-rose-600 hidden sm:table-cell">₹${inr(esc(d.debit))}</td>
      <td class="p-3 text-xs hidden sm:table-cell">${appliedTo(d)}</td>
    </tr>`).join('');
}

// Mark/unmark a statement credit as not belonging to any registration. The
// server refuses to mark one that's currently linked (unlink it first), and
// once marked it's excluded from every "candidate credit" picker -- both
// enforced server-side, this just surfaces whatever it says.
async function markNonRegistration(id, value) {
  const data = await (await fetch(`/api/admin/bank-statement/${encodeURIComponent(id)}/non-registration`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }),
  })).json();
  if (!data.success) return showToast(data.error || 'Could not update this transaction.');
  showToast(value ? 'Marked as non-registration.' : 'Unmarked.', 'success');
  await loadReconciliation();
}

// The matched list, cached so the search box can filter it without refetching.
let cachedMatched = [];
function matchedRowHtml(m, serial) {
  // Same compact-pill shape as everywhere else (Phase 3) -- this one used a
  // plain `rounded` corner and lighter tones instead of `rounded-full` +
  // the standard rose-100/800/300 triad, which is exactly why it slipped
  // past that pass: it doesn't match "rounded-full", the pattern searched.
  const rejectedTag = m.bank_status === 'REJECTED'
    ? ' <span class="text-[10px] font-bold text-rose-800 bg-rose-100 border border-rose-300 rounded-full px-2 py-0.5">rejected</span>' : '';
  // linkedAmount is what THIS delegate's own portion of the credit is -- the
  // full credit amount unless it's split across more than one registration.
  // amountOk now describes the credit as a whole (fully & exactly
  // allocated, no leftover, no double-count), not "does this delegate's
  // claim match the credit" -- that comparison stopped making sense once a
  // credit can legitimately back more than one registration at less than
  // its full amount each.
  const isSplit = Number(m.linkedAmount) !== Number(m.transaction.credit);
  const amountLine = isSplit ? `₹${inr(esc(m.linkedAmount))} of ₹${inr(esc(m.transaction.credit))}` : `₹${inr(esc(m.transaction.credit))}`;
  return `
      <tr class="${m.bank_status === 'REJECTED' ? 'bg-rose-50/40' : (m.amountOk ? '' : 'bg-rose-50/50')}">
        <td class="p-3 block sm:hidden">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="font-bold text-sm truncate"><span class="text-slate-400 font-normal">${serial}.</span> ${esc(m.delegate_name)}${rejectedTag}</p>
              <p class="text-[11px] font-mono text-slate-400 truncate">${esc(m.registration_number || '—')} · ${esc(m.utr_number)}</p>
            </div>
            <div class="text-right shrink-0">
              <p class="font-semibold text-slate-700">${amountLine}</p>
              <p class="text-[10px] text-slate-400">${esc(m.transaction.post_date)}</p>
            </div>
          </div>
          ${m.transaction.description ? `<p class="text-[11px] text-slate-500 mt-1 truncate">${esc(m.transaction.description)}</p>` : ''}
          ${m.amountOk ? '' : `<p class="text-[11px] text-rose-600 font-bold mt-1">${ICON('warning')}credit not fully/exactly allocated</p>`}
        </td>
        <td class="p-3 text-slate-400 hidden sm:table-cell">${serial}</td>
        <td class="p-3 font-mono text-xs hidden sm:table-cell">${esc(m.registration_number || '—')}</td>
        <td class="p-3 hidden sm:table-cell">${esc(m.delegate_name)}${rejectedTag}</td>
        <td class="p-3 font-mono text-xs hidden sm:table-cell">${esc(m.utr_number)}</td>
        <td class="p-3 hidden sm:table-cell">${esc(m.transaction.post_date)}</td>
        <td class="p-3 text-xs text-slate-500 hidden sm:table-cell max-w-[240px] truncate" title="${esc(m.transaction.description || '')}">${esc(m.transaction.description || '—')}</td>
        <td class="p-3 hidden sm:table-cell">${amountLine}${m.amountOk ? '' : ` <span class="text-rose-600 font-bold">${ICON('warning')}not fully/exactly allocated</span>`}</td>
      </tr>`;
}

// Filter the matched list by the search box (reg no, name, UTR, description,
// amount) and render with running serial numbers.
function filterMatchedRows() {
  const body = document.getElementById('rec-matched-body');
  if (!body) return;
  const q = (document.getElementById('rec-matched-search')?.value || '').trim().toLowerCase();
  const list = !q ? cachedMatched : cachedMatched.filter((m) => {
    const hay = `${m.registration_number || ''} ${m.delegate_name || ''} ${m.utr_number || ''} ${m.transaction.description || ''} ${m.transaction.credit || ''}`.toLowerCase();
    return hay.includes(q);
  });
  const total = cachedMatched.length;
  setText('rec-matched-count', total ? (q ? `(${list.length} of ${total})` : `(${total})`) : '');
  body.innerHTML = list.length
    ? list.map((m, i) => matchedRowHtml(m, i + 1)).join('')
    : `<tr><td colspan="7" class="p-4 text-center text-slate-400 text-xs">${total ? 'No matches for this search.' : 'No matches yet — upload a statement above.'}</td></tr>`;
}


// --- FIRST PAINT -----------------------------------------------------------
// Apply the registration the server embedded in the page, before any network
// call, so the status chip is correct the moment the delegate sees it rather
// than starting on a placeholder and correcting itself. restoreSession()
// re-applies the freshly fetched copy a moment later, which is what makes a
// stale bootstrap self-correcting.
//
// Deliberately at the very BOTTOM of this file: it runs during script
// evaluation, so everything it touches has to be initialised already. Putting
// it higher is how the portal broke before -- a `const` declared further down
// threw a temporal-dead-zone error that killed the rest of the file. The
// try/catch is the second line of defence.
try {
  if (typeof window !== 'undefined' && window.__BOOTSTRAP_REG__ !== undefined
      && document.getElementById('payment-status-tag')) {
    applyRegistrationState(window.__BOOTSTRAP_REG__);
  }
} catch (err) {
  console.error('Could not apply the embedded registration; waiting for the fetch.', err);
}
