// The staging tree for scripts/presentations-drive.sh: each presenter's file
// linked into the folder it belongs in on Drive. Oral and Award files sit
// in their format's folder; e-posters, by session and screen (owner, 20 Nov
// 2026), as the app lays out in .presentations-drive-layout.json:
//
//   Poster/1. Sunday 22 November, 12:00 PM, Hall B/Screen 1/<file>
//   Poster/Not on a screen yet/<file>
//
// No layout (an app not yet updated, or a file that cannot be read): the
// posters stay flat in Poster/, as before -- never all moved to one side.
//
// node presentations-drive-stage.js <src dir> <layout.json> <stage dir> "<types>"
const fs = require('fs');
const path = require('path');

// A folder path the layout gives, or '' -- never one that climbs out.
function cleanSub(sub) {
  const parts = String(sub || '').split('/').map((p) => p.trim());
  if (!parts.length || parts.some((p) => !p || p === '.' || p === '..' || p.includes('\\'))) return '';
  return parts.join('/');
}

function stage(src, layoutPath, out, types) {
  let layout = null;
  try { layout = JSON.parse(fs.readFileSync(layoutPath, 'utf8')); } catch (e) { layout = null; }
  const names = fs.readdirSync(src).filter((f) => !f.startsWith('.'));
  const placed = [];
  for (const t of types) {
    fs.mkdirSync(path.join(out, t), { recursive: true });
    const where = (layout && layout[t]) || {};
    for (const f of names.filter((n) => n.endsWith(`_${t}.pdf`))) {
      const sub = cleanSub(where[f]);
      const dir = path.join(out, t, ...(sub ? sub.split('/') : []));
      fs.mkdirSync(dir, { recursive: true });
      fs.symlinkSync(path.join(src, f), path.join(dir, f));
      placed.push(`${t}/${sub ? `${sub}/` : ''}${f}`);
    }
  }
  return placed;
}

if (require.main === module) {
  const [src, layoutPath, out, types] = process.argv.slice(2);
  stage(src, layoutPath, out, String(types || '').split(' ').filter(Boolean));
}
module.exports = { stage, cleanSub };
