// A programme session's speakers (or facilitators) and chairs (or
// moderators): an ordered list, each either someone on the faculty list
// ({ guestId }) or plain words ({ text }) -- "and Team", "NQoCN and MGIMS
// Team", someone not added as faculty.
//
// The line the delegate sees is made from the list, so a faculty member's
// name is always as the faculty list has it now. Sessions typed before the
// list existed keep their words until edited; splitLegacy/matchFaculty turn
// those words into a proposed list for the editor to show.

const TITLES = new Set(['dr', 'prof', 'professor', 'mrs', 'mr', 'ms', 'smt', 'shri', 'maj', 'gen', 'air', 'cmde', 'lt', 'col', 'brig', 'capt', 'sr']);

// "Prof Dr B. S. Garg" -> "b s garg": titles, dots and case aside.
function normName(name) {
  const words = String(name || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  while (words.length > 1 && TITLES.has(words[0])) words.shift();
  return words.join(' ');
}

// "Dr A, Dr B and Team" -> ["Dr A", "Dr B", "and Team"].
function splitLegacy(text) {
  const parts = String(text || '').split(/[,;\n]/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const team = /^(.*\S)\s+(and\s+(?:the\s+)?team\b.*)$/i.exec(p);
    if (team) out.push(team[1], team[2]);
    else out.push(p);
  }
  return out;
}

// Words -> a proposed list: a name matching exactly one faculty member
// (titles aside) becomes them; anything else stays words.
function matchFaculty(parts, faculty) {
  return parts.map((text) => {
    if (/^and\b/i.test(text)) return { text };
    const key = normName(text);
    const hits = key ? faculty.filter((f) => normName(f.name) === key) : [];
    return hits.length === 1 ? { guestId: hits[0].id } : { text };
  });
}

// The line: names with commas, "and Team" tacked on with a space.
function joinPeople(names) {
  return names.reduce((line, n) => {
    if (!line) return n;
    return /^and\b/i.test(n) ? `${line} ${n}` : `${line}, ${n}`;
  }, '');
}

// A list as the client sent it, checked: { value } or { error }. `known` is
// the set of faculty ids that exist.
const MAX_PEOPLE = 40;
function cleanPeople(list, known, what) {
  if (!Array.isArray(list)) return { error: `${what}: not a list.` };
  if (list.length > MAX_PEOPLE) return { error: `${what}: at most ${MAX_PEOPLE}.` };
  const value = [];
  const seen = new Set();
  for (const item of list) {
    if (item && item.guestId != null) {
      const id = Number(item.guestId);
      if (!known.has(id)) return { error: `${what}: someone is no longer on the faculty list. Remove them and add them again.` };
      if (seen.has(id)) continue;
      seen.add(id);
      value.push({ guestId: id });
    } else {
      const text = String((item && item.text) || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (text.length > 120) return { error: `${what}: "${text.slice(0, 30)}…" is too long.` };
      value.push({ text });
    }
  }
  return { value };
}

module.exports = { normName, splitLegacy, matchFaculty, joinPeople, cleanPeople, MAX_PEOPLE };
