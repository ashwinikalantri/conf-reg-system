// The authors of an abstract, in the order they are to be printed.
//
// Abstracts first captured only the delegate who submitted them
// (abstracts.author_name). The full list is kept in abstracts.authors as
// JSON -- [{ name, presenting }] -- with the submitter in it exactly once,
// marked as the presenting author, at whatever position the team wants.
// NULL means the list has not been given yet: the submitter is then shown
// alone, as before. Names only, at most MAX_AUTHORS.
//
// Pure, so it can be tested on its own; the routes are in server.js.

const MAX_AUTHORS = 6;
const MAX_NAME = 120;

const tidy = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const key = (s) => tidy(s).toLowerCase().replace(/[.,]/g, '');

// The stored list, or null when there is none (or it cannot be read).
function parseAuthors(raw) {
  if (!raw) return null;
  let list;
  try { list = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return null; }
  if (!Array.isArray(list) || !list.length) return null;
  const out = list.map((a) => ({ name: tidy(a && a.name), presenting: !!(a && a.presenting) })).filter((a) => a.name);
  return out.length ? out : null;
}

// What to show: the stored list, or the submitter alone.
function effectiveAuthors(abstract) {
  return parseAuthors(abstract && abstract.authors)
    || [{ name: tidy(abstract && abstract.author_name) || 'Author', presenting: true }];
}

// Check a list as sent. Exactly one entry is the presenting author.
// presentingName, when given, is what that entry must say (a delegate
// cannot rename the submitter; an admin may correct the spelling).
// -> { authors } or { error }
function cleanAuthors(input, { presentingName = null } = {}) {
  if (!Array.isArray(input)) return { error: 'Send the authors as a list.' };
  const list = input.map((a) => (typeof a === 'string' ? { name: a } : a || {}))
    .map((a) => ({ name: tidy(a.name), presenting: !!a.presenting }));
  const presenting = list.filter((a) => a.presenting);
  if (presenting.length !== 1) return { error: 'Exactly one author must be the presenting author.' };
  if (presentingName != null) presenting[0].name = tidy(presentingName);
  const named = list.filter((a) => a.name || a.presenting);
  if (named.some((a) => !a.name)) return { error: 'The presenting author needs a name.' };
  if (named.length > MAX_AUTHORS) return { error: `An abstract can have at most ${MAX_AUTHORS} authors.` };
  const tooLong = named.find((a) => a.name.length > MAX_NAME);
  if (tooLong) return { error: `"${tooLong.name.slice(0, 40)}…" is too long for a name.` };
  if (named.some((a) => !/\p{L}/u.test(a.name))) return { error: 'Each author needs a name with letters in it.' };
  const seen = new Set();
  for (const a of named) {
    const k = key(a.name);
    if (seen.has(k)) return { error: `${a.name} is listed twice.` };
    seen.add(k);
  }
  return { authors: named };
}

// One line of text, for exports and logs: "A Rao, B Shah*, C Iyer" -- the
// asterisk marks the presenting author.
function authorsText(list, { mark = true } = {}) {
  return (list || []).map((a) => `${a.name}${mark && a.presenting && list.length > 1 ? '*' : ''}`).join(', ');
}

module.exports = { MAX_AUTHORS, MAX_NAME, parseAuthors, effectiveAuthors, cleanAuthors, authorsText };
