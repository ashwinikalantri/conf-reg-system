// Phase 0 of turning roles into data: prove the catalogue describes exactly
// what the app already enforces, before anything starts enforcing it.
//
// The test reads the real guards out of server.js -- `requireRole(...)` on
// each route, and REPORT_ROLES for the six reports -- reconstructs, for each
// of the five roles, the precise set of routes that role can reach today, and
// holds it against the set permissions.js would grant. One route more or
// fewer, for any role, and this fails.
//
// It also enforces the properties that keep the catalogue honest: no route
// left unmapped (the fail-open case), no permission covering routes with
// different guards (a key too coarse to say what the app already says), and
// no orphan keys.
const { check, report, appFile } = require('./harness');
const fs = require('fs');
const perms = require('../permissions');

const src = fs.readFileSync(appFile('server.js'), 'utf8');

// --- what the app enforces today -------------------------------------------

// Every `app.method('/path', requireRole('A', 'B'), ...)` in source order.
function guardedRoutes() {
  const re = /app\.(get|post|put|delete|patch)\(\s*'([^']+)'\s*,\s*requireRole\(([^)]*)\)/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push({
      route: `${m[1].toUpperCase()} ${m[2]}`,
      roles: m[3].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean),
    });
  }
  return out;
}

// ROLE_IMPLIES, read from source rather than restated here.
function roleImplies() {
  const m = /const ROLE_IMPLIES = (\{[^}]*\});/.exec(src);
  return m ? new Function(`return ${m[1]}`)() : {};
}
const IMPLIES = roleImplies();
const grants = (role) => [role, ...(IMPLIES[role] || [])];

function reportRoles() {
  const start = src.indexOf('const REPORT_ROLES = {');
  const end = src.indexOf('};', start) + 2;
  return new Function(`return ${src.slice(start + 'const REPORT_ROLES = '.length, end)}`)();
}

const ROUTES = guardedRoutes();
const REPORT_ROLES = reportRoles();
const ROLES = ['SUPER_ADMIN', 'FINANCE_ADMIN', 'ACADEMIC_REVIEWER', 'FINANCE_ACADEMIC', 'OPERATIONS'];

const setOf = (arr) => new Set(arr);
const diff = (a, b) => [...a].filter((x) => !b.has(x));

(async () => {
  console.log('\n== The inventory is complete ==');
  check('routes were found in source', ROUTES.length > 50, ROUTES.length);
  console.log(`   ${ROUTES.length} role-guarded routes, ${perms.PERMISSIONS.length} permissions, ${Object.keys(perms.ROUTE_PERMISSIONS).length} mapped`);

  const unmapped = ROUTES.filter((r) => !perms.permissionForRoute(r.route));
  check('every guarded route has a permission', unmapped.length === 0,
    unmapped.map((r) => r.route).slice(0, 8));

  const declared = setOf(Object.keys(perms.ROUTE_PERMISSIONS));
  const real = setOf(ROUTES.map((r) => r.route));
  const phantom = diff(declared, real);
  check('no permission maps a route that does not exist', phantom.length === 0, phantom.slice(0, 8));

  const unknownKey = Object.entries(perms.ROUTE_PERMISSIONS)
    .filter(([, k]) => !perms.PERMISSION_KEYS.includes(k));
  check('every mapping names a catalogued permission', unknownKey.length === 0, unknownKey.slice(0, 5));

  const usedKeys = setOf([...Object.values(perms.ROUTE_PERMISSIONS), ...Object.values(perms.REPORT_PERMISSIONS)]);
  const orphans = perms.PERMISSION_KEYS.filter((k) => !usedKeys.has(k));
  check('no permission guards nothing', orphans.length === 0, orphans);

  console.log('\n== No permission is coarser than the app it describes ==');
  // Every route sharing a key must share a guard set today. If two differ,
  // the key cannot express what the app currently allows.
  const byKey = new Map();
  ROUTES.forEach((r) => {
    const k = perms.permissionForRoute(r.route);
    if (!k) return;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  });
  const coarse = [];
  for (const [key, list] of byKey) {
    const shapes = setOf(list.map((r) => r.roles.slice().sort().join('+')));
    if (shapes.size > 1) coarse.push({ key, shapes: [...shapes] });
  }
  check('each permission covers one guard shape', coarse.length === 0, coarse.slice(0, 4));

  console.log('\n== Every role reaches exactly what it reaches today ==');
  let mismatched = 0;
  for (const role of ROLES) {
    const held = setOf(perms.permissionsForRole(role));
    const now = setOf(ROUTES.filter((r) => grants(role).some((g) => r.roles.includes(g))).map((r) => r.route));
    const next = setOf(ROUTES.filter((r) => held.has(perms.permissionForRoute(r.route))).map((r) => r.route));
    const gained = diff(next, now);
    const lost = diff(now, next);
    const ok = gained.length === 0 && lost.length === 0;
    if (!ok) mismatched++;
    console.log(`   ${role.padEnd(18)} ${String(now.size).padStart(2)} routes today`
      + (ok ? '  — identical' : `  — GAINS ${gained.length}, LOSES ${lost.length}`));
    check(`${role} gains nothing`, gained.length === 0, gained.slice(0, 6));
    check(`${role} loses nothing`, lost.length === 0, lost.slice(0, 6));
  }
  check('no role changed at all', mismatched === 0, mismatched);

  console.log('\n== The six reports keep their own rules ==');
  const reportNames = Object.keys(REPORT_ROLES);
  check('every report has a permission',
    reportNames.every((n) => perms.REPORT_PERMISSIONS[n]),
    reportNames.filter((n) => !perms.REPORT_PERMISSIONS[n]));
  for (const name of reportNames) {
    const key = perms.REPORT_PERMISSIONS[name];
    const nowRoles = setOf(ROLES.filter((r) => grants(r).some((g) => REPORT_ROLES[name].includes(g))));
    const nextRoles = setOf(ROLES.filter((r) => perms.roleCan(r, key)));
    check(`report "${name}" reaches the same roles`,
      diff(nowRoles, nextRoles).length === 0 && diff(nextRoles, nowRoles).length === 0,
      { now: [...nowRoles], next: [...nextRoles] });
  }

  console.log('\n== Sections open to the same roles the browser opens them to ==');
  // What applyRoleVisibility() does today, transcribed from public/app.js
  // (rolesFor + the tab/menu toggles). Phase 3 deletes that function and
  // draws the same thing from the catalogue; until then this is the check
  // that the catalogue would draw it identically.
  const CLIENT_TODAY = {
    SUPER_ADMIN: ['payments', 'statement', 'abstracts', 'reports', 'users', 'fees', 'programs', 'discount', 'groupdiscount', 'reminders', 'general', 'activity'],
    FINANCE_ADMIN: ['payments', 'statement', 'reports', 'discount', 'groupdiscount', 'reminders'],
    ACADEMIC_REVIEWER: ['abstracts', 'reports'],
    FINANCE_ACADEMIC: ['payments', 'statement', 'abstracts', 'reports', 'discount', 'groupdiscount', 'reminders'],
    OPERATIONS: ['reports', 'users'],
  };
  const allSections = Object.keys(perms.SECTION_PERMISSIONS);
  check('a section rule exists for every admin screen',
    allSections.length === fs.readdirSync(appFile('views', 'admin', 'sections')).length,
    allSections.length);
  for (const role of ROLES) {
    const fromCatalogue = setOf(allSections.filter((s) => perms.roleSeesSection(role, s)));
    const inBrowser = setOf(CLIENT_TODAY[role]);
    check(`${role} sees the same sections`,
      diff(fromCatalogue, inBrowser).length === 0 && diff(inBrowser, fromCatalogue).length === 0,
      { catalogue: [...fromCatalogue], browser: [...inBrowser] });
  }

  console.log('\n== The known drift is described, not inherited ==');
  // The Settings menu offers Reminders to a Finance Admin, and the audience
  // lists behind it do load for that role -- but every send button answers
  // 403. The catalogue says exactly that: the page is viewable, sending is
  // not. Phase 3 makes the buttons follow, which is the actual fix.
  check('Finance may open Reminders', perms.roleCan('FINANCE_ADMIN', 'comms.reminders_view'));
  check('...and may not send one', !perms.roleCan('FINANCE_ADMIN', 'comms.reminders_send'));
  check('...nor a test send', !perms.roleCan('FINANCE_ADMIN', 'comms.reminders_test'));
  check('...nor a custom email', !perms.roleCan('FINANCE_ADMIN', 'comms.custom_send'));
  check('only Super Admin may send', ROLES.filter((r) => perms.roleCan(r, 'comms.reminders_send')).join() === 'SUPER_ADMIN',
    ROLES.filter((r) => perms.roleCan(r, 'comms.reminders_send')));

  console.log('\n== Catalogue hygiene ==');
  const sectionKeys = setOf(perms.SECTIONS.map((s) => s.key));
  check('every permission belongs to a declared section',
    perms.PERMISSIONS.every((p) => sectionKeys.has(p.section)),
    perms.PERMISSIONS.filter((p) => !sectionKeys.has(p.section)).map((p) => p.key));
  check('keys are unique', setOf(perms.PERMISSION_KEYS).size === perms.PERMISSION_KEYS.length);
  check('keys are section-prefixed',
    perms.PERMISSIONS.every((p) => p.key.startsWith(`${p.section}.`)),
    perms.PERMISSIONS.filter((p) => !p.key.startsWith(`${p.section}.`)).map((p) => p.key));
  check('every permission has a description a person can act on',
    perms.PERMISSIONS.every((p) => p.label && p.description && p.description.length > 20),
    perms.PERMISSIONS.filter((p) => !p.description || p.description.length <= 20).map((p) => p.key));

  console.log('\n== Super Admin is the way back in ==');
  check('it holds every permission',
    perms.permissionsForRole('SUPER_ADMIN').length === perms.PERMISSION_KEYS.length);
  check('including any added later', perms.roleCan('SUPER_ADMIN', perms.PERMISSION_KEYS[perms.PERMISSION_KEYS.length - 1]));
  check('it is marked uneditable', perms.ROLES_BY_KEY.SUPER_ADMIN.all === true);
  check('an unknown role holds nothing', perms.permissionsForRole('NOT_A_ROLE').length === 0);
  check('and can do nothing', perms.roleCan('NOT_A_ROLE', 'payments.view') === false);
  check('DELEGATE is not an admin role', perms.permissionsForRole('DELEGATE').length === 0);

  console.log('\n== Nothing is enforced yet ==');
  // Phase 0 changes no behaviour. If server.js starts calling into this file,
  // that is Phase 1 and this assertion is the reminder to update the plan.
  check('server.js does not require the catalogue yet', !/require\('\.\/permissions'\)/.test(src));

  report();
})();
