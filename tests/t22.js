const { call, check, report } = require('./harness');
; const fs=require('fs');
(async()=>{
const js=(await call('GET','/app.js',null,null)).raw;
console.log('\n== State-border layer ships ==');
check('meshes cached at fetch time', /stateMesh, outline \}/.test(js) || /stateMesh,\s*outline/.test(js));
check('drawn from the cache, not an out-of-scope topo', /path\(data\.stateMesh\)/.test(js) && /path\(data\.outline\)/.test(js));
check('no bare `topo` reference in the draw function',
  !/path\(topojson\.mesh\(topo/.test(js.slice(js.indexOf('function drawDelegateMap'))), 'ok');
check('fill:none on the mesh layers', /attr\('d', path\(data\.stateMesh\)\)\s*\n\s*\.attr\('fill', 'none'\)/.test(js));
check('mesh does not steal hover', (js.match(/pointer-events'\)/g)||[]).length>=0 && /\.style\('pointer-events', 'none'\);\s*\/\/ never steal hover/.test(js));

console.log('\n== Meshes are correct against the real topology + CDN build ==');
const src=fs.readFileSync('/tmp/claude-0/topojson.min.js','utf8');
const mod={exports:{}}; new Function('module','exports',src)(mod,mod.exports);
const tj=mod.exports;
const topo=JSON.parse(fs.readFileSync('/home/ashwinikalantri/nqocn/public/data/india-districts.topo.json','utf8'));
const o=topo.objects.in_district;
const state=tj.mesh(topo,o,(a,b)=>a!==b && a.properties.stname!==b.properties.stname);
const outline=tj.mesh(topo,o,(a,b)=>a===b);
const internal=tj.mesh(topo,o,(a,b)=>a!==b);
check('state mesh is non-empty', state.coordinates.length>0, state.coordinates.length);
check('state borders are a strict subset of district borders', state.coordinates.length<internal.coordinates.length, [state.coordinates.length, internal.coordinates.length]);
check('outline is non-empty', outline.coordinates.length>0, outline.coordinates.length);
check('every district carries stname', o.geometries.every(g=>g.properties&&g.properties.stname), 'ok');

console.log('\n== Map data still serves ==');
let r=await call('POST','/api/auth/login-otp',{identifier:'7440977777'});
r=await call('POST','/api/auth/login',{identifier:'7440977777',otp:r.body.devOtp});
const map=await call('GET','/api/admin/delegate-locations',null,r.cookie);
check('endpoint 200', map.status===200, map.status);
check('locations present', Array.isArray(map.body.locations) && map.body.locations.length>0, (map.body.locations||[]).length);
report();
})();
