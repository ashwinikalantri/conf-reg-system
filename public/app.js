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
  if (nameEl) nameEl.textContent = (c.name || 'Registration Portal') + (nameEl.dataset.suffix || '');

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

// Defensively parsed: a bad/corrupted value here (e.g. the literal string
// "undefined", which JSON.parse rejects) must never throw at module load --
// that would abort every later top-level const/let in this file, leaving
// them in the temporal-dead-zone and breaking the whole page.
function readStoredDelegate() {
  const raw = localStorage.getItem('nqocn_current_user');
  if (!raw || raw === 'undefined' || raw === 'null') return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    localStorage.removeItem('nqocn_current_user');
    return null;
  }
}
let currentDelegate = readStoredDelegate();

// Never store undefined/null -- JSON.stringify(undefined) is the string
// "undefined", not valid JSON, which is exactly what corrupts the next load.
function persistDelegate(user) {
  if (user) localStorage.setItem('nqocn_current_user', JSON.stringify(user));
  else localStorage.removeItem('nqocn_current_user');
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

const ADMIN_ROLES = ['SUPER_ADMIN', 'FINANCE_ADMIN', 'ACADEMIC_REVIEWER', 'FINANCE_ACADEMIC', 'OPERATIONS'];
function isAdminUser() {
  return !!currentDelegate && ADMIN_ROLES.includes(currentDelegate.role);
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
  // The backend button is only for admins on the dashboard; hide it elsewhere.
  updateAdminNav(pageId === 'dashboard-page' && isAdminUser());
}

// Delegate portal only (admin.html has no #dashboard-page). Shows the
// dashboard immediately from the cached user, before restoreSession()'s
// network round-trip resolves -- otherwise the login page is what's in the
// HTML by default, and it flashes on screen for every returning delegate
// until that fetch comes back. restoreSession() still re-validates against
// the server afterwards and reverts to the login page if the session
// turned out to be stale. (Placed here, after navigateTo/isAdminUser/
// ADMIN_ROLES are defined, not at the top of the file -- calling
// navigateTo() before ADMIN_ROLES's `const` initializer has run throws a
// temporal-dead-zone ReferenceError that silently aborts the rest of this
// script's top-level execution.)
if (currentDelegate && document.getElementById('dashboard-page')) {
  navigateTo('dashboard-page');
  const displayName = currentDelegate.full_name || currentDelegate.name;
  const nameEl = document.getElementById('user-display-name');
  const subEl = document.getElementById('user-display-sub');
  if (nameEl) nameEl.innerText = currentDelegate.salutation ? `${currentDelegate.salutation} ${displayName}` : displayName;
  if (subEl) subEl.innerText = `${currentDelegate.designation} | ${currentDelegate.institution || currentDelegate.institute} (${delegateDisplayPhone(currentDelegate) || currentDelegate.email || ''})`;
}

function toggleAuth(view) {
  const regForm = document.getElementById('register-form');
  const loginForm = document.getElementById('login-form');

  if (view === 'register') {
    // Fill the country list and apply its rules the first time the form is
    // shown, so the phone/address fields are never briefly in the wrong shape.
    populateSignupCountries();
    onSignupCountryChange();
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
let loginMode = 'otp';
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

// --- PIN CODE API (India Post) ---
async function fetchAddressDetails(pincode) {
  const statusSpan = document.getElementById('pincode-status');
  const stateInput = document.getElementById('reg-state');
  const districtInput = document.getElementById('reg-district');

  if (pincode.length !== 6) {
    statusSpan.innerText = '';
    stateInput.value = '';
    districtInput.value = '';
    return;
  }

  statusSpan.innerText = 'Fetching details...';
  statusSpan.className = 'text-xs mt-1 block text-indigo-600';

  try {
    const res = await fetch(`https://api.postalpincode.in/pincode/${pincode}`);
    const data = await res.json();

    if (data && data[0].Status === 'Success') {
      const postOffices = data[0].PostOffice;
      stateInput.value = postOffices[0].State;
      districtInput.value = postOffices[0].District;

      statusSpan.innerText = '✓ PIN Code verified';
      statusSpan.className = 'text-xs mt-1 block text-emerald-600 font-bold';
    } else {
      throw new Error("Invalid PIN");
    }
  } catch (err) {
    statusSpan.innerText = 'Invalid PIN Code or API unreachable';
    statusSpan.className = 'text-xs mt-1 block text-rose-600 font-bold';
    stateInput.value = '';
    districtInput.value = '';
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
  const otpBtn = document.getElementById('btn-send-reg-otp');

  if (cc) cc.classList.toggle('hidden', !india);
  if (phone) {
    phone.classList.toggle('pl-12', india);
    phone.maxLength = india ? 10 : 20;
    phone.placeholder = india ? '10-digit Mobile No.' : 'e.g. +44 7700 900123';
    if (!india) phone.value = phone.value.replace(/^\+?91/, '');
  }
  setText('reg-phone-label', india ? 'Mobile Number' : 'Mobile Number (optional)');
  // We can only SMS Indian numbers, so there is no OTP to send anywhere
  // else -- an international delegate verifies by email instead.
  if (otpBtn) otpBtn.classList.toggle('hidden', !india);
  const otpBox = document.getElementById('reg-otp-container');
  if (!india && otpBox) { otpBox.classList.add('hidden'); const o = document.getElementById('reg-otp'); if (o) o.value = ''; }

  const indiaBlock = document.getElementById('reg-address-india');
  const intlBlock = document.getElementById('reg-address-intl');
  if (indiaBlock) indiaBlock.classList.toggle('hidden', !india);
  if (intlBlock) { intlBlock.classList.toggle('hidden', india); intlBlock.classList.toggle('grid', !india); }
  updateSignupVerifyStatus();
}

async function handleRegistration(e) {
  e.preventDefault();
  const phone = document.getElementById('reg-phone').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const phoneOtp = document.getElementById('reg-otp').value.trim();
  const emailOtp = document.getElementById('reg-email-otp').value.trim();

  const country = (document.getElementById('reg-country') || {}).value || 'India';
  const india = signupCountryIsIndia();
  if (india && !phone) return showToast('A mobile number is required.');
  if (india && phone && !isIndianPhone(phone)) {
    return showToast('Enter a valid 10-digit Indian mobile number, or change your country.');
  }
  if (phone && !isPhoneValue(phone)) return showToast('Please enter a valid mobile number, including the country code.');
  if (!india && phone && isIndianPhone(phone)) {
    return showToast('That looks like an Indian mobile number — please set your country to India.');
  }
  if (email && !EMAIL_RE.test(email)) return showToast('Please enter a valid email address.');
  // The server is the real gate (it burns the OTP); this just avoids a
  // pointless round trip and gives a clearer message.
  if (!phoneOtp && !emailOtp) {
    return showToast(india
      ? 'Verify your mobile number or your email address with an OTP to continue.'
      : 'Verify your email address with an OTP to continue — we can only send SMS to Indian numbers.');
  }

  const password = document.getElementById('reg-password').value;
  if (!password || password.length < 8) {
    return showToast('Please set a password of at least 8 characters.');
  }

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
    // New identifier — switch to sign-up, carrying it across.
    toggleAuth('register');
    const isEmail = EMAIL_RE.test(identifier);
    document.getElementById(isEmail ? 'reg-email' : 'reg-phone').value = identifier;
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
  // phone_number is the account key, which is only a real number for
  // phone-based accounts -- fall back to the email for email-only ones
  // rather than printing a synthetic key as if it were a mobile.
  const contactLine = delegateDisplayPhone(currentDelegate)
    ? delegateDisplayPhone(currentDelegate)
    : (currentDelegate.email || '');
  document.getElementById('user-display-sub').innerText =
    `${currentDelegate.designation} | ${currentDelegate.institution || currentDelegate.institute}${contactLine ? ` (${contactLine})` : ''}`;

  renderVerifyEmailBanner();

  const statusTag = document.getElementById('payment-status-tag');
  const confBtn = document.getElementById('register-conf-btn');
  const reverifyBanner = document.getElementById('reverify-banner');
  const confirmedBlock = document.getElementById('confirmed-block');

  const regRes = await fetch('/api/registrations/me');
  const regData = await regRes.json();
  const reg = regData.registration;
  currentRegistration = reg;

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
  if (verified) {
    document.getElementById('reg-number-display').innerText = reg.registration_number || '—';
    const selBox = document.getElementById('conf-selections');
    if (selBox) {
      const selections = reg.selections || [];
      selBox.innerHTML = selections.length
        ? selections.map((s) => `<div><span class="text-slate-500">${esc(s.group_name)}:</span> <span class="font-semibold text-slate-800">${esc(s.option_name)}</span></div>`).join('')
        : '';
    }
  }

  if (!reg) {
    // No payment submitted yet — reset to the initial pending state.
    statusTag.className = "text-xs bg-amber-100 text-amber-800 font-bold px-2.5 py-1 rounded-full border border-amber-200";
    statusTag.innerText = "Registration Pending";
    confBtn.innerText = "Register & Pay Now";
    reverifyBanner.classList.add('hidden');
  } else if (verified) {
    // Confirmed: the action button/note are hidden; only the confirmed block
    // (number, workshop, QI, receipt) is shown.
    statusTag.className = "text-xs bg-emerald-100 text-emerald-800 font-bold px-3 py-1 rounded-full border border-emerald-300";
    statusTag.innerText = "Registration Confirmed ✓";
    reverifyBanner.classList.add('hidden');
  } else if (reg.bank_status === 'REJECTED') {
    // Rejected: show the reason and the tailored action the delegate should
    // take. The button dispatches by reason (see resolveRejection).
    statusTag.className = "text-xs bg-rose-100 text-rose-800 font-bold px-3 py-1 rounded-full border border-rose-300";
    statusTag.innerText = "Registration Rejected";

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
    statusTag.className = "text-xs bg-orange-100 text-orange-800 font-bold px-3 py-1 rounded-full border border-orange-300";
    statusTag.innerText = "Partial Payment — Balance Due";
    reverifyBanner.classList.add('hidden');
  } else {
    // Pending manual verification: payment details are locked once
    // submitted, so there is nothing for the delegate to edit here. Hide
    // the action button entirely rather than opening a form the server
    // will just reject.
    statusTag.className = "text-xs bg-amber-100 text-amber-800 font-bold px-3 py-1 rounded-full border border-amber-300";
    statusTag.innerText = reg.is_flagged ? "Flagged - Awaiting Manual Audit" : "Registration Pending (Awaiting Verification)";
    reverifyBanner.classList.add('hidden');
  }

  await loadAbstractStatus();
  await renderGroupSection();
  navigateTo('dashboard-page');
}

// --- GROUP REGISTRATION (delegate) ---
const GROUP_STATUS_LABEL = { BANK_VERIFIED: 'Paid ✓', PARTIAL_PAYMENT: 'Balance due', PENDING: 'Pending', REJECTED: 'Rejected', NOT_REGISTERED: 'Not paid' };
async function renderGroupSection() {
  const box = document.getElementById('group-section');
  if (!box) return;
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
        <h3 class="text-lg font-bold text-slate-800">👥 Group Registration</h3>
        <span class="text-xs text-slate-500">${esc(g.categoryLabel)} · ${g.size} member${g.size === 1 ? '' : 's'}</span>
      </div>
      <p class="text-xs mb-3">${statusLine}</p>
      <div class="bg-white rounded-lg border border-indigo-100 px-3 py-1 mb-3">${rows}</div>
      <div class="flex flex-wrap gap-2">
        ${g.isLeader ? `<button onclick="openAddGroupMember()" class="px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg">+ Add member</button>` : ''}
        <button onclick="leaveGroup()" class="px-3 py-2 bg-white border border-slate-300 text-slate-600 hover:bg-slate-50 text-xs font-semibold rounded-lg">Leave group</button>
      </div>
      <p class="text-[11px] text-slate-500 mt-3">Each member pays their own (discounted) fee. The discount is confirmed once every member's payment is verified.</p>`;
    box.classList.remove('hidden');
    return;
  }

  // Not in a group: offer to start one for any category that has a rule.
  const eligible = (await (await fetch('/api/groups/eligible-categories')).json().catch(() => ({}))).categories || [];
  if (!eligible.length) { box.classList.add('hidden'); return; }
  box.innerHTML = `
    <div class="flex items-center justify-between mb-2">
      <h3 class="text-lg font-bold text-slate-800">👥 Group Registration</h3>
      <span class="text-xs text-slate-500">Save with 5+ delegates</span>
    </div>
    <p class="text-xs text-slate-600 mb-3">Registering as a group? Start a group and add fellow delegates in the same category to unlock a group discount for everyone.</p>
    <div class="flex flex-wrap gap-2 items-end">
      <select id="group-start-cat" class="h-9 px-3 border border-slate-300 rounded-lg text-sm bg-white outline-none">
        ${eligible.map((c) => `<option value="${esc(c.category_key)}">${esc(c.label)} — ${c.discount_type === 'PERCENT' ? esc(c.discount_value) + '%' : '₹' + inr(c.discount_value)} off for ${esc(c.min_size)}+</option>`).join('')}
      </select>
      <button onclick="startGroup()" class="h-9 px-4 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold rounded-lg">Start a group</button>
    </div>`;
  box.classList.remove('hidden');
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
async function loadAbstractStatus() {
  const tag = document.getElementById('abstract-status-tag');
  const btn = document.getElementById('abstract-action-btn');
  const desc = document.getElementById('abstract-desc');
  if (!tag) return;
  const STYLES = {
    UNDER_REVIEW: ['Under Review', 'bg-amber-100 text-amber-700'],
    ACCEPTED: ['Accepted ✓', 'bg-emerald-100 text-emerald-700'],
    REJECTED: ['Not Accepted', 'bg-rose-100 text-rose-700'],
    REVISION_REQUESTED: ['Corrections Needed', 'bg-orange-100 text-orange-700'],
  };
  const previewToggle = document.getElementById('abstract-preview-toggle');
  const previewBox = document.getElementById('abstract-preview-box');
  try {
    const abs = (await (await fetch('/api/abstracts/me')).json()).abstract;
    cachedOwnAbstract = abs;
    if (abs) {
      let [label, cls] = STYLES[abs.status] || ['Submitted', 'bg-slate-100 text-slate-600'];
      if (abs.status === 'ACCEPTED' && abs.allocation) {
        label = `Accepted · ${abs.allocation === 'ORAL' ? 'Oral' : 'Poster'}`;
      }
      tag.className = `text-xs font-bold px-2 py-0.5 rounded-full ${cls}`;
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
          const kind = abs.allocation === 'ORAL' ? 'oral' : 'poster';
          desc.innerHTML = `Your abstract has been <b>accepted for ${kind} presentation</b>. Details will be communicated.`;
        } else if (abs.status === 'ACCEPTED') {
          desc.innerHTML = 'Your abstract has been <b>accepted</b>. The presentation format will be communicated.';
        } else if (abs.status === 'REJECTED') {
          desc.innerText = 'Your abstract was not accepted.';
        } else if (needsRevision) {
          desc.innerHTML = `<b>The committee has requested corrections:</b> ${esc(abs.revision_note || '')}`;
        } else {
          desc.innerText = 'Your abstract has been submitted and is under review. It cannot be changed.';
        }
      }
      if (previewToggle) previewToggle.classList.remove('hidden');
      if (previewBox) previewBox.classList.add('hidden'); // collapsed by default each load
    } else {
      tag.className = 'text-xs bg-slate-100 text-slate-600 font-bold px-2 py-0.5 rounded-full';
      tag.innerText = 'Not Submitted';
      if (btn) { btn.innerText = 'Submit Abstract'; btn.disabled = false; btn.classList.remove('opacity-60', 'cursor-not-allowed'); }
      if (previewToggle) previewToggle.classList.add('hidden');
      if (previewBox) previewBox.classList.add('hidden');
    }
  } catch (e) { /* leave as-is */ }
}

// Cached so the preview toggle doesn't need a second round trip.
let cachedOwnAbstract = null;

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

// Explicit remove action once a code is applied -- clearing the input text
// and re-clicking Apply worked but wasn't a discoverable way to drop a code.
// Triggered by the small ✕ shown next to the "Discount (CODE)" line.
function removeAppliedPromo() {
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
    showMsg(`Code applied — you save ₹${inr(data.discountAmount)}. New fee: ₹${inr(data.finalFee)}.`, true);
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
async function loadFees() {
  try {
    const data = await (await fetch('/api/fees')).json();
    feeCategories = {};
    (data.categories || []).forEach((c) => { feeCategories[c.key] = c; });
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
    renderCategoryDropdown(data.categories || []);
  } catch (e) {
    /* keep any hardcoded fallback options */
  }
}

// Custom category picker: the underlying <select id="payment-category"> stays
// in the DOM (hidden) so calculateFee()/submit keep reading its .value --
// this just renders a nicer label/subtitle/fee row on top of it and keeps
// the two in sync.
function renderCategoryDropdown(categories) {
  const panel = document.getElementById('category-dropdown-panel');
  if (!panel) return;
  panel.innerHTML = categories.map((c) => `
    <button type="button" class="category-option w-full text-left p-3 border-b border-slate-100 last:border-b-0 hover:bg-slate-50 flex items-start justify-between gap-3" data-key="${esc(c.key)}" onclick="selectCategory('${esc(c.key)}')">
      <div class="min-w-0">
        <p class="font-semibold text-slate-800 text-sm">${esc(c.label)}</p>
        ${c.subtitle ? `<p class="text-xs text-slate-500 mt-0.5">${esc(c.subtitle)}</p>` : ''}
      </div>
      <p class="font-semibold text-slate-700 text-sm shrink-0">₹${inr(Number(c.fee))}</p>
    </button>`).join('');

  // Re-sync the button label if a category was already selected (e.g. re-opening the modal).
  const sel = document.getElementById('payment-category');
  const chosen = categories.find((c) => c.key === (sel && sel.value));
  setCategoryDropdownLabel(chosen || null);
}

function setCategoryDropdownLabel(category) {
  const label = document.getElementById('category-dropdown-label');
  if (!label) return;
  if (category) {
    label.innerText = category.label;
    label.classList.remove('text-slate-400');
  } else {
    label.innerText = '-- Select Category --';
    label.classList.add('text-slate-400');
  }
}

function toggleCategoryDropdown(forceOpen) {
  const panel = document.getElementById('category-dropdown-panel');
  if (!panel) return;
  const open = forceOpen !== undefined ? forceOpen : panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !open);
}

function selectCategory(key) {
  const sel = document.getElementById('payment-category');
  if (!sel) return;
  sel.value = key;
  setCategoryDropdownLabel(feeCategories[key] || null);
  toggleCategoryDropdown(false);
  calculateFee(); // nothing listens for the hidden select's 'change' event, so call it directly
}

document.addEventListener('click', (e) => {
  const panel = document.getElementById('category-dropdown-panel');
  const btn = document.getElementById('category-dropdown-btn');
  if (!panel || panel.classList.contains('hidden')) return;
  if (!panel.contains(e.target) && e.target !== btn) toggleCategoryDropdown(false);
});

// Refresh capacity + fees then open the payment modal.
async function openPaymentModal() {
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
  const btn = document.getElementById('category-dropdown-btn');
  const locked = !!(reg && reg.category_locked);
  if (locked && reg.category_key) {
    selectCategory(reg.category_key);
    setCategoryDropdownLabel(feeCategories[reg.category_key] || { label: reg.category_label });
  }
  if (btn) {
    btn.disabled = locked;
    btn.classList.toggle('opacity-60', locked);
    btn.classList.toggle('cursor-not-allowed', locked);
    btn.onclick = locked ? null : () => toggleCategoryDropdown();
  }
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
  document.getElementById(id).classList.remove('hidden');
  if (id === 'modal-abstract') {
    // A delegate whose abstract was sent back for corrections
    // (REVISION_REQUESTED -- the only status that leaves the dashboard
    // button enabled here, see loadAbstractStatus) gets the form prefilled
    // with what they already submitted; anyone else gets a blank form.
    if (cachedOwnAbstract && cachedOwnAbstract.status === 'REVISION_REQUESTED') {
      prefillAbstractFormForRevision(cachedOwnAbstract);
    } else {
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
}

// In-page confirmation dialog. Native confirm() is unreliable — browsers
// suppress repeated dialogs and then it silently returns false — so the
// admin panel uses this modal instead. Resolves true/false.
function showConfirm(message, okText = 'Confirm', cancelText = 'Cancel') {
  return new Promise((resolve) => {
    const modal = document.getElementById('modal-confirm');
    if (!modal) return resolve(window.confirm(message)); // fallback
    document.getElementById('confirm-message').textContent = message;
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
  if (sessionStorage.getItem('verifyEmailPromptDismissed')) return;
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
function openSetPasswordModal(mandatory) {
  const closeBtn = document.getElementById('set-password-close-btn');
  if (closeBtn) closeBtn.classList.toggle('hidden', !!mandatory);
  setText('set-password-title', mandatory ? 'Set a password to continue' : 'Set Password');
  setText('set-password-blurb', mandatory
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
  sessionStorage.setItem('verifyEmailPromptDismissed', '1');
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
    showToast('Email verified.', 'success');
    closeModal('modal-verify-email');
    renderVerifyEmailBanner();
  } finally {
    btn.disabled = false;
  }
}

async function logout() {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
  currentDelegate = null;
  localStorage.removeItem('nqocn_current_user');
  // Full navigation so this works from both the delegate portal and /admin.
  window.location.href = '/';
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

// Populates the signup form's Designation/Institute <datalist> options from
// what's already on file, so a new delegate can pick an existing spelling
// instead of typing a near-duplicate -- the fields stay plain text inputs,
// so typing anything not in the list is still accepted. No-op on admin.html
// (no signup form there) since the datalist elements simply won't exist.
async function loadDirectorySuggestions() {
  const designationList = document.getElementById('designation-options');
  const instituteList = document.getElementById('institute-options');
  if (!designationList && !instituteList) return;
  try {
    const res = await fetch('/api/directory/suggestions');
    if (!res.ok) return;
    const data = await res.json();
    if (designationList) {
      designationList.innerHTML = (data.designations || []).map((d) => `<option value="${esc(d)}">`).join('');
    }
    if (instituteList) {
      instituteList.innerHTML = (data.institutions || []).map((i) => `<option value="${esc(i)}">`).join('');
    }
  } catch (e) {
    /* offline — the fields still work as plain free-text inputs */
  }
}
document.addEventListener('DOMContentLoaded', loadDirectorySuggestions);
// Public (no login required) -- runs on both the delegate landing page and
// the admin panel, so conference name/dates/location/acronym shown as static
// page text everywhere reflect the current Settings → General value.
document.addEventListener('DOMContentLoaded', loadConferenceInfo);

// --- ADMIN & BACKEND LOGIC ---

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
    programsBox.addEventListener('click', (e) => {
      const save = e.target.closest('.prog-save');
      if (save) {
        const capInput = programsBox.querySelector(`.prog-capacity[data-id="${save.dataset.id}"]`);
        const feeInput = programsBox.querySelector(`.prog-fee[data-id="${save.dataset.id}"]`);
        return saveProgramOption(save.dataset.id, parseInt(capInput.value, 10), parseFloat(feeInput.value) || 0);
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
    feeBody.addEventListener('click', (e) => {
      const save = e.target.closest('.fee-save');
      if (save) return saveFeeCategory(save.dataset.id);
      const toggle = e.target.closest('.fee-toggle');
      if (toggle) return toggleFeeCategory(toggle.dataset.id, toggle.dataset.active === '1' ? 0 : 1);
      const del = e.target.closest('.fee-delete');
      if (del) return deleteFeeCategory(del.dataset.id);
    });
  }
}

// Set the text of an element if it exists.
function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
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
    ? `<span class="text-emerald-600 font-bold" title="${esc(what)} matches the payment screenshot">✓</span>`
    : `<span class="text-rose-600 font-bold" title="${esc(what)} does not match the payment screenshot">✗</span>`;
}

// Format an epoch-ms audit timestamp for display; '' when absent.
function fmtAuditTime(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms));
  return isNaN(d) ? '' : d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

// Which broad capabilities a role grants. Single source of truth -- used by
// applyRoleVisibility() to show/hide chrome and by allowedBackendTabs() to
// decide which tabs may be opened, so the two can't drift apart.
function rolesFor(role) {
  const isSuper = role === 'SUPER_ADMIN';
  return {
    isSuper,
    isFinance: isSuper || role === 'FINANCE_ADMIN' || role === 'FINANCE_ACADEMIC',
    isReviewer: isSuper || role === 'ACADEMIC_REVIEWER' || role === 'FINANCE_ACADEMIC',
    // Reports (all of them) + Users & Roles only -- not Payments/Statement/
    // Abstracts, so isOperations is its own flag rather than folded into
    // isFinance/isReviewer above.
    isOperations: isSuper || role === 'OPERATIONS',
  };
}

// Show only the nav tabs and default to the first section this admin's role
// is allowed to use.
function applyRoleVisibility(role) {
  const { isSuper, isFinance, isReviewer, isOperations } = rolesFor(role);

  const tabPayments = document.getElementById('nav-tab-payments');
  const tabStatement = document.getElementById('nav-tab-statement');
  const tabAbstracts = document.getElementById('nav-tab-abstracts');
  const tabReports = document.getElementById('nav-tab-reports');
  if (tabPayments) tabPayments.classList.toggle('hidden', !isFinance);
  if (tabStatement) tabStatement.classList.toggle('hidden', !isFinance);
  if (tabAbstracts) tabAbstracts.classList.toggle('hidden', !isReviewer);
  if (tabReports) tabReports.classList.toggle('hidden', !(isFinance || isReviewer || isOperations));

  // POST /api/admin/registrations is requireRole('SUPER_ADMIN', 'FINANCE_ADMIN')
  // -- same as isFinance, since ROLE_IMPLIES grants FINANCE_ACADEMIC the
  // FINANCE_ADMIN role too (see server.js), so no narrower check is needed here.
  const registerBtn = document.getElementById('register-delegate-btn');
  if (registerBtn) registerBtn.classList.toggle('hidden', !isFinance);

  // Masters/Users/Reminders/Logs live in the header's Settings menu, not
  // the main tab bar. The menu button itself only shows if at least one
  // item would.
  const settingsMenuBtn = document.getElementById('settings-menu-btn');
  // Super-admin-only masters; Reminders + Group Discount also open to finance;
  // Users & Roles also opens to Operations (see isOperations above).
  const superItems = ['programs', 'fees', 'general', 'discount', 'activity'];
  const financeItems = ['reminders', 'groupdiscount'];
  superItems.forEach((key) => {
    const el = document.getElementById(`settings-item-${key}`);
    if (el) el.classList.toggle('hidden', !isSuper);
  });
  financeItems.forEach((key) => {
    const el = document.getElementById(`settings-item-${key}`);
    if (el) el.classList.toggle('hidden', !isFinance);
  });
  const usersItem = document.getElementById('settings-item-users');
  if (usersItem) usersItem.classList.toggle('hidden', !(isSuper || isOperations));
  if (settingsMenuBtn) settingsMenuBtn.classList.toggle('hidden', !(isSuper || isFinance || isOperations));

  // Show only the report cards this role can access. Operations sees all of
  // them, same as Super Admin.
  const rd = document.getElementById('report-delegates');
  const rdp = document.getElementById('report-delegate-programs');
  const rp = document.getElementById('report-payments');
  const rw = document.getElementById('report-workshops');
  const ra = document.getElementById('report-abstracts');
  if (rd) rd.classList.toggle('hidden', !(isFinance || isOperations));
  if (rdp) rdp.classList.toggle('hidden', !(isFinance || isOperations));
  if (rp) rp.classList.toggle('hidden', !(isFinance || isOperations));
  if (rw) rw.classList.toggle('hidden', !(isFinance || isOperations));
  if (ra) ra.classList.toggle('hidden', !(isReviewer || isOperations));

  return { isSuper, isFinance, isReviewer, isOperations };
}

async function initBackendPortal() {
  setupAdminDelegation();

  // Identify the logged-in admin from the session, not a client-side switcher.
  const meRes = await fetch('/api/auth/me');
  if (!meRes.ok) {
    showToast('Please log in through the delegate portal with an administrator account.');
    window.location.href = '/';
    return;
  }
  activeAdminUser = (await meRes.json()).user;
  setText('active-admin-role-badge', activeAdminUser.full_name);

  const { isSuper, isFinance, isReviewer, isOperations } = applyRoleVisibility(activeAdminUser.role);

  // Land on the section from the URL (so a refresh, bookmark, or shared link
  // stays put), falling back to the first section this role can actually use.
  // A hash naming a tab this role can't open -- a stale bookmark, or a link
  // from a super admin -- falls back too rather than showing an empty page.
  // Done now, before the awaited renders below, not after: switching tabs
  // here first means an admin who clicks a different tab while data is still
  // loading stays where they clicked; switching again afterwards would
  // silently snap them back once loading finished.
  const defaultTab = isFinance ? 'payments' : isReviewer ? 'abstracts' : isOperations ? 'reports' : 'workshops';
  const allowed = allowedBackendTabs({ isSuper, isFinance, isReviewer, isOperations });
  const hashTab = window.location.hash.slice(1);
  const loading = document.getElementById('admin-initial-loading');
  if (loading) loading.classList.add('hidden');
  switchBackendTab(allowed.includes(hashTab) ? hashTab : defaultTab);

  // Render every section this role may see (this also fills the tab badges).
  if (isFinance) await renderBackendPayments();
  if (isFinance) renderDelegateMap();
  if (isReviewer) await renderBackendAbstracts();
  // Users & Roles is also open to OPERATIONS (see allowedBackendTabs/
  // applyRoleVisibility above) -- everything below this line stays
  // isSuper-only, since those are the SUPER_ADMIN-only masters.
  if (isSuper || isOperations) await loadBackendUsers();
  if (isSuper) await renderBackendPrograms();
  if (isSuper) await renderBackendFees();
  if (isSuper) await renderDiscountCodes();
  if (isSuper) await renderGroupRules();
  if (isSuper) await renderGeneralSettings();
  if (isSuper) await renderBackendActivity();
  if (isFinance) await loadReportWorkshopOptions();
  if (isFinance) await renderBackendReminders(isSuper);
  if (isFinance) await renderBackendBalanceDueReminders(isSuper);
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
  const statusTone = p.bank_status === 'REJECTED' ? 'bg-rose-100 text-rose-800'
    : p.bank_status === 'BANK_VERIFIED' ? 'bg-emerald-100 text-emerald-800'
    : p.bank_status === 'PARTIAL_PAYMENT' ? 'bg-orange-100 text-orange-800'
    : 'bg-amber-100 text-amber-800';
  const balanceDue = isBalanceDue(p);
  const statusLabel = p.bank_status === 'PARTIAL_PAYMENT' ? 'PARTIAL'
    : (balanceDue ? 'BALANCE DUE' : (BANK_STATUS_LABELS[p.bank_status] || p.bank_status).toUpperCase());
  const statusTone2 = balanceDue ? 'bg-orange-100 text-orange-800' : statusTone;
  const statusPill = `<span class="${statusTone2} text-[10px] sm:text-xs px-2 sm:px-2.5 py-0.5 sm:py-1 rounded-full font-bold">${esc(statusLabel)}</span>`;
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
    ? `<span class="text-[10px] text-orange-700 font-semibold">₹${inr(paidSoFar)} of ₹${inr(Number(p.expected_amount))} · ₹${inr(owed)} due</span>`
    : '';
  const reviseHint = categoryChangedShortfall
    ? `<span class="text-[10px] text-orange-700 font-semibold bg-orange-50 border border-orange-200 rounded px-1.5 py-0.5">⚠ Category changed — revise</span>`
    : '';
  // Verified payments (net of any already-recorded refund) exceed what was
  // owed -- surfaced here so it's visible while scanning the list, not only
  // after opening Review (see getPaymentSummary's overpaid / the refund
  // section inside the review modal, where it's actually recorded as
  // refunded).
  const overpaidAmt = Number(p.overpaid) || 0;
  const overpaidPill = overpaidAmt > 0
    ? `<span class="text-[10px] text-amber-700 font-semibold bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">💰 ₹${inr(overpaidAmt)} excess paid</span>`
    : '';
  // Link status is now per transaction: show "linked" only when every pending
  // payment has its own bank credit linked. Verified/rejected rows (no pending
  // transactions) don't show the pill.
  const pendingTxns = (p.transactions || []).filter((t) => t.txn_status === 'PENDING');
  const allPendingLinked = pendingTxns.length > 0 && pendingTxns.every((t) => t.bank_txn_id != null);
  const linkedPill = pendingTxns.length === 0 ? ''
    : `<span class="text-[10px] ${allPendingLinked ? 'text-emerald-600' : 'text-amber-600'} font-semibold">${allPendingLinked ? '🔗 Linked' : '⚠ Not linked'}</span>`;
  const idPill = isStudentCategory(p.category_key)
    ? `<span class="text-[10px] ${p.id_verified ? 'text-emerald-600' : 'text-amber-600'} font-semibold">${p.id_verified ? '🎓 ID Verified' : '⚠ ID Not Verified'}</span>`
    : '';
  const rejectionNote = p.bank_status === 'REJECTED' && p.rejection_reason
    ? `<span class="text-[10px] text-rose-600 font-semibold">${esc(REJECTION_LABELS[p.rejection_reason] || p.rejection_reason)}${p.rejection_note ? ': ' + esc(p.rejection_note) : ''}</span>`
    : '';
  const reviewBtn = `<button class="review-btn px-3 py-1.5 ${p.is_flagged ? 'bg-red-600 hover:bg-red-700' : 'bg-indigo-600 hover:bg-indigo-700'} text-white font-semibold rounded-lg text-xs shadow-sm" data-id="${esc(p.id)}">${p.is_flagged ? 'Review (Force Verify)' : 'Review'}</button>`;

  return `
    <tr class="border-b border-slate-100 ${p.is_flagged ? 'bg-red-50/50' : ''}">
      <!-- Mobile-only card: same data, no column labels -- meaning comes
           from layout (name bold top-left, amount top-right, pills below). -->
      <td class="p-4 block sm:hidden">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="font-bold text-sm truncate">${esc(p.delegate_name)}</p>
            <p class="text-[11px] text-slate-500">${esc(p.category_label)}</p>
          </div>
          <p class="font-semibold text-slate-700 shrink-0">₹${inr(paidSoFar)}</p>
        </div>
        <div class="flex flex-wrap items-center gap-1.5 mt-2">
          ${p.is_flagged ? `<span class="text-[10px] bg-red-100 text-red-700 px-2 py-0.5 rounded border border-red-200 font-bold uppercase tracking-wider">⚠️ Flagged</span>` : ''}
          ${statusPill}${reviseHint}${balancePill}${overpaidPill}${rejectionNote}${linkedPill}${idPill}
        </div>
        <div class="mt-3">${reviewBtn}</div>
      </td>
      <!-- Desktop columns -->
      <td class="p-4 font-bold text-sm hidden sm:table-cell">
        ${esc(p.delegate_name)}
        <br><span class="text-[11px] font-normal text-slate-500">${esc(p.category_label)}</span>
        ${p.is_flagged ? `<br><span class="inline-block mt-1 text-[10px] bg-red-100 text-red-700 px-2 py-0.5 rounded border border-red-200 font-bold uppercase tracking-wider">⚠️ Flagged</span>` : ''}
      </td>
      <td class="p-4 text-sm hidden sm:table-cell">
        <span class="font-semibold text-slate-700">₹${inr(paidSoFar)}</span>
      </td>
      <td class="p-4 hidden sm:table-cell">
        ${statusPill}
        ${reviseHint ? `<br>${reviseHint}` : ''}
        ${balancePill ? `<br>${balancePill}` : ''}
        ${overpaidPill ? `<br>${overpaidPill}` : ''}
        ${rejectionNote ? `<br>${rejectionNote}` : ''}
        <br>${linkedPill}
        ${idPill ? `<br>${idPill}` : ''}
      </td>
      <td class="p-4 text-right hidden sm:table-cell">
        ${reviewBtn}
      </td>
    </tr>
  `;
}

// Re-runs the automated screenshot/ID checks against every currently
// flagged, still-pending registration's already-uploaded files -- useful
// after fixing a bug in the OCR matching logic itself, so past
// submissions get re-judged instead of sitting flagged on stale results.
async function rescanFlaggedPayments() {
  const btn = document.getElementById('rescan-flagged-btn');
  if (btn) { btn.disabled = true; btn.textContent = '🔄 Rescanning…'; }

  const data = await (await fetch('/api/admin/registrations/rescan-flagged', { method: 'POST' })).json();

  if (btn) { btn.disabled = false; btn.textContent = '🔄 Rescan Flagged'; }

  if (!data.success) {
    showToast(data.error || 'Rescan failed.');
    return;
  }
  showToast(
    `Rescanned ${data.rescanned} of ${data.totalFlagged} flagged. ${data.unflagged} cleared, ${data.stillFlagged} still flagged.`
      + (data.skippedNoFile ? ` (${data.skippedNoFile} skipped -- file missing.)` : ''),
    data.unflagged ? 'success' : 'info'
  );
  await renderBackendPayments();
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
    tbody.innerHTML = `<tr><td colspan="4" class="p-8 text-center text-sm text-slate-400">Nothing awaiting a decision.</td></tr>`;
  }

  const rejectedSection = document.getElementById('rejected-section');
  const rejectedBody = document.getElementById('rejected-table-body');
  setText('badge-rejected-count', rejected.length);
  if (rejectedSection) rejectedSection.classList.toggle('hidden', rejected.length === 0);
  if (rejectedBody) rejectedBody.innerHTML = rejected.map(paymentRowHtml).join('');

  // Balance-due section: PARTIAL_PAYMENT delegates (e.g. after a category
  // change) who've been emailed to pay the difference. It's their turn, so
  // they live here instead of the main worklist -- finance can still track
  // and open them.
  const balanceSection = document.getElementById('balance-section');
  const balanceBody = document.getElementById('balance-table-body');
  setText('badge-balance-count', partialAwaiting.length);
  if (balanceSection) balanceSection.classList.toggle('hidden', partialAwaiting.length === 0);
  if (balanceBody) balanceBody.innerHTML = partialAwaiting.map(paymentRowHtml).join('');

  // Verified section is a super-admin-only entry point into already-verified
  // registrations, purely so they can be opened and un-approved. Hidden for
  // everyone else (finance admins never need to reach a settled record here).
  const isSuper = !!(activeAdminUser && activeAdminUser.role === 'SUPER_ADMIN');
  const verifiedSection = document.getElementById('verified-section');
  const verifiedBody = document.getElementById('verified-table-body');
  setText('badge-verified-count', verified.length);
  if (verifiedSection) verifiedSection.classList.toggle('hidden', !isSuper || verified.length === 0);
  if (verifiedBody) verifiedBody.innerHTML = isSuper ? verified.map(paymentRowHtml).join('') : '';
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
  const key = DISTRICT_NAME_ALIASES[named] || named;
  if (key && feat.features.some((f) => String(f.properties.dtname || '').toLowerCase().trim() === key)) {
    return { key, rawName };
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
    return { key: String(f.properties.dtname || '').toLowerCase().trim(), rawName: rawName || f.properties.dtname };
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
        `<p class="text-xs font-bold text-slate-600 mb-1.5">🌍 International — ${intlReg} registered · ${intlSign} signed up only <span class="font-normal text-slate-400">(not shown on the map)</span></p>`
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
    const key = String(f.properties.dtname || '').toLowerCase().trim();
    const rec = data.byKey.get(key);
    return { f, key, name: f.properties.dtname, rec, value: rec ? rec[metricKey] : 0, host: key === 'wardha' };
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
      tip.style('opacity', 1).html(`<b>${esc(d.rec.rawName || d.name)}</b><br>${d.rec.registered} registered · ${d.rec.signedup} signed up`)
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

  setText('review-title', p.is_flagged ? 'Review Payment (Flagged)' : 'Review Payment');
  setText('review-name', p.delegate_name);
  setText('review-category', p.category_label);
  setText('review-regno', p.registration_number ? `Reg No. ${p.registration_number}` : '');
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

  // Evidence pane: both documents live here behind a switcher (see
  // setReviewImage). Reset to the screenshot, unzoomed, on every open --
  // otherwise the previous delegate's chosen tab/zoom carries over. Revoke
  // the previous delegate's blob: URLs first -- otherwise every review this
  // session leaks two of them.
  Object.values(reviewImageBlobUrls).forEach((u) => { if (u) URL.revokeObjectURL(u); });
  reviewImageBlobUrls = { screenshot: '', idcard: '', txnslip: '' };
  reviewImageUrls = {
    screenshot: p.has_screenshot ? `/api/registrations/${encodeURIComponent(p.id)}/screenshot` : '',
    idcard: p.has_id_card ? `/api/registrations/${encodeURIComponent(p.id)}/id-card` : '',
    txnslip: '', // filled in only when an admin opens a specific payment's slip
  };
  reviewTxnSlipLabel = 'Slip';
  reviewImageZoomed = false;
  setReviewImage('screenshot');
  // Fetch both documents into memory (as blob: URLs) right away, in the
  // background, so switching to the ID card later is instant instead of
  // triggering a fresh network request at click time -- the endpoints are
  // served with Cache-Control: no-store (payment evidence shouldn't sit in
  // the browser's disk cache), so the plain <img src> reload the tab used
  // to do was a real, uncached fetch every single time.
  prefetchReviewImages();

  // Automated check verdicts, shown against the field each one is about.
  // NEFT/RTGS slips carry no VPA to read, so Mode gets no mark at all there
  // -- a dash would imply a check that could have run and didn't.
  setHTML('review-amount-check', reviewCheckMark(p.ocr_amount_match, 'The amount'));
  setHTML('review-utr-check', reviewCheckMark(p.ocr_utr_match, 'The transaction ID'));
  setHTML('review-mode-check', p.payment_mode === 'NEFT_RTGS' ? '' : reviewCheckMark(p.ocr_vpa_match, 'The UPI ID'));

  const flaggedNote = document.getElementById('review-flagged-note');
  if (flaggedNote) flaggedNote.classList.toggle('hidden', !p.is_flagged);

  // Rejecting an already-rejected registration doesn't mean anything --
  // that action is only offered while a decision is still pending.
  const rejectBtn = document.getElementById('review-reject-btn');
  if (rejectBtn) rejectBtn.classList.toggle('hidden', p.bank_status === 'REJECTED');

  // Un-approve: super admins only, and only for a currently-verified
  // registration (reverting a decision that's already been made). The
  // Accept/Reject buttons are meaningless on an already-verified record, so
  // hide them in that state and offer un-approve instead.
  const isSuper = !!(activeAdminUser && activeAdminUser.role === 'SUPER_ADMIN');
  const isVerified = p.bank_status === 'BANK_VERIFIED';
  const unapproveBtn = document.getElementById('review-unapprove-btn');
  const acceptBtn = document.getElementById('review-accept-btn');
  if (unapproveBtn) unapproveBtn.classList.toggle('hidden', !(isSuper && isVerified));
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
// Three evidence slots. screenshot/idcard come from the registration and
// are prefetched on open; txnslip is populated on demand by showTxnSlip for
// one specific ledger payment, and carries its own label (the payment's
// date) since a partial + top-up produce two of them.
let reviewImageUrls = { screenshot: '', idcard: '', txnslip: '' };
let reviewTxnSlipLabel = 'Slip';
// Blob: URLs for documents already fetched into memory this modal-open --
// see prefetchReviewImages(). Falls back to the plain API url (a real
// network fetch, same as before) until its prefetch resolves.
let reviewImageBlobUrls = { screenshot: '', idcard: '', txnslip: '' };
let reviewImageZoomed = false;
let reviewImageWhich = 'screenshot';

// Both documents are served with Cache-Control: no-store (payment evidence
// shouldn't sit in the browser's disk cache), so a plain <img src> reload
// hits the network every time a reviewer switches tabs -- the delay this
// works around. Fetching each into a blob: URL up front means the switch
// itself is just swapping which already-downloaded image is shown.
function prefetchReviewImages() {
  // txnslip deliberately excluded -- it has no URL until an admin asks for
  // a particular payment's slip, and there may be several to choose from.
  ['screenshot', 'idcard'].forEach((which) => {
    const url = reviewImageUrls[which];
    if (!url) return;
    fetch(url)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('fetch failed'))))
      .then((blob) => {
        // The modal may have moved on to a different registration (or
        // closed) by the time this resolves -- only apply it if the URL it
        // was fetched for is still the one currently assigned to this slot.
        if (reviewImageUrls[which] !== url) return;
        reviewImageBlobUrls[which] = URL.createObjectURL(blob);
        if (reviewImageWhich === which) setReviewImage(which); // clears the spinner if they're already looking at it
      })
      .catch(() => { /* leave it to load the normal way via <img src> on click */ });
  });
}

function setReviewImage(which) {
  reviewImageWhich = which;
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
  const LABELS = { screenshot: '📷 Screenshot', idcard: '🪪 ID Card', txnslip: `📄 ${reviewTxnSlipLabel}` };
  const present = ['screenshot', 'idcard', 'txnslip'].filter((k) => reviewImageUrls[k]);
  const multi = present.length > 1;
  const switcher = document.getElementById('review-img-switcher');
  const soloLabel = document.getElementById('review-img-solo-label');
  if (switcher) {
    switcher.classList.toggle('hidden', !multi);
    switcher.classList.toggle('flex', multi);
  }
  if (soloLabel) {
    const soloText = present.length === 1 ? LABELS[present[0]] : '';
    soloLabel.textContent = soloText;
    soloLabel.classList.toggle('hidden', multi || !soloText);
  }
  // Nudges a reviewer who's only looked at the screenshot to also check the
  // ID card -- the actual decision-relevant document for a student category
  // -- rather than letting it go unnoticed as a small inactive tab. Clears
  // itself the moment they switch away. Only about the ID card, so it stays
  // quiet when the extra document is a payment slip they just opened.
  const hint = document.getElementById('review-img-switcher-hint');
  if (hint) hint.classList.toggle('hidden', !(reviewImageUrls.screenshot && reviewImageUrls.idcard) || which !== 'screenshot');

  // Active-tab styling, applied by hand rather than via a framework class
  // toggle so the inactive state stays legible on the dark pane.
  ['screenshot', 'idcard', 'txnslip'].forEach((k) => {
    const tab = document.getElementById(`review-img-tab-${k}`);
    if (!tab) return;
    const active = k === which;
    const showThisTab = multi && !!reviewImageUrls[k];
    if (k === 'txnslip') tab.textContent = LABELS.txnslip;
    tab.className = `${showThisTab ? 'flex' : 'hidden'} items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-bold transition ${
      active ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-300 hover:text-white hover:bg-slate-700'}`;
  });
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
  if (btn) btn.textContent = reviewImageZoomed ? '🔍 Fit' : '🔍 Zoom';
}

// Loads ONE ledger payment's own slip into the evidence pane. Each payment
// keeps its own (payment_transactions.screenshot), so after a partial
// payment plus a top-up both remain viewable -- unlike the registration's
// single screenshot column, which the later submission overwrote.
function showTxnSlip(txnId, label) {
  const url = `/api/payment-transactions/${encodeURIComponent(txnId)}/screenshot`;
  // A different payment than the one already loaded: drop the old blob so
  // the pane can't show the previous slip under the new one's label.
  if (reviewImageUrls.txnslip !== url) {
    if (reviewImageBlobUrls.txnslip) URL.revokeObjectURL(reviewImageBlobUrls.txnslip);
    reviewImageBlobUrls.txnslip = '';
  }
  reviewImageUrls.txnslip = url;
  reviewTxnSlipLabel = label ? `Slip · ${label}` : 'Slip';
  setReviewImage('txnslip');
  // Not part of the on-open prefetch (there may be several to choose from),
  // so fetch this one now -- the spinner covers the wait.
  if (!reviewImageBlobUrls.txnslip) {
    fetch(url)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('fetch failed'))))
      .then((blob) => {
        if (reviewImageUrls.txnslip !== url) return; // moved on already
        reviewImageBlobUrls.txnslip = URL.createObjectURL(blob);
        if (reviewImageWhich === 'txnslip') setReviewImage('txnslip');
      })
      .catch(() => { /* the <img> falls back to loading the URL directly */ });
  }
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

  const verdict = document.getElementById('review-strip-verdict');
  const TONE = {
    BANK_VERIFIED: ['Verified', 'bg-emerald-100 text-emerald-800', 'bg-emerald-50 border-emerald-200'],
    REJECTED: ['Rejected', 'bg-rose-100 text-rose-800', 'bg-rose-50 border-rose-200'],
    PARTIAL_PAYMENT: ['Partial', 'bg-orange-100 text-orange-800', 'bg-orange-50 border-orange-200'],
    PENDING: ['Pending', 'bg-amber-100 text-amber-800', 'bg-amber-50 border-amber-200'],
  };
  const [label, pillTone, stripTone] = TONE[p.bank_status] || TONE.PENDING;
  if (verdict) verdict.className = `text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${pillTone}`;
  if (verdict) verdict.textContent = label;
  strip.className = `rounded-lg border p-3 ${stripTone}`;

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
    ledger.innerHTML = txns.map(reviewTxnRowHtml).join('');
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
           <button type="button" onclick="recordRefund()" ${reviewRefundCandidates.length ? '' : 'disabled'} class="shrink-0 px-2 py-1 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold rounded text-[10px]">Record Refund</button>
         </div>
       </div>`;
    reviewRefundOverpaid = overpaid;
    if (reviewRefundCandidates.length) onReviewRefundTxnChange();
  } else if (excessLine) {
    excessLine.innerHTML = `<span class="text-emerald-700 font-semibold">✓ No outstanding excess</span>`;
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

// One transaction row in the reconciliation ledger: amount + status on top,
// bank-link state below. Linking a payment to its bank credit acknowledges
// (verifies) it, so a linked row shows VERIFIED with an Unlink control (until
// the whole registration is confirmed); an unlinked row offers a Link button
// with a collapsible candidate picker.
function reviewTxnRowHtml(t) {
  const TONE = { VERIFIED: 'text-emerald-700', PENDING: 'text-amber-700', REJECTED: 'text-rose-600' };
  const amt = t.txn_status === 'VERIFIED' && t.verified_amount != null ? t.verified_amount : t.amount;
  const linked = t.bank_txn_id != null;
  const isRejected = t.txn_status === 'REJECTED';
  // Unlink is offered on a linked payment until the registration itself is
  // confirmed (BANK_VERIFIED) -- undoing a link un-acknowledges the payment.
  // Cash is a different claim from a bank payment. It was acknowledged the
  // moment it was taken at the desk, so "not acknowledged" would be wrong and
  // "Link & acknowledge" would offer to do something already done -- what's
  // outstanding is only whether it has been BANKED, which is reconciled in
  // bulk from the Bank Statement tab, not one delegate at a time. See the
  // cash-deposit endpoints in server.js.
  const isCash = t.payment_mode === 'CASH';
  const linkLine = linked
    ? `<span class="text-emerald-700 font-semibold">🔗 ${isCash ? 'Banked ' : ''}${esc(t.bank_txn_date || '')} · ₹${inr(esc(t.bank_txn_credit != null ? t.bank_txn_credit : ''))}</span>`
        + (reviewRegVerified || isCash ? '' : ` <button type="button" class="text-rose-600 hover:underline font-semibold ml-1" onclick="unlinkTxn(${esc(t.id)})">Unlink</button>`)
    : isRejected
      ? `<span class="text-slate-400">Rejected — not linked</span>`
      : isCash
        ? `<span class="text-slate-500">💵 Cash taken at the desk — <span class="text-amber-700 font-semibold">not yet banked</span></span>`
        : `<span class="text-amber-700 font-semibold">⚠ Not acknowledged</span> <button type="button" class="text-indigo-600 hover:underline font-semibold ml-1" onclick="toggleTxnCandidates(${esc(t.id)})">Link &amp; acknowledge</button>`;
  // Each payment keeps its OWN slip (payment_transactions.screenshot), unlike
  // registrations.screenshot which the next submission overwrites -- so this
  // is how the original partial payment's slip stays reachable after a
  // top-up. Shown in the evidence pane on the left, same as the others.
  const slipBtn = t.has_screenshot
    ? `<button type="button" class="text-indigo-600 hover:underline font-semibold" onclick="showTxnSlip(${esc(t.id)}, '${esc(fmtAuditTime(t.submitted_at) || '')}')">📄 Payment Slip</button>`
    : `<span class="text-slate-400">No slip on file</span>`;
  return `<div class="border border-slate-200 rounded-lg p-2 bg-white">
    <div class="flex items-center justify-between">
      <span class="font-mono text-slate-500">${esc(t.utr_number || '—')}</span>
      <span class="flex items-center gap-2">
        <span class="font-semibold">₹${inr(Number(amt))}</span>
        <span class="font-bold ${TONE[t.txn_status] || 'text-slate-500'}">${esc(t.txn_status)}</span>
      </span>
    </div>
    <div class="mt-1 flex items-center justify-between gap-2 text-[10px]">
      <span class="text-slate-400">${esc(fmtAuditTime(t.submitted_at) || '')}</span>
      ${slipBtn}
    </div>
    <div class="mt-1 text-[10px]">${linkLine}</div>
    <div id="txn-candidates-${esc(t.id)}" class="hidden mt-2 divide-y divide-slate-100 border border-slate-200 rounded-lg max-h-40 overflow-y-auto"></div>
  </div>`;
}

async function toggleTxnCandidates(txnId) {
  const box = document.getElementById(`txn-candidates-${txnId}`);
  if (!box) return;
  if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.innerHTML = '<p class="text-[10px] text-slate-400 p-2">Loading candidates…</p>';
  const res = await fetch(`/api/payment-transactions/${encodeURIComponent(txnId)}/candidates`);
  if (!res.ok) { box.innerHTML = '<p class="text-[10px] text-rose-600 p-2">Could not load candidates.</p>'; return; }
  const rows = (await res.json()).transactions || [];
  // A credit with less than its full credit still unallocated (partially
  // claimed by someone else already) shows "₹X of ₹Y available" so the
  // admin can see at a glance whether this payment's own amount will fit --
  // the server is still the actual gate at link time.
  box.innerHTML = rows.length ? rows.map((c) => `
    <div class="flex items-center justify-between gap-2 p-2 text-[10px]">
      <div class="min-w-0"><p class="font-semibold text-slate-700">${esc(c.post_date)} · ₹${inr(esc(c.remaining))}${c.remaining !== c.credit ? ` of ₹${inr(esc(c.credit))}` : ''} available</p><p class="text-slate-500 truncate">${esc(c.description)}</p></div>
      <button type="button" class="shrink-0 px-2 py-1 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded" onclick="linkTxnToBank(${esc(txnId)}, ${esc(c.id)})">Link</button>
    </div>`).join('') : '<p class="text-[10px] text-slate-400 p-2">No unused credits in the statement yet.</p>';
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
        <button type="button" class="px-2 py-1 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded" onclick="adminAddPayment(${esc(c.id)}, ${esc(c.remaining)})">Add</button>
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
function updateReviewAcceptGate() {
  const acceptBtn = document.getElementById('review-accept-btn');
  const blocked = !(reviewGate.linked && reviewGate.idOk);
  if (acceptBtn) acceptBtn.disabled = blocked;

  // Spell out each requirement rather than leaving a disabled button with no
  // explanation. Refreshed from here (not only on open) so ticking the ID
  // checkbox updates the list immediately. Only rendered while the button is
  // actually on screen -- on an already-verified or rejected registration
  // there's no decision left to gate.
  const list = document.getElementById('review-gate-list');
  if (!list) return;
  const acceptVisible = acceptBtn && !acceptBtn.classList.contains('hidden');
  if (!acceptVisible) { list.innerHTML = ''; return; }
  const row = (ok, okText, blockedText) =>
    `<div class="${ok ? 'text-emerald-700' : 'text-amber-700 font-semibold'}">${ok ? '✓' : '○'} ${ok ? okText : blockedText}</div>`;
  const rows = [row(reviewGate.linked, 'All payments linked to bank credits', 'Link every payment to its bank credit below')];
  // idOk is true for non-student categories, where there's nothing to confirm
  // -- showing a permanently-ticked row there would be noise.
  if (!reviewGate.idOk || isStudentCategory((cachedPaymentRegs.find((r) => String(r.id) === String(reviewTargetId)) || {}).category_key)) {
    rows.push(row(reviewGate.idOk, 'Student ID confirmed', 'Confirm the student ID card below'));
  }
  list.innerHTML = blocked
    ? `<p class="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Before you can verify</p>${rows.join('')}`
    : rows.join('');
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

async function renderReviewCategoryLock(p) {
  const sel = document.getElementById('review-category-select');
  const lockBtn = document.getElementById('review-category-lock-btn');
  const unlockBtn = document.getElementById('review-category-unlock-btn');
  const badge = document.getElementById('review-category-locked-badge');
  if (!sel) return;
  const cats = await ensureReviewCategories();
  sel.innerHTML = cats.map((c) => `<option value="${esc(c.key)}" ${c.key === p.category_key ? 'selected' : ''}>${esc(c.label)}</option>`).join('');

  const locked = !!p.category_locked;
  const isSuper = !!(activeAdminUser && activeAdminUser.role === 'SUPER_ADMIN');
  if (badge) badge.classList.toggle('hidden', !locked);
  // When locked, the picker is disabled; only a super admin can unlock.
  sel.disabled = locked;
  if (lockBtn) lockBtn.classList.toggle('hidden', locked);
  if (unlockBtn) unlockBtn.classList.toggle('hidden', !(locked && isSuper));

  // The Corrections disclosure is closed by default (these controls are used
  // on a small minority of reviews), but an already-locked category is state
  // the admin needs to notice -- so surface it on the summary line and open
  // the section when it applies.
  const details = document.getElementById('review-corrections');
  const hint = document.getElementById('review-corrections-hint');
  if (hint) hint.textContent = locked ? ' · 🔒 category locked' : '';
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

  if (checkbox) checkbox.checked = !!p.id_verified;
  if (note) {
    note.classList.toggle('hidden', !p.id_verified);
    note.textContent = p.id_verified_by ? `✓ Verified by ${p.id_verified_by} · ${fmtAuditTime(p.id_verified_at)}` : '';
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
  BANK_VERIFIED: 'bg-emerald-100 text-emerald-800',
  PENDING: 'bg-amber-100 text-amber-800',
  REJECTED: 'bg-rose-100 text-rose-800',
  PARTIAL_PAYMENT: 'bg-orange-100 text-orange-800',
};

// Cached so filtering/search re-renders instantly without a round-trip, and
// so the program-change modal has the full group/option list to draw from.
let cachedUsers = [];
let cachedAdminProgramGroups = [];

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
const ROLE_ICONS = {
  SUPER_ADMIN: '👑',
  FINANCE_ADMIN: '💰',
  ACADEMIC_REVIEWER: '🎓',
  FINANCE_ACADEMIC: '💰🎓',
  OPERATIONS: '📊',
  DELEGATE: '🎫',
};

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
    if (roleFilter && u.role !== roleFilter) return false;
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
      <td class="p-4 font-semibold text-slate-800">${roleMarkBW(u.role)}${u.salutation ? esc(u.salutation) + ' ' : ''}${esc(u.full_name)}</td>
      <td class="p-4 text-slate-600">${esc(u.designation || '—')}</td>
      <td class="p-4 text-slate-600">${esc(u.institution || '—')}</td>
      <td class="p-4 whitespace-nowrap">${accountMarks(u)}</td>
      <td class="p-4">${u.registration_status
        ? `<span class="${REG_STATUS_STYLES[u.registration_status] || 'bg-slate-100 text-slate-600'} text-xs font-bold px-2 py-1 rounded-full">${esc(BANK_STATUS_LABELS[u.registration_status] || u.registration_status)}</span>`
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

const ROLE_OPTIONS = [
  ['DELEGATE', 'Delegate'],
  ['FINANCE_ADMIN', 'Finance Admin'],
  ['ACADEMIC_REVIEWER', 'Academic Reviewer'],
  ['FINANCE_ACADEMIC', 'Finance & Academic Reviewer'],
  ['OPERATIONS', 'Operations'],
  ['SUPER_ADMIN', 'Super Admin'],
];

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

  if (userDetailEditing) { body.innerHTML = userDetailEditForm(u); return; }

  // Demography
  const demography = detailRow('Age', u.age) + detailRow('Gender', u.gender)
    + detailRow('District', u.district) + detailRow('State', u.state)
    + detailRow('Pincode', u.pincode);

  // Contact
  const contact = detailRow('Email', u.email) + detailRow('Phone', delegateDisplayPhone(u) || '—');

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
      ${sel && sel.is_faculty ? '<span class="ml-1.5 text-[10px] bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded-full font-bold uppercase tracking-wide align-middle">Faculty</span>' : ''}
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
  const roleOptions = viewerIsSuper ? ROLE_OPTIONS : ROLE_OPTIONS.filter(([v]) => v !== 'SUPER_ADMIN');
  const roleLocked = targetIsSuper && !viewerIsSuper;
  const roleSelect = `<div class="flex items-center gap-2">
    <select id="user-detail-role-select" ${roleLocked ? 'disabled' : ''} class="flex-1 p-2 border rounded-lg text-sm bg-white outline-none disabled:bg-slate-100 disabled:text-slate-400">
      ${roleLocked ? `<option value="SUPER_ADMIN" selected>${esc(roleLabel('SUPER_ADMIN'))}</option>` : roleOptions.map(([v, l]) => `<option value="${v}" ${u.role === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}
    </select>
    <button type="button" onclick="saveUserDetailRole()" ${roleLocked ? 'disabled' : ''} class="px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg disabled:bg-slate-300 disabled:cursor-not-allowed">Save</button>
  </div>${roleLocked ? `<p class="text-[11px] text-slate-400 mt-1.5">Only a Super Admin can change another Super Admin's role.</p>` : ''}`;

  const editBtn = isSuperAdminViewer()
    ? `<button type="button" onclick="toggleUserDetailEdit()" class="text-[11px] text-indigo-600 hover:text-indigo-800 font-semibold underline">Edit</button>`
    : '';

  body.innerHTML =
    detailCard('Demography', demography, editBtn)
    + detailCard('Contact', contact)
    + detailCard('Registration', regHtml)
    + (ledger ? detailCard('Payments', ledger) : '')
    + detailCard('Programs', programs)
    + detailCard('Role', roleSelect);
}

function userDetailEditForm(u) {
  const field = (id, label, val, type = 'text') =>
    `<div><label class="block text-[11px] font-semibold text-slate-600 mb-1">${esc(label)}</label>
      <input id="ude-${id}" type="${type}" value="${val == null ? '' : esc(String(val))}" class="w-full p-2 border rounded-lg text-sm outline-none"></div>`;
  return `<div class="space-y-3">
    <div class="grid grid-cols-2 gap-3">
      ${field('salutation', 'Salutation', u.salutation)}
      ${field('full_name', 'Full name', u.full_name)}
    </div>
    <div class="grid grid-cols-2 gap-3">
      ${field('designation', 'Designation', u.designation)}
      ${field('institution', 'Institute', u.institution)}
    </div>
    ${field('email', 'Email', u.email, 'email')}
    <div class="grid grid-cols-2 gap-3">
      ${field('age', 'Age', u.age, 'number')}
      ${field('gender', 'Gender', u.gender)}
    </div>
    <div class="grid grid-cols-2 gap-3">
      ${field('district', 'District', u.district)}
      ${field('state', 'State', u.state)}
    </div>
    ${field('pincode', 'Pincode', u.pincode)}
    <div class="flex justify-end gap-2 pt-2">
      <button type="button" onclick="toggleUserDetailEdit()" class="px-4 py-2 border rounded-xl text-xs font-semibold text-slate-600">Cancel</button>
      <button type="button" onclick="saveUserDetailEdit()" class="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-semibold shadow-md">Save changes</button>
    </div>
  </div>`;
}

function toggleUserDetailEdit() {
  if (!isSuperAdminViewer()) return showToast('Only a super admin can edit user details.');
  userDetailEditing = !userDetailEditing;
  renderUserDetail();
}

async function saveUserDetailEdit() {
  if (!userDetailPhone) return;
  const ids = ['salutation', 'full_name', 'designation', 'institution', 'email',
    'age', 'gender', 'district', 'state', 'pincode'];
  const payload = {};
  ids.forEach((id) => {
    const el = document.getElementById(`ude-${id}`);
    if (el) payload[id] = el.value.trim();
  });
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
      <div class="flex-1 min-w-[180px]">
        <p class="font-semibold text-sm text-slate-800">${esc(o.name)}${Number(o.fee) > 0 ? ` <span class="text-[11px] font-normal text-indigo-600">+₹${inr(o.fee)}</span>` : ''}</p>
        <p class="text-[11px] text-slate-500">Enrolled ${Number(o.enrolled)} / ${Number(o.capacity)} · ${remaining} left${facultyCount ? ` · ${facultyCount} faculty` : ''}${o.active ? '' : ' · inactive'}</p>
      </div>
      <input type="number" min="0" value="${esc(o.capacity)}" title="Capacity" class="prog-capacity w-20 p-1.5 border rounded text-sm" data-id="${esc(o.id)}">
      <input type="number" min="0" step="0.01" value="${esc(o.fee)}" title="Fee (₹)" class="prog-fee w-24 p-1.5 border rounded text-sm" data-id="${esc(o.id)}">
      <button class="prog-save px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg" data-id="${esc(o.id)}">Save</button>
      <button class="prog-roster px-3 py-1.5 bg-slate-700 hover:bg-slate-800 text-white text-xs font-semibold rounded-lg" data-id="${esc(o.id)}" data-name="${esc(o.name)}">Roster</button>
      <button class="prog-toggle px-3 py-1.5 ${o.active ? 'bg-amber-500 hover:bg-amber-600' : 'bg-emerald-600 hover:bg-emerald-700'} text-white text-xs font-semibold rounded-lg" data-id="${esc(o.id)}" data-active="${o.active ? 1 : 0}">${o.active ? 'Deactivate' : 'Activate'}</button>
      <button class="prog-delete px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold rounded-lg" data-id="${esc(o.id)}">Delete</button>
    </div>`;
  };

  box.innerHTML = groups.map((g) => `
    <div class="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm mb-6 ${g.active ? '' : 'opacity-60'}">
      <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div>
          <h4 class="font-bold text-slate-800">${esc(g.name)}${g.active ? '' : ' <span class="text-[10px] font-normal text-slate-400">(inactive)</span>'}</h4>
          <p class="text-[11px] text-slate-500">${g.required ? 'Required' : 'Optional'} · choose up to ${Number(g.max_select)}</p>
        </div>
        <div class="flex gap-2">
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
        <button type="submit" class="px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg">+ Add</button>
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

async function saveProgramOption(id, capacity, fee) {
  const data = await (await fetch(`/api/admin/program-options/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ capacity, fee }),
  })).json();
  if (!data.success) showToast(data.error || 'Update failed.');
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
          <p class="font-semibold text-slate-800 truncate">${esc(r.delegate_name)}${Number(r.is_faculty) ? ' <span class="text-[10px] bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded-full font-bold uppercase tracking-wide align-middle">Faculty</span>' : ''}</p>
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
  const todayStr = new Date().toISOString().slice(0, 10);
  const conf = confRes.ok ? await confRes.json() : {};
  [early, regular, late].forEach((el) => {
    if (!el) return;
    el.min = todayStr;
    if (conf.startDate) el.max = conf.startDate;
  });

  tbody.innerHTML = (data.categories || []).map((c) => `
    <tr class="${c.active ? '' : 'opacity-50'}" data-id="${esc(c.id)}">
      <td class="p-4">
        <p class="font-semibold text-slate-800">${esc(c.label)}</p>
        ${c.subtitle ? `<p class="text-xs text-slate-500">${esc(c.subtitle)}</p>` : ''}
        <p class="text-[10px] font-mono text-slate-400 mt-1">${esc(c.category_key)}${c.active ? '' : ' · inactive'}</p>
      </td>
      <td class="p-4"><input type="number" min="0" value="${esc(c.early_fee)}" class="fee-early w-20 p-1.5 border rounded text-sm" data-id="${esc(c.id)}"></td>
      <td class="p-4"><input type="number" min="0" value="${esc(c.regular_fee)}" class="fee-regular w-20 p-1.5 border rounded text-sm" data-id="${esc(c.id)}"></td>
      <td class="p-4"><input type="number" min="0" value="${esc(c.late_fee)}" class="fee-late w-20 p-1.5 border rounded text-sm" data-id="${esc(c.id)}"></td>
      <td class="p-4"><input type="number" min="0" value="${esc(c.spot_fee)}" class="fee-spot w-20 p-1.5 border rounded text-sm" data-id="${esc(c.id)}"></td>
      <td class="p-4">
        <!-- Just whether a card is required. It used to also pick a
             discipline/level pair, which existed only to tell the ID-card
             OCR what keywords to look for; that check is gone, so any
             category can require an ID and an approver judges the card. -->
        <label class="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" class="fee-studentid" data-id="${esc(c.id)}" ${c.requires_student_id ? 'checked' : ''}>
          Required
        </label>
      </td>
      <td class="p-4 text-right whitespace-nowrap">
        <button class="fee-save px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg" data-id="${esc(c.id)}">Save</button>
        <button class="fee-toggle px-3 py-1.5 ${c.active ? 'bg-amber-500 hover:bg-amber-600' : 'bg-emerald-600 hover:bg-emerald-700'} text-white text-xs font-semibold rounded-lg" data-id="${esc(c.id)}" data-active="${c.active ? 1 : 0}">${c.active ? 'Deactivate' : 'Activate'}</button>
        <button class="fee-delete px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold rounded-lg" data-id="${esc(c.id)}">Delete</button>
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
  PROGRAM_OPTION_CREATE: 'Created', PROGRAM_OPTION_UPDATE: 'Updated', PROGRAM_OPTION_DELETE: 'Deleted',
  FEE_CONFIG_UPDATE: 'Dates Updated', FEE_CATEGORY_CREATE: 'Created', FEE_CATEGORY_UPDATE: 'Updated', FEE_CATEGORY_DELETE: 'Deleted',
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
    discount_code: 'Discount Code', group_rule: 'Group Discount', general_settings: 'General', settings: 'General',
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

async function saveFeeCategory(id) {
  const q = (cls) => document.querySelector(`.${cls}[data-id="${id}"]`);
  const data = await (await fetch(`/api/admin/fees/categories/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      earlyFee: Number(q('fee-early').value),
      regularFee: Number(q('fee-regular').value),
      lateFee: Number(q('fee-late').value),
      spotFee: Number(q('fee-spot').value),
      requiresStudentId: q('fee-studentid').checked,
    })
  })).json();
  if (!data.success) showToast(data.error || 'Update failed.');
  reviewCategoryList = null; // requiresStudentId may have changed -- force ensureReviewCategories() to refetch
  renderBackendFees();
}

async function toggleFeeCategory(id, active) {
  const q = (cls) => document.querySelector(`.${cls}[data-id="${id}"]`);
  await fetch(`/api/admin/fees/categories/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      active,
      earlyFee: Number(q('fee-early').value),
      regularFee: Number(q('fee-regular').value),
      lateFee: Number(q('fee-late').value),
      spotFee: Number(q('fee-spot').value),
    })
  });
  renderBackendFees();
}

async function deleteFeeCategory(id) {
  if (!(await showConfirm('Delete this category? This cannot be undone.'))) return;
  const data = await (await fetch(`/api/admin/fees/categories/${encodeURIComponent(id)}`, { method: 'DELETE' })).json();
  if (!data.success) showToast(data.error || 'Delete failed.');
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

  const discountLine = c.discount_type === 'PERCENT' ? `${Number(c.discount_value)}% off` : `₹${inr(Number(c.discount_value))} off`;
  let scopeLine = '';
  if (c.scope_type === 'INDIVIDUAL') {
    const u = (cachedUsers || []).find((x) => x.phone_number === c.scope_value);
    scopeLine = `\nThis code is reserved for ${u ? u.full_name : 'you'} only.`;
  } else if (c.scope_type === 'CATEGORY') {
    scopeLine = '\nApplies to a specific delegate category — check on the registration page.';
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
    if (btn) { btn.disabled = false; btn.textContent = '✉️ Send'; }
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

function updateDiscScopeHints() {
  const scope = document.getElementById('new-disc-scope').value;
  const catWrap = document.getElementById('new-disc-scope-cat-wrap');
  const phoneWrap = document.getElementById('new-disc-scope-phone-wrap');
  const maxWrap = document.getElementById('new-disc-max-wrap');
  if (catWrap) catWrap.classList.toggle('hidden', scope !== 'CATEGORY');
  if (phoneWrap) phoneWrap.classList.toggle('hidden', scope !== 'INDIVIDUAL');
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
  box.innerHTML = matches.length
    ? matches.map((u) => `<button type="button" class="w-full text-left px-3 py-2 hover:bg-indigo-50" onclick="pickDiscDelegate('${esc(u.phone_number)}', '${esc((u.full_name || '').replace(/'/g, "\\'"))}', '${esc(discDelegateContact(u))}')">
        <p class="font-semibold text-slate-800 text-sm">${esc(u.full_name || '—')}</p>
        <p class="text-[11px] text-slate-500">${esc(discDelegateContact(u))}${u.registration_number ? ' · ' + esc(u.registration_number) : ''}</p>
      </button>`).join('')
    : '<p class="text-xs text-slate-400 p-3">No matching delegate.</p>';
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
  tbody.innerHTML = codes.length ? codes.map((c) => {
    const disc = c.discount_type === 'PERCENT' ? `${Number(c.discount_value)}%` : `₹${inr(Number(c.discount_value))}`;
    const indivName = c.scope_type === 'INDIVIDUAL'
      ? ((cachedUsers || []).find((u) => u.phone_number === c.scope_value) || {}).full_name : null;
    const scope = c.scope_type === 'GLOBAL' ? 'All delegates'
      : c.scope_type === 'CATEGORY' ? `Category: ${esc(catLabel(c.scope_value))}`
      : `Delegate: ${esc(indivName ? indivName + ' (' + c.scope_value + ')' : c.scope_value || '')}`;
    const usedTxt = `${c.applied_count}${c.max_uses ? ' / ' + c.max_uses : ''}${c.verified_count ? ` (${c.verified_count} verified)` : ''}`;
    return `<tr class="${c.active ? '' : 'opacity-50'}">
      <td class="p-4"><span class="font-mono font-bold text-slate-800">${esc(c.code)}</span>${c.active ? '' : ' <span class="text-[10px] text-slate-400">· inactive</span>'}</td>
      <td class="p-4 font-semibold">${disc}</td>
      <td class="p-4 text-slate-600">${scope}</td>
      <td class="p-4">${usedTxt}</td>
      <td class="p-4 text-slate-600">${c.expires_at ? esc(c.expires_at) : '—'}</td>
      <td class="p-4 text-right whitespace-nowrap">
        <button onclick="openShareDiscountModal(${esc(c.id)})" class="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg">📤 Share</button>
      </td>
      <td class="p-4 text-right whitespace-nowrap">
        <button onclick="toggleDiscountCode(${esc(c.id)}, ${c.active ? 0 : 1})" class="px-3 py-1.5 ${c.active ? 'bg-amber-500 hover:bg-amber-600' : 'bg-emerald-600 hover:bg-emerald-700'} text-white text-xs font-semibold rounded-lg">${c.active ? 'Deactivate' : 'Activate'}</button>
        <button onclick="deleteDiscountCode(${esc(c.id)})" class="px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold rounded-lg">Delete</button>
      </td>
    </tr>`;
  }).join('') : `<tr><td colspan="7" class="p-6 text-center text-slate-400">No discount codes yet.</td></tr>`;
}

async function handleAddDiscountCode(e) {
  e.preventDefault();
  const scopeType = document.getElementById('new-disc-scope').value;
  if (scopeType === 'INDIVIDUAL' && !document.getElementById('new-disc-scope-phone').value) {
    return showToast('Search and select the delegate this code is for.');
  }
  const body = {
    code: document.getElementById('new-disc-code').value,
    discountType: document.getElementById('new-disc-type').value,
    discountValue: document.getElementById('new-disc-value').value,
    scopeType,
    scopeValue: scopeType === 'CATEGORY' ? document.getElementById('new-disc-scope-cat').value
      : scopeType === 'INDIVIDUAL' ? document.getElementById('new-disc-scope-phone').value : '',
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
  showToast(`Discount code ${body.code} added.`, 'success');
  generateDiscCode(); // fresh code ready for the next one
  document.getElementById('new-disc-value').value = '';
  document.getElementById('new-disc-max').value = '';
  document.getElementById('new-disc-expires').value = '';
  clearDiscDelegate();
  renderDiscountCodes();
}

async function toggleDiscountCode(id, active) {
  const data = await (await fetch(`/api/admin/discount-codes/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active }),
  })).json();
  if (!data.success) showToast(data.error || 'Update failed.');
  renderDiscountCodes();
}

async function deleteDiscountCode(id) {
  if (!(await showConfirm('Delete this discount code?'))) return;
  const data = await (await fetch(`/api/admin/discount-codes/${encodeURIComponent(id)}`, { method: 'DELETE' })).json();
  if (!data.success) showToast(data.error || 'Delete failed.');
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

async function renderGeneralSettings() {
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
  // A conference being set up is always in the future, and it can't end
  // before it starts -- nudged here, enforced server-side regardless (see
  // PUT /api/admin/general-settings).
  const todayStr = new Date().toISOString().slice(0, 10);
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
      ? '<span class="text-[11px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">✓ Fully approved</span>'
      : g.qualifies
        ? '<span class="text-[11px] font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-full px-2 py-0.5">Discount active</span>'
        : `<span class="text-[11px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">Below min (${g.size}/${g.minSize || '—'})</span>`;
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

// --- REGISTRATION REMINDERS (admin) ---

// Built fresh (not a frozen const) so it always reflects the current
// conference name/dates/location, same as the reminder-subject default.
function reminderDefaultBody() {
  const c = conferenceInfo;
  const start = formatFullDate(c.startDate);
  const end = formatFullDate(c.endDate);
  const dateRange = (start && end && c.startDate !== c.endDate) ? `${start} – ${end}` : (start || end);
  const when = [dateRange, c.location].filter(Boolean).join(', ');
  return `<p>Dear {{name}},</p>
<p>Thanks for signing up for the ${esc(c.name)}${when ? ` (${esc(when)})` : ''}. We noticed your registration isn't complete yet &mdash; your account is set up, but we haven't received your payment details.</p>
<p>Completing your registration only takes a couple of minutes.</p>
<p style="text-align:center;margin:1.5rem 0">
  <a href="${window.location.origin}" style="background:#4f46e5;color:#fff;padding:.75rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">Complete My Registration</a>
</p>
<p>If you've already registered, please disregard this email.</p>`;
}

let cachedReminderRecipients = [];
let reminderIsSuper = false;

// A reminder sent within the last 24h to this person blocks another one
// (server-enforced too -- this just keeps the UI honest about it upfront).
const REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;
function reminderOnCooldown(u) {
  return u.last_reminder_sent_at && (Date.now() - Number(u.last_reminder_sent_at)) < REMINDER_COOLDOWN_MS;
}

async function renderBackendReminders(isSuper) {
  reminderIsSuper = isSuper;
  const res = await fetch('/api/admin/reminders/pending-signups');
  if (!res.ok) return;
  const data = await res.json();
  cachedReminderRecipients = data.users || [];

  setText('badge-pending-signups', String(cachedReminderRecipients.length));
  setText('reminders-count', String(cachedReminderRecipients.length));

  const bodyBox = document.getElementById('reminder-body');
  if (bodyBox && !bodyBox.value.trim()) bodyBox.value = reminderDefaultBody();

  const list = document.getElementById('reminders-list');
  if (list) {
    list.innerHTML = cachedReminderRecipients.length
      ? cachedReminderRecipients.map((u) => {
        const onCooldown = reminderOnCooldown(u);
        const disabled = !u.email || onCooldown;
        return `
        <div class="px-3 py-2 flex items-center gap-2">
          <input type="checkbox" class="reminder-recipient-checkbox shrink-0" value="${esc(u.phone_number)}" ${disabled ? 'disabled' : ''} onchange="updateReminderSelectedCount()">
          <div class="min-w-0 flex-1">
            <p class="font-semibold text-slate-700 truncate">${esc([u.salutation, u.full_name].filter(Boolean).join(' '))}</p>
            <p class="text-xs text-slate-400 truncate">${esc(u.email || 'No email on file')}${u.last_reminder_sent_at ? ` · last sent ${esc(fmtAuditTime(u.last_reminder_sent_at))}` : ''}</p>
          </div>
          ${!u.email ? '<span class="text-[10px] bg-rose-100 text-rose-700 px-2 py-0.5 rounded-full font-bold shrink-0">No email</span>' : ''}
          ${onCooldown ? '<span class="text-[10px] bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-bold shrink-0">Sent within 24h</span>' : ''}
        </div>`;
      }).join('')
      : `<div class="px-3 py-6 text-center text-slate-400 text-sm">Everyone who's signed up has also registered.</div>`;
  }

  const testBtn = document.getElementById('reminder-test-btn');
  if (testBtn) {
    testBtn.disabled = !isSuper;
    testBtn.title = isSuper ? '' : 'Only a Super Admin can send reminder emails.';
  }
  updateReminderSelectedCount();
}

// Keeps the "Select all" checkbox, the selected-count label, and the Send
// button's enabled state / count in sync with whichever recipient
// checkboxes are actually checked right now.
function updateReminderSelectedCount() {
  const boxes = Array.from(document.querySelectorAll('.reminder-recipient-checkbox'));
  const selectable = boxes.filter((b) => !b.disabled);
  const selected = boxes.filter((b) => b.checked);

  setText('reminder-selected-count', String(selected.length));
  setText('reminder-send-count', String(selected.length));

  const selectAll = document.getElementById('reminders-select-all');
  if (selectAll) {
    selectAll.checked = selectable.length > 0 && selected.length === selectable.length;
    selectAll.disabled = selectable.length === 0;
  }

  const sendBtn = document.getElementById('reminder-send-btn');
  if (sendBtn) {
    sendBtn.disabled = selected.length === 0 || !reminderIsSuper;
    sendBtn.title = reminderIsSuper ? '' : 'Only a Super Admin can send bulk reminder emails.';
  }
}

function toggleAllReminderRecipients(checked) {
  document.querySelectorAll('.reminder-recipient-checkbox').forEach((b) => {
    if (!b.disabled) b.checked = checked;
  });
  updateReminderSelectedCount();
}

// Sends the reminder to the logged-in admin's own email only, so wording
// and formatting can be checked before the irreversible bulk send.
async function sendReminderTest() {
  const subject = document.getElementById('reminder-subject').value.trim();
  const bodyHtml = document.getElementById('reminder-body').value.trim();
  if (!subject || !bodyHtml) return showToast('Subject and body are both required.');

  const btn = document.getElementById('reminder-test-btn');
  const resultEl = document.getElementById('reminder-send-result');
  if (btn) btn.disabled = true;
  if (resultEl) { resultEl.className = 'text-xs font-semibold block text-slate-500'; resultEl.textContent = 'Sending test…'; }

  const data = await (await fetch('/api/admin/reminders/test-send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject, bodyHtml }),
  })).json();

  if (!data.success) {
    if (resultEl) { resultEl.className = 'text-xs font-semibold block text-rose-600'; resultEl.textContent = data.error || 'Test send failed.'; }
    showToast(data.error || 'Could not send test email.');
  } else {
    const msg = `Test sent to ${data.sentTo}.`;
    if (resultEl) { resultEl.className = 'text-xs font-semibold block text-emerald-600'; resultEl.textContent = msg; }
    showToast(msg, 'success');
  }
  if (btn) btn.disabled = false;
}

async function sendRegistrationReminders() {
  const subject = document.getElementById('reminder-subject').value.trim();
  const bodyHtml = document.getElementById('reminder-body').value.trim();
  const phones = Array.from(document.querySelectorAll('.reminder-recipient-checkbox:checked')).map((b) => b.value);
  if (!subject || !bodyHtml) return showToast('Subject and body are both required.');
  if (!phones.length) return showToast('Select at least one recipient.');

  if (!confirm(`Send this reminder to ${phones.length} selected ${phones.length === 1 ? 'person' : 'people'}? This can't be undone.`)) return;

  const btn = document.getElementById('reminder-send-btn');
  const resultEl = document.getElementById('reminder-send-result');
  if (btn) btn.disabled = true;
  if (resultEl) { resultEl.className = 'text-xs font-semibold block text-slate-500'; resultEl.textContent = 'Sending…'; }

  const data = await (await fetch('/api/admin/reminders/send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject, bodyHtml, phones }),
  })).json();

  if (!data.success) {
    if (resultEl) { resultEl.className = 'text-xs font-semibold block text-rose-600'; resultEl.textContent = data.error || 'Send failed.'; }
    showToast(data.error || 'Could not send reminders.');
  } else {
    const skipNotes = [
      data.skippedNoEmail ? `${data.skippedNoEmail} no email on file` : null,
      data.skippedSentRecently ? `${data.skippedSentRecently} sent within the last 24h` : null,
    ].filter(Boolean).join(', ');
    const msg = `Sent to ${data.sent} of ${data.total}${skipNotes ? ` (${skipNotes})` : ''}.`;
    if (resultEl) { resultEl.className = 'text-xs font-semibold block text-emerald-600'; resultEl.textContent = msg; }
    showToast(msg, 'success');
  }
  // Refresh so last-sent times and cooldown badges reflect what just happened.
  await renderBackendReminders(reminderIsSuper);
}

// --- BALANCE-DUE PAYMENT REMINDERS (admin) ---
// Mirrors REGISTRATION REMINDERS above one-for-one -- same cooldown/select-all/
// test-then-send flow -- for the other worklist that benefits from a nudge:
// PARTIAL_PAYMENT registrations (see isBalanceDue()). The one addition is
// {{amount}}, each recipient's own outstanding balance.

function balanceDueReminderDefaultBody() {
  const c = conferenceInfo;
  return `<p>Dear {{name}},</p>
<p>Thanks for registering for the ${esc(c.name)}. Your registration currently has a balance of <b>{{amount}}</b> still due.</p>
<p>Please log in and complete your payment at your earliest convenience to confirm your spot.</p>
<p style="text-align:center;margin:1.5rem 0">
  <a href="${window.location.origin}" style="background:#4f46e5;color:#fff;padding:.75rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">Pay My Balance</a>
</p>
<p>If you've already paid, please disregard this email.</p>`;
}

let cachedBalanceDueRecipients = [];
let balanceDueIsSuper = false;

function balanceDueReminderOnCooldown(u) {
  return u.last_reminder_sent_at && (Date.now() - Number(u.last_reminder_sent_at)) < REMINDER_COOLDOWN_MS;
}

async function renderBackendBalanceDueReminders(isSuper) {
  balanceDueIsSuper = isSuper;
  const res = await fetch('/api/admin/reminders/balance-due');
  if (!res.ok) return;
  const data = await res.json();
  cachedBalanceDueRecipients = data.users || [];

  setText('bdreminders-count', String(cachedBalanceDueRecipients.length));

  const bodyBox = document.getElementById('bdreminder-body');
  if (bodyBox && !bodyBox.value.trim()) bodyBox.value = balanceDueReminderDefaultBody();

  const list = document.getElementById('bdreminders-list');
  if (list) {
    list.innerHTML = cachedBalanceDueRecipients.length
      ? cachedBalanceDueRecipients.map((u) => {
        const onCooldown = balanceDueReminderOnCooldown(u);
        const disabled = !u.email || onCooldown;
        return `
        <div class="px-3 py-2 flex items-center gap-2">
          <input type="checkbox" class="bdreminder-recipient-checkbox shrink-0" value="${esc(u.phone_number)}" ${disabled ? 'disabled' : ''} onchange="updateBalanceDueReminderSelectedCount()">
          <div class="min-w-0 flex-1">
            <p class="font-semibold text-slate-700 truncate">${esc(u.delegate_name)} <span class="font-normal text-slate-400">· ₹${inr(u.remaining)} due</span></p>
            <p class="text-xs text-slate-400 truncate">${esc(u.email || 'No email on file')}${u.last_reminder_sent_at ? ` · last sent ${esc(fmtAuditTime(u.last_reminder_sent_at))}` : ''}</p>
          </div>
          ${!u.email ? '<span class="text-[10px] bg-rose-100 text-rose-700 px-2 py-0.5 rounded-full font-bold shrink-0">No email</span>' : ''}
          ${onCooldown ? '<span class="text-[10px] bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-bold shrink-0">Sent within 24h</span>' : ''}
        </div>`;
      }).join('')
      : `<div class="px-3 py-6 text-center text-slate-400 text-sm">No registrations have a balance due right now.</div>`;
  }

  const testBtn = document.getElementById('bdreminder-test-btn');
  if (testBtn) {
    testBtn.disabled = !isSuper;
    testBtn.title = isSuper ? '' : 'Only a Super Admin can send reminder emails.';
  }
  updateBalanceDueReminderSelectedCount();
}

function updateBalanceDueReminderSelectedCount() {
  const boxes = Array.from(document.querySelectorAll('.bdreminder-recipient-checkbox'));
  const selectable = boxes.filter((b) => !b.disabled);
  const selected = boxes.filter((b) => b.checked);

  setText('bdreminder-selected-count', String(selected.length));
  setText('bdreminder-send-count', String(selected.length));

  const selectAll = document.getElementById('bdreminders-select-all');
  if (selectAll) {
    selectAll.checked = selectable.length > 0 && selected.length === selectable.length;
    selectAll.disabled = selectable.length === 0;
  }

  const sendBtn = document.getElementById('bdreminder-send-btn');
  if (sendBtn) {
    sendBtn.disabled = selected.length === 0 || !balanceDueIsSuper;
    sendBtn.title = balanceDueIsSuper ? '' : 'Only a Super Admin can send bulk reminder emails.';
  }
}

function toggleAllBalanceDueRecipients(checked) {
  document.querySelectorAll('.bdreminder-recipient-checkbox').forEach((b) => {
    if (!b.disabled) b.checked = checked;
  });
  updateBalanceDueReminderSelectedCount();
}

async function sendBalanceDueReminderTest() {
  const subject = document.getElementById('bdreminder-subject').value.trim();
  const bodyHtml = document.getElementById('bdreminder-body').value.trim();
  if (!subject || !bodyHtml) return showToast('Subject and body are both required.');

  const btn = document.getElementById('bdreminder-test-btn');
  const resultEl = document.getElementById('bdreminder-send-result');
  if (btn) btn.disabled = true;
  if (resultEl) { resultEl.className = 'text-xs font-semibold block text-slate-500'; resultEl.textContent = 'Sending test…'; }

  const data = await (await fetch('/api/admin/reminders/balance-due/test-send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject, bodyHtml }),
  })).json();

  if (!data.success) {
    if (resultEl) { resultEl.className = 'text-xs font-semibold block text-rose-600'; resultEl.textContent = data.error || 'Test send failed.'; }
    showToast(data.error || 'Could not send test email.');
  } else {
    const msg = `Test sent to ${data.sentTo}.`;
    if (resultEl) { resultEl.className = 'text-xs font-semibold block text-emerald-600'; resultEl.textContent = msg; }
    showToast(msg, 'success');
  }
  if (btn) btn.disabled = false;
}

async function sendBalanceDueReminders() {
  const subject = document.getElementById('bdreminder-subject').value.trim();
  const bodyHtml = document.getElementById('bdreminder-body').value.trim();
  const phones = Array.from(document.querySelectorAll('.bdreminder-recipient-checkbox:checked')).map((b) => b.value);
  if (!subject || !bodyHtml) return showToast('Subject and body are both required.');
  if (!phones.length) return showToast('Select at least one recipient.');

  if (!confirm(`Send this reminder to ${phones.length} selected ${phones.length === 1 ? 'person' : 'people'}? This can't be undone.`)) return;

  const btn = document.getElementById('bdreminder-send-btn');
  const resultEl = document.getElementById('bdreminder-send-result');
  if (btn) btn.disabled = true;
  if (resultEl) { resultEl.className = 'text-xs font-semibold block text-slate-500'; resultEl.textContent = 'Sending…'; }

  const data = await (await fetch('/api/admin/reminders/balance-due/send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject, bodyHtml, phones }),
  })).json();

  if (!data.success) {
    if (resultEl) { resultEl.className = 'text-xs font-semibold block text-rose-600'; resultEl.textContent = data.error || 'Send failed.'; }
    showToast(data.error || 'Could not send reminders.');
  } else {
    const skipNotes = [
      data.skippedNoEmail ? `${data.skippedNoEmail} no email on file` : null,
      data.skippedSentRecently ? `${data.skippedSentRecently} sent within the last 24h` : null,
    ].filter(Boolean).join(', ');
    const msg = `Sent to ${data.sent} of ${data.total}${skipNotes ? ` (${skipNotes})` : ''}.`;
    if (resultEl) { resultEl.className = 'text-xs font-semibold block text-emerald-600'; resultEl.textContent = msg; }
    showToast(msg, 'success');
  }
  // Refresh so last-sent times and cooldown badges reflect what just happened.
  await renderBackendBalanceDueReminders(balanceDueIsSuper);
}

// --- CUSTOM-RECIPIENT REMINDERS (admin) ---
// Reaches addresses with no account in this system at all -- e.g. an
// external mailing list -- so it's driven by a pasted list, not a picked-
// from-a-table selection like the two reminder cards above.

// Defaults to an "early bird ends today" push (fetching the actual cutoff
// date from /api/fees so the copy doesn't drift from the real fee_config),
// since that's the recurring reason this card gets used -- an admin can
// still overwrite both fields for any other announcement.
// Pulls conference details, current fee-category pricing, and the
// program-group lineup live from the server (rather than hardcoding any of
// it into the template) so the email can't say something the admin-editable
// settings no longer agree with.
async function buildEarlyBirdReminderBody() {
  const c = conferenceInfo;
  const start = formatFullDate(c.startDate);
  const end = formatFullDate(c.endDate);
  const dateRange = (start && end && c.startDate !== c.endDate) ? `${start} &ndash; ${end}` : (start || end);

  let deadlineLine = '';
  try {
    const fees = await (await fetch('/api/fees')).json();
    if (fees.earlyUntil) deadlineLine = ` (${esc(formatFullDate(fees.earlyUntil))})`;
  } catch { /* best-effort -- the email still makes sense without the exact date */ }

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

let customReminderInitialized = false;
async function initCustomReminderCard() {
  updateCustomReminderCount();
  if (customReminderInitialized) return;
  customReminderInitialized = true;

  const subjectInput = document.getElementById('customreminder-subject');
  const bodyBox = document.getElementById('customreminder-body');
  if (subjectInput && !subjectInput.value.trim()) {
    subjectInput.value = conferenceInfo.acronym ? `Early Bird Registration for ${conferenceInfo.acronym} Ends Today` : 'Early Bird Registration Ends Today';
  }
  if (bodyBox && !bodyBox.value.trim()) {
    bodyBox.value = await buildEarlyBirdReminderBody();
  }
}

function parseCustomReminderEmails() {
  const raw = document.getElementById('customreminder-emails').value;
  return raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

function updateCustomReminderCount() {
  setText('customreminder-send-count', String(parseCustomReminderEmails().length));
  const sendBtn = document.getElementById('customreminder-send-btn');
  if (sendBtn) sendBtn.disabled = !isSuperAdminViewer();
}

// Reuses the same test-send endpoint as the other two cards -- it only ever
// emails the logged-in admin's own address, so it doesn't care which card
// triggered it.
async function sendCustomReminderTest() {
  const subject = document.getElementById('customreminder-subject').value.trim();
  const bodyHtml = document.getElementById('customreminder-body').value.trim();
  if (!subject || !bodyHtml) return showToast('Subject and body are both required.');

  const btn = document.getElementById('customreminder-test-btn');
  const resultEl = document.getElementById('customreminder-send-result');
  if (btn) btn.disabled = true;
  if (resultEl) { resultEl.className = 'text-xs font-semibold block text-slate-500'; resultEl.textContent = 'Sending test…'; }

  const data = await (await fetch('/api/admin/reminders/test-send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject, bodyHtml }),
  })).json();

  if (!data.success) {
    if (resultEl) { resultEl.className = 'text-xs font-semibold block text-rose-600'; resultEl.textContent = data.error || 'Test send failed.'; }
    showToast(data.error || 'Could not send test email.');
  } else {
    const msg = `Test sent to ${data.sentTo}.`;
    if (resultEl) { resultEl.className = 'text-xs font-semibold block text-emerald-600'; resultEl.textContent = msg; }
    showToast(msg, 'success');
  }
  if (btn) btn.disabled = false;
}

async function sendCustomReminders() {
  const subject = document.getElementById('customreminder-subject').value.trim();
  const bodyHtml = document.getElementById('customreminder-body').value.trim();
  const emails = parseCustomReminderEmails();
  if (!subject || !bodyHtml) return showToast('Subject and body are both required.');
  if (!emails.length) return showToast('Enter at least one email address.');

  if (!confirm(`Send this reminder to ${emails.length} entered ${emails.length === 1 ? 'address' : 'addresses'}? This can't be undone.`)) return;

  const btn = document.getElementById('customreminder-send-btn');
  const resultEl = document.getElementById('customreminder-send-result');
  if (btn) btn.disabled = true;
  if (resultEl) { resultEl.className = 'text-xs font-semibold block text-slate-500'; resultEl.textContent = 'Sending…'; }

  const data = await (await fetch('/api/admin/reminders/custom-send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject, bodyHtml, emails }),
  })).json();

  if (!data.success) {
    if (resultEl) { resultEl.className = 'text-xs font-semibold block text-rose-600'; resultEl.textContent = data.error || 'Send failed.'; }
    showToast(data.error || 'Could not send reminders.');
  } else {
    const skipNotes = [
      data.skippedInvalid ? `${data.skippedInvalid} not a valid address` : null,
      data.skippedSentRecently ? `${data.skippedSentRecently} sent within the last 24h` : null,
    ].filter(Boolean).join(', ');
    const msg = `Sent to ${data.sent} of ${data.total}${skipNotes ? ` (${skipNotes})` : ''}.`;
    if (resultEl) { resultEl.className = 'text-xs font-semibold block text-emerald-600'; resultEl.textContent = msg; }
    showToast(msg, 'success');
  }
  if (btn) btn.disabled = false;
}

// CSV downloads; HTML opens a printable report (Print / Save as PDF).
// `extraQuery` is an already-encoded query fragment like "&optionId=5"
// (used by the workshops report's one-at-a-time picker).
function downloadReport(type, format, extraQuery) {
  const params = (format === 'csv' ? 'format=csv' : '') + (extraQuery || '');
  const url = `/api/admin/reports/${encodeURIComponent(type)}` + (params ? '?' + params.replace(/^&/, '') : '');
  window.open(url, '_blank');
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
    const keep = ['Designation', 'Institution', 'District', 'State'];
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
    const STATUS_ICON = { verified: '✅', accepted: '✅', completed: '✅', rejected: '❌', pending: '⏳' };
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
      ${sec.name ? `<h3 class="text-sm font-bold text-indigo-800 mt-4 mb-2">${esc(sec.name)} <span class="report-section-count text-slate-400 font-normal">(${sec.rows.length})</span></h3>` : ''}
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
        <p class="text-xs text-slate-500 mt-0.5">Total: <span id="report-total-count" class="font-bold text-slate-700">${totalRows}</span> record${totalRows === 1 ? '' : 's'}<span id="report-filtered-note" class="hidden text-slate-400"> (filtered from ${totalRows})</span></p>
      </div>
      <div class="flex items-center gap-2">
        <input id="report-search-input" type="text" placeholder="🔍 Search rows…" oninput="filterReportRows()" class="p-2 border rounded-lg text-xs w-52 outline-none focus:ring-2 focus:ring-indigo-200">
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
  UNDER_REVIEW: 'bg-amber-100 text-amber-800',
  ACCEPTED: 'bg-emerald-100 text-emerald-800',
  REJECTED: 'bg-rose-100 text-rose-800',
  REVISION_REQUESTED: 'bg-orange-100 text-orange-800',
};

// Shared header markup (title, author, status badge, last-action note, file
// link) for both the Approval and Assignment cards.
function abstractCardHeader(a) {
  const status = a.status || 'UNDER_REVIEW';
  const badge = ABSTRACT_STATUS_STYLES[status] || 'bg-slate-100 text-slate-700';
  return `
      <div class="flex justify-between items-start gap-4">
        <div>
          <h4 class="font-bold text-slate-800">${esc(a.title)}</h4>
          <p class="text-xs text-slate-500 mt-0.5">${esc(a.author_name)} · ${esc(a.format)}</p>
        </div>
        <div class="text-right shrink-0">
          <span class="${badge} text-xs px-2.5 py-1 rounded-full font-bold whitespace-nowrap">${esc(status.replace('_', ' '))}</span>
          ${status === 'REVISION_REQUESTED' ? '<p class="text-[10px] text-orange-600 mt-1">Awaiting delegate resubmission</p>' : ''}
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

function openAbstractReview(id) {
  const a = abstractsCache.find((x) => String(x.id) === String(id));
  if (!a) return;
  const titleEl = document.getElementById('abstract-review-modal-title');
  if (titleEl) titleEl.innerText = a.title || 'Abstract';
  const body = document.getElementById('abstract-review-modal-body');
  if (body) body.innerHTML = abstractSectionsHtml(a);
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
  const abstracts = data.abstracts || [];
  abstractsCache = abstracts;
  const underReview = abstracts.filter(a => (a.status || 'UNDER_REVIEW') === 'UNDER_REVIEW');
  setText('badge-pending-abstracts', underReview.length);

  if (!abstracts.length) {
    approvalBox.innerHTML = `<p class="text-sm text-slate-500 p-4">No abstracts submitted yet.</p>`;
    assignBox.innerHTML = '';
    return;
  }

  // Step 1: Approval -- accept/reject/reset happens inside the review modal
  // (see openAbstractReview), not on the card itself.
  approvalBox.innerHTML = abstracts.map(a => `
    <div class="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm">
      ${abstractCardHeader(a)}
    </div>
  `).join('');

  // Step 2: Assignment -- approved abstracts only.
  const approved = abstracts.filter(a => a.status === 'ACCEPTED');
  assignBox.innerHTML = approved.length ? approved.map(a => `
    <div class="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm">
      ${abstractCardHeader(a)}
      <div class="flex flex-wrap items-center gap-2 mt-4 pt-3 border-t border-slate-100">
        <span class="text-[11px] font-semibold text-slate-500">Assign format:</span>
        <button class="abstract-alloc-btn px-3 py-1.5 ${a.allocation === 'ORAL' ? 'bg-indigo-600' : 'bg-white border border-indigo-300 text-indigo-700'} ${a.allocation === 'ORAL' ? 'text-white' : ''} font-semibold rounded-lg text-xs" data-id="${esc(a.id)}" data-alloc="ORAL">Oral</button>
        <button class="abstract-alloc-btn px-3 py-1.5 ${a.allocation === 'POSTER' ? 'bg-indigo-600' : 'bg-white border border-indigo-300 text-indigo-700'} ${a.allocation === 'POSTER' ? 'text-white' : ''} font-semibold rounded-lg text-xs" data-id="${esc(a.id)}" data-alloc="POSTER">Poster</button>
        ${a.allocation ? `<span class="text-[11px] text-emerald-600 font-semibold">Assigned &amp; delegate notified: ${esc(a.allocation === 'ORAL' ? 'Oral' : 'Poster')}</span>` : `<span class="text-[11px] text-amber-600 font-semibold">Not yet assigned — delegate has not been notified</span>`}
      </div>
    </div>
  `).join('') : `<p class="text-sm text-slate-500 p-4">No approved abstracts yet.</p>`;
}

async function updateAbstractStatus(id, status) {
  await fetch(`/api/abstracts/${encodeURIComponent(id)}/status`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status })
  });
  renderBackendAbstracts();
}

async function updateAbstractAllocation(id, allocation) {
  const data = await (await fetch(`/api/abstracts/${encodeURIComponent(id)}/allocation`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ allocation })
  })).json();
  if (!data.success) showToast(data.error || 'Allocation failed.');
  renderBackendAbstracts();
}

function openCreateUserModal() {
  // Same escalation boundary as the role-change select in openUserDetail:
  // only a Super Admin can hand out Super Admin (see the server-side check
  // in POST /api/users).
  const superOpt = document.querySelector('#new-user-role option[value="SUPER_ADMIN"]');
  if (superOpt) superOpt.disabled = !isSuperAdminViewer();
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

async function openRegisterDelegateModal() {
  resetRegisterDelegateForm();
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
  openModal('modal-register-delegate');
}

function resetRegisterDelegateForm() {
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
function updateRegisterDelegateFee() {
  const key = document.getElementById('rd-category').value;
  const cat = rdCategoriesCache.find((c) => c.key === key);
  const base = cat ? Number(cat.fee) || 0 : 0;
  const optionsFee = collectRegisterDelegateOptionIds().reduce((sum, id) => {
    const opt = rdGroupsCache.flatMap((g) => g.options).find((o) => o.id === id);
    return sum + (opt ? Number(opt.fee) || 0 : 0);
  }, 0);
  const total = base + optionsFee;
  setText('rd-fee-display', `₹${inr(total)}`);
  const cashInput = document.getElementById('rd-cash-amount');
  if (cashInput && (cashInput.value === '' || Number(cashInput.dataset.auto) === 1)) {
    cashInput.value = total;
    cashInput.dataset.auto = '1';
  }
  if (rdMode === 'BANK_TRANSFER') loadRegisterDelegateBankCandidates(total);
  return total;
}

function setRegisterDelegateMode(mode) {
  rdMode = mode;
  const cashBtn = document.getElementById('rd-mode-cash-btn');
  const bankBtn = document.getElementById('rd-mode-bank-btn');
  const cashBox = document.getElementById('rd-mode-cash');
  const bankBox = document.getElementById('rd-mode-bank');
  const isCash = mode === 'CASH';
  if (cashBtn) cashBtn.className = `flex-1 py-2 rounded-md ${isCash ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500'}`;
  if (bankBtn) bankBtn.className = `flex-1 py-2 rounded-md ${!isCash ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500'}`;
  if (cashBox) cashBox.classList.toggle('hidden', !isCash);
  if (bankBox) bankBox.classList.toggle('hidden', isCash);
  if (isCash) setRegisterDelegateBankLinkLater(false);
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
      <button type="button" class="shrink-0 px-2 py-1 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded" onclick='selectRegisterDelegateBankTxn(${JSON.stringify(t).replace(/'/g, "&#39;")})'>Select</button>
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
  if (!isPhoneValue(phone)) return showToast('Enter a valid mobile number.');
  const categoryKey = document.getElementById('rd-category').value;
  if (!categoryKey) return showToast('Select a delegate category.');
  const cat = rdCategoriesCache.find((c) => c.key === categoryKey);
  if (cat && cat.requiresStudentId && !document.getElementById('rd-idverify-checkbox').checked) {
    return showToast('Confirm the student ID card before continuing.');
  }

  const payload = {
    phone,
    name: document.getElementById('rd-name').value.trim(),
    designation: document.getElementById('rd-designation').value.trim(),
    institute: document.getElementById('rd-institute').value.trim(),
    email: document.getElementById('rd-email').value.trim(),
    categoryKey,
    optionIds: collectRegisterDelegateOptionIds(),
    discountCode: document.getElementById('rd-discount-code').value.trim(),
    idVerifiedByAdmin: cat && cat.requiresStudentId ? true : undefined,
    paymentMode: rdMode,
  };
  if (rdMode === 'CASH') {
    payload.amount = Number(document.getElementById('rd-cash-amount').value);
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
    const data = await (await fetch('/api/admin/registrations', {
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
    setText('rd-result-icon', isPending ? '⏳' : '✅');
    const heading = document.getElementById('rd-result-heading');
    if (heading) heading.className = `font-bold mt-1 ${isPending ? 'text-amber-800' : 'text-emerald-800'}`;
    setText('rd-result-heading', isPending ? 'Registered — payment pending bank-statement linkage' : 'Registration confirmed');
    const balance = Math.max(0, Number(data.expectedAmount) - Number(data.paidAmount));
    setText('rd-result-amount', isPending
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

// Header "Settings" dropdown: Masters, Reminders, and Logs (Activity Log)
// live here instead of the main tab bar.
function toggleSettingsMenu(forceHide) {
  const menu = document.getElementById('settings-menu');
  if (menu) menu.classList.toggle('hidden', forceHide === true ? true : undefined);
}
function selectSettingsTab(tab) {
  switchBackendTab(tab);
  toggleSettingsMenu(true);
}
document.addEventListener('click', (e) => {
  const menu = document.getElementById('settings-menu');
  const btn = document.getElementById('settings-menu-btn');
  if (!menu || menu.classList.contains('hidden')) return;
  if (menu.contains(e.target) || (btn && btn.contains(e.target))) return;
  menu.classList.add('hidden');
});

// Settings sub-menu tabs (each is now its own top-level <section>) vs. the
// main nav-bar tabs. The Settings items highlight in the dropdown; the main
// tabs highlight in the tab bar.
const SETTINGS_TABS = ['programs', 'fees', 'general', 'reminders', 'groupdiscount', 'discount', 'users', 'activity'];
const MAIN_TABS = ['payments', 'statement', 'abstracts', 'reports'];

// Which tabs each role may open -- the single source of truth used both to
// pick the landing tab and to validate a tab restored from the URL, so a
// bookmarked #users can't drop a finance admin on a section they can't see.
// Mirrors the show/hide rules in applyRoleVisibility().
function allowedBackendTabs({ isSuper, isFinance, isReviewer, isOperations }) {
  const allowed = [];
  if (isFinance) allowed.push('payments', 'statement');
  if (isReviewer) allowed.push('abstracts');
  if (isFinance || isReviewer || isOperations) allowed.push('reports');
  if (isFinance) allowed.push('reminders', 'groupdiscount');
  if (isSuper) allowed.push('programs', 'fees', 'general', 'discount', 'activity');
  if (isSuper || isOperations) allowed.push('users');
  return allowed;
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
  if (tab === 'payments') { renderBackendPayments(); renderDelegateMap(); }
  if (tab === 'abstracts') renderBackendAbstracts();
  if (tab === 'reports') loadReportWorkshopOptions();
  if (tab === 'programs') renderBackendPrograms();
  if (tab === 'fees') renderBackendFees();
  if (tab === 'discount') renderDiscountCodes();
  if (tab === 'groupdiscount') { renderGroupRules(); renderGroupsMonitor(); }
  if (tab === 'general') renderGeneralSettings();
  if (tab === 'activity') renderBackendActivity();
  if (tab === 'users') loadBackendUsers();
  if (tab === 'reminders') { renderBackendReminders(isSuperAdminViewer()); renderBackendBalanceDueReminders(isSuperAdminViewer()); initCustomReminderCard(); }
  [...MAIN_TABS, ...SETTINGS_TABS].forEach(t => {
    const section = document.getElementById(`section-${t}`);
    if (section) section.classList.toggle('hidden', t !== tab);

    const btn = document.getElementById(`nav-tab-${t}`);
    if (btn) {
      const active = t === tab;
      btn.classList.toggle('text-indigo-600', active);
      btn.classList.toggle('border-b-2', active);
      btn.classList.toggle('border-indigo-600', active);
      btn.classList.toggle('text-slate-500', !active);
    }
  });

  // Highlight whichever Settings-menu item is currently selected, since those
  // tabs live in the header dropdown rather than the main tab bar.
  SETTINGS_TABS.forEach((key) => {
    const item = document.getElementById(`settings-item-${key}`);
    if (!item) return;
    const active = key === tab;
    item.classList.toggle('bg-indigo-50', active);
    item.classList.toggle('text-indigo-700', active);
  });

  if (tab === 'statement') loadReconciliation();
}

// Follow the hash if it changes from outside our own navigation -- editing it
// in the address bar, or following a link to #general. switchBackendTab writes
// it with replaceState (no new history entry, so clicking through tabs doesn't
// bury the previous page behind a dozen Back presses), which doesn't emit
// hashchange, and the guard below ignores a tab already showing.
window.addEventListener('hashchange', () => {
  const tab = window.location.hash.slice(1);
  if (!tab || tab === currentBackendTab || !activeAdminUser) return;
  if (allowedBackendTabs(rolesFor(activeAdminUser.role)).includes(tab)) switchBackendTab(tab);
});

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
            <span class="bg-slate-100 text-slate-600 text-[10px] font-semibold px-2 py-0.5 rounded-full">${esc(PAYMENT_MODE_LABELS[r.payment_mode] || r.payment_mode || 'UPI')}</span>
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
          <button type="button" onclick="markNonRegistration(${esc(t.id)}, false)" class="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg">Unmark</button>
        </td>
      </tr>`).join('') : `<tr><td colspan="4" class="p-4 text-center text-slate-400 text-xs">No transactions marked non-registration.</td></tr>`;
  }

  cachedMatched = data.matched || [];
  filterMatchedRows();
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
  const rejectedTag = m.bank_status === 'REJECTED'
    ? ' <span class="text-[10px] font-bold text-rose-700 bg-rose-50 border border-rose-200 rounded px-1.5 py-0.5">rejected</span>' : '';
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
          ${m.amountOk ? '' : `<p class="text-[11px] text-rose-600 font-bold mt-1">⚠ credit not fully/exactly allocated</p>`}
        </td>
        <td class="p-3 text-slate-400 hidden sm:table-cell">${serial}</td>
        <td class="p-3 font-mono text-xs hidden sm:table-cell">${esc(m.registration_number || '—')}</td>
        <td class="p-3 hidden sm:table-cell">${esc(m.delegate_name)}${rejectedTag}</td>
        <td class="p-3 font-mono text-xs hidden sm:table-cell">${esc(m.utr_number)}</td>
        <td class="p-3 hidden sm:table-cell">${esc(m.transaction.post_date)}</td>
        <td class="p-3 text-xs text-slate-500 hidden sm:table-cell max-w-[240px] truncate" title="${esc(m.transaction.description || '')}">${esc(m.transaction.description || '—')}</td>
        <td class="p-3 hidden sm:table-cell">${amountLine}${m.amountOk ? '' : ` <span class="text-rose-600 font-bold">⚠ not fully/exactly allocated</span>`}</td>
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
