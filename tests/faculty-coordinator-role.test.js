// The Faculty Coordinator (owner, 20 Nov 2026): one role for the whole of
// faculty coordination -- the Transport and Accommodation Coordinators'
// together -- without what stays with whoever manages the module.
const perms = require('../permissions');
const { call, check, report, adminLogin } = require('./harness');

(async () => {
  const P = new Set(perms.permissionsForRole('FACULTY_COORDINATOR'));
  const union = new Set([...perms.permissionsForRole('TRANSPORT_COORDINATOR'), ...perms.permissionsForRole('ACCOMMODATION_COORDINATOR')]);
  check('everything both coordinators may do', [...union].every((k) => P.has(k)), [...union].filter((k) => !P.has(k)));
  check('...travel and stay, marking faculty, the Faculty tab', ['guests.view', 'guests.edit', 'guests.travel', 'guests.stay'].every((k) => P.has(k)) && perms.roleSeesSection('FACULTY_COORDINATOR', 'faculty'));
  check('not removing faculty, deleting cars and rooms, the lists and settings', !P.has('guests.manage'));
  check('no money, no free registrations, no users', !['payments.view', 'payments.complimentary', 'users.manage_roles', 'desk.view'].some((k) => P.has(k)));
  const roles = (await call('GET', '/api/admin/roles', null, await adminLogin())).body.roles;
  check('a built-in role, offered in Users', roles.some((r) => r.key === 'FACULTY_COORDINATOR' && r.label === 'Faculty Coordinator'));
  report();
})();
