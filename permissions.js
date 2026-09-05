// The permission catalogue.
//
// Phase 0 of turning roles into data. Today a role is a string compared
// against a list written inline at each of the 83 guarded routes, again in
// REPORT_ROLES for the six reports, and a third time in the browser. Nothing
// keeps those three in step, and they have already drifted: the Settings menu
// offers Reminders to a Finance Admin whose every send button answers 403.
//
// This file is the single place that says what may be done and who may do it.
// Nothing enforces it yet -- Phase 0 deliberately changes no behaviour. What
// it does is make the current rules writable down as data and provable: the
// test beside it reconstructs, for every role, the exact set of routes that
// role can reach today, and fails if this catalogue would grant one more or
// one fewer.
//
// A permission is not an idea, it is an enforceable boundary. Every key here
// corresponds to routes the server actually guards, which is why "approve"
// and "reject" are one key: they are one endpoint (PUT .../status) taking a
// status in the body, and no guard can separate them without splitting the
// route first.

// The sections of the admin panel a permission can belong to. Order is the
// order the role editor will show them in.
const SECTIONS = [
  { key: 'desk', label: 'Front desk' },
  { key: 'payments', label: 'Payments' },
  { key: 'statement', label: 'Bank statement' },
  { key: 'abstracts', label: 'Abstracts' },
  { key: 'reports', label: 'Reports' },
  { key: 'users', label: 'Users & roles' },
  { key: 'masters', label: 'Masters' },
  { key: 'discounts', label: 'Discounts' },
  { key: 'comms', label: 'Communications' },
  { key: 'system', label: 'System' },
];

// key, section, label, description. The description is what the role editor
// shows beside the checkbox, so it is written for the person choosing, not
// for the person implementing.
const PERMISSIONS = [
  // --- Front desk ---
  //
  // The desk is the one screen that starts from a person rather than a
  // queue, and these three exist because every grant that would otherwise
  // cover its work is far too wide for a volunteer on a conference day:
  // reprinting a receipt would need payments.view (the entire finance
  // worklist, every ledger and audit trail), reading one delegate's record
  // would need users.view (the whole Users & Roles tab), and moving somebody
  // into a workshop would need masters.programs_manage -- which also confers
  // the power to delete that workshop and wipe its roster.
  //
  // So the desk gets its own narrow routes over the same handlers. What it
  // does to a delegate's money, ID and category is NOT re-permissioned here:
  // payments.add_payment, payments.verify_id, payments.revise and
  // payments.desk_register already exist at exactly the right grain, and
  // none of them opens a tab.
  ['desk.view', 'desk', 'Open the front desk', 'Look a delegate up and read their whole record — registration, payment, programme, abstract and arrival — one person at a time.'],
  ['desk.enroll', 'desk', 'Change a programme choice', 'Move a delegate into a different workshop or QI practice at the desk.'],
  ['desk.checkin', 'desk', 'Check a delegate in', 'Record that a delegate has physically arrived.'],

  // --- Payments ---
  ['payments.view', 'payments', 'View payments', 'Open the Payments tab and read every registration, its ledger and its audit trail.'],
  ['payments.decide', 'payments', 'Approve or reject', 'Settle a pending payment. Approving and rejecting are one action here — they are the same endpoint.'],
  ['payments.unapprove', 'payments', 'Reverse a decision', 'Return an already-approved registration to pending.'],
  ['payments.revise', 'payments', 'Revise what is owed', 'Change a delegate’s category or fee, and ask them for a balance.'],
  ['payments.unlock_category', 'payments', 'Unlock a category', 'Undo a category lock, letting the delegate change category again.'],
  ['payments.link', 'payments', 'Link a payment to a credit', 'Match a payment against a bank credit, or unlink one.'],
  ['payments.add_payment', 'payments', 'Record a payment', 'Add a payment to a registration on the delegate’s behalf.'],
  ['payments.refund', 'payments', 'Record a refund', 'Return an excess payment against a real statement debit.'],
  ['payments.verify_id', 'payments', 'Verify a student ID', 'Confirm a student ID card and unlock verification.'],
  ['payments.desk_register', 'payments', 'Register at the desk', 'Create a registration for a walk-in, with the payment already settled.'],
  ['payments.rescan', 'payments', 'Re-run slip checks', 'Re-judge stored screenshots against the current OCR logic.'],
  // Conference-wide money, as opposed to one delegate's. Separate from
  // payments.view because they are different disclosures: working the
  // approval queue needs each registration's amount, while total revenue and
  // total outstanding are a management figure. Keeping them apart also makes
  // a totals-only role expressible -- someone who should see what the
  // conference has taken without reading anybody's individual record.
  ['payments.view_totals', 'payments', 'View financial totals', 'See conference-wide money: total collected and total still outstanding, without needing access to individual registrations.'],

  // --- Bank statement ---
  ['statement.view', 'statement', 'View the statement', 'Open the Bank Statement tab and its reconciliation.'],
  ['statement.import', 'statement', 'Import a statement', 'Upload a bank statement file.'],
  ['statement.mark_non_registration', 'statement', 'Mark non-registration', 'Set a credit aside as not belonging to any registration.'],
  ['statement.cash_deposit', 'statement', 'Bank desk cash', 'Link cash collected at the desk to the deposit it was banked as.'],

  // --- Abstracts ---
  ['abstracts.view', 'abstracts', 'View abstracts', 'Open the Abstracts tab and read submissions.'],
  ['abstracts.review', 'abstracts', 'Review abstracts', 'Accept or reject a submission, or ask its author for corrections.'],
  // Separate from review, and independent of it: deciding oral vs poster is a
  // programme decision rather than an academic one, and a role may hold
  // either without the other. Note this is also the step that emails the
  // author -- accepting an abstract tells them nothing until a format is
  // assigned (see PUT /api/abstracts/:id/allocation).
  ['abstracts.assign', 'abstracts', 'Assign presentation format', 'Set an accepted abstract to oral or poster, which is what sends the author their decision.'],

  // --- Reports ---
  ['reports.delegates', 'reports', 'Delegates report', 'The full delegate list, on screen or as CSV.'],
  ['reports.delegate_programs', 'reports', 'Delegate programmes report', 'Who is enrolled in what.'],
  ['reports.payments', 'reports', 'Payments report', 'Fees, receipts and balances.'],
  ['reports.programs', 'reports', 'Programme roster report', 'The roster for one workshop or practice.'],
  ['reports.abstracts', 'reports', 'Abstracts report', 'Submissions and their review status.'],
  ['reports.users', 'reports', 'Users report', 'Accounts, contact details and roles.'],

  // --- Users & roles ---
  ['users.view', 'users', 'View users', 'Open Users & Roles and read any account.'],
  ['users.create', 'users', 'Create a user', 'Add a staff or delegate account directly.'],
  ['users.edit', 'users', 'Edit a user', 'Change a person’s name, contact details or demography.'],
  ['users.assign_role', 'users', 'Assign a role', 'Change which role an account holds.'],
  ['users.manage_roles', 'users', 'Manage roles', 'Create and edit the roles themselves, and what each one may do.'],

  // --- Masters ---
  ['masters.fees_view', 'masters', 'View fees', 'Read the fee categories and date tiers.'],
  ['masters.fees_manage', 'masters', 'Edit fees', 'Change fee categories, amounts and the phase dates that price them.'],
  ['masters.programs_view', 'masters', 'View programmes', 'Read programme groups, options and their rosters.'],
  ['masters.programs_manage', 'masters', 'Edit programmes', 'Add or change programme groups and options, and manage their rosters.'],

  // --- Discounts ---
  ['discounts.view', 'discounts', 'View discount codes', 'Read promo codes and their usage.'],
  ['discounts.manage', 'discounts', 'Manage discount codes', 'Create, edit, delete and send promo codes.'],
  ['discounts.group_view', 'discounts', 'View group discounts', 'Read group discount rules and the groups holding them.'],
  ['discounts.group_manage', 'discounts', 'Manage group discounts', 'Create, edit and delete group discount rules.'],

  // --- Communications ---
  ['comms.reminders_view', 'comms', 'View reminder audiences', 'See who would receive a reminder, without sending one.'],
  // Super Admin only, by default. Finance Admin has always been able to see
  // who a reminder would reach (comms.reminders_view) without being able to
  // press send -- a real product question with no single right answer, not
  // a bug: is bulk email to delegates a Super Admin decision, or ordinary
  // Finance Admin work? Left as the conservative default rather than
  // decided here, because it no longer has to be decided in code at all --
  // tick this box for Finance Admin (or Finance & Academic) in Settings ->
  // Roles if the answer for this conference is "yes".
  ['comms.reminders_send', 'comms', 'Send reminders', 'Send a reminder to a real audience. Super Admin only by default -- grant it to another role here if that role should be trusted to email delegates directly.'],
  ['comms.reminders_test', 'comms', 'Send a test reminder', 'Send a reminder to yourself to check how it reads.'],
  ['comms.custom_send', 'comms', 'Send a custom email', 'Compose and send to an address list you supply.'],

  // --- System ---
  ['system.settings_view', 'system', 'View settings', 'Read Settings → General, including credentials’ presence.'],
  ['system.settings_edit', 'system', 'Edit settings', 'Change conference details, channels, payment details and maintenance mode.'],
  ['system.backups', 'system', 'Manage backups', 'Run a backup and link or test the off-site Google Drive copy.'],
  ['system.activity_log', 'system', 'View the activity log', 'Read the audit trail of who changed what.'],
].map(([key, section, label, description]) => ({ key, section, label, description }));

const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

// Which routes each permission actually guards. "METHOD /path" exactly as
// Express declares it, so the test can line this up against the source
// without a second, hand-kept list to fall out of date.
//
// Every route under one key must currently be guarded by the SAME set of
// roles -- the test asserts it. A key covering two differently-guarded routes
// would be a permission too coarse to express what the app already does.
const ROUTE_PERMISSIONS = {
  // Front desk. Each of these is a thin route over a handler that already
  // exists elsewhere under a wider permission -- the receipt is literally the
  // same renderReceipt, and the lookup composes the same helpers as
  // GET /api/users/:phone/detail. They are separate routes rather than a
  // widened guard because requirePermission takes exactly one key.
  'GET /api/desk/delegate/:identifier': 'desk.view',
  'GET /api/desk/registrations/:id/receipt': 'desk.view',
  'GET /api/desk/search': 'desk.view',
  'GET /api/desk/programmes': 'desk.view',
  'GET /api/desk/staff': 'desk.view',
  'GET /api/desk/cash-in-hand': 'desk.view',
  'POST /api/desk/enroll': 'desk.enroll',
  'POST /api/desk/checkin': 'desk.checkin',
  // Guarded by the existing "add a payment on the delegate's behalf" key
  // rather than a new one -- taking cash at the counter is that idea, not a
  // different one. The desk-specific part is the route, not the permission.
  'POST /api/desk/collect-cash': 'payments.add_payment',

  // Payments
  'GET /api/registrations': 'payments.view',
  'GET /api/admin/finance-summary': 'payments.view_totals',
  'GET /api/registrations/:id/audit': 'payments.view',
  'GET /api/registrations/:id/receipt': 'payments.view',
  'GET /api/admin/delegate-locations': 'payments.view',
  'PUT /api/registrations/:id/status': 'payments.decide',
  'PUT /api/registrations/:id/unapprove': 'payments.unapprove',
  'PUT /api/registrations/:id/lock-category': 'payments.revise',
  'POST /api/registrations/:id/revise-payment': 'payments.revise',
  'DELETE /api/registrations/:id/lock-category': 'payments.unlock_category',
  'GET /api/registrations/:id/candidate-transactions': 'payments.link',
  'PUT /api/registrations/:id/link-transaction': 'payments.link',
  'DELETE /api/registrations/:id/link-transaction': 'payments.link',
  'GET /api/payment-transactions/:txnId/candidates': 'payments.link',
  'PUT /api/payment-transactions/:txnId/link': 'payments.link',
  'DELETE /api/payment-transactions/:txnId/link': 'payments.link',
  'GET /api/admin/bank-credit-candidates': 'payments.link',
  'POST /api/registrations/:id/admin-add-payment': 'payments.add_payment',
  'GET /api/registrations/:id/refund-candidates': 'payments.refund',
  'POST /api/registrations/:id/refund': 'payments.refund',
  'DELETE /api/registrations/:id/refund/:refundId': 'payments.refund',
  'PUT /api/registrations/:id/verify-id': 'payments.verify_id',
  'POST /api/admin/registrations': 'payments.desk_register',
  'POST /api/admin/registrations/rescan-flagged': 'payments.rescan',

  // Bank statement
  'GET /api/admin/bank-statement': 'statement.view',
  'GET /api/admin/bank-statement/reconcile': 'statement.view',
  'POST /api/admin/bank-statement/upload': 'statement.import',
  'PUT /api/admin/bank-statement/:id/non-registration': 'statement.mark_non_registration',
  'GET /api/admin/cash-in-hand': 'statement.cash_deposit',
  'POST /api/admin/cash-deposit': 'statement.cash_deposit',
  'POST /api/admin/cash-deposit/unlink': 'statement.cash_deposit',

  // Abstracts
  'GET /api/abstracts': 'abstracts.view',
  'PUT /api/abstracts/:id/status': 'abstracts.review',
  'PUT /api/abstracts/:id/allocation': 'abstracts.assign',

  // Users & roles
  'GET /api/users': 'users.view',
  'GET /api/users/:phone/detail': 'users.view',
  'POST /api/users': 'users.create',
  'PUT /api/users/:phone': 'users.edit',
  'PUT /api/users/:phone/role': 'users.assign_role',
  'POST /api/admin/roles/reload': 'users.manage_roles',
  'GET /api/admin/roles': 'users.manage_roles',
  'POST /api/admin/roles': 'users.manage_roles',
  'PUT /api/admin/roles/:key': 'users.manage_roles',
  'DELETE /api/admin/roles/:key': 'users.manage_roles',
  // Lighter than the four above: read-only, no permission detail, just
  // enough (key/label) to populate a role picker. Held by anyone who can
  // assign a role, not only someone who can redesign one.
  'GET /api/admin/roles/options': 'users.assign_role',

  // Masters -- fees
  'GET /api/admin/fees': 'masters.fees_view',
  'PUT /api/admin/fees/config': 'masters.fees_manage',
  'POST /api/admin/fees/categories': 'masters.fees_manage',
  'PUT /api/admin/fees/categories/:id': 'masters.fees_manage',
  'POST /api/admin/fees/categories/:id/realign': 'masters.fees_manage',
  'DELETE /api/admin/fees/categories/:id': 'masters.fees_manage',

  // Masters -- programmes
  'GET /api/admin/program-groups': 'masters.programs_view',
  'GET /api/admin/program-options': 'masters.programs_view',
  'GET /api/admin/program-options/:id/enrolled': 'masters.programs_view',
  'POST /api/admin/program-groups': 'masters.programs_manage',
  'PUT /api/admin/program-groups/:id': 'masters.programs_manage',
  'DELETE /api/admin/program-groups/:id': 'masters.programs_manage',
  'POST /api/admin/program-options': 'masters.programs_manage',
  'PUT /api/admin/program-options/:id': 'masters.programs_manage',
  'DELETE /api/admin/program-options/:id': 'masters.programs_manage',
  'POST /api/admin/program-options/:id/enroll': 'masters.programs_manage',
  'DELETE /api/admin/program-options/:id/enroll/:phone': 'masters.programs_manage',
  'PUT /api/admin/program-options/:id/enrolled/:phone/faculty': 'masters.programs_manage',

  // Discounts
  'GET /api/admin/discount-codes': 'discounts.view',
  'GET /api/admin/discount-codes/:id/share': 'discounts.view',
  'POST /api/admin/discount-codes': 'discounts.manage',
  'PUT /api/admin/discount-codes/:id': 'discounts.manage',
  'DELETE /api/admin/discount-codes/:id': 'discounts.manage',
  'POST /api/admin/discount-codes/:id/email': 'discounts.manage',
  'GET /api/admin/group-rules': 'discounts.group_view',
  'GET /api/admin/groups': 'discounts.group_view',
  'POST /api/admin/group-rules': 'discounts.group_manage',
  'PUT /api/admin/group-rules/:id': 'discounts.group_manage',
  'DELETE /api/admin/group-rules/:id': 'discounts.group_manage',

  // Communications
  'GET /api/admin/reminders/pending-signups': 'comms.reminders_view',
  'GET /api/admin/reminders/balance-due': 'comms.reminders_view',
  'POST /api/admin/reminders/send': 'comms.reminders_send',
  'POST /api/admin/reminders/balance-due/send': 'comms.reminders_send',
  'POST /api/admin/reminders/test-send': 'comms.reminders_test',
  'POST /api/admin/reminders/balance-due/test-send': 'comms.reminders_test',
  'POST /api/admin/reminders/custom-send': 'comms.custom_send',

  // System
  'GET /api/admin/general-settings': 'system.settings_view',
  'PUT /api/admin/general-settings': 'system.settings_edit',
  'GET /api/admin/activity-log': 'system.activity_log',
  'GET /api/admin/backup/status': 'system.backups',
  'POST /api/admin/backup/request': 'system.backups',
  'POST /api/admin/backup/drive-link': 'system.backups',
  'POST /api/admin/backup/drive-check': 'system.backups',
  'POST /api/admin/backup/drive-oauth/config': 'system.backups',
  'GET /api/admin/backup/drive-oauth/start': 'system.backups',
  'GET /api/admin/backup/drive-callback': 'system.backups',
};

// The six reports are not guarded by requireRole -- they share two routes and
// pick their roles from REPORT_ROLES inside the handler, keyed on the report
// name. So they map by name rather than by route.
const REPORT_PERMISSIONS = {
  delegates: 'reports.delegates',
  'delegate-programs': 'reports.delegate_programs',
  payments: 'reports.payments',
  workshops: 'reports.programs',
  abstracts: 'reports.abstracts',
  users: 'reports.users',
};

// Which permission opens each screen of the admin panel -- one entry per file
// in views/admin/sections. Phase 3 draws the tab bar and the Settings menu
// from this instead of the four booleans in the browser's rolesFor(), which
// is what stops the two from disagreeing.
//
// `anyOf` for Reports: it is one tab holding six independently-permissioned
// reports, so it opens if any of them may be read.
const SECTION_PERMISSIONS = {
  // The overview only restates figures the other sections own, so it opens
  // for anyone who can open at least one of them -- and each card is hidden
  // individually for a role that cannot reach the section behind it (see
  // renderBackendOverview). It grants no reach of its own.
  overview: { anyOf: ['payments.view', 'statement.view', 'abstracts.view'] },
  desk: { permission: 'desk.view' },
  payments: { permission: 'payments.view' },
  statement: { permission: 'statement.view' },
  abstracts: { permission: 'abstracts.view' },
  reports: { anyOf: ['reports.delegates', 'reports.delegate_programs', 'reports.payments',
    'reports.programs', 'reports.abstracts', 'reports.users'] },
  users: { permission: 'users.view' },
  roles: { permission: 'users.manage_roles' },
  fees: { permission: 'masters.fees_view' },
  programs: { permission: 'masters.programs_view' },
  discount: { permission: 'discounts.view' },
  groupdiscount: { permission: 'discounts.group_view' },
  reminders: { permission: 'comms.reminders_view' },
  general: { permission: 'system.settings_view' },
  activity: { permission: 'system.activity_log' },
};

// Can this role open that screen?
function roleSeesSection(roleKey, sectionKey) {
  const rule = SECTION_PERMISSIONS[sectionKey];
  if (!rule) return false;
  if (rule.anyOf) return rule.anyOf.some((k) => roleCan(roleKey, k));
  return roleCan(roleKey, rule.permission);
}

// The five roles as they exist today, written out as permission sets.
//
// This is the seed, and it is deliberately explicit rather than derived from
// ROUTE_PERMISSIONS: derived, it could only ever agree with itself. Written
// out, the test can hold it against what the running app actually allows and
// fail if the two have diverged.
//
// SUPER_ADMIN is absent on purpose. It holds every permission implicitly,
// including any added later, and it is not editable -- that is what makes it
// the way back in when a role is misconfigured.
const SYSTEM_ROLES = [
  {
    key: 'SUPER_ADMIN',
    label: 'Super Admin',
    description: 'Everything, including roles themselves. Cannot be edited or removed.',
    all: true,
    permissions: [],
  },
  {
    key: 'FINANCE_ADMIN',
    label: 'Finance Admin',
    description: 'Payments, the bank statement, discounts and the finance reports.',
    permissions: [
      'payments.view', 'payments.view_totals', 'payments.decide', 'payments.revise', 'payments.link',
      'payments.add_payment', 'payments.refund', 'payments.verify_id',
      'payments.desk_register', 'payments.rescan',
      'statement.view', 'statement.import', 'statement.mark_non_registration', 'statement.cash_deposit',
      'discounts.view', 'discounts.manage', 'discounts.group_view', 'discounts.group_manage',
      'comms.reminders_view',
      // Read-only, not masters.fees_manage -- Finance Admin still can't touch
      // a fee amount or a phase date, and never sees the Fee Master settings
      // page's edit controls. But three things Finance Admin already does --
      // student ID verification and category correction inside Review, and
      // the category picker on both discount screens -- all read the fee
      // category list to know which categories are "student" ones or to
      // populate a dropdown, and without this they silently rendered as
      // empty: no ID Verification section shown at all, a blank category
      // picker. This was true before roles became data (GET /api/admin/fees
      // was SUPER_ADMIN-only in the original server.js too) -- a real bug
      // this migration inherited rather than caused, closed here because the
      // fix is a plain read grant, not a product decision like the two
      // deliberately-left-alone ones above.
      'masters.fees_view',
      'reports.delegates', 'reports.delegate_programs', 'reports.payments', 'reports.programs',
    ],
  },
  {
    key: 'ACADEMIC_REVIEWER',
    label: 'Academic Reviewer',
    description: 'Abstracts and the abstracts report. Nothing financial.',
    permissions: ['abstracts.view', 'abstracts.review', 'reports.abstracts'],
  },
  {
    key: 'FINANCE_ACADEMIC',
    label: 'Finance & Academic',
    description: 'Finance Admin and Academic Reviewer together.',
    // Today this is ROLE_IMPLIES expanding one role into two at request time.
    // As a permission set it is simply the union, which is what it always
    // meant -- and the reason ROLE_IMPLIES can retire once this lands.
    permissions: null, // filled below: union of the two above
  },
  {
    key: 'FRONT_DESK',
    label: 'Front Desk',
    description: 'One delegate at a time on the conference days: look them up, register walk-ins, take cash, fix details, check them in.',
    permissions: [
      'desk.view', 'desk.enroll', 'desk.checkin',
      // Existing keys at exactly the right grain, deliberately reused rather
      // than re-invented. None of them opens a tab of its own, so the desk
      // can hold them without seeing the payments worklist: the Payments tab
      // is gated on payments.view, which the desk does NOT get, and neither
      // is payments.view_totals -- conference-wide money is not desk work.
      'payments.desk_register', 'payments.add_payment', 'payments.verify_id', 'payments.revise',
      // Correcting a delegate's own details is the desk's most ordinary job.
      // This is a widening of a deliberately narrow permission (see the
      // comment above PUT /api/users/:phone) and is acknowledged as such in
      // permission-catalogue's WIDENED_SINCE_BASELINE.
      'users.edit',
      // Read the fee categories, for the same reason Finance Admin needs it:
      // the category picker and the "does this category need a student ID"
      // question both read that list, and render empty without it.
      'masters.fees_view',
    ],
  },
  {
    key: 'OPERATIONS',
    label: 'Operations',
    description: 'Users and every report. No payments, statement or abstracts.',
    permissions: [
      'users.view', 'users.create', 'users.assign_role',
      'reports.delegates', 'reports.delegate_programs', 'reports.payments',
      'reports.programs', 'reports.abstracts', 'reports.users',
    ],
  },
];

// FINANCE_ACADEMIC is the union of the two roles it implies today.
(() => {
  const byKey = Object.fromEntries(SYSTEM_ROLES.map((r) => [r.key, r]));
  byKey.FINANCE_ACADEMIC.permissions = [
    ...new Set([...byKey.FINANCE_ADMIN.permissions, ...byKey.ACADEMIC_REVIEWER.permissions]),
  ];
})();

const ROLES_BY_KEY = Object.fromEntries(SYSTEM_ROLES.map((r) => [r.key, r]));

// Every permission a role holds. Super Admin holds all of them, including
// ones added after it was written.
function permissionsForRole(roleKey) {
  const role = ROLES_BY_KEY[roleKey];
  if (!role) return [];
  return role.all ? PERMISSION_KEYS.slice() : role.permissions.slice();
}

function roleCan(roleKey, permissionKey) {
  const role = ROLES_BY_KEY[roleKey];
  if (!role) return false;
  return role.all ? PERMISSION_KEYS.includes(permissionKey) : role.permissions.includes(permissionKey);
}

// The permission guarding one route, or undefined if it is not an admin
// route. `route` is "METHOD /path" as Express declares it.
function permissionForRoute(route) {
  return ROUTE_PERMISSIONS[route];
}

module.exports = {
  SECTIONS,
  SECTION_PERMISSIONS,
  roleSeesSection,
  PERMISSIONS,
  PERMISSION_KEYS,
  ROUTE_PERMISSIONS,
  REPORT_PERMISSIONS,
  SYSTEM_ROLES,
  ROLES_BY_KEY,
  permissionsForRole,
  roleCan,
  permissionForRoute,
};
