// Six district names in the shapefile belong to two states each. Keying the
// map on the bare name meant a delegate could be drawn on the wrong state's
// district, and -- worse, because it was silent -- BOTH same-named polygons
// were shaded with the combined count. Aurangabad, Bihar was showing the four
// delegates who live in Aurangabad, Maharashtra.
//
// The resolver is exercised for real here, not regex-matched: the relevant
// declarations are lifted out of app.js and run. Geometry is never touched by
// the name path, so the features can be plain property bags.
const { check, report, appFile } = require('./harness');
const fs = require('fs');

const src = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
const slice = (startMarker, endMarker) => {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a);
  if (a === -1 || b === -1) throw new Error(`could not lift ${startMarker} out of app.js`);
  return src.slice(a, b);
};
const lifted = [
  slice('const DISTRICT_NAME_ALIASES = {', '};') + '};',
  slice('const STATE_SYNONYMS = {', '\nfunction sameState'),
  slice('function sameState(a, b) {', '\n\n'),
  slice('const districtKey = (f) =>', '\n'),
  slice('function resolveDelegateDistrict(loc, feat, featBoxes, pinCoords) {', '\n}\n') + '\n}',
].join('\n');
// Never reached by the name path; present so the source parses and so a test
// that DID fall through would fail loudly rather than silently pass.
const d3 = { geoBounds: () => [[0, 0], [0, 0]], geoContains: () => false };
const { resolveDelegateDistrict, districtKey } = new Function('d3', `${lifted}
  return { resolveDelegateDistrict, districtKey };`)(d3);

(async () => {
  console.log('\n== The shapefile really does duplicate these names ==');
  const topo = JSON.parse(fs.readFileSync(appFile('public', 'data', 'india-districts.topo.json'), 'utf8'));
  const byName = new Map();
  topo.objects.in_district.geometries.forEach((g) => {
    const d = String(g.properties.dtname || '').toLowerCase().trim();
    if (!byName.has(d)) byName.set(d, new Set());
    byName.get(d).add(g.properties.stname);
  });
  const shared = [...byName.entries()].filter(([, states]) => states.size > 1).map(([d]) => d).sort();
  console.log(`   shared names: ${shared.join(', ')}`);
  check('some district names are shared between states', shared.length > 0, shared.length);
  check('aurangabad is one of them', shared.includes('aurangabad'), shared);

  const feat = { features: topo.objects.in_district.geometries.map((g) => ({ properties: g.properties })) };
  const find = (dt, st) => feat.features.find((f) =>
    String(f.properties.dtname).toLowerCase().trim() === dt && f.properties.stname === st);

  console.log('\n== A shared name resolves by state ==');
  const mh = resolveDelegateDistrict({ district: 'Aurangabad', state: 'Maharashtra', pincode: '' }, feat, [], {});
  const br = resolveDelegateDistrict({ district: 'Aurangabad', state: 'Bihar', pincode: '' }, feat, [], {});
  check('Aurangabad, Maharashtra resolves', !!mh, mh);
  check('Aurangabad, Bihar resolves', !!br, br);
  check('they are DIFFERENT districts', mh && br && mh.key !== br.key, [mh && mh.key, br && br.key]);
  check('Maharashtra maps to the Maharashtra polygon',
    mh && mh.key === districtKey(find('aurangabad', 'MAHARASHTRA')), mh && mh.key);
  check('Bihar maps to the Bihar polygon',
    br && br.key === districtKey(find('aurangabad', 'BIHAR')), br && br.key);

  console.log('\n== Every shared name is separable ==');
  for (const name of shared) {
    const states = [...byName.get(name)];
    const keys = states.map((st) => {
      const hit = resolveDelegateDistrict({ district: name, state: st, pincode: '' }, feat, [], {});
      return hit && hit.key;
    });
    check(`${name}: ${states.join(' vs ')} resolve to two distinct polygons`,
      keys.every(Boolean) && new Set(keys).size === states.length, keys);
  }

  console.log('\n== A state the delegate did not give is not guessed ==');
  // No state and no PIN code: two real districts a thousand kilometres apart,
  // and nothing to choose between them. Unmapped beats a coin flip.
  const blind = resolveDelegateDistrict({ district: 'Aurangabad', state: '', pincode: '' }, feat, [], {});
  check('an ambiguous name with no state is left unmapped', blind === null, blind);
  // The PIN code decides when there is one -- that path is the geometry
  // fallback, which the stub d3 above deliberately fails, proving the name
  // branch didn't quietly answer instead.
  const viaPin = resolveDelegateDistrict({ district: 'Aurangabad', state: '', pincode: '431001' }, feat, [], { 431001: [19.87, 75.34] });
  check('and falls through to the PIN code rather than the name', viaPin === null, viaPin);

  console.log('\n== Unambiguous names still work exactly as before ==');
  const wardha = resolveDelegateDistrict({ district: 'Wardha', state: 'Maharashtra', pincode: '' }, feat, [], {});
  check('the host district resolves', !!wardha, wardha);
  check('even with no state given, since the name is unique',
    !!resolveDelegateDistrict({ district: 'Wardha', state: '', pincode: '' }, feat, [], {}));
  check('a state spelled differently still matches',
    !!resolveDelegateDistrict({ district: 'Bilaspur', state: 'Chattisgarh', pincode: '' }, feat, [], {}));
  const alias = resolveDelegateDistrict({ district: 'Gondia', state: 'Maharashtra', pincode: '' }, feat, [], {});
  check('a name alias still resolves', !!alias && alias.key.includes('gondiya'), alias);
  check('an unknown district with no PIN is unmapped',
    resolveDelegateDistrict({ district: 'Nowhere', state: 'Maharashtra', pincode: '' }, feat, [], {}) === null);

  console.log('\n== Keys are unique per polygon ==');
  const allKeys = feat.features.map((f) => districtKey(f));
  const dupes = allKeys.filter((k, i) => allKeys.indexOf(k) !== i);
  check('no two districts share a key', dupes.length === 0, [...new Set(dupes)].slice(0, 5));
  check('the key carries the state', districtKey(find('aurangabad', 'BIHAR')).startsWith('bihar|'),
    districtKey(find('aurangabad', 'BIHAR')));

  console.log('\n== The map reads districts by that same key ==');
  check('drawDelegateMap keys features with districtKey', /const key = districtKey\(f\);/.test(src));
  check('the server groups by state as well', /GROUP BY TRIM\(u\.pincode\), LOWER\(TRIM\(u\.district\)\), LOWER\(TRIM\(u\.state\)\)/
    .test(fs.readFileSync(appFile('server.js'), 'utf8')));

  report();
})();
