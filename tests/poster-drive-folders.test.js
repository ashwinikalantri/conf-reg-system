// E-posters on Google Drive, by session and screen (owner, 20 Nov 2026):
// Poster › "1. Sunday 22 November, 12:00 PM, Hall B" › "Screen 1" › file. The
// app writes where each file goes beside the database; the host script's
// stager builds the tree from it, and with no layout keeps posters flat.
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../poster-screens');
const { stage, cleanSub } = require('../scripts/presentations-drive-stage');
const { check, report, appFile, dataDir } = require('./harness');

console.log('\n== Where each poster goes ==');
const sessions = [
  { day: 'Sunday 22 November', startTime: '12:00 PM', hall: 'Hall B', screens: [
    { name: 'Screen 1', posters: [{ file: { fileName: 'A_Poster.pdf' } }, { file: null }] },
    { name: 'Screen/2', posters: [{ file: { fileName: 'B_Poster.pdf' } }] }] },
  { day: 'Sunday 22 November', startTime: '2:00 PM', hall: 'Hall B', screens: [{ name: 'Screen 1', posters: [{ file: { fileName: 'C_Poster.pdf' } }] }] },
];
const f = P.driveFolders({ sessions, unallotted: [{ file: { fileName: 'D_Poster.pdf' } }, { file: null }] });
check('a session folder, numbered in time order, then the screen', f['A_Poster.pdf'] === '1. Sunday 22 November, 12:00 PM, Hall B/Screen 1', f);
check('...the second session after it', f['C_Poster.pdf'] === '2. Sunday 22 November, 2:00 PM, Hall B/Screen 1');
check('a slash in a name cannot make a folder of its own', f['B_Poster.pdf'] === '1. Sunday 22 November, 12:00 PM, Hall B/Screen-2');
check('not on a screen yet: its own folder', f['D_Poster.pdf'] === P.NOT_PLACED_FOLDER);
check('no file, nothing to place', Object.keys(f).length === 4);

console.log('\n== The staging tree ==');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-stage-'));
const src = path.join(tmp, 'src');
fs.mkdirSync(src);
for (const n of ['A_Poster.pdf', 'D_Poster.pdf', 'E_Poster.pdf', 'X_Oral.pdf', '.partial_Poster.pdf']) fs.writeFileSync(path.join(src, n), n);
fs.writeFileSync(path.join(tmp, 'layout.json'), JSON.stringify({ Poster: { 'A_Poster.pdf': f['A_Poster.pdf'], 'D_Poster.pdf': P.NOT_PLACED_FOLDER, 'E_Poster.pdf': '../../etc' } }));
const placed = stage(src, path.join(tmp, 'layout.json'), path.join(tmp, 'out'), ['Oral', 'Poster', 'Award']);
check('posters in their session and screen folders', placed.includes('Poster/1. Sunday 22 November, 12:00 PM, Hall B/Screen 1/A_Poster.pdf')
  && fs.readFileSync(path.join(tmp, 'out', 'Poster', '1. Sunday 22 November, 12:00 PM, Hall B', 'Screen 1', 'A_Poster.pdf'), 'utf8') === 'A_Poster.pdf', placed);
check('...or the not-placed folder', placed.includes(`Poster/${P.NOT_PLACED_FOLDER}/D_Poster.pdf`));
check('a folder that climbs out is not followed: the file stays at the top', placed.includes('Poster/E_Poster.pdf') && cleanSub('../x') === '' && cleanSub('a/b') === 'a/b');
check('oral and award files as before, a file still being written left out', placed.includes('Oral/X_Oral.pdf') && !placed.some((p) => p.includes('.partial')));
const flat = stage(src, path.join(tmp, 'missing.json'), path.join(tmp, 'flat'), ['Poster']);
check('no layout: posters flat, as before, never all moved aside', flat.sort().join() === 'Poster/A_Poster.pdf,Poster/D_Poster.pdf,Poster/E_Poster.pdf', flat);
fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n== The script and the app ==');
const sh = fs.readFileSync(appFile('scripts', 'presentations-drive.sh'), 'utf8');
const src2 = fs.readFileSync(appFile('server.js'), 'utf8');
check('the script stages with the stager, from the host, read-only', /-v "\$STAGER":\/stage\.js:ro/.test(sh) && /node \/stage\.js \/src \/layout\.json \/tmp\/stage "\$3"/.test(sh));
check('...a missing layout is an empty one', /\[ -f "\$LAYOUT" \] \|\| LAYOUT_MOUNT=\/dev\/null/.test(sh));
check('a moved poster is moved on Drive, not binned and uploaded again', /--track-renames/.test(sh) && /--max-delete "\$4"/.test(sh));
check('a new layout counts as a change', /cat "\$LAYOUT" 2>\/dev\/null; \} \| md5sum/.test(sh));
check('what is on Drive is read from every folder down', /e\.isDirectory\(\)/.test(sh));
check('"In Drive" finds a file in a session folder', /const key = \(p\) => \{ const parts = String\(p\)\.split\('\/'\); return `\$\{parts\[0\]\}\/\$\{parts\[parts\.length - 1\]\}`; \};/.test(src2));
const layoutFile = path.join(dataDir(), '.presentations-drive-layout.json');
let layout = null;
try { layout = JSON.parse(fs.readFileSync(layoutFile, 'utf8')); } catch (e) { layout = null; }
check('the app writes the layout beside the database', !!layout && typeof layout.Poster === 'object', layoutFile);
report();
