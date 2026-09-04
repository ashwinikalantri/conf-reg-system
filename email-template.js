// The chrome every outgoing email is wrapped in.
//
// This lived twice -- once in server.js, once in scripts/daily-digest.js --
// as two byte-identical copies that differed only in how they reached the
// conference name. They had already drifted from the app: both still carried
// the pre-redesign indigo (#312e81) months after the portal and admin panel
// moved to the steel-blue "Clinical Trust" ramp. One copy here, imported by
// both, so the next restyle cannot leave half the mail behind.
//
// Constraints that shape what this can be, and why it is not just the app's
// CSS again:
//
//   * Every style must be inline. Gmail strips <style> blocks, and there is
//     no stylesheet to link to from an inbox.
//   * Web fonts do not arrive. Gmail ignores them outright, so the families
//     below name Source Sans 3 and Libre Franklin for the clients that
//     happen to have them and fall back to the same system stack the old
//     template used everywhere else -- no worse than before, better where
//     it lands.
//   * This returns a fragment, not a document. That is what SES has always
//     been handed here, and what the tests expect; wrapping it in <html>
//     would be more correct in the abstract and is not worth the client
//     quirks it would buy.

// Straight from the portal's tailwind config (views/index.ejs) -- the same
// ramp `indigo` is remapped onto across the app, so an email and the page it
// links to are the same colour.
const STEEL = {
  50: '#eef3f6', 100: '#dbe6ec', 200: '#b9cedb', 300: '#8fb0c3',
  400: '#628ea8', 500: '#46708c', 600: '#2f5673', 700: '#244560',
  800: '#1c3549', 900: '#142838',
};

// Slate, unchanged from what the templates already used for text and rules.
const INK = '#0f172a';
const BODY_TEXT = '#334155';
const MUTED = '#94a3b8';
const RULE = '#e2e8f0';

const BODY_FONT = "'Source Sans 3', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const HEAD_FONT = "'Libre Franklin', 'Source Sans 3', system-ui, -apple-system, 'Segoe UI', sans-serif";

const escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// `conference` is { name, acronym, location } -- passed in rather than read
// from a global, since the two callers hold it differently (server.js has a
// CONFERENCE object, the digest script has three let-bindings it refreshes
// from the database on each run).
function emailWrap(title, bodyHtml, conference = {}) {
  const eyebrow = [conference.acronym, conference.location].filter(Boolean).join(' · ');
  return `<div style="font-family:${BODY_FONT};max-width:560px;margin:0 auto;color:${INK};background:#ffffff">
     <div style="background:${STEEL[800]};color:#ffffff;padding:1.25rem 1.5rem;border-radius:12px 12px 0 0">
       <div style="font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;color:${STEEL[200]}">${escapeHtml(eyebrow)}</div>
       <h1 style="font-family:${HEAD_FONT};font-size:1.05rem;font-weight:700;margin:.35rem 0 0">${escapeHtml(conference.name)}</h1>
     </div>
     <div style="border:1px solid ${RULE};border-top:0;border-radius:0 0 12px 12px;padding:1.5rem;background:#ffffff">
       <h2 style="font-family:${HEAD_FONT};font-size:1rem;font-weight:700;margin:0 0 .75rem;color:${INK}">${escapeHtml(title)}</h2>
       ${bodyHtml}
       <p style="color:${MUTED};font-size:.72rem;margin-top:1.5rem">This is an automated message from the conference registration portal.</p>
     </div>
   </div>`;
}

// A call-to-action link styled as a button. Inline-block with real padding
// rather than a table -- the same shape the app's buttons have, and enough
// for every client that matters here.
const emailButton = (href, text) =>
  `<a href="${escapeHtml(href)}" style="display:inline-block;background:${STEEL[600]};color:#ffffff;text-decoration:none;`
  + `font-family:${HEAD_FONT};font-weight:700;font-size:.85rem;padding:.7rem 1.4rem;border-radius:10px">${escapeHtml(text)}</a>`;

module.exports = { emailWrap, emailButton, STEEL, INK, BODY_TEXT, MUTED, RULE, BODY_FONT, HEAD_FONT };
