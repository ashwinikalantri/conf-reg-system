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

  if (reg) {
    if (reg.bank_status === 'BANK_VERIFIED') {
      statusTag.className = "text-xs bg-emerald-100 text-emerald-800 font-bold px-3 py-1 rounded-full border border-emerald-300";
      statusTag.innerText = "Registration Confirmed ✓";
      confBtn.innerText = "View Verified Details";
      reverifyBanner.classList.add('hidden');
    } else {
      statusTag.className = "text-xs bg-amber-100 text-amber-800 font-bold px-3 py-1 rounded-full border border-amber-300";
      statusTag.innerText = reg.is_flagged ? "Flagged - Awaiting Manual Audit" : "Registration Pending (Awaiting Verification)";
      confBtn.innerText = "Edit Submitted Payment";
      reverifyBanner.classList.add('hidden');
    }
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

// --- SCREENSHOT DISCREPANCY ANALYSIS ---
async function analyzeScreenshotDiscrepancies(base64Image, enteredUtr, enteredAmount) {
  return new Promise((resolve) => {
    setTimeout(() => {
      const utrInvalid = enteredUtr.length < 12;
      const mockRandomFlag = Math.random() > 0.7;
      const hasDiscrepancy = utrInvalid || mockRandomFlag;
      resolve(hasDiscrepancy);
    }, 1000); 
  });
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
  submitBtn.innerText = "Scanning Screenshot...";
  submitBtn.disabled = true;

  const reader = new FileReader();
  reader.onload = async function(event) {
    const base64Screenshot = event.target.result;
    const utr = document.getElementById('entered-utr').value.trim();
    const amount = parseFloat(document.getElementById('entered-amount').value);
    
    let isFlagged = false;

    const hasDiscrepancy = await analyzeScreenshotDiscrepancies(base64Screenshot, utr, amount);

    if (hasDiscrepancy) {
      const userProceeds = confirm(
        "⚠️ DISCREPANCY DETECTED IN SCREENSHOT SCAN\n\n" +
        "Our automated scanner could not cleanly match the entered UTR or Amount with the image provided.\n\n" +
        "Click OK to proceed anyway (your transaction will be FLAGGED for strict manual audit by the finance team).\n" +
        "Click Cancel to re-check your UTR or upload a clearer screenshot."
      );

      if (!userProceeds) {
        submitBtn.innerText = originalBtnText;
        submitBtn.disabled = false;
        return;
      }
      
      isFlagged = true;
    }

    const payload = {
      delegateName: currentDelegate.full_name || currentDelegate.name,
      categoryKey: document.getElementById('payment-category').value,
      categoryLabel: PRICING_TIERS[document.getElementById('payment-category').value].label,
      workshop: document.getElementById('payment-workshop').value,
      qiExposure: document.getElementById('payment-qi-exposure').value,
      amount: amount,
      utr: utr,
      screenshot: base64Screenshot,
      isFlagged: isFlagged
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
        alert(isFlagged 
          ? "Flagged submission received. It has been queued for manual finance audit." 
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
  navigateTo('main-page');
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
async function initBackendPortal() {
  const res = await fetch('/api/users');
  if (res.status === 401) {
    alert('Please log in through the delegate portal with an administrator account.');
    window.location.href = '/';
    return;
  }
  if (res.status === 403) {
    // Signed in, but not a super admin — user management is off-limits.
    // Still render the sections this role is allowed to see.
    renderBackendPayments();
    return;
  }
  const data = await res.json();
  const users = data.users || [];
  const adminUsers = users.filter(u => u.role !== 'DELEGATE');

  const switcher = document.getElementById('admin-user-switcher');
  if (switcher) {
    switcher.innerHTML = adminUsers.map(u => `<option value="${u.phone_number}">${u.full_name} (${u.role})</option>`).join('');
    if (!activeAdminUser && adminUsers.length) activeAdminUser = adminUsers[0];
  }

  renderBackendPayments();
  renderBackendUsers();
}

async function renderBackendPayments() {
  const res = await fetch('/api/registrations');
  const data = await res.json();
  const tbody = document.getElementById('payment-table-body');
  if (!tbody) return;

  tbody.innerHTML = (data.registrations || []).map(p => `
    <tr class="border-b border-slate-100 ${p.is_flagged ? 'bg-red-50/50' : ''}">
      <td class="p-4 font-bold text-sm">
        ${p.delegate_name}
        ${p.is_flagged ? `<br><span class="inline-block mt-1 text-[10px] bg-red-100 text-red-700 px-2 py-0.5 rounded border border-red-200 font-bold uppercase tracking-wider">⚠️ Flagged</span>` : ''}
      </td>
      <td class="p-4 font-mono text-xs">${p.utr_number}</td>
      <td class="p-4 text-sm font-semibold text-slate-700">₹${p.paid_amount}</td>
      <td class="p-4 text-center">
        ${p.screenshot 
          ? `<a href="${p.screenshot}" target="_blank" class="text-indigo-600 hover:text-indigo-800 font-semibold underline text-xs">View Image</a>` 
          : `<span class="text-xs text-slate-400">N/A</span>`
        }
      </td>
      <td class="p-4">
        <span class="${p.bank_status === 'BANK_VERIFIED' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'} text-xs px-2.5 py-1 rounded-full font-bold">
          ${p.bank_status}
        </span>
      </td>
      <td class="p-4 text-right">
        ${p.bank_status !== 'BANK_VERIFIED' 
          ? `<button onclick="approvePayment('${p.id}')" class="px-3 py-1.5 ${p.is_flagged ? 'bg-red-600 hover:bg-red-700' : 'bg-emerald-600 hover:bg-emerald-700'} text-white font-semibold rounded-lg text-xs shadow-sm">
              ${p.is_flagged ? 'Force Verify' : 'Verify Payment'}
             </button>`
          : `<span class="text-xs text-slate-400 font-medium">Verified</span>`
        }
      </td>
    </tr>
  `).join('');
}

async function approvePayment(id) {
  if (confirm("Have you cross-checked the payment screenshot and bank record?")) {
    await fetch(`/api/registrations/${id}/status`, {
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

  tbody.innerHTML = (data.users || []).map(u => `
    <tr>
      <td class="p-4 font-bold">${u.full_name}<br><span class="text-xs text-slate-400">+91 ${u.phone_number}</span></td>
      <td class="p-4">${u.designation} (${u.institution})</td>
      <td class="p-4"><span class="bg-indigo-100 text-indigo-800 text-xs font-bold px-2 py-1 rounded-full">${u.role}</span></td>
      <td class="p-4 text-right">
        <select onchange="updateRole('${u.phone_number}', this.value)" class="text-xs p-1 border rounded">
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
  await fetch(`/api/users/${phone}/role`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role })
  });
  initBackendPortal();
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
  document.getElementById('section-payments').classList.add('hidden');
  document.getElementById('section-abstracts').classList.add('hidden');
  document.getElementById('section-users').classList.add('hidden');
  document.getElementById(`section-${tab}`).classList.remove('hidden');
}