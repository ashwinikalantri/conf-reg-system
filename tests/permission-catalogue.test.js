// Roles as data: the catalogue must grant exactly what the app granted
// before enforcement moved into it, and must keep granting it.
//
// Phase 0 proved the equivalence by reading `requireRole(...)` out of the
// source. Phase 1 replaced those guards, so that reading is gone and would
// be circular anyway -- the catalogue checked against itself. The answer is
// frozen instead, in tests/fixtures/role-reachability.json, captured from
// the source at 1a88c34. Every role's route set is held against it, so
// widening a role from here on has to change that file in a diff someone
// reads.
//
// It also enforces the properties that keep the catalogue honest: no route
// left unmapped (the fail-open case), no permission covering routes with
// different guards (a key too coarse to say what the app already says), and
// no orphan keys.
//
// What this test does NOT catch: a server that declares the right permission
// and then never consults it. Everything here reads source. Whether the
// running app actually refuses anyone is permission-enforcement.test.js,
// which signs in as each role and calls the routes.
const { check, report, appFile } = require('./harness');
const fs = require('fs');
const perms = require('../permissions');

const src = fs.readFileSync(appFile('server.js'), 'utf8');

// --- what the app enforces today -------------------------------------------

// Every `app.method('/path', requirePermission('key'), ...)` in source order.
// Phase 1 replaced the inline role lists with these, so this is now read
// straight out of the guards rather than reconstructed from role names.
function guardedRoutes() {
  const re = /app\.(get|post|put|delete|patch)\(\s*'([^']+)'\s*,\s*requirePermission\('([^']+)'\)/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push({ route: `${m[1].toUpperCase()} ${m[2]}`, permission: m[3] });
  }
  return out;
}

// The reachability table as it stood the moment before enforcement moved to
// permissions. Captured from the source at 1a88c34, when roles were still
// lists of names at each route. Re-deriving it from today's source would be
// circular -- the catalogue would only be checked against itself -- so the
// answer is frozen and this test holds the running catalogue against it.
// Widening a role from now on has to change this file, in a diff someone
// reads.
const BASELINE = JSON.parse(fs.readFileSync(appFile('tests', 'fixtures', 'role-reachability.json'), 'utf8'));

const ROUTES = guardedRoutes();
const ROLES = Object.keys(BASELINE.roles);

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
  // Routes sharing a key must have been reachable by the same roles at the
  // baseline. If two differ, the key cannot express what the app allowed,
  // and collapsing them silently widened or narrowed someone's access.
  const byKey = new Map();
  ROUTES.forEach((r) => {
    if (!byKey.has(r.permission)) byKey.set(r.permission, []);
    byKey.get(r.permission).push(r.route);
  });
  const shapeOf = (route) => ROLES.filter((role) => BASELINE.roles[role].routes.includes(route)).join('+');
  const coarse = [];
  for (const [key, routes] of byKey) {
    const known = routes.filter((r) => BASELINE.roles.SUPER_ADMIN.routes.includes(r));
    if (!known.length) continue;   // added since the baseline; nothing to compare against
    const shapes = setOf(known.map(shapeOf));
    if (shapes.size > 1) coarse.push({ key, shapes: [...shapes] });
  }
  check('each permission covers one guard shape', coarse.length === 0, coarse.slice(0, 4));

  console.log('\n== The declared mapping and the real guards agree ==');
  const wrong = ROUTES.filter((r) => perms.permissionForRoute(r.route) !== r.permission);
  check('every route is guarded by the permission the catalogue assigns it',
    wrong.length === 0, wrong.slice(0, 6));

  console.log('\n== Every role reaches exactly what it reached before ==');
  // Routes added after the baseline was frozen are legitimate -- the app
  // keeps growing -- but each one has to be named here, with what it is and
  // who may reach it. An unlisted new route fails, so widening access by
  // adding a route is as visible as widening it by editing a role.
  const ADDED_SINCE_BASELINE = {
    'POST /api/admin/roles/reload': 'Phase 2. Re-reads roles from the database. Super Admin only.',
    'GET /api/admin/roles': 'Phase 4. The role editor\'s own detail view. Super Admin only.',
    'GET /api/admin/roles/options': 'Phase 4. Light role list for an assignment picker -- users.assign_role, not manage_roles.',
    'POST /api/admin/roles': 'Phase 4. Create a role. Super Admin only.',
    'PUT /api/admin/roles/:key': 'Phase 4. Edit a role. Super Admin only.',
    'DELETE /api/admin/roles/:key': 'Phase 4. Delete a role. Super Admin only.',
    'POST /api/admin/fees/categories/:id/realign': 'Brings registrations that stored an older label for a category up to the current one. Display name only -- no category or fee changes. masters.fees_manage, the same permission as renaming the category in the first place, so it widens nobody\'s access.',
  };
  const added = ROUTES.map((r) => r.route).filter((r) => !BASELINE.roles.SUPER_ADMIN.routes.includes(r));
  check('every route added since the baseline is accounted for',
    added.every((r) => ADDED_SINCE_BASELINE[r]), added.filter((r) => !ADDED_SINCE_BASELINE[r]));
  check('the baseline still covers the rest',
    BASELINE.routeCount === ROUTES.length - added.length, [BASELINE.routeCount, ROUTES.length, added.length]);

  // Existing routes whose ACCESS widened for one particular role -- a
  // different thing from a new route existing at all (ADDED_SINCE_BASELINE
  // above), and deliberately role-scoped rather than filtered globally: this
  // must not also let some OTHER role gain the same route unnoticed. Keyed
  // "ROLE route", one entry per (role, route) pair, each with its own reason.
  const WIDENED_SINCE_BASELINE = {
    'FINANCE_ADMIN GET /api/admin/fees': 'Bugfix, pre-dates the roles migration (this route was '
      + "SUPER_ADMIN-only in the original server.js too). Finance Admin's own Review modal reads it "
      + '(ensureReviewCategories, via masters.fees_view) to know which categories require a student ID '
      + 'and to populate the category-correction and both discount-scope pickers -- all screens Finance '
      + 'Admin already has. Without it those rendered as silently empty: no ID Verification section, no '
      + 'options in the category dropdowns. Read-only -- masters.fees_manage, which can actually change a '
      + 'fee or a phase date, is untouched and stays Super Admin only.',
    'FINANCE_ACADEMIC GET /api/admin/fees': 'Inherited automatically -- FINANCE_ACADEMIC is the union of '
      + 'FINANCE_ADMIN and ACADEMIC_REVIEWER\'s permission sets, not a separately-curated list. Same reason as above.',
  };

  // The mirror of the above, for access that SHRINKS. There was no way to
  // record one: `lost` was computed unfiltered, so narrowing a role failed
  // this test with nothing to do about it but revert. That made removing a
  // permission harder than adding one, which is the wrong way round -- the
  // point of the file is that a change in who reaches what appears in a diff
  // someone reads, and that argument applies at least as strongly to taking
  // something away. Same key shape: "ROLE route", one entry per pair.
  const NARROWED_SINCE_BASELINE = {
    'ACADEMIC_REVIEWER PUT /api/abstracts/:id/allocation': 'Assigning oral vs poster moved from '
      + 'abstracts.review to its own abstracts.assign key, granted to Super Admin only. Deliberate: '
      + 'the format is a programme decision rather than an academic one. Accept/reject '
      + '(PUT .../status) is untouched. Note this route is also what emails the author their '
      + 'decision, so acceptances now reach delegates only once a Super Admin assigns a format.',
    'FINANCE_ACADEMIC PUT /api/abstracts/:id/allocation': 'Follows from the line above -- '
      + 'FINANCE_ACADEMIC is the union of FINANCE_ADMIN and ACADEMIC_REVIEWER, not a curated list, '
      + 'so it loses what ACADEMIC_REVIEWER loses.',
  };

  let mismatched = 0;
  for (const role of ROLES) {
    const held = setOf(perms.permissionsForRole(role));
    const before = setOf(BASELINE.roles[role].routes);
    const nowReach = setOf(ROUTES.filter((r) => held.has(r.permission)).map((r) => r.route));
    const gained = diff(nowReach, before).filter((r) => !ADDED_SINCE_BASELINE[r] && !WIDENED_SINCE_BASELINE[`${role} ${r}`]);
    const lost = diff(before, nowReach).filter((r) => !NARROWED_SINCE_BASELINE[`${role} ${r}`]);
    const ok = gained.length === 0 && lost.length === 0;
    if (!ok) mismatched++;
    console.log(`   ${role.padEnd(18)} ${String(before.size).padStart(2)} routes at the baseline`
      + (ok ? '  — identical' : `  — GAINS ${gained.length}, LOSES ${lost.length}`));
    check(`${role} gains nothing`, gained.length === 0, gained.slice(0, 6));
    check(`${role} loses nothing`, lost.length === 0, lost.slice(0, 6));
  }
  check('no role changed at all', mismatched === 0, mismatched);

  console.log('\n== The six reports keep their own rules ==');
  const reportNames = Object.keys(perms.REPORT_PERMISSIONS);
  check('the baseline knows the same reports',
    reportNames.length === setOf(Object.values(BASELINE.roles).flatMap((r) => r.reports)).size,
    reportNames.length);
  for (const role of ROLES) {
    const before = setOf(BASELINE.roles[role].reports);
    const nowReach = setOf(reportNames.filter((n) => perms.roleCan(role, perms.REPORT_PERMISSIONS[n])));
    check(`${role} runs the same reports`,
      diff(nowReach, before).length === 0 && diff(before, nowReach).length === 0,
      { baseline: [...before], now: [...nowReach] });
  }

  console.log('\n== Sections open to the same roles the browser opens them to ==');
  // What applyRoleVisibility() does today, transcribed from public/app.js
  // (rolesFor + the tab/menu toggles). Phase 3 deletes that function and
  // draws the same thing from the catalogue; until then this is the check
  // that the catalogue would draw it identically.
  // Finance Admin (and Finance & Academic) now also see 'fees' -- a
  // deliberate consequence of granting masters.fees_view to fix the
  // ID-verification bug below, not a fact independently re-derived from the
  // client. The tab is read-only for them: masters.fees_manage (the actual
  // edit/save/delete actions on the Fee Master page) is untouched.
  // 'overview' is the landing screen. It restates figures the payments,
  // statement and abstracts sections own, so it opens for anyone who can
  // open at least one of those and grants no reach of its own -- every card
  // is hidden individually for a role that cannot reach the section behind
  // it. OPERATIONS is deliberately absent: it sees Reports and Users, and
  // nothing the overview summarises, so it would be an empty screen.
  const CLIENT_TODAY = {
    SUPER_ADMIN: ['overview', 'payments', 'statement', 'abstracts', 'reports', 'users', 'roles', 'fees', 'programs', 'discount', 'groupdiscount', 'reminders', 'general', 'activity'],
    FINANCE_ADMIN: ['overview', 'payments', 'statement', 'reports', 'fees', 'discount', 'groupdiscount', 'reminders'],
    ACADEMIC_REVIEWER: ['overview', 'abstracts', 'reports'],
    FINANCE_ACADEMIC: ['overview', 'payments', 'statement', 'abstracts', 'reports', 'fees', 'discount', 'groupdiscount', 'reminders'],
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

  console.log('\n== The server enforces it ==');
  check('server.js reads the catalogue', /require\('\.\/permissions'\)/.test(src));
  check('requirePermission exists', /function requirePermission\(permission\)/.test(src));
  check('an unknown permission fails at load, not at request time',
    /throw new Error\(`Unknown permission/.test(src));
  // The old vocabulary is gone rather than left lying around: dead
  // access-control code reads as if it still governs something.
  check('requireRole is gone', !/function requireRole\(/.test(src));
  check('ROLE_IMPLIES is gone', !/const ROLE_IMPLIES =/.test(src));
  check('REPORT_ROLES is gone', !/const REPORT_ROLES =/.test(src));
  check('no route still names a role inline', !/requireRole\('/.test(src));
  // The fail-open guard: a route that carries no permission stops the boot.
  check('the router is audited at boot', /function auditRoutePermissions\(\)/.test(src));
  check('and an unguarded admin route is fatal', /FATAL: admin route\(s\) with no permission/.test(src));

  report();
})();
