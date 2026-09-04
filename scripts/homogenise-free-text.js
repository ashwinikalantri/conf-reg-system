#!/usr/bin/env node
// Homogenise the delegate-typed designation and institution fields.
//
//   node scripts/homogenise-free-text.js <db>            # dry run, prints the plan
//   node scripts/homogenise-free-text.js <db> --apply    # writes it
//   node scripts/homogenise-free-text.js <db> --propose  # Tier 2 candidates
//
// Both fields are free text, and the same place arrived 19 different ways:
// "MGIMS Sevagram", "MGIMS Sevagram ", "MGIMS Sevagram .", "MGIMS", and so
// on -- 164 delegates, 41% of the conference, split across those spellings.
// That fragments the Users filters, every report grouped by institution, and
// any count of who came from where.
//
// TWO TIERS, deliberately separated.
//
// Tier 1 is mechanical: variants identical once spacing, trailing
// punctuation and case are set aside. "Junior resident " and "Junior
// Resident" are the same string typed carelessly, and merging them needs no
// judgement about the world. This is what --apply writes.
//
// Tier 2 is semantic: "MGIMS" and "Mahatma Gandhi Institute of Medical
// Sciences, Sevagram" are the same institution, but knowing that is domain
// knowledge, not string processing. --propose prints candidates for a human
// to accept or reject; nothing here merges them on its own. The reason for
// the split is one pair in this very dataset: "Kasturba Nursing College,
// Sevagram" (47 delegates) and "Kasturba Nursing School, Sevagram" (8) are
// DIFFERENT institutions one word apart, and any similarity score loose
// enough to merge the MGIMS spellings also merges those two.
//
// Canonical spelling within a Tier 1 group is the one already most used --
// never a form this script invents. That is what keeps acronyms intact:
// title-casing would produce "Mgims" and "Anm", while the most common
// spelling of those groups is the acronym itself. Ties break towards the
// variant with more capitalised words, because two spellings of
// "MGIMS, Sevagram, Wardha" appear twice each and the all-lowercase one
// should not win by accident.

'use strict';

const path = require('path');
const sqlite3 = require('sqlite3');

const FIELDS = [
  { column: 'designation', label: 'DESIGNATION' },
  { column: 'institution', label: 'INSTITUTION' },
];

// The mechanical pass. Matches tidyFreeText() in server.js, which applies
// the same rules at every write so this stays true after the one-off run.
const tidy = (v) => {
  if (v == null) return null;
  const out = String(v).replace(/\s+/g, ' ').trim().replace(/[.,;:\s]+$/, '').trim();
  return out || null;
};
const fold = (v) => (tidy(v) || '').toLowerCase();
const capScore = (v) => String(v).split(/\s+/).filter((w) => /^[A-Z]/.test(w)).length;

const dbFile = process.argv[2];
const APPLY = process.argv.includes('--apply');
const PROPOSE = process.argv.includes('--propose');
const CLUSTERS = process.argv.includes('--clusters');
// Tier 2: apply the reviewed alias map. Separate flag from --apply because
// it is a different kind of change -- Tier 1 is spacing, this asserts that
// two differently-named things are the same place or the same rank, which
// only a person can decide. The script does no matching here; it applies
// exactly what the file says.
const ALIASES = process.argv.includes('--aliases');
if (!dbFile) {
  console.error('Usage: node scripts/homogenise-free-text.js <db> [--apply] [--propose]');
  process.exit(1);
}

const db = new sqlite3.Database(dbFile, APPLY ? sqlite3.OPEN_READWRITE : sqlite3.OPEN_READONLY);
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { return e ? rej(e) : res(this); }));

// Group every distinct spelling by its folded form, and pick the canonical.
function groupsFor(rows, column) {
  const counts = new Map();
  rows.forEach((r) => {
    const v = r[column];
    if (!tidy(v)) return;
    counts.set(v, (counts.get(v) || 0) + 1);
  });
  const groups = new Map();
  for (const [raw, n] of counts) {
    const k = fold(raw);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ raw, n });
  }
  const out = [];
  for (const [, variants] of groups) {
    variants.sort((a, b) => b.n - a.n || capScore(b.raw) - capScore(a.raw) || b.raw.length - a.raw.length);
    const canonical = tidy(variants[0].raw);
    const changing = variants.filter((v) => v.raw !== canonical);
    out.push({ canonical, variants, changing, total: variants.reduce((s, v) => s + v.n, 0) });
  }
  return out.sort((a, b) => b.total - a.total);
}

// Tier 2 candidates. SUGGESTIONS ONLY -- nothing here merges anything.
//
// Kept deliberately conservative, because the failure mode is silent and
// permanent: "Kasturba Nursing College, Sevagram" (47 delegates) and
// "Kasturba Nursing School, Sevagram" (8) are different institutions one
// word apart, and any rule loose enough to catch every MGIMS spelling also
// catches those two.
//
// Two rules only:
//   * every significant word of the shorter name appears in the longer one,
//     and the shorter has at least TWO of them. One shared word matched
//     "Student" to "PG Student" and "Professor" to "Assistant Professor" --
//     different ranks, not spellings.
//   * an acronym whose letters are the initials of the other name, ignoring
//     the small joining words. Without that exclusion MGIMS fails against
//     "Mahatma Gandhi Institute OF Medical Sciences" -- which is the single
//     largest merge in this dataset, so the rule earns its keep.
const STOP = new Set(['of', 'and', 'for', 'the', 'in', 'at', '&']);
function proposals(canonicals) {
  const words = (v) => new Set(v.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w)));
  const initials = (v) => v.split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z]/g, ''))
    .filter((w) => w && !STOP.has(w.toLowerCase()))
    .map((w) => w[0].toLowerCase()).join('');
  const firstWord = (v) => v.split(/[\s,]+/)[0] || '';
  const out = [];
  for (let i = 0; i < canonicals.length; i++) {
    for (let j = i + 1; j < canonicals.length; j++) {
      const a = canonicals[i];
      const b = canonicals[j];
      const wa = words(a.canonical);
      const wb = words(b.canonical);
      if (!wa.size || !wb.size) continue;
      const shared = [...wa].filter((w) => wb.has(w));
      const smaller = Math.min(wa.size, wb.size);
      const subset = smaller >= 2 && shared.length === smaller;
      // The acronym has to be the whole first token AND its letters must
      // open the other name in order -- "GMC" against "Seth GS Medical
      // College & KEM Hospital" shares letters but not the opening.
      const acro = (x, y) => {
        const t = firstWord(x);
        return /^[A-Z]{3,}$/.test(t) && initials(y).startsWith(t.toLowerCase());
      };
      const acronymHit = acro(a.canonical, b.canonical) || acro(b.canonical, a.canonical);
      if (subset || acronymHit) {
        out.push({ a, b, why: acronymHit ? 'acronym of the other' : `${smaller} significant words, all shared` });
      }
    }
  }
  return out;
}

// Values that are not an institution or a designation at all. Found one in
// this dataset -- someone typed their email address into the institution
// box -- and a merge report is the wrong place to notice that quietly.
function suspicious(canonicals) {
  return canonicals.filter((g) => /@|https?:|^\d+$/.test(g.canonical) || g.canonical.length < 3);
}

(async () => {
  if (ALIASES) {
    const mapFile = path.join(__dirname, 'free-text-aliases.json');
    const map = JSON.parse(require('fs').readFileSync(mapFile, 'utf8'));
    console.log(`Applying reviewed aliases from ${path.basename(mapFile)}`
      + `${APPLY ? '' : '   (DRY RUN -- add --apply to write)'}\n`);
    let grand = 0;
    for (const field of FIELDS) {
      const groups = map[field.column] || {};
      console.log(`===== ${field.label} =====`);
      for (const [canonical, variants] of Object.entries(groups)) {
        for (const variant of variants) {
          const hit = await all(
            `SELECT COUNT(*) AS n FROM users WHERE role = 'DELEGATE' AND ${field.column} = ?`, [variant]);
          const n = hit[0].n;
          // A variant that matches nothing is reported rather than skipped
          // silently -- it means the map has drifted from the data, which is
          // worth knowing before trusting the rest of it.
          if (!n) { console.log(`    0  ${JSON.stringify(variant)}   <-- NOT FOUND, map may be stale`); continue; }
          console.log(`  ${String(n).padStart(3)}  ${JSON.stringify(variant)} -> ${JSON.stringify(canonical)}`);
          if (APPLY) {
            const r = await run(
              `UPDATE users SET ${field.column} = ? WHERE role = 'DELEGATE' AND ${field.column} = ?`,
              [canonical, variant]);
            grand += r.changes;
          }
        }
      }
      console.log('');
    }
    if (APPLY) console.log(`applied: ${grand} row(s) updated.`);
    db.close();
    return;
  }
  const rows = await all("SELECT phone_number, designation, institution FROM users WHERE role = 'DELEGATE'");
  console.log(`${rows.length} delegates in ${path.basename(dbFile)}${APPLY ? '' : '   (DRY RUN -- pass --apply to write)'}\n`);

  for (const field of FIELDS) {
    const groups = groupsFor(rows, field.column);
    const merging = groups.filter((g) => g.changing.length);
    const rowsTouched = merging.reduce((s, g) => s + g.changing.reduce((t, v) => t + v.n, 0), 0);
    const distinctBefore = new Set(rows.map((r) => r[field.column]).filter((v) => tidy(v))).size;

    console.log(`===== ${field.label} =====`);
    console.log(`  ${distinctBefore} distinct -> ${groups.length} after tier 1   (${rowsTouched} rows rewritten)\n`);

    for (const g of merging) {
      console.log(`  "${g.canonical}"`);
      for (const v of g.changing) console.log(`     ${String(v.n).padStart(3)}  <- ${JSON.stringify(v.raw)}`);
    }
    if (!merging.length) console.log('  nothing to merge.');

    if (APPLY) {
      let written = 0;
      for (const g of merging) {
        for (const v of g.changing) {
          const r = await run(
            `UPDATE users SET ${field.column} = ? WHERE role = 'DELEGATE' AND ${field.column} = ?`,
            [g.canonical, v.raw]);
          written += r.changes;
        }
      }
      console.log(`\n  applied: ${written} row(s) updated.`);
    }

    if (PROPOSE) {
      const odd = suspicious(groups);
      if (odd.length) {
        console.log(`\n  --- NOT AN ${field.label} AT ALL (${odd.length}) ---`);
        odd.forEach((g) => console.log(`   ! ${JSON.stringify(g.canonical)} (${g.total})`));
      }
      if (CLUSTERS) {
        // Pairs are the wrong unit to review: one institution generated
        // eight of them. Connected components turn that into one decision.
        // Every member is printed, because transitive linking (A~B, B~C) can
        // pull in something that belongs to neither -- which a reader spots
        // instantly and a similarity score never will.
        const cands = proposals(groups);
        const parent = new Map(groups.map((g) => [g.canonical, g.canonical]));
        const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
        cands.forEach(({ a, b }) => { const ra = find(a.canonical); const rb = find(b.canonical);
          if (ra !== rb) parent.set(ra, rb); });
        const byRoot = new Map();
        groups.forEach((g) => {
          const r = find(g.canonical);
          if (!byRoot.has(r)) byRoot.set(r, []);
          byRoot.get(r).push(g);
        });
        const clusters = [...byRoot.values()].filter((c) => c.length > 1)
          .map((c) => c.sort((x, y) => y.total - x.total))
          .sort((x, y) => y.reduce((s, g) => s + g.total, 0) - x.reduce((s, g) => s + g.total, 0));
        console.log(`\n  --- ${clusters.length} CLUSTER(S) TO REVIEW ---`);
        clusters.forEach((c, i) => {
          const total = c.reduce((s, g) => s + g.total, 0);
          console.log(`\n  [${field.label[0]}${i + 1}]  ${total} delegates   suggested: ${JSON.stringify(c[0].canonical)}`);
          c.forEach((g) => console.log(`         ${String(g.total).padStart(3)}  ${JSON.stringify(g.canonical)}`));
        });
        const single = groups.filter((g) => byRoot.get(find(g.canonical)).length === 1);
        console.log(`\n  (${single.length} value(s) matched nothing and are left alone)`);
        continue;
      }
      const cands = proposals(groups);
      console.log(`\n  --- TIER 2 CANDIDATES (${cands.length}) -- suggestions only, nothing merged ---`);
      cands.sort((x, y) => (y.a.total + y.b.total) - (x.a.total + x.b.total));
      for (const c of cands) {
        console.log(`   ? ${JSON.stringify(c.a.canonical)} (${c.a.total})`);
        console.log(`     ${JSON.stringify(c.b.canonical)} (${c.b.total})     [${c.why}]`);
      }
    }
    console.log('');
  }
  db.close();
})().catch((e) => { console.error(e); process.exit(1); });
