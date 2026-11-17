// Workshop feedback (owner, 17 Nov 2026): each delegate marked present at a
// workshop rates it on three questions, 1 to 5, and may add suggestions. A
// workshop certificate is issued only once its feedback is in (an
// organiser's Include override still issues one without it). Given once,
// not changed. The organisers' report shows each response by registration
// number, never by name.
//
// Pure (no database), so it can be tested on its own; the routes are in
// server.js.

const QUESTIONS = [
  { key: 'relevance', label: 'Relevance of content' },
  { key: 'facilitation', label: 'Quality of facilitation' },
  { key: 'usefulness', label: 'Usefulness in your professional practice' },
];
const SUGGESTIONS = { key: 'suggestions', label: 'Suggestions for improving the workshop in future', maxLength: 2000 };
const SCALE = [
  { value: 1, label: 'Poor' },
  { value: 2, label: 'Fair' },
  { value: 3, label: 'Good' },
  { value: 4, label: 'Very good' },
  { value: 5, label: 'Excellent' },
];

// A response as the delegate sent it: { values } when every rating is a
// whole number from 1 to 5, else { error } naming the first one missing.
function check(body) {
  const b = body || {};
  const values = {};
  for (const q of QUESTIONS) {
    const v = Number(b[q.key]);
    if (!Number.isInteger(v) || v < 1 || v > 5) return { error: `Choose a rating for "${q.label}".` };
    values[q.key] = v;
  }
  const text = String(b[SUGGESTIONS.key] || '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length > SUGGESTIONS.maxLength) return { error: `Keep the suggestions under ${SUGGESTIONS.maxLength} characters.` };
  values[SUGGESTIONS.key] = text || null;
  return { values };
}

// Each question across responses: how many, the average (one decimal) and
// how many gave each rating.
function summarise(rows) {
  return QUESTIONS.map((q) => {
    const counts = [0, 0, 0, 0, 0];
    let sum = 0;
    for (const r of rows) {
      const v = Number(r[q.key]);
      if (v >= 1 && v <= 5) { counts[v - 1] += 1; sum += v; }
    }
    const n = counts.reduce((a, b) => a + b, 0);
    return { key: q.key, label: q.label, n, mean: n ? Math.round((sum / n) * 10) / 10 : null, counts };
  });
}

module.exports = { QUESTIONS, SUGGESTIONS, SCALE, check, summarise };
