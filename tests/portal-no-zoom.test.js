// The delegate portal does not zoom on a phone: the viewport tag for
// Android, pinch stopped by script for iPhones (which ignore user-scalable),
// touch-action for the double tap. The admin page still zooms.
const { call, check, report, adminLogin } = require('./harness');

(async () => {
  const portal = (await call('GET', '/', null, null)).raw;
  check('the portal\'s viewport does not scale', /<meta name="viewport" content="[^"]*maximum-scale=1\.0, user-scalable=no"/.test(portal));
  check('...an iPhone pinch is stopped', /addEventListener\('gesturestart', stop, \{ passive: false \}\)/.test(portal)
    && /e\.touches\.length > 1\) e\.preventDefault\(\)/.test(portal));
  check('...and a double tap does not zoom', /html \{ touch-action: pan-x pan-y; \}/.test(portal));
  const admin = (await call('GET', '/admin', null, await adminLogin())).raw || '';
  check('the admin page still zooms', /<meta name="viewport"/.test(admin) && !/user-scalable=no/.test(admin) && !/gesturestart/.test(admin));
  report();
})();
