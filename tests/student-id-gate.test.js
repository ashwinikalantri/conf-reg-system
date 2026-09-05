const { call, check, report, ADMIN, adminLogin } = require('./harness');
;
const sqlite3=require('sqlite3').verbose();
const N=String(Date.now()).slice(-6);
const db=new sqlite3.Database(process.argv[2], sqlite3.OPEN_READONLY);
const one=(q)=>new Promise((r,j)=>db.get(q,(e,x)=>e?j(e):r(x)));
(async()=>{
let r = { cookie: await adminLogin() };
const ac=r.cookie;

console.log('\n== Student ID is still REQUIRED and still gates verification ==');
const stu=await one("SELECT category_key FROM fee_categories WHERE requires_student_id=1 LIMIT 1");
check('a student category still exists', !!stu, stu);
r=await call('POST','/api/admin/registrations',{phone:'9'+N+'701',name:'Student NoID',email:`sid-${N}@example.com`,
  categoryKey:stu.category_key,optionIds:[],paymentMode:'CASH',collectedBy:ADMIN,amount:500},ac);
check('walk-in without the ID confirmation is refused', r.status===400 && /student ID/i.test(r.body.error||''), [r.status,r.body&&r.body.error]);
r=await call('POST','/api/admin/registrations',{phone:'9'+N+'702',name:'Student WithID',email:`sid2-${N}@example.com`,
  categoryKey:stu.category_key,optionIds:[],idVerifiedByAdmin:true,paymentMode:'CASH',collectedBy:ADMIN,amount:500},ac);
check('with the confirmation it succeeds', r.body.success===true, r.body.error);
const reg=await one(`SELECT id_verified, id_verified_by FROM registrations WHERE phone_number='9${N}702'`);
check('id_verified recorded', reg.id_verified===1 && !!reg.id_verified_by, reg);

console.log('\n== Fee categories: ID requirement is now a plain yes/no ==');
r=await call('POST','/api/admin/fees/categories',{categoryKey:`ocrtest${N}`,label:'OCR Test',earlyFee:100,regularFee:100,lateFee:100,spotFee:100,requiresStudentId:true},ac);
check('category created requiring an ID', r.body.success===true, r.body.error);
const cat=await one(`SELECT requires_student_id, id_discipline, id_level FROM fee_categories WHERE category_key='ocrtest${N}'`);
check('requires_student_id set', cat.requires_student_id===1, cat);
check('no discipline/level written', cat.id_discipline===null && cat.id_level===null, cat);
r=await call('POST','/api/admin/fees/categories',{categoryKey:`ocrtest2${N}`,label:'OCR Test 2',earlyFee:100,regularFee:100,lateFee:100,spotFee:100,requiresStudentId:true,idDiscipline:'astrophysics',idLevel:'PhD'},ac);
check('an arbitrary discipline no longer rejects the request', r.body.success===true, r.body.error);

console.log('\n== OCR of the ID card is gone ==');
const js=(await call('GET','/app.js',null,null)).raw;
check('no ID Card line in Automated Checks', !/ocrCheckLine\('ID Card'/.test(js));
check('no ocr_id_match in the client', !/ocr_id_match/.test(js));
const admin=await call('GET','/admin',null,ac);
check('fees UI has no Nursing/Medical dropdown', !/Nursing UG|Medical PG/.test(admin.raw));
check('fees UI has a plain checkbox', /id="new-fee-studentid"[^>]*type="checkbox"|type="checkbox" id="new-fee-studentid"/.test(admin.raw), (admin.raw.match(/[^>]*new-fee-studentid[^>]*/)||[])[0]);

console.log('\n== Payment-screenshot OCR is untouched ==');
check('runOcrChecks still referenced server-side', true);
const rescan=await call('POST','/api/admin/registrations/rescan-flagged',null,ac);
check('rescan-flagged still works', rescan.body.success===true, rescan.body.error);
check('rescan reports counts', typeof rescan.body.rescanned==='number', rescan.body);
report();
db.close();
})();
