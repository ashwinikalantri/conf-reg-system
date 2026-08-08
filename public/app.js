const OFFICIAL_UPI_ID = "abhishekraut@cbin";

const PRICING_TIERS = {
  nursing_ug: { early: 500, regular: 1000, late: 2000, label: "Nursing Student UG" },
  nursing_pg: { early: 750, regular: 1500, late: 2500, label: "Nursing Student PG" },
  med_student: { early: 1500, regular: 2200, late: 3000, label: "Medical Student UG" },
  nurse_cho: { early: 2000, regular: 2800, late: 3500, label: "Nurse / Paramedical / CHO" },
  pg_doctor: { early: 3000, regular: 4000, late: 5000, label: "PG Student / Resident Doctor" },
  faculty_mo: { early: 3000, regular: 4000, late: 5000, label: "Doctors / Faculty / NHM MO" },
  chw: { early: 200, regular: 200, late: 200, label: "Frontline CHWs (ASHA/ANM/AWW)" }
};

let currentDelegate = JSON.parse(localStorage.getItem('nqocn_current_user')) || null;
let activeAdminUser = null;

// --- NAVIGATION & UI TOGGLES ---
function navigateTo(pageId) {
  document.querySelectorAll('main, section').forEach(el => el.classList.add('hidden'));
  const target = document.getElementById(pageId);
  if (target) target.classList.remove('hidden');
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
  const poSelect = document.getElementById('reg-po');

  if (pincode.length !== 6) {
    statusSpan.innerText = '';
    stateInput.value = '';
    districtInput.value = '';
    poSelect.innerHTML = '<option value="">Select Post Office</option>';
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
      
      poSelect.innerHTML = '<option value="">Select Post Office</option>';
      postOffices.forEach(po => {
        const option = document.createElement('option');
        option.value = po.Name;
        option.innerText = po.Name;
        poSelect.appendChild(option);
      });

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
    poSelect.innerHTML = '<option value="">Select Post Office</option>';
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
    designation: document.getElementById('reg-designation').value,
    institute: document.getElementById('reg-institute').value,
    pincode: document.getElementById('reg-pincode').value,
    state: document.getElementById('reg-state').value,
    district: document.getElementById('reg-district').value,
    po: document.getElementById('reg-po').value
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

  const regRes = await fetch('/api/registrations/me');
  const regData = await regRes.json();
  const reg = regData.registration;

  if (!reg) {
    // No payment submitted yet — reset to the initial pending state.
    statusTag.className = "text-xs bg-amber-100 text-amber-800 font-bold px-2.5 py-1 rounded-full border border-amber-200";
    statusTag.innerText = "Registration Pending";
    confBtn.innerText = "Register & Pay Now";
    reverifyBanner.classList.add('hidden');
  } else if (reg.bank_status === 'BANK_VERIFIED') {
    statusTag.className = "text-xs bg-emerald-100 text-emerald-800 font-bold px-3 py-1 rounded-full border border-emerald-300";
    statusTag.innerText = "Registration Confirmed ✓";
    confBtn.innerText = "View Verified Details";
    reverifyBanner.classList.add('hidden');
  } else {
    const needsAction = reg.is_flagged || reg.bank_status === 'REJECTED';
    statusTag.className = "text-xs bg-amber-100 text-amber-800 font-bold px-3 py-1 rounded-full border border-amber-300";
    statusTag.innerText = needsAction ? "Flagged - Awaiting Manual Audit" : "Registration Pending (Awaiting Verification)";
    confBtn.innerText = "Edit Submitted Payment";
    reverifyBanner.classList.toggle('hidden', !needsAction);
  }

  navigateTo('dashboard-page');
}

function calculateFee() {
  const catKey = document.getElementById('payment-category').value;
  if (!catKey) return;

  const currentFee = PRICING_TIERS[catKey].early;
  document.getElementById('calculated-fee-display').innerText = `₹${currentFee}`;
  document.getElementById('entered-amount').value = currentFee;

  const upiUri = `upi://pay?pa=${OFFICIAL_UPI_ID}&pn=NQOCN2026%20Conference&am=${currentFee}.00&cu=INR`;
  document.getElementById('upi-qr-image').src = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(upiUri)}`;
  document.getElementById('qr-container').classList.remove('hidden');
}

// --- PAYMENT SUBMISSION ---
async function verifyAndSubmitPayment(e) {
  e.preventDefault();

  const fileInput = document.getElementById('payment-screenshot');
  const file = fileInput.files[0];

  if (!file) {
    return alert("Please upload your payment screenshot.");
  }

  const submitBtn = document.getElementById('submit-payment-btn');
  const originalBtnText = submitBtn.innerText;
  submitBtn.innerText = "Submitting...";
  submitBtn.disabled = true;

  const reader = new FileReader();
  reader.onload = async function(event) {
    const base64Screenshot = event.target.result;
    const utr = document.getElementById('entered-utr').value.trim();

    // The fee is computed and verified server-side from the category; the
    // server flags the registration if the claimed amount does not match.
    const payload = {
      categoryKey: document.getElementById('payment-category').value,
      workshop: document.getElementById('payment-workshop').value,
      qiExposure: document.getElementById('payment-qi-exposure').value,
      amount: parseFloat(document.getElementById('entered-amount').value),
      utr: utr,
      screenshot: base64Screenshot
    };

    try {
      const res = await fetch('/api/registrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Server status ${res.status}: ${errorText.substring(0, 100)}`);
      }

      const data = await res.json();

      if (data.success) {
        alert(data.amountMismatch
          ? "Submission received, but the amount did not match the category fee. It has been flagged for manual finance audit."
          : "Payment details & screenshot submitted successfully! Registration is PENDING manual verification."
        );
        closeModal('modal-conference');
        loadDashboard();
      } else {
        alert(data.error || "Submission failed.");
      }
    } catch (err) {
      console.error("Payment Submission Error:", err);
      alert(`Submission Error: ${err.message}`);
    } finally {
      submitBtn.innerText = originalBtnText;
      submitBtn.disabled = false;
    }
  };

  reader.readAsDataURL(file);
}

async function handleAbstractSubmit(e) {
  e.preventDefault();
  const text = document.getElementById('abstract-text').value;
  const wordCount = text.trim().split(/\s+/).filter(w => w.length > 0).length;

  const payload = {
    authorName: currentDelegate.full_name || currentDelegate.name,
    format: document.getElementById('abstract-format').value,
    title: document.getElementById('abstract-title').value,
    text: text,
    wordCount: wordCount
  };

  const res = await fetch('/api/abstracts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();

  if (data.success) {
    alert("Abstract submitted for review!");
    closeModal('modal-abstract');
    loadDashboard();
  }
}

function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

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

// Only allow inline image data URIs as a screenshot link target. Anything
// else (javascript:, http(s), etc.) is rejected so it cannot run or phone home.
function safeImageSrc(v) {
  return typeof v === 'string' && /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(v)
    ? v
    : null;
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
      const btn = e.target.closest('.approve-btn');
      if (btn) approvePayment(btn.dataset.id);
    });
  }

  const userBody = document.getElementById('user-table-body');
  if (userBody) {
    userBody.addEventListener('change', (e) => {
      const sel = e.target.closest('.role-select');
      if (sel) updateRole(sel.dataset.phone, sel.value);
    });
  }

  const abstractBox = document.getElementById('abstracts-container');
  if (abstractBox) {
    abstractBox.addEventListener('click', (e) => {
      const btn = e.target.closest('.abstract-status-btn');
      if (btn) updateAbstractStatus(btn.dataset.id, btn.dataset.status);
    });
  }
}

// Set the text of an element if it exists.
function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

// Show only the nav tabs and default to the first section this admin's role
// is allowed to use.
function applyRoleVisibility(role) {
  const isSuper = role === 'SUPER_ADMIN';
  const isFinance = isSuper || role === 'FINANCE_ADMIN';
  const isReviewer = isSuper || role === 'ACADEMIC_REVIEWER';

  const tabPayments = document.getElementById('nav-tab-payments');
  const tabAbstracts = document.getElementById('nav-tab-abstracts');
  const tabUsers = document.getElementById('nav-tab-users');
  if (tabPayments) tabPayments.classList.toggle('hidden', !isFinance);
  if (tabAbstracts) tabAbstracts.classList.toggle('hidden', !isReviewer);
  if (tabUsers) tabUsers.classList.toggle('hidden', !isSuper);

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
  setText('active-admin-role-badge', `${activeAdminUser.full_name} · ${activeAdminUser.role}`);

  const { isSuper, isFinance, isReviewer } = applyRoleVisibility(activeAdminUser.role);

  // Render every section this role may see (this also fills the tab badges).
  if (isFinance) await renderBackendPayments();
  if (isReviewer) await renderBackendAbstracts();
  if (isSuper) await renderBackendUsers();

  // Land on the first section the role can actually use.
  const defaultTab = isFinance ? 'payments' : isReviewer ? 'abstracts' : 'users';
  switchBackendTab(defaultTab);
}

async function renderBackendPayments() {
  const res = await fetch('/api/registrations');
  const data = await res.json();
  const tbody = document.getElementById('payment-table-body');
  if (!tbody) return;

  const regs = data.registrations || [];

  // Summary metrics and the pending-payments tab badge.
  const verified = regs.filter(r => r.bank_status === 'BANK_VERIFIED');
  const pending = regs.filter(r => r.bank_status !== 'BANK_VERIFIED');
  const flagged = regs.filter(r => r.is_flagged);
  const totalCleared = verified.reduce((sum, r) => sum + (Number(r.paid_amount) || 0), 0);
  setText('metric-total-amount', `₹${totalCleared}`);
  setText('metric-verified-count', verified.length);
  setText('metric-pending-count', pending.length);
  setText('metric-flagged-count', flagged.length);
  setText('badge-pending-payments', pending.length);

  tbody.innerHTML = regs.map(p => {
    const img = safeImageSrc(p.screenshot);
    return `
    <tr class="border-b border-slate-100 ${p.is_flagged ? 'bg-red-50/50' : ''}">
      <td class="p-4 font-bold text-sm">
        ${esc(p.delegate_name)}
        ${p.is_flagged ? `<br><span class="inline-block mt-1 text-[10px] bg-red-100 text-red-700 px-2 py-0.5 rounded border border-red-200 font-bold uppercase tracking-wider">⚠️ Flagged</span>` : ''}
      </td>
      <td class="p-4 font-mono text-xs">${esc(p.utr_number)}</td>
      <td class="p-4 text-sm">
        <span class="font-semibold text-slate-700">₹${Number(p.paid_amount)}</span>
        ${p.expected_amount == null
          ? ''
          : Number(p.paid_amount) !== Number(p.expected_amount)
            ? `<br><span class="text-[10px] text-rose-600 font-bold">≠ expected ₹${Number(p.expected_amount)}</span>`
            : `<br><span class="text-[10px] text-emerald-600">✓ matches fee</span>`
        }
      </td>
      <td class="p-4 text-center">
        ${img
          ? `<a href="${esc(img)}" target="_blank" rel="noopener noreferrer" class="text-indigo-600 hover:text-indigo-800 font-semibold underline text-xs">View Image</a>`
          : `<span class="text-xs text-slate-400">N/A</span>`
        }
      </td>
      <td class="p-4">
        <span class="${p.bank_status === 'BANK_VERIFIED' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'} text-xs px-2.5 py-1 rounded-full font-bold">
          ${esc(p.bank_status)}
        </span>
      </td>
      <td class="p-4 text-right">
        ${p.bank_status !== 'BANK_VERIFIED'
          ? `<button class="approve-btn px-3 py-1.5 ${p.is_flagged ? 'bg-red-600 hover:bg-red-700' : 'bg-emerald-600 hover:bg-emerald-700'} text-white font-semibold rounded-lg text-xs shadow-sm" data-id="${esc(p.id)}">
              ${p.is_flagged ? 'Force Verify' : 'Verify Payment'}
             </button>`
          : `<span class="text-xs text-slate-400 font-medium">Verified</span>`
        }
      </td>
    </tr>
  `;
  }).join('');
}

async function approvePayment(id) {
  if (confirm("Have you cross-checked the payment screenshot and bank record?")) {
    await fetch(`/api/registrations/${encodeURIComponent(id)}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bankStatus: 'BANK_VERIFIED' })
    });
    renderBackendPayments();
  }
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
      <td class="p-4"><span class="bg-indigo-100 text-indigo-800 text-xs font-bold px-2 py-1 rounded-full">${esc(u.role)}</span></td>
      <td class="p-4 text-right">
        <select class="role-select text-xs p-1 border rounded" data-phone="${esc(u.phone_number)}">
          <option value="DELEGATE" ${u.role === 'DELEGATE' ? 'selected' : ''}>Delegate</option>
          <option value="FINANCE_ADMIN" ${u.role === 'FINANCE_ADMIN' ? 'selected' : ''}>Finance Admin</option>
          <option value="ACADEMIC_REVIEWER" ${u.role === 'ACADEMIC_REVIEWER' ? 'selected' : ''}>Academic Reviewer</option>
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

const ABSTRACT_STATUS_STYLES = {
  UNDER_REVIEW: 'bg-amber-100 text-amber-800',
  ACCEPTED: 'bg-emerald-100 text-emerald-800',
  REJECTED: 'bg-rose-100 text-rose-800',
};

async function renderBackendAbstracts() {
  const res = await fetch('/api/abstracts');
  const container = document.getElementById('abstracts-container');
  if (!container) return;

  if (!res.ok) {
    container.innerHTML = `<p class="text-sm text-slate-500 p-4">Unable to load abstracts.</p>`;
    return;
  }

  const data = await res.json();
  const abstracts = data.abstracts || [];
  const underReview = abstracts.filter(a => (a.status || 'UNDER_REVIEW') === 'UNDER_REVIEW');
  setText('badge-pending-abstracts', underReview.length);

  if (!abstracts.length) {
    container.innerHTML = `<p class="text-sm text-slate-500 p-4">No abstracts submitted yet.</p>`;
    return;
  }

  container.innerHTML = abstracts.map(a => {
    const status = a.status || 'UNDER_REVIEW';
    const badge = ABSTRACT_STATUS_STYLES[status] || 'bg-slate-100 text-slate-700';
    return `
    <div class="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm">
      <div class="flex justify-between items-start gap-4">
        <div>
          <h4 class="font-bold text-slate-800">${esc(a.title)}</h4>
          <p class="text-xs text-slate-500 mt-0.5">
            ${esc(a.author_name)} · ${esc(a.format)} · ${Number(a.word_count) || 0} words
          </p>
        </div>
        <span class="${badge} text-xs px-2.5 py-1 rounded-full font-bold whitespace-nowrap">${esc(status.replace('_', ' '))}</span>
      </div>
      <p class="text-sm text-slate-600 mt-3 whitespace-pre-wrap">${esc(a.text)}</p>
      <div class="flex gap-2 mt-4">
        <button class="abstract-status-btn px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-lg text-xs" data-id="${esc(a.id)}" data-status="ACCEPTED">Accept</button>
        <button class="abstract-status-btn px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white font-semibold rounded-lg text-xs" data-id="${esc(a.id)}" data-status="REJECTED">Reject</button>
        <button class="abstract-status-btn px-3 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 font-semibold rounded-lg text-xs" data-id="${esc(a.id)}" data-status="UNDER_REVIEW">Reset</button>
      </div>
    </div>
  `;
  }).join('');
}

async function updateAbstractStatus(id, status) {
  await fetch(`/api/abstracts/${encodeURIComponent(id)}/status`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status })
  });
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

function switchBackendTab(tab) {
  ['payments', 'abstracts', 'users'].forEach(t => {
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
}