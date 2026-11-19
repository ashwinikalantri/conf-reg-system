// The abstract review's five steps fold away under their headings (owner,
// 19 Nov 2026); which are folded is remembered on the browser, so the desk
// opens as it was left.
const fs = require('fs');
const { call, adminLogin, appFile, check, report } = require('./harness');

(async () => {
  const admin = await adminLogin();
  const html = (await call('GET', '/admin', null, admin)).raw;
  const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
  const css = fs.readFileSync(appFile('public', 'styles.css'), 'utf8');
  const steps = [...html.matchAll(/<details class="abs-step group" data-step="(\d)" open>\s*<summary[^>]*>[\s\S]*?<h3[^>]*>(Step \d · [^<]+)<\/h3>\s*<\/summary>/g)];
  check('each of the five steps is a fold, open to begin with, its heading the handle',
    steps.length === 5 && steps.every((m, i) => m[1] === String(i + 1) && m[2].startsWith(`Step ${i + 1} ·`)), steps.map((m) => m[2]));
  const block = (id) => html.slice(html.indexOf(`id="${id}"`), html.indexOf('</details>', html.indexOf(`id="${id}"`)));
  check('what a step holds folds with it', ['abstracts-approval-container', 'abstracts-assignment-container', 'presentations-list', 'screens-board', 'zenodo-list']
    .every((id) => /data-step="\d"/.test(html.slice(0, html.indexOf(`id="${id}"`)).split('</details>').pop())));
  check('...and the blocks a role may not see still hide whole', /id="abstracts-assignment-block" class="pt-4[^"]*">\s*<details/.test(html) && /id="abstracts-zenodo-block" class="hidden[^"]*">\s*<details/.test(html));
  check('the browser\'s own marker gives way to the chevron', /\.abs-step > summary::-webkit-details-marker \{ display: none; \}/.test(css) && /group-open:rotate-90/.test(html));
  check('folded steps are remembered on this browser and restored on opening the tab',
    /storageSet\('local', ABSTRACT_STEPS_KEY/.test(js) && /async function renderBackendAbstracts\(\) \{\n\s*restoreAbstractSteps\(\);/.test(js)
    && /d\.ontoggle = \(\) => rememberAbstractStep\(d\);/.test(js) && !/ontoggle=/.test(html));
  check('...and a broken stored value cannot stop the tab', /const foldedAbstractSteps = \(\) => \{ try \{/.test(js) && block('abstracts-approval-container') !== '');
  report();
})();
