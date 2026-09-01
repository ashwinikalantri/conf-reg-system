#!/usr/bin/env node
//
// Runs the whole suite.
//
//   npm test                 seed a fresh fixture, run everything
//   npm test -- t31 t37      run only the files whose names match
//   KEEP=1 npm test          leave the workspace behind for inspection
//
// There is deliberately no "run against production data" mode yet. The tests
// now address fixture identities by name, so pointing them at a copy of the
// real database fails ~160 assertions for the single reason that those people
// do not exist there -- no signal at all. Making that mode useful means
// layering the fixtures on top of real rows (tolerating existing categories
// and programme groups), which is its own piece of work rather than a flag.
//
// It seeds a database, starts the app against a throwaway copy of it on a free
// port, runs each test file as its own process, and tears everything down.
//
// Sequential, deliberately. The files share one server, and the OTP resend
// throttle is per destination -- running them in parallel makes the suite flaky
// for reasons that have nothing to do with what it is testing.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const filters = process.argv.slice(2);

const RESET = '\x1b[0m';
const c = (code, s) => (process.stdout.isTTY ? `\x1b[${code}m${s}${RESET}` : s);
const green = (s) => c(32, s);
const red = (s) => c(31, s);
const dim = (s) => c(2, s);
const bold = (s) => c(1, s);

// An OS-assigned free port, so two runs (or a run alongside a dev instance)
// never collide.
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function testFiles() {
  return fs.readdirSync(__dirname)
    .filter((f) => /^t\d*\.js$/.test(f))
    .filter((f) => !filters.length || filters.some((q) => f.includes(q)))
    .sort((a, b) => {
      const n = (f) => Number((f.match(/^t(\d*)\.js$/) || [])[1] || 0);
      return n(a) - n(b);
    });
}

async function waitForServer(port, child, log) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`The app exited before it was ready:\n${log()}`);
    try {
      const res = await new Promise((resolve, reject) => {
        const req = require('http').get({ host: '127.0.0.1', port, path: '/' }, resolve);
        req.on('error', reject);
        req.setTimeout(2000, () => req.destroy(new Error('timeout')));
      });
      res.resume();
      return;
    } catch { await sleep(300); }
  }
  throw new Error(`The app never became ready on port ${port}:\n${log()}`);
}

(async () => {
  const files = testFiles();
  if (!files.length) {
    console.error(filters.length ? `No test files match: ${filters.join(' ')}` : 'No test files found.');
    process.exit(1);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nqocn-test-'));
  const dbPath = path.join(work, 'conference.db');

  console.log(dim('Seeding a fixture database…'));
  const seeded = spawnSync(process.execPath, [path.join(__dirname, 'seed.js'), dbPath],
    { encoding: 'utf8' });
  if (seeded.status !== 0) {
    console.error(red('Could not seed the fixture database:'));
    console.error(seeded.stdout || '', seeded.stderr || '');
    process.exit(1);
  }
  console.log(dim(seeded.stdout.trim().split('\n').map((l) => `  ${l}`).join('\n')));

  const port = Number(process.env.TEST_PORT) || await freePort();
  let log = '';
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: work,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      OTP_ECHO: '1',            // tests read the code out of the response
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  const stop = () => { try { child.kill('SIGTERM'); } catch { /* already gone */ } };
  process.on('exit', stop);
  process.on('SIGINT', () => { stop(); process.exit(130); });

  try {
    await waitForServer(port, child, () => log);
  } catch (err) {
    console.error(red(err.message));
    stop();
    process.exit(1);
  }
  console.log(dim(`App on port ${port}, data in ${work}\n`));

  let passed = 0;
  let failed = 0;
  const broken = [];
  const started = Date.now();

  for (const file of files) {
    const res = spawnSync(process.execPath, [path.join(__dirname, file), dbPath], {
      encoding: 'utf8',
      env: { ...process.env, TEST_PORT: String(port) },
    });
    const out = `${res.stdout || ''}${res.stderr || ''}`;
    const p = (out.match(/ {2}PASS/g) || []).length;
    const f = (out.match(/ {2}FAIL/g) || []).length;
    passed += p;
    failed += f;

    // A file that crashes reports neither -- and must not be mistaken for one
    // that simply has nothing to say.
    const crashed = res.status !== 0 && f === 0;
    if (crashed) broken.push(file);

    const name = file.padEnd(10);
    if (crashed) console.log(`${red('✗')} ${name} ${red('crashed')}`);
    else if (f) console.log(`${red('✗')} ${name} ${green(`${p} passed`)}, ${red(`${f} failed`)}`);
    else if (p) console.log(`${green('✓')} ${name} ${p} passed`);
    else console.log(`${dim('·')} ${dim(`${name} no assertions`)}`);

    // Show what actually failed, and the tail of a crash.
    if (f) out.split('\n').filter((l) => l.includes('  FAIL')).forEach((l) => console.log(`    ${l.trim()}`));
    if (crashed) out.trim().split('\n').slice(-4).forEach((l) => console.log(dim(`    ${l}`)));
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log('');
  const summary = `${passed} passed, ${failed} failed${broken.length ? `, ${broken.length} crashed` : ''}  ${dim(`(${secs}s)`)}`;
  console.log(failed || broken.length ? red(bold(summary)) : green(bold(summary)));

  stop();
  if (process.env.KEEP) console.log(dim(`Workspace kept at ${work}`));
  else fs.rmSync(work, { recursive: true, force: true });

  process.exit(failed || broken.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
