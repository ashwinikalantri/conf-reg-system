const { check, report, appFile } = require('./harness');
// Pricing phases turn over at IST midnight, not UTC midnight.
const fs=require('fs');
const js=fs.readFileSync(appFile('server.js'),'utf8');
const grab=(n)=>js.match(new RegExp('function '+n+'\\([\\s\\S]*?\\n}'))[0];
const env=new Function(`
  ${js.match(/const IST_OFFSET_MS = [^\n]+/)[0]}
  ${grab('istDateString')}
  ${grab('currentPhase')}
  return {istDateString, currentPhase};`)();
const {istDateString, currentPhase}=env;

// The live fee master.
const cfg={early_until:'2026-08-31', regular_until:'2026-09-30', late_until:'2026-10-31'};
// An IST wall-clock time, expressed as the UTC instant it actually is.
const ist=(s)=>new Date(Date.parse(s+'+05:30'));

console.log('\n== The early-bird boundary, in IST ==');
const cases=[
  ['2026-08-31T00:00:00','early',   'the cutoff day itself, from the start'],
  ['2026-08-31T12:00:00','early',   'midday on the cutoff day'],
  ['2026-08-31T23:59:59','early',   'the last second of the cutoff day'],
  ['2026-09-01T00:00:01','regular', 'one second past IST midnight -- the bug'],
  ['2026-09-01T00:41:00','regular', 'when this was reported'],
  ['2026-09-01T05:29:00','regular', 'the last minute of the old UTC-lag window'],
  ['2026-09-01T05:31:00','regular', 'after it, where the old code was accidentally right'],
  ['2026-09-30T23:59:00','regular', 'the regular cutoff day'],
  ['2026-10-01T00:00:30','late',    'regular -> late, same boundary logic'],
  ['2026-11-01T00:00:30','spot',    'past every cutoff'],
];
for (const [t,want,why] of cases) {
  const got=currentPhase(cfg, ist(t));
  check(`${t} IST -> ${want} (${why})`, got===want, `got ${got}`);
}

console.log('\n== The specific regression ==');
// 2026-09-01 00:41 IST is 2026-08-31 19:11 UTC. The old code read the UTC
// date, saw 2026-08-31, and concluded early bird was still running.
const moment=ist('2026-09-01T00:41:00');
check('the UTC date really is still the 31st at that moment',
  moment.toISOString().slice(0,10)==='2026-08-31', moment.toISOString());
check('istDateString reports the 1st, as an Indian clock does',
  istDateString(moment)==='2026-09-01', istDateString(moment));
check('so the phase is regular, not early', currentPhase(cfg,moment)==='regular');
const oldPhase=(c,d)=>{const s=d.toISOString().slice(0,10);
  return c.early_until&&s<=c.early_until?'early':c.regular_until&&s<=c.regular_until?'regular':'spot';};
check('...and the old code would have said early (confirming the bug was real)',
  oldPhase(cfg,moment)==='early', oldPhase(cfg,moment));

console.log('\n== No DST surprises ==');
check('offset holds in January', istDateString(ist('2026-01-01T00:30:00'))==='2026-01-01');
check('offset holds in July',    istDateString(ist('2026-07-01T00:30:00'))==='2026-07-01');
check('independent of the host TZ',
  (()=>{const o=process.env.TZ; process.env.TZ='America/New_York';
        const r=istDateString(ist('2026-09-01T00:41:00')); process.env.TZ=o; return r==='2026-09-01';})());

console.log('\n== Right now ==');
console.log('   UTC date:', new Date().toISOString().slice(0,10), '| IST date:', istDateString(),
            '| phase:', currentPhase(cfg));
check('early bird is over as of today', currentPhase(cfg)!=='early', currentPhase(cfg));
report();
