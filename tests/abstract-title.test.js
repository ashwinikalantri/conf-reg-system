// Abstract titles, tidied (31 Oct 2026): quotation marks off their ends, one
// space between words, APA title case -- for every title already submitted
// (a one-off update) and every one submitted from now on.
const { check, report, appFile } = require('./harness');
const fs = require('fs');
const { cleanTitle } = require(appFile('abstract-title.js'));

const cases = [
  ['the quotes off both ends, curly or straight', '“Improving the Practice of Birth Companion Support”', 'Improving the Practice of Birth Companion Support'],
  ['...and when only one end has one', '"A study to assess the effectiveness of a module', 'A Study to Assess the Effectiveness of a Module'],
  ['...but an apostrophe stays', "Enhancing Mothers' Experience of Childbirth", "Enhancing Mothers' Experience of Childbirth"],
  ['short words small inside, capitalised first and after a colon', 'Exploring the immunological host responses: a quality healthcare approach in tubercular infection',
    'Exploring the Immunological Host Responses: A Quality Healthcare Approach in Tubercular Infection'],
  ['"Of", "On", "And", "At" brought down', 'Effectiveness Of Structured Teaching Program On Knowledge Regarding Prevention And Control', 'Effectiveness of Structured Teaching Program on Knowledge Regarding Prevention and Control'],
  ['acronyms and names with inner capitals kept', 'Reducing unplanned extubation in a NICU using WHO-POCQI and SaQushal', 'Reducing Unplanned Extubation in a NICU Using WHO-POCQI and SaQushal'],
  ['each part of a hyphenated word', 'Improving follow-up after a cross-sectional decision-to-delivery study', 'Improving Follow-Up After a Cross-Sectional Decision-to-Delivery Study'],
  ['a title in capitals brought down, ETCO2 kept', 'THE EFFECT OF ETCO2 MONITORING ON PATIENT SAFETY', 'The Effect of ETCO2 Monitoring on Patient Safety'],
  ['runs of spaces made one', 'Hand hygiene  in a labour   room', 'Hand Hygiene in a Labour Room'],
  ['after ";-" a new start', 'Stress in old age homes;- a quasi experimental study', 'Stress in Old Age Homes;- A Quasi Experimental Study'],
  ['brackets: the word inside capitalised', 'A study (SPOT improvement study)', 'A Study (SPOT Improvement Study)'],
  ['a question mark ends a clause', 'What distinguishes relapse? a rural study', 'What Distinguishes Relapse? A Rural Study'],
  ['the last word always capitalised', 'What they were looking for', 'What They Were Looking For'],
];
for (const [what, input, want] of cases) {
  const got = cleanTitle(input);
  check(what, got === want, got);
}
check('quotes alone leave nothing', cleanTitle(' “” ') === '');
check('no space before a colon', cleanTitle('Diabetes in Central India : A Mixed Method Study') === 'Diabetes in Central India: A Mixed Method Study'
  && cleanTitle('Intensive Care Unit  : A Quality Improvement Initiative') === 'Intensive Care Unit: A Quality Improvement Initiative');
check('a leading hyphen taken off', cleanTitle('-Improving hand hygiene compliance') === 'Improving Hand Hygiene Compliance', cleanTitle('-Improving hand hygiene compliance'));
check('...and a "Title of paper:" label', cleanTitle('Title of paper:  Improving Hand Hygiene: A PDSA-Based Project') === 'Improving Hand Hygiene: A PDSA-Based Project'
  && cleanTitle('TITLE: A study of care') === 'A Study of Care' && cleanTitle('“Title of the abstract – Care at home”') === 'Care at Home');
check('...but a title that merely starts with "Title" is left alone', cleanTitle('Titles and honours in nursing') === 'Titles and Honours in Nursing');
check('...and a hyphen inside a title too', cleanTitle('Co-designing care') === 'Co-Designing Care');

const server = fs.readFileSync(appFile('server.js'), 'utf8');
check('a submitted title is cleaned the same way, and an empty one refused',
  /const cleanTitle = abstractTitle\.cleanTitle\(title\);\n\s*if \(!cleanTitle\) return res\.status\(400\)/.test(server));
report();
