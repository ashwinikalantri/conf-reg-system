// The medical councils a doctor may be registered with: the state medical
// councils as the National Medical Commission lists them
// (https://nmc.org.in/list-of-state-medical-councils, names as written there),
// and the National Medical Commission itself for the Indian Medical Register.
// A Doctor's or Medical PG's council and registration number go on the
// certificate with MMC credit points.
const MEDICAL_COUNCILS = [
  'Andhra Pradesh Medical Council',
  'Arunachal Pradesh Medical Council',
  'Assam Medical Council',
  'Bihar Medical Council',
  'Chattisgarh Medical Council',
  'Delhi Medical Council',
  'Goa Medical Council',
  'Gujarat Medical Council',
  'Haryana Medical Council',
  'Himanchal Pradesh Medical Council',
  'Jammu & Kashmir Medical Council',
  'Jharkhand Medical Council',
  'Karnataka Medical Council',
  'Madhya Pradesh Medical Council',
  'Maharashtra Medical Council',
  'Manipur Medical Council',
  'Mizoram Medical Council',
  'Nagaland Medical Council',
  'Orissa Council of Medical Registration',
  'Punjab Medical Council',
  'Rajasthan Medical Council',
  'Sikkim Medical Council',
  'Tamil Nadu Medical Council',
  'Telangana State Medical Council',
  'Travancore Cochin Medical Council, Trivandrum',
  'Tripura State Medical Council',
  'Uttar Pradesh Medical Council',
  'Uttarakhand Medical Council',
  'West Bengal Medical Council',
  'Medical Council of India',
  'National Medical Commission',
];

// A registration number as typed (" 2012/03/1234 ") made tidy, upper-case,
// no spaces.
const cleanRegNo = (v) => String(v || '').replace(/\s+/g, '').toUpperCase();

// What is wrong with a council and number, or null. Both are needed together.
function councilError(councilName, regNo) {
  const name = String(councilName || '').trim();
  const no = cleanRegNo(regNo);
  if (!name && !no) return 'Choose your Medical Council and enter your registration number.';
  if (!MEDICAL_COUNCILS.includes(name)) return 'Choose your Medical Council from the list.';
  if (!/^[A-Z0-9/.-]{3,30}$/.test(no)) return 'Enter your registration number as it appears on your certificate: letters, digits, / . or -.';
  return null;
}

module.exports = { MEDICAL_COUNCILS, cleanRegNo, councilError };
