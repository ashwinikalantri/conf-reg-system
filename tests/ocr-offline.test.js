// OCR must not depend on the network.
//
// tesseract.js downloads its English model from the jsdelivr CDN whenever it
// has no cached copy, and the cache folder (.ocr-cache/, git-ignored) did not
// exist in a checkout -- so every start downloaded it. On a slow day that one
// download made the suite take five minutes instead of one, and once hung it
// for over ten. On the live site the same start had no time limit at all, and
// OCR is serialised, so a stalled start would hang every slip check queued
// behind it until a restart.
//
// What this file proves rather than assumes:
//   * with the network REMOVED (a separate network namespace), the engine
//     starts from the bundled model and reads real text -- and without the
//     bundled model, in the same sandbox, it cannot (so the sandbox is real);
//   * the bundled model is the one tesseract.js would fetch for this OEM;
//   * a start that stalls fails in bounded time, lets the next request try
//     again, and does not leak the worker if it turns up late;
//   * the test runner reports a file that hangs, by name, and moves on.
const { check, report, appFile } = require('./harness');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(appFile('server.js'), 'utf8');

(async () => {
  console.log('\n== The model ships with the app ==');
  const pkgDir = path.dirname(require.resolve('@tesseract.js-data/eng/package.json', { paths: [ROOT] }));
  const model = path.join(pkgDir, '4.0.0_best_int', 'eng.traineddata.gz');
  check('the English model is installed as a dependency', fs.existsSync(model), model);
  check('...pinned in package.json', require(path.join(ROOT, 'package.json')).dependencies['@tesseract.js-data/eng'] === '1.0.0');
  check('the server reads it from there', /require\.resolve\('@tesseract\.js-data\/eng\/package\.json'\)\), '4\.0\.0_best_int'\)/.test(src));
  // tesseract.js picks best_int for OEM 1 (LSTM only); the server uses OEM 1,
  // so this is the same model it would otherwise download.
  check('...the variant tesseract.js fetches for the OEM the server uses',
    /createWorker\('eng', 1, \{ cachePath: OCR_CACHE_DIR,/.test(src));

  console.log('\n== With no network at all, it still reads text ==');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-offline-'));
  // A real image of known text, rendered from a PDF.
  // pdfkit's font engine needs the same small-ICU fallback the reports use on
  // this host's Node 16 (see report-pdf.js).
  require(appFile('report-pdf.js')).ensureTextDecoders();
  const PDF = require(require.resolve('pdfkit', { paths: [ROOT] }));
  await new Promise((resolve) => {
    const doc = new PDF({ size: [620, 160], margin: 20 });
    const out = fs.createWriteStream(path.join(tmp, 'slip.pdf'));
    doc.pipe(out);
    doc.fontSize(44).text('OFFLINE RECEIPT 2026', 30, 50);
    doc.end();
    out.on('finish', resolve);
  });
  execFileSync('pdftoppm', ['-r', '120', '-png', '-singlefile', path.join(tmp, 'slip.pdf'), path.join(tmp, 'slip')]);
  const child = path.join(tmp, 'ocr-child.js');
  fs.writeFileSync(child, `
    const { createWorker } = require(${JSON.stringify(require.resolve('tesseract.js', { paths: [ROOT] }))});
    const LANG = process.env.LANG_PATH || undefined;
    (async () => {
      const worker = await Promise.race([
        createWorker('eng', 1, { cachePath: process.env.CACHE, ...(LANG ? { langPath: LANG } : {}) }),
        new Promise((_, r) => setTimeout(() => r(new Error('did not start')), Number(process.env.LIMIT))),
      ]);
      const { data } = await worker.recognize(process.env.IMG);
      console.log('TEXT:' + data.text.replace(/\\s+/g, ' ').trim());
      await worker.terminate();
      process.exit(0);
    })().catch((e) => { console.log('ERR:' + e.message); process.exit(2); });`);
  // unshare -n: a network namespace with nothing in it, not even DNS.
  const offline = (env) => spawnSync('unshare', ['-n', process.execPath, child], {
    encoding: 'utf8', timeout: 90000, env: { ...process.env, IMG: path.join(tmp, 'slip.png'), ...env } });
  const isolated = spawnSync('unshare', ['-n', 'true']).status === 0;
  check('this machine can run a process with no network (unshare -n)', isolated);
  if (isolated) {
    const started = Date.now();
    const withModel = offline({ LANG_PATH: path.join(pkgDir, '4.0.0_best_int'), CACHE: fs.mkdtempSync(path.join(tmp, 'c1-')), LIMIT: '60000' });
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const text = ((withModel.stdout || '').match(/TEXT:(.*)/) || [])[1] || '';
    check('offline, the engine starts from the bundled model', withModel.status === 0, (withModel.stdout || '') + (withModel.stderr || '').slice(-300));
    check('...and reads the text on the image', /OFFLINE/.test(text) && /RECEIPT/.test(text) && /2026/.test(text), text);
    check('...in seconds, not minutes', Number(secs) < 45, `${secs}s`);
    // The control: same sandbox, no bundled model. It must fail -- otherwise
    // "no network" above proved nothing.
    const without = offline({ CACHE: fs.mkdtempSync(path.join(tmp, 'c2-')), LIMIT: '20000' });
    // tesseract.js reports a failed download out-of-band (an uncaught error
    // from its worker thread), so the evidence is on stderr, not our catch.
    const tried = `${without.stdout || ''}${without.stderr || ''}`;
    check('without it, the same sandbox cannot start the engine: it tries the CDN and cannot reach it',
      without.status !== 0 && /cdn\.jsdelivr\.net/.test(tried) && /ENOTFOUND|EAI_AGAIN|FetchError/.test(tried)
      && !/TEXT:/.test(without.stdout || ''), tried.slice(0, 300));
  }

  console.log('\n== A stalled start is bounded, and retried ==');
  // The server's own code, run against a stand-in engine.
  const start = src.indexOf('const OCR_CACHE_DIR');
  const end = src.indexOf('  return ocrWorkerPromise;\n}', start) + '  return ocrWorkerPromise;\n}'.length;
  const block = src.slice(start, end);
  const harness = (createWorker) => {
    const made = [];
    const sandbox = {
      path, __dirname: ROOT, setTimeout, clearTimeout, Promise, Error, Number,
      fs: { mkdirSync: (p, o) => made.push([p, o]) },
      require: Object.assign(() => { throw new Error('unexpected require'); }, { resolve: (m) => require.resolve(m, { paths: [ROOT] }) }),
      process: { env: { OCR_INIT_TIMEOUT_MS: '60' } },
      createWorker,
    };
    vm.createContext(sandbox);
    const api = vm.runInContext(`${block}\n({ getOcrWorker, langPath: OCR_LANG_PATH })`, sandbox);
    return { api, made };
  };
  let calls = 0;
  const stalled = harness(() => { calls++; return new Promise(() => {}); });
  let err = null;
  const t0 = Date.now();
  try {
    await Promise.race([stalled.api.getOcrWorker(),
      new Promise((_, r) => setTimeout(() => r(new Error('test gave up waiting: the start has no limit')), 2000))]);
  } catch (e) { err = e; }
  check('a start that never finishes fails, not hangs', !!err && /did not start within/.test(err.message), err && err.message);
  check('...in about the time allowed', Date.now() - t0 < 1000, Date.now() - t0);
  try {
    await Promise.race([stalled.api.getOcrWorker(), new Promise((_, r) => setTimeout(() => r(new Error('gave up')), 2000))]);
  } catch (e) { /* expected */ }
  check('the next request starts afresh instead of waiting on the stalled one', calls === 2, calls);
  check('the cache folder is created before starting', stalled.made.some(([p, o]) => p.endsWith('.ocr-cache') && o && o.recursive));
  check('the model path given to the engine is the bundled one', stalled.api.langPath === path.join(pkgDir, '4.0.0_best_int'), stalled.api.langPath);

  let terminated = 0;
  const late = harness(() => new Promise((r) => setTimeout(() => r({ terminate: () => { terminated++; return Promise.resolve(); } }), 150)));
  try { await late.api.getOcrWorker(); } catch (e) { /* timed out first */ }
  await new Promise((r) => setTimeout(r, 300));
  check('a worker that turns up after the limit is shut down, not leaked', terminated === 1, terminated);

  let made = 0;
  let given = null;
  const fine = harness((lang, oem, opts) => { made++; given = { lang, oem, opts }; return Promise.resolve({ id: 'w' }); });
  const a = await fine.api.getOcrWorker();
  const b = await fine.api.getOcrWorker();
  check('a normal start is made once and reused', made === 1 && a === b, made);
  // The path above is only computed; this is the engine actually being told.
  check('the engine is TOLD to use the bundled model, not left to download it',
    !!given && !!given.opts && given.opts.langPath === path.join(pkgDir, '4.0.0_best_int'), given && given.opts);
  check('...for English, LSTM only, as before', !!given && given.lang === 'eng' && given.oem === 1, given);

  console.log('\n== The test runner names a file that hangs ==');
  const run = fs.readFileSync(appFile('tests', 'run.js'), 'utf8');
  check('each file runs under a time limit', /timeout: FILE_TIMEOUT_MS,/.test(run) && /killSignal: 'SIGKILL'/.test(run));
  check('...adjustable, three minutes by default', /Number\(process\.env\.TEST_FILE_TIMEOUT_MS\) \|\| 180000/.test(run));
  check('a file over the limit is reported as timed out, by name', /timed out after \$\{FILE_TIMEOUT_MS \/ 1000\}s/.test(run));
  check('...and counts against the run', /if \(crashed \|\| timedOut\) broken\.push\(file\);/.test(run));

  fs.rmSync(tmp, { recursive: true, force: true });
  report();
})();
