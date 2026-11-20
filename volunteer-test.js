// Volunteer test mode (owner, 20 Nov 2026): volunteers practise on the
// real system, and everything they change is undone when the test ends;
// what everyone else does meanwhile is kept.
//
// How: while it is on, a request from a volunteer -- someone whose roles
// are only volunteer roles (on a delegate account or not) -- reads and
// writes through a second connection to the database. That connection
// alone carries TEMP triggers, which record every row it inserts, changes
// or deletes, before and after, in volunteer_test_changes. Nothing else
// writes through it, so the record is exactly the volunteers' changes.
// Ending the test walks the record backwards and puts each row back --
// only where the row still holds what the volunteer left: a field someone
// else has changed since keeps their value.
//
// Pure SQL building and the undo walk live here; server.js holds the
// connections and the switch.

const JOURNAL = 'volunteer_test_changes';
const JOURNAL_SQL = `CREATE TABLE IF NOT EXISTS ${JOURNAL} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL, op TEXT NOT NULL,
  old_rowid INTEGER, new_rowid INTEGER, old_values TEXT, new_values TEXT,
  at INTEGER NOT NULL
)`;
// Not recorded: sign-in sessions and codes (undoing them would only sign
// volunteers out), SQLite's own counters, and the record itself.
const SKIP_TABLES = new Set(['sessions', 'otp_codes', 'sqlite_sequence', JOURNAL]);

const isVolunteerOnly = (roles, volunteerKeys) => {
  const list = (roles || []).filter(Boolean);
  return list.some((r) => volunteerKeys.has(r)) && list.every((r) => r === 'DELEGATE' || volunteerKeys.has(r));
};

const q = (name) => `"${String(name).replace(/"/g, '""')}"`;
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
// A row as JSON; a blob as ["blob", "<hex>"] (JSON cannot hold bytes).
const rowJson = (ref, cols) => `json_object(${cols.map((c) => `${lit(c)}, CASE WHEN typeof(${ref}.${q(c)}) = 'blob' THEN json_array('blob', hex(${ref}.${q(c)})) ELSE ${ref}.${q(c)} END`).join(', ')})`;
const NOW_MS = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

// The three TEMP triggers for one table.
function triggerSql(table, cols) {
  const t = String(table).replace(/[^A-Za-z0-9_]/g, '_');
  const ins = (op, oldId, newId, oldV, newV) => `INSERT INTO ${JOURNAL} (table_name, op, old_rowid, new_rowid, old_values, new_values, at)
    VALUES (${lit(table)}, '${op}', ${oldId}, ${newId}, ${oldV}, ${newV}, ${NOW_MS})`;
  return [
    `CREATE TEMP TRIGGER IF NOT EXISTS vt_ins_${t} AFTER INSERT ON main.${q(table)} BEGIN ${ins('INSERT', 'NULL', 'NEW.rowid', 'NULL', rowJson('NEW', cols))}; END`,
    `CREATE TEMP TRIGGER IF NOT EXISTS vt_upd_${t} AFTER UPDATE ON main.${q(table)} BEGIN ${ins('UPDATE', 'OLD.rowid', 'NEW.rowid', rowJson('OLD', cols), rowJson('NEW', cols))}; END`,
    `CREATE TEMP TRIGGER IF NOT EXISTS vt_del_${t} AFTER DELETE ON main.${q(table)} BEGIN ${ins('DELETE', 'OLD.rowid', 'NULL', rowJson('OLD', cols), 'NULL')}; END`,
  ];
}

// Sets the recording up on a connection: { all, run } promise helpers.
async function arm({ all, run }) {
  await run(JOURNAL_SQL);
  // An INSERT OR REPLACE deletes the row it replaces: recorded too.
  await run('PRAGMA recursive_triggers = ON');
  const tables = (await all("SELECT name, sql FROM sqlite_master WHERE type = 'table'"))
    .filter((t) => !SKIP_TABLES.has(t.name) && !t.name.startsWith('sqlite_') && !/WITHOUT\s+ROWID/i.test(t.sql || ''));
  for (const t of tables) {
    const cols = (await all(`PRAGMA table_info(${q(t.name)})`)).map((c) => c.name);
    if (!cols.length) continue;
    for (const sql of triggerSql(t.name, cols)) await run(sql);
  }
  return tables.length;
}

const decode = (v) => (Array.isArray(v) && v[0] === 'blob' ? Buffer.from(String(v[1] || ''), 'hex') : v);
function same(a, b) {
  const x = decode(a);
  const y = decode(b);
  if (x == null || y == null) return x == null && y == null;
  if (Buffer.isBuffer(x) || Buffer.isBuffer(y)) return Buffer.isBuffer(x) && Buffer.isBuffer(y) && x.equals(y);
  return String(x) === String(y);
}
const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } };

// Every recorded change, last first, put back. { all, get, run } on a
// connection that does NOT record. Returns what was undone and what was
// kept because someone else has changed the row since, by table.
async function undoAll({ all, get, run }, upToId = null) {
  const entries = await all(`SELECT * FROM ${JOURNAL} ${upToId ? 'WHERE id <= ?' : ''} ORDER BY id DESC`, upToId ? [upToId] : []);
  const result = { undone: 0, kept: 0, tables: {} };
  const tally = (table, key) => {
    result[key]++;
    result.tables[table] = result.tables[table] || { undone: 0, kept: 0 };
    result.tables[table][key]++;
  };
  const colsOf = new Map();
  const columns = async (table) => {
    if (!colsOf.has(table)) colsOf.set(table, new Set((await all(`PRAGMA table_info(${q(table)})`)).map((c) => c.name)));
    return colsOf.get(table);
  };
  for (const e of entries) {
    const cols = await columns(e.table_name);
    if (!cols.size) { tally(e.table_name, 'kept'); continue; }
    const T = q(e.table_name);
    const oldV = parse(e.old_values) || {};
    const newV = parse(e.new_values) || {};
    const rowAt = (id) => (id == null ? null : get(`SELECT * FROM ${T} WHERE rowid = ?`, [id]));
    try {
      if (e.op === 'INSERT') {
        const row = await rowAt(e.new_rowid);
        if (!row) { tally(e.table_name, 'undone'); continue; }
        // Only a row still as the volunteer made it goes.
        if (Object.keys(newV).filter((c) => cols.has(c)).every((c) => same(row[c], newV[c]))) {
          await run(`DELETE FROM ${T} WHERE rowid = ?`, [e.new_rowid]);
          tally(e.table_name, 'undone');
        } else tally(e.table_name, 'kept');
      } else if (e.op === 'UPDATE') {
        const row = await rowAt(e.new_rowid);
        if (!row) { tally(e.table_name, 'kept'); continue; }
        const changed = Object.keys(newV).filter((c) => cols.has(c) && !same(oldV[c], newV[c]));
        const back = changed.filter((c) => same(row[c], newV[c]));
        if (back.length) {
          await run(`UPDATE ${T} SET ${back.map((c) => `${q(c)} = ?`).join(', ')} WHERE rowid = ?`, [...back.map((c) => decode(oldV[c])), e.new_rowid]);
        }
        tally(e.table_name, back.length === changed.length ? 'undone' : 'kept');
      } else if (e.op === 'DELETE') {
        if (await rowAt(e.old_rowid)) { tally(e.table_name, 'kept'); continue; }
        const keys = Object.keys(oldV).filter((c) => cols.has(c));
        await run(`INSERT INTO ${T} (rowid, ${keys.map(q).join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')})`, [e.old_rowid, ...keys.map((c) => decode(oldV[c]))]);
        tally(e.table_name, 'undone');
      }
    } catch (err) {
      // A row that cannot go back (say, its place taken by a real one) stays.
      tally(e.table_name, 'kept');
    }
  }
  return result;
}

// What the record holds, in words, by table: how many rows each touched.
const TABLE_LABELS = {
  registrations: 'Check-ins and kits', attendance: 'Sign-ins at the doors', meal_servings: 'Meals served',
  guests: 'Faculty travel and stay', held_emails: 'Emails (none were sent)', audit_log: 'Activity log entries',
  users: 'People\'s details', fee_waiver_requests: 'Fee waiver requests', flight_lookups: 'Flight look-ups',
};
async function summary({ all }) {
  const rows = await all(`SELECT table_name, COUNT(*) AS changes, COUNT(DISTINCT COALESCE(new_rowid, old_rowid)) AS rows, MIN(at) AS first, MAX(at) AS last, MAX(id) AS top
                            FROM ${JOURNAL} GROUP BY table_name ORDER BY changes DESC`);
  return {
    changes: rows.reduce((n, r) => n + r.changes, 0),
    lastId: rows.reduce((n, r) => Math.max(n, r.top), 0) || null,
    tables: rows.map((r) => ({ table: r.table_name, label: TABLE_LABELS[r.table_name] || r.table_name.replace(/_/g, ' '), changes: r.changes, rows: r.rows })),
  };
}

module.exports = { JOURNAL, JOURNAL_SQL, SKIP_TABLES, isVolunteerOnly, triggerSql, arm, undoAll, summary, same, TABLE_LABELS };
