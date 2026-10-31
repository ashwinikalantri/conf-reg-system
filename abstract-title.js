// An abstract's title, tidied: the quotation marks some authors wrap it in
// taken off its ends, runs of spaces made one, and title case.
//
// Title case is APA's: every word capitalised but the short conjunctions,
// articles and prepositions (three letters or fewer) inside the title; the
// first word, the last, and the first after a colon, semicolon, question
// mark, full stop or dash always. Each part of a hyphenated word is treated
// as a word ("Follow-Up", "Decision-to-Delivery"). A word with a capital after its first letter --
// an acronym (NICU, QI, GMCD) or a name like SaQushal -- is left as it is.
// A title typed in capitals throughout is first brought down, keeping only
// words with a digit in them (ETCO2) as they are.
const SMALL = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'so', 'yet', 'as', 'at', 'by', 'in', 'of', 'off', 'on', 'per', 'to', 'via', 'vs', 'vs.']);
const QUOTES = /^[\s"“”„«»]+|[\s"“”„«»]+$/g;

function capitalise(word) {
  // The first letter, after any opening bracket or quote.
  return word.replace(/^([^A-Za-z]*)([a-z])/, (m, lead, ch) => lead + ch.toUpperCase());
}

function caseWord(word, force, shouting) {
  const letters = word.replace(/[^A-Za-z]/g, '');
  if (!letters) return word;
  if (shouting) {
    if (/\d/.test(word) && /[A-Z]/.test(word)) return word;
    word = word.toLowerCase();
  } else if (/[A-Z]/.test(letters.slice(1))) {
    return word;
  }
  const bare = word.replace(/^[^A-Za-z]+|[^A-Za-z.]+$/g, '').toLowerCase();
  if (!force && SMALL.has(bare)) return word.toLowerCase();
  return capitalise(word);
}

function titleCase(text) {
  const letters = text.replace(/[^A-Za-z]/g, '');
  const upper = letters.replace(/[^A-Z]/g, '').length;
  const shouting = letters.length > 12 && upper / letters.length > 0.8;
  const words = text.split(' ');
  let forceNext = true;
  return words.map((w, i) => {
    const last = i === words.length - 1;
    // Hyphenated and slashed words: each part a word of its own, the first
    // taking this word's place in the title.
    const parts = w.split(/([-/–—])/);
    const out = parts.map((p, j) => {
      if (j % 2 === 1 || !p) return p;
      return caseWord(p, (j === 0 && (forceNext || last)) || (j > 0 && j === parts.length - 1 && last), shouting);
    }).join('');
    forceNext = /[:;?!.–—-]$/.test(w);
    return out;
  }).join(' ');
}

function cleanTitle(title) {
  const s = String(title == null ? '' : title).replace(/\s+/g, ' ').replace(QUOTES, '').trim();
  return s ? titleCase(s) : s;
}

module.exports = { cleanTitle, titleCase };
