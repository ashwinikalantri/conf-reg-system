const OFFICIAL_UPI_ID = "abhishekraut@cbin";
<!-- const OFFICIAL_UPI_ID = "nqocn2026@cbin"-->

// Categories that must upload a student ID card (kept in sync with the server).
const STUDENT_CATEGORIES = ['nursing_ug', 'nursing_pg', 'med_student', 'pg_doctor'];

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

const ADMIN_ROLES = ['SUPER_ADMIN', 'FINANCE_ADMIN', 'ACADEMIC_REVIEWER', 'FINANCE_ACADEMIC'];
function isAdminUser() {
  return !!currentDelegate && ADMIN_ROLES.includes(currentDelegate.role);
}

// Human-readable role names for display (raw values keep their underscores).
const ROLE_LABELS = {
  DELEGATE: 'Delegate',
  FINANCE_ADMIN: 'Finance Admin',
  ACADEMIC_REVIEWER: 'Academic Reviewer',
  FINANCE_ACADEMIC: 'Finance & Academic Reviewer',
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
  if (subEl) subEl.innerText = `${currentDelegate.designation} | ${currentDelegate.institution || currentDelegate.institute} (+91 ${currentDelegate.phone_number || currentDelegate.phone})`;
}

function toggleAuth(view) {
  const regForm = document.getElementById('register-form');
  const loginForm = document.getElementById('login-form');
  
  if (view === 'register') {
    regForm.classList.remove('hidden');
    loginForm.classList.add('hidden');
  } else {
    loginForm.classList.remove('hidden');
    regForm.classList.add('hidden');
  }
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
async function requestOTP(context) {
  const phone = document.getElementById(`${context}-phone`).value.trim();
  if (phone.length !== 10 || isNaN(phone)) {
    return showToast("Please enter a valid 10-digit Indian Mobile Number.");
  }

  const res = await fetch('/api/otp/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone })
  });
  const data = await res.json();

  if (data.success) {
    document.getElementById(`${context}-otp-container`).classList.remove('hidden');
    if (data.devOtp) {
      document.getElementById(`${context}-otp-hint`).innerText = `Demo OTP: ${data.devOtp}`;
      showToast(`OTP sent to +91 ${phone}.\nYour 6-Digit OTP is: ${data.devOtp}`, 'info');
    } else {
      document.getElementById(`${context}-otp-hint`).innerText = 'Sent via SMS';
      showToast(`A 6-digit OTP has been sent to +91 ${phone}.`, 'info');
    }
  } else {
    showToast(data.error || 'Could not send OTP. Please try again.');
  }
}

// Same pattern the server enforces (server.js) -- pragmatic "good enough"
// email shape, not full RFC 5322. Checked here too so a malformed address
// is caught immediately with the app's own toast, instead of only via the
// browser's native type="email" validation (which is inconsistently loose
// across browsers) or a round-trip to the server.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function handleRegistration(e) {
  e.preventDefault();
  const phone = document.getElementById('reg-phone').value.trim();
  const otp = document.getElementById('reg-otp').value.trim();
  const email = document.getElementById('reg-email').value.trim();

  if (email && !EMAIL_RE.test(email)) {
    showToast('Please enter a valid email address.');
    return;
  }

  const payload = {
    phone,
    otp,
    salutation: document.getElementById('reg-salutation').value,
    name: document.getElementById('reg-name').value,
    age: document.getElementById('reg-age').value,
    gender: document.getElementById('reg-gender').value,
    designation: document.getElementById('reg-designation').value,
    institute: document.getElementById('reg-institute').value,
    email,
    pincode: document.getElementById('reg-pincode').value,
    state: document.getElementById('reg-state').value,
    district: document.getElementById('reg-district').value
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
    showToast("Mobile OTP Verified! Account registered.", 'success');
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
  const phone = document.getElementById('login-phone').value.trim();
  const otp = document.getElementById('login-otp').value.trim();

  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, otp })
  });
  const data = await res.json();

  if (data.success) {
    currentDelegate = data.user;
    persistDelegate(currentDelegate);
    const welcomeName = currentDelegate.full_name || currentDelegate.name;
    showToast(`Welcome back, ${currentDelegate.salutation ? currentDelegate.salutation + ' ' : ''}${welcomeName}!`, 'success');
    loadDashboard();
  } else if (data.notRegistered) {
    // New number — switch to sign-up, carrying the phone and (still-valid) OTP.
    toggleAuth('register');
    document.getElementById('reg-phone').value = phone;
    document.getElementById('reg-otp-container').classList.remove('hidden');
    document.getElementById('reg-otp').value = otp;
    document.getElementById('reg-otp-hint').innerText = otp ? 'OTP carried over' : '';
    showToast("This number isn't registered yet — please complete the sign-up form to create your account.", 'info');
  } else {
    showToast(data.error || "Login failed.");
  }
}

// --- DELEGATE DASHBOARD & FEATURES ---
async function loadDashboard() {
  if (!currentDelegate) return navigateTo('auth-page');

  const displayName = currentDelegate.full_name || currentDelegate.name;
  document.getElementById('user-display-name').innerText = currentDelegate.salutation ? `${currentDelegate.salutation} ${displayName}` : displayName;
  document.getElementById('user-display-sub').innerText = `${currentDelegate.designation} | ${currentDelegate.institution || currentDelegate.institute} (+91 ${currentDelegate.phone_number || currentDelegate.phone})`;

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
      setText('balance-fee', `₹${Number(reg.expected_amount)}`);
      setText('balance-paid', `₹${Number(reg.verified_total || 0)}`);
      setText('balance-due', `₹${Number(reg.remaining || 0)}`);
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
    document.getElementById('conf-workshop').innerText = reg.workshop || '—';
    document.getElementById('conf-qi').innerText = reg.qi_exposure || '—';
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
  navigateTo('dashboard-page');
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
  };
  try {
    const abs = (await (await fetch('/api/abstracts/me')).json()).abstract;
    if (abs) {
      let [label, cls] = STYLES[abs.status] || ['Submitted', 'bg-slate-100 text-slate-600'];
      if (abs.status === 'ACCEPTED' && abs.allocation) {
        label = `Accepted · ${abs.allocation === 'ORAL' ? 'Oral' : 'Poster'}`;
      }
      tag.className = `text-xs font-bold px-2 py-0.5 rounded-full ${cls}`;
      tag.innerText = label;

      // Locked after submission.
      if (btn) { btn.innerText = 'Abstract Submitted'; btn.disabled = true; btn.classList.add('opacity-60', 'cursor-not-allowed'); }
      if (desc) {
        if (abs.status === 'ACCEPTED' && abs.allocation) {
          const kind = abs.allocation === 'ORAL' ? 'oral' : 'poster';
          desc.innerHTML = `Your abstract has been <b>accepted for ${kind} presentation</b>. Details will be communicated.`;
        } else if (abs.status === 'ACCEPTED') {
          desc.innerHTML = 'Your abstract has been <b>accepted</b>. The presentation format will be communicated.';
        } else if (abs.status === 'REJECTED') {
          desc.innerText = 'Your abstract was not accepted.';
        } else {
          desc.innerText = 'Your abstract has been submitted and is under review. It cannot be changed.';
        }
      }
    } else {
      tag.className = 'text-xs bg-slate-100 text-slate-600 font-bold px-2 py-0.5 rounded-full';
      tag.innerText = 'Not Submitted';
      if (btn) { btn.innerText = 'Submit Abstract'; btn.disabled = false; btn.classList.remove('opacity-60', 'cursor-not-allowed'); }
    }
  } catch (e) { /* leave as-is */ }
}

// Applied promo code for the current payment form: { code, discountAmount,
// finalFee, categoryKey }. Cleared when the category changes.
let appliedPromo = null;
function clearAppliedPromo() {
  appliedPromo = null;
  const msg = document.getElementById('promo-msg');
  if (msg) msg.classList.add('hidden');
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
    showMsg(`Code applied — you save ₹${data.discountAmount}. New fee: ₹${data.finalFee}.`, true);
    calculateFee();
  } catch (e) {
    showMsg('Could not check the code. Try again.', false);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function calculateFee() {
  const catKey = document.getElementById('payment-category').value;

  // Student categories must upload an ID card.
  const idBlock = document.getElementById('id-card-block');
  if (idBlock) idBlock.classList.toggle('hidden', !STUDENT_CATEGORIES.includes(catKey));

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
  const currentFee = Math.max(0, baseFee - discount);

  const baseLine = document.getElementById('fee-discount-line');
  const discLine = document.getElementById('fee-discount-amount-line');
  if (discount > 0) {
    if (baseLine) { baseLine.classList.remove('hidden'); setText('fee-base-display', `₹${baseFee}`); }
    if (discLine) { discLine.classList.remove('hidden'); setText('fee-discount-display', `−₹${discount}`); setText('fee-discount-label', `Discount (${esc(appliedPromo.code)})`); }
  } else {
    if (baseLine) baseLine.classList.add('hidden');
    if (discLine) discLine.classList.add('hidden');
  }
  document.getElementById('calculated-fee-display').innerText = `₹${currentFee}`;
  document.getElementById('entered-amount').value = currentFee;

  // Reference is the delegate's registration number plus name, so the
  // transaction note (and therefore the QR code and the "Pay via UPI App"
  // link, which both encode the same note) let finance match a payment to a
  // delegate on sight, not just by number.
  const ref = (currentDelegate && (currentDelegate.registration_number || currentDelegate.phone_number || currentDelegate.phone)) || '';
  const name = (currentDelegate && (currentDelegate.full_name || currentDelegate.name)) || '';
  const note = name ? `${ref}_${name}` : ref;
  const upiUri = `upi://pay?pa=${OFFICIAL_UPI_ID}&pn=${encodeURIComponent('NQOCN 2026')}&am=${currentFee}.00&cu=INR&tn=${encodeURIComponent(note)}`;
  document.getElementById('upi-qr-image').src = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(upiUri)}`;
  const payLink = document.getElementById('upi-pay-link');
  if (payLink) payLink.href = upiUri;
  document.getElementById('qr-container').classList.remove('hidden');
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

// Populate a <select> from program-option data, showing remaining spots and
// disabling full options.
function fillOptionSelect(id, options, placeholder) {
  const sel = document.getElementById(id);
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = `<option value="">-- ${esc(placeholder)} --</option>` +
    (options || []).map(o =>
      `<option value="${o.id}" ${o.full ? 'disabled' : ''}>${esc(o.name)}${o.full ? ' — FULL' : ` (${o.remaining} left)`}</option>`
    ).join('');
  if (current) sel.value = current;
}

// Load workshops and QI practices (with live capacity) into the payment form.
async function loadProgramOptions() {
  try {
    const data = await (await fetch('/api/program-options')).json();
    fillOptionSelect('payment-workshop', data.workshops, 'Choose 1 Workshop (optional)');
    fillOptionSelect('payment-qi-exposure', data.qiPractices, 'Choose 1 QI Practice (optional)');
  } catch (e) {
    /* leave the placeholders in place if the fetch fails */
  }
}

// Categories + current-phase fee, loaded from the fee master.
let feeCategories = {};
async function loadFees() {
  try {
    const data = await (await fetch('/api/fees')).json();
    feeCategories = {};
    (data.categories || []).forEach((c) => { feeCategories[c.key] = c; });
    const sel = document.getElementById('payment-category');
    if (sel) {
      const current = sel.value;
      sel.innerHTML = '<option value="">-- Select Category --</option>' +
        (data.categories || []).map((c) => `<option value="${esc(c.key)}">${esc(c.label)}${c.subtitle ? ' — ' + esc(c.subtitle) : ''} — ₹${Number(c.fee)}</option>`).join('');
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
      <p class="font-semibold text-slate-700 text-sm shrink-0">₹${Number(c.fee)}</p>
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
  const isStudent = STUDENT_CATEGORIES.includes(categoryKey);

  // Belt-and-braces: entered-amount is only ever auto-filled by
  // calculateFee(), which now refuses to fall back to ₹0 -- but guard here
  // too in case it's ever empty for another reason, since a ₹0 claimed
  // amount gets silently flagged as tampering server-side.
  const enteredAmount = parseFloat(document.getElementById('entered-amount').value);
  if (!enteredAmount || enteredAmount <= 0) {
    return showToast('Could not determine the fee for this category. Please close and reopen this form.');
  }

  const file = document.getElementById('payment-screenshot').files[0];
  if (!file) return showToast('Please upload your payment screenshot.');

  const idFile = document.getElementById('payment-id-card').files[0];
  if (isStudent && !idFile) return showToast('Please upload your student ID card for this category.');

  const submitBtn = document.getElementById('submit-payment-btn');
  const originalBtnText = submitBtn.innerText;
  submitBtn.innerText = 'Checking uploads...';
  submitBtn.disabled = true;

  try {
    const screenshot = await readFileAsDataURL(file);
    const idCard = isStudent ? await readFileAsDataURL(idFile) : undefined;
    const utr = document.getElementById('entered-utr').value.trim();

    // The server derives the fee from the category and reads the screenshot
    // (amount / UPI ID / UTR) and, for students, the ID card.
    const basePayload = {
      categoryKey,
      workshopOptionId: Number(document.getElementById('payment-workshop').value) || null,
      qiOptionId: Number(document.getElementById('payment-qi-exposure').value) || null,
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
      if (!c.amount) problems.push(`• The amount ₹${data.expectedAmount} could not be found in the screenshot`);
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
        : "Registration submitted successfully! It is PENDING manual verification.",
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
function openTopupModal() {
  const reg = currentRegistration;
  if (!reg || !(reg.remaining > 0)) return showToast('No outstanding balance to pay.');
  const balance = Number(reg.remaining);
  setText('topup-amount-display', `₹${balance}`);
  document.getElementById('topup-utr').value = '';
  const fileInput = document.getElementById('topup-screenshot');
  if (fileInput) fileInput.value = '';

  // UPI QR for the exact balance, with the delegate's reg number + name as the
  // note so finance can match it -- same scheme as the initial payment.
  const ref = reg.registration_number || reg.phone_number || '';
  const name = (currentDelegate && (currentDelegate.full_name || currentDelegate.name)) || '';
  const note = name ? `${ref}_${name}` : ref;
  const upiUri = `upi://pay?pa=${OFFICIAL_UPI_ID}&pn=${encodeURIComponent('NQOCN 2026')}&am=${balance}.00&cu=INR&tn=${encodeURIComponent(note)}`;
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
    const payload = { amount: Number(reg.remaining), utr, screenshot, paymentMode: 'UPI' };
    const submit = async (acknowledged) => (await fetch('/api/registrations/topup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, acknowledged }),
    })).json();

    let data = await submit(false);
    if (data.needsConfirmation) {
      const c = data.checks || {};
      const problems = [];
      if (!c.amount) problems.push(`• The balance ₹${data.expectedAmount} could not be found in the screenshot`);
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
      if (!c.amount) problems.push(`• The amount ₹${data.expectedAmount} could not be found in the screenshot`);
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

async function handleAbstractSubmit(e) {
  e.preventDefault();
  const file = document.getElementById('abstract-pdf').files[0];
  if (!file) return showToast('Please attach your abstract PDF.');
  if (file.type !== 'application/pdf') return showToast('The abstract must be a PDF file.');

  const reader = new FileReader();
  reader.onload = async function (event) {
    const payload = {
      format: document.getElementById('abstract-format').value,
      title: document.getElementById('abstract-title').value,
      pdf: event.target.result
    };
    try {
      const res = await fetch('/api/abstracts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        showToast('Abstract submitted for review!', 'success');
        document.getElementById('abstract-pdf').value = '';
        closeModal('modal-abstract');
        loadDashboard();
      } else {
        showToast(data.error || 'Submission failed.');
      }
    } catch (err) {
      showToast(`Submission error: ${err.message}`);
    }
  };
  reader.readAsDataURL(file);
}

function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
  // Stop the PDF viewer from continuing to load/render in the background
  // once its modal is closed, and avoid a stale flash of the previous file
  // the next time it opens.
  if (id === 'modal-abstract-pdf') {
    const frame = document.getElementById('abstract-pdf-modal-frame');
    if (frame) frame.src = '';
    const actions = document.getElementById('abstract-pdf-modal-actions');
    if (actions) { actions.classList.add('hidden'); actions.classList.remove('flex'); }
  }
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

async function logout() {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
  currentDelegate = null;
  localStorage.removeItem('nqocn_current_user');
  // Full navigation so this works from both the delegate portal and /admin.
  window.location.href = '/';
}

// Restore an active server session on page load. The session cookie is the
// source of truth; localStorage only caches display fields.
async function restoreSession() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) {
      // The optimistic cached-dashboard shell above may already be showing
      // -- a stale/expired session must revert it back to the login page,
      // not just clear storage and leave the dashboard on screen.
      currentDelegate = null;
      persistDelegate(null);
      if (document.getElementById('dashboard-page')) navigateTo('auth-page');
      return;
    }
    const data = await res.json();
    if (data.success && data.user) {
      currentDelegate = data.user;
      persistDelegate(currentDelegate);
      loadDashboard();
    } else {
      currentDelegate = null;
      persistDelegate(null);
      if (document.getElementById('dashboard-page')) navigateTo('auth-page');
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
  ['payment-table-body', 'rejected-table-body', 'verified-table-body'].forEach((id) => {
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

  // Approve/Reject/Reset inside the PDF viewer modal -- id comes from the
  // container's data-id (set by openAbstractPdf), not the button itself.
  const abstractPdfActions = document.getElementById('abstract-pdf-modal-actions');
  if (abstractPdfActions) {
    abstractPdfActions.addEventListener('click', (e) => {
      const btn = e.target.closest('.abstract-status-btn');
      if (!btn) return;
      updateAbstractStatus(abstractPdfActions.dataset.id, btn.dataset.status);
      closeModal('modal-abstract-pdf');
    });
  }

  const programsBox = document.getElementById('programs-container');
  if (programsBox) {
    programsBox.addEventListener('click', (e) => {
      const save = e.target.closest('.prog-save');
      if (save) {
        const input = programsBox.querySelector(`.prog-capacity[data-id="${save.dataset.id}"]`);
        return saveProgramCapacity(save.dataset.id, parseInt(input.value, 10));
      }
      const toggle = e.target.closest('.prog-toggle');
      if (toggle) return toggleProgram(toggle.dataset.id, toggle.dataset.active === '1' ? 0 : 1);
      const del = e.target.closest('.prog-delete');
      if (del) return deleteProgram(del.dataset.id);
      const roster = e.target.closest('.prog-roster');
      if (roster) return openRosterModal(roster.dataset.id, roster.dataset.type, roster.dataset.name);
    });
  }

  const rosterList = document.getElementById('roster-list');
  if (rosterList) {
    rosterList.addEventListener('click', (e) => {
      const del = e.target.closest('.roster-remove');
      if (del) return handleRosterRemove(del.dataset.phone);
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

// One line of the screenshot OCR check result: 1 = match, 0 = mismatch,
// null/undefined = not checked (legacy rows).
// Rendered as a small chip rather than a plain colored line, so a row of
// checks reads at a glance (used both in the compact table cell and the
// larger review modal).
function ocrCheckLine(label, val) {
  if (val == null) {
    return `<span class="inline-flex items-center gap-1 text-[10px] font-semibold text-slate-500 bg-slate-100 border border-slate-200 rounded-full px-2 py-0.5">${esc(label)} <span class="opacity-70">·  not checked</span></span>`;
  }
  return Number(val) === 1
    ? `<span class="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">✓ ${esc(label)}</span>`
    : `<span class="inline-flex items-center gap-1 text-[10px] font-bold text-rose-700 bg-rose-50 border border-rose-300 rounded-full px-2 py-0.5">✗ ${esc(label)}</span>`;
}

// Format an epoch-ms audit timestamp for display; '' when absent.
function fmtAuditTime(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms));
  return isNaN(d) ? '' : d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

// Show only the nav tabs and default to the first section this admin's role
// is allowed to use.
function applyRoleVisibility(role) {
  const isSuper = role === 'SUPER_ADMIN';
  const isFinance = isSuper || role === 'FINANCE_ADMIN' || role === 'FINANCE_ACADEMIC';
  const isReviewer = isSuper || role === 'ACADEMIC_REVIEWER' || role === 'FINANCE_ACADEMIC';

  const tabPayments = document.getElementById('nav-tab-payments');
  const tabStatement = document.getElementById('nav-tab-statement');
  const tabAbstracts = document.getElementById('nav-tab-abstracts');
  const tabReports = document.getElementById('nav-tab-reports');
  if (tabPayments) tabPayments.classList.toggle('hidden', !isFinance);
  if (tabStatement) tabStatement.classList.toggle('hidden', !isFinance);
  if (tabAbstracts) tabAbstracts.classList.toggle('hidden', !isReviewer);
  if (tabReports) tabReports.classList.toggle('hidden', !(isFinance || isReviewer));

  // Masters/Users/Reminders/Logs live in the header's Settings menu, not
  // the main tab bar. The menu button itself only shows if at least one
  // item would.
  const settingsMenuBtn = document.getElementById('settings-menu-btn');
  const settingsMasters = document.getElementById('settings-item-masters');
  const settingsUsers = document.getElementById('settings-item-users');
  const settingsReminders = document.getElementById('settings-item-reminders');
  const settingsActivity = document.getElementById('settings-item-activity');
  if (settingsMasters) settingsMasters.classList.toggle('hidden', !isSuper);
  if (settingsUsers) settingsUsers.classList.toggle('hidden', !isSuper);
  if (settingsReminders) settingsReminders.classList.toggle('hidden', !isFinance);
  if (settingsActivity) settingsActivity.classList.toggle('hidden', !isSuper);
  if (settingsMenuBtn) settingsMenuBtn.classList.toggle('hidden', !(isSuper || isFinance));

  // Show only the report cards this role can access.
  const rd = document.getElementById('report-delegates');
  const rp = document.getElementById('report-payments');
  const rw = document.getElementById('report-workshops');
  const ra = document.getElementById('report-abstracts');
  if (rd) rd.classList.toggle('hidden', !isFinance);
  if (rp) rp.classList.toggle('hidden', !isFinance);
  if (rw) rw.classList.toggle('hidden', !isFinance);
  if (ra) ra.classList.toggle('hidden', !isReviewer);

  return { isSuper, isFinance, isReviewer };
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

  const { isSuper, isFinance, isReviewer } = applyRoleVisibility(activeAdminUser.role);

  // Land on the first section the role can actually use, and do it now --
  // before the awaited renders below, not after. Switching tabs here first
  // means an admin who clicks a different tab while data is still loading
  // stays where they clicked; switching again afterwards would silently
  // snap them back to this default tab once loading finished.
  const defaultTab = isFinance ? 'payments' : isReviewer ? 'abstracts' : 'programs';
  const loading = document.getElementById('admin-initial-loading');
  if (loading) loading.classList.add('hidden');
  switchBackendTab(defaultTab);

  // Render every section this role may see (this also fills the tab badges).
  if (isFinance) await renderBackendPayments();
  if (isFinance) renderDelegateMap();
  if (isReviewer) await renderBackendAbstracts();
  if (isSuper) await loadBackendUsers();
  if (isSuper) await renderBackendPrograms();
  if (isSuper) await renderBackendFees();
  if (isSuper) await renderDiscountCodes();
  if (isSuper) await renderBackendActivity();
  if (isFinance) await loadReportWorkshopOptions();
  if (isFinance) await renderBackendReminders(isSuper);
}

const PAYMENT_MODE_LABELS = { UPI: 'UPI', NEFT_RTGS: 'NEFT / RTGS' };

// Cached so the review modal can look a row up by id without a second fetch.
let cachedPaymentRegs = [];

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
  const statusLabel = p.bank_status === 'PARTIAL_PAYMENT' ? 'PARTIAL' : p.bank_status;
  const statusPill = `<span class="${statusTone} text-[10px] sm:text-xs px-2 sm:px-2.5 py-0.5 sm:py-1 rounded-full font-bold">${esc(statusLabel)}</span>`;
  // For a partial payment, surface how much is still owed at a glance.
  const balancePill = (p.remaining > 0 && p.verified_total > 0)
    ? `<span class="text-[10px] text-orange-700 font-semibold">₹${Number(p.verified_total)} of ₹${Number(p.expected_amount)} · ₹${Number(p.remaining)} due</span>`
    : '';
  // Link status is now per transaction: show "linked" only when every pending
  // payment has its own bank credit linked. Verified/rejected rows (no pending
  // transactions) don't show the pill.
  const pendingTxns = (p.transactions || []).filter((t) => t.txn_status === 'PENDING');
  const allPendingLinked = pendingTxns.length > 0 && pendingTxns.every((t) => t.bank_txn_id != null);
  const linkedPill = pendingTxns.length === 0 ? ''
    : `<span class="text-[10px] ${allPendingLinked ? 'text-emerald-600' : 'text-amber-600'} font-semibold">${allPendingLinked ? '🔗 Linked' : '⚠ Not linked'}</span>`;
  const idPill = STUDENT_CATEGORIES.includes(p.category_key)
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
          <p class="font-semibold text-slate-700 shrink-0">₹${Number(p.paid_amount)}</p>
        </div>
        <div class="flex flex-wrap items-center gap-1.5 mt-2">
          ${p.is_flagged ? `<span class="text-[10px] bg-red-100 text-red-700 px-2 py-0.5 rounded border border-red-200 font-bold uppercase tracking-wider">⚠️ Flagged</span>` : ''}
          ${statusPill}${balancePill}${rejectionNote}${linkedPill}${idPill}
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
        <span class="font-semibold text-slate-700">₹${Number(p.paid_amount)}</span>
      </td>
      <td class="p-4 hidden sm:table-cell">
        ${statusPill}
        ${balancePill ? `<br>${balancePill}` : ''}
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
  const needsDecision = allRegs.filter(r => r.bank_status === 'PENDING');
  const rejected = allRegs.filter(r => r.bank_status === 'REJECTED');
  // Partial payments awaiting the delegate's top-up: shown as a metric so
  // finance can see money still outstanding.
  const partialAwaiting = allRegs.filter(r => r.bank_status === 'PARTIAL_PAYMENT');
  const flagged = allRegs.filter(r => r.is_flagged);
  const totalCleared = verified.reduce((sum, r) => sum + (Number(r.verified_total) || 0), 0);
  setText('metric-total-amount', `₹${totalCleared}`);
  setText('metric-verified-count', verified.length);
  setText('metric-pending-count', needsDecision.length);
  setText('metric-flagged-count', flagged.length);
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

// Approximate lat/lng for the districts delegates have signed up from, plus
// state centroids as a fallback so a delegate from a district we don't have
// pinned still lands in roughly the right place. Districts are matched
// case-insensitively against users.district.
const DISTRICT_COORDS = {
  'wardha': [20.75, 78.60], 'yavatmal': [20.39, 78.13], 'nagpur': [21.15, 79.09],
  'mumbai': [19.08, 72.88], 'aurangabad': [19.88, 75.34], 'south west delhi': [28.60, 77.10],
  'central': [28.65, 77.23], 'raipur': [21.25, 81.63], 'hyderabad': [17.39, 78.49],
  'warangal': [17.97, 79.59], 'tiruvannamalai': [12.23, 79.07], 'tiruvallur': [13.14, 79.91],
  'raichur': [16.21, 77.36], 'pune': [18.52, 73.86], 'patna': [25.59, 85.14],
  'lucknow': [26.85, 80.95], 'kota': [25.18, 75.83], 'kolkata': [22.57, 88.36],
  'kolar': [13.14, 78.13], 'kanchipuram': [12.84, 79.70], 'jodhpur': [26.24, 73.02],
  'east godavari': [17.00, 81.78], 'bhandara': [21.17, 79.65], 'bangalore': [12.97, 77.59],
  'amravati': [20.93, 77.76], 'akola': [20.71, 77.00], 'ajmer': [26.45, 74.64],
  'ahmed nagar': [19.09, 74.75], 'nashik': [20.00, 73.79], 'thane': [19.22, 72.97],
  'nanded': [19.15, 77.32], 'chennai': [13.08, 80.27], 'jaipur': [26.91, 75.79],
  'bhopal': [23.26, 77.41], 'indore': [22.72, 75.86], 'chandrapur': [19.95, 79.30],
  'gadchiroli': [20.18, 80.00], 'gondia': [21.46, 80.20], 'buldhana': [20.53, 76.18],
  'jalna': [19.84, 75.88], 'parbhani': [19.27, 76.78], 'coimbatore': [11.02, 76.96],
};
const STATE_COORDS = {
  'maharashtra': [19.75, 75.71], 'delhi': [28.61, 77.21], 'chattisgarh': [21.28, 81.87],
  'chhattisgarh': [21.28, 81.87], 'telangana': [17.90, 79.60], 'tamil nadu': [11.10, 78.66],
  'karnataka': [15.32, 75.71], 'rajasthan': [26.60, 73.80], 'uttar pradesh': [26.85, 80.95],
  'bihar': [25.60, 85.10], 'west bengal': [22.99, 87.85], 'andhra pradesh': [15.90, 79.74],
  'gujarat': [22.70, 71.60], 'madhya pradesh': [23.50, 78.50], 'kerala': [10.50, 76.30],
  'punjab': [31.10, 75.30], 'haryana': [29.20, 76.30], 'odisha': [20.50, 84.90],
  'jharkhand': [23.60, 85.30], 'assam': [26.20, 92.90], 'uttarakhand': [30.00, 79.30],
  'himachal pradesh': [31.90, 77.20], 'jammu and kashmir': [33.80, 76.50], 'goa': [15.40, 74.00],
};

let delegateMapRendered = false;
async function renderDelegateMap() {
  if (delegateMapRendered) return; // static enough; render once per page load
  const host = document.getElementById('delegate-map');
  if (!host || typeof d3 === 'undefined' || typeof topojson === 'undefined') return;
  delegateMapRendered = true;

  const res = await fetch('/api/admin/delegate-locations');
  if (!res.ok) { delegateMapRendered = false; return; }
  const locations = (await res.json()).locations || [];

  // Resolve each district to coordinates (district first, then state).
  let unmapped = 0, totalReg = 0, totalSign = 0;
  const pts = [];
  locations.forEach((loc) => {
    const d = String(loc.district || '').toLowerCase().trim();
    const st = String(loc.state || '').toLowerCase().trim();
    const coord = DISTRICT_COORDS[d] || STATE_COORDS[st];
    totalReg += loc.registered; totalSign += loc.signedup;
    if (!coord) { unmapped += loc.registered + loc.signedup; return; }
    pts.push({ name: d.replace(/\b\w/g, (c) => c.toUpperCase()), lat: coord[0], lng: coord[1],
      reg: loc.registered, sign: loc.signedup, total: loc.registered + loc.signedup,
      host: d === 'wardha' });
  });

  setText('delegate-map-summary',
    `${totalReg} registered · ${totalSign} signed up only across ${locations.length} districts`
    + (unmapped ? ` (${unmapped} not shown — unmapped location)` : ''));

  const C_REG = '#008300', C_SIGN = '#eda100';
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
  const maxTotal = Math.max(1, ...pts.map((p) => p.total));
  const rScale = d3.scaleSqrt().domain([1, maxTotal]).range([5, 27]);
  const pie = d3.pie().sort(null).value((d) => d.v);

  // Self-hosted (public/data/india-states.topo.json) rather than an
  // external CDN -- dissolved from the official Survey of India district
  // shapefile (github.com/abhatia08/india_shp_2020), so it depicts India's
  // full claimed territory (all of Jammu & Kashmir and Ladakh as separate
  // states), and doesn't depend on a third party staying up.
  d3.json('/data/india-states.topo.json').then((topo) => {
    const feat = topojson.feature(topo, topo.objects.in_district);
    const proj = d3.geoMercator().fitExtent([[10, 10], [W - 10, H - 10]], feat);
    svg.append('g').selectAll('path').data(feat.features).join('path')
      .attr('d', d3.geoPath(proj)).attr('fill', '#f1efe8').attr('stroke', '#d3d1c7').attr('stroke-width', 0.5);

    const placed = pts.map((c) => ({ ...c, p: proj([c.lng, c.lat]) })).filter((c) => c.p).sort((a, b) => b.total - a.total);
    const g = svg.append('g').selectAll('g.city').data(placed).join('g')
      .attr('transform', (d) => `translate(${d.p[0]},${d.p[1]})`).style('cursor', 'pointer')
      .on('mousemove', (ev, d) => {
        const b = host.getBoundingClientRect();
        tip.style('opacity', 1).html(`<b>${esc(d.name)}</b><br>${d.reg} registered · ${d.sign} signed up`)
          .style('left', (ev.clientX - b.left + 12) + 'px').style('top', (ev.clientY - b.top - 6) + 'px');
      })
      .on('mouseleave', () => tip.style('opacity', 0));
    g.each(function (d) {
      const rad = rScale(d.total);
      const arc = d3.arc().innerRadius(0).outerRadius(rad);
      const slices = pie([{ k: 'reg', v: d.reg }, { k: 'sign', v: d.sign }].filter((s) => s.v > 0));
      d3.select(this).selectAll('path').data(slices).join('path')
        .attr('d', arc).attr('fill', (s) => s.data.k === 'reg' ? C_REG : C_SIGN).attr('fill-opacity', 0.85)
        .attr('stroke', '#fff').attr('stroke-width', slices.length > 1 ? 1 : 0);
      d3.select(this).append('circle').attr('r', rad).attr('fill', 'none')
        .attr('stroke', d.host ? '#ea580c' : '#fff').attr('stroke-width', d.host ? 2.5 : 0.8);
    });
    svg.append('g').selectAll('text').data(placed.filter((d) => d.total >= 3)).join('text')
      .attr('x', (d) => d.p[0]).attr('y', (d) => d.p[1] - rScale(d.total) - 3).attr('text-anchor', 'middle')
      .attr('font-size', '11px').attr('font-weight', '600').attr('fill', '#475569')
      .text((d) => `${d.name} (${d.total})`);
  }).catch(() => { setText('delegate-map-summary', 'Could not load the map.'); });
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
  setText('review-designation', p.delegate_designation || '—');
  setText('review-institute', p.delegate_institution || '—');
  setText('review-age', p.delegate_age != null && p.delegate_age !== '' ? p.delegate_age : '—');
  setText('review-gender', p.delegate_gender || '—');
  setText('review-mode', PAYMENT_MODE_LABELS[p.payment_mode] || p.payment_mode || 'UPI');
  setText('review-amount', `₹${Number(p.paid_amount)}` + (p.expected_amount != null && Number(p.paid_amount) !== Number(p.expected_amount) ? ` (expected ₹${Number(p.expected_amount)})` : ''));
  setText('review-utr', p.utr_number);
  setText('review-date', fmtAuditTime(p.submitted_at) || '—');

  const img = document.getElementById('review-screenshot');
  if (img) img.src = p.has_screenshot ? `/api/registrations/${encodeURIComponent(p.id)}/screenshot` : '';

  const checksBox = document.getElementById('review-checks');
  if (checksBox) {
    const lines = [ocrCheckLine('Amount', p.ocr_amount_match)];
    if (p.payment_mode !== 'NEFT_RTGS') lines.push(ocrCheckLine('UPI ID', p.ocr_vpa_match));
    lines.push(ocrCheckLine('UTR', p.ocr_utr_match));
    if (p.ocr_id_match != null) lines.push(ocrCheckLine('ID Card', p.ocr_id_match));
    checksBox.innerHTML = lines.join('');
  }

  const idWrap = document.getElementById('review-idcard-wrap');
  const idImg = document.getElementById('review-idcard');
  if (idWrap && idImg) {
    idWrap.classList.toggle('hidden', !p.has_id_card);
    idImg.src = p.has_id_card ? `/api/registrations/${encodeURIComponent(p.id)}/id-card` : '';
  }

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

  renderReviewIdVerification(p);
  // Bank reconciliation is now per transaction, inside the ledger
  // (renderReviewPaymentProgress); the old registration-level renderReviewTxnLink
  // is superseded and no longer called.
  renderReviewPaymentProgress(p);
  renderReviewCategoryLock(p);
  openModal('modal-review');
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
  const legacy = document.getElementById('review-legacy-link-section');
  if (legacy) legacy.classList.add('hidden'); // superseded by per-transaction linking
  const txns = p.transactions || [];
  reviewTxns = txns;
  reviewRegVerified = p.bank_status === 'BANK_VERIFIED';
  const fee = Number(p.expected_amount) || 0;
  const verifiedTotal = Number(p.verified_total) || 0;
  const remaining = Number(p.remaining != null ? p.remaining : Math.max(0, fee - verifiedTotal));

  if (wrap) wrap.classList.toggle('hidden', txns.length === 0);
  if (ledger && txns.length) {
    setText('review-progress-summary', `₹${verifiedTotal} / ₹${fee}${remaining > 0 ? ` · ₹${remaining} due` : ' · fully paid'}`);
    ledger.innerHTML = txns.map(reviewTxnRowHtml).join('');
  }

  // Verify gate: no unacknowledged (pending) payments may remain -- linking a
  // payment to its bank credit is what acknowledges it. Server also enforces
  // that the acknowledged total covers the fee.
  const pending = txns.filter((t) => t.txn_status === 'PENDING');
  reviewGate.linked = txns.length === 0 ? !!p.bank_txn_id : pending.length === 0;
  updateReviewAcceptGate();
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
  const linkLine = linked
    ? `<span class="text-emerald-700 font-semibold">🔗 ${esc(t.bank_txn_date || '')} · ₹${esc(t.bank_txn_credit != null ? t.bank_txn_credit : '')}</span>`
        + (reviewRegVerified ? '' : ` <button type="button" class="text-rose-600 hover:underline font-semibold ml-1" onclick="unlinkTxn(${esc(t.id)})">Unlink</button>`)
    : isRejected
      ? `<span class="text-slate-400">Rejected — not linked</span>`
      : `<span class="text-amber-700 font-semibold">⚠ Not acknowledged</span> <button type="button" class="text-indigo-600 hover:underline font-semibold ml-1" onclick="toggleTxnCandidates(${esc(t.id)})">Link &amp; acknowledge</button>`;
  return `<div class="border border-slate-200 rounded-lg p-2 bg-white">
    <div class="flex items-center justify-between">
      <span class="font-mono text-slate-500">${esc(t.utr_number || '—')}</span>
      <span class="flex items-center gap-2">
        <span class="font-semibold">₹${Number(amt)}</span>
        <span class="font-bold ${TONE[t.txn_status] || 'text-slate-500'}">${esc(t.txn_status)}</span>
      </span>
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
  box.innerHTML = rows.length ? rows.map((c) => `
    <div class="flex items-center justify-between gap-2 p-2 text-[10px]">
      <div class="min-w-0"><p class="font-semibold text-slate-700">${esc(c.post_date)} · ₹${esc(c.credit)}</p><p class="text-slate-500 truncate">${esc(c.description)}</p></div>
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

// Accept & Verify is gated on every applicable requirement being met: a
// linked bank transaction always, and (for student categories) an
// approver's confirmation that the ID card verifies that status. Each
// render function records its own reviewGate flag; this reconciles them.
const reviewGate = { linked: false, idOk: true };
function updateReviewAcceptGate() {
  const acceptBtn = document.getElementById('review-accept-btn');
  if (acceptBtn) acceptBtn.disabled = !(reviewGate.linked && reviewGate.idOk);
}

// Category list for the review modal's lock control, loaded once from the fee
// master and cached.
let reviewCategoryList = null;
async function ensureReviewCategories() {
  if (reviewCategoryList) return reviewCategoryList;
  try {
    const data = await (await fetch('/api/admin/fees')).json();
    reviewCategoryList = (data.categories || []).map((c) => ({ key: c.category_key, label: c.label }));
  } catch (e) { reviewCategoryList = []; }
  return reviewCategoryList;
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
}

async function reviewLockCategory() {
  const categoryKey = document.getElementById('review-category-select').value;
  if (!(await showConfirm('Lock this delegate into the selected category? The fee will be recalculated and the delegate can no longer change it.'))) return;
  const data = await (await fetch(`/api/registrations/${encodeURIComponent(reviewTargetId)}/lock-category`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ categoryKey }),
  })).json();
  if (!data.success) return showToast(data.error || 'Could not lock category.');
  showToast(`Category locked. Fee is now ₹${data.expectedAmount}${data.remaining > 0 ? `, ₹${data.remaining} balance due from the delegate.` : '.'}`, 'info');
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
// verifies that status before the registration can be verified -- the
// automated OCR check alone (shown among Automated Checks) is advisory.
function renderReviewIdVerification(p) {
  const wrap = document.getElementById('review-idverify-wrap');
  const checkbox = document.getElementById('review-idverify-checkbox');
  const note = document.getElementById('review-idverify-note');
  const isStudent = STUDENT_CATEGORIES.includes(p.category_key);

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

// Show whether this registration is linked to a statement transaction; if
// not, load candidates the admin can pick from manually. Verification is
// blocked (both by the server and by disabling this button) until linked.
function renderReviewTxnLink(p) {
  const linkedBox = document.getElementById('review-txn-linked');
  const unlinkedBox = document.getElementById('review-txn-unlinked');
  const isLinked = !!p.bank_txn_id;

  if (linkedBox) linkedBox.classList.toggle('hidden', !isLinked);
  if (unlinkedBox) unlinkedBox.classList.toggle('hidden', isLinked);
  reviewGate.linked = isLinked;
  updateReviewAcceptGate();

  if (isLinked) {
    setText('review-txn-details', `${esc(p.bank_txn_date || '')} · ₹${esc(p.bank_txn_credit)} · ${esc(p.bank_txn_description || '')}`);
    return;
  }
  loadReviewTxnCandidates(p.id);
}

async function loadReviewTxnCandidates(regId) {
  const box = document.getElementById('review-txn-candidates');
  if (!box) return;
  box.innerHTML = '<p class="text-xs text-slate-400 p-2">Loading candidates…</p>';
  const res = await fetch(`/api/registrations/${encodeURIComponent(regId)}/candidate-transactions`);
  if (!res.ok) { box.innerHTML = '<p class="text-xs text-rose-600 p-2">Could not load candidates.</p>'; return; }
  const data = await res.json();
  const txns = data.transactions || [];
  box.innerHTML = txns.length ? txns.map(t => `
    <div class="flex items-center justify-between gap-2 p-2 text-xs">
      <div class="min-w-0">
        <p class="font-semibold text-slate-700">${esc(t.post_date)} · ₹${esc(t.credit)}</p>
        <p class="text-slate-500 truncate">${esc(t.description)}</p>
      </div>
      <button type="button" class="review-txn-link-btn shrink-0 px-2.5 py-1 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg" data-txn-id="${esc(t.id)}">Link</button>
    </div>`).join('') : '<p class="text-xs text-slate-400 p-2">No unused credits in the statement yet.</p>';

  box.querySelectorAll('.review-txn-link-btn').forEach((btn) => {
    btn.addEventListener('click', () => reviewLinkTransaction(btn.dataset.txnId));
  });
}

async function reviewLinkTransaction(transactionId) {
  const data = await (await fetch(`/api/registrations/${encodeURIComponent(reviewTargetId)}/link-transaction`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transactionId }),
  })).json();
  if (!data.success) return showToast(data.error || 'Could not link this transaction.');
  await renderBackendPayments();
  openReviewModal(reviewTargetId); // re-open with fresh cached data to reflect the new link
}

async function reviewUnlinkTransaction() {
  if (!(await showConfirm('Unlink this transaction? You will need to link one before this can be verified.'))) return;
  const data = await (await fetch(`/api/registrations/${encodeURIComponent(reviewTargetId)}/link-transaction`, { method: 'DELETE' })).json();
  if (!data.success) return showToast(data.error || 'Could not unlink.');
  await renderBackendPayments();
  openReviewModal(reviewTargetId);
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

const REG_STATUS_STYLES = {
  BANK_VERIFIED: 'bg-emerald-100 text-emerald-800',
  PENDING: 'bg-amber-100 text-amber-800',
  REJECTED: 'bg-rose-100 text-rose-800',
};
const REG_STATUS_LABELS = { BANK_VERIFIED: 'Verified', PENDING: 'Pending', REJECTED: 'Rejected' };

// Cached so filtering/search re-renders instantly without a round-trip, and
// so the workshop/QI <select>s below have the full option list to draw from.
let cachedUsers = [];
let cachedAdminProgramOptions = [];

async function loadBackendUsers() {
  const [usersRes, optsRes] = await Promise.all([
    fetch('/api/users'),
    fetch('/api/admin/program-options'),
  ]);
  cachedUsers = ((await usersRes.json()).users) || [];
  cachedAdminProgramOptions = ((await optsRes.json()).options) || [];
  renderBackendUsers();
}

// Plain-text display of a delegate's current workshop/QI choice, plus a
// "Change" button (verified registrations only -- nothing to enroll into
// before payment is verified) that opens a confirm-before-save modal
// instead of an inline <select>. An inline select sitting in a dense table
// is an easy misclick/scroll-wheel-while-hovering away from silently
// changing someone's enrollment; routing every change through an explicit
// "Change" -> modal -> "Save" flow removes that.
const ROLE_ICONS = {
  SUPER_ADMIN: '👑',
  FINANCE_ADMIN: '💰',
  ACADEMIC_REVIEWER: '🎓',
  FINANCE_ACADEMIC: '💰🎓',
  DELEGATE: '🎫',
};

function programDisplayCell(u, options, currentId, type) {
  const current = options.find((o) => String(o.id) === String(currentId));
  const label = type === 'WORKSHOP' ? 'Workshop' : 'QI Exposure';
  const changeBtn = u.registration_status === 'BANK_VERIFIED'
    ? `<button type="button" class="block text-[10px] text-indigo-600 hover:text-indigo-800 underline font-semibold mt-0.5" onclick="openProgramChangeModal('${esc(u.phone_number)}','${type}')">${current ? 'Change' : 'Add'} ${label}</button>`
    : '';
  return `<span class="text-xs ${current ? 'text-slate-700 font-semibold' : 'text-slate-400'}">${current ? esc(current.name) : '—'}</span>${changeBtn}`;
}

function renderBackendUsers() {
  const tbody = document.getElementById('user-table-body');
  if (!tbody) return;

  const search = (document.getElementById('user-filter-search')?.value || '').trim().toLowerCase();
  const roleFilter = document.getElementById('user-filter-role')?.value || '';
  const statusFilter = document.getElementById('user-filter-status')?.value || '';

  const filtered = cachedUsers.filter((u) => {
    if (roleFilter && u.role !== roleFilter) return false;
    if (statusFilter) {
      const matches = statusFilter === 'NONE' ? !u.registration_status : u.registration_status === statusFilter;
      if (!matches) return false;
    }
    if (search) {
      const hay = [u.full_name, u.phone_number, u.designation, u.institution].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  setText('user-total-count', String(cachedUsers.length));
  setText('user-filter-count', String(filtered.length));
  setText('badge-user-count', String(cachedUsers.length));

  const workshopOptions = cachedAdminProgramOptions.filter((o) => o.type === 'WORKSHOP');
  const qiOptions = cachedAdminProgramOptions.filter((o) => o.type === 'QI');

  tbody.innerHTML = filtered.length ? filtered.map((u) => `
    <tr>
      <td class="p-4">
        <span class="inline-flex items-center justify-center w-6 h-6 mb-1 bg-indigo-100 rounded-full text-xs" title="${esc(roleLabel(u.role))}">${ROLE_ICONS[u.role] || '👤'}</span>
        <p class="font-bold">${u.salutation ? esc(u.salutation) + ' ' : ''}${esc(u.full_name)}</p>
        <span class="text-xs text-slate-400">+91 ${esc(u.phone_number)}</span>
      </td>
      <td class="p-4">${esc(u.designation)} (${esc(u.institution)})</td>
      <td class="p-4 font-mono text-xs">${esc(u.registration_number || '—')}</td>
      <td class="p-4">${u.registration_status
        ? `<span class="${REG_STATUS_STYLES[u.registration_status] || 'bg-slate-100 text-slate-600'} text-xs font-bold px-2 py-1 rounded-full">${esc(REG_STATUS_LABELS[u.registration_status] || u.registration_status)}</span>`
        : `<span class="text-xs text-slate-400">Not registered</span>`}</td>
      <td class="p-4">${programDisplayCell(u, workshopOptions, u.workshop_option_id, 'WORKSHOP')}</td>
      <td class="p-4">${programDisplayCell(u, qiOptions, u.qi_option_id, 'QI')}</td>
      <td class="p-4 text-right">
        <select class="role-select text-xs p-1 border rounded" data-phone="${esc(u.phone_number)}">
          <option value="DELEGATE" ${u.role === 'DELEGATE' ? 'selected' : ''}>Delegate</option>
          <option value="FINANCE_ADMIN" ${u.role === 'FINANCE_ADMIN' ? 'selected' : ''}>Finance Admin</option>
          <option value="ACADEMIC_REVIEWER" ${u.role === 'ACADEMIC_REVIEWER' ? 'selected' : ''}>Academic Reviewer</option>
          <option value="FINANCE_ACADEMIC" ${u.role === 'FINANCE_ACADEMIC' ? 'selected' : ''}>Finance &amp; Academic Reviewer</option>
          <option value="SUPER_ADMIN" ${u.role === 'SUPER_ADMIN' ? 'selected' : ''}>Super Admin</option>
        </select>
      </td>
    </tr>
  `).join('') : `<tr><td colspan="7" class="p-8 text-center text-sm text-slate-400">No users match these filters.</td></tr>`;
}

// State for the shared workshop/QI change modal -- one modal, reused for
// both program types and re-populated per delegate on open.
let programChangeState = { phone: null, type: null, currentId: null };

function openProgramChangeModal(phone, type) {
  const u = cachedUsers.find((x) => x.phone_number === phone);
  if (!u) return;
  const currentId = type === 'WORKSHOP' ? u.workshop_option_id : u.qi_option_id;
  const options = cachedAdminProgramOptions.filter((o) => o.type === type);
  programChangeState = { phone, type, currentId };

  setText('program-change-title', type === 'WORKSHOP' ? 'Change Workshop' : 'Change QI Exposure');
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
}

async function updateRole(phone, role) {
  await fetch(`/api/users/${encodeURIComponent(phone)}/role`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role })
  });
  await loadBackendUsers();
}

// --- WORKSHOPS & QI PRACTICES (admin) ---
async function renderBackendPrograms() {
  const res = await fetch('/api/admin/program-options');
  const container = document.getElementById('programs-container');
  if (!container) return;
  if (!res.ok) {
    container.innerHTML = '<p class="text-sm text-slate-500 p-4">Unable to load programs.</p>';
    return;
  }
  const options = (await res.json()).options || [];
  setText('badge-program-count', options.length);

  const groupHtml = (type, title) => {
    const rows = options.filter(o => o.type === type).map(o => {
      const remaining = Math.max(0, o.capacity - o.enrolled);
      return `
      <div class="flex flex-wrap items-center gap-3 py-3 border-b border-slate-100 ${o.active ? '' : 'opacity-60'}">
        <div class="flex-1 min-w-[180px]">
          <p class="font-semibold text-sm text-slate-800">${esc(o.name)}</p>
          <p class="text-[11px] text-slate-500">Enrolled ${Number(o.enrolled)} / ${Number(o.capacity)} · ${remaining} left${o.active ? '' : ' · inactive'}</p>
        </div>
        <input type="number" min="0" value="${esc(o.capacity)}" class="prog-capacity w-20 p-1.5 border rounded text-sm" data-id="${esc(o.id)}">
        <button class="prog-save px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg" data-id="${esc(o.id)}">Save</button>
        <button class="prog-roster px-3 py-1.5 bg-slate-700 hover:bg-slate-800 text-white text-xs font-semibold rounded-lg" data-id="${esc(o.id)}" data-type="${esc(o.type)}" data-name="${esc(o.name)}">Roster</button>
        <button class="prog-toggle px-3 py-1.5 ${o.active ? 'bg-amber-500 hover:bg-amber-600' : 'bg-emerald-600 hover:bg-emerald-700'} text-white text-xs font-semibold rounded-lg" data-id="${esc(o.id)}" data-active="${o.active ? 1 : 0}">${o.active ? 'Deactivate' : 'Activate'}</button>
        <button class="prog-delete px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold rounded-lg" data-id="${esc(o.id)}">Delete</button>
      </div>`;
    }).join('') || '<p class="text-sm text-slate-400 py-2">None yet.</p>';
    return `<div class="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm">
        <h3 class="text-sm font-bold text-slate-800 uppercase tracking-wide mb-2">${esc(title)}</h3>${rows}</div>`;
  };

  container.innerHTML = groupHtml('WORKSHOP', 'Workshops') + groupHtml('QI', 'QI Practices');
}

async function handleAddProgram(e) {
  e.preventDefault();
  const payload = {
    type: document.getElementById('new-program-type').value,
    name: document.getElementById('new-program-name').value,
    capacity: parseInt(document.getElementById('new-program-capacity').value, 10),
  };
  const data = await (await fetch('/api/admin/program-options', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  })).json();
  if (!data.success) return showToast(data.error || 'Could not add option.');
  document.getElementById('new-program-name').value = '';
  renderBackendPrograms();
}

async function saveProgramCapacity(id, capacity) {
  const data = await (await fetch(`/api/admin/program-options/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ capacity }),
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

// --- WORKSHOP / QI ROSTER (manual admin add/remove) ---
let rosterOptionId = null;
let rosterEnrolledPhones = new Set();

async function openRosterModal(id, type, name) {
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
      <div class="flex items-center justify-between py-2">
        <div>
          <p class="font-semibold text-slate-800">${esc(r.delegate_name)}</p>
          <p class="text-[11px] text-slate-500">+91 ${esc(r.phone_number)} · ${esc(r.registration_number || '—')}</p>
        </div>
        <button class="roster-remove px-2.5 py-1 bg-white border border-rose-300 text-rose-700 hover:bg-rose-50 text-xs font-semibold rounded-lg" data-phone="${esc(r.phone_number)}">Remove</button>
      </div>`).join('')
    : '<p class="text-xs text-slate-400 py-3">Nobody enrolled yet.</p>';
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
        <p class="text-[11px] text-slate-500">+91 ${esc(r.phone_number)} · ${esc(r.registration_number || '—')}${r.category_label ? ' · ' + esc(r.category_label) : ''}</p>
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
  const res = await fetch('/api/admin/fees');
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
  BANK_TXN_LINK: 'Linked', BANK_TXN_UNLINK: 'Unlinked', ABSTRACT_STATUS_CHANGE: 'Status', ABSTRACT_ALLOCATION: 'Allotted',
  PROGRAM_OPTION_CREATE: 'Created', PROGRAM_OPTION_UPDATE: 'Updated', PROGRAM_OPTION_DELETE: 'Deleted',
  FEE_CONFIG_UPDATE: 'Dates Updated', FEE_CATEGORY_CREATE: 'Created', FEE_CATEGORY_UPDATE: 'Updated', FEE_CATEGORY_DELETE: 'Deleted',
};
function activityActionPill(action) {
  const label = ACTIVITY_ACTION_LABELS[action] || action;
  let tone = 'muted';
  if (action === 'BANK_STATUS_CHANGE') tone = 'info';
  else if (action === 'STUDENT_ID_VERIFICATION' || action === 'BANK_TXN_LINK' || action === 'PROGRAM_OPTION_CREATE' || action === 'FEE_CATEGORY_CREATE') tone = 'ok';
  else if (action === 'ADMIN_UNENROLL' || action === 'BANK_TXN_UNLINK' || action.endsWith('_DELETE')) tone = 'bad';
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
      <td class="py-3 px-4 font-semibold">₹${esc(r.total_credit ?? 0)}</td>
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

  const areaLabels = { program_option: 'Workshop / QI', fee_config: 'Fee Dates', fee_category: 'Fee Category' };
  setText('activity-count-master', String((data.master || []).length));
  document.getElementById('activity-master-body').innerHTML = (data.master || []).map((r) => `
    <tr>
      <td class="py-3 px-4 whitespace-nowrap text-slate-500">${fmtAuditTime(r.created_at)}</td>
      <td class="py-3 px-4">${activityPill(areaLabels[r.entity_type] || r.entity_type, 'info')} ${activityActionPill(r.action)}</td>
      <td class="py-3 px-4">${activityTransition(r.old_value, r.new_value)}</td>
      <td class="py-3 px-4">${esc(r.actor_name)}</td>
    </tr>`).join('') || `<tr><td colspan="4" class="py-6 text-center text-slate-400">No master-data edits logged yet</td></tr>`;

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
  };
  const data = await (await fetch('/api/admin/fees/categories', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  })).json();
  if (!data.success) return showToast(data.error || 'Could not add category.');
  document.getElementById('new-fee-key').value = '';
  document.getElementById('new-fee-label').value = '';
  document.getElementById('new-fee-subtitle').value = '';
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
    })
  })).json();
  if (!data.success) showToast(data.error || 'Update failed.');
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
  renderBackendFees();
}

// --- DISCOUNT CODES (admin) ---
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
  const matches = (cachedUsers || [])
    .filter((u) => `${u.full_name || ''} ${u.phone_number || ''} ${u.registration_number || ''}`.toLowerCase().includes(q))
    .slice(0, 8);
  box.innerHTML = matches.length
    ? matches.map((u) => `<button type="button" class="w-full text-left px-3 py-2 hover:bg-indigo-50" onclick="pickDiscDelegate('${esc(u.phone_number)}', '${esc((u.full_name || '').replace(/'/g, "\\'"))}')">
        <p class="font-semibold text-slate-800 text-sm">${esc(u.full_name || '—')}</p>
        <p class="text-[11px] text-slate-500">+91 ${esc(u.phone_number)}${u.registration_number ? ' · ' + esc(u.registration_number) : ''}</p>
      </button>`).join('')
    : '<p class="text-xs text-slate-400 p-3">No matching delegate.</p>';
  box.classList.remove('hidden');
}

function pickDiscDelegate(phone, name) {
  document.getElementById('new-disc-scope-phone').value = phone;
  document.getElementById('new-disc-delegate-search').value = name || phone;
  document.getElementById('new-disc-delegate-results').classList.add('hidden');
  const sel = document.getElementById('new-disc-delegate-selected');
  sel.textContent = `✓ ${name || ''} (+91 ${phone})`;
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
  const catLabel = (key) => (cats.find((c) => c.key === key) || {}).label || key;
  tbody.innerHTML = codes.length ? codes.map((c) => {
    const disc = c.discount_type === 'PERCENT' ? `${Number(c.discount_value)}%` : `₹${Number(c.discount_value)}`;
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
        <button onclick="toggleDiscountCode(${esc(c.id)}, ${c.active ? 0 : 1})" class="px-3 py-1.5 ${c.active ? 'bg-amber-500 hover:bg-amber-600' : 'bg-emerald-600 hover:bg-emerald-700'} text-white text-xs font-semibold rounded-lg">${c.active ? 'Deactivate' : 'Activate'}</button>
        <button onclick="deleteDiscountCode(${esc(c.id)})" class="px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold rounded-lg">Delete</button>
      </td>
    </tr>`;
  }).join('') : `<tr><td colspan="6" class="p-6 text-center text-slate-400">No discount codes yet.</td></tr>`;
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
    ? `<option value="">Select a workshop or QI practice…</option>` +
      options.map((o) => `<option value="${esc(o.id)}">${o.type === 'QI' ? 'QI: ' : 'Workshop: '}${esc(o.name)}</option>`).join('')
    : '<option value="">No workshops or QI practices set up yet</option>';
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

const REMINDER_DEFAULT_BODY = `<p>Dear {{name}},</p>
<p>Thanks for signing up for the International Conference on Healthcare Quality &amp; Patient Safety 2026 (21&ndash;22 November 2026, MGIMS, Sevagram, Wardha). We noticed your registration isn't complete yet &mdash; your account is set up, but we haven't received your payment details.</p>
<p>Completing your registration only takes a couple of minutes.</p>
<p style="text-align:center;margin:1.5rem 0">
  <a href="https://registration.mgims.ac.in" style="background:#4f46e5;color:#fff;padding:.75rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">Complete My Registration</a>
</p>
<p>If you've already registered, please disregard this email.</p>`;

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
  if (bodyBox && !bodyBox.value.trim()) bodyBox.value = REMINDER_DEFAULT_BODY;

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
      return `<span class="font-semibold text-slate-700">₹${esc(val)}</span>`;
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
          ${amountVal != null && amountVal !== '' ? `<span class="font-semibold text-slate-700 text-sm">₹${esc(amountVal)}</span>` : ''}
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
          ${a.last_action_by
            ? `<p class="text-[10px] text-slate-400 mt-1">by ${esc(a.last_action_by)} · ${esc(fmtAuditTime(a.last_action_at))}</p>`
            : ''
          }
        </div>
      </div>
      <div class="mt-3">
        ${a.abstract_file
          ? `<button type="button" onclick="openAbstractPdf(${esc(a.id)}, '${esc(a.title).replace(/'/g, "\\'")}')" class="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg text-xs">Review</button>`
          : a.text
            ? `<p class="text-sm text-slate-600 whitespace-pre-wrap">${esc(a.text)}</p>`
            : `<span class="text-xs text-slate-400">No file</span>`
        }
      </div>`;
}

// Show an abstract's PDF in an inline modal instead of opening/downloading it
// in a new tab. Approve/Reject/Reset live in the modal footer (rather than
// on the card) for abstracts that have a file, so a reviewer decides while
// actually looking at the PDF; the data-id is set here so the delegated
// click handler on #abstract-pdf-modal-actions knows which abstract to act on.
function openAbstractPdf(id, title) {
  const frame = document.getElementById('abstract-pdf-modal-frame');
  const titleEl = document.getElementById('abstract-pdf-modal-title');
  const actions = document.getElementById('abstract-pdf-modal-actions');
  if (!frame) return;
  frame.src = `/api/abstracts/${encodeURIComponent(id)}/file`;
  if (titleEl) titleEl.innerText = title || 'Abstract PDF';
  if (actions) {
    actions.dataset.id = id;
    actions.classList.remove('hidden');
    actions.classList.add('flex');
  }
  openModal('modal-abstract-pdf');
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
  const underReview = abstracts.filter(a => (a.status || 'UNDER_REVIEW') === 'UNDER_REVIEW');
  setText('badge-pending-abstracts', underReview.length);

  if (!abstracts.length) {
    approvalBox.innerHTML = `<p class="text-sm text-slate-500 p-4">No abstracts submitted yet.</p>`;
    assignBox.innerHTML = '';
    return;
  }

  // Step 1: Approval -- accept/reject/reset. Abstracts with a PDF make that
  // decision from inside the PDF viewer modal instead (see openAbstractPdf),
  // so a reviewer decides while actually looking at the file; text-only
  // abstracts have no PDF to view, so they keep the buttons on the card.
  approvalBox.innerHTML = abstracts.map(a => `
    <div class="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm">
      ${abstractCardHeader(a)}
      ${a.abstract_file ? '' : `
      <div class="flex flex-wrap gap-2 mt-4">
        <button class="abstract-status-btn px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-lg text-xs" data-id="${esc(a.id)}" data-status="ACCEPTED">Approve</button>
        <button class="abstract-status-btn px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white font-semibold rounded-lg text-xs" data-id="${esc(a.id)}" data-status="REJECTED">Reject</button>
        <button class="abstract-status-btn px-3 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 font-semibold rounded-lg text-xs" data-id="${esc(a.id)}" data-status="UNDER_REVIEW">Reset</button>
      </div>`}
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

function openCreateUserModal() { openModal('modal-create-user'); }

async function handleCreateUserSubmit(e) {
  e.preventDefault();
  const payload = {
    name: document.getElementById('new-user-name').value,
    phone: document.getElementById('new-user-phone').value,
    designation: document.getElementById('new-user-designation').value,
    institute: document.getElementById('new-user-institute').value,
    role: document.getElementById('new-user-role').value
  };

  await fetch('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  closeModal('modal-create-user');
  initBackendPortal();
}

// "Masters" groups Workshops & QI / Fees / Users under one nav entry with an
// inner sub-nav; the wrapper is shown whenever one of those sub-tabs is
// active, and remembers the last one visited so the top-level Masters button
// can jump back into it.
// Activity Log shows one category at a time, picked from its own submenu
// (separate from the main Masters sub-tabs above).
const ACTIVITY_SUBTABS = ['imports', 'mapping', 'approval', 'abstract-approval', 'abstract-allotment', 'master'];
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

const MASTERS_SUBTABS = ['programs', 'fees'];
let lastMastersTab = 'programs';

function switchBackendTab(tab) {
  ['payments', 'statement', 'abstracts', 'programs', 'fees', 'reports', 'reminders', 'activity', 'users'].forEach(t => {
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

  // Highlight whichever Settings-menu item (Masters/Users/Reminders/Logs)
  // is currently selected, since those tabs no longer live in the main bar.
  ['masters', 'users', 'reminders', 'activity'].forEach((key) => {
    const item = document.getElementById(`settings-item-${key}`);
    if (!item) return;
    const active = key === 'masters' ? MASTERS_SUBTABS.includes(tab) : key === tab;
    item.classList.toggle('bg-indigo-50', active);
    item.classList.toggle('text-indigo-700', active);
  });

  const inMasters = MASTERS_SUBTABS.includes(tab);
  const mastersWrap = document.getElementById('section-masters-wrapper');
  if (mastersWrap) mastersWrap.classList.toggle('hidden', !inMasters);
  if (inMasters) {
    lastMastersTab = tab;
    MASTERS_SUBTABS.forEach((t) => {
      const sb = document.getElementById(`subnav-${t}`);
      if (!sb) return;
      const active = t === tab;
      sb.classList.toggle('bg-indigo-600', active);
      sb.classList.toggle('text-white', active);
      sb.classList.toggle('bg-slate-100', !active);
      sb.classList.toggle('text-slate-600', !active);
    });
  }

  if (tab === 'statement') loadReconciliation();
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

async function loadReconciliation() {
  const res = await fetch('/api/admin/bank-statement/reconcile');
  if (!res.ok) return;
  const data = await res.json();

  setText('rec-metric-total', data.summary.registrations);
  setText('rec-metric-matched', data.summary.matched);
  setText('rec-metric-unmatched', data.summary.unmatched);
  setText('rec-metric-credits', data.summary.unmatchedCredits);

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
            <p class="font-semibold text-slate-700 shrink-0">₹${esc(r.paid_amount != null ? r.paid_amount : r.expected_amount)}</p>
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
        <td class="p-3 hidden sm:table-cell">₹${esc(r.paid_amount != null ? r.paid_amount : r.expected_amount)}</td>
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
            <p class="font-semibold text-amber-700 shrink-0">₹${esc(t.credit)}</p>
          </div>
        </td>
        <td class="p-3 hidden sm:table-cell">${esc(t.post_date)}</td>
        <td class="p-3 hidden sm:table-cell">${esc(t.description)}</td>
        <td class="p-3 font-semibold hidden sm:table-cell">₹${esc(t.credit)}</td>
      </tr>`).join('') : `<tr><td colspan="3" class="p-4 text-center text-slate-400 text-xs">No unmatched credits.</td></tr>`;
  }

  const matchedBody = document.getElementById('rec-matched-body');
  if (matchedBody) {
    matchedBody.innerHTML = data.matched.length ? data.matched.map(m => `
      <tr class="${m.amountOk ? '' : 'bg-rose-50/50'}">
        <td class="p-3 block sm:hidden">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="font-bold text-sm truncate">${esc(m.delegate_name)}</p>
              <p class="text-[11px] font-mono text-slate-400 truncate">${esc(m.registration_number || '—')} · ${esc(m.utr_number)}</p>
            </div>
            <div class="text-right shrink-0">
              <p class="font-semibold text-slate-700">₹${esc(m.transaction.credit)}</p>
              <p class="text-[10px] text-slate-400">${esc(m.transaction.post_date)}</p>
            </div>
          </div>
          ${m.amountOk ? '' : `<p class="text-[11px] text-rose-600 font-bold mt-1">≠ claimed ₹${esc(m.paid_amount != null ? m.paid_amount : m.expected_amount)}</p>`}
        </td>
        <td class="p-3 font-mono text-xs hidden sm:table-cell">${esc(m.registration_number || '—')}</td>
        <td class="p-3 hidden sm:table-cell">${esc(m.delegate_name)}</td>
        <td class="p-3 font-mono text-xs hidden sm:table-cell">${esc(m.utr_number)}</td>
        <td class="p-3 hidden sm:table-cell">${esc(m.transaction.post_date)}</td>
        <td class="p-3 hidden sm:table-cell">₹${esc(m.transaction.credit)}${m.amountOk ? '' : ` <span class="text-rose-600 font-bold">≠ claimed ₹${esc(m.paid_amount != null ? m.paid_amount : m.expected_amount)}</span>`}</td>
      </tr>`).join('') : `<tr><td colspan="5" class="p-4 text-center text-slate-400 text-xs">No matches yet — upload a statement above.</td></tr>`;
  }
}
