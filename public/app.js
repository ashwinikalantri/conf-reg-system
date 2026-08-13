const OFFICIAL_UPI_ID = "abhishekraut@cbin";
<!-- const OFFICIAL_UPI_ID = "nqocn2026@cbin"-->

// Categories that must upload a student ID card (kept in sync with the server).
const STUDENT_CATEGORIES = ['nursing_ug', 'nursing_pg', 'med_student', 'pg_doctor'];

const REJECTION_LABELS = {
  PAYMENT: 'Payment discrepancy',
  ID: 'ID discrepancy',
  OTHER: 'Other',
};

let currentDelegate = JSON.parse(localStorage.getItem('nqocn_current_user')) || null;
let activeAdminUser = null;

// Read a File into a base64 data URL.
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = (e) => resolve(e.target.result);
    r.onerror = () => reject(new Error('Could not read file.'));
    r.readAsDataURL(file);
  });
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

// Show the admin backend link only to a logged-in admin on the dashboard.
// When it is hidden (login/signup/landing) the NQOCN pill is centred.
function updateAdminNav(show) {
  const btn = document.getElementById('admin-nav-btn');
  if (btn) btn.classList.toggle('hidden', !show);
  const header = document.getElementById('top-header');
  if (header) {
    header.classList.toggle('justify-between', show);
    header.classList.toggle('justify-center', !show);
  }
}

// --- NAVIGATION & UI TOGGLES ---
function navigateTo(pageId) {
  document.querySelectorAll('main, section').forEach(el => el.classList.add('hidden'));
  const target = document.getElementById(pageId);
  if (target) target.classList.remove('hidden');
  // The backend button is only for admins on the dashboard; hide it elsewhere.
  updateAdminNav(pageId === 'dashboard-page' && isAdminUser());
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
    return alert("Please enter a valid 10-digit Indian Mobile Number.");
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
      alert(`OTP sent to +91 ${phone}.\nYour 6-Digit OTP is: ${data.devOtp}`);
    } else {
      document.getElementById(`${context}-otp-hint`).innerText = 'Sent via SMS';
      alert(`A 6-digit OTP has been sent to +91 ${phone}.`);
    }
  } else {
    alert(data.error || 'Could not send OTP. Please try again.');
  }
}

async function handleRegistration(e) {
  e.preventDefault();
  const phone = document.getElementById('reg-phone').value.trim();
  const otp = document.getElementById('reg-otp').value.trim();

  const payload = {
    phone,
    otp,
    name: document.getElementById('reg-name').value,
    age: document.getElementById('reg-age').value,
    gender: document.getElementById('reg-gender').value,
    designation: document.getElementById('reg-designation').value,
    institute: document.getElementById('reg-institute').value,
    email: document.getElementById('reg-email').value,
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
    localStorage.setItem('nqocn_current_user', JSON.stringify(currentDelegate));
    alert("Mobile OTP Verified! Account registered.");
    loadDashboard();
  } else {
    alert(data.error || "Registration failed.");
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
    localStorage.setItem('nqocn_current_user', JSON.stringify(currentDelegate));
    alert(`Welcome back, ${currentDelegate.full_name || currentDelegate.name}!`);
    loadDashboard();
  } else if (data.notRegistered) {
    // New number — switch to sign-up, carrying the phone and (still-valid) OTP.
    toggleAuth('register');
    document.getElementById('reg-phone').value = phone;
    document.getElementById('reg-otp-container').classList.remove('hidden');
    document.getElementById('reg-otp').value = otp;
    document.getElementById('reg-otp-hint').innerText = otp ? 'OTP carried over' : '';
    alert("This number isn't registered yet — please complete the sign-up form to create your account.");
  } else {
    alert(data.error || "Login failed.");
  }
}

// --- DELEGATE DASHBOARD & FEATURES ---
async function loadDashboard() {
  if (!currentDelegate) return navigateTo('auth-page');

  document.getElementById('user-display-name').innerText = currentDelegate.full_name || currentDelegate.name;
  document.getElementById('user-display-sub').innerText = `${currentDelegate.designation} | ${currentDelegate.institution || currentDelegate.institute} (+91 ${currentDelegate.phone_number || currentDelegate.phone})`;

  const statusTag = document.getElementById('payment-status-tag');
  const confBtn = document.getElementById('register-conf-btn');
  const reverifyBanner = document.getElementById('reverify-banner');
  const confirmedBlock = document.getElementById('confirmed-block');

  const regRes = await fetch('/api/registrations/me');
  const regData = await regRes.json();
  const reg = regData.registration;

  // Registration number, receipt, and the chosen workshop / QI practice are
  // revealed only once the payment is verified. The register/edit action and
  // the pending note are hidden in that state.
  const verified = reg && reg.bank_status === 'BANK_VERIFIED';
  const actionArea = document.getElementById('payment-action-area');
  const paymentDesc = document.getElementById('payment-desc');
  if (confirmedBlock) confirmedBlock.classList.toggle('hidden', !verified);
  if (actionArea) actionArea.classList.toggle('hidden', verified);
  if (paymentDesc) paymentDesc.classList.toggle('hidden', verified);
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
    // Rejected: show the reason and the action the delegate should take.
    statusTag.className = "text-xs bg-rose-100 text-rose-800 font-bold px-3 py-1 rounded-full border border-rose-300";
    statusTag.innerText = "Registration Rejected";
    confBtn.innerText = "Update & Resubmit";

    let msg, label;
    if (reg.rejection_reason === 'PAYMENT') {
      msg = 'Your payment was rejected due to a discrepancy. Please resubmit your correct payment details and screenshot.';
      label = 'Resubmit Payment';
    } else if (reg.rejection_reason === 'ID') {
      msg = 'Your ID could not be verified for the selected category. Please change your category or re-upload the correct student ID card.';
      label = 'Update Category / ID';
    } else {
      msg = 'Your registration was rejected' + (reg.rejection_note ? `: ${reg.rejection_note}` : '.') + ' Please review and resubmit.';
      label = 'Update Registration';
    }
    document.getElementById('reverify-msg').innerText = msg;
    document.getElementById('reverify-btn').innerText = label;
    reverifyBanner.classList.remove('hidden');
  } else {
    // Pending manual verification (possibly flagged — no delegate action needed).
    statusTag.className = "text-xs bg-amber-100 text-amber-800 font-bold px-3 py-1 rounded-full border border-amber-300";
    statusTag.innerText = reg.is_flagged ? "Flagged - Awaiting Manual Audit" : "Registration Pending (Awaiting Verification)";
    confBtn.innerText = "Edit Submitted Payment";
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

function calculateFee() {
  const catKey = document.getElementById('payment-category').value;

  // Student categories must upload an ID card.
  const idBlock = document.getElementById('id-card-block');
  if (idBlock) idBlock.classList.toggle('hidden', !STUDENT_CATEGORIES.includes(catKey));

  if (!catKey) return;

  const currentFee = (feeCategories[catKey] || {}).fee || 0;
  document.getElementById('calculated-fee-display').innerText = `₹${currentFee}`;
  document.getElementById('entered-amount').value = currentFee;

  // Reference is the delegate's registration number (assigned at signup).
  const ref = (currentDelegate && (currentDelegate.registration_number || currentDelegate.phone_number || currentDelegate.phone)) || '';
  const upiUri = `upi://pay?pa=${OFFICIAL_UPI_ID}&pn=${encodeURIComponent('NQOCN 2026')}&am=${currentFee}.00&cu=INR&tn=${encodeURIComponent(ref)}`;
  document.getElementById('upi-qr-image').src = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(upiUri)}`;
  const payLink = document.getElementById('upi-pay-link');
  if (payLink) payLink.href = upiUri;
  document.getElementById('qr-container').classList.remove('hidden');
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
        (data.categories || []).map((c) => `<option value="${esc(c.key)}">${esc(c.label)} — ₹${Number(c.fee)}</option>`).join('');
      if (current) sel.value = current;
    }
  } catch (e) {
    /* keep any hardcoded fallback options */
  }
}

// Refresh capacity + fees then open the payment modal.
async function openPaymentModal() {
  await Promise.all([loadProgramOptions(), loadFees()]);
  openModal('modal-conference');
}

// --- PAYMENT SUBMISSION ---
async function verifyAndSubmitPayment(e) {
  e.preventDefault();

  const categoryKey = document.getElementById('payment-category').value;
  const isStudent = STUDENT_CATEGORIES.includes(categoryKey);

  const file = document.getElementById('payment-screenshot').files[0];
  if (!file) return alert('Please upload your payment screenshot.');

  const idFile = document.getElementById('payment-id-card').files[0];
  if (isStudent && !idFile) return alert('Please upload your student ID card for this category.');

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
      alert(data.flagged
        ? "Submission received and FLAGGED for manual scrutiny (some details could not be auto-verified)."
        : "Registration submitted successfully! It is PENDING manual verification."
      );
      closeModal('modal-conference');
      loadDashboard();
    } else {
      alert(data.error || 'Submission failed.');
    }
  } catch (err) {
    console.error('Payment Submission Error:', err);
    alert(`Submission Error: ${err.message}`);
  } finally {
    submitBtn.innerText = originalBtnText;
    submitBtn.disabled = false;
  }
}

async function handleAbstractSubmit(e) {
  e.preventDefault();
  const file = document.getElementById('abstract-pdf').files[0];
  if (!file) return alert('Please attach your abstract PDF.');
  if (file.type !== 'application/pdf') return alert('The abstract must be a PDF file.');

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
        alert('Abstract submitted for review!');
        document.getElementById('abstract-pdf').value = '';
        closeModal('modal-abstract');
        loadDashboard();
      } else {
        alert(data.error || 'Submission failed.');
      }
    } catch (err) {
      alert(`Submission error: ${err.message}`);
    }
  };
  reader.readAsDataURL(file);
}

function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

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
  if (sel) sel.value = 'PAYMENT';
  if (note) note.value = '';
  toggleRejectNote();
  openModal('modal-reject');
}
function toggleRejectNote() {
  const sel = document.getElementById('reject-reason');
  const wrap = document.getElementById('reject-note-wrap');
  if (sel && wrap) wrap.classList.toggle('hidden', sel.value !== 'OTHER');
}
async function submitReject() {
  const reason = document.getElementById('reject-reason').value;
  const note = document.getElementById('reject-note').value.trim();
  if (reason === 'OTHER' && !note) return alert('Please describe the reason.');
  const data = await (await fetch(`/api/registrations/${encodeURIComponent(rejectTargetId)}/status`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bankStatus: 'REJECTED', rejectionReason: reason, rejectionNote: note })
  })).json();
  if (!data.success) return alert(data.error || 'Rejection failed.');
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
      localStorage.removeItem('nqocn_current_user');
      return;
    }
    const data = await res.json();
    if (data.success && data.user) {
      currentDelegate = data.user;
      localStorage.setItem('nqocn_current_user', JSON.stringify(currentDelegate));
      loadDashboard();
    }
  } catch (e) {
    /* offline — stay on the landing page */
  }
}

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

  const paymentBody = document.getElementById('payment-table-body');
  if (paymentBody) {
    paymentBody.addEventListener('click', (e) => {
      const review = e.target.closest('.review-btn');
      if (review) return openReviewModal(review.dataset.id);
      const view = e.target.closest('.view-image-btn');
      if (view) return openScreenshot(view.dataset.id);
      const viewId = e.target.closest('.view-id-btn');
      if (viewId) return openIdCard(viewId.dataset.id);
    });
  }

  const userBody = document.getElementById('user-table-body');
  if (userBody) {
    userBody.addEventListener('change', (e) => {
      const sel = e.target.closest('.role-select');
      if (sel) updateRole(sel.dataset.phone, sel.value);
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
function ocrCheckLine(label, val) {
  if (val == null) {
    return `<span class="text-[10px] text-slate-400">${esc(label)}: — not checked</span>`;
  }
  return Number(val) === 1
    ? `<span class="text-[10px] text-emerald-600">✓ ${esc(label)} matches</span>`
    : `<span class="text-[10px] text-rose-600 font-bold">✗ ${esc(label)} mismatch</span>`;
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
  const tabMasters = document.getElementById('nav-tab-masters');
  const tabReports = document.getElementById('nav-tab-reports');
  if (tabPayments) tabPayments.classList.toggle('hidden', !isFinance);
  if (tabStatement) tabStatement.classList.toggle('hidden', !isFinance);
  if (tabAbstracts) tabAbstracts.classList.toggle('hidden', !isReviewer);
  if (tabMasters) tabMasters.classList.toggle('hidden', !isSuper);
  if (tabReports) tabReports.classList.toggle('hidden', !(isFinance || isReviewer));

  // Show only the report cards this role can access.
  const rv = document.getElementById('report-verified');
  const rw = document.getElementById('report-workshops');
  const ra = document.getElementById('report-abstracts');
  if (rv) rv.classList.toggle('hidden', !isFinance);
  if (rw) rw.classList.toggle('hidden', !isFinance);
  if (ra) ra.classList.toggle('hidden', !isReviewer);

  return { isSuper, isFinance, isReviewer };
}

async function initBackendPortal() {
  setupAdminDelegation();

  // Identify the logged-in admin from the session, not a client-side switcher.
  const meRes = await fetch('/api/auth/me');
  if (!meRes.ok) {
    alert('Please log in through the delegate portal with an administrator account.');
    window.location.href = '/';
    return;
  }
  activeAdminUser = (await meRes.json()).user;
  setText('active-admin-role-badge', `${activeAdminUser.full_name} · ${roleLabel(activeAdminUser.role)}`);

  const { isSuper, isFinance, isReviewer } = applyRoleVisibility(activeAdminUser.role);

  // Render every section this role may see (this also fills the tab badges).
  if (isFinance) await renderBackendPayments();
  if (isReviewer) await renderBackendAbstracts();
  if (isSuper) await renderBackendUsers();
  if (isSuper) await renderBackendPrograms();
  if (isSuper) await renderBackendFees();

  // Land on the first section the role can actually use.
  const defaultTab = isFinance ? 'payments' : isReviewer ? 'abstracts' : 'programs';
  switchBackendTab(defaultTab);
}

const PAYMENT_MODE_LABELS = { UPI: 'UPI', NEFT_RTGS: 'NEFT / RTGS' };

// Cached so the review modal can look a row up by id without a second fetch.
let cachedPaymentRegs = [];

async function renderBackendPayments() {
  const res = await fetch('/api/registrations');
  const data = await res.json();
  const tbody = document.getElementById('payment-table-body');
  if (!tbody) return;

  const allRegs = data.registrations || [];
  cachedPaymentRegs = allRegs;

  // Metrics reflect everyone; the worklist below only shows what still needs
  // a decision -- a verified delegate drops off it (see Reports for the
  // full verified list).
  const verified = allRegs.filter(r => r.bank_status === 'BANK_VERIFIED');
  const pending = allRegs.filter(r => r.bank_status !== 'BANK_VERIFIED');
  const flagged = allRegs.filter(r => r.is_flagged);
  const totalCleared = verified.reduce((sum, r) => sum + (Number(r.paid_amount) || 0), 0);
  setText('metric-total-amount', `₹${totalCleared}`);
  setText('metric-verified-count', verified.length);
  setText('metric-pending-count', pending.length);
  setText('metric-flagged-count', flagged.length);
  setText('badge-pending-payments', pending.length);

  const regs = pending; // worklist excludes already-verified delegates

  tbody.innerHTML = regs.map(p => {
    return `
    <tr class="border-b border-slate-100 ${p.is_flagged ? 'bg-red-50/50' : ''}">
      <td class="p-4 font-bold text-sm">
        ${esc(p.delegate_name)}
        <br><span class="text-[11px] font-normal text-slate-500">${esc(p.category_label)}</span>
        ${p.is_flagged ? `<br><span class="inline-block mt-1 text-[10px] bg-red-100 text-red-700 px-2 py-0.5 rounded border border-red-200 font-bold uppercase tracking-wider">⚠️ Flagged</span>` : ''}
      </td>
      <td class="p-4 text-xs">
        <span class="font-mono">${esc(p.utr_number)}</span>
        <br><span class="text-slate-500">${esc(PAYMENT_MODE_LABELS[p.payment_mode] || p.payment_mode || 'UPI')}</span>
        <br><span class="text-slate-400">${esc(fmtAuditTime(p.submitted_at))}</span>
      </td>
      <td class="p-4 text-sm">
        <span class="font-semibold text-slate-700">₹${Number(p.paid_amount)}</span>
        ${p.expected_amount == null
          ? ''
          : Number(p.paid_amount) !== Number(p.expected_amount)
            ? `<br><span class="text-[10px] text-rose-600 font-bold">≠ expected ₹${Number(p.expected_amount)}</span>`
            : `<br><span class="text-[10px] text-emerald-600">✓ matches fee</span>`
        }
        <div class="mt-1.5 flex flex-col gap-0.5">
          ${ocrCheckLine('Amount', p.ocr_amount_match)}
          ${p.payment_mode === 'NEFT_RTGS' ? '' : ocrCheckLine('UPI ID', p.ocr_vpa_match)}
          ${ocrCheckLine('UTR', p.ocr_utr_match)}
          ${p.ocr_id_match == null ? '' : ocrCheckLine('ID', p.ocr_id_match)}
        </div>
      </td>
      <td class="p-4 text-center whitespace-nowrap">
        ${p.has_screenshot
          ? `<button type="button" class="view-image-btn text-indigo-600 hover:text-indigo-800 font-semibold underline text-xs" data-id="${esc(p.id)}">Payment</button>`
          : `<span class="text-xs text-slate-400">N/A</span>`
        }
        ${p.has_id_card
          ? `<br><button type="button" class="view-id-btn text-indigo-600 hover:text-indigo-800 font-semibold underline text-xs mt-1" data-id="${esc(p.id)}">ID Card</button>`
          : ''
        }
      </td>
      <td class="p-4">
        <span class="${p.bank_status === 'REJECTED' ? 'bg-rose-100 text-rose-800' : 'bg-amber-100 text-amber-800'} text-xs px-2.5 py-1 rounded-full font-bold">
          ${esc(p.bank_status)}
        </span>
        ${p.bank_status === 'REJECTED' && p.rejection_reason
          ? `<br><span class="text-[10px] text-rose-600 font-semibold">${esc(REJECTION_LABELS[p.rejection_reason] || p.rejection_reason)}${p.rejection_note ? ': ' + esc(p.rejection_note) : ''}</span>`
          : ''
        }
        ${p.last_action_by
          ? `<br><span class="text-[10px] text-slate-400">by ${esc(p.last_action_by)} · ${esc(fmtAuditTime(p.last_action_at))}</span>`
          : ''
        }
      </td>
      <td class="p-4 text-right">
        <button class="review-btn px-3 py-1.5 ${p.is_flagged ? 'bg-red-600 hover:bg-red-700' : 'bg-indigo-600 hover:bg-indigo-700'} text-white font-semibold rounded-lg text-xs shadow-sm" data-id="${esc(p.id)}">
          ${p.is_flagged ? 'Review (Force Verify)' : 'Review'}
        </button>
        <p class="text-[10px] mt-1 ${p.bank_txn_id ? 'text-emerald-600' : 'text-amber-600'} font-semibold">${p.bank_txn_id ? '🔗 Linked' : '⚠ Not linked'}</p>
      </td>
    </tr>
  `;
  }).join('');

  if (!regs.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="p-8 text-center text-sm text-slate-400">Nothing awaiting a decision.</td></tr>`;
  }
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

  renderReviewTxnLink(p);
  openModal('modal-review');
}

// Show whether this registration is linked to a statement transaction; if
// not, load candidates the admin can pick from manually. Verification is
// blocked (both by the server and by disabling this button) until linked.
function renderReviewTxnLink(p) {
  const linkedBox = document.getElementById('review-txn-linked');
  const unlinkedBox = document.getElementById('review-txn-unlinked');
  const acceptBtn = document.getElementById('review-accept-btn');
  const isLinked = !!p.bank_txn_id;

  if (linkedBox) linkedBox.classList.toggle('hidden', !isLinked);
  if (unlinkedBox) unlinkedBox.classList.toggle('hidden', isLinked);
  if (acceptBtn) acceptBtn.disabled = !isLinked;

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
  if (!data.success) return alert(data.error || 'Could not link this transaction.');
  await renderBackendPayments();
  openReviewModal(reviewTargetId); // re-open with fresh cached data to reflect the new link
}

async function reviewUnlinkTransaction() {
  if (!(await showConfirm('Unlink this transaction? You will need to link one before this can be verified.'))) return;
  const data = await (await fetch(`/api/registrations/${encodeURIComponent(reviewTargetId)}/link-transaction`, { method: 'DELETE' })).json();
  if (!data.success) return alert(data.error || 'Could not unlink.');
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
  if (!data.success) return alert(data.error || 'Verification failed.');
  closeModal('modal-review');
  renderBackendPayments();
}

// Hand off to the existing reject-with-reason modal, stacked on top.
function reviewReject() {
  openRejectModal(reviewTargetId);
}

async function renderBackendUsers() {
  const res = await fetch('/api/users');
  const data = await res.json();
  const tbody = document.getElementById('user-table-body');
  if (!tbody) return;

  const users = data.users || [];
  setText('badge-user-count', users.length);

  tbody.innerHTML = users.map(u => `
    <tr>
      <td class="p-4 font-bold">${esc(u.full_name)}<br><span class="text-xs text-slate-400">+91 ${esc(u.phone_number)}</span></td>
      <td class="p-4">${esc(u.designation)} (${esc(u.institution)})</td>
      <td class="p-4"><span class="bg-indigo-100 text-indigo-800 text-xs font-bold px-2 py-1 rounded-full">${esc(roleLabel(u.role))}</span></td>
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
  `).join('');
}

async function updateRole(phone, role) {
  await fetch(`/api/users/${encodeURIComponent(phone)}/role`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role })
  });
  renderBackendUsers();
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
  if (!data.success) return alert(data.error || 'Could not add option.');
  document.getElementById('new-program-name').value = '';
  renderBackendPrograms();
}

async function saveProgramCapacity(id, capacity) {
  const data = await (await fetch(`/api/admin/program-options/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ capacity }),
  })).json();
  if (!data.success) alert(data.error || 'Update failed.');
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
  if (!data.success) alert(data.error || 'Delete failed.');
  renderBackendPrograms();
}

// --- WORKSHOP / QI ROSTER (manual admin add/remove) ---
let rosterOptionId = null;

async function openRosterModal(id, type, name) {
  rosterOptionId = id;
  setText('roster-title', `Roster — ${name}`);
  document.getElementById('roster-add-phone').value = '';
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

async function handleRosterAdd(e) {
  e.preventDefault();
  const phone = document.getElementById('roster-add-phone').value.trim();
  if (!/^\d{10}$/.test(phone)) return alert('Enter a valid 10-digit mobile number.');
  const data = await (await fetch(`/api/admin/program-options/${encodeURIComponent(rosterOptionId)}/enroll`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }),
  })).json();
  if (!data.success) return alert(data.error || 'Could not enroll this delegate.');
  document.getElementById('roster-add-phone').value = '';
  await loadRoster();
  renderBackendPrograms();
}

async function handleRosterRemove(phone) {
  if (!(await showConfirm('Remove this delegate from the roster?'))) return;
  const data = await (await fetch(`/api/admin/program-options/${encodeURIComponent(rosterOptionId)}/enroll/${encodeURIComponent(phone)}`, {
    method: 'DELETE',
  })).json();
  if (!data.success) alert(data.error || 'Could not remove this delegate.');
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
        <p class="text-[10px] font-mono text-slate-400">${esc(c.category_key)}${c.active ? '' : ' · inactive'}</p>
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

async function saveFeeConfig() {
  const data = await (await fetch('/api/admin/fees/config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      earlyUntil: document.getElementById('fee-early-until').value || null,
      regularUntil: document.getElementById('fee-regular-until').value || null,
      lateUntil: document.getElementById('fee-late-until').value || null,
    })
  })).json();
  if (!data.success) return alert(data.error || 'Could not save dates.');
  renderBackendFees();
}

async function handleAddFeeCategory(e) {
  e.preventDefault();
  const body = {
    categoryKey: document.getElementById('new-fee-key').value.trim(),
    label: document.getElementById('new-fee-label').value.trim(),
    earlyFee: Number(document.getElementById('new-fee-early').value),
    regularFee: Number(document.getElementById('new-fee-regular').value),
    lateFee: Number(document.getElementById('new-fee-late').value),
    spotFee: Number(document.getElementById('new-fee-spot').value),
  };
  const data = await (await fetch('/api/admin/fees/categories', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  })).json();
  if (!data.success) return alert(data.error || 'Could not add category.');
  document.getElementById('new-fee-key').value = '';
  document.getElementById('new-fee-label').value = '';
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
  if (!data.success) alert(data.error || 'Update failed.');
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
  if (!data.success) alert(data.error || 'Delete failed.');
  renderBackendFees();
}

// --- REPORTS (admin) ---
// CSV downloads; HTML opens a printable report (Print / Save as PDF).
function downloadReport(type, format) {
  const url = `/api/admin/reports/${encodeURIComponent(type)}` + (format === 'csv' ? '?format=csv' : '');
  window.open(url, '_blank');
}

// Render a report directly in the page (one table per section) instead of
// opening the printable/export view.
async function viewReport(type) {
  const box = document.getElementById('report-view-container');
  if (!box) return;
  box.classList.remove('hidden');
  box.innerHTML = '<p class="text-sm text-slate-500">Loading…</p>';
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const res = await fetch(`/api/admin/reports/${encodeURIComponent(type)}?format=json`);
  const data = await res.json();
  if (!data.success) { box.innerHTML = `<p class="text-sm text-rose-600">${esc(data.error || 'Could not load report.')}</p>`; return; }

  const rep = data.report;
  const table = (sec) => `
    ${sec.name ? `<h3 class="text-sm font-bold text-indigo-800 mt-4 mb-2">${esc(sec.name)} <span class="text-slate-400 font-normal">(${sec.rows.length})</span></h3>` : ''}
    <div class="overflow-x-auto border border-slate-200 rounded-xl">
      <table class="w-full text-left border-collapse text-xs">
        <thead><tr class="bg-slate-50 border-b border-slate-200 font-bold text-slate-500 uppercase">
          ${sec.columns.map(c => `<th class="py-2 px-3">${esc(c)}</th>`).join('')}
        </tr></thead>
        <tbody class="divide-y divide-slate-100">
          ${sec.rows.length ? sec.rows.map(r => `<tr>${r.map(c => `<td class="py-2 px-3">${esc(c)}</td>`).join('')}</tr>`).join('')
            : `<tr><td colspan="${sec.columns.length}" class="py-4 px-3 text-center text-slate-400">No records</td></tr>`}
        </tbody>
      </table>
    </div>`;

  box.innerHTML = `<div class="flex justify-between items-center">
      <h3 class="font-bold text-slate-800">${esc(rep.title)}</h3>
      <button onclick="document.getElementById('report-view-container').classList.add('hidden')" class="text-xs text-slate-400 hover:text-slate-600 font-semibold">✕ Close</button>
    </div>
    ${rep.sections.map(table).join('')}`;
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
          ? `<a href="/api/abstracts/${esc(a.id)}/file" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-indigo-600 hover:text-indigo-800 font-semibold underline text-xs">📄 Download abstract PDF</a>`
          : a.text
            ? `<p class="text-sm text-slate-600 whitespace-pre-wrap">${esc(a.text)}</p>`
            : `<span class="text-xs text-slate-400">No file</span>`
        }
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
  const abstracts = data.abstracts || [];
  const underReview = abstracts.filter(a => (a.status || 'UNDER_REVIEW') === 'UNDER_REVIEW');
  setText('badge-pending-abstracts', underReview.length);

  if (!abstracts.length) {
    approvalBox.innerHTML = `<p class="text-sm text-slate-500 p-4">No abstracts submitted yet.</p>`;
    assignBox.innerHTML = '';
    return;
  }

  // Step 1: Approval -- every abstract, accept/reject/reset only.
  approvalBox.innerHTML = abstracts.map(a => `
    <div class="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm">
      ${abstractCardHeader(a)}
      <div class="flex flex-wrap gap-2 mt-4">
        <button class="abstract-status-btn px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-lg text-xs" data-id="${esc(a.id)}" data-status="ACCEPTED">Approve</button>
        <button class="abstract-status-btn px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white font-semibold rounded-lg text-xs" data-id="${esc(a.id)}" data-status="REJECTED">Reject</button>
        <button class="abstract-status-btn px-3 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 font-semibold rounded-lg text-xs" data-id="${esc(a.id)}" data-status="UNDER_REVIEW">Reset</button>
      </div>
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
  if (!data.success) alert(data.error || 'Allocation failed.');
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
const MASTERS_SUBTABS = ['programs', 'fees', 'users'];
let lastMastersTab = 'programs';

function switchBackendTab(tab) {
  ['payments', 'statement', 'abstracts', 'programs', 'fees', 'reports', 'users'].forEach(t => {
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

  const inMasters = MASTERS_SUBTABS.includes(tab);
  const mastersWrap = document.getElementById('section-masters-wrapper');
  if (mastersWrap) mastersWrap.classList.toggle('hidden', !inMasters);
  const mastersBtn = document.getElementById('nav-tab-masters');
  if (mastersBtn) {
    mastersBtn.classList.toggle('text-indigo-600', inMasters);
    mastersBtn.classList.toggle('border-b-2', inMasters);
    mastersBtn.classList.toggle('border-indigo-600', inMasters);
    mastersBtn.classList.toggle('text-slate-500', !inMasters);
  }
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
    resultEl.textContent = `Imported ${data.imported} new row(s) of ${data.total} (${data.duplicates} already had been imported).`;
    fileInput.value = '';
    loadReconciliation();
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
        <td class="p-3 font-mono text-xs">${esc(r.registration_number || '—')}</td>
        <td class="p-3">${esc(r.delegate_name)}</td>
        <td class="p-3">${esc(PAYMENT_MODE_LABELS[r.payment_mode] || r.payment_mode || 'UPI')}</td>
        <td class="p-3 font-mono text-xs">${esc(r.utr_number)}</td>
        <td class="p-3">₹${esc(r.paid_amount != null ? r.paid_amount : r.expected_amount)}</td>
      </tr>`).join('') : `<tr><td colspan="5" class="p-4 text-center text-slate-400 text-xs">Every registration's reference was found in the statement.</td></tr>`;
  }

  const creditsBody = document.getElementById('rec-credits-body');
  if (creditsBody) {
    creditsBody.innerHTML = data.unmatchedCredits.length ? data.unmatchedCredits.map(t => `
      <tr>
        <td class="p-3">${esc(t.post_date)}</td>
        <td class="p-3">${esc(t.description)}</td>
        <td class="p-3 font-semibold">₹${esc(t.credit)}</td>
      </tr>`).join('') : `<tr><td colspan="3" class="p-4 text-center text-slate-400 text-xs">No unmatched credits.</td></tr>`;
  }

  const matchedBody = document.getElementById('rec-matched-body');
  if (matchedBody) {
    matchedBody.innerHTML = data.matched.length ? data.matched.map(m => `
      <tr class="${m.amountOk ? '' : 'bg-rose-50/50'}">
        <td class="p-3 font-mono text-xs">${esc(m.registration_number || '—')}</td>
        <td class="p-3">${esc(m.delegate_name)}</td>
        <td class="p-3 font-mono text-xs">${esc(m.utr_number)}</td>
        <td class="p-3">${esc(m.transaction.post_date)}</td>
        <td class="p-3">₹${esc(m.transaction.credit)}${m.amountOk ? '' : ` <span class="text-rose-600 font-bold">≠ claimed ₹${esc(m.paid_amount != null ? m.paid_amount : m.expected_amount)}</span>`}</td>
      </tr>`).join('') : `<tr><td colspan="5" class="p-4 text-center text-slate-400 text-xs">No matches yet — upload a statement above.</td></tr>`;
  }
}
