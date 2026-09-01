const { call, check, report, adminLogin } = require('./harness');
// The Users report must show an email-only account as a person with an email
// and no mobile -- not as a blank row, and never as their synthetic account
// key. This was a script that printed the report and left you to look; the
// endpoint returns CSV, which is why the old version crashed reading .sections.
const { openDb } = require('./harness');
const db = openDb({ readOnly: true });

(async () => {
  const ac = await adminLogin();
  check('signed in as an admin', !!ac);

  const rep = await call('GET', '/api/admin/reports/users?format=csv', null, ac);
  check('the users report is served', rep.status === 200, rep.status);
  const lines = rep.raw.trim().split('\n');
  const header = lines[0].split(',');
  const iMobile = header.indexOf('Mobile');
  const iEmail = header.indexOf('Email');
  const iName = header.indexOf('Name');
  check('it has Name, Mobile and Email columns', iMobile > -1 && iEmail > -1 && iName > -1, header);

  // The email-only account from the fixture: no phone at all.
  const emailOnly = await db.get(
    "SELECT phone_number, full_name, email FROM users WHERE phone_number LIKE 'u\\_%' ESCAPE '\\' LIMIT 1");
  check('the fixture has an email-only account', !!emailOnly, emailOnly);

  const row = lines.find((l) => l.includes(emailOnly.email));
  check('it appears in the report', !!row, emailOnly.email);
  const cells = row.split(',');
  check('with its email', cells[iEmail].replace(/"/g, '') === emailOnly.email, cells[iEmail]);
  check('and no mobile', cells[iMobile].replace(/"/g, '').trim() === '', cells[iMobile]);
  check('never its internal account key', !row.includes(emailOnly.phone_number), row.slice(0, 120));

  // A phone account, for contrast: the mobile must actually be there.
  const withPhone = await db.get(
    "SELECT phone, email FROM users WHERE phone IS NOT NULL AND email IS NOT NULL LIMIT 1");
  const phoneRow = lines.find((l) => l.includes(withPhone.email));
  check('a phone account still shows its mobile',
    !!phoneRow && phoneRow.includes(withPhone.phone.replace('+91', '')), withPhone.phone);

  db.close();
  report();
})();
