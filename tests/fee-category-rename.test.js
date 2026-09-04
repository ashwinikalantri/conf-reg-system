// Fee category labels used to be set once at creation and never editable --
// PUT /api/admin/fees/categories/:id deliberately left label and subtitle
// out of its UPDATE. They are now editable.
//
// The wrinkle is that registrations.category_label is a denormalised
// snapshot taken when the delegate registered, and it -- not the master row
// -- is what receipts, CSV exports and reminder emails print. Renaming only
// the master would leave those delegates showing a category name that no
// longer appears anywhere in the admin panel, which is exactly what had
// already happened in production: 34 registrations across 5 categories were
// carrying older names. So a rename carries through to them, and a Realign
// control reconciles rows that drifted some other way (a rename made
// directly against the database).
//
// category_key stays immutable throughout: registrations,
// group_discount_rules and promo-code scopes all join on it.
const { call, check, report, adminLogin, openDb } = require('./harness');

(async () => {
  const db = openDb();
  const cookie = await adminLogin();

  const fees = await call('GET', '/api/admin/fees', null, cookie);
  const cat = (fees.body.categories || []).find((c) => c.category_key === 'faculty_mo');
  if (!cat) { check('fixture has the faculty_mo category to rename', false); return report(); }

  const regsIn = async (key) => (await db.all(
    'SELECT category_label, COUNT(*) AS n FROM registrations WHERE category_key = ? GROUP BY category_label', [key]));

  console.log('\n== The label and subtitle can be renamed ==');
  const before = await regsIn('faculty_mo');
  const renamed = await call('PUT', `/api/admin/fees/categories/${cat.id}`, {
    label: 'Consultant Physician', subtitle: 'Faculty and medical officers',
    earlyFee: cat.early_fee, regularFee: cat.regular_fee, lateFee: cat.late_fee, spotFee: cat.spot_fee,
  }, cookie);
  check('the rename is accepted', renamed.status === 200 && renamed.body.success, renamed.body);

  const afterFees = await call('GET', '/api/admin/fees', null, cookie);
  const after = (afterFees.body.categories || []).find((c) => c.id === cat.id);
  check('the master row carries the new label', after.label === 'Consultant Physician', after.label);
  check('...and the new subtitle', after.subtitle === 'Faculty and medical officers', after.subtitle);
  check('the category_key is untouched', after.category_key === 'faculty_mo', after.category_key);

  console.log('\n== ...and it reaches the registrations that stored the old name ==');
  const totalRegs = before.reduce((n, r) => n + r.n, 0);
  check('the response reports how many registrations were updated',
    renamed.body.renamed === totalRegs, `reported ${renamed.body.renamed}, expected ${totalRegs}`);
  const stored = await regsIn('faculty_mo');
  check('every registration in the category now shows the new name',
    stored.length === 1 && stored[0].category_label === 'Consultant Physician',
    JSON.stringify(stored));
  check('no drift is left behind', Number(after.drifted) === 0, after.drifted);

  console.log('\n== A field left out of the body means "no change" ==');
  // toggleFeeCategory() sends only `active` and the fees. Before label was
  // editable that was harmless; now an absent label must not blank it.
  const toggled = await call('PUT', `/api/admin/fees/categories/${cat.id}`, {
    active: 0, earlyFee: cat.early_fee, regularFee: cat.regular_fee, lateFee: cat.late_fee, spotFee: cat.spot_fee,
  }, cookie);
  check('a body with no label is accepted', toggled.body.success, toggled.body);
  const afterToggle = ((await call('GET', '/api/admin/fees', null, cookie)).body.categories || []).find((c) => c.id === cat.id);
  check('the label survived a request that did not mention it',
    afterToggle.label === 'Consultant Physician', afterToggle.label);
  check('...and so did the subtitle', afterToggle.subtitle === 'Faculty and medical officers', afterToggle.subtitle);
  await call('PUT', `/api/admin/fees/categories/${cat.id}`, {
    active: 1, earlyFee: cat.early_fee, regularFee: cat.regular_fee, lateFee: cat.late_fee, spotFee: cat.spot_fee,
  }, cookie);

  console.log('\n== An empty label is refused rather than stored ==');
  const blank = await call('PUT', `/api/admin/fees/categories/${cat.id}`, {
    label: '   ', earlyFee: cat.early_fee, regularFee: cat.regular_fee, lateFee: cat.late_fee, spotFee: cat.spot_fee,
  }, cookie);
  check('a whitespace-only label is a 400', blank.status === 400, blank.status);
  const afterBlank = ((await call('GET', '/api/admin/fees', null, cookie)).body.categories || []).find((c) => c.id === cat.id);
  check('...and the stored label is unharmed', afterBlank.label === 'Consultant Physician', afterBlank.label);

  console.log('\n== Drift that appears some other way is reported and realignable ==');
  // Simulating what had actually happened in production: the label changed
  // without going through the API, leaving registrations behind.
  await db.run("UPDATE registrations SET category_label = 'Stale Name' WHERE category_key = 'faculty_mo'");
  const drifted = ((await call('GET', '/api/admin/fees', null, cookie)).body.categories || []).find((c) => c.id === cat.id);
  check('the drifted rows are counted', Number(drifted.drifted) === totalRegs, `${drifted.drifted} vs ${totalRegs}`);

  const realigned = await call('POST', `/api/admin/fees/categories/${cat.id}/realign`, {}, cookie);
  check('realign succeeds', realigned.body.success, realigned.body);
  check('...and reports the row count', realigned.body.updated === totalRegs, realigned.body);
  const settled = await regsIn('faculty_mo');
  check('every row is back on the master label',
    settled.length === 1 && settled[0].category_label === 'Consultant Physician', JSON.stringify(settled));
  const afterRealign = ((await call('GET', '/api/admin/fees', null, cookie)).body.categories || []).find((c) => c.id === cat.id);
  check('drift reads zero afterwards', Number(afterRealign.drifted) === 0, afterRealign.drifted);

  console.log('\n== Realign only touches the display name ==');
  const keys = await db.all("SELECT DISTINCT category_key FROM registrations WHERE category_key = 'faculty_mo'");
  check('the registrations are still in the same category', keys.length === 1 && keys[0].category_key === 'faculty_mo');
  const fee = await db.get("SELECT COUNT(*) AS n FROM registrations WHERE category_key='faculty_mo' AND expected_amount IS NULL");
  check('no fee was disturbed', fee.n === 0, fee);

  console.log('\n== Both writes are audited ==');
  const audit = await db.all(
    "SELECT action, new_value FROM audit_log WHERE entity_type='fee_category' ORDER BY id DESC LIMIT 12");
  check('the rename is in the log with its row count',
    audit.some((a) => a.action === 'FEE_CATEGORY_UPDATE' && /renamed from/.test(a.new_value || '')),
    JSON.stringify(audit.slice(0, 4)));
  check('the realign is in the log', audit.some((a) => a.action === 'FEE_CATEGORY_REALIGN'), JSON.stringify(audit.slice(0, 4)));

  db.close();
  report();
})();
